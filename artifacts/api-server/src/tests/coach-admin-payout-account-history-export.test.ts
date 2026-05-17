/**
 * Tests for the org-wide payout-account history export endpoint — Task #1066.
 *
 * Covers:
 *   GET /coach-marketplace/admin/payout-account/history
 *
 * The endpoint backs the "Export history (CSV)" control on the Coaches card
 * of the org-admin coach payouts screen. Compliance/finance teams rely on
 * the export, so we lock in the authorization rules and the row shape:
 *
 *   - 401 anonymous, 403 non-admin
 *   - org-admin gets every history row across every pro in the org
 *   - when no organizationId is supplied, the route defaults to the
 *     caller's own organization (and never leaks rows from another org)
 *   - rows include `proName` and the masked detail fields the CSV exporter
 *     reads (upiVpaMasked / bankAccountLast4 / bankIfsc), plus the
 *     change-actor metadata
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  teachingProsTable,
  coachPayoutAccountHistoryTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let otherOrgId: number;
let adminUserId: number;
let otherAdminUserId: number;
let nonAdminUserId: number;
let coachAUserId: number;
let coachBUserId: number;
let otherCoachUserId: number;
let coachAProId: number;
let coachBProId: number;
let otherCoachProId: number;

let admin: TestUser;
let otherAdmin: TestUser;
let nonAdmin: TestUser;
let appAsAdmin: ReturnType<typeof createTestApp>;
let appAsOtherAdmin: ReturnType<typeof createTestApp>;
let appAsNonAdmin: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `PayoutHistExport_${stamp}`,
    slug: `payout-hist-export-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `PayoutHistExportOther_${stamp}`,
    slug: `payout-hist-export-other-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  const [adminU] = await db.insert(appUsersTable).values({
    replitUserId: `phe-admin-${stamp}`,
    username: `phe_admin_${stamp}`,
    email: `phe_admin_${stamp}@example.com`,
    displayName: "Hist Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminU.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: adminUserId, role: "org_admin",
  });

  const [otherAdminU] = await db.insert(appUsersTable).values({
    replitUserId: `phe-other-admin-${stamp}`,
    username: `phe_other_admin_${stamp}`,
    email: `phe_other_admin_${stamp}@example.com`,
    displayName: "Other Hist Admin",
    role: "org_admin",
    organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  otherAdminUserId = otherAdminU.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: otherOrgId, userId: otherAdminUserId, role: "org_admin",
  });

  const [nonAdminU] = await db.insert(appUsersTable).values({
    replitUserId: `phe-nonadmin-${stamp}`,
    username: `phe_nonadmin_${stamp}`,
    email: `phe_nonadmin_${stamp}@example.com`,
    displayName: "Hist NonAdmin",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  nonAdminUserId = nonAdminU.id;

  const [coachAU] = await db.insert(appUsersTable).values({
    replitUserId: `phe-coachA-${stamp}`,
    username: `phe_coachA_${stamp}`,
    email: `phe_coachA_${stamp}@example.com`,
    displayName: "Coach Alpha",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachAUserId = coachAU.id;

  const [coachBU] = await db.insert(appUsersTable).values({
    replitUserId: `phe-coachB-${stamp}`,
    username: `phe_coachB_${stamp}`,
    email: `phe_coachB_${stamp}@example.com`,
    displayName: "Coach Bravo",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachBUserId = coachBU.id;

  const [otherCoachU] = await db.insert(appUsersTable).values({
    replitUserId: `phe-other-coach-${stamp}`,
    username: `phe_other_coach_${stamp}`,
    email: `phe_other_coach_${stamp}@example.com`,
    displayName: "Coach Other",
    role: "player",
    organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  otherCoachUserId = otherCoachU.id;

  const [proA] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachAUserId, displayName: "Coach Alpha",
  }).returning({ id: teachingProsTable.id });
  coachAProId = proA.id;

  const [proB] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachBUserId, displayName: "Coach Bravo",
  }).returning({ id: teachingProsTable.id });
  coachBProId = proB.id;

  const [otherPro] = await db.insert(teachingProsTable).values({
    organizationId: otherOrgId, userId: otherCoachUserId, displayName: "Coach Other",
  }).returning({ id: teachingProsTable.id });
  otherCoachProId = otherPro.id;

  // Seed history rows: two for Coach Alpha (UPI created → bank updated),
  // one for Coach Bravo (UPI), and one for the cross-org coach (must NOT
  // appear in this org's export).
  const t0 = new Date(Date.now() - 60_000);
  const t1 = new Date(Date.now() - 30_000);
  const t2 = new Date(Date.now() - 10_000);

  // Task #1427 — also seed an admin_reverify audit row for Coach Alpha
  // so we can lock in the new `changeKind` filter on the org-wide
  // export endpoint.
  const t3 = new Date(Date.now() - 5_000);

  await db.insert(coachPayoutAccountHistoryTable).values([
    {
      proId: coachAProId, organizationId: orgId,
      changedByUserId: coachAUserId, changedByRole: "coach", changeKind: "created",
      method: "upi",
      accountHolderName: "Coach Alpha",
      upiVpaMasked: "co***@upi",
      payoutAccountId: "fa_alpha_1",
      ipAddress: "10.0.0.1",
      userAgent: "vitest",
      createdAt: t0,
    },
    {
      proId: coachAProId, organizationId: orgId,
      changedByUserId: adminUserId, changedByRole: "admin", changeKind: "updated",
      method: "bank_account",
      accountHolderName: "Coach Alpha",
      bankAccountLast4: "1234",
      bankIfsc: "HDFC0000001",
      payoutAccountId: "fa_alpha_2",
      ipAddress: "10.0.0.2",
      userAgent: "vitest",
      createdAt: t1,
    },
    {
      proId: coachBProId, organizationId: orgId,
      changedByUserId: coachBUserId, changedByRole: "coach", changeKind: "created",
      method: "upi",
      accountHolderName: "Coach Bravo",
      upiVpaMasked: "br***@upi",
      payoutAccountId: "fa_bravo_1",
      ipAddress: "10.0.0.3",
      userAgent: "vitest",
      createdAt: t2,
    },
    {
      proId: otherCoachProId, organizationId: otherOrgId,
      changedByUserId: otherCoachUserId, changedByRole: "coach", changeKind: "created",
      method: "upi",
      accountHolderName: "Coach Other",
      upiVpaMasked: "ot***@upi",
      payoutAccountId: "fa_other_1",
      ipAddress: "10.9.9.9",
      userAgent: "vitest",
      createdAt: t2,
    },
    {
      // Task #1427 — admin re-verify row (mirrors the saved bank
      // account snapshot; verificationOutcome / verificationReason
      // carry the audit signal).
      proId: coachAProId, organizationId: orgId,
      changedByUserId: adminUserId, changedByRole: "admin", changeKind: "admin_reverify",
      method: "bank_account",
      accountHolderName: "Coach Alpha",
      bankAccountLast4: "1234",
      bankIfsc: "HDFC0000001",
      payoutAccountId: "fa_alpha_2",
      verificationOutcome: "needs_attention",
      verificationReason: "Bank account is no longer accepting transfers",
      ipAddress: "10.0.0.4",
      userAgent: "vitest",
      createdAt: t3,
    },
  ]);

  admin = { id: adminUserId, username: `phe_admin_${stamp}`, role: "org_admin", organizationId: orgId };
  otherAdmin = { id: otherAdminUserId, username: `phe_other_admin_${stamp}`, role: "org_admin", organizationId: otherOrgId };
  nonAdmin = { id: nonAdminUserId, username: `phe_nonadmin_${stamp}`, role: "player", organizationId: orgId };
  appAsAdmin = createTestApp(admin);
  appAsOtherAdmin = createTestApp(otherAdmin);
  appAsNonAdmin = createTestApp(nonAdmin);
  appAnonymous = createTestApp();
});

afterAll(async () => {
  const proIds = [coachAProId, coachBProId, otherCoachProId].filter(Boolean);
  if (proIds.length) {
    await db.delete(coachPayoutAccountHistoryTable)
      .where(inArray(coachPayoutAccountHistoryTable.proId, proIds));
    await db.delete(teachingProsTable)
      .where(inArray(teachingProsTable.id, proIds));
  }
  const userIds = [
    adminUserId, otherAdminUserId, nonAdminUserId,
    coachAUserId, coachBUserId, otherCoachUserId,
  ].filter(Boolean);
  if (userIds.length) await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (otherOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

describe("GET /coach-marketplace/admin/payout-account/history (org-wide export)", () => {
  it("requires authentication", async () => {
    const res = await request(appAnonymous)
      .get(`/api/coach-marketplace/admin/payout-account/history`)
      .query({ organizationId: orgId });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin caller in the same org", async () => {
    const res = await request(appAsNonAdmin)
      .get(`/api/coach-marketplace/admin/payout-account/history`)
      .query({ organizationId: orgId });
    expect(res.status).toBe(403);
  });

  it("returns 403 for an admin of a different org", async () => {
    const res = await request(appAsOtherAdmin)
      .get(`/api/coach-marketplace/admin/payout-account/history`)
      .query({ organizationId: orgId });
    expect(res.status).toBe(403);
  });

  it("defaults to the caller's organization when organizationId is omitted", async () => {
    const res = await request(appAsAdmin)
      .get(`/api/coach-marketplace/admin/payout-account/history`);
    expect(res.status, res.text).toBe(200);
    const history = res.body.history as Array<{ proId: number; proName: string }>;
    // Only this org's four rows (created + updated + bravo create +
    // admin_reverify); the other org's row must not leak in.
    const ourPros = new Set([coachAProId, coachBProId]);
    expect(history.length).toBe(4);
    for (const h of history) {
      expect(ourPros.has(h.proId)).toBe(true);
    }
    expect(history.some(h => h.proId === otherCoachProId)).toBe(false);
  });

  it("returns 400 when organizationId is missing and the caller has no org", async () => {
    const orphan: TestUser = { id: nonAdminUserId, username: "phe_orphan", role: "super_admin" };
    const orphanApp = createTestApp(orphan);
    const res = await request(orphanApp)
      .get(`/api/coach-marketplace/admin/payout-account/history`);
    expect(res.status).toBe(400);
  });

  it("returns every audit row in the org with the fields the CSV exporter needs", async () => {
    const res = await request(appAsAdmin)
      .get(`/api/coach-marketplace/admin/payout-account/history`)
      .query({ organizationId: orgId });
    expect(res.status, res.text).toBe(200);
    const history = res.body.history as Array<{
      id: number; proId: number; proName: string;
      changeKind: string; method: string;
      accountHolderName: string | null;
      upiVpaMasked: string | null;
      bankAccountLast4: string | null;
      bankIfsc: string | null;
      payoutAccountId: string | null;
      changedByUserId: number | null;
      changedByRole: string | null;
      changedByName: string | null;
      ipAddress: string | null;
      createdAt: string;
    }>;
    // Task #1427 — fixture now also includes one admin_reverify row.
    expect(history.length).toBe(4);

    const alphaRows = history.filter(h => h.proId === coachAProId);
    expect(alphaRows.length).toBe(3);
    const alphaUpdate = alphaRows.find(h => h.changeKind === "updated")!;
    expect(alphaUpdate.proName).toBe("Coach Alpha");
    expect(alphaUpdate.method).toBe("bank_account");
    expect(alphaUpdate.bankAccountLast4).toBe("1234");
    expect(alphaUpdate.bankIfsc).toBe("HDFC0000001");
    expect(alphaUpdate.payoutAccountId).toBe("fa_alpha_2");
    expect(alphaUpdate.changedByRole).toBe("admin");
    expect(alphaUpdate.changedByName).toBe("Hist Admin");
    expect(alphaUpdate.ipAddress).toBe("10.0.0.2");

    const alphaCreate = alphaRows.find(h => h.changeKind === "created")!;
    expect(alphaCreate.method).toBe("upi");
    expect(alphaCreate.upiVpaMasked).toBe("co***@upi");
    expect(alphaCreate.changedByRole).toBe("coach");

    const bravoRow = history.find(h => h.proId === coachBProId)!;
    expect(bravoRow.proName).toBe("Coach Bravo");
    expect(bravoRow.method).toBe("upi");
    expect(bravoRow.upiVpaMasked).toBe("br***@upi");
  });

  // Task #1427 — optional `changeKind` query parameter narrows the
  // org-wide export to a single audit category. Compliance reviewers
  // use this from the new dropdown next to the "Export history (CSV)"
  // button on the Coaches card.
  it("filters by changeKind=admin_reverify and ignores unknown filter values", async () => {
    const filtered = await request(appAsAdmin)
      .get(`/api/coach-marketplace/admin/payout-account/history`)
      .query({ organizationId: orgId, changeKind: "admin_reverify" });
    expect(filtered.status, filtered.text).toBe(200);
    const filteredHistory = filtered.body.history as Array<{
      proId: number; changeKind: string;
      verificationOutcome: string | null;
      verificationReason: string | null;
    }>;
    expect(filteredHistory.length).toBe(1);
    expect(filteredHistory[0].proId).toBe(coachAProId);
    expect(filteredHistory[0].changeKind).toBe("admin_reverify");
    expect(filteredHistory[0].verificationOutcome).toBe("needs_attention");
    expect(filteredHistory[0].verificationReason).toBe("Bank account is no longer accepting transfers");

    // Unknown values fall through to "no filter" so a typo never
    // silently empties the export.
    const unknown = await request(appAsAdmin)
      .get(`/api/coach-marketplace/admin/payout-account/history`)
      .query({ organizationId: orgId, changeKind: "totally-bogus" });
    expect(unknown.status).toBe(200);
    expect((unknown.body.history as unknown[]).length).toBe(4);

    // Explicit "all" sentinel is also treated as no filter.
    const allSentinel = await request(appAsAdmin)
      .get(`/api/coach-marketplace/admin/payout-account/history`)
      .query({ organizationId: orgId, changeKind: "all" });
    expect(allSentinel.status).toBe(200);
    expect((allSentinel.body.history as unknown[]).length).toBe(4);
  });
});
