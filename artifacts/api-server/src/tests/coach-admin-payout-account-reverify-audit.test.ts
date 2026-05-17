/**
 * Task #1222 — Tests for the admin-triggered payout-account re-verify
 * endpoint's audit-trail row.
 *
 * `POST /api/coach-marketplace/admin/coaches/:proId/payout-account/reverify`
 * runs the same VPA / bank-fund-account validation the nightly cron uses
 * but, prior to this task, never wrote a `coach_payout_account_history`
 * row. That left a compliance gap — "who triggered the re-check that
 * flipped this coach to needs_attention?" was unanswerable. We now
 * persist a row with `changeKind = 'admin_reverify'` carrying the
 * verification outcome + reason and the calling admin's id / IP /
 * user-agent.
 *
 * We mock Razorpay so the test deterministically exercises both the
 * "still verified" and "now needs attention" branches, then assert the
 * resulting audit row directly via Drizzle.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

process.env.SESSION_SECRET ||= "test-session-secret-coach-admin-reverify-audit";

const {
  createRazorpayContactMock,
  createRazorpayFundAccountMock,
  validateRazorpayVpaMock,
  validateRazorpayBankFundAccountMock,
  recordAdminReverifyHistoryMock,
} = vi.hoisted(() => ({
  createRazorpayContactMock: vi.fn(),
  createRazorpayFundAccountMock: vi.fn(),
  validateRazorpayVpaMock: vi.fn(),
  validateRazorpayBankFundAccountMock: vi.fn(),
  recordAdminReverifyHistoryMock: vi.fn<
    typeof import("../lib/coachPayoutAccountReverifyAudit").recordAdminReverifyHistory
  >(),
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
// Mock the audit-row helper so the failure-mode test can simulate a
// persistence error without touching the real database. The mock is
// pre-wired to delegate to the real implementation, so the rest of the
// suite exercises the genuine insert path against the test DB —
// `beforeEach` resets the implementation back to the real one in case
// any test overrode it.
vi.mock("../lib/coachPayoutAccountReverifyAudit", async () => {
  const actual = await vi.importActual<typeof import("../lib/coachPayoutAccountReverifyAudit")>(
    "../lib/coachPayoutAccountReverifyAudit",
  );
  recordAdminReverifyHistoryMock.mockImplementation(actual.recordAdminReverifyHistory);
  return {
    ...actual,
    recordAdminReverifyHistory: recordAdminReverifyHistoryMock,
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
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let coachUserId: number;
let adminUserId: number;
let otherOrgAdminUserId: number;
let otherOrgId: number;
let proId: number;

let coach: TestUser;
let admin: TestUser;
let otherOrgAdmin: TestUser;

let appAsCoach: ReturnType<typeof createTestApp>;
let appAsAdmin: ReturnType<typeof createTestApp>;
let appAsOtherOrgAdmin: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;

const POST_URL = "/api/coach-marketplace/me/payout-account";

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `ReverifyAudit_${stamp}`,
    slug: `reverify-audit-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `ReverifyAuditOther_${stamp}`,
    slug: `reverify-audit-other-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  const [c] = await db.insert(appUsersTable).values({
    replitUserId: `reverify-audit-coach-${stamp}`,
    username: `reverify_audit_coach_${stamp}`,
    email: `reverify_audit_coach_${stamp}@example.com`,
    displayName: "Audit Coach",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachUserId = c.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `reverify-audit-admin-${stamp}`,
    username: `reverify_audit_admin_${stamp}`,
    email: `reverify_audit_admin_${stamp}@example.com`,
    displayName: "Audit Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = a.id;

  const [oa] = await db.insert(appUsersTable).values({
    replitUserId: `reverify-audit-other-admin-${stamp}`,
    username: `reverify_audit_other_admin_${stamp}`,
    email: `reverify_audit_other_admin_${stamp}@example.com`,
    displayName: "Other Org Admin",
    role: "org_admin",
    organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  otherOrgAdminUserId = oa.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: coachUserId, role: "player" },
    { organizationId: orgId, userId: adminUserId, role: "org_admin" },
    { organizationId: otherOrgId, userId: otherOrgAdminUserId, role: "org_admin" },
  ]);

  const [p] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachUserId, displayName: "Audit Coach",
  }).returning({ id: teachingProsTable.id });
  proId = p.id;

  coach = {
    id: coachUserId, username: `reverify_audit_coach_${stamp}`,
    displayName: "Audit Coach", role: "player", organizationId: orgId,
  };
  admin = {
    id: adminUserId, username: `reverify_audit_admin_${stamp}`,
    displayName: "Audit Admin", role: "org_admin", organizationId: orgId,
  };
  otherOrgAdmin = {
    id: otherOrgAdminUserId, username: `reverify_audit_other_admin_${stamp}`,
    displayName: "Other Org Admin", role: "org_admin", organizationId: otherOrgId,
  };

  appAsCoach = createTestApp(coach);
  appAsAdmin = createTestApp(admin);
  appAsOtherOrgAdmin = createTestApp(otherOrgAdmin);
  appAnonymous = createTestApp();
});

afterAll(async () => {
  if (proId) {
    await db.delete(coachPayoutAccountHistoryTable).where(eq(coachPayoutAccountHistoryTable.proId, proId));
    await db.delete(coachMarketplaceProfilesTable).where(eq(coachMarketplaceProfilesTable.proId, proId));
    await db.delete(teachingProsTable).where(eq(teachingProsTable.id, proId));
  }
  const userIds = [coachUserId, adminUserId, otherOrgAdminUserId].filter(Boolean);
  if (userIds.length) await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  const orgIds = [orgId, otherOrgId].filter(Boolean);
  if (orgIds.length) await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgIds));
});

beforeEach(async () => {
  createRazorpayContactMock.mockReset();
  createRazorpayFundAccountMock.mockReset();
  validateRazorpayVpaMock.mockReset();
  validateRazorpayBankFundAccountMock.mockReset();
  // Restore the audit helper to its real implementation (the failure
  // -mode test temporarily overrides it). We re-import via
  // `vi.importActual` so we always get the un-mocked function.
  const realModule = await vi.importActual<typeof import("../lib/coachPayoutAccountReverifyAudit")>(
    "../lib/coachPayoutAccountReverifyAudit",
  );
  recordAdminReverifyHistoryMock.mockReset();
  recordAdminReverifyHistoryMock.mockImplementation(realModule.recordAdminReverifyHistory);
  // Each test seeds its own profile + history rows — start clean.
  await db.delete(coachPayoutAccountHistoryTable).where(eq(coachPayoutAccountHistoryTable.proId, proId));
  await db.delete(coachMarketplaceProfilesTable).where(eq(coachMarketplaceProfilesTable.proId, proId));
});

/**
 * Drive the verify→confirm flow as the coach so the test exercises the
 * same code path real saves go through. Leaves a single `created` audit
 * row in the history table for the caller to ignore (we only assert on
 * the new `admin_reverify` rows the endpoint under test inserts).
 */
async function seedSavedUpiAccount(opts: { upiVpa: string; fundAccountId: string; contactId: string }) {
  createRazorpayContactMock.mockResolvedValueOnce({ id: opts.contactId });
  createRazorpayFundAccountMock.mockResolvedValueOnce({
    id: opts.fundAccountId, contact_id: opts.contactId,
    account_type: "vpa", vpa: { address: opts.upiVpa },
  });
  validateRazorpayVpaMock.mockResolvedValueOnce({
    vpa: opts.upiVpa, success: true, customer_name: "AUDIT COACH",
  });
  const verifyRes = await request(appAsCoach).post(POST_URL).send({
    method: "upi", upiVpa: opts.upiVpa, accountHolderName: "Audit Coach",
  });
  expect(verifyRes.status, verifyRes.text).toBe(200);
  const confirmRes = await request(appAsCoach).post(POST_URL).send({
    method: "upi", confirm: true,
    verificationToken: verifyRes.body.verification.verificationToken,
  });
  expect(confirmRes.status, confirmRes.text).toBe(200);
}

async function seedSavedBankAccount(opts: {
  bankAccountNumber: string; bankIfsc: string;
  fundAccountId: string; contactId: string;
}) {
  createRazorpayContactMock.mockResolvedValueOnce({ id: opts.contactId });
  createRazorpayFundAccountMock.mockResolvedValueOnce({
    id: opts.fundAccountId, contact_id: opts.contactId,
    account_type: "bank_account",
  });
  validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
    id: `fav_${opts.fundAccountId}`, status: "completed",
    results: { account_status: "active", registered_name: "AUDIT COACH" },
  });
  const verifyRes = await request(appAsCoach).post(POST_URL).send({
    method: "bank_account",
    bankAccountNumber: opts.bankAccountNumber, bankIfsc: opts.bankIfsc,
    accountHolderName: "Audit Coach",
  });
  expect(verifyRes.status, verifyRes.text).toBe(200);
  const confirmRes = await request(appAsCoach).post(POST_URL).send({
    method: "bank_account", confirm: true,
    verificationToken: verifyRes.body.verification.verificationToken,
  });
  expect(confirmRes.status, confirmRes.text).toBe(200);
}

describe("POST /coach-marketplace/admin/coaches/:proId/payout-account/reverify — audit row", () => {
  it("inserts an admin_reverify history row when the re-check confirms the UPI account is still verified", async () => {
    await seedSavedUpiAccount({
      upiVpa: "alice.long@upi", contactId: "cont_audit_upi_ok", fundAccountId: "fa_audit_upi_ok",
    });

    // The admin re-verify call hits Razorpay's VPA endpoint a second time.
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "alice.long@upi", success: true, customer_name: "AUDIT COACH",
    });

    const res = await request(appAsAdmin)
      .post(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/reverify`)
      .set("User-Agent", "AdminUI/1.2 (test)")
      .set("X-Forwarded-For", "203.0.113.7")
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("verified");

    // The audit row sits alongside the original `created` row.
    const rows = await db.select()
      .from(coachPayoutAccountHistoryTable)
      .where(eq(coachPayoutAccountHistoryTable.proId, proId))
      .orderBy(asc(coachPayoutAccountHistoryTable.createdAt));
    expect(rows).toHaveLength(2);
    const reverifyRow = rows.find(r => r.changeKind === "admin_reverify")!;
    expect(reverifyRow).toBeDefined();
    expect(reverifyRow.changedByRole).toBe("admin");
    expect(reverifyRow.changedByUserId).toBe(adminUserId);
    expect(reverifyRow.method).toBe("upi");
    expect(reverifyRow.payoutAccountId).toBe("fa_audit_upi_ok");
    expect(reverifyRow.verificationOutcome).toBe("verified");
    expect(reverifyRow.verificationReason).toBeNull();
    // VPA is masked exactly like the coach-initiated rows.
    expect(reverifyRow.upiVpaMasked).not.toBe("alice.long@upi");
    expect(reverifyRow.upiVpaMasked).toContain("@upi");
    expect(reverifyRow.bankAccountLast4).toBeNull();
    // User-agent is captured. (req.ip in supertest reflects the loopback
    // address; the X-Forwarded-For header isn't auto-trusted by Express
    // without `trust proxy`, so we don't assert on the IP value — just
    // that *something* was recorded or null, never undefined.)
    expect(reverifyRow.userAgent).toBe("AdminUI/1.2 (test)");
    expect(typeof reverifyRow.ipAddress === "string" || reverifyRow.ipAddress === null).toBe(true);
  });

  it("inserts an admin_reverify history row carrying the failure reason when the bank account no longer accepts transfers", async () => {
    await seedSavedBankAccount({
      bankAccountNumber: "9876543210", bankIfsc: "ICIC0009999",
      contactId: "cont_audit_bank_bad", fundAccountId: "fa_audit_bank_bad",
    });

    validateRazorpayBankFundAccountMock.mockResolvedValueOnce({
      id: "fav_audit_bank_bad", status: "completed",
      results: { account_status: "invalid", registered_name: "AUDIT COACH" },
      error: { description: "Account closed by bank" },
    });

    const res = await request(appAsAdmin)
      .post(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/reverify`)
      .set("User-Agent", "AdminUI/1.2 (test)")
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("needs_attention");
    expect(res.body.reason).toBe("Account closed by bank");

    const reverifyRows = await db.select()
      .from(coachPayoutAccountHistoryTable)
      .where(and(
        eq(coachPayoutAccountHistoryTable.proId, proId),
        eq(coachPayoutAccountHistoryTable.changeKind, "admin_reverify"),
      ))
      .orderBy(desc(coachPayoutAccountHistoryTable.createdAt));
    expect(reverifyRows).toHaveLength(1);
    const r = reverifyRows[0];
    expect(r.changedByRole).toBe("admin");
    expect(r.changedByUserId).toBe(adminUserId);
    expect(r.method).toBe("bank_account");
    expect(r.payoutAccountId).toBe("fa_audit_bank_bad");
    expect(r.verificationOutcome).toBe("needs_attention");
    expect(r.verificationReason).toBe("Account closed by bank");
    // The masked snapshot mirrors the saved profile.
    expect(r.bankAccountLast4).toBe("3210");
    expect(r.bankIfsc).toBe("ICIC0009999");
    expect(r.upiVpaMasked).toBeNull();
    // Raw account number must never appear in the audit row.
    expect(JSON.stringify(r)).not.toContain("9876543210");
  });

  it("surfaces the new audit row through the org-admin history list endpoint with verificationOutcome / verificationReason", async () => {
    await seedSavedUpiAccount({
      upiVpa: "carol@upi", contactId: "cont_audit_list", fundAccountId: "fa_audit_list",
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "carol@upi", success: false,
    });

    const reverifyRes = await request(appAsAdmin)
      .post(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/reverify`)
      .send({});
    expect(reverifyRes.status, reverifyRes.text).toBe(200);
    expect(reverifyRes.body.outcome).toBe("needs_attention");

    const listRes = await request(appAsAdmin)
      .get(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/history`);
    expect(listRes.status, listRes.text).toBe(200);
    const history = listRes.body.history as Array<Record<string, unknown>>;
    const apiReverify = history.find(h => h.changeKind === "admin_reverify");
    expect(apiReverify).toBeDefined();
    expect(apiReverify!.verificationOutcome).toBe("needs_attention");
    expect(typeof apiReverify!.verificationReason).toBe("string");
    expect(apiReverify!.changedByRole).toBe("admin");
    expect(apiReverify!.changedByName).toBe("Audit Admin");
  });

  it("returns 400 and writes no audit row when the coach has no saved payout account", async () => {
    // No profile seeded — straight to the reverify call.
    const res = await request(appAsAdmin)
      .post(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/reverify`)
      .send({});
    expect(res.status).toBe(400);

    const rows = await db.select()
      .from(coachPayoutAccountHistoryTable)
      .where(eq(coachPayoutAccountHistoryTable.proId, proId));
    expect(rows).toHaveLength(0);
  });

  it("returns 500 (rather than silently succeeding) when the audit-row insert fails", async () => {
    // Compliance contract: a 200 from this endpoint must imply an
    // `admin_reverify` row has been persisted. We simulate a DB failure
    // on just the history insert (via the typed audit-helper mock set
    // up at the top of this file) and assert the request fails loudly
    // so the admin retries — leaving an unaudited state change would
    // be worse than the user-visible error.
    await seedSavedUpiAccount({
      upiVpa: "frank@upi", contactId: "cont_audit_fail", fundAccountId: "fa_audit_fail",
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "frank@upi", success: true, customer_name: "AUDIT COACH",
    });
    recordAdminReverifyHistoryMock.mockRejectedValueOnce(
      new Error("simulated audit insert failure"),
    );

    const res = await request(appAsAdmin)
      .post(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/reverify`)
      .send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/audit/i);

    // The helper was invoked exactly once with the expected payload —
    // proving the route reached the persistence step (and so the 500 is
    // a true persistence-failure response, not an early validation
    // bail-out we'd be confusing for the contract).
    expect(recordAdminReverifyHistoryMock).toHaveBeenCalledTimes(1);
    const call = recordAdminReverifyHistoryMock.mock.calls[0]![0];
    expect(call.proId).toBe(proId);
    expect(call.adminUserId).toBe(adminUserId);
    expect(call.outcome).toBe("verified");
    expect(call.profileBefore.payoutAccountId).toBe("fa_audit_fail");

    // And no admin_reverify row landed in the table.
    const rows = await db.select()
      .from(coachPayoutAccountHistoryTable)
      .where(and(
        eq(coachPayoutAccountHistoryTable.proId, proId),
        eq(coachPayoutAccountHistoryTable.changeKind, "admin_reverify"),
      ));
    expect(rows).toHaveLength(0);
  });

  it("rejects unauthenticated and cross-org admin callers without writing an audit row", async () => {
    await seedSavedUpiAccount({
      upiVpa: "dan@upi", contactId: "cont_audit_authz", fundAccountId: "fa_audit_authz",
    });

    const anonRes = await request(appAnonymous)
      .post(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/reverify`).send({});
    expect(anonRes.status).toBe(401);

    const otherRes = await request(appAsOtherOrgAdmin)
      .post(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/reverify`).send({});
    expect(otherRes.status).toBe(403);

    // Razorpay's re-verify mock was never triggered because the auth
    // checks short-circuit; just assert no admin_reverify rows landed.
    const rows = await db.select()
      .from(coachPayoutAccountHistoryTable)
      .where(and(
        eq(coachPayoutAccountHistoryTable.proId, proId),
        eq(coachPayoutAccountHistoryTable.changeKind, "admin_reverify"),
      ));
    expect(rows).toHaveLength(0);
  });
});
