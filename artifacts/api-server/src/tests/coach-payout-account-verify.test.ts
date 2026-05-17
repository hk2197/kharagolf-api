/**
 * Tests for the two-phase payout-account verify → confirm flow — Task #914.
 *
 * The endpoint POST /api/coach-marketplace/me/payout-account is the gate that
 * stops a coach from sending RazorpayX payouts to the wrong UPI/bank account.
 * It runs in two legs:
 *
 *   1. VERIFY  — body has the raw account details. We create (or reuse) a
 *                Razorpay contact + fund account, then call the bank-side
 *                lookup (UPI VPA validate or bank penny-drop). On success we
 *                hand back a signed `verificationToken` describing the
 *                account that was just verified. NOTHING is persisted yet.
 *
 *   2. CONFIRM — body is `{ method, confirm: true, verificationToken }`.
 *                We re-check the HMAC + expiry, then write the account
 *                details *from the token* (never from the body) onto the
 *                coach's marketplace profile + history audit row.
 *
 * These tests exercise both legs, plus the failure modes that protect the
 * gate (failed VPA lookup / penny-drop must NOT touch the previously-saved
 * account on file). Every Razorpay HTTP call is mocked so the suite runs
 * offline.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// SESSION_SECRET signs the verification token. Must be set BEFORE the route
// module is imported (createTestApp pulls in the router which reads the env
// at call time, but the constant is read lazily inside helpers — set early
// for safety so other parallel suites don't override us).
process.env.SESSION_SECRET ||= "test-session-secret-coach-payout-verify";

// Hoisted Razorpay mocks. We mock exactly the four calls the verify-leg
// touches; everything else (createRazorpayPayout, etc.) keeps the real
// implementation so the auto-retry-after-confirm path inside the route
// continues to behave normally (it's a no-op when there are no stuck
// payouts, which is the case for these tests).
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

import crypto from "crypto";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  teachingProsTable,
  coachMarketplaceProfilesTable,
  coachPayoutAccountHistoryTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let coachUserId: number;
let nonCoachUserId: number;
let proId: number;

let coach: TestUser;
let nonCoach: TestUser;
let appAsCoach: ReturnType<typeof createTestApp>;
let appAsNonCoach: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `PayoutVerifyTest_${stamp}`,
    slug: `payout-verify-test-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [coachU] = await db.insert(appUsersTable).values({
    replitUserId: `payout-verify-coach-${stamp}`,
    username: `payout_verify_coach_${stamp}`,
    email: `payout_verify_coach_${stamp}@example.com`,
    displayName: "Coach Verify",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachUserId = coachU.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: coachUserId, role: "player",
  });

  const [nonCoachU] = await db.insert(appUsersTable).values({
    replitUserId: `payout-verify-noncoach-${stamp}`,
    username: `payout_verify_noncoach_${stamp}`,
    email: `payout_verify_noncoach_${stamp}@example.com`,
    displayName: "Not A Coach",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  nonCoachUserId = nonCoachU.id;

  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachUserId, displayName: "Coach Verify",
  }).returning({ id: teachingProsTable.id });
  proId = pro.id;

  coach = {
    id: coachUserId, username: `payout_verify_coach_${stamp}`,
    displayName: "Coach Verify", role: "player", organizationId: orgId,
  };
  nonCoach = {
    id: nonCoachUserId, username: `payout_verify_noncoach_${stamp}`,
    displayName: "Not A Coach", role: "player", organizationId: orgId,
  };
  appAsCoach = createTestApp(coach);
  appAsNonCoach = createTestApp(nonCoach);
  appAnonymous = createTestApp();
});

afterAll(async () => {
  if (proId) {
    await db.delete(coachPayoutAccountHistoryTable).where(eq(coachPayoutAccountHistoryTable.proId, proId));
    await db.delete(coachMarketplaceProfilesTable).where(eq(coachMarketplaceProfilesTable.proId, proId));
    await db.delete(teachingProsTable).where(eq(teachingProsTable.id, proId));
  }
  const userIds = [coachUserId, nonCoachUserId].filter(Boolean);
  if (userIds.length) await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  createRazorpayContactMock.mockReset();
  createRazorpayFundAccountMock.mockReset();
  validateRazorpayVpaMock.mockReset();
  validateRazorpayBankFundAccountMock.mockReset();
  // Wipe any saved profile/history between tests so each one starts clean.
  await db.delete(coachPayoutAccountHistoryTable).where(eq(coachPayoutAccountHistoryTable.proId, proId));
  await db.delete(coachMarketplaceProfilesTable).where(eq(coachMarketplaceProfilesTable.proId, proId));
});

const POST_URL = "/api/coach-marketplace/me/payout-account";

// ─── Verify leg ───────────────────────────────────────────────────────

describe("POST /coach-marketplace/me/payout-account — verify leg", () => {
  it("requires authentication", async () => {
    const res = await request(appAnonymous).post(POST_URL).send({
      method: "upi", upiVpa: "alice@upi", accountHolderName: "Alice",
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 if the caller is not a registered coach", async () => {
    const res = await request(appAsNonCoach).post(POST_URL).send({
      method: "upi", upiVpa: "alice@upi", accountHolderName: "Alice",
    });
    expect(res.status).toBe(403);
  });

  it("returns the bank-returned holder name without persisting (UPI)", async () => {
    createRazorpayContactMock.mockResolvedValueOnce({
      id: "cont_test_upi_1", name: "Coach Verify",
    });
    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: "fa_test_upi_1", contact_id: "cont_test_upi_1",
      account_type: "vpa", vpa: { address: "alice@upi" },
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "alice@upi", success: true, customer_name: "ALICE BANK NAME",
    });

    const res = await request(appAsCoach).post(POST_URL).send({
      method: "upi", upiVpa: "alice@upi",
      accountHolderName: "Alice Submitted",
    });
    expect(res.status, res.text).toBe(200);
    const v = res.body.verification;
    expect(v.status).toBe("verified");
    expect(v.method).toBe("upi");
    expect(v.verifiedHolderName).toBe("ALICE BANK NAME");
    expect(v.fundAccountId).toBe("fa_test_upi_1");
    expect(v.razorpayContactId).toBe("cont_test_upi_1");
    expect(v.accountHolderName).toBe("Alice Submitted");
    expect(typeof v.verificationToken).toBe("string");
    expect(v.verificationToken.length).toBeGreaterThan(20);

    // Crucially: nothing has been written to the profile yet.
    const [profile] = await db.select().from(coachMarketplaceProfilesTable)
      .where(eq(coachMarketplaceProfilesTable.proId, proId));
    expect(profile).toBeUndefined();
    const history = await db.select().from(coachPayoutAccountHistoryTable)
      .where(eq(coachPayoutAccountHistoryTable.proId, proId));
    expect(history).toHaveLength(0);

    expect(validateRazorpayVpaMock).toHaveBeenCalledWith("alice@upi");
    expect(validateRazorpayBankFundAccountMock).not.toHaveBeenCalled();
  });

  it("returns the bank-returned holder name without persisting (bank)", async () => {
    createRazorpayContactMock.mockResolvedValueOnce({
      id: "cont_test_bank_1", name: "Coach Verify",
    });
    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: "fa_test_bank_1", contact_id: "cont_test_bank_1",
      account_type: "bank_account",
      bank_account: { name: "Alice Submitted", ifsc: "HDFC0001234", account_number: "1234567890" },
    });
    validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
      id: "fav_test_1", status: "completed",
      results: { account_status: "active", registered_name: "ALICE BANK ACCT" },
    });

    const res = await request(appAsCoach).post(POST_URL).send({
      method: "bank_account",
      bankAccountNumber: "1234567890",
      bankIfsc: "hdfc0001234",
      accountHolderName: "Alice Submitted",
    });
    expect(res.status, res.text).toBe(200);
    const v = res.body.verification;
    expect(v.status).toBe("verified");
    expect(v.method).toBe("bank_account");
    expect(v.verifiedHolderName).toBe("ALICE BANK ACCT");
    expect(v.fundAccountId).toBe("fa_test_bank_1");
    expect(v.razorpayContactId).toBe("cont_test_bank_1");
    expect(v.bankAccountLast4).toBe("7890");
    expect(v.bankIfsc).toBe("HDFC0001234");

    const [profile] = await db.select().from(coachMarketplaceProfilesTable)
      .where(eq(coachMarketplaceProfilesTable.proId, proId));
    expect(profile).toBeUndefined();

    expect(validateRazorpayBankFundAccountMock).toHaveBeenCalledWith("fa_test_bank_1");
    expect(validateRazorpayVpaMock).not.toHaveBeenCalled();
  });
});

// ─── Confirm leg ──────────────────────────────────────────────────────

describe("POST /coach-marketplace/me/payout-account — confirm leg", () => {
  async function runVerify(method: "upi" | "bank_account") {
    if (method === "upi") {
      createRazorpayContactMock.mockResolvedValueOnce({ id: "cont_confirm_upi" });
      createRazorpayFundAccountMock.mockResolvedValueOnce({
        id: "fa_confirm_upi", contact_id: "cont_confirm_upi",
        account_type: "vpa", vpa: { address: "bob@upi" },
      });
      validateRazorpayVpaMock.mockResolvedValueOnce({
        vpa: "bob@upi", success: true, customer_name: "BOB BANK",
      });
      const res = await request(appAsCoach).post(POST_URL).send({
        method: "upi", upiVpa: "bob@upi", accountHolderName: "Bob",
      });
      expect(res.status, res.text).toBe(200);
      return res.body.verification as { verificationToken: string };
    } else {
      createRazorpayContactMock.mockResolvedValueOnce({ id: "cont_confirm_bank" });
      createRazorpayFundAccountMock.mockResolvedValueOnce({
        id: "fa_confirm_bank", contact_id: "cont_confirm_bank",
        account_type: "bank_account",
      });
      validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
        id: "fav_confirm", status: "completed",
        results: { account_status: "active", registered_name: "BOB BANK" },
      });
      const res = await request(appAsCoach).post(POST_URL).send({
        method: "bank_account",
        bankAccountNumber: "9876543210",
        bankIfsc: "ICIC0009999",
        accountHolderName: "Bob",
      });
      expect(res.status, res.text).toBe(200);
      return res.body.verification as { verificationToken: string };
    }
  }

  it("persists the verified account when given a valid verificationToken (UPI)", async () => {
    const verification = await runVerify("upi");

    const res = await request(appAsCoach).post(POST_URL).send({
      method: "upi", confirm: true,
      verificationToken: verification.verificationToken,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body.payoutAccount.razorpayFundAccountId).toBe("fa_confirm_upi");
    expect(res.body.payoutAccount.razorpayContactId).toBe("cont_confirm_upi");

    const [profile] = await db.select().from(coachMarketplaceProfilesTable)
      .where(eq(coachMarketplaceProfilesTable.proId, proId));
    expect(profile).toBeDefined();
    // The persisted fundAccountId + razorpayContactId come from the SIGNED
    // token, not the request body — confirms the gate is doing its job.
    expect(profile.payoutAccountId).toBe("fa_confirm_upi");
    expect(profile.razorpayContactId).toBe("cont_confirm_upi");
    expect(profile.payoutMethod).toBe("upi");
    expect(profile.payoutVpa).toBe("bob@upi");
    expect(profile.payoutAccountHolderName).toBe("Bob");
    expect(profile.payoutBankAccountNumber).toBeNull();
    expect(profile.payoutBankIfsc).toBeNull();

    const history = await db.select().from(coachPayoutAccountHistoryTable)
      .where(eq(coachPayoutAccountHistoryTable.proId, proId));
    expect(history).toHaveLength(1);
    expect(history[0].changeKind).toBe("created");
    expect(history[0].method).toBe("upi");
    expect(history[0].payoutAccountId).toBe("fa_confirm_upi");
    expect(history[0].razorpayContactId).toBe("cont_confirm_upi");
    // VPA is masked in the audit row — never the full address.
    expect(history[0].upiVpaMasked).not.toBe("bob@upi");
    expect(history[0].upiVpaMasked).toContain("@upi");
  });

  it("persists the verified account when given a valid verificationToken (bank)", async () => {
    const verification = await runVerify("bank_account");

    const res = await request(appAsCoach).post(POST_URL).send({
      method: "bank_account", confirm: true,
      verificationToken: verification.verificationToken,
    });
    expect(res.status, res.text).toBe(200);

    const [profile] = await db.select().from(coachMarketplaceProfilesTable)
      .where(eq(coachMarketplaceProfilesTable.proId, proId));
    expect(profile).toBeDefined();
    expect(profile.payoutAccountId).toBe("fa_confirm_bank");
    expect(profile.razorpayContactId).toBe("cont_confirm_bank");
    expect(profile.payoutMethod).toBe("bank_account");
    expect(profile.payoutBankAccountNumber).toBe("9876543210");
    expect(profile.payoutBankIfsc).toBe("ICIC0009999");
    expect(profile.payoutVpa).toBeNull();
  });

  it("rejects confirm with no verificationToken and persists nothing", async () => {
    const res = await request(appAsCoach).post(POST_URL).send({
      method: "upi", confirm: true,
    });
    expect(res.status).toBe(400);
    const [profile] = await db.select().from(coachMarketplaceProfilesTable)
      .where(eq(coachMarketplaceProfilesTable.proId, proId));
    expect(profile).toBeUndefined();
  });

  it("rejects confirm with a tampered verificationToken and persists nothing", async () => {
    const verification = await runVerify("upi");
    // Flip a character in the signature half — must fail HMAC.
    const [json, sig] = verification.verificationToken.split(".");
    const tampered = `${json}.${sig.slice(0, -2)}AA`;

    const res = await request(appAsCoach).post(POST_URL).send({
      method: "upi", confirm: true, verificationToken: tampered,
    });
    expect(res.status).toBe(400);
    const [profile] = await db.select().from(coachMarketplaceProfilesTable)
      .where(eq(coachMarketplaceProfilesTable.proId, proId));
    expect(profile).toBeUndefined();
  });

  // Mirrors the route's signPayoutVerificationToken so we can craft tokens
  // that pass HMAC verification but carry semantically invalid payloads.
  function signTokenForTest(payload: Record<string, unknown>): string {
    const secret = process.env.SESSION_SECRET!;
    const json = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(json).digest("base64url");
    return `${json}.${sig}`;
  }

  it("rejects confirm when the signed token is missing fundAccountId, persists nothing", async () => {
    const token = signTokenForTest({
      proId,
      method: "upi",
      accountHolderName: "Bob",
      verifiedHolderName: "BOB BANK",
      // fundAccountId intentionally omitted — verifier must reject.
      razorpayContactId: "cont_confirm_upi",
      upiVpa: "bob@upi",
      exp: Date.now() + 60_000,
    });
    const res = await request(appAsCoach).post(POST_URL).send({
      method: "upi", confirm: true, verificationToken: token,
    });
    expect(res.status).toBe(400);
    const [profile] = await db.select().from(coachMarketplaceProfilesTable)
      .where(eq(coachMarketplaceProfilesTable.proId, proId));
    expect(profile).toBeUndefined();
    const history = await db.select().from(coachPayoutAccountHistoryTable)
      .where(eq(coachPayoutAccountHistoryTable.proId, proId));
    expect(history).toHaveLength(0);
  });

  it("rejects confirm when the signed token is missing razorpayContactId, persists nothing", async () => {
    const token = signTokenForTest({
      proId,
      method: "upi",
      accountHolderName: "Bob",
      verifiedHolderName: "BOB BANK",
      fundAccountId: "fa_confirm_upi",
      // razorpayContactId intentionally omitted.
      upiVpa: "bob@upi",
      exp: Date.now() + 60_000,
    });
    const res = await request(appAsCoach).post(POST_URL).send({
      method: "upi", confirm: true, verificationToken: token,
    });
    expect(res.status).toBe(400);
    const [profile] = await db.select().from(coachMarketplaceProfilesTable)
      .where(eq(coachMarketplaceProfilesTable.proId, proId));
    expect(profile).toBeUndefined();
  });

  it("rejects confirm when fundAccountId / razorpayContactId are empty strings", async () => {
    const token = signTokenForTest({
      proId,
      method: "upi",
      accountHolderName: "Bob",
      verifiedHolderName: "BOB BANK",
      fundAccountId: "",
      razorpayContactId: "",
      upiVpa: "bob@upi",
      exp: Date.now() + 60_000,
    });
    const res = await request(appAsCoach).post(POST_URL).send({
      method: "upi", confirm: true, verificationToken: token,
    });
    expect(res.status).toBe(400);
    const [profile] = await db.select().from(coachMarketplaceProfilesTable)
      .where(eq(coachMarketplaceProfilesTable.proId, proId));
    expect(profile).toBeUndefined();
  });

  it("rejects confirm when method does not match the verified token", async () => {
    const verification = await runVerify("upi");
    const res = await request(appAsCoach).post(POST_URL).send({
      method: "bank_account", confirm: true,
      verificationToken: verification.verificationToken,
    });
    expect(res.status).toBe(400);
    const [profile] = await db.select().from(coachMarketplaceProfilesTable)
      .where(eq(coachMarketplaceProfilesTable.proId, proId));
    expect(profile).toBeUndefined();
  });
});

// ─── Failed verification leaves the prior account untouched ───────────

describe("POST /coach-marketplace/me/payout-account — failed verification preserves prior account", () => {
  // Seeds the coach with a previously-saved UPI account so we can prove a
  // failed verify against a *different* account does NOT overwrite it.
  async function seedPriorUpiAccount() {
    await db.insert(coachMarketplaceProfilesTable).values({
      proId, organizationId: orgId,
      payoutMethod: "upi",
      payoutVpa: "prior@upi",
      payoutAccountHolderName: "Prior Holder",
      razorpayContactId: "cont_prior",
      payoutAccountId: "fa_prior",
    });
  }

  async function expectPriorUntouched() {
    const [profile] = await db.select().from(coachMarketplaceProfilesTable)
      .where(eq(coachMarketplaceProfilesTable.proId, proId));
    expect(profile).toBeDefined();
    expect(profile.payoutMethod).toBe("upi");
    expect(profile.payoutVpa).toBe("prior@upi");
    expect(profile.payoutAccountHolderName).toBe("Prior Holder");
    expect(profile.razorpayContactId).toBe("cont_prior");
    expect(profile.payoutAccountId).toBe("fa_prior");
    // No history row should have been written for the failed attempt.
    const history = await db.select().from(coachPayoutAccountHistoryTable)
      .where(eq(coachPayoutAccountHistoryTable.proId, proId));
    expect(history).toHaveLength(0);
  }

  it("returns 422 when the UPI VPA lookup says success=false, prior account untouched", async () => {
    await seedPriorUpiAccount();

    createRazorpayContactMock.mockResolvedValueOnce({ id: "cont_new_attempt" });
    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: "fa_new_attempt", contact_id: "cont_new_attempt",
      account_type: "vpa", vpa: { address: "wrong@upi" },
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "wrong@upi", success: false,
    });

    const res = await request(appAsCoach).post(POST_URL).send({
      method: "upi", upiVpa: "wrong@upi", accountHolderName: "Imposter",
    });
    expect(res.status).toBe(422);
    expect(res.body.verification.status).toBe("failed");
    expect(res.body.verification.method).toBe("upi");
    expect(res.body.error).toMatch(/verify/i);

    await expectPriorUntouched();
  });

  it("returns 422 when the UPI lookup throws, prior account untouched", async () => {
    await seedPriorUpiAccount();

    createRazorpayContactMock.mockResolvedValueOnce({ id: "cont_throw" });
    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: "fa_throw", contact_id: "cont_throw",
      account_type: "vpa", vpa: { address: "boom@upi" },
    });
    validateRazorpayVpaMock.mockRejectedValueOnce(new Error("razorpay 503"));

    const res = await request(appAsCoach).post(POST_URL).send({
      method: "upi", upiVpa: "boom@upi", accountHolderName: "Boom",
    });
    expect(res.status).toBe(422);
    expect(res.body.verification.status).toBe("failed");
    await expectPriorUntouched();
  });

  it("returns 422 when the bank penny-drop fails, prior account untouched", async () => {
    await seedPriorUpiAccount();

    createRazorpayContactMock.mockResolvedValueOnce({ id: "cont_pd_fail" });
    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: "fa_pd_fail", contact_id: "cont_pd_fail",
      account_type: "bank_account",
    });
    validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
      id: "fav_pd_fail", status: "failed",
      error: { description: "Account is closed", code: "BAD_ACCOUNT" },
    });

    const res = await request(appAsCoach).post(POST_URL).send({
      method: "bank_account",
      bankAccountNumber: "9999999999",
      bankIfsc: "HDFC0001111",
      accountHolderName: "Imposter",
    });
    expect(res.status).toBe(422);
    expect(res.body.verification.status).toBe("failed");
    expect(res.body.verification.method).toBe("bank_account");
    await expectPriorUntouched();
  });

  it("returns 422 when the penny-drop completes with account_status=invalid, prior account untouched", async () => {
    await seedPriorUpiAccount();

    createRazorpayContactMock.mockResolvedValueOnce({ id: "cont_invalid" });
    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: "fa_invalid", contact_id: "cont_invalid",
      account_type: "bank_account",
    });
    validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
      id: "fav_invalid", status: "completed",
      results: { account_status: "invalid" },
    });

    const res = await request(appAsCoach).post(POST_URL).send({
      method: "bank_account",
      bankAccountNumber: "8888888888",
      bankIfsc: "HDFC0002222",
      accountHolderName: "Imposter",
    });
    expect(res.status).toBe(422);
    expect(res.body.verification.status).toBe("failed");
    await expectPriorUntouched();
  });
});
