/**
 * Tests for the payout-account history *read* endpoints — Task #1058.
 *
 * Task #764 added two read paths over `coach_payout_account_history`:
 *
 *   GET  /api/coach-marketplace/me/payout-account/history
 *        Coach reads their own audit trail. Returns `{ history: [] }` when
 *        the caller is authenticated but has no teaching-pro row yet (the
 *        UI never has to special-case 404).
 *
 *   GET  /api/coach-marketplace/admin/coaches/:proId/payout-account/history
 *        Org admin reads any coach in their org. 401 unauth, 403 if the
 *        caller is not an admin for *that coach's* org, 404 unknown proId.
 *
 * These are purely read-only views over rows the verify→confirm flow
 * (covered in `coach-payout-account-verify.test.ts`) writes. We reuse that
 * file's hoisted-Razorpay-mock + verify→confirm pattern to seed real
 * history rows, so the masking the route emits is the same masking real
 * traffic would see.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

process.env.SESSION_SECRET ||= "test-session-secret-coach-payout-history";

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
  orgMembershipsTable,
  teachingProsTable,
  coachMarketplaceProfilesTable,
  coachPayoutAccountHistoryTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgAId: number;
let orgBId: number;
let coachAUserId: number;
let coachBUserId: number;
let nonCoachUserId: number;
let orgAAdminUserId: number;
let orgBAdminUserId: number;
let proAId: number;
let proBId: number;

let coachA: TestUser;
let coachB: TestUser;
let nonCoach: TestUser;
let orgAAdmin: TestUser;
let orgBAdmin: TestUser;

let appAsCoachA: ReturnType<typeof createTestApp>;
let appAsCoachB: ReturnType<typeof createTestApp>;
let appAsNonCoach: ReturnType<typeof createTestApp>;
let appAsOrgAAdmin: ReturnType<typeof createTestApp>;
let appAsOrgBAdmin: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;

const POST_URL = "/api/coach-marketplace/me/payout-account";

beforeAll(async () => {
  const [orgA] = await db.insert(organizationsTable).values({
    name: `PayoutHistA_${stamp}`,
    slug: `payout-hist-a-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `PayoutHistB_${stamp}`,
    slug: `payout-hist-b-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [cA] = await db.insert(appUsersTable).values({
    replitUserId: `payout-hist-coachA-${stamp}`,
    username: `payout_hist_coachA_${stamp}`,
    email: `payout_hist_coachA_${stamp}@example.com`,
    displayName: "Coach A",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  coachAUserId = cA.id;

  const [cB] = await db.insert(appUsersTable).values({
    replitUserId: `payout-hist-coachB-${stamp}`,
    username: `payout_hist_coachB_${stamp}`,
    email: `payout_hist_coachB_${stamp}@example.com`,
    displayName: "Coach B",
    role: "player",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  coachBUserId = cB.id;

  const [nc] = await db.insert(appUsersTable).values({
    replitUserId: `payout-hist-noncoach-${stamp}`,
    username: `payout_hist_noncoach_${stamp}`,
    email: `payout_hist_noncoach_${stamp}@example.com`,
    displayName: "Not A Coach",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  nonCoachUserId = nc.id;

  const [aA] = await db.insert(appUsersTable).values({
    replitUserId: `payout-hist-adminA-${stamp}`,
    username: `payout_hist_adminA_${stamp}`,
    email: `payout_hist_adminA_${stamp}@example.com`,
    displayName: "Org A Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  orgAAdminUserId = aA.id;

  const [aB] = await db.insert(appUsersTable).values({
    replitUserId: `payout-hist-adminB-${stamp}`,
    username: `payout_hist_adminB_${stamp}`,
    email: `payout_hist_adminB_${stamp}@example.com`,
    displayName: "Org B Admin",
    role: "org_admin",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  orgBAdminUserId = aB.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgAId, userId: coachAUserId, role: "player" },
    { organizationId: orgAId, userId: nonCoachUserId, role: "player" },
    { organizationId: orgBId, userId: coachBUserId, role: "player" },
    { organizationId: orgAId, userId: orgAAdminUserId, role: "org_admin" },
    { organizationId: orgBId, userId: orgBAdminUserId, role: "org_admin" },
  ]);

  const [pA] = await db.insert(teachingProsTable).values({
    organizationId: orgAId, userId: coachAUserId, displayName: "Coach A",
  }).returning({ id: teachingProsTable.id });
  proAId = pA.id;

  const [pB] = await db.insert(teachingProsTable).values({
    organizationId: orgBId, userId: coachBUserId, displayName: "Coach B",
  }).returning({ id: teachingProsTable.id });
  proBId = pB.id;

  coachA = {
    id: coachAUserId, username: `payout_hist_coachA_${stamp}`,
    displayName: "Coach A", role: "player", organizationId: orgAId,
  };
  coachB = {
    id: coachBUserId, username: `payout_hist_coachB_${stamp}`,
    displayName: "Coach B", role: "player", organizationId: orgBId,
  };
  nonCoach = {
    id: nonCoachUserId, username: `payout_hist_noncoach_${stamp}`,
    displayName: "Not A Coach", role: "player", organizationId: orgAId,
  };
  orgAAdmin = {
    id: orgAAdminUserId, username: `payout_hist_adminA_${stamp}`,
    displayName: "Org A Admin", role: "org_admin", organizationId: orgAId,
  };
  orgBAdmin = {
    id: orgBAdminUserId, username: `payout_hist_adminB_${stamp}`,
    displayName: "Org B Admin", role: "org_admin", organizationId: orgBId,
  };

  appAsCoachA = createTestApp(coachA);
  appAsCoachB = createTestApp(coachB);
  appAsNonCoach = createTestApp(nonCoach);
  appAsOrgAAdmin = createTestApp(orgAAdmin);
  appAsOrgBAdmin = createTestApp(orgBAdmin);
  appAnonymous = createTestApp();
});

afterAll(async () => {
  for (const id of [proAId, proBId]) {
    if (!id) continue;
    await db.delete(coachPayoutAccountHistoryTable).where(eq(coachPayoutAccountHistoryTable.proId, id));
    await db.delete(coachMarketplaceProfilesTable).where(eq(coachMarketplaceProfilesTable.proId, id));
    await db.delete(teachingProsTable).where(eq(teachingProsTable.id, id));
  }
  const userIds = [coachAUserId, coachBUserId, nonCoachUserId, orgAAdminUserId, orgBAdminUserId].filter(Boolean);
  if (userIds.length) await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  const orgIds = [orgAId, orgBId].filter(Boolean);
  if (orgIds.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgIds));
});

beforeEach(async () => {
  createRazorpayContactMock.mockReset();
  createRazorpayFundAccountMock.mockReset();
  validateRazorpayVpaMock.mockReset();
  validateRazorpayBankFundAccountMock.mockReset();
  // Each test seeds its own history rows — start clean.
  await db.delete(coachPayoutAccountHistoryTable).where(inArray(coachPayoutAccountHistoryTable.proId, [proAId, proBId]));
  await db.delete(coachMarketplaceProfilesTable).where(inArray(coachMarketplaceProfilesTable.proId, [proAId, proBId]));
});

/**
 * Reuse the verify→confirm flow from coach-payout-account-verify.test.ts
 * to actually persist a history row through the same code path real
 * traffic uses. Caller picks which coach to act as so we can seed both
 * coach A and coach B independently.
 */
interface SeedOpts {
  app: ReturnType<typeof createTestApp>;
  method: "upi" | "bank_account";
  upiVpa?: string;            // for UPI
  bankAccountNumber?: string; // for bank
  bankIfsc?: string;
  accountHolderName: string;
  contactId: string;
  fundAccountId: string;
  verifiedHolderName: string;
}

async function seedHistoryViaVerifyConfirm(opts: SeedOpts) {
  if (opts.method === "upi") {
    createRazorpayContactMock.mockResolvedValueOnce({ id: opts.contactId });
    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: opts.fundAccountId, contact_id: opts.contactId,
      account_type: "vpa", vpa: { address: opts.upiVpa! },
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: opts.upiVpa!, success: true, customer_name: opts.verifiedHolderName,
    });
    const verifyRes = await request(opts.app).post(POST_URL).send({
      method: "upi", upiVpa: opts.upiVpa, accountHolderName: opts.accountHolderName,
    });
    expect(verifyRes.status, verifyRes.text).toBe(200);
    const confirmRes = await request(opts.app).post(POST_URL).send({
      method: "upi", confirm: true,
      verificationToken: verifyRes.body.verification.verificationToken,
    });
    expect(confirmRes.status, confirmRes.text).toBe(200);
  } else {
    createRazorpayContactMock.mockResolvedValueOnce({ id: opts.contactId });
    createRazorpayFundAccountMock.mockResolvedValueOnce({
      id: opts.fundAccountId, contact_id: opts.contactId,
      account_type: "bank_account",
    });
    validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
      id: `fav_${opts.fundAccountId}`, status: "completed",
      results: { account_status: "active", registered_name: opts.verifiedHolderName },
    });
    const verifyRes = await request(opts.app).post(POST_URL).send({
      method: "bank_account",
      bankAccountNumber: opts.bankAccountNumber,
      bankIfsc: opts.bankIfsc,
      accountHolderName: opts.accountHolderName,
    });
    expect(verifyRes.status, verifyRes.text).toBe(200);
    const confirmRes = await request(opts.app).post(POST_URL).send({
      method: "bank_account", confirm: true,
      verificationToken: verifyRes.body.verification.verificationToken,
    });
    expect(confirmRes.status, confirmRes.text).toBe(200);
  }
}

// ─── GET /me/payout-account/history ──────────────────────────────────

describe("GET /coach-marketplace/me/payout-account/history", () => {
  it("requires authentication", async () => {
    const res = await request(appAnonymous).get("/api/coach-marketplace/me/payout-account/history");
    expect(res.status).toBe(401);
  });

  it("returns { history: [] } when the caller is authenticated but not a registered coach", async () => {
    const res = await request(appAsNonCoach).get("/api/coach-marketplace/me/payout-account/history");
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ history: [] });
  });

  it("returns the coach's own rows newest-first with masked fields", async () => {
    // Seed two rows for coach A: one UPI then one bank — newest is bank.
    await seedHistoryViaVerifyConfirm({
      app: appAsCoachA, method: "upi",
      upiVpa: "alice.long@upi", accountHolderName: "Alice",
      contactId: "cont_histA_upi", fundAccountId: "fa_histA_upi",
      verifiedHolderName: "ALICE BANK",
    });
    await seedHistoryViaVerifyConfirm({
      app: appAsCoachA, method: "bank_account",
      bankAccountNumber: "1234567890", bankIfsc: "HDFC0001234",
      accountHolderName: "Alice",
      contactId: "cont_histA_bank", fundAccountId: "fa_histA_bank",
      verifiedHolderName: "ALICE BANK",
    });

    const res = await request(appAsCoachA).get("/api/coach-marketplace/me/payout-account/history");
    expect(res.status, res.text).toBe(200);
    const history = res.body.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);

    // Newest-first: the bank-account write should come before the UPI one.
    expect(history[0].method).toBe("bank_account");
    expect(history[1].method).toBe("upi");

    // Sorted by createdAt desc (timestamps may tie if writes are within
    // the same ms — tolerate equal but never inverted).
    const t0 = new Date(history[0].createdAt as string).getTime();
    const t1 = new Date(history[1].createdAt as string).getTime();
    expect(t0).toBeGreaterThanOrEqual(t1);

    // Bank row: account number is masked to last4, never raw.
    expect(history[0].bankAccountLast4).toBe("7890");
    expect(JSON.stringify(history[0])).not.toContain("1234567890");
    expect(history[0].bankIfsc).toBe("HDFC0001234");
    expect(history[0].upiVpaMasked).toBeNull();

    // UPI row: VPA is masked, the full address is never returned.
    const upiMasked = history[1].upiVpaMasked as string;
    expect(upiMasked).not.toBe("alice.long@upi");
    expect(upiMasked).toContain("@upi");
    expect(upiMasked).toContain("•");
    expect(JSON.stringify(history[1])).not.toContain("alice.long@upi");
    expect(history[1].bankAccountLast4).toBeNull();
  });

  // Task #1720 — coaches can also narrow their own audit trail by
  // change kind, mirroring the org-admin endpoint. We seed one
  // `created` row + one `updated` row through the real verify→confirm
  // flow, then directly insert an `admin_reverify` audit row (since
  // the re-verify pathway lives on the wallet/admin endpoints, not
  // here) and assert the filter narrows to exactly that row.
  it("filters the coach's own history by ?changeKind and ignores unknown values", async () => {
    await seedHistoryViaVerifyConfirm({
      app: appAsCoachA, method: "upi",
      upiVpa: "alice.long@upi", accountHolderName: "Alice",
      contactId: "cont_filterA_upi", fundAccountId: "fa_filterA_upi",
      verifiedHolderName: "ALICE BANK",
    });
    await seedHistoryViaVerifyConfirm({
      app: appAsCoachA, method: "bank_account",
      bankAccountNumber: "5550006789", bankIfsc: "HDFC0009999",
      accountHolderName: "Alice",
      contactId: "cont_filterA_bank", fundAccountId: "fa_filterA_bank",
      verifiedHolderName: "ALICE BANK",
    });
    // Direct-insert an admin_reverify audit row that mirrors the saved
    // bank account snapshot — same shape that
    // `coach-admin-payout-account-reverify-audit.test.ts` exercises end
    // to end, narrowed here so the read endpoint test stays focused.
    await db.insert(coachPayoutAccountHistoryTable).values({
      proId: proAId, organizationId: orgAId,
      changedByUserId: orgAAdminUserId, changedByRole: "admin",
      changeKind: "admin_reverify",
      method: "bank_account",
      accountHolderName: "Alice",
      bankAccountLast4: "6789",
      bankIfsc: "HDFC0009999",
      payoutAccountId: "fa_filterA_bank",
      verificationOutcome: "needs_attention",
      verificationReason: "Bank account is no longer accepting transfers",
      ipAddress: "10.0.0.5",
      userAgent: "vitest",
    });

    // Sanity check — without the filter the coach sees all three rows.
    const all = await request(appAsCoachA)
      .get("/api/coach-marketplace/me/payout-account/history");
    expect(all.status, all.text).toBe(200);
    expect((all.body.history as unknown[]).length).toBe(3);

    // Filter to admin re-verifications: only the seeded reverify row.
    const reverify = await request(appAsCoachA)
      .get("/api/coach-marketplace/me/payout-account/history")
      .query({ changeKind: "admin_reverify" });
    expect(reverify.status, reverify.text).toBe(200);
    const reverifyHist = reverify.body.history as Array<Record<string, unknown>>;
    expect(reverifyHist).toHaveLength(1);
    expect(reverifyHist[0].changeKind).toBe("admin_reverify");
    expect(reverifyHist[0].verificationOutcome).toBe("needs_attention");
    expect(reverifyHist[0].verificationReason)
      .toBe("Bank account is no longer accepting transfers");
    expect(reverifyHist[0].bankAccountLast4).toBe("6789");
    // No raw account number leaked even on a filtered fetch.
    expect(JSON.stringify(reverifyHist[0])).not.toContain("5550006789");

    // Filter to `created`: only the UPI row.
    const created = await request(appAsCoachA)
      .get("/api/coach-marketplace/me/payout-account/history")
      .query({ changeKind: "created" });
    expect(created.status).toBe(200);
    const createdHist = created.body.history as Array<Record<string, unknown>>;
    expect(createdHist).toHaveLength(1);
    expect(createdHist[0].changeKind).toBe("created");
    expect(createdHist[0].method).toBe("upi");

    // Unknown filter values are ignored (parser falls back to "no
    // filter") so the caller still sees the full list — same forgiving
    // behaviour the admin endpoint has.
    const unknown = await request(appAsCoachA)
      .get("/api/coach-marketplace/me/payout-account/history")
      .query({ changeKind: "not-a-real-kind" });
    expect(unknown.status).toBe(200);
    expect((unknown.body.history as unknown[]).length).toBe(3);

    // The `all` sentinel is also treated as "no filter".
    const sentinel = await request(appAsCoachA)
      .get("/api/coach-marketplace/me/payout-account/history")
      .query({ changeKind: "all" });
    expect(sentinel.status).toBe(200);
    expect((sentinel.body.history as unknown[]).length).toBe(3);
  });

  it("never includes another coach's rows", async () => {
    // Coach A and Coach B each write one row.
    await seedHistoryViaVerifyConfirm({
      app: appAsCoachA, method: "upi",
      upiVpa: "alice@upi", accountHolderName: "Alice",
      contactId: "cont_isoA", fundAccountId: "fa_isoA",
      verifiedHolderName: "ALICE",
    });
    await seedHistoryViaVerifyConfirm({
      app: appAsCoachB, method: "upi",
      upiVpa: "bob@upi", accountHolderName: "Bob",
      contactId: "cont_isoB", fundAccountId: "fa_isoB",
      verifiedHolderName: "BOB",
    });

    const resA = await request(appAsCoachA).get("/api/coach-marketplace/me/payout-account/history");
    expect(resA.status).toBe(200);
    const histA = resA.body.history as Array<Record<string, unknown>>;
    expect(histA).toHaveLength(1);
    expect(histA[0].payoutAccountId).toBe("fa_isoA");
    expect(histA.some(r => r.payoutAccountId === "fa_isoB")).toBe(false);

    const resB = await request(appAsCoachB).get("/api/coach-marketplace/me/payout-account/history");
    expect(resB.status).toBe(200);
    const histB = resB.body.history as Array<Record<string, unknown>>;
    expect(histB).toHaveLength(1);
    expect(histB[0].payoutAccountId).toBe("fa_isoB");
    expect(histB.some(r => r.payoutAccountId === "fa_isoA")).toBe(false);
  });
});

// ─── GET /admin/coaches/:proId/payout-account/history ────────────────

describe("GET /coach-marketplace/admin/coaches/:proId/payout-account/history", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(appAnonymous)
      .get(`/api/coach-marketplace/admin/coaches/${proAId}/payout-account/history`);
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not an org admin for the coach's org", async () => {
    // Coach A belongs to org A; Org B's admin must NOT see their history.
    const res = await request(appAsOrgBAdmin)
      .get(`/api/coach-marketplace/admin/coaches/${proAId}/payout-account/history`);
    expect(res.status).toBe(403);
  });

  it("returns 403 when a non-admin coach calls the admin endpoint for another coach", async () => {
    const res = await request(appAsCoachB)
      .get(`/api/coach-marketplace/admin/coaches/${proAId}/payout-account/history`);
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown proId", async () => {
    const res = await request(appAsOrgAAdmin)
      .get("/api/coach-marketplace/admin/coaches/9999999/payout-account/history");
    expect(res.status).toBe(404);
  });

  it("returns the same masked rows to the org admin as to the coach themselves", async () => {
    await seedHistoryViaVerifyConfirm({
      app: appAsCoachA, method: "upi",
      upiVpa: "alice.long@upi", accountHolderName: "Alice",
      contactId: "cont_adm_upi", fundAccountId: "fa_adm_upi",
      verifiedHolderName: "ALICE BANK",
    });
    await seedHistoryViaVerifyConfirm({
      app: appAsCoachA, method: "bank_account",
      bankAccountNumber: "9876543210", bankIfsc: "ICIC0009999",
      accountHolderName: "Alice",
      contactId: "cont_adm_bank", fundAccountId: "fa_adm_bank",
      verifiedHolderName: "ALICE BANK",
    });

    const adminRes = await request(appAsOrgAAdmin)
      .get(`/api/coach-marketplace/admin/coaches/${proAId}/payout-account/history`);
    expect(adminRes.status, adminRes.text).toBe(200);
    const adminHist = adminRes.body.history as Array<Record<string, unknown>>;
    expect(adminHist).toHaveLength(2);

    // Same masking rules as the coach-self endpoint.
    const bankRow = adminHist.find(r => r.method === "bank_account")!;
    expect(bankRow.bankAccountLast4).toBe("3210");
    expect(JSON.stringify(bankRow)).not.toContain("9876543210");

    const upiRow = adminHist.find(r => r.method === "upi")!;
    expect(upiRow.upiVpaMasked).not.toBe("alice.long@upi");
    expect(upiRow.upiVpaMasked).toContain("@upi");
    expect(JSON.stringify(upiRow)).not.toContain("alice.long@upi");

    // And the row set matches what the coach themselves would see.
    const selfRes = await request(appAsCoachA).get("/api/coach-marketplace/me/payout-account/history");
    expect(selfRes.status).toBe(200);
    const selfHist = selfRes.body.history as Array<Record<string, unknown>>;
    expect(selfHist.map(r => r.payoutAccountId).sort())
      .toEqual(adminHist.map(r => r.payoutAccountId).sort());
    expect(selfHist.map(r => r.upiVpaMasked).sort())
      .toEqual(adminHist.map(r => r.upiVpaMasked).sort());
    expect(selfHist.map(r => r.bankAccountLast4).sort())
      .toEqual(adminHist.map(r => r.bankAccountLast4).sort());
  });
});
