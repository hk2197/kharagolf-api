/**
 * Tests for the Dynamic Pricing forecast-accuracy endpoint — Task #821.
 *
 * Covers `GET /organizations/:orgId/tee-pricing/forecast-accuracy` plus the
 * persistence side of `POST /organizations/:orgId/tee-pricing/forecast`.
 *
 * The flow under test: a forecast is recorded with projected revenue and a
 * date window, the actual realised bookings are seeded for that window, and
 * the accuracy endpoint is expected to compute the right error %, accuracy
 * %, and bucket (high / medium / low).
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
  teeDynamicPricingAuditTable,
  teePricingForecastsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let userId: number;
let courseId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

function dayOffset(days: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}
function dateStr(days: number): string {
  return dayOffset(days).toISOString().split("T")[0];
}

async function clearFixtures() {
  const bookings = await db.select({ id: teeBookingsTable.id })
    .from(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
  for (const b of bookings) {
    await db.delete(teeBookingPlayersTable).where(eq(teeBookingPlayersTable.bookingId, b.id));
  }
  await db.delete(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
  await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.organizationId, orgId));
  await db.delete(teePricingForecastsTable).where(eq(teePricingForecastsTable.organizationId, orgId));
  await db.delete(teeDynamicPricingAuditTable).where(eq(teeDynamicPricingAuditTable.organizationId, orgId));
  await db.delete(teeDynamicPricingTiersTable).where(eq(teeDynamicPricingTiersTable.organizationId, orgId));
  await db.delete(teeDynamicPricingModifiersTable).where(eq(teeDynamicPricingModifiersTable.organizationId, orgId));
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `ForecastAccuracyTest_${stamp}`,
    slug: `forecast-accuracy-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `forecast-accuracy-${stamp}`,
    username: `forecast_accuracy_${stamp}`,
    email: `forecast_accuracy_${stamp}@example.com`,
    displayName: "Forecast Accuracy Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId, role: "org_admin",
  });

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Forecast Accuracy Course",
    slug: `forecast-accuracy-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  await db.insert(teePricingRulesTable).values({
    organizationId: orgId, memberRate: "1000", guestRate: "1500",
  });

  admin = {
    id: userId,
    username: `forecast_accuracy_${stamp}`,
    displayName: "Forecast Accuracy Admin",
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
    await db.delete(teePricingForecastsTable).where(eq(teePricingForecastsTable.organizationId, orgId));
  }
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

/**
 * Seed a completed forecast window: a stored forecast row whose
 * windowStart/windowEnd lie entirely in the past, plus a configurable
 * amount of realised booking revenue inside that window.
 *
 * `projected` is the forecast's projected revenue; `actualRevenue` is the
 * sum of seeded confirmed booking totals so we can dial in the accuracy
 * bucket the test wants to land in.
 */
async function seedCompletedForecast(opts: {
  projected: number;
  actualRevenue: number;
  partySize?: number;
  scenario?: "active" | "draft";
}) {
  const windowStart = dateStr(-30);
  const windowEnd = dateStr(-1); // window ended yesterday — fully in past
  await db.insert(teePricingForecastsTable).values({
    organizationId: orgId,
    courseId,
    actorUserId: userId,
    scenario: opts.scenario ?? "active",
    label: "test-forecast",
    horizonDays: 30,
    windowStart,
    windowEnd,
    projectedRevenue: opts.projected.toFixed(2),
    projectedAvgPrice: "0",
    projectedSeatsBooked: 0,
    projectedSeatsTotal: 0,
    assumptions: { historicalSampleDays: 90 },
  });
  // Seed one slot inside the window with the desired booking revenue.
  if (opts.actualRevenue > 0) {
    const [s] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: dayOffset(-15), slotTime: "10:00", capacity: 4,
    }).returning();
    await db.insert(teeBookingsTable).values({
      slotId: s.id, organizationId: orgId, leadUserId: userId,
      partySize: opts.partySize ?? 3, status: "confirmed",
      totalAmount: opts.actualRevenue.toFixed(2), currency: "INR",
    });
  }
}

describe("GET /tee-pricing/forecast-accuracy", () => {
  it("returns a high-accuracy bucket when projection matches actual revenue closely", async () => {
    await clearFixtures();
    // Projected 10000, actual 9800 → error -200/9800 ≈ -2.04% → accuracy ≈ 97.96% (high).
    await seedCompletedForecast({ projected: 10000, actualRevenue: 9800 });

    const res = await request(app).get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy`);
    expect(res.status, res.text).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows.length).toBe(1);
    const row = res.body.rows[0];
    expect(row.status).toBe("complete");
    expect(row.projectedRevenue).toBeCloseTo(10000, 1);
    expect(row.actualRevenue).toBeCloseTo(9800, 1);
    expect(row.accuracyPct).toBeGreaterThanOrEqual(95);
    expect(row.accuracyBucket).toBe("high");
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.bucketCounts.high).toBe(1);
  });

  it("returns a low-accuracy bucket when projection is wildly off", async () => {
    await clearFixtures();
    // Projected 10000, actual 3000 → error 7000/3000 ≈ 233% → accuracy = 0% (low).
    await seedCompletedForecast({ projected: 10000, actualRevenue: 3000 });

    const res = await request(app).get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy`);
    expect(res.status, res.text).toBe(200);
    const row = res.body.rows[0];
    expect(row.accuracyBucket).toBe("low");
    expect(row.accuracyPct).toBeLessThan(70);
    expect(res.body.summary.bucketCounts.low).toBe(1);
  });

  it("hits a medium-accuracy bucket on a moderately-off projection", async () => {
    await clearFixtures();
    // Projected 10000, actual 8000 → error 2000/8000 = 25% → accuracy 75% (medium).
    await seedCompletedForecast({ projected: 10000, actualRevenue: 8000 });

    const res = await request(app).get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy`);
    expect(res.status, res.text).toBe(200);
    const row = res.body.rows[0];
    expect(row.accuracyBucket).toBe("medium");
    expect(row.accuracyPct).toBeGreaterThanOrEqual(70);
    expect(row.accuracyPct).toBeLessThan(85);
  });

  it("treats a non-zero projection with zero realised revenue as a low-bucket 0% accuracy miss", async () => {
    await clearFixtures();
    // Projected 5000, actual 0 (no bookings seeded) → worst-case miss.
    await seedCompletedForecast({ projected: 5000, actualRevenue: 0 });

    const res = await request(app).get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.rows.length).toBe(1);
    const row = res.body.rows[0];
    expect(row.actualRevenue).toBe(0);
    expect(row.projectedRevenue).toBeCloseTo(5000, 1);
    expect(row.accuracyPct).toBe(0);
    expect(row.accuracyBucket).toBe("low");
    expect(res.body.summary.bucketCounts.low).toBe(1);
    expect(res.body.summary.sampleSize).toBe(1);
  });

  it("filters forecasts by exact label when ?label= is provided (Task #1258)", async () => {
    await clearFixtures();
    // Three completed forecasts, each with a different publish-snapshot label.
    // The endpoint should return only the row matching the requested label.
    await db.insert(teePricingForecastsTable).values([
      {
        organizationId: orgId, courseId, actorUserId: userId,
        scenario: "active", label: "publish:tier-101", horizonDays: 14,
        windowStart: dateStr(-30), windowEnd: dateStr(-1),
        projectedRevenue: "10000.00", projectedAvgPrice: "0",
        projectedSeatsBooked: 0, projectedSeatsTotal: 0, assumptions: {},
      },
      {
        organizationId: orgId, courseId, actorUserId: userId,
        scenario: "active", label: "publish:tier-202", horizonDays: 14,
        windowStart: dateStr(-30), windowEnd: dateStr(-1),
        projectedRevenue: "20000.00", projectedAvgPrice: "0",
        projectedSeatsBooked: 0, projectedSeatsTotal: 0, assumptions: {},
      },
      {
        organizationId: orgId, courseId, actorUserId: userId,
        scenario: "active", label: "publish:modifier-9", horizonDays: 14,
        windowStart: dateStr(-30), windowEnd: dateStr(-1),
        projectedRevenue: "30000.00", projectedAvgPrice: "0",
        projectedSeatsBooked: 0, projectedSeatsTotal: 0, assumptions: {},
      },
    ]);

    const filtered = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy?label=publish:tier-101`);
    expect(filtered.status, filtered.text).toBe(200);
    expect(filtered.body.rows.length).toBe(1);
    expect(filtered.body.rows[0].label).toBe("publish:tier-101");
    expect(filtered.body.rows[0].projectedRevenue).toBeCloseTo(10000, 1);

    const modOnly = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy?label=publish:modifier-9`);
    expect(modOnly.status).toBe(200);
    expect(modOnly.body.rows.length).toBe(1);
    expect(modOnly.body.rows[0].label).toBe("publish:modifier-9");

    // Sanity check: omitting the filter still returns all three rows.
    const all = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy`);
    expect(all.status).toBe(200);
    expect(all.body.rows.length).toBe(3);

    // Unknown label → empty rows, not an error.
    const empty = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy?label=publish:tier-999`);
    expect(empty.status).toBe(200);
    expect(empty.body.rows.length).toBe(0);
  });

  // Task #1809 — multi-course coverage. The list handler builds
  // `courseClause` differently depending on whether each forecast row was
  // scoped to a single course or to the org as a whole. The single-course
  // branch is exercised by the tests above (which seed only one course);
  // the following tests seed two courses in the same org with bookings on
  // overlapping days and assert both branches independently. Mirrors the
  // multi-course coverage added to the drill-down endpoint in #1475.
  describe("multi-course branches", () => {
    let secondCourseId: number;

    beforeAll(async () => {
      const [c2] = await db.insert(coursesTable).values({
        organizationId: orgId,
        name: "Forecast Accuracy Course Two",
        slug: `forecast-accuracy-course-two-${stamp}`,
      }).returning({ id: coursesTable.id });
      secondCourseId = c2.id;
    });

    async function seedBookingOnDay(
      targetCourseId: number,
      dayOffsetN: number,
      revenue: number,
      slotTime: string,
    ) {
      const [s] = await db.insert(courseTeeSlotTable).values({
        courseId: targetCourseId, organizationId: orgId,
        slotDate: dayOffset(dayOffsetN), slotTime, capacity: 4,
      }).returning();
      await db.insert(teeBookingsTable).values({
        slotId: s.id, organizationId: orgId, leadUserId: userId,
        partySize: 3, status: "confirmed",
        totalAmount: revenue.toFixed(2), currency: "INR",
      });
    }

    async function insertListForecast(opts: {
      courseId: number | null;
      windowStart: string;
      windowEnd: string;
      horizonDays: number;
      projectedRevenue: number;
      label: string;
    }) {
      await db.insert(teePricingForecastsTable).values({
        organizationId: orgId,
        courseId: opts.courseId ?? undefined,
        actorUserId: userId,
        scenario: "active",
        label: opts.label,
        horizonDays: opts.horizonDays,
        windowStart: opts.windowStart,
        windowEnd: opts.windowEnd,
        projectedRevenue: opts.projectedRevenue.toFixed(2),
        projectedAvgPrice: "0",
        projectedSeatsBooked: 0,
        projectedSeatsTotal: 0,
        assumptions: { historicalSampleDays: 90 },
      });
    }

    it("course-scoped list row only counts bookings from the named course", async () => {
      await clearFixtures();
      // Forecast scoped to course-1 over a 3-day past window.
      await insertListForecast({
        courseId, windowStart: dateStr(-6), windowEnd: dateStr(-3),
        horizonDays: 3, projectedRevenue: 3000,
        label: "test-list-course1",
      });
      // Overlapping bookings on the same days for both courses; only
      // course-1's revenue should be summed into the list row.
      await seedBookingOnDay(courseId, -6, 700, "10:00");
      await seedBookingOnDay(secondCourseId, -6, 9999, "11:00");
      await seedBookingOnDay(courseId, -5, 400, "10:00");
      await seedBookingOnDay(secondCourseId, -5, 8888, "11:00");
      await seedBookingOnDay(secondCourseId, -4, 7777, "11:00");

      const res = await request(app)
        .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy`);
      expect(res.status, res.text).toBe(200);
      expect(res.body.rows.length).toBe(1);
      const row = res.body.rows[0];
      expect(row.courseId).toBe(courseId);
      // Only course-1 bookings: 700 + 400 = 1100. Course-2's 26,664 is
      // intentionally excluded by the courseClause filter.
      expect(row.actualRevenue).toBeCloseTo(1100, 1);
      // 2 bookings × partySize 3 = 6 seats.
      expect(row.actualSeatsBooked).toBe(6);
    });

    it("org-wide list row (no courseId) sums bookings across every course in the club", async () => {
      await clearFixtures();
      // Org-wide forecast: courseId is null, so the handler must aggregate
      // bookings from every course in the org.
      await insertListForecast({
        courseId: null, windowStart: dateStr(-6), windowEnd: dateStr(-3),
        horizonDays: 3, projectedRevenue: 3000,
        label: "test-list-orgwide",
      });
      // Overlapping bookings on the same day across both courses must
      // add up in the row's actualRevenue.
      await seedBookingOnDay(courseId, -6, 700, "10:00");
      await seedBookingOnDay(secondCourseId, -6, 300, "11:00");
      await seedBookingOnDay(courseId, -5, 400, "10:00");
      await seedBookingOnDay(secondCourseId, -5, 600, "11:00");
      await seedBookingOnDay(secondCourseId, -4, 250, "11:00");

      const res = await request(app)
        .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy`);
      expect(res.status, res.text).toBe(200);
      expect(res.body.rows.length).toBe(1);
      const row = res.body.rows[0];
      expect(row.courseId).toBeNull();
      // Sum across both courses: 700+300+400+600+250 = 2250.
      expect(row.actualRevenue).toBeCloseTo(2250, 1);
      // 5 bookings × partySize 3 = 15 seats.
      expect(row.actualSeatsBooked).toBe(15);
    });
  });

  it("excludes forecasts whose window has not ended unless includePending=true", async () => {
    await clearFixtures();
    // Pending forecast: window straddles the future.
    await db.insert(teePricingForecastsTable).values({
      organizationId: orgId, courseId, actorUserId: userId,
      scenario: "active", horizonDays: 14,
      windowStart: dateStr(0), windowEnd: dateStr(14),
      projectedRevenue: "5000.00", projectedAvgPrice: "0",
      projectedSeatsBooked: 0, projectedSeatsTotal: 0,
      assumptions: {},
    });

    const r1 = await request(app).get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy`);
    expect(r1.status).toBe(200);
    expect(r1.body.rows.length).toBe(0);

    const r2 = await request(app).get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy?includePending=true`);
    expect(r2.status).toBe(200);
    expect(r2.body.rows.length).toBe(1);
    expect(r2.body.rows[0].status).toBe("pending");
    expect(r2.body.rows[0].accuracyPct).toBeNull();
  });
});

describe("POST /tee-pricing/forecast — persistence", () => {
  it("records the active scenario as a forecast snapshot row", async () => {
    await clearFixtures();
    // Need a baseline tier + at least one upcoming slot so the forecast handler runs.
    await db.insert(teeDynamicPricingConfigTable).values({
      organizationId: orgId, enabled: true,
    }).onConflictDoUpdate({
      target: teeDynamicPricingConfigTable.organizationId,
      set: { enabled: true, updatedAt: new Date() },
    });
    await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId, name: "Persist test",
      daysOfWeek: [0,1,2,3,4,5,6], memberType: "any",
      memberRate: "1000", guestRate: "1500", priority: 5, isActive: true,
    });
    for (let i = 1; i <= 5; i++) {
      await db.insert(courseTeeSlotTable).values({
        courseId, organizationId: orgId,
        slotDate: dayOffset(i), slotTime: "10:00", capacity: 4,
      });
    }

    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/forecast`)
      .send({ horizonDays: 14, draft: {} });
    expect(res.status, res.text).toBe(200);
    expect(typeof res.body.forecastId).toBe("number");

    const stored = await db.select().from(teePricingForecastsTable)
      .where(eq(teePricingForecastsTable.organizationId, orgId));
    const activeRows = stored.filter(s => s.scenario === "active");
    expect(activeRows.length).toBe(1);
    expect(activeRows[0].horizonDays).toBe(14);
    // No persistDraft flag → draft scenario is not stored.
    expect(stored.filter(s => s.scenario === "draft").length).toBe(0);
  });
});
