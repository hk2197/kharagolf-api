/**
 * Task #1289 — Admin-triggered re-verification of a single member's
 * wallet payout account.
 *
 * Mirrors the coach sibling at
 *   POST /coach-marketplace/admin/coaches/:proId/payout-account/reverify
 * (Task #1062 / #1222). Until this task an admin had to wait up to a
 * day for the nightly `reverifyStaleWalletPayoutAccounts` cron
 * (Task #1119) before a member who'd just re-issued their UPI / bank
 * account could withdraw again.
 *
 * Verifies the three reverify branches the cron itself exercises:
 *   - `verified`         — successful re-check, row is bumped & failure
 *                          reason cleared.
 *   - `needs_attention`  — failed re-check, row flips and the member
 *                          notify path runs (we just assert the row +
 *                          response — the full notify side-effects
 *                          have their own coverage in
 *                          `wallet-reverify-payouts.test.ts`).
 *   - `skipped`          — Razorpay penny-drop still pending; the row
 *                          is intentionally left untouched so the next
 *                          tick (or admin retry) can converge.
 *
 * Plus permission gating (anonymous → 401, cross-org admin → 403,
 * unknown id → 404, no fund-account → 400). The coach-side audit-row
 * test (`coach-admin-payout-account-reverify-audit.test.ts`) covers
 * the equivalent cross-org / not-found checks for that route — we
 * mirror those here for parity.
 *
 * Razorpay HTTP calls are mocked; we never hit a real Razorpay
 * endpoint from a test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

process.env.SESSION_SECRET ||= "test-session-secret-wallet-admin-reverify";

const {
  validateRazorpayVpaMock,
  validateRazorpayBankFundAccountMock,
} = vi.hoisted(() => ({
  validateRazorpayVpaMock: vi.fn(),
  validateRazorpayBankFundAccountMock: vi.fn(),
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
// `wallet-reverify-payouts.test.ts`. Here we only care that the admin
// route correctly drives `reverifyOneWalletAccount` and surfaces the
// outcome.
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

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  walletPayoutAccountsTable,
  memberMessagesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
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

const STALE = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000); // 100 days old

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `WAdminReverify_${stamp}`,
    slug: `wadmin-reverify-${stamp}`,
    contactEmail: `wadmin-${stamp}@example.test`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `WAdminReverifyOther_${stamp}`,
    slug: `wadmin-reverify-other-${stamp}`,
    contactEmail: `wadmin-other-${stamp}@example.test`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  const [m] = await db.insert(appUsersTable).values({
    replitUserId: `wadmin-member-${stamp}`,
    username: `wadmin_member_${stamp}`,
    email: `wadmin_member_${stamp}@example.com`,
    displayName: "WAdmin Member",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  memberUserId = m.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `wadmin-admin-${stamp}`,
    username: `wadmin_admin_${stamp}`,
    email: `wadmin_admin_${stamp}@example.com`,
    displayName: "WAdmin Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = a.id;

  const [oa] = await db.insert(appUsersTable).values({
    replitUserId: `wadmin-other-admin-${stamp}`,
    username: `wadmin_other_admin_${stamp}`,
    email: `wadmin_other_admin_${stamp}@example.com`,
    displayName: "WAdmin Other Admin",
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
    email: `wadmin_member_${stamp}@example.com`,
    firstName: "WAdmin",
    lastName: "Member",
  }).returning({ id: clubMembersTable.id });
  clubMemberId = cm.id;

  admin = {
    id: adminUserId, username: `wadmin_admin_${stamp}`,
    displayName: "WAdmin Admin", role: "org_admin", organizationId: orgId,
  };
  otherOrgAdmin = {
    id: otherOrgAdminUserId, username: `wadmin_other_admin_${stamp}`,
    displayName: "WAdmin Other Admin", role: "org_admin", organizationId: otherOrgId,
  };

  appAsAdmin = createTestApp(admin);
  appAsOtherOrgAdmin = createTestApp(otherOrgAdmin);
  appAnonymous = createTestApp();
});

afterAll(async () => {
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
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(walletPayoutAccountsTable).where(eq(walletPayoutAccountsTable.organizationId, orgId));
});

async function seedAccount(overrides: Partial<typeof walletPayoutAccountsTable.$inferInsert> = {}) {
  const [row] = await db.insert(walletPayoutAccountsTable).values({
    organizationId: orgId,
    userId: memberUserId,
    method: "upi",
    accountHolderName: "WAdmin Member",
    upiVpa: "wadminmember@upi",
    razorpayContactId: "cont_wadmin",
    razorpayFundAccountId: "fa_wadmin",
    verifiedAt: STALE,
    verificationStatus: "verified",
    ...overrides,
  }).returning();
  return row;
}

const URL_FOR = (id: number) =>
  `/api/admin/wallet/payout-accounts/${id}/reverify`;

describe("POST /admin/wallet/payout-accounts/:id/reverify", () => {
  it("UPI verified: bumps verifiedAt, clears stale failure reason, returns updated row + outcome=verified", async () => {
    const seeded = await seedAccount({
      verificationFailureReason: "stale message that should be cleared",
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "wadminmember@upi", success: true, customer_name: "WADMIN MEMBER",
    });

    const res = await request(appAsAdmin).post(URL_FOR(seeded.id)).send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("verified");
    expect(res.body.method).toBe("upi");
    expect(res.body.reason).toBeNull();
    expect(res.body.account).toBeDefined();
    expect(res.body.account.id).toBe(seeded.id);
    expect(res.body.account.verificationStatus).toBe("verified");
    expect(res.body.account.verificationFailureReason).toBeNull();

    // Persisted row matches the returned snapshot.
    const [row] = await db.select().from(walletPayoutAccountsTable)
      .where(eq(walletPayoutAccountsTable.id, seeded.id));
    expect(row.verificationStatus).toBe("verified");
    expect(row.verificationFailureReason).toBeNull();
    expect(row.verifiedAt!.getTime()).toBeGreaterThan(STALE.getTime());
  });

  it("Bank: flips to needs_attention on a failed penny-drop and returns outcome + reason", async () => {
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

    const res = await request(appAsAdmin).post(URL_FOR(seeded.id)).send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("needs_attention");
    expect(res.body.method).toBe("bank_account");
    expect(typeof res.body.reason).toBe("string");
    expect(res.body.reason).toContain("Account closed");
    expect(res.body.account.verificationStatus).toBe("needs_attention");
    expect(res.body.account.verificationFailureReason).toContain("Account closed");

    // Member-facing in-app message landed (sanity — the full notify
    // side-effect coverage lives in `wallet-reverify-payouts.test.ts`).
    const msgs = await db.select().from(memberMessagesTable)
      .where(eq(memberMessagesTable.clubMemberId, clubMemberId));
    expect(msgs.length).toBeGreaterThanOrEqual(1);
  });

  it("Bank: penny-drop still pending → outcome=skipped, row left untouched (admin can retry)", async () => {
    const seeded = await seedAccount({
      method: "bank_account",
      upiVpa: null,
      bankAccountNumber: "1234567890",
      bankIfsc: "ICIC0001234",
      verificationStatus: "verified",
      verifiedAt: STALE,
    });
    validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
      id: "fav_pending", status: "created",
    });

    const res = await request(appAsAdmin).post(URL_FOR(seeded.id)).send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("skipped");
    expect(res.body.method).toBe("bank_account");
    // The row is intentionally left as-is so the next reverify attempt
    // (cron tick or another admin click) can converge.
    expect(res.body.account.verificationStatus).toBe("verified");
    expect(new Date(res.body.account.verifiedAt).getTime()).toBe(STALE.getTime());

    const [row] = await db.select().from(walletPayoutAccountsTable)
      .where(eq(walletPayoutAccountsTable.id, seeded.id));
    expect(row.verificationStatus).toBe("verified");
    expect(row.verifiedAt!.getTime()).toBe(STALE.getTime());
  });

  it("returns 404 for an unknown account id", async () => {
    const res = await request(appAsAdmin).post(URL_FOR(99_999_999)).send({});
    expect(res.status).toBe(404);
    expect(validateRazorpayVpaMock).not.toHaveBeenCalled();
    expect(validateRazorpayBankFundAccountMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the account has no Razorpay fund-account on file", async () => {
    const seeded = await seedAccount({ razorpayFundAccountId: null });
    const res = await request(appAsAdmin).post(URL_FOR(seeded.id)).send({});
    expect(res.status).toBe(400);
    expect(validateRazorpayVpaMock).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers (401)", async () => {
    const seeded = await seedAccount();
    const res = await request(appAnonymous).post(URL_FOR(seeded.id)).send({});
    expect(res.status).toBe(401);
    expect(validateRazorpayVpaMock).not.toHaveBeenCalled();
  });

  it("rejects an org_admin from a different organization (403)", async () => {
    const seeded = await seedAccount();
    const res = await request(appAsOtherOrgAdmin).post(URL_FOR(seeded.id)).send({});
    expect(res.status).toBe(403);
    expect(validateRazorpayVpaMock).not.toHaveBeenCalled();
  });
});
