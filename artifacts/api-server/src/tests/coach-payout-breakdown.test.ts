/**
 * Tests for the coach-facing payout breakdown sheet — Task #1513.
 *
 * Covers `GET /coach/payouts/:id/requests`, which the mobile
 * `PayoutDetailModal` consumes to show the swing-review requests
 * rolled up into a single coach payout (member name, delivered
 * date, gross price, and the coach's share of each).
 *
 * Asserts:
 *   - 401 when the caller is not authenticated
 *   - 403 when a different coach (or a non-coach user) calls the
 *     endpoint for somebody else's payout
 *   - 404 for an unknown payout id (only after the caller has
 *     proven they are a registered coach)
 *   - the per-request `coachSharePaise` honours the owning
 *     coach's `revenueSharePct`
 *   - an empty payout (no requests attached yet) returns an empty
 *     list with 200 — not a 404.
 *
 * Seed pattern mirrors `coach-admin-payouts.test.ts`: two coaches
 * in the same org with their own teaching-pro rows, one of them
 * carrying an explicit 80% revenue share.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  teachingProsTable,
  coachMarketplaceProfilesTable,
  swingVideosTable,
  swingReviewRequestsTable,
  coachPayoutsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let memberUserId: number;
let nonCoachUserId: number;
let coachAUserId: number;
let coachBUserId: number;
let coachAProId: number;
let coachBProId: number;
let coachAVideoId: number;
let coachBVideoId: number;

let coachA: TestUser;
let coachB: TestUser;
let nonCoach: TestUser;
let appAsCoachA: ReturnType<typeof createTestApp>;
let appAsCoachB: ReturnType<typeof createTestApp>;
let appAsNonCoach: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;

async function clearReviewsAndPayouts() {
  await db.update(swingReviewRequestsTable)
    .set({ payoutId: null })
    .where(eq(swingReviewRequestsTable.organizationId, orgId));
  await db.delete(coachPayoutsTable).where(eq(coachPayoutsTable.organizationId, orgId));
  await db.delete(swingReviewRequestsTable).where(eq(swingReviewRequestsTable.organizationId, orgId));
}

async function seedDeliveredReview(proId: number, videoId: number, pricePaise: number) {
  const [row] = await db.insert(swingReviewRequestsTable).values({
    organizationId: orgId,
    proId,
    userId: memberUserId,
    swingVideoId: videoId,
    pricePaise,
    status: "delivered",
    escrowHeld: true,
    deliveredAt: new Date(),
  }).returning();
  return row;
}

async function seedPayoutForCoach(proId: number, opts: { gross: number; net: number } = { gross: 0, net: 0 }) {
  const [row] = await db.insert(coachPayoutsTable).values({
    proId,
    organizationId: orgId,
    periodStart: new Date(),
    periodEnd: new Date(),
    grossPaise: opts.gross,
    platformFeePaise: opts.gross - opts.net,
    netPayoutPaise: opts.net,
    status: "pending",
  }).returning();
  return row;
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `CoachPayoutBreakdown_${stamp}`,
    slug: `coach-payout-breakdown-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [memberU] = await db.insert(appUsersTable).values({
    replitUserId: `coach-payout-bd-member-${stamp}`,
    username: `coach_payout_bd_member_${stamp}`,
    email: `coach_payout_bd_member_${stamp}@example.com`,
    displayName: "Breakdown Member",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  memberUserId = memberU.id;

  const [nonCoachU] = await db.insert(appUsersTable).values({
    replitUserId: `coach-payout-bd-noncoach-${stamp}`,
    username: `coach_payout_bd_noncoach_${stamp}`,
    email: `coach_payout_bd_noncoach_${stamp}@example.com`,
    displayName: "Breakdown NonCoach",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  nonCoachUserId = nonCoachU.id;

  const [coachAU] = await db.insert(appUsersTable).values({
    replitUserId: `coach-payout-bd-coachA-${stamp}`,
    username: `coach_payout_bd_coachA_${stamp}`,
    email: `coach_payout_bd_coachA_${stamp}@example.com`,
    displayName: "Coach A",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachAUserId = coachAU.id;

  const [coachBU] = await db.insert(appUsersTable).values({
    replitUserId: `coach-payout-bd-coachB-${stamp}`,
    username: `coach_payout_bd_coachB_${stamp}`,
    email: `coach_payout_bd_coachB_${stamp}@example.com`,
    displayName: "Coach B",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachBUserId = coachBU.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: memberUserId, role: "player" },
    { organizationId: orgId, userId: nonCoachUserId, role: "player" },
    { organizationId: orgId, userId: coachAUserId, role: "player" },
    { organizationId: orgId, userId: coachBUserId, role: "player" },
  ]);

  const [proA] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachAUserId, displayName: "Coach A",
  }).returning({ id: teachingProsTable.id });
  coachAProId = proA.id;

  const [proB] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachBUserId, displayName: "Coach B",
  }).returning({ id: teachingProsTable.id });
  coachBProId = proB.id;

  // Coach A: explicit 80% revenue share. Coach B: no profile row → 70% default.
  await db.insert(coachMarketplaceProfilesTable).values({
    proId: coachAProId, organizationId: orgId,
    isListed: true, revenueSharePct: "80",
    asyncReviewPricePaise: 50000,
  });

  const [vidA] = await db.insert(swingVideosTable).values({
    userId: memberUserId, organizationId: orgId,
    videoUrl: "https://example.com/breakdown-a.mp4",
  }).returning({ id: swingVideosTable.id });
  coachAVideoId = vidA.id;

  const [vidB] = await db.insert(swingVideosTable).values({
    userId: memberUserId, organizationId: orgId,
    videoUrl: "https://example.com/breakdown-b.mp4",
  }).returning({ id: swingVideosTable.id });
  coachBVideoId = vidB.id;

  coachA = {
    id: coachAUserId, username: `coach_payout_bd_coachA_${stamp}`,
    displayName: "Coach A", role: "player", organizationId: orgId,
  };
  coachB = {
    id: coachBUserId, username: `coach_payout_bd_coachB_${stamp}`,
    displayName: "Coach B", role: "player", organizationId: orgId,
  };
  nonCoach = {
    id: nonCoachUserId, username: `coach_payout_bd_noncoach_${stamp}`,
    displayName: "Breakdown NonCoach", role: "player", organizationId: orgId,
  };
  appAsCoachA = createTestApp(coachA);
  appAsCoachB = createTestApp(coachB);
  appAsNonCoach = createTestApp(nonCoach);
  appAnonymous = createTestApp();
});

afterAll(async () => {
  if (orgId) {
    await db.delete(swingReviewRequestsTable).where(eq(swingReviewRequestsTable.organizationId, orgId));
    await db.delete(coachPayoutsTable).where(eq(coachPayoutsTable.organizationId, orgId));
    await db.delete(swingVideosTable).where(eq(swingVideosTable.organizationId, orgId));
    await db.delete(coachMarketplaceProfilesTable).where(eq(coachMarketplaceProfilesTable.organizationId, orgId));
    await db.delete(teachingProsTable).where(eq(teachingProsTable.organizationId, orgId));
    await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  }
  const userIds = [memberUserId, nonCoachUserId, coachAUserId, coachBUserId].filter(Boolean);
  if (userIds.length) await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  await clearReviewsAndPayouts();
});

describe("GET /coach/payouts/:id/requests", () => {
  it("requires authentication", async () => {
    const payout = await seedPayoutForCoach(coachAProId);
    const res = await request(appAnonymous)
      .get(`/api/swing-reviews/coach/payouts/${payout.id}/requests`);
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not a registered coach", async () => {
    const payout = await seedPayoutForCoach(coachAProId);
    const res = await request(appAsNonCoach)
      .get(`/api/swing-reviews/coach/payouts/${payout.id}/requests`);
    expect(res.status).toBe(403);
  });

  it("returns 403 when a different coach tries to read another coach's payout", async () => {
    const payout = await seedPayoutForCoach(coachAProId);
    const res = await request(appAsCoachB)
      .get(`/api/swing-reviews/coach/payouts/${payout.id}/requests`);
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown payout id (caller is a coach)", async () => {
    const res = await request(appAsCoachA)
      .get(`/api/swing-reviews/coach/payouts/9999999/requests`);
    expect(res.status).toBe(404);
  });

  it("computes per-request coachSharePaise using the coach's revenueSharePct", async () => {
    // Two delivered reviews for Coach A (attached to A's payout) and
    // one delivered review for Coach B that is NOT attached — the
    // route must only return rows whose payoutId matches the path id.
    const a1 = await seedDeliveredReview(coachAProId, coachAVideoId, 50000);
    const a2 = await seedDeliveredReview(coachAProId, coachAVideoId, 30000);
    const b1 = await seedDeliveredReview(coachBProId, coachBVideoId, 40000);

    const payout = await seedPayoutForCoach(coachAProId, { gross: 80000, net: 64000 });
    await db.update(swingReviewRequestsTable)
      .set({ payoutId: payout.id })
      .where(inArray(swingReviewRequestsTable.id, [a1.id, a2.id]));

    // b1 is intentionally left unattached — exercises the payoutId
    // filter in the route so a foreign coach's request cannot leak in.
    void b1;

    const res = await request(appAsCoachA)
      .get(`/api/swing-reviews/coach/payouts/${payout.id}/requests`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.sharePct).toBe(80);
    expect(res.body.payout.id).toBe(payout.id);

    const requests = res.body.requests as Array<{
      id: number; memberName: string; pricePaise: number; coachSharePaise: number;
    }>;
    expect(requests).toHaveLength(2);
    const ids = requests.map(r => r.id).sort((x, y) => x - y);
    expect(ids).toEqual([a1.id, a2.id].sort((x, y) => x - y));

    const r1 = requests.find(r => r.id === a1.id)!;
    const r2 = requests.find(r => r.id === a2.id)!;
    expect(r1.pricePaise).toBe(50000);
    // 80% of 50000 = 40000
    expect(r1.coachSharePaise).toBe(40000);
    expect(r2.pricePaise).toBe(30000);
    // 80% of 30000 = 24000
    expect(r2.coachSharePaise).toBe(24000);

    // Member name is surfaced from displayName.
    expect(r1.memberName).toBe("Breakdown Member");
  });

  it("falls back to the default 70% revenue share when the coach has no marketplace profile", async () => {
    const b1 = await seedDeliveredReview(coachBProId, coachBVideoId, 40000);
    const payout = await seedPayoutForCoach(coachBProId, { gross: 40000, net: 28000 });
    await db.update(swingReviewRequestsTable)
      .set({ payoutId: payout.id })
      .where(eq(swingReviewRequestsTable.id, b1.id));

    const res = await request(appAsCoachB)
      .get(`/api/swing-reviews/coach/payouts/${payout.id}/requests`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.sharePct).toBe(70);
    const requests = res.body.requests as Array<{ id: number; pricePaise: number; coachSharePaise: number }>;
    expect(requests).toHaveLength(1);
    // 70% of 40000 = 28000
    expect(requests[0].coachSharePaise).toBe(28000);
  });

  it("returns an empty list (not 404) when the payout has no requests attached", async () => {
    const payout = await seedPayoutForCoach(coachAProId);
    const res = await request(appAsCoachA)
      .get(`/api/swing-reviews/coach/payouts/${payout.id}/requests`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.requests).toEqual([]);
    expect(res.body.payout.id).toBe(payout.id);
    expect(res.body.sharePct).toBe(80);
  });
});
