/**
 * Task #1119 — Periodic re-verification of members' wallet payout accounts.
 *
 * Verifies that:
 *   - The cron entry-point only picks up rows whose `verifiedAt` is older
 *     than the staleness window (default 60 days), and skips rows that are
 *     already marked `needs_attention`.
 *   - On a Razorpay VPA / penny-drop failure the row flips to
 *     `needs_attention`, the failure reason is persisted, and the member
 *     is notified by push + email + in-app message.
 *   - On a successful re-verification `verifiedAt` is bumped and any
 *     stale `verificationFailureReason` is cleared (and the member is NOT
 *     notified — that would be noise).
 *   - A "pending" penny-drop response is skipped without flipping the
 *     row's status (so the next tick can retry).
 *
 * Razorpay HTTP calls are mocked; mailer + push are spied on so we can
 * assert delivery without touching real services.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Hoisted Razorpay mocks must run before the lib module imports razorpay.
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

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  walletPayoutAccountsTable,
  memberMessagesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { reverifyStaleWalletPayoutAccounts } from "../lib/walletReverifyPayouts.js";
import { sendMemberPayoutAccountNeedsAttentionEmail } from "../lib/mailer.js";
import { sendPushToUsers } from "../lib/push.js";

const emailMock = vi.mocked(sendMemberPayoutAccountNeedsAttentionEmail);
const pushMock = vi.mocked(sendPushToUsers);

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let userId: number;
let clubMemberId: number;

const STALE = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000); // 100 days old
const FRESH = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);   //  1 day old

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `WReverifyTest_${stamp}`,
    slug: `wreverify-test-${stamp}`,
    contactEmail: `wr-${stamp}@example.test`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `wr-member-${stamp}`,
    username: `wr_member_${stamp}`,
    email: `wr_member_${stamp}@example.com`,
    displayName: "Re-verify Member",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId,
    email: `wr_member_${stamp}@example.com`,
    firstName: "Re",
    lastName: "Verify",
  }).returning({ id: clubMembersTable.id });
  clubMemberId = m.id;
});

afterAll(async () => {
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(walletPayoutAccountsTable).where(eq(walletPayoutAccountsTable.organizationId, orgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, orgId));
  if (userId) await db.delete(appUsersTable).where(inArray(appUsersTable.id, [userId]));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  validateRazorpayVpaMock.mockReset();
  validateRazorpayBankFundAccountMock.mockReset();
  emailMock.mockClear();
  pushMock.mockClear();
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(walletPayoutAccountsTable).where(eq(walletPayoutAccountsTable.organizationId, orgId));
});

async function seedAccount(overrides: Partial<typeof walletPayoutAccountsTable.$inferInsert> = {}) {
  const [row] = await db.insert(walletPayoutAccountsTable).values({
    organizationId: orgId,
    userId,
    method: "upi",
    accountHolderName: "Re Verify",
    upiVpa: "reverify@upi",
    razorpayContactId: "cont_wr",
    razorpayFundAccountId: "fa_wr",
    verifiedAt: STALE,
    verificationStatus: "verified",
    ...overrides,
  }).returning();
  return row;
}

describe("reverifyStaleWalletPayoutAccounts", () => {
  it("skips accounts whose verifiedAt is fresh (within the staleness window)", async () => {
    await seedAccount({ verifiedAt: FRESH });

    const summary = await reverifyStaleWalletPayoutAccounts();
    expect(summary.considered).toBe(0);
    expect(validateRazorpayVpaMock).not.toHaveBeenCalled();
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("skips accounts already flagged needs_attention (no daily spam)", async () => {
    await seedAccount({
      verifiedAt: STALE,
      verificationStatus: "needs_attention",
      verificationFailureReason: "previously failed",
    });

    const summary = await reverifyStaleWalletPayoutAccounts();
    expect(summary.considered).toBe(0);
    expect(validateRazorpayVpaMock).not.toHaveBeenCalled();
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("UPI: bumps verifiedAt and clears any stale failure reason on success (no notification)", async () => {
    const seeded = await seedAccount({
      verificationFailureReason: "stale message that should be cleared",
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "reverify@upi", success: true, customer_name: "Re Verify",
    });

    const summary = await reverifyStaleWalletPayoutAccounts();
    expect(summary.considered).toBe(1);
    expect(summary.verified).toBe(1);
    expect(summary.needsAttention).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();

    const [row] = await db.select().from(walletPayoutAccountsTable)
      .where(eq(walletPayoutAccountsTable.id, seeded.id));
    expect(row.verificationStatus).toBe("verified");
    expect(row.verificationFailureReason).toBeNull();
    expect(row.verifiedAt!.getTime()).toBeGreaterThan(STALE.getTime());
  });

  it("UPI: flips to needs_attention on a failed VPA lookup and notifies the member", async () => {
    const seeded = await seedAccount();
    validateRazorpayVpaMock.mockResolvedValueOnce({ vpa: "reverify@upi", success: false });

    const summary = await reverifyStaleWalletPayoutAccounts();
    expect(summary.needsAttention).toBe(1);

    const [row] = await db.select().from(walletPayoutAccountsTable)
      .where(eq(walletPayoutAccountsTable.id, seeded.id));
    expect(row.verificationStatus).toBe("needs_attention");
    expect(row.verificationFailureReason).toBeTruthy();
    // verifiedAt is left at the previous timestamp so the cron doesn't
    // immediately re-pick it up — needs_attention itself excludes it.
    expect(row.verifiedAt!.getTime()).toBe(STALE.getTime());

    // Member was emailed + pushed.
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(emailMock.mock.calls[0][0]).toMatchObject({
      to: `wr_member_${stamp}@example.com`,
      method: "upi",
    });
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0]).toEqual([userId]);
    expect(pushMock.mock.calls[0][3]).toMatchObject({
      type: "wallet_payout_account_needs_attention",
      accountId: seeded.id,
    });

    // In-app message persisted for the member's inbox.
    const msgs = await db.select().from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.clubMemberId, clubMemberId),
        eq(memberMessagesTable.relatedEntity, "wallet_payout_account"),
      ));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].subject).toMatch(/Re-verify/i);
  });

  it("Bank: flips to needs_attention on an invalid penny-drop", async () => {
    const seeded = await seedAccount({
      method: "bank_account",
      upiVpa: null,
      bankAccountNumber: "1234567890",
      bankIfsc: "HDFC0001234",
    });
    validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
      id: "fav_bad", status: "failed",
      error: { description: "Account closed", code: "ACC_CLOSED" },
    });

    const summary = await reverifyStaleWalletPayoutAccounts();
    expect(summary.needsAttention).toBe(1);

    const [row] = await db.select().from(walletPayoutAccountsTable)
      .where(eq(walletPayoutAccountsTable.id, seeded.id));
    expect(row.verificationStatus).toBe("needs_attention");
    // shared verifyRazorpayPayoutAccount surfaces the bank's description.
    expect(row.verificationFailureReason).toContain("Account closed");
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(emailMock.mock.calls[0][0]).toMatchObject({ method: "bank_account" });
  });

  it("Bank: leaves the row unchanged when penny-drop is still pending", async () => {
    const seeded = await seedAccount({
      method: "bank_account",
      upiVpa: null,
      bankAccountNumber: "1234567890",
      bankIfsc: "HDFC0001234",
    });
    validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
      id: "fav_pending", status: "created",
    });

    const summary = await reverifyStaleWalletPayoutAccounts();
    expect(summary.skipped).toBe(1);
    expect(summary.needsAttention).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();

    const [row] = await db.select().from(walletPayoutAccountsTable)
      .where(eq(walletPayoutAccountsTable.id, seeded.id));
    // Status is left as 'verified' so the next tick will retry.
    expect(row.verificationStatus).toBe("verified");
  });
});
