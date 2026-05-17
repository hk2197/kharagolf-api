/**
 * Integration tests: club-wide levy summary endpoint (Task 230).
 *
 * Covers GET /api/organizations/:orgId/members-360/levies-summary.
 *
 *   - 401 when unauthenticated, 403 for non-admin roles
 *   - Aggregated collected / outstanding / refunded / waivedAmount totals
 *     across mixed statuses (paid, partial, unpaid, waived, refunded)
 *   - Levies with zero charges still appear (LEFT JOIN) with zero counts
 *   - totalsByCurrency buckets correctly split multi-currency clubs
 *
 * Uses the real PostgreSQL database (DATABASE_URL). Test data is created
 * in beforeAll and cleaned in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let testOrgId: number;
let adminUserId: number;
let nonAdminUserId: number;
let memberAId: number;
let memberBId: number;
let memberCId: number;
let mixedInrLevyId: number;
let emptyLevyId: number;
let usdLevyId: number;

let admin: TestUser;
let nonAdmin: TestUser;
let adminApp: ReturnType<typeof createTestApp>;
let nonAdminApp: ReturnType<typeof createTestApp>;
let anonApp: ReturnType<typeof createTestApp>;

const BASE = () => `/api/organizations/${testOrgId}/members-360`;

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_LeviesSummary_${stamp}`,
    slug: `test-levies-summary-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-levies-summary-admin-${stamp}`,
    username: `levies_summary_admin_${stamp}`,
    email: `levies_summary_admin_${stamp}@example.com`,
    displayName: "Levies Summary Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [nonAdminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-levies-summary-player-${stamp}`,
    username: `levies_summary_player_${stamp}`,
    email: `levies_summary_player_${stamp}@example.com`,
    displayName: "Levies Summary Player",
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  nonAdminUserId = nonAdminRow.id;

  const [m1] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Alpha", lastName: "Member",
    email: `alpha_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberAId = m1.id;

  const [m2] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Beta", lastName: "Member",
    email: `beta_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberBId = m2.id;

  const [m3] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Gamma", lastName: "Member",
    email: `gamma_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberCId = m3.id;

  // Levy 1 — INR with five charges across all five statuses.
  // amount per charge = 100. The endpoint sums paid_amount across ALL
  // charges (regardless of status), so a refunded charge that was first
  // paid still contributes to `collected`. Expected aggregates:
  //   collected    = 100 (paid) + 40 (partial) + 100 (refunded was paid) = 240
  //   refunded     = 100 (refunded)                                       = 100
  //   outstanding  = 0 (paid) + 60 (partial: 100-40-0) + 100 (unpaid)     = 160
  //   waivedAmount = 100 (waived)                                         = 100
  //   counts: paid=1 partial=1 unpaid=1 waived=1 refunded=1, chargesCount=5
  const [lv1] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: `Mixed INR Levy ${stamp}`,
    amount: "100.00", currency: "INR",
    status: "applied", appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  mixedInrLevyId = lv1.id;

  // To exercise all five statuses we need five distinct (levyId, memberId)
  // pairs (table has a unique index). Re-use members where possible by
  // splitting across additional levies — but the spec wants the aggregates
  // on a single levy, so create three extra throwaway members for the
  // remaining statuses.
  const extraMembers: number[] = [];
  for (let i = 0; i < 2; i++) {
    const [em] = await db.insert(clubMembersTable).values({
      organizationId: testOrgId,
      firstName: `Extra${i}`, lastName: "Member",
      email: `extra${i}_${stamp}@example.com`,
    }).returning({ id: clubMembersTable.id });
    extraMembers.push(em.id);
  }

  await db.insert(memberLevyChargesTable).values([
    // paid
    { levyId: mixedInrLevyId, clubMemberId: memberAId, amount: "100.00",
      status: "paid", paid: true, paidAmount: "100.00", refundedAmount: "0", paidAt: new Date() },
    // partial (40 of 100)
    { levyId: mixedInrLevyId, clubMemberId: memberBId, amount: "100.00",
      status: "partial", paid: false, paidAmount: "40.00", refundedAmount: "0" },
    // unpaid
    { levyId: mixedInrLevyId, clubMemberId: memberCId, amount: "100.00",
      status: "unpaid", paid: false, paidAmount: "0", refundedAmount: "0" },
    // waived
    { levyId: mixedInrLevyId, clubMemberId: extraMembers[0], amount: "100.00",
      status: "waived", paid: false, paidAmount: "0", refundedAmount: "0",
      waivedReason: "goodwill" },
    // refunded (paid then fully refunded)
    { levyId: mixedInrLevyId, clubMemberId: extraMembers[1], amount: "100.00",
      status: "refunded", paid: true, paidAmount: "100.00", refundedAmount: "100.00",
      paidAt: new Date() },
  ]);

  // Levy 2 — INR with zero charges (newly-created, never applied).
  const [lv2] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: `Empty INR Levy ${stamp}`,
    amount: "250.00", currency: "INR",
    status: "draft",
  }).returning({ id: memberLeviesTable.id });
  emptyLevyId = lv2.id;

  // Levy 3 — USD currency with one paid + one unpaid charge (different members).
  // collected=200, outstanding=200, refunded=0, waivedAmount=0
  const [lv3] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: `USD Levy ${stamp}`,
    amount: "200.00", currency: "USD",
    status: "applied", appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  usdLevyId = lv3.id;

  await db.insert(memberLevyChargesTable).values([
    { levyId: usdLevyId, clubMemberId: memberAId, amount: "200.00",
      status: "paid", paid: true, paidAmount: "200.00", refundedAmount: "0", paidAt: new Date() },
    { levyId: usdLevyId, clubMemberId: memberBId, amount: "200.00",
      status: "unpaid", paid: false, paidAmount: "0", refundedAmount: "0" },
  ]);

  admin = {
    id: adminUserId,
    username: `levies_summary_admin_${stamp}`,
    role: "org_admin",
    organizationId: testOrgId,
  };
  nonAdmin = {
    id: nonAdminUserId,
    username: `levies_summary_player_${stamp}`,
    role: "player",
    organizationId: testOrgId,
  };
  adminApp = createTestApp(admin);
  nonAdminApp = createTestApp(nonAdmin);
  anonApp = createTestApp(undefined);
});

afterAll(async () => {
  // app_users.organization_id has ON DELETE NO ACTION (FK with no cascade),
  // so users created for this org must be removed before the org itself.
  // Levies, charges, and club members all cascade off organizations.
  if (adminUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  }
  if (nonAdminUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, nonAdminUserId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

describe("GET /levies-summary — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(anonApp).get(`${BASE()}/levies-summary`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/auth/i);
  });

  it("returns 403 for a non-admin role (player)", async () => {
    const res = await request(nonAdminApp).get(`${BASE()}/levies-summary`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access/i);
  });

  it("returns 200 for an org_admin", async () => {
    const res = await request(adminApp).get(`${BASE()}/levies-summary`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.levies)).toBe(true);
    expect(typeof res.body.totalsByCurrency).toBe("object");
  });
});

describe("GET /levies-summary — aggregation", () => {
  it("aggregates collected / outstanding / refunded / waived correctly across mixed statuses", async () => {
    const res = await request(adminApp).get(`${BASE()}/levies-summary`);
    expect(res.status).toBe(200);

    const mixed = res.body.levies.find(
      (l: { id: number }) => l.id === mixedInrLevyId,
    );
    expect(mixed, "mixed-status levy must appear").toBeDefined();

    expect(parseFloat(mixed.collected)).toBe(240);
    expect(parseFloat(mixed.outstanding)).toBe(160);
    expect(parseFloat(mixed.refunded)).toBe(100);
    expect(parseFloat(mixed.waivedAmount)).toBe(100);

    expect(mixed.chargesCount).toBe(5);
    expect(mixed.paidCount).toBe(1);
    expect(mixed.partialCount).toBe(1);
    expect(mixed.unpaidCount).toBe(1);
    expect(mixed.waivedCount).toBe(1);
    expect(mixed.refundedCount).toBe(1);
  });

  it("includes levies with zero charges as zero rows", async () => {
    const res = await request(adminApp).get(`${BASE()}/levies-summary`);
    expect(res.status).toBe(200);

    const empty = res.body.levies.find(
      (l: { id: number }) => l.id === emptyLevyId,
    );
    expect(empty, "empty levy must still appear (LEFT JOIN)").toBeDefined();
    expect(empty.chargesCount).toBe(0);
    expect(empty.paidCount).toBe(0);
    expect(empty.partialCount).toBe(0);
    expect(empty.unpaidCount).toBe(0);
    expect(empty.waivedCount).toBe(0);
    expect(empty.refundedCount).toBe(0);
    expect(parseFloat(empty.collected)).toBe(0);
    expect(parseFloat(empty.outstanding)).toBe(0);
    expect(parseFloat(empty.refunded)).toBe(0);
    expect(parseFloat(empty.waivedAmount)).toBe(0);
  });
});

describe("GET /levies-summary — totalsByCurrency", () => {
  it("buckets totals per currency for multi-currency clubs", async () => {
    const res = await request(adminApp).get(`${BASE()}/levies-summary`);
    expect(res.status).toBe(200);

    const totals = res.body.totalsByCurrency as Record<string, {
      collected: number; outstanding: number; refunded: number; waived: number;
      chargesCount: number; leviesCount: number;
    }>;

    // Test data only created INR + USD — but the org may inherit from a
    // shared dev DB, so assert key existence rather than exact set equality.
    expect(totals.INR).toBeDefined();
    expect(totals.USD).toBeDefined();

    // INR aggregates = mixed levy (240/160/100/100, 5 charges, 1 levy)
    //                + empty levy (0/0/0/0, 0 charges, 1 levy)
    expect(totals.INR.collected).toBe(240);
    expect(totals.INR.outstanding).toBe(160);
    expect(totals.INR.refunded).toBe(100);
    expect(totals.INR.waived).toBe(100);
    expect(totals.INR.chargesCount).toBe(5);
    expect(totals.INR.leviesCount).toBe(2);

    // USD aggregates = usd levy (200/200/0/0, 2 charges, 1 levy)
    expect(totals.USD.collected).toBe(200);
    expect(totals.USD.outstanding).toBe(200);
    expect(totals.USD.refunded).toBe(0);
    expect(totals.USD.waived).toBe(0);
    expect(totals.USD.chargesCount).toBe(2);
    expect(totals.USD.leviesCount).toBe(1);
  });
});
