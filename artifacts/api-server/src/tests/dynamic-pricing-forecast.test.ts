/**
 * Tests for the Dynamic Pricing forecast endpoint — Task #664.
 *
 * Covers `POST /organizations/:orgId/tee-pricing/forecast` in
 * `artifacts/api-server/src/routes/tee-pricing.ts`. The endpoint blends
 * the live production pricing context with a draft overlay (full tier
 * replacement, per-id tier overrides, ephemeral additions, modifier
 * replacement, and config overrides), simulates upcoming slots against a
 * historical demand signal, and produces active-vs-draft revenue and
 * average-price deltas. These tests exercise the documented draft
 * shapes and verify the numbers move in the expected direction.
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

function dayOffset(days: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}

async function clearForecastFixtures() {
  // Bookings (and players via cascade) first, then slots.
  const bookings = await db.select({ id: teeBookingsTable.id })
    .from(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
  for (const b of bookings) {
    await db.delete(teeBookingPlayersTable).where(eq(teeBookingPlayersTable.bookingId, b.id));
  }
  await db.delete(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
  await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.organizationId, orgId));
  await db.delete(teeDynamicPricingAuditTable).where(eq(teeDynamicPricingAuditTable.organizationId, orgId));
  await db.delete(teeDynamicPricingCourseElasticityTable).where(eq(teeDynamicPricingCourseElasticityTable.organizationId, orgId));
  await db.delete(teeDynamicPricingTiersTable).where(eq(teeDynamicPricingTiersTable.organizationId, orgId));
  await db.delete(teeDynamicPricingModifiersTable).where(eq(teeDynamicPricingModifiersTable.organizationId, orgId));
}

/** Seed a baseline production state — config + a single active tier — and
 *  a ring of upcoming + historical slots so the forecaster has something to
 *  chew on. Returns the active tier id so tests can patch it. */
async function seedBaseline(opts?: { ceilingPct?: string; floorPct?: string }) {
  await db.insert(teeDynamicPricingConfigTable).values({
    organizationId: orgId, enabled: true,
    priceFloorPct: opts?.floorPct ?? "0.50",
    priceCeilingPct: opts?.ceilingPct ?? "2.00",
    dealBadgeThresholdPct: "0.85",
  }).onConflictDoUpdate({
    target: teeDynamicPricingConfigTable.organizationId,
    set: {
      enabled: true,
      priceFloorPct: opts?.floorPct ?? "0.50",
      priceCeilingPct: opts?.ceilingPct ?? "2.00",
      dealBadgeThresholdPct: "0.85",
      updatedAt: new Date(),
    },
  });

  const [tier] = await db.insert(teeDynamicPricingTiersTable).values({
    organizationId: orgId,
    name: "Baseline",
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    memberType: "any",
    memberRate: "1000",
    guestRate: "1500",
    priority: 5,
    isActive: true,
  }).returning({ id: teeDynamicPricingTiersTable.id });
  baselineTierId = tier.id;

  // Upcoming slots: one per day from +1d to +29d at 10:00, capacity 4.
  // horizon=14 → days +1..+13 fall inside (13 slots).
  // horizon=30 → days +1..+29 fall inside (29 slots).
  for (let i = 1; i <= 29; i++) {
    await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: dayOffset(i), slotTime: "10:00", capacity: 4,
    });
  }

  // Historical slots in the last ~30 days with confirmed bookings so the
  // forecaster's fallback utilisation lands near 0.75 (3 of 4 seats booked).
  for (let i = 3; i <= 10; i++) {
    const [s] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: dayOffset(-i), slotTime: "10:00", capacity: 4,
    }).returning();
    await db.insert(teeBookingsTable).values({
      slotId: s.id, organizationId: orgId, leadUserId: userId,
      partySize: 3, status: "confirmed",
      totalAmount: "3000", currency: "INR",
    });
  }
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `DynPricingForecastTest_${stamp}`,
    slug: `dyn-pricing-forecast-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `dyn-pricing-forecast-${stamp}`,
    username: `dyn_pricing_forecast_${stamp}`,
    email: `dyn_pricing_forecast_${stamp}@example.com`,
    displayName: "Dyn Pricing Forecast Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId, role: "org_admin",
  });

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Forecast Test Course",
    slug: `forecast-test-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  await db.insert(teePricingRulesTable).values({
    organizationId: orgId, memberRate: "1000", guestRate: "1500",
  });

  admin = {
    id: userId,
    username: `dyn_pricing_forecast_${stamp}`,
    displayName: "Dyn Pricing Forecast Admin",
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  if (orgId) {
    const leftover = await db.select({ id: teeBookingsTable.id })
      .from(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
    for (const b of leftover) {
      await db.delete(teeBookingPlayersTable).where(eq(teeBookingPlayersTable.bookingId, b.id));
    }
    await db.delete(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
    await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.organizationId, orgId));
  }
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function postForecast(body: object) {
  return request(app)
    .post(`/api/organizations/${orgId}/tee-pricing/forecast`)
    .send(body);
}

function expectForecastShape(body: Record<string, unknown>) {
  expect(body.active).toBeDefined();
  expect(body.draft).toBeDefined();
  expect(body.delta).toBeDefined();
  expect(body.assumptions).toBeDefined();
  expect(Array.isArray(body.daily)).toBe(true);
  for (const k of ["revenue", "seatsBooked", "seatsTotal", "slots", "avgPrice", "utilizationPct"]) {
    expect((body.active as Record<string, number>)[k]).toBeDefined();
    expect((body.draft as Record<string, number>)[k]).toBeDefined();
  }
}

// ─── draft.tiers full replacement ────────────────────────────────────────────

describe("POST /tee-pricing/forecast — draft.tiers full replacement", () => {
  it("returns active/draft/delta blocks and increases draft revenue when the new tier is materially higher", async () => {
    await clearForecastFixtures();
    await seedBaseline();

    const res = await postForecast({
      horizonDays: 14,
      draft: {
        tiers: [{
          name: "Premium",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          memberType: "any",
          memberRate: 2000,
          guestRate: 2500,
          priority: 5,
          isActive: true,
        }],
      },
    });
    expect(res.status, res.text).toBe(200);
    expectForecastShape(res.body);

    const active = res.body.active as { revenue: number; avgPrice: number; slots: number };
    const draft = res.body.draft as { revenue: number; avgPrice: number };
    const delta = res.body.delta as { revenue: number; avgPrice: number };

    expect(active.slots).toBeGreaterThan(0);
    expect(active.revenue).toBeGreaterThan(0);
    // Premium tier nearly doubles per-seat prices; even after elastic demand
    // damping, draft revenue should clearly exceed the active baseline.
    expect(draft.revenue).toBeGreaterThan(active.revenue);
    expect(draft.avgPrice).toBeGreaterThan(active.avgPrice);
    expect(delta.revenue).toBeGreaterThan(0);
    expect(delta.avgPrice).toBeGreaterThan(0);
  });

  it("decreases draft revenue when the new tier is materially lower", async () => {
    await clearForecastFixtures();
    await seedBaseline();

    const res = await postForecast({
      horizonDays: 14,
      draft: {
        tiers: [{
          name: "Discount",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          memberType: "any",
          memberRate: 400,
          guestRate: 600,
          priority: 5,
          isActive: true,
        }],
      },
    });
    expect(res.status, res.text).toBe(200);
    const active = res.body.active as { revenue: number };
    const draft = res.body.draft as { revenue: number };
    const delta = res.body.delta as { revenue: number };
    expect(draft.revenue).toBeLessThan(active.revenue);
    expect(delta.revenue).toBeLessThan(0);
  });
});

// ─── draft.tierOverrides ─────────────────────────────────────────────────────

describe("POST /tee-pricing/forecast — draft.tierOverrides", () => {
  it("patches an existing tier by id and reflects the new rates in draft revenue", async () => {
    await clearForecastFixtures();
    await seedBaseline();

    const res = await postForecast({
      horizonDays: 14,
      draft: {
        tierOverrides: [{
          id: baselineTierId,
          memberRate: 1800,
          guestRate: 2200,
        }],
      },
    });
    expect(res.status, res.text).toBe(200);
    const active = res.body.active as { revenue: number };
    const draft = res.body.draft as { revenue: number };
    expect(draft.revenue).toBeGreaterThan(active.revenue);
    expect((res.body.delta as { revenue: number }).revenue).toBeGreaterThan(0);
  });

  it("adds an ephemeral tier (no id) and lets it influence draft revenue when it wins on priority", async () => {
    await clearForecastFixtures();
    await seedBaseline();

    const res = await postForecast({
      horizonDays: 14,
      draft: {
        tierOverrides: [{
          name: "Ephemeral peak",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          memberType: "any",
          memberRate: 2400,
          guestRate: 2800,
          priority: 99,
          isActive: true,
        }],
      },
    });
    expect(res.status, res.text).toBe(200);
    const active = res.body.active as { revenue: number; avgPrice: number };
    const draft = res.body.draft as { revenue: number; avgPrice: number };
    expect(draft.avgPrice).toBeGreaterThan(active.avgPrice);
    expect(draft.revenue).toBeGreaterThan(active.revenue);
  });
});

// ─── draft.config overrides (tighter ceiling) ────────────────────────────────

describe("POST /tee-pricing/forecast — draft.config overrides", () => {
  it("clamps draft prices when the draft ceiling is tightened, lowering draft revenue", async () => {
    await clearForecastFixtures();
    // Active config has a generous 2.0× ceiling. Add a modifier that
    // pushes price 200% above the tier rate so the cap actually binds.
    await seedBaseline({ ceilingPct: "2.00", floorPct: "0.50" });
    await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId,
      name: "Always-on surge",
      kind: "utilization",
      thresholdMin: "0",
      thresholdMax: "2",
      adjustmentType: "percent",
      adjustmentValue: "200",
      applyTo: "any",
      priority: 1,
      isActive: true,
    });

    // Tighten only the draft ceiling. The draft tier set is unchanged
    // (omit draft.tiers / draft.tierOverrides) so the only difference
    // between active and draft is the cap.
    const res = await postForecast({
      horizonDays: 14,
      draft: { config: { priceCeilingPct: "1.20" } },
    });
    expect(res.status, res.text).toBe(200);
    const active = res.body.active as { revenue: number; avgPrice: number };
    const draft = res.body.draft as { revenue: number; avgPrice: number };
    expect(active.revenue).toBeGreaterThan(0);
    // The tighter cap clamps draft prices below the active (2.0×) cap →
    // draft per-seat price and revenue should both shrink.
    expect(draft.avgPrice).toBeLessThan(active.avgPrice);
    expect(draft.revenue).toBeLessThan(active.revenue);
    expect((res.body.delta as { revenue: number }).revenue).toBeLessThan(0);
  });
});

// ─── horizonDays widening ────────────────────────────────────────────────────

describe("POST /tee-pricing/forecast — horizonDays", () => {
  it("widens assumptions.slotsConsidered when horizon switches from 14 to 30 days", async () => {
    await clearForecastFixtures();
    await seedBaseline();

    const r14 = await postForecast({ horizonDays: 14, draft: {} });
    expect(r14.status, r14.text).toBe(200);
    const r30 = await postForecast({ horizonDays: 30, draft: {} });
    expect(r30.status, r30.text).toBe(200);

    const slots14 = (r14.body.assumptions as { slotsConsidered: number }).slotsConsidered;
    const slots30 = (r30.body.assumptions as { slotsConsidered: number }).slotsConsidered;
    expect(slots14).toBeGreaterThan(0);
    expect(slots30).toBeGreaterThan(slots14);
    expect((r14.body.assumptions as { historicalSampleDays: number }).historicalSampleDays).toBe(90);
  });
});

// ─── Task #822 — saved & per-course elasticity ───────────────────────────────

/** Helper: change only the price (via a higher-priority draft tier) and
 *  return the elasticity assumptions the forecaster reports back. The whole
 *  point of this section is to verify which elasticity number the endpoint
 *  picks up when the request omits an explicit one. */
async function priceBumpForecast(courseIdInBody: number | null) {
  const body: Record<string, unknown> = {
    horizonDays: 14,
    draft: {
      tierOverrides: [{
        id: baselineTierId,
        memberRate: 1500,
        guestRate: 2200,
      }],
    },
  };
  if (courseIdInBody != null) body.courseId = courseIdInBody;
  return postForecast(body);
}

describe("POST /tee-pricing/forecast — saved elasticity fallback (Task #822)", () => {
  it("falls back to the org-saved per-segment elasticity when the request omits one", async () => {
    await clearForecastFixtures();
    await seedBaseline();
    // Persist a non-default org elasticity for both segments.
    await db.update(teeDynamicPricingConfigTable)
      .set({ defaultMemberElasticity: "-0.40", defaultGuestElasticity: "-1.20", updatedAt: new Date() })
      .where(eq(teeDynamicPricingConfigTable.organizationId, orgId));

    const res = await priceBumpForecast(null);
    expect(res.status, res.text).toBe(200);
    const a = res.body.assumptions as {
      memberElasticity: number;
      guestElasticity: number;
      memberElasticitySource: string;
      guestElasticitySource: string;
    };
    expect(a.memberElasticity).toBeCloseTo(-0.4, 2);
    expect(a.guestElasticity).toBeCloseTo(-1.2, 2);
    expect(a.memberElasticitySource).toBe("org_default");
    expect(a.guestElasticitySource).toBe("org_default");
  });

  it("still honours an explicit body.memberElasticity over the saved org default", async () => {
    await clearForecastFixtures();
    await seedBaseline();
    await db.update(teeDynamicPricingConfigTable)
      .set({ defaultMemberElasticity: "-0.40", defaultGuestElasticity: "-1.20", updatedAt: new Date() })
      .where(eq(teeDynamicPricingConfigTable.organizationId, orgId));

    const res = await postForecast({
      horizonDays: 14,
      memberElasticity: -0.05,
      draft: { tierOverrides: [{ id: baselineTierId, memberRate: 1500, guestRate: 2200 }] },
    });
    expect(res.status, res.text).toBe(200);
    const a = res.body.assumptions as {
      memberElasticity: number; guestElasticity: number;
      memberElasticitySource: string; guestElasticitySource: string;
    };
    expect(a.memberElasticity).toBeCloseTo(-0.05, 2);
    // Guest still inherits from org default since no body override.
    expect(a.guestElasticity).toBeCloseTo(-1.2, 2);
    expect(a.memberElasticitySource).toBe("request");
    expect(a.guestElasticitySource).toBe("org_default");
  });
});

describe("POST /tee-pricing/forecast — per-course elasticity override (Task #822)", () => {
  it("uses the per-course override in preference to the org default when courseId is set", async () => {
    await clearForecastFixtures();
    await seedBaseline();
    await db.update(teeDynamicPricingConfigTable)
      .set({ defaultMemberElasticity: "-0.20", defaultGuestElasticity: "-0.70", updatedAt: new Date() })
      .where(eq(teeDynamicPricingConfigTable.organizationId, orgId));
    // Course-specific override — much more elastic on both segments.
    await db.insert(teeDynamicPricingCourseElasticityTable).values({
      organizationId: orgId, courseId,
      memberElasticity: "-1.50", guestElasticity: "-2.10",
    });

    const res = await priceBumpForecast(courseId);
    expect(res.status, res.text).toBe(200);
    const a = res.body.assumptions as {
      memberElasticity: number; guestElasticity: number;
      memberElasticitySource: string; guestElasticitySource: string;
    };
    expect(a.memberElasticity).toBeCloseTo(-1.5, 2);
    expect(a.guestElasticity).toBeCloseTo(-2.1, 2);
    expect(a.memberElasticitySource).toBe("course_override");
    expect(a.guestElasticitySource).toBe("course_override");
  });

  it("inherits the org default for any segment whose override column is NULL", async () => {
    await clearForecastFixtures();
    await seedBaseline();
    await db.update(teeDynamicPricingConfigTable)
      .set({ defaultMemberElasticity: "-0.30", defaultGuestElasticity: "-0.90", updatedAt: new Date() })
      .where(eq(teeDynamicPricingConfigTable.organizationId, orgId));
    // Override only the guest segment for this course.
    await db.insert(teeDynamicPricingCourseElasticityTable).values({
      organizationId: orgId, courseId,
      memberElasticity: null, guestElasticity: "-1.80",
    });

    const res = await priceBumpForecast(courseId);
    expect(res.status, res.text).toBe(200);
    const a = res.body.assumptions as {
      memberElasticity: number; guestElasticity: number;
      memberElasticitySource: string; guestElasticitySource: string;
    };
    expect(a.memberElasticity).toBeCloseTo(-0.3, 2); // inherits org default
    expect(a.guestElasticity).toBeCloseTo(-1.8, 2);  // course override
    expect(a.memberElasticitySource).toBe("org_default");
    expect(a.guestElasticitySource).toBe("course_override");
  });

  it("ignores per-course overrides when the forecast is org-wide (no courseId)", async () => {
    await clearForecastFixtures();
    await seedBaseline();
    await db.update(teeDynamicPricingConfigTable)
      .set({ defaultMemberElasticity: "-0.25", defaultGuestElasticity: "-0.65", updatedAt: new Date() })
      .where(eq(teeDynamicPricingConfigTable.organizationId, orgId));
    await db.insert(teeDynamicPricingCourseElasticityTable).values({
      organizationId: orgId, courseId,
      memberElasticity: "-2.50", guestElasticity: "-2.50",
    });

    const res = await priceBumpForecast(null);
    expect(res.status, res.text).toBe(200);
    const a = res.body.assumptions as {
      memberElasticity: number; guestElasticity: number;
      memberElasticitySource: string;
    };
    // Without courseId, the per-course override row is ignored.
    expect(a.memberElasticity).toBeCloseTo(-0.25, 2);
    expect(a.guestElasticity).toBeCloseTo(-0.65, 2);
    expect(a.memberElasticitySource).toBe("org_default");
  });
});

// ─── Task #822 — admin CRUD on per-course overrides ──────────────────────────

describe("Per-course elasticity admin endpoints (Task #822)", () => {
  it("PUT upserts an override, GET lists it, and DELETE removes it (with clamping + audit)", async () => {
    await clearForecastFixtures();
    await seedBaseline();

    // PUT clamps out-of-range values to [-3, 0].
    const putRes = await request(app)
      .put(`/api/organizations/${orgId}/tee-pricing/course-elasticity/${courseId}`)
      .send({ memberElasticity: -99, guestElasticity: 5 });
    expect(putRes.status, putRes.text).toBe(200);
    expect(parseFloat(putRes.body.memberElasticity)).toBeCloseTo(-3, 2);
    expect(parseFloat(putRes.body.guestElasticity)).toBeCloseTo(0, 2);

    // GET surfaces the row.
    const listRes = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/course-elasticity`);
    expect(listRes.status, listRes.text).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].courseId).toBe(courseId);

    // PUT again with explicit nulls clears one segment back to "inherit".
    const clearRes = await request(app)
      .put(`/api/organizations/${orgId}/tee-pricing/course-elasticity/${courseId}`)
      .send({ memberElasticity: null, guestElasticity: -0.55 });
    expect(clearRes.status, clearRes.text).toBe(200);
    expect(clearRes.body.memberElasticity).toBeNull();
    expect(parseFloat(clearRes.body.guestElasticity)).toBeCloseTo(-0.55, 2);

    // Audit row was written on the upsert path.
    const auditRows = await db.select().from(teeDynamicPricingAuditTable)
      .where(eq(teeDynamicPricingAuditTable.organizationId, orgId));
    const audit = auditRows.find(a => a.entityType === "course_elasticity");
    expect(audit).toBeDefined();
    expect(audit!.entityId).toBe(courseId);

    // DELETE removes it.
    const delRes = await request(app)
      .delete(`/api/organizations/${orgId}/tee-pricing/course-elasticity/${courseId}`);
    expect(delRes.status, delRes.text).toBe(200);
    const afterDelete = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/course-elasticity`);
    expect(afterDelete.body).toHaveLength(0);
  });
});
