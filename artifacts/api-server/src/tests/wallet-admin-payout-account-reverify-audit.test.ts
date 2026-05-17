/**
 * Task #1518 — Tests for the admin-triggered wallet payout-account
 * re-verify endpoint's audit-trail row.
 *
 * `POST /api/admin/wallet/payout-accounts/:id/reverify` runs the same
 * Razorpay validation the nightly cron (Task #1119) does. Until this
 * task it never wrote a row to a history table — only a structured log
 * line — so the compliance question "who triggered the re-check that
 * flipped this member to needs_attention?" was unanswerable once log
 * rotation kicked in. We now persist a row with
 * `change_kind = 'admin_reverify'` carrying the verification outcome +
 * reason, the calling admin's id / IP / user-agent, and a masked
 * snapshot of the saved account.
 *
 * Mirrors `coach-admin-payout-account-reverify-audit.test.ts` (Task
 * #1222) — same shape, same coverage:
 *   - happy-path UPI verified                  → verified row, masked VPA
 *   - happy-path bank account → needs_attention → row carries reason +
 *                                                masked last4/IFSC, no
 *                                                raw account number
 *   - history list endpoint surfaces the row with admin name joined
 *   - 400 on no-saved-account writes no audit row
 *   - 500 (not 200) when the audit insert fails — preserves the
 *     compliance contract that a 200 implies a persisted audit row
 *   - anonymous + cross-org admin callers do not write audit rows
 *
 * Razorpay HTTP calls are mocked; we never hit a real Razorpay
 * endpoint from a test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

process.env.SESSION_SECRET ||= "test-session-secret-wallet-admin-reverify-audit";

const {
  validateRazorpayVpaMock,
  validateRazorpayBankFundAccountMock,
  recordWalletAdminReverifyHistoryMock,
} = vi.hoisted(() => ({
  validateRazorpayVpaMock: vi.fn(),
  validateRazorpayBankFundAccountMock: vi.fn(),
  recordWalletAdminReverifyHistoryMock: vi.fn<
    typeof import("../lib/walletPayoutAccountReverifyAudit").recordWalletAdminReverifyHistory
  >(),
}));
vi.mock("../lib/razorpay", async () => {
  const actual = await vi.importActual<typeof import("../lib/razorpay")>("../lib/razorpay");
  return {
    ...actual,
    validateRazorpayVpa: validateRazorpayVpaMock,
    validateRazorpayBankFundAccount: validateRazorpayBankFundAccountMock,
  };
});
// Notification side-effects are silenced — they're covered by
// `wallet-reverify-payouts.test.ts`. Here we only care about the audit
// row this task adds.
vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendMemberPayoutAccountNeedsAttentionEmail: vi.fn(async () => undefined),
  };
});
vi.mock("../lib/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push.js")>();
  return {
    ...actual,
    sendPushToUsers: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
  };
});
// Mock the audit-row helper so the failure-mode test can simulate a
// persistence error without touching the real database. The mock is
// pre-wired to delegate to the real implementation, so the rest of the
// suite exercises the genuine insert path against the test DB —
// `beforeEach` resets the implementation back to the real one in case
// any test overrode it.
vi.mock("../lib/walletPayoutAccountReverifyAudit", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/walletPayoutAccountReverifyAudit")
  >("../lib/walletPayoutAccountReverifyAudit");
  recordWalletAdminReverifyHistoryMock.mockImplementation(actual.recordWalletAdminReverifyHistory);
  return {
    ...actual,
    recordWalletAdminReverifyHistory: recordWalletAdminReverifyHistoryMock,
  };
});

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  walletPayoutAccountsTable,
  walletPayoutAccountHistoryTable,
  memberMessagesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let otherOrgId: number;
let memberUserId: number;
let adminUserId: number;
let otherOrgAdminUserId: number;
let clubMemberId: number;

let admin: TestUser;
let otherOrgAdmin: TestUser;

let appAsAdmin: ReturnType<typeof createTestApp>;
let appAsOtherOrgAdmin: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;

const STALE = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `WAdminReverifyAudit_${stamp}`,
    slug: `wadmin-reverify-audit-${stamp}`,
    contactEmail: `wadmin-audit-${stamp}@example.test`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `WAdminReverifyAuditOther_${stamp}`,
    slug: `wadmin-reverify-audit-other-${stamp}`,
    contactEmail: `wadmin-audit-other-${stamp}@example.test`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  const [m] = await db.insert(appUsersTable).values({
    replitUserId: `wadmin-audit-member-${stamp}`,
    username: `wadmin_audit_member_${stamp}`,
    email: `wadmin_audit_member_${stamp}@example.com`,
    displayName: "WAudit Member",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  memberUserId = m.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `wadmin-audit-admin-${stamp}`,
    username: `wadmin_audit_admin_${stamp}`,
    email: `wadmin_audit_admin_${stamp}@example.com`,
    displayName: "WAudit Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = a.id;

  const [oa] = await db.insert(appUsersTable).values({
    replitUserId: `wadmin-audit-other-admin-${stamp}`,
    username: `wadmin_audit_other_admin_${stamp}`,
    email: `wadmin_audit_other_admin_${stamp}@example.com`,
    displayName: "WAudit Other Admin",
    role: "org_admin",
    organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  otherOrgAdminUserId = oa.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: memberUserId, role: "player" },
    { organizationId: orgId, userId: adminUserId, role: "org_admin" },
    { organizationId: otherOrgId, userId: otherOrgAdminUserId, role: "org_admin" },
  ]);

  const [cm] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: memberUserId,
    email: `wadmin_audit_member_${stamp}@example.com`,
    firstName: "WAudit",
    lastName: "Member",
  }).returning({ id: clubMembersTable.id });
  clubMemberId = cm.id;

  admin = {
    id: adminUserId, username: `wadmin_audit_admin_${stamp}`,
    displayName: "WAudit Admin", role: "org_admin", organizationId: orgId,
  };
  otherOrgAdmin = {
    id: otherOrgAdminUserId, username: `wadmin_audit_other_admin_${stamp}`,
    displayName: "WAudit Other Admin", role: "org_admin", organizationId: otherOrgId,
  };

  appAsAdmin = createTestApp(admin);
  appAsOtherOrgAdmin = createTestApp(otherOrgAdmin);
  appAnonymous = createTestApp();
});

afterAll(async () => {
  // History rows cascade from the parent payout account row, but be
  // explicit so a failed test doesn't leave orphans behind.
  await db.delete(walletPayoutAccountHistoryTable)
    .where(eq(walletPayoutAccountHistoryTable.organizationId, orgId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(walletPayoutAccountsTable).where(eq(walletPayoutAccountsTable.organizationId, orgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, orgId));
  const userIds = [memberUserId, adminUserId, otherOrgAdminUserId].filter(Boolean);
  if (userIds.length) await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  const orgIds = [orgId, otherOrgId].filter(Boolean);
  if (orgIds.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgIds));
});

beforeEach(async () => {
  validateRazorpayVpaMock.mockReset();
  validateRazorpayBankFundAccountMock.mockReset();
  // Restore the audit helper to its real implementation (the failure-
  // mode test temporarily overrides it). We re-import via
  // `vi.importActual` so we always get the un-mocked function.
  const realModule = await vi.importActual<
    typeof import("../lib/walletPayoutAccountReverifyAudit")
  >("../lib/walletPayoutAccountReverifyAudit");
  recordWalletAdminReverifyHistoryMock.mockReset();
  recordWalletAdminReverifyHistoryMock.mockImplementation(realModule.recordWalletAdminReverifyHistory);
  // Each test seeds its own account — start from a clean slate.
  await db.delete(walletPayoutAccountHistoryTable)
    .where(eq(walletPayoutAccountHistoryTable.organizationId, orgId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(walletPayoutAccountsTable).where(eq(walletPayoutAccountsTable.organizationId, orgId));
});

async function seedAccount(overrides: Partial<typeof walletPayoutAccountsTable.$inferInsert> = {}) {
  const [row] = await db.insert(walletPayoutAccountsTable).values({
    organizationId: orgId,
    userId: memberUserId,
    method: "upi",
    accountHolderName: "WAudit Member",
    upiVpa: "alice.long@upi",
    razorpayContactId: "cont_audit",
    razorpayFundAccountId: "fa_audit",
    verifiedAt: STALE,
    verificationStatus: "verified",
    ...overrides,
  }).returning();
  return row;
}

const REVERIFY_URL = (id: number) => `/api/admin/wallet/payout-accounts/${id}/reverify`;
const HISTORY_URL = (id: number) => `/api/admin/wallet/payout-accounts/${id}/history`;

describe("POST /admin/wallet/payout-accounts/:id/reverify — audit row", () => {
  it("inserts an admin_reverify history row when the re-check confirms the UPI account is still verified", async () => {
    const seeded = await seedAccount();
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "alice.long@upi", success: true, customer_name: "WAUDIT MEMBER",
    });

    const res = await request(appAsAdmin)
      .post(REVERIFY_URL(seeded.id))
      .set("User-Agent", "AdminUI/1.2 (test)")
      .set("X-Forwarded-For", "203.0.113.7")
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("verified");

    const rows = await db.select().from(walletPayoutAccountHistoryTable)
      .where(eq(walletPayoutAccountHistoryTable.walletPayoutAccountId, seeded.id));
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.changeKind).toBe("admin_reverify");
    expect(r.changedByRole).toBe("admin");
    expect(r.changedByUserId).toBe(adminUserId);
    expect(r.organizationId).toBe(orgId);
    expect(r.userId).toBe(memberUserId);
    expect(r.method).toBe("upi");
    expect(r.razorpayFundAccountId).toBe("fa_audit");
    expect(r.razorpayContactId).toBe("cont_audit");
    expect(r.verificationOutcome).toBe("verified");
    expect(r.verificationReason).toBeNull();
    // VPA is masked — the raw value never appears in the audit row.
    expect(r.upiVpaMasked).not.toBe("alice.long@upi");
    expect(r.upiVpaMasked).toContain("@upi");
    expect(r.bankAccountLast4).toBeNull();
    expect(r.userAgent).toBe("AdminUI/1.2 (test)");
    // req.ip in supertest reflects the loopback address; X-Forwarded-For
    // isn't auto-trusted by Express without `trust proxy`. We just
    // assert *something* was recorded (or null), never undefined.
    expect(typeof r.ipAddress === "string" || r.ipAddress === null).toBe(true);
  });

  it("inserts an admin_reverify history row carrying the failure reason when the bank account no longer accepts transfers", async () => {
    const seeded = await seedAccount({
      method: "bank_account",
      upiVpa: null,
      bankAccountNumber: "9876543210",
      bankIfsc: "HDFC0000999",
    });
    validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
      id: "fav_bad", status: "failed",
      error: { description: "Account closed by bank", code: "ACC_CLOSED" },
    });

    const res = await request(appAsAdmin)
      .post(REVERIFY_URL(seeded.id))
      .set("User-Agent", "AdminUI/1.2 (test)")
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("needs_attention");
    expect(res.body.reason).toContain("Account closed");

    const rows = await db.select().from(walletPayoutAccountHistoryTable)
      .where(eq(walletPayoutAccountHistoryTable.walletPayoutAccountId, seeded.id));
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.changeKind).toBe("admin_reverify");
    expect(r.changedByRole).toBe("admin");
    expect(r.changedByUserId).toBe(adminUserId);
    expect(r.method).toBe("bank_account");
    expect(r.verificationOutcome).toBe("needs_attention");
    expect(r.verificationReason).toContain("Account closed");
    // Masked snapshot mirrors the saved account.
    expect(r.bankAccountLast4).toBe("3210");
    expect(r.bankIfsc).toBe("HDFC0000999");
    expect(r.upiVpaMasked).toBeNull();
    // Raw account number must never appear in the audit row.
    expect(JSON.stringify(r)).not.toContain("9876543210");
  });

  it("inserts a single admin_reverify history row even when the penny-drop is still pending (skipped outcome)", async () => {
    const seeded = await seedAccount({
      method: "bank_account",
      upiVpa: null,
      bankAccountNumber: "1234567890",
      bankIfsc: "ICIC0001234",
    });
    validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
      id: "fav_pending", status: "created",
    });

    const res = await request(appAsAdmin).post(REVERIFY_URL(seeded.id)).send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("skipped");

    // A `skipped` outcome still gets an audit row — the admin still
    // *triggered* a re-check, the result was just that we couldn't
    // tell yet. This matches the coach-side audit semantics.
    const rows = await db.select().from(walletPayoutAccountHistoryTable)
      .where(eq(walletPayoutAccountHistoryTable.walletPayoutAccountId, seeded.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].verificationOutcome).toBe("skipped");
  });

  it("surfaces the new audit row through the per-account history endpoint with verificationOutcome / verificationReason and admin name", async () => {
    const seeded = await seedAccount({ upiVpa: "carol@upi" });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "carol@upi", success: false,
    });

    const reverifyRes = await request(appAsAdmin).post(REVERIFY_URL(seeded.id)).send({});
    expect(reverifyRes.status, reverifyRes.text).toBe(200);
    expect(reverifyRes.body.outcome).toBe("needs_attention");

    const listRes = await request(appAsAdmin).get(HISTORY_URL(seeded.id));
    expect(listRes.status, listRes.text).toBe(200);
    expect(listRes.body.account).toBeDefined();
    expect(listRes.body.account.id).toBe(seeded.id);
    const history = listRes.body.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    const entry = history[0];
    expect(entry.changeKind).toBe("admin_reverify");
    expect(entry.verificationOutcome).toBe("needs_attention");
    expect(typeof entry.verificationReason).toBe("string");
    expect(entry.changedByRole).toBe("admin");
    expect(entry.changedByName).toBe("WAudit Admin");
    expect(entry.upiVpaMasked).not.toBe("carol@upi");
  });

  it("returns 400 and writes no audit row when the account has no Razorpay fund account on file", async () => {
    const seeded = await seedAccount({ razorpayFundAccountId: null });
    const res = await request(appAsAdmin).post(REVERIFY_URL(seeded.id)).send({});
    expect(res.status).toBe(400);

    const rows = await db.select().from(walletPayoutAccountHistoryTable)
      .where(eq(walletPayoutAccountHistoryTable.walletPayoutAccountId, seeded.id));
    expect(rows).toHaveLength(0);
    expect(recordWalletAdminReverifyHistoryMock).not.toHaveBeenCalled();
  });

  it("returns 500 (rather than silently succeeding) when the audit-row insert fails", async () => {
    // Compliance contract: a 200 from this endpoint must imply an
    // `admin_reverify` row has been persisted. We simulate a DB failure
    // on just the history insert (via the typed audit-helper mock set
    // up at the top of this file) and assert the request fails loudly
    // so the admin retries — leaving an unaudited state change would
    // be worse than the user-visible error.
    const seeded = await seedAccount({ upiVpa: "frank@upi" });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "frank@upi", success: true, customer_name: "WAUDIT MEMBER",
    });
    recordWalletAdminReverifyHistoryMock.mockRejectedValueOnce(
      new Error("simulated audit insert failure"),
    );

    const res = await request(appAsAdmin).post(REVERIFY_URL(seeded.id)).send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/audit/i);

    // The helper was invoked exactly once with the expected payload —
    // proving the route reached the persistence step.
    expect(recordWalletAdminReverifyHistoryMock).toHaveBeenCalledTimes(1);
    const call = recordWalletAdminReverifyHistoryMock.mock.calls[0]![0];
    expect(call.walletPayoutAccountId).toBe(seeded.id);
    expect(call.organizationId).toBe(orgId);
    expect(call.userId).toBe(memberUserId);
    expect(call.adminUserId).toBe(adminUserId);
    expect(call.outcome).toBe("verified");
    expect(call.accountBefore.razorpayFundAccountId).toBe("fa_audit");

    // No admin_reverify row landed in the table.
    const rows = await db.select().from(walletPayoutAccountHistoryTable)
      .where(and(
        eq(walletPayoutAccountHistoryTable.walletPayoutAccountId, seeded.id),
        eq(walletPayoutAccountHistoryTable.changeKind, "admin_reverify"),
      ));
    expect(rows).toHaveLength(0);
  });

  it("rejects unauthenticated and cross-org admin callers without writing an audit row", async () => {
    const seeded = await seedAccount();

    const anonRes = await request(appAnonymous).post(REVERIFY_URL(seeded.id)).send({});
    expect(anonRes.status).toBe(401);

    const otherRes = await request(appAsOtherOrgAdmin).post(REVERIFY_URL(seeded.id)).send({});
    expect(otherRes.status).toBe(403);

    const rows = await db.select().from(walletPayoutAccountHistoryTable)
      .where(eq(walletPayoutAccountHistoryTable.walletPayoutAccountId, seeded.id));
    expect(rows).toHaveLength(0);
    expect(recordWalletAdminReverifyHistoryMock).not.toHaveBeenCalled();
  });
});

describe("GET /admin/wallet/payout-accounts/:id/history", () => {
  it("returns 404 for an unknown account id", async () => {
    const res = await request(appAsAdmin).get(HISTORY_URL(99_999_999));
    expect(res.status).toBe(404);
  });

  it("rejects an org_admin from a different organization (403)", async () => {
    const seeded = await seedAccount();
    const res = await request(appAsOtherOrgAdmin).get(HISTORY_URL(seeded.id));
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers (401)", async () => {
    const seeded = await seedAccount();
    const res = await request(appAnonymous).get(HISTORY_URL(seeded.id));
    expect(res.status).toBe(401);
  });

  it("returns an empty history list for an account that has never been re-verified", async () => {
    const seeded = await seedAccount();
    const res = await request(appAsAdmin).get(HISTORY_URL(seeded.id));
    expect(res.status, res.text).toBe(200);
    expect(res.body.history).toEqual([]);
    expect(res.body.account.id).toBe(seeded.id);
  });

  it("returns audit rows newest-first", async () => {
    const seeded = await seedAccount();
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "alice.long@upi", success: true, customer_name: "WAUDIT MEMBER",
    });
    const r1 = await request(appAsAdmin).post(REVERIFY_URL(seeded.id)).send({});
    expect(r1.status, r1.text).toBe(200);

    // Small delay so the second row's createdAt is strictly later.
    await new Promise(r => setTimeout(r, 25));

    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "alice.long@upi", success: false,
    });
    const r2 = await request(appAsAdmin).post(REVERIFY_URL(seeded.id)).send({});
    expect(r2.status, r2.text).toBe(200);

    const listRes = await request(appAsAdmin).get(HISTORY_URL(seeded.id));
    expect(listRes.status, listRes.text).toBe(200);
    const history = listRes.body.history as Array<{ verificationOutcome: string }>;
    expect(history).toHaveLength(2);
    // newest first
    expect(history[0].verificationOutcome).toBe("needs_attention");
    expect(history[1].verificationOutcome).toBe("verified");
  });
});
