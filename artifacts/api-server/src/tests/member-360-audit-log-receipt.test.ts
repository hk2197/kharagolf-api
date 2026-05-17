/**
 * Integration test: Receipt-status enrichment on the Member 360 audit log (Task #253 / #291).
 *
 * Covers GET /api/organizations/:orgId/members-360/:memberId/audit-log:
 *   - rows for entity='levy_charge' return the joined receiptStatus,
 *     receiptLevyId, receiptKind, receiptAmount, receiptReason, receiptAt
 *   - non-levy rows (e.g. entity='profile') return null receipt fields
 *   - the resend shortcut endpoint that the audit-log UI posts to
 *     (POST /levies/:id/charges/:memberId/resend-receipt) exists for the
 *     same charge and accepts the receiptLevyId surfaced by the join
 *
 * Guards against a regression that drops the leftJoin in member-360.ts (e.g.
 * someone narrowing the select shape) which would silently hide the badges
 * in AuditTab.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

// The resend-receipt endpoint fans out to the levy-receipt mailer/push/sms.
// Mock the helper so the test doesn't touch real providers — we only need to
// verify the route is reachable for the receiptLevyId returned by the audit
// join (the receipt-fan-out itself is covered in levy-receipt-notify.test.ts).
vi.mock("../lib/levyReceiptNotify.js", async () => {
  return {
    sendLevyReceipt: vi.fn(async () => ({
      status: "sent" as const,
      reason: null,
      email: { status: "sent" as const, error: null },
      push: { status: "sent" as const, error: null },
      sms: { status: "opted_out" as const, error: null },
    })),
    LEVY_RECEIPT_MAX_PUSH_ATTEMPTS: 3,
    LEVY_RECEIPT_MAX_SMS_ATTEMPTS: 3,
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
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let adminUserId: number;
let memberId: number;
let levyId: number;
let sentChargeId: number;
let skippedChargeId: number;
let failedChargeId: number;
let admin: TestUser;
const auditIds: number[] = [];

const URL = () => `/api/organizations/${orgId}/members-360/${memberId}/audit-log`;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_AuditReceipt_${stamp}`,
    slug: `test-audit-receipt-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `audit-receipt-admin-${stamp}`,
    username: `audit_receipt_admin_${stamp}`,
    email: `audit_receipt_admin_${stamp}@example.com`,
    displayName: "Audit Receipt Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName: "Receipt",
    lastName: "Member",
    email: `receipt_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberId = m.id;

  const [levy] = await db.insert(memberLeviesTable).values({
    organizationId: orgId,
    name: `Test Levy ${stamp}`,
    amount: "100.00",
    currency: "INR",
    status: "applied",
    appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  levyId = levy.id;

  // Three charges with distinct lastReceiptStatus values so the test can
  // assert that each surfaces correctly through the leftJoin.
  const [sent] = await db.insert(memberLevyChargesTable).values({
    levyId,
    clubMemberId: memberId,
    amount: "100.00",
    status: "paid",
    paidAmount: "100.00",
    lastReceiptStatus: "sent",
    lastReceiptKind: "payment",
    lastReceiptAmount: "100.00",
    lastReceiptAt: new Date(),
  }).returning({ id: memberLevyChargesTable.id });
  sentChargeId = sent.id;

  // Skipped + failed charges need their own (levyId, clubMemberId) pair to
  // satisfy the unique index, so we create extra levies for them.
  const [levy2] = await db.insert(memberLeviesTable).values({
    organizationId: orgId,
    name: `Test Levy Skipped ${stamp}`,
    amount: "50.00",
    currency: "INR",
    status: "applied",
    appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  const [skipped] = await db.insert(memberLevyChargesTable).values({
    levyId: levy2.id,
    clubMemberId: memberId,
    amount: "50.00",
    status: "unpaid",
    lastReceiptStatus: "skipped",
    lastReceiptReason: "no_email",
    lastReceiptKind: "payment",
    lastReceiptAmount: "50.00",
    lastReceiptAt: new Date(),
  }).returning({ id: memberLevyChargesTable.id });
  skippedChargeId = skipped.id;

  const [levy3] = await db.insert(memberLeviesTable).values({
    organizationId: orgId,
    name: `Test Levy Failed ${stamp}`,
    amount: "75.00",
    currency: "INR",
    status: "applied",
    appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  const [failed] = await db.insert(memberLevyChargesTable).values({
    levyId: levy3.id,
    clubMemberId: memberId,
    amount: "75.00",
    status: "unpaid",
    lastReceiptStatus: "failed",
    lastReceiptReason: "smtp boom",
    lastReceiptKind: "partial_payment",
    lastReceiptAmount: "25.00",
    lastReceiptAt: new Date(),
  }).returning({ id: memberLevyChargesTable.id });
  failedChargeId = failed.id;

  // Audit rows: one update per levy_charge (entityId = charge id) and one
  // unrelated profile row to ensure the leftJoin doesn't bleed into it.
  const inserted = await db.insert(memberAuditLogTable).values([
    {
      organizationId: orgId, clubMemberId: memberId, actorUserId: adminUserId,
      actorName: "Audit Receipt Admin", actorRole: "org_admin",
      entity: "levy_charge", entityId: sentChargeId, action: "update",
      reason: "payment recorded",
    },
    {
      organizationId: orgId, clubMemberId: memberId, actorUserId: adminUserId,
      actorName: "Audit Receipt Admin", actorRole: "org_admin",
      entity: "levy_charge", entityId: skippedChargeId, action: "update",
      reason: "payment recorded",
    },
    {
      organizationId: orgId, clubMemberId: memberId, actorUserId: adminUserId,
      actorName: "Audit Receipt Admin", actorRole: "org_admin",
      entity: "levy_charge", entityId: failedChargeId, action: "update",
      reason: "payment recorded",
    },
    {
      organizationId: orgId, clubMemberId: memberId, actorUserId: adminUserId,
      actorName: "Audit Receipt Admin", actorRole: "org_admin",
      entity: "profile", entityId: 1, action: "update",
      reason: "profile updated",
    },
  ]).returning({ id: memberAuditLogTable.id });
  for (const r of inserted) auditIds.push(r.id);

  admin = {
    id: adminUserId,
    username: `audit_receipt_admin_${stamp}`,
    displayName: "Audit Receipt Admin",
    role: "org_admin",
    organizationId: orgId,
  };
});

afterAll(async () => {
  if (auditIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.id, auditIds));
  }
  if (memberId) {
    await db.delete(memberLevyChargesTable).where(eq(memberLevyChargesTable.clubMemberId, memberId));
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberId));
  }
  if (orgId) {
    await db.delete(memberLeviesTable).where(eq(memberLeviesTable.organizationId, orgId));
  }
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("GET /:memberId/audit-log — receipt-status enrichment", () => {
  it("returns the joined receiptStatus / receiptLevyId / etc. for entity='levy_charge' rows", async () => {
    const app = createTestApp(admin);
    const res = await request(app).get(URL());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const byEntityId = new Map<number, any>(
      res.body
        .filter((r: { entity: string }) => r.entity === "levy_charge")
        .map((r: { entityId: number }) => [r.entityId, r]),
    );

    const sentRow = byEntityId.get(sentChargeId);
    expect(sentRow).toBeTruthy();
    expect(sentRow.receiptStatus).toBe("sent");
    expect(sentRow.receiptLevyId).toBe(levyId);
    expect(sentRow.receiptKind).toBe("payment");
    expect(sentRow.receiptAmount).toBe("100.00");
    expect(sentRow.receiptAt).not.toBeNull();
    // Deep-link enrichment from the secondary lookup also resolves the parent
    // levy + charge id so the UI can link straight to the charge timeline.
    expect(sentRow.linkedLevyId).toBe(levyId);
    expect(sentRow.linkedChargeId).toBe(sentChargeId);

    const skippedRow = byEntityId.get(skippedChargeId);
    expect(skippedRow.receiptStatus).toBe("skipped");
    expect(skippedRow.receiptReason).toBe("no_email");
    expect(skippedRow.receiptLevyId).not.toBeNull();

    const failedRow = byEntityId.get(failedChargeId);
    expect(failedRow.receiptStatus).toBe("failed");
    expect(failedRow.receiptReason).toBe("smtp boom");
    expect(failedRow.receiptKind).toBe("partial_payment");
    expect(failedRow.receiptAmount).toBe("25.00");
  });

  it("returns null receipt fields for non-levy_charge rows (e.g. profile)", async () => {
    const app = createTestApp(admin);
    const res = await request(app).get(URL());
    expect(res.status).toBe(200);
    const profileRow = res.body.find((r: { entity: string }) => r.entity === "profile");
    expect(profileRow).toBeTruthy();
    expect(profileRow.receiptStatus).toBeNull();
    expect(profileRow.receiptLevyId).toBeNull();
    expect(profileRow.receiptKind).toBeNull();
    expect(profileRow.receiptAmount).toBeNull();
    expect(profileRow.receiptAt).toBeNull();
    expect(profileRow.receiptReason).toBeNull();
  });

  it("the receiptLevyId returned by the join routes back to a working resend-receipt endpoint", async () => {
    const app = createTestApp(admin);
    const auditRes = await request(app).get(URL());
    const failedRow = auditRes.body.find(
      (r: { entity: string; entityId: number }) =>
        r.entity === "levy_charge" && r.entityId === failedChargeId,
    );
    expect(failedRow.receiptLevyId).toBeTruthy();

    // The audit-log UI posts to this URL — verify the route exists and accepts
    // the receiptLevyId (not 404). That's the guarantee the badge + button
    // contract relies on.
    const resendRes = await request(app)
      .post(`/api/organizations/${orgId}/members-360/levies/${failedRow.receiptLevyId}/charges/${memberId}/resend-receipt`)
      .send({});
    expect([200, 201]).toContain(resendRes.status);
  });
});
