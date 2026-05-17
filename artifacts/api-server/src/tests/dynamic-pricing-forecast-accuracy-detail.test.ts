/**
 * Tests for the per-forecast accuracy drill-down endpoint — Task #1264.
 *
 * Covers `GET /organizations/:orgId/tee-pricing/forecast-accuracy/:forecastId`,
 * which produces the per-day spine, totals, biggest-miss callout and
 * pending/complete status used by the admin drill-down view.
 *
 * Scenarios exercised here:
 *   - A fully-elapsed window with bookings spread across the days, asserting
 *     the daily spine, totals, biggestMiss day and status="complete".
 *   - A partly-pending window (windowEnd in the future) where future days
 *     report pending=true / 0 actuals and the overall status is "pending".
 *   - An unknown forecastId returns 404.
 *   - Cross-org access is rejected (a different org's admin gets 403,
 *     and a forecast belonging to another org is not reachable via this
 *     org's URL — 404).
 *   - The biggestMiss callout selects the day with the largest absolute
 *     projected-vs-actual delta (positive or negative).
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
  teePricingForecastsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let userId: number;
let courseId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;

// Second org used to exercise cross-org isolation.
let otherOrgId: number;
let otherUserId: number;
let otherCourseId: number;
let otherAdmin: TestUser;
let otherApp: ReturnType<typeof createTestApp>;

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

async function clearForecastFixtures(targetOrgId: number) {
  const bookings = await db.select({ id: teeBookingsTable.id })
    .from(teeBookingsTable).where(eq(teeBookingsTable.organizationId, targetOrgId));
  for (const b of bookings) {
    await db.delete(teeBookingPlayersTable).where(eq(teeBookingPlayersTable.bookingId, b.id));
  }
  await db.delete(teeBookingsTable).where(eq(teeBookingsTable.organizationId, targetOrgId));
  await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.organizationId, targetOrgId));
  await db.delete(teePricingForecastsTable).where(eq(teePricingForecastsTable.organizationId, targetOrgId));
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `ForecastDetailTest_${stamp}`,
    slug: `forecast-detail-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `forecast-detail-${stamp}`,
    username: `forecast_detail_${stamp}`,
    email: `forecast_detail_${stamp}@example.com`,
    displayName: "Forecast Detail Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId, role: "org_admin",
  });

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Forecast Detail Course",
    slug: `forecast-detail-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  await db.insert(teePricingRulesTable).values({
    organizationId: orgId, memberRate: "1000", guestRate: "1500",
  });

  admin = {
    id: userId,
    username: `forecast_detail_${stamp}`,
    displayName: "Forecast Detail Admin",
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);

  // Second org / admin (cross-org isolation tests).
  const [other] = await db.insert(organizationsTable).values({
    name: `ForecastDetailOther_${stamp}`,
    slug: `forecast-detail-other-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  otherOrgId = other.id;

  const [oUser] = await db.insert(appUsersTable).values({
    replitUserId: `forecast-detail-other-${stamp}`,
    username: `forecast_detail_other_${stamp}`,
    email: `forecast_detail_other_${stamp}@example.com`,
    displayName: "Forecast Detail Other Admin",
    role: "org_admin",
    organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  otherUserId = oUser.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: otherOrgId, userId: otherUserId, role: "org_admin",
  });

  const [oCourse] = await db.insert(coursesTable).values({
    organizationId: otherOrgId,
    name: "Forecast Detail Other Course",
    slug: `forecast-detail-other-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  otherCourseId = oCourse.id;

  await db.insert(teePricingRulesTable).values({
    organizationId: otherOrgId, memberRate: "1000", guestRate: "1500",
  });

  otherAdmin = {
    id: otherUserId,
    username: `forecast_detail_other_${stamp}`,
    displayName: "Forecast Detail Other Admin",
    role: "org_admin",
    organizationId: otherOrgId,
  };
  otherApp = createTestApp(otherAdmin);
});

afterAll(async () => {
  for (const targetOrg of [orgId, otherOrgId]) {
    if (!targetOrg) continue;
    const leftover = await db.select({ id: teeBookingsTable.id })
      .from(teeBookingsTable).where(eq(teeBookingsTable.organizationId, targetOrg));
    for (const b of leftover) {
      await db.delete(teeBookingPlayersTable).where(eq(teeBookingPlayersTable.bookingId, b.id));
    }
    await db.delete(teeBookingsTable).where(eq(teeBookingsTable.organizationId, targetOrg));
    await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.organizationId, targetOrg));
    await db.delete(teePricingForecastsTable).where(eq(teePricingForecastsTable.organizationId, targetOrg));
  }
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (otherUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, otherUserId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (otherOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

/**
 * Insert a single confirmed booking on the given day with the given revenue.
 * Used to dial a specific actual-revenue value into the per-day spine.
 */
async function seedBookingOnDay(
  targetOrgId: number,
  targetCourseId: number,
  leadUserId: number,
  dayOffsetN: number,
  revenue: number,
  slotTime: string,
) {
  const [s] = await db.insert(courseTeeSlotTable).values({
    courseId: targetCourseId, organizationId: targetOrgId,
    slotDate: dayOffset(dayOffsetN), slotTime, capacity: 4,
  }).returning();
  await db.insert(teeBookingsTable).values({
    slotId: s.id, organizationId: targetOrgId, leadUserId,
    partySize: 3, status: "confirmed",
    totalAmount: revenue.toFixed(2), currency: "INR",
  });
}

async function insertForecast(opts: {
  organizationId: number;
  courseId: number | null;
  actorUserId: number;
  windowStart: string;
  windowEnd: string;
  horizonDays: number;
  projectedRevenue: number;
  scenario?: "active" | "draft";
  label?: string;
}): Promise<number> {
  const [row] = await db.insert(teePricingForecastsTable).values({
    organizationId: opts.organizationId,
    courseId: opts.courseId ?? undefined,
    actorUserId: opts.actorUserId,
    scenario: opts.scenario ?? "active",
    label: opts.label ?? "test-forecast-detail",
    horizonDays: opts.horizonDays,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
    projectedRevenue: opts.projectedRevenue.toFixed(2),
    projectedAvgPrice: "0",
    projectedSeatsBooked: 0,
    projectedSeatsTotal: 0,
    assumptions: { historicalSampleDays: 90 },
  }).returning({ id: teePricingForecastsTable.id });
  return row.id;
}

describe("GET /tee-pricing/forecast-accuracy/:forecastId — drill-down", () => {
  it("returns per-day spine, totals and complete status for a fully-elapsed window with bookings", async () => {
    await clearForecastFixtures(orgId);

    // 5-day window entirely in the past: [today-10, today-5).
    // Days returned: today-10, today-9, today-8, today-7, today-6 → 5 days.
    // Projected = 5000 over horizonDays=5 → projectedPerDay = 1000.
    const windowStart = dateStr(-10);
    const windowEnd = dateStr(-5);
    const forecastId = await insertForecast({
      organizationId: orgId, courseId, actorUserId: userId,
      windowStart, windowEnd, horizonDays: 5, projectedRevenue: 5000,
    });
    // Two booking days inside the window.
    await seedBookingOnDay(orgId, courseId, userId, -8, 1200, "10:00");
    await seedBookingOnDay(orgId, courseId, userId, -7, 800, "10:00");

    const res = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/${forecastId}`);
    expect(res.status, res.text).toBe(200);

    expect(res.body.status).toBe("complete");
    expect(res.body.forecast.id).toBe(forecastId);
    expect(res.body.forecast.windowStart).toBe(windowStart);
    expect(res.body.forecast.windowEnd).toBe(windowEnd);
    expect(res.body.forecast.horizonDays).toBe(5);
    expect(res.body.forecast.projectedRevenue).toBeCloseTo(5000, 1);

    // Per-day spine: 5 days, none pending, projectedRevenue 1000 each.
    expect(Array.isArray(res.body.daily)).toBe(true);
    expect(res.body.daily.length).toBe(5);
    for (const d of res.body.daily) {
      expect(d.pending).toBe(false);
      expect(d.projectedRevenue).toBeCloseTo(1000, 1);
    }
    const byDay: Record<string, { actualRevenue: number; revenueDelta: number }> = {};
    for (const d of res.body.daily) byDay[d.day] = d;
    expect(byDay[dateStr(-8)].actualRevenue).toBeCloseTo(1200, 1);
    expect(byDay[dateStr(-8)].revenueDelta).toBeCloseTo(200, 1);
    expect(byDay[dateStr(-7)].actualRevenue).toBeCloseTo(800, 1);
    expect(byDay[dateStr(-7)].revenueDelta).toBeCloseTo(-200, 1);
    expect(byDay[dateStr(-10)].actualRevenue).toBe(0);
    expect(byDay[dateStr(-10)].revenueDelta).toBeCloseTo(-1000, 1);

    // Totals: actualRevenue = 1200 + 800 = 2000.
    expect(res.body.totals.projectedRevenue).toBeCloseTo(5000, 1);
    expect(res.body.totals.actualRevenue).toBeCloseTo(2000, 1);
    expect(res.body.totals.revenueError).toBeCloseTo(3000, 1);
    expect(res.body.totals.revenueErrorPct).toBeCloseTo(150, 1);
    // accuracyPct = max(0, 100 - |150|) = 0.
    expect(res.body.totals.accuracyPct).toBe(0);

    // biggestMiss is the day with the largest |projected - actual| gap.
    // The three "no booking" days each have delta = -1000 (|1000|); the two
    // booked days have |200|. So biggestMiss is one of the empty days.
    expect(res.body.biggestMiss).toBeTruthy();
    expect(Math.abs(res.body.biggestMiss.revenueDelta)).toBeCloseTo(1000, 1);
  });

  it("flags future days as pending and reports overall status='pending' for a partly-pending window", async () => {
    await clearForecastFixtures(orgId);

    // Window: [today-1, today+2) → spine days today-1, today, today+1.
    // windowEnd > today → isPending=true at the top level.
    // Per the handler: a day is "pending" only when strictly > today, so
    // today-1 and today are not pending; today+1 is.
    const windowStart = dateStr(-1);
    const windowEnd = dateStr(2);
    const forecastId = await insertForecast({
      organizationId: orgId, courseId, actorUserId: userId,
      windowStart, windowEnd, horizonDays: 3, projectedRevenue: 6000,
    });
    // Booking on the elapsed day (today-1).
    await seedBookingOnDay(orgId, courseId, userId, -1, 1500, "10:00");
    // Booking on a strictly-future day (today+1) — actuals must be masked.
    await seedBookingOnDay(orgId, courseId, userId, 1, 4000, "10:00");

    const res = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/${forecastId}`);
    expect(res.status, res.text).toBe(200);

    expect(res.body.status).toBe("pending");
    // accuracyPct is null while the window is still pending.
    expect(res.body.totals.accuracyPct).toBeNull();

    expect(res.body.daily.length).toBe(3);
    const byDay: Record<string, { pending: boolean; actualRevenue: number; actualBookings: number }> = {};
    for (const d of res.body.daily) byDay[d.day] = d;

    // Yesterday: not pending, real booking visible.
    expect(byDay[dateStr(-1)].pending).toBe(false);
    expect(byDay[dateStr(-1)].actualRevenue).toBeCloseTo(1500, 1);
    expect(byDay[dateStr(-1)].actualBookings).toBe(1);

    // Today: not pending (only strictly-future days are pending), no bookings.
    expect(byDay[dateStr(0)].pending).toBe(false);
    expect(byDay[dateStr(0)].actualRevenue).toBe(0);
    expect(byDay[dateStr(0)].actualBookings).toBe(0);

    // Tomorrow: pending — real booking exists but the response masks actuals.
    expect(byDay[dateStr(1)].pending).toBe(true);
    expect(byDay[dateStr(1)].actualRevenue).toBe(0);
    expect(byDay[dateStr(1)].actualBookings).toBe(0);

    // Totals only include non-pending days, so actualRevenue = 1500 (the
    // future booking is hidden until its day elapses).
    expect(res.body.totals.actualRevenue).toBeCloseTo(1500, 1);

    // biggestMiss is computed only over completed days. Projected per-day =
    // 6000/3 = 2000. Deltas: yesterday 1500-2000=-500; today 0-2000=-2000.
    // Tomorrow is excluded. Largest |delta| is today's -2000.
    expect(res.body.biggestMiss).toBeTruthy();
    expect(res.body.biggestMiss.day).toBe(dateStr(0));
    expect(res.body.biggestMiss.revenueDelta).toBeCloseTo(-2000, 1);
  });

  it("returns 404 for an unknown forecastId in this org", async () => {
    await clearForecastFixtures(orgId);
    const res = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/999999999`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("rejects cross-org access from a different org's admin with 403", async () => {
    await clearForecastFixtures(orgId);
    // A real forecast in orgId (the "victim" org).
    const forecastId = await insertForecast({
      organizationId: orgId, courseId, actorUserId: userId,
      windowStart: dateStr(-5), windowEnd: dateStr(-1),
      horizonDays: 4, projectedRevenue: 2000,
    });
    // Other org's admin (no membership in orgId) tries to read it.
    const res = await request(otherApp)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/${forecastId}`);
    expect(res.status).toBe(403);
  });

  it("returns 404 when a forecastId from a different org is queried via this org's URL", async () => {
    await clearForecastFixtures(orgId);
    await clearForecastFixtures(otherOrgId);
    // Forecast belongs to otherOrgId.
    const foreignForecastId = await insertForecast({
      organizationId: otherOrgId, courseId: otherCourseId, actorUserId: otherUserId,
      windowStart: dateStr(-5), windowEnd: dateStr(-1),
      horizonDays: 4, projectedRevenue: 1000,
    });
    // Caller is admin of orgId — passes requireOrgAdmin for orgId, but the
    // forecast lookup scopes by organizationId, so it should 404.
    const res = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/${foreignForecastId}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // Task #1475 — multi-course coverage. The drill-down handler builds
  // `courseClause` differently depending on whether the forecast was scoped
  // to a single course or to the org as a whole. The single-course branch
  // is exercised by the tests above; the following tests seed two courses
  // in the same org with bookings on overlapping days and assert both
  // branches independently.
  describe("multi-course branches", () => {
    let secondCourseId: number;

    beforeAll(async () => {
      const [c2] = await db.insert(coursesTable).values({
        organizationId: orgId,
        name: "Forecast Detail Course Two",
        slug: `forecast-detail-course-two-${stamp}`,
      }).returning({ id: coursesTable.id });
      secondCourseId = c2.id;
    });

    it("course-scoped forecast only counts bookings from the named course", async () => {
      await clearForecastFixtures(orgId);

      // 3-day window in the past: today-6 .. today-3 (exclusive).
      const windowStart = dateStr(-6);
      const windowEnd = dateStr(-3); // 3 days: -6, -5, -4
      // Course-1 forecast: courseId is set, so the handler should ignore
      // course-2 bookings entirely.
      const forecastId = await insertForecast({
        organizationId: orgId, courseId, actorUserId: userId,
        windowStart, windowEnd, horizonDays: 3, projectedRevenue: 3000,
        label: "test-forecast-detail-course1",
      });

      // Same days, both courses: only course-1's revenue should land in
      // the per-day spine and totals.
      await seedBookingOnDay(orgId, courseId, userId, -6, 700, "10:00");
      await seedBookingOnDay(orgId, secondCourseId, userId, -6, 9999, "11:00");
      await seedBookingOnDay(orgId, courseId, userId, -5, 400, "10:00");
      await seedBookingOnDay(orgId, secondCourseId, userId, -5, 8888, "11:00");
      await seedBookingOnDay(orgId, secondCourseId, userId, -4, 7777, "11:00"); // course-1 has nothing on -4

      const res = await request(app)
        .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/${forecastId}`);
      expect(res.status, res.text).toBe(200);
      expect(res.body.forecast.courseId).toBe(courseId);
      expect(res.body.daily.length).toBe(3);

      const byDay: Record<string, { actualRevenue: number; actualBookings: number }> = {};
      for (const d of res.body.daily) byDay[d.day] = d;

      // Only course-1 bookings are counted on each day.
      expect(byDay[dateStr(-6)].actualRevenue).toBeCloseTo(700, 1);
      expect(byDay[dateStr(-6)].actualBookings).toBe(1);
      expect(byDay[dateStr(-5)].actualRevenue).toBeCloseTo(400, 1);
      expect(byDay[dateStr(-5)].actualBookings).toBe(1);
      expect(byDay[dateStr(-4)].actualRevenue).toBe(0);
      expect(byDay[dateStr(-4)].actualBookings).toBe(0);

      // Totals: only course-1 (700 + 400 = 1100), not course-2's 26,664.
      expect(res.body.totals.actualRevenue).toBeCloseTo(1100, 1);
      expect(res.body.totals.actualBookings).toBe(2);
    });

    it("org-wide forecast (no courseId) sums bookings across every course in the club", async () => {
      await clearForecastFixtures(orgId);

      // Same 3-day window.
      const windowStart = dateStr(-6);
      const windowEnd = dateStr(-3); // 3 days: -6, -5, -4
      // Org-wide forecast: courseId is null, so the handler aggregates
      // bookings from every course in the org.
      const forecastId = await insertForecast({
        organizationId: orgId, courseId: null, actorUserId: userId,
        windowStart, windowEnd, horizonDays: 3, projectedRevenue: 3000,
        label: "test-forecast-detail-orgwide",
      });

      // Overlapping bookings on the same day across both courses must add
      // up in the per-day spine.
      await seedBookingOnDay(orgId, courseId, userId, -6, 700, "10:00");
      await seedBookingOnDay(orgId, secondCourseId, userId, -6, 300, "11:00");
      await seedBookingOnDay(orgId, courseId, userId, -5, 400, "10:00");
      await seedBookingOnDay(orgId, secondCourseId, userId, -5, 600, "11:00");
      await seedBookingOnDay(orgId, secondCourseId, userId, -4, 250, "11:00");

      const res = await request(app)
        .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/${forecastId}`);
      expect(res.status, res.text).toBe(200);
      expect(res.body.forecast.courseId).toBeNull();
      expect(res.body.daily.length).toBe(3);

      const byDay: Record<string, { actualRevenue: number; actualBookings: number }> = {};
      for (const d of res.body.daily) byDay[d.day] = d;

      // Each day sums both courses.
      expect(byDay[dateStr(-6)].actualRevenue).toBeCloseTo(1000, 1); // 700 + 300
      expect(byDay[dateStr(-6)].actualBookings).toBe(2);
      expect(byDay[dateStr(-5)].actualRevenue).toBeCloseTo(1000, 1); // 400 + 600
      expect(byDay[dateStr(-5)].actualBookings).toBe(2);
      expect(byDay[dateStr(-4)].actualRevenue).toBeCloseTo(250, 1);  // course-2 only
      expect(byDay[dateStr(-4)].actualBookings).toBe(1);

      // Totals across both courses: 1000 + 1000 + 250 = 2250.
      expect(res.body.totals.actualRevenue).toBeCloseTo(2250, 1);
      expect(res.body.totals.actualBookings).toBe(5);

      // Sanity: biggestMiss is one of the 1000-revenue days (delta = 0)
      // or the 250-revenue day (delta = -750). Projected per-day = 1000.
      // So the biggest absolute delta is on day -4 with -750.
      expect(res.body.biggestMiss).toBeTruthy();
      expect(res.body.biggestMiss.day).toBe(dateStr(-4));
      expect(res.body.biggestMiss.revenueDelta).toBeCloseTo(-750, 1);
    });
  });

  it("biggestMiss callout selects the day with the largest absolute projected-vs-actual delta", async () => {
    await clearForecastFixtures(orgId);

    // 5-day window, projected 5000 → projectedPerDay = 1000.
    // Bookings (deltas vs 1000):
    //   day -8 → 1200 (delta +200)
    //   day -7 →  900 (delta -100)
    //   day -6 → 5000 (delta +4000)  ← largest absolute delta
    //   day -5 →  800 (delta -200)
    //   day -4 → 1100 (delta +100)
    const windowStart = dateStr(-8);
    const windowEnd = dateStr(-3); // 5 days: -8, -7, -6, -5, -4
    const forecastId = await insertForecast({
      organizationId: orgId, courseId, actorUserId: userId,
      windowStart, windowEnd, horizonDays: 5, projectedRevenue: 5000,
    });
    await seedBookingOnDay(orgId, courseId, userId, -8, 1200, "10:00");
    await seedBookingOnDay(orgId, courseId, userId, -7,  900, "10:00");
    await seedBookingOnDay(orgId, courseId, userId, -6, 5000, "10:00");
    await seedBookingOnDay(orgId, courseId, userId, -5,  800, "10:00");
    await seedBookingOnDay(orgId, courseId, userId, -4, 1100, "10:00");

    const res = await request(app)
      .get(`/api/organizations/${orgId}/tee-pricing/forecast-accuracy/${forecastId}`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.daily.length).toBe(5);
    expect(res.body.biggestMiss).toBeTruthy();
    expect(res.body.biggestMiss.day).toBe(dateStr(-6));
    expect(res.body.biggestMiss.revenueDelta).toBeCloseTo(4000, 1);
  });
});
