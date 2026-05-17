/**
 * Task #883 — Pin the per-segment price-elasticity wiring on
 *   POST /organizations/:orgId/tee-pricing/forecast
 *
 * The forecaster now applies separate price-elasticity coefficients to the
 * member-seat and guest-seat projections (introduced by Task #730). These
 * tests assert that:
 *
 *   1. Bumping ONLY the member rate causes the projected booked seats to
 *      shift with `memberElasticity` — and is unaffected by changes to
 *      `guestElasticity`.
 *   2. Bumping ONLY the guest rate causes the projected booked seats to
 *      shift with `guestElasticity` — and is unaffected by changes to
 *      `memberElasticity`.
 *   3. The legacy single `elasticity` field still works and is applied to
 *      both segments (backwards-compat with older clients).
 *   4. Invalid / missing values fall back to org defaults, and extreme
 *      values are clamped to the documented [-3, 0] band.
 *
 * The numbers are derived from the same constant-elasticity model the
 * route uses internally:  q1 = q0 * (p1/p0)^elasticity  (clamped to the
 * per-segment seat cap). Fixtures pin the historical utilisation and
 * member/guest mix the forecaster reads from so the predicted seat counts
 * are deterministic.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  coursesTable,
  courseTeeSlotTable,
  teeBookingsTable,
  teeBookingPlayersTable,
  teePricingRulesTable,
  teeDynamicPricingTiersTable,
  teeDynamicPricingModifiersTable,
  teeDynamicPricingConfigTable,
  teeDynamicPricingCourseElasticityTable,
  teeDynamicPricingAuditTable,
  teePricingForecastsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let userId: number;
let courseId: number;
let baselineTierId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

// All upcoming slots use the same capacity so historical util & member-share
// translate to a single (estMember, estGuest) split everywhere. Picked large
// enough that JS rounding is unambiguous on each segment.
const CAPACITY = 10;
// History below seeds 8 of 10 seats booked per past slot → util = 0.8.
const HISTORICAL_UTIL = 0.8;
// Historical players: 7 members + 3 guests per past slot → memberShare = 0.7.
const MEMBER_SHARE = 0.7;
// Active tier rates used by every test in this file.
const ACTIVE_MEMBER_RATE = 1000;
const ACTIVE_GUEST_RATE = 1500;

function dayOffset(days: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}

async function clearFixtures() {
  await db.delete(teePricingForecastsTable).where(eq(teePricingForecastsTable.organizationId, orgId));
  const bookings = await db.select({ id: teeBookingsTable.id })
    .from(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
  for (const b of bookings) {
    await db.delete(teeBookingPlayersTable).where(eq(teeBookingPlayersTable.bookingId, b.id));
  }
  await db.delete(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
  await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.organizationId, orgId));
  await db.delete(teeDynamicPricingAuditTable).where(eq(teeDynamicPricingAuditTable.organizationId, orgId));
  await db.delete(teeDynamicPricingCourseElasticityTable).where(eq(teeDynamicPricingCourseElasticityTable.organizationId, orgId));
  await db.delete(teeDynamicPricingModifiersTable).where(eq(teeDynamicPricingModifiersTable.organizationId, orgId));
  await db.delete(teeDynamicPricingTiersTable).where(eq(teeDynamicPricingTiersTable.organizationId, orgId));
  await db.delete(teeDynamicPricingConfigTable).where(eq(teeDynamicPricingConfigTable.organizationId, orgId));
}

/** Seed an org-config + a single active tier + a ring of upcoming slots and
 *  a matching ring of historical booked slots so the forecaster's
 *  utilisation and member/guest mix are deterministic. */
async function seedBaseline(opts?: {
  defaultMemberElasticity?: string | null;
  defaultGuestElasticity?: string | null;
}) {
  await db.insert(teeDynamicPricingConfigTable).values({
    organizationId: orgId, enabled: true,
    priceFloorPct: "0.10", priceCeilingPct: "5.00",
    dealBadgeThresholdPct: "0.85",
    ...(opts?.defaultMemberElasticity ? { defaultMemberElasticity: opts.defaultMemberElasticity } : {}),
    ...(opts?.defaultGuestElasticity ? { defaultGuestElasticity: opts.defaultGuestElasticity } : {}),
  });

  const [tier] = await db.insert(teeDynamicPricingTiersTable).values({
    organizationId: orgId, name: "Baseline",
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    memberType: "any",
    memberRate: String(ACTIVE_MEMBER_RATE),
    guestRate: String(ACTIVE_GUEST_RATE),
    priority: 5, isActive: true,
  }).returning({ id: teeDynamicPricingTiersTable.id });
  baselineTierId = tier.id;

  // Upcoming slots: one per day from +1d to +13d at 10:00 (inside the
  // default 14-day horizon).
  for (let i = 1; i <= 13; i++) {
    await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: dayOffset(i), slotTime: "10:00", capacity: CAPACITY,
    });
  }

  // Historical slots (last ~30d) at the same hour with confirmed bookings
  // sized to lock util = 0.8 and memberShare = 0.7. Spans 14 days so every
  // (DOW, hour=10) bucket is covered — no slot will fall back to the
  // bracket-wide fallbackUtil.
  for (let i = 3; i <= 16; i++) {
    const [s] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: dayOffset(-i), slotTime: "10:00", capacity: CAPACITY,
    }).returning();
    const seatsBooked = Math.round(CAPACITY * HISTORICAL_UTIL); // 8
    const [b] = await db.insert(teeBookingsTable).values({
      slotId: s.id, organizationId: orgId, leadUserId: userId,
      partySize: seatsBooked, status: "confirmed",
      totalAmount: "8000", currency: "INR",
    }).returning({ id: teeBookingsTable.id });
    // 7 members + 3 guests → memberShare 0.7. (We seed all 10 player rows
    // even though partySize=8, since memberShare is computed off the raw
    // player counts not the booking party size — what matters is the ratio.)
    const memberCount = Math.round(CAPACITY * MEMBER_SHARE);     // 7
    const guestCount = CAPACITY - memberCount;                    // 3
    const players: Array<typeof teeBookingPlayersTable.$inferInsert> = [];
    for (let k = 0; k < memberCount; k++) {
      players.push({ bookingId: b.id, playerType: "member", guestName: `M${k}` });
    }
    for (let k = 0; k < guestCount; k++) {
      players.push({ bookingId: b.id, playerType: "guest", guestName: `G${k}` });
    }
    await db.insert(teeBookingPlayersTable).values(players);
  }
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `SegElasticityTest_${stamp}`,
    slug: `seg-elasticity-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `seg-elasticity-${stamp}`,
    username: `seg_elasticity_${stamp}`,
    email: `seg_elasticity_${stamp}@example.com`,
    displayName: "Segment Elasticity Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId, role: "org_admin",
  });

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Segment Elasticity Course",
    slug: `seg-elasticity-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  await db.insert(teePricingRulesTable).values({
    organizationId: orgId,
    memberRate: String(ACTIVE_MEMBER_RATE), guestRate: String(ACTIVE_GUEST_RATE),
  });

  admin = {
    id: userId,
    username: `seg_elasticity_${stamp}`,
    displayName: "Segment Elasticity Admin",
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  if (orgId) {
    await clearFixtures().catch(() => {});
    await db.delete(teePricingRulesTable).where(eq(teePricingRulesTable.organizationId, orgId)).catch(() => {});
    await db.delete(coursesTable).where(eq(coursesTable.id, courseId)).catch(() => {});
    await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId)).catch(() => {});
  }
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId)).catch(() => {});
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId)).catch(() => {});
});

function postForecast(body: object) {
  return request(app)
    .post(`/api/organizations/${orgId}/tee-pricing/forecast`)
    .send(body);
}

// Per-slot estimates the forecaster derives from the pinned fixtures.
const EST_BOOKED = Math.round(CAPACITY * HISTORICAL_UTIL);   // 8
const EST_MEMBER = Math.round(EST_BOOKED * MEMBER_SHARE);    // 6
const EST_GUEST = EST_BOOKED - EST_MEMBER;                   // 2

/** Constant-elasticity model the route applies per segment, mirrored here so
 *  expected values stay readable. */
function expectedDraftSeats(args: {
  pMemRatio: number; pGstRatio: number;
  elasMember: number; elasGuest: number;
}) {
  const capMember = Math.round(CAPACITY * MEMBER_SHARE);     // 7
  const capGuest = CAPACITY - capMember;                      // 3
  const dMem = args.pMemRatio === 1
    ? EST_MEMBER
    : Math.max(0, Math.min(capMember, EST_MEMBER * Math.pow(args.pMemRatio, args.elasMember)));
  const dGst = args.pGstRatio === 1
    ? EST_GUEST
    : Math.max(0, Math.min(capGuest, EST_GUEST * Math.pow(args.pGstRatio, args.elasGuest)));
  return { dMem, dGst, total: Math.min(CAPACITY, dMem + dGst) };
}

// ─── Sanity: pinned fixtures yield the documented per-slot estimates ────────

describe("POST /tee-pricing/forecast — segment elasticity (Task #883)", () => {
  it("baseline: active per-slot booked seats match the seeded utilisation × capacity", async () => {
    await clearFixtures();
    await seedBaseline();

    // No draft tier change → active and draft prices are identical → demand
    // is unaffected by either elasticity, so draft.seatsBooked == active.
    const res = await postForecast({ horizonDays: 14, draft: {} });
    expect(res.status, res.text).toBe(200);
    const active = res.body.active as { seatsBooked: number; slots: number; seatsTotal: number };
    expect(active.slots).toBe(13);
    expect(active.seatsTotal).toBe(13 * CAPACITY);
    expect(active.seatsBooked).toBe(13 * EST_BOOKED);
    const draft = res.body.draft as { seatsBooked: number };
    expect(draft.seatsBooked).toBe(active.seatsBooked);

    const a = res.body.assumptions as { memberShare: number; fallbackUtilization: number };
    expect(a.memberShare).toBeCloseTo(MEMBER_SHARE, 2);
    expect(a.fallbackUtilization).toBeCloseTo(HISTORICAL_UTIL, 2);
  });

  // ── Member-only price bump: draft seats move with memberElasticity only ──

  it("member-only price bump: projected member seats track memberElasticity", async () => {
    await clearFixtures();
    await seedBaseline();

    // Double the member rate; leave guest rate untouched.
    const draft = { tierOverrides: [{ id: baselineTierId, memberRate: ACTIVE_MEMBER_RATE * 2 }] };

    // memberElasticity = -1 → dEstMember = 6 * 2^-1 = 3.
    const r1 = await postForecast({ horizonDays: 14, draft, memberElasticity: -1, guestElasticity: -2 });
    expect(r1.status, r1.text).toBe(200);
    const exp1 = expectedDraftSeats({ pMemRatio: 2, pGstRatio: 1, elasMember: -1, elasGuest: -2 });
    expect((r1.body.draft as { seatsBooked: number }).seatsBooked).toBeCloseTo(13 * exp1.total, 5);

    // memberElasticity = 0 → no demand response → draft seats == active.
    const r2 = await postForecast({ horizonDays: 14, draft, memberElasticity: 0, guestElasticity: -3 });
    expect(r2.status, r2.text).toBe(200);
    const exp2 = expectedDraftSeats({ pMemRatio: 2, pGstRatio: 1, elasMember: 0, elasGuest: -3 });
    expect((r2.body.draft as { seatsBooked: number }).seatsBooked).toBeCloseTo(13 * exp2.total, 5);
    expect((r2.body.draft as { seatsBooked: number }).seatsBooked).toBeCloseTo(
      (r2.body.active as { seatsBooked: number }).seatsBooked, 5,
    );

    // Different memberElasticity values must yield different draft seat
    // counts when the member rate is the only one that moved.
    expect((r1.body.draft as { seatsBooked: number }).seatsBooked)
      .not.toBeCloseTo((r2.body.draft as { seatsBooked: number }).seatsBooked, 1);
  });

  it("member-only price bump: changing guestElasticity does NOT change draft seats", async () => {
    await clearFixtures();
    await seedBaseline();
    const draft = { tierOverrides: [{ id: baselineTierId, memberRate: ACTIVE_MEMBER_RATE * 2 }] };

    // Same memberElasticity, wildly different guestElasticity values.
    const rA = await postForecast({ horizonDays: 14, draft, memberElasticity: -1, guestElasticity: 0 });
    const rB = await postForecast({ horizonDays: 14, draft, memberElasticity: -1, guestElasticity: -3 });
    expect(rA.status, rA.text).toBe(200);
    expect(rB.status, rB.text).toBe(200);
    expect((rA.body.draft as { seatsBooked: number }).seatsBooked)
      .toBeCloseTo((rB.body.draft as { seatsBooked: number }).seatsBooked, 5);
  });

  // ── Guest-only price bump: draft seats move with guestElasticity only ───

  it("guest-only price bump: projected guest seats track guestElasticity", async () => {
    await clearFixtures();
    await seedBaseline();

    const draft = { tierOverrides: [{ id: baselineTierId, guestRate: ACTIVE_GUEST_RATE * 2 }] };

    // guestElasticity = -1 → dEstGuest = 2 * 2^-1 = 1.
    const r1 = await postForecast({ horizonDays: 14, draft, memberElasticity: -2, guestElasticity: -1 });
    expect(r1.status, r1.text).toBe(200);
    const exp1 = expectedDraftSeats({ pMemRatio: 1, pGstRatio: 2, elasMember: -2, elasGuest: -1 });
    expect((r1.body.draft as { seatsBooked: number }).seatsBooked).toBeCloseTo(13 * exp1.total, 5);

    // guestElasticity = 0 → no response → draft == active.
    const r2 = await postForecast({ horizonDays: 14, draft, memberElasticity: -3, guestElasticity: 0 });
    expect(r2.status, r2.text).toBe(200);
    expect((r2.body.draft as { seatsBooked: number }).seatsBooked).toBeCloseTo(
      (r2.body.active as { seatsBooked: number }).seatsBooked, 5,
    );

    expect((r1.body.draft as { seatsBooked: number }).seatsBooked)
      .not.toBeCloseTo((r2.body.draft as { seatsBooked: number }).seatsBooked, 1);
  });

  it("guest-only price bump: changing memberElasticity does NOT change draft seats", async () => {
    await clearFixtures();
    await seedBaseline();
    const draft = { tierOverrides: [{ id: baselineTierId, guestRate: ACTIVE_GUEST_RATE * 2 }] };

    const rA = await postForecast({ horizonDays: 14, draft, memberElasticity: 0, guestElasticity: -1 });
    const rB = await postForecast({ horizonDays: 14, draft, memberElasticity: -3, guestElasticity: -1 });
    expect(rA.status, rA.text).toBe(200);
    expect(rB.status, rB.text).toBe(200);
    expect((rA.body.draft as { seatsBooked: number }).seatsBooked)
      .toBeCloseTo((rB.body.draft as { seatsBooked: number }).seatsBooked, 5);
  });

  // ── Legacy single `elasticity` field is applied to BOTH segments ───────

  it("legacy `elasticity` field still works and is applied to both segments", async () => {
    await clearFixtures();
    await seedBaseline();

    // Bump both rates so each segment has a non-trivial price ratio.
    const draft = {
      tierOverrides: [{
        id: baselineTierId,
        memberRate: ACTIVE_MEMBER_RATE * 2,
        guestRate: ACTIVE_GUEST_RATE * 2,
      }],
    };

    const res = await postForecast({ horizonDays: 14, draft, elasticity: -1 });
    expect(res.status, res.text).toBe(200);

    const a = res.body.assumptions as {
      memberElasticity: number; guestElasticity: number;
      memberElasticitySource: string; guestElasticitySource: string;
      elasticity: number;
    };
    expect(a.memberElasticity).toBeCloseTo(-1, 5);
    expect(a.guestElasticity).toBeCloseTo(-1, 5);
    expect(a.memberElasticitySource).toBe("request_legacy");
    expect(a.guestElasticitySource).toBe("request_legacy");
    expect(a.elasticity).toBeCloseTo(-1, 5);

    // dMem = 6 * 0.5 = 3, dGst = 2 * 0.5 = 1 → draft per slot = 4.
    const exp = expectedDraftSeats({ pMemRatio: 2, pGstRatio: 2, elasMember: -1, elasGuest: -1 });
    expect((res.body.draft as { seatsBooked: number }).seatsBooked).toBeCloseTo(13 * exp.total, 5);
  });

  it("explicit per-segment values WIN over the legacy `elasticity` field when both are sent", async () => {
    await clearFixtures();
    await seedBaseline();
    const draft = {
      tierOverrides: [{
        id: baselineTierId,
        memberRate: ACTIVE_MEMBER_RATE * 2,
        guestRate: ACTIVE_GUEST_RATE * 2,
      }],
    };
    const res = await postForecast({
      horizonDays: 14, draft,
      elasticity: -1, memberElasticity: -0.5, guestElasticity: -2,
    });
    expect(res.status, res.text).toBe(200);
    const a = res.body.assumptions as {
      memberElasticity: number; guestElasticity: number;
      memberElasticitySource: string; guestElasticitySource: string;
    };
    expect(a.memberElasticity).toBeCloseTo(-0.5, 5);
    expect(a.guestElasticity).toBeCloseTo(-2, 5);
    expect(a.memberElasticitySource).toBe("request");
    expect(a.guestElasticitySource).toBe("request");
  });

  // ── Clamping & defaults ────────────────────────────────────────────────

  it("missing values fall back to org defaults (system defaults when no config row sets them)", async () => {
    await clearFixtures();
    await seedBaseline(); // config row has no per-segment elasticity columns set.

    const res = await postForecast({ horizonDays: 14, draft: {} });
    expect(res.status, res.text).toBe(200);
    const a = res.body.assumptions as {
      memberElasticity: number; guestElasticity: number;
      memberElasticitySource: string; guestElasticitySource: string;
    };
    // System defaults documented at the top of tee-pricing.ts.
    expect(a.memberElasticity).toBeCloseTo(-0.2, 2);
    expect(a.guestElasticity).toBeCloseTo(-0.7, 2);
    expect(a.memberElasticitySource).toBe("org_default");
    expect(a.guestElasticitySource).toBe("org_default");
  });

  it("missing values fall back to the org-saved defaults when the config row sets them", async () => {
    await clearFixtures();
    await seedBaseline({ defaultMemberElasticity: "-0.40", defaultGuestElasticity: "-1.10" });
    const res = await postForecast({ horizonDays: 14, draft: {} });
    expect(res.status, res.text).toBe(200);
    const a = res.body.assumptions as { memberElasticity: number; guestElasticity: number };
    expect(a.memberElasticity).toBeCloseTo(-0.4, 2);
    expect(a.guestElasticity).toBeCloseTo(-1.1, 2);
  });

  it("invalid (non-numeric) values fall back to the saved defaults rather than NaN-poisoning the model", async () => {
    await clearFixtures();
    await seedBaseline({ defaultMemberElasticity: "-0.40", defaultGuestElasticity: "-1.10" });
    const res = await postForecast({
      horizonDays: 14, draft: {},
      memberElasticity: "not-a-number", guestElasticity: "abc",
    });
    expect(res.status, res.text).toBe(200);
    const a = res.body.assumptions as { memberElasticity: number; guestElasticity: number };
    // clampElasticity returns the fallback for non-finite input.
    expect(a.memberElasticity).toBeCloseTo(-0.4, 2);
    expect(a.guestElasticity).toBeCloseTo(-1.1, 2);
  });

  it("extreme negative values are clamped to -3", async () => {
    await clearFixtures();
    await seedBaseline();
    const res = await postForecast({
      horizonDays: 14, draft: {},
      memberElasticity: -100, guestElasticity: -50,
    });
    expect(res.status, res.text).toBe(200);
    const a = res.body.assumptions as { memberElasticity: number; guestElasticity: number };
    expect(a.memberElasticity).toBeCloseTo(-3, 5);
    expect(a.guestElasticity).toBeCloseTo(-3, 5);
  });

  it("positive values are clamped to 0 (constant-elasticity demand never increases with price)", async () => {
    await clearFixtures();
    await seedBaseline();
    const res = await postForecast({
      horizonDays: 14, draft: {},
      memberElasticity: 5, guestElasticity: 2.5,
    });
    expect(res.status, res.text).toBe(200);
    const a = res.body.assumptions as { memberElasticity: number; guestElasticity: number };
    expect(a.memberElasticity).toBeCloseTo(0, 5);
    expect(a.guestElasticity).toBeCloseTo(0, 5);
  });

  it("invalid legacy `elasticity` does NOT collapse both segments to the member default", async () => {
    // Regression guard for the documented bug at tee-pricing.ts:543-546:
    // an unparseable legacy field must NOT silently apply the member default
    // to the guest segment.
    await clearFixtures();
    await seedBaseline({ defaultMemberElasticity: "-0.30", defaultGuestElasticity: "-1.00" });
    const res = await postForecast({ horizonDays: 14, draft: {}, elasticity: "garbage" });
    expect(res.status, res.text).toBe(200);
    const a = res.body.assumptions as {
      memberElasticity: number; guestElasticity: number;
      memberElasticitySource: string; guestElasticitySource: string;
    };
    expect(a.memberElasticity).toBeCloseTo(-0.3, 2);
    expect(a.guestElasticity).toBeCloseTo(-1.0, 2);
    expect(a.memberElasticitySource).toBe("org_default");
    expect(a.guestElasticitySource).toBe("org_default");
  });
});
