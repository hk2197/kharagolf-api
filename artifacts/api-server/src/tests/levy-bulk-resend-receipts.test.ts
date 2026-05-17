/**
 * Integration test: Bulk-resend failed/skipped levy receipts (Task #254 / #292).
 *
 * Covers POST /api/organizations/:orgId/members-360/levies/:id/resend-failed-receipts.
 *
 * The test seeds a single levy with five charges, each in a different
 * `lastReceiptStatus` state (sent / failed / skipped / failed-with-bad-kind /
 * no-receipt), then invokes the bulk endpoint with `sendLevyReceipt`
 * stubbed so we can deterministically choose what each retry returns.
 *
 * It then asserts:
 *   - aggregate counters (attempted, sent, skipped, failed) are accurate,
 *   - only failed/skipped charges with a valid persisted kind are retried,
 *   - per-charge `lastReceiptStatus` is updated on disk to the new outcome,
 *   - one audit-log row is appended per attempted charge,
 *   - the GET .../charges summary then reflects the residual
 *     failedReceiptCount / skippedReceiptCount.
 *
 * `sendLevyReceipt` is mocked so we don't touch real SMTP / push / SMS
 * providers; everything else (DB writes, audit-log inserts, summary
 * recomputation) runs against the real PostgreSQL database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

// Hoisted mock of the receipt fan-out helper. Each test case primes
// `sendLevyReceiptMock` with the per-call outcomes it expects the route to
// observe. The route will then call our stub instead of touching providers.
vi.mock("../lib/levyReceiptNotify.js", async () => {
  return {
    sendLevyReceipt: vi.fn(),
    LEVY_RECEIPT_MAX_PUSH_ATTEMPTS: 5,
    LEVY_RECEIPT_MAX_SMS_ATTEMPTS: 5,
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { sendLevyReceipt } from "../lib/levyReceiptNotify.js";
import type { LevyReceiptResult } from "../lib/levyReceiptNotify.js";
import { createTestApp, type TestUser } from "./helpers.js";

const sendLevyReceiptMock = vi.mocked(sendLevyReceipt);

/** Build a fully-typed LevyReceiptResult from a short shape so the per-call
 *  mock implementations stay terse. */
function receipt(
  status: "sent" | "skipped" | "failed",
  reason?: string,
  overrides?: Partial<Pick<LevyReceiptResult, "email" | "push" | "sms" | "whatsapp">>,
): LevyReceiptResult {
  const channel = status === "sent" ? "sent" : status === "skipped" ? "opted_out" : "failed";
  return {
    status,
    ...(reason ? { reason } : {}),
    email: { status: channel },
    push: { status: channel },
    sms: { status: channel },
    whatsapp: { status: channel },
    ...overrides,
  };
}

let testOrgId: number;
let testUserId: number;
let testLevyId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;

// One member + one charge per scenario we want to exercise.
const charges: {
  memberId: number;
  chargeId: number;
  label: "sent" | "failed" | "skipped" | "failed_no_kind" | "no_receipt";
}[] = [];

const URL = () =>
  `/api/organizations/${testOrgId}/members-360/levies/${testLevyId}/resend-failed-receipts`;
const CHARGES_URL = () =>
  `/api/organizations/${testOrgId}/members-360/levies/${testLevyId}/charges`;

async function makeMemberWithCharge(opts: {
  label: typeof charges[number]["label"];
  lastReceiptStatus: string | null;
  lastReceiptKind: string | null;
  lastReceiptAmount: string | null;
  lastReceiptNote: string | null;
}): Promise<void> {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: opts.label,
    lastName: `Tester_${stamp}`,
    email: `${opts.label}_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });

  const [charge] = await db.insert(memberLevyChargesTable).values({
    levyId: testLevyId,
    clubMemberId: member.id,
    amount: "100.00",
    paid: true,
    paidAmount: "100.00",
    status: "paid",
    lastReceiptStatus: opts.lastReceiptStatus,
    lastReceiptKind: opts.lastReceiptKind,
    lastReceiptAmount: opts.lastReceiptAmount,
    lastReceiptNote: opts.lastReceiptNote,
    lastReceiptAt: opts.lastReceiptStatus ? new Date() : null,
  }).returning({ id: memberLevyChargesTable.id });

  charges.push({ memberId: member.id, chargeId: charge.id, label: opts.label });
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_BulkResendReceipts_${stamp}`,
    slug: `test-bulk-resend-receipts-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `test-bulk-resend-${stamp}`,
    username: `bulk_resend_admin_${stamp}`,
    email: `bulk_resend_admin_${stamp}@example.com`,
    displayName: "Bulk Resend Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;

  const [levy] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: `Bulk Resend Test Levy ${stamp}`,
    amount: "100.00",
    currency: "INR",
    status: "applied",
    appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  testLevyId = levy.id;

  // ─── Mixed pool of receipt states ─────────────────────────────────────
  // 1. "sent": already delivered — must be ignored by the bulk endpoint.
  await makeMemberWithCharge({
    label: "sent",
    lastReceiptStatus: "sent",
    lastReceiptKind: "payment",
    lastReceiptAmount: "100.00",
    lastReceiptNote: null,
  });
  // 2. "failed" with a valid persisted kind — should be retried.
  await makeMemberWithCharge({
    label: "failed",
    lastReceiptStatus: "failed",
    lastReceiptKind: "payment",
    lastReceiptAmount: "100.00",
    lastReceiptNote: null,
  });
  // 3. "skipped" with a valid persisted kind — should be retried.
  await makeMemberWithCharge({
    label: "skipped",
    lastReceiptStatus: "skipped",
    lastReceiptKind: "refund",
    lastReceiptAmount: "50.00",
    lastReceiptNote: "partial refund",
  });
  // 4. "failed" but with no persisted kind — should short-circuit to
  //    failed/missing_receipt_kind without invoking sendLevyReceipt.
  await makeMemberWithCharge({
    label: "failed_no_kind",
    lastReceiptStatus: "failed",
    lastReceiptKind: null,
    lastReceiptAmount: null,
    lastReceiptNote: null,
  });
  // 5. No receipt issued at all — should be ignored entirely.
  await makeMemberWithCharge({
    label: "no_receipt",
    lastReceiptStatus: null,
    lastReceiptKind: null,
    lastReceiptAmount: null,
    lastReceiptNote: null,
  });

  admin = {
    id: testUserId,
    username: `bulk_resend_admin_${stamp}`,
    displayName: "Bulk Resend Admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  // Audit rows are not cascaded by the levy/member deletes, so wipe them
  // explicitly first to keep the DB clean between test runs.
  const chargeIds = charges.map((c) => c.chargeId);
  if (chargeIds.length) {
    await db.delete(memberAuditLogTable).where(and(
      eq(memberAuditLogTable.organizationId, testOrgId),
      eq(memberAuditLogTable.entity, "levy_charge"),
      inArray(memberAuditLogTable.entityId, chargeIds),
    ));
  }
  if (testLevyId) {
    await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, testLevyId));
  }
  for (const c of charges) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, c.memberId));
  }
  if (testUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(() => {
  sendLevyReceiptMock.mockReset();
});

describe("POST .../levies/:id/resend-failed-receipts", () => {
  it("retries only failed/skipped charges, updates status + audit, and refreshes the summary", async () => {
    const failedCharge = charges.find((c) => c.label === "failed")!;
    const skippedCharge = charges.find((c) => c.label === "skipped")!;
    const sentCharge = charges.find((c) => c.label === "sent")!;
    const failedNoKindCharge = charges.find((c) => c.label === "failed_no_kind")!;

    // The retry of the originally-failed charge succeeds; the retry of the
    // originally-skipped charge stays skipped (e.g. SMS provider still off).
    // The "failed without kind" charge must NOT reach this stub at all
    // (the route short-circuits it).
    sendLevyReceiptMock.mockImplementation(async (opts) => {
      if (opts.clubMemberId === failedCharge.memberId) {
        // Mixed per-channel outcome: email delivered, push hard-failed,
        // SMS opted-out, WhatsApp had no phone on file. The aggregate is
        // "sent" because at least one channel went out.
        return receipt("sent", undefined, {
          email: { status: "sent" },
          push: { status: "failed", error: "push_delivery_failed" },
          sms: { status: "opted_out" },
          whatsapp: { status: "no_address" },
        });
      }
      if (opts.clubMemberId === skippedCharge.memberId) {
        // Provider-not-configured on SMS; everything else opted out.
        return receipt("skipped", "provider_not_configured", {
          email: { status: "opted_out" },
          push: { status: "no_user" },
          sms: { status: "skipped", error: "provider_not_configured" },
          whatsapp: { status: "skipped", error: "provider_not_configured" },
        });
      }
      throw new Error(
        `unexpected sendLevyReceipt call for member ${opts.clubMemberId}`,
      );
    });

    // ── Sanity check the summary BEFORE the bulk resend ──────────────────
    // We expect 1 failed (failed) + 1 skipped (skipped) + 1 failed without
    // kind (counted as failed because lastReceiptKind is null → not counted
    // by the summary, which gates on lastReceiptKind being set).
    const before = await request(app).get(CHARGES_URL());
    expect(before.status).toBe(200);
    expect(before.body.summary.failedReceiptCount).toBe(1);
    expect(before.body.summary.skippedReceiptCount).toBe(1);

    // ── Fire the bulk resend ─────────────────────────────────────────────
    const res = await request(app).post(URL()).send({});
    expect(res.status, `bulk resend failed: ${res.text}`).toBe(200);

    // The route should have attempted exactly 3 charges (failed + skipped +
    // failed_no_kind). The "sent" and "no_receipt" charges are excluded by
    // the WHERE clause on the underlying query.
    expect(res.body.attempted).toBe(3);
    expect(res.body.sent).toBe(1);
    expect(res.body.skipped).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.results).toHaveLength(3);

    // Only the two charges with a valid persisted kind should have actually
    // invoked sendLevyReceipt — the malformed one is short-circuited.
    expect(sendLevyReceiptMock).toHaveBeenCalledTimes(2);

    const byCharge = new Map<number, typeof res.body.results[number]>(
      res.body.results.map((r: { chargeId: number }) => [r.chargeId, r]),
    );
    expect(byCharge.get(failedCharge.chargeId)?.status).toBe("sent");
    expect(byCharge.get(skippedCharge.chargeId)?.status).toBe("skipped");
    expect(byCharge.get(skippedCharge.chargeId)?.reason).toBe("provider_not_configured");
    expect(byCharge.get(failedNoKindCharge.chargeId)?.status).toBe("failed");
    expect(byCharge.get(failedNoKindCharge.chargeId)?.reason).toBe("missing_receipt_kind");
    // Defensive: the already-sent charge must not appear at all.
    expect(byCharge.has(sentCharge.chargeId)).toBe(false);

    // ── Per-channel breakdown surfaced on each result entry (Task #352) ──
    const failedEntry = byCharge.get(failedCharge.chargeId)!;
    expect(failedEntry.channels).toEqual({
      email: { status: "sent" },
      push: { status: "failed", error: "push_delivery_failed" },
      sms: { status: "opted_out" },
      whatsapp: { status: "no_address" },
    });
    const skippedEntry = byCharge.get(skippedCharge.chargeId)!;
    expect(skippedEntry.channels).toEqual({
      email: { status: "opted_out" },
      push: { status: "no_user" },
      sms: { status: "skipped", error: "provider_not_configured" },
      whatsapp: { status: "skipped", error: "provider_not_configured" },
    });
    // Short-circuited (malformed) entries still carry a uniform per-channel
    // block so the UI can render the row without special-casing it.
    const noKindEntry = byCharge.get(failedNoKindCharge.chargeId)!;
    expect(noKindEntry.channels).toEqual({
      email: { status: "skipped" },
      push: { status: "skipped" },
      sms: { status: "skipped" },
      whatsapp: { status: "skipped" },
    });

    // ── Aggregate channel-level totals ───────────────────────────────────
    // Across the 3 attempted charges (failed + skipped + failed_no_kind):
    //   email:   1 sent, 1 opted_out, 1 skipped
    //   push:    1 failed, 1 no_user, 1 skipped
    //   sms:     1 opted_out, 1 skipped (provider_not_configured), 1 skipped
    //   whatsapp:1 no_address, 1 skipped (provider_not_configured), 1 skipped
    expect(res.body.channelTotals).toEqual({
      email:    { sent: 1, failed: 0, no_address: 0, no_user: 0, opted_out: 1, skipped: 1 },
      push:     { sent: 0, failed: 1, no_address: 0, no_user: 1, opted_out: 0, skipped: 1 },
      sms:      { sent: 0, failed: 0, no_address: 0, no_user: 0, opted_out: 1, skipped: 2 },
      whatsapp: { sent: 0, failed: 0, no_address: 1, no_user: 0, opted_out: 0, skipped: 2 },
    });

    // ── Per-charge persisted state should reflect the new outcomes ──────
    const updated = await db.select({
      id: memberLevyChargesTable.id,
      lastReceiptStatus: memberLevyChargesTable.lastReceiptStatus,
      lastReceiptReason: memberLevyChargesTable.lastReceiptReason,
    }).from(memberLevyChargesTable).where(inArray(
      memberLevyChargesTable.id,
      [failedCharge.chargeId, skippedCharge.chargeId, sentCharge.chargeId, failedNoKindCharge.chargeId],
    ));
    const updatedById = new Map(updated.map((u) => [u.id, u]));
    expect(updatedById.get(failedCharge.chargeId)?.lastReceiptStatus).toBe("sent");
    expect(updatedById.get(skippedCharge.chargeId)?.lastReceiptStatus).toBe("skipped");
    expect(updatedById.get(skippedCharge.chargeId)?.lastReceiptReason).toBe("provider_not_configured");
    // The "sent" charge must be untouched.
    expect(updatedById.get(sentCharge.chargeId)?.lastReceiptStatus).toBe("sent");
    // The malformed charge stays "failed" (the route doesn't call
    // persistReceiptStatus for the short-circuited case, so its prior status
    // remains).
    expect(updatedById.get(failedNoKindCharge.chargeId)?.lastReceiptStatus).toBe("failed");

    // ── Audit-log: one row per *attempted* charge that reached the
    // sendLevyReceipt path. The malformed-kind branch returns early before
    // the audit row, so we only expect rows for the two real attempts.
    const audits = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, testOrgId),
        eq(memberAuditLogTable.entity, "levy_charge"),
        inArray(memberAuditLogTable.entityId, [
          failedCharge.chargeId,
          skippedCharge.chargeId,
          failedNoKindCharge.chargeId,
        ]),
      ));
    const auditByEntity = new Map<number, typeof audits[number]>();
    for (const a of audits) {
      // Keep only the most recent per entity for a robust assertion.
      if (a.entityId == null) continue;
      auditByEntity.set(a.entityId, a);
    }
    expect(auditByEntity.get(failedCharge.chargeId)?.action).toBe("update");
    expect(auditByEntity.get(failedCharge.chargeId)?.reason).toMatch(/Bulk resend.*sent/);
    expect(auditByEntity.get(skippedCharge.chargeId)?.action).toBe("update");
    expect(auditByEntity.get(skippedCharge.chargeId)?.reason).toMatch(/Bulk resend.*skipped/);
    // Malformed entry: route short-circuits before recording audit.
    expect(auditByEntity.has(failedNoKindCharge.chargeId)).toBe(false);

    // ── GET /charges summary should now reflect the residual ─────────────
    const after = await request(app).get(CHARGES_URL());
    expect(after.status).toBe(200);
    // After the retry: the originally-failed charge is now sent (no longer
    // counted), the originally-skipped charge is still skipped (still
    // counted), and the malformed-kind charge has lastReceiptKind=null so
    // the summary doesn't include it in either bucket.
    expect(after.body.summary.failedReceiptCount).toBe(0);
    expect(after.body.summary.skippedReceiptCount).toBe(1);
  });
});
