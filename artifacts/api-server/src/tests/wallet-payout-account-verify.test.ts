/**
 * Task #965 — Verify a member's UPI / bank account before saving it.
 *
 * Covers POST /api/wallet/payout-account, which must:
 *   * Run the Razorpay fund-account validation (UPI lookup or bank penny
 *     drop) AFTER creating the Razorpay contact + fund account.
 *   * Persist the account ONLY when validation succeeds, stamping
 *     `verified_at` + `verified_holder_name` + `verification_status`.
 *   * Return 422 on a failed/pending validation without leaving a
 *     half-verified row in the database.
 *   * Block POST /api/wallet/withdraw with a clear error code while the
 *     saved account is unverified.
 *
 * Every Razorpay HTTP call is mocked so the suite runs offline.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const {
  createRazorpayContactMock,
  createRazorpayFundAccountMock,
  validateRazorpayVpaMock,
  validateRazorpayBankFundAccountMock,
} = vi.hoisted(() => ({
  createRazorpayContactMock: vi.fn(),
  createRazorpayFundAccountMock: vi.fn(),
  validateRazorpayVpaMock: vi.fn(),
  validateRazorpayBankFundAccountMock: vi.fn(),
}));
vi.mock("../lib/razorpay", async () => {
  const actual = await vi.importActual<typeof import("../lib/razorpay")>("../lib/razorpay");
  return {
    ...actual,
    createRazorpayContact: createRazorpayContactMock,
    createRazorpayFundAccount: createRazorpayFundAccountMock,
    validateRazorpayVpa: validateRazorpayVpaMock,
    validateRazorpayBankFundAccount: validateRazorpayBankFundAccountMock,
  };
});

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  walletPayoutAccountsTable,
  clubWalletsTable,
  clubWalletTxnsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let userId: number;
let appAsMember: ReturnType<typeof createTestApp>;
let member: TestUser;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `WalletVerifyTest_${stamp}`,
    slug: `wallet-verify-test-${stamp}`,
    contactEmail: `wv-${stamp}@example.test`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `wv-member-${stamp}`,
    username: `wv_member_${stamp}`,
    email: `wv_member_${stamp}@example.com`,
    displayName: "Wallet Verify Member",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  member = {
    id: userId, username: `wv_member_${stamp}`,
    displayName: "Wallet Verify Member", role: "player", organizationId: orgId,
  };
  appAsMember = createTestApp(member);
});

afterAll(async () => {
  await db.delete(walletPayoutAccountsTable).where(eq(walletPayoutAccountsTable.organizationId, orgId));
  await db.delete(clubWalletTxnsTable).where(eq(clubWalletTxnsTable.sourceType, "test_seed_t965"));
  await db.delete(clubWalletsTable).where(eq(clubWalletsTable.organizationId, orgId));
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  createRazorpayContactMock.mockReset();
  createRazorpayFundAccountMock.mockReset();
  validateRazorpayVpaMock.mockReset();
  validateRazorpayBankFundAccountMock.mockReset();
  await db.delete(walletPayoutAccountsTable).where(eq(walletPayoutAccountsTable.organizationId, orgId));
});

const URL = "/api/wallet/payout-account";

describe("POST /wallet/payout-account — Razorpay fund-account verification", () => {
  it("UPI: persists row + verifiedAt only when VPA validation succeeds", async () => {
    createRazorpayContactMock.mockResolvedValueOnce({ id: "cont_t965_1", name: "M", type: "customer" });
    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: "fa_t965_upi_ok", contact_id: "cont_t965_1", account_type: "vpa", vpa: { address: "ok@upi" },
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "ok@upi", success: true, customer_name: "Wallet Verify Member",
    });

    const res = await request(appAsMember).post(URL).send({
      organizationId: orgId, method: "upi",
      accountHolderName: "Wallet Verify Member", upiVpa: "ok@upi",
    });
    expect(res.status).toBe(200);
    expect(res.body.account.verified).toBe(true);
    expect(res.body.account.verifiedAt).toBeTruthy();
    expect(res.body.account.verifiedHolderName).toBe("Wallet Verify Member");
    expect(res.body.account.verificationStatus).toBe("verified");

    const [row] = await db.select().from(walletPayoutAccountsTable).where(and(
      eq(walletPayoutAccountsTable.organizationId, orgId),
      eq(walletPayoutAccountsTable.userId, userId),
    ));
    expect(row.verifiedAt).not.toBeNull();
    expect(row.razorpayFundAccountId).toBe("fa_t965_upi_ok");
    expect(validateRazorpayVpaMock).toHaveBeenCalledWith("ok@upi");
    expect(validateRazorpayBankFundAccountMock).not.toHaveBeenCalled();
  });

  it("UPI: returns 422 and DOES NOT persist when VPA validation fails", async () => {
    createRazorpayContactMock.mockResolvedValueOnce({ id: "cont_t965_2", name: "M", type: "customer" });
    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: "fa_t965_upi_bad", contact_id: "cont_t965_2", account_type: "vpa", vpa: { address: "bad@upi" },
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({ vpa: "bad@upi", success: false });

    const res = await request(appAsMember).post(URL).send({
      organizationId: orgId, method: "upi",
      accountHolderName: "Wallet Verify Member", upiVpa: "bad@upi",
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/UPI/i);
    expect(res.body.verification).toMatchObject({ status: "failed", method: "upi" });

    const rows = await db.select().from(walletPayoutAccountsTable).where(and(
      eq(walletPayoutAccountsTable.organizationId, orgId),
      eq(walletPayoutAccountsTable.userId, userId),
    ));
    expect(rows).toHaveLength(0);
  });

  it("Bank: persists row + verifiedAt when penny-drop completes", async () => {
    createRazorpayContactMock.mockResolvedValueOnce({ id: "cont_t965_3", name: "M", type: "customer" });
    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: "fa_t965_bank_ok", contact_id: "cont_t965_3", account_type: "bank_account",
      bank_account: { name: "Holder", ifsc: "HDFC0001234", account_number: "1234567890" },
    });
    validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
      id: "fav_ok", status: "completed",
      results: { account_status: "active", registered_name: "HOLDER M." },
    });

    const res = await request(appAsMember).post(URL).send({
      organizationId: orgId, method: "bank_account",
      accountHolderName: "Holder",
      bankAccountNumber: "1234567890", bankIfsc: "HDFC0001234",
    });
    expect(res.status).toBe(200);
    expect(res.body.account.verified).toBe(true);
    expect(res.body.account.verifiedHolderName).toBe("HOLDER M.");
    expect(validateRazorpayBankFundAccountMock).toHaveBeenCalledWith("fa_t965_bank_ok");
  });

  it("Bank: returns 422 and DOES NOT persist when penny-drop returns invalid", async () => {
    createRazorpayContactMock.mockResolvedValueOnce({ id: "cont_t965_4", name: "M", type: "customer" });
    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: "fa_t965_bank_bad", contact_id: "cont_t965_4", account_type: "bank_account",
      bank_account: { name: "Holder", ifsc: "HDFC0001234", account_number: "9999999999" },
    });
    validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
      id: "fav_bad", status: "completed", results: { account_status: "invalid" },
    });

    const res = await request(appAsMember).post(URL).send({
      organizationId: orgId, method: "bank_account",
      accountHolderName: "Holder",
      bankAccountNumber: "9999999999", bankIfsc: "HDFC0001234",
    });
    expect(res.status).toBe(422);
    expect(res.body.verification).toMatchObject({ status: "failed", method: "bank_account" });

    const rows = await db.select().from(walletPayoutAccountsTable).where(and(
      eq(walletPayoutAccountsTable.organizationId, orgId),
      eq(walletPayoutAccountsTable.userId, userId),
    ));
    expect(rows).toHaveLength(0);
  });

  it("Bank: returns 422 with status=pending when penny-drop is still in flight", async () => {
    createRazorpayContactMock.mockResolvedValueOnce({ id: "cont_t965_5", name: "M", type: "customer" });
    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: "fa_t965_bank_pending", contact_id: "cont_t965_5", account_type: "bank_account",
      bank_account: { name: "Holder", ifsc: "HDFC0001234", account_number: "1234567890" },
    });
    validateRazorpayBankFundAccountMock.mockResolvedValueOnce({ id: "fav_p", status: "created" });

    const res = await request(appAsMember).post(URL).send({
      organizationId: orgId, method: "bank_account",
      accountHolderName: "Holder",
      bankAccountNumber: "1234567890", bankIfsc: "HDFC0001234",
    });
    expect(res.status).toBe(422);
    expect(res.body.verification).toMatchObject({ status: "pending", method: "bank_account" });
  });

  it("A previously-saved verified account is preserved when a re-save fails verification", async () => {
    // Seed an already-verified account.
    await db.insert(walletPayoutAccountsTable).values({
      organizationId: orgId, userId, method: "upi",
      accountHolderName: "Wallet Verify Member", upiVpa: "old@upi",
      razorpayContactId: "cont_t965_old", razorpayFundAccountId: "fa_t965_old",
      verifiedAt: new Date(), verificationStatus: "verified",
      verifiedHolderName: "Wallet Verify Member",
    });

    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: "fa_t965_upi_bad2", contact_id: "cont_t965_old", account_type: "vpa", vpa: { address: "bad@upi" },
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({ vpa: "bad@upi", success: false });

    const res = await request(appAsMember).post(URL).send({
      organizationId: orgId, method: "upi",
      accountHolderName: "Wallet Verify Member", upiVpa: "bad@upi",
    });
    expect(res.status).toBe(422);

    // Original row should be untouched (still pointing at fa_t965_old).
    const [row] = await db.select().from(walletPayoutAccountsTable).where(and(
      eq(walletPayoutAccountsTable.organizationId, orgId),
      eq(walletPayoutAccountsTable.userId, userId),
    ));
    expect(row.razorpayFundAccountId).toBe("fa_t965_old");
    expect(row.upiVpa).toBe("old@upi");
    expect(row.verifiedAt).not.toBeNull();
    // Contact creation should be skipped on the second call (we reuse the saved contact id).
    expect(createRazorpayContactMock).not.toHaveBeenCalled();
  });
});

describe("POST /wallet/withdraw — verification gate", () => {
  it("rejects withdrawals against an unverified saved account", async () => {
    // Seed an UNVERIFIED account (verifiedAt = null) — only possible from
    // pre-task #965 data because the route would never persist this now.
    await db.insert(walletPayoutAccountsTable).values({
      organizationId: orgId, userId, method: "upi",
      accountHolderName: "Wallet Verify Member", upiVpa: "old@upi",
      razorpayContactId: "cont_t965_unv", razorpayFundAccountId: "fa_t965_unv",
      verifiedAt: null, verificationStatus: null,
    });
    // Seed wallet so we'd otherwise pass the balance check.
    await db.insert(clubWalletsTable).values({
      organizationId: orgId, userId, currency: "INR", balance: "5000.00",
    });

    const res = await request(appAsMember).post("/api/wallet/withdraw").send({
      organizationId: orgId, amount: 200, currency: "INR",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PAYOUT_ACCOUNT_NOT_VERIFIED");
  });

  it("Task #1288 — rejects withdrawals when a previously-verified account was just flagged needs_attention by the cron", async () => {
    // Seed a row that mimics what the daily re-verification cron
    // (Task #1119) leaves behind when a previously-verified account
    // fails its periodic re-check: `verifiedAt` is left intact (so the
    // saved-account banner can keep showing the prior verified date),
    // but `verificationStatus` flips to `needs_attention` and a
    // `verificationFailureReason` is persisted. Without the new guard
    // the route would happily wave the withdrawal through because
    // `verifiedAt` is still set.
    const failureReason = "Razorpay says: VPA no longer active";
    await db.insert(walletPayoutAccountsTable).values({
      organizationId: orgId, userId, method: "upi",
      accountHolderName: "Wallet Verify Member", upiVpa: "stale@upi",
      razorpayContactId: "cont_t1288_flagged", razorpayFundAccountId: "fa_t1288_flagged",
      verifiedAt: new Date(),
      verificationStatus: "needs_attention",
      verificationFailureReason: failureReason,
    });
    // The previous test in this suite may have already inserted a wallet
    // for (org, user, INR) — there's a unique constraint, so be idempotent.
    await db.insert(clubWalletsTable).values({
      organizationId: orgId, userId, currency: "INR", balance: "5000.00",
    }).onConflictDoNothing();

    const res = await request(appAsMember).post("/api/wallet/withdraw").send({
      organizationId: orgId, amount: 200, currency: "INR",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PAYOUT_ACCOUNT_NEEDS_REVERIFY");
    expect(res.body.verificationFailureReason).toBe(failureReason);
    // The persisted reason should be surfaced as the human-readable
    // error so the wallet UI banner matches the saved-account screen.
    expect(res.body.error).toBe(failureReason);
  });
});
