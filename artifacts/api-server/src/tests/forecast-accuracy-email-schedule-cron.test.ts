/**
 * Tests for the forecast accuracy email schedule cron — Task #1254.
 *
 * Mirrors the per-currency revenue pivot cron (Task #669) so the
 * digest finance teams subscribe to here is exercised end-to-end:
 *
 *   - `runDueForecastAccuracyEmailSchedules` only picks up enabled rows
 *     whose `next_run_at` has elapsed; paused (enabled=false) and
 *     future-dated rows are left untouched so admins can pause without
 *     losing recipients.
 *   - On success a 'sent' history row is recorded with the actual row
 *     count, recipients, and period span; the schedule's `lastSentAt`
 *     advances to the run time and `nextRunAt` rolls forward by the
 *     cadence (7 days weekly).
 *   - The CSV that is mailed has the same header columns the manual
 *     download uses (window_start, window_end, scenario, label,
 *     projected_revenue, actual_revenue, error_pct, accuracy_pct,
 *     bucket) — keeps the on-demand and digest contracts aligned so
 *     finance scripts that key off column names don't break.
 *   - Pending (in-progress) forecast windows are excluded from the CSV
 *     so the digest is reconciliation-ready.
 *
 * The mailer is mocked so no SMTP traffic happens; the database is real.
 *
 * ─── Test isolation (Task #1808 / #2266) ──────────────────────────────
 * The api-server vitest suite runs in a single fork against a shared
 * dev DB and `runDueForecastAccuracyEmailSchedules` sweeps schedules
 * globally. Unscoped `mailerMock).toHaveBeenCalledTimes(N)` totals
 * would flake the moment a sibling test file leaks a due schedule, so
 * the runDue tests below filter mock calls by the unique recipient
 * email seeded by THIS test (test-local stamp).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendForecastAccuracyScheduleEmail: vi.fn(async () => undefined),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  coursesTable,
  courseTeeSlotTable,
  teeBookingsTable,
  teeBookingPlayersTable,
  teePricingForecastsTable,
  forecastAccuracyEmailSchedulesTable,
  forecastAccuracyEmailRunsTable,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  runOneForecastAccuracyEmailSchedule,
  runDueForecastAccuracyEmailSchedules,
  buildForecastAccuracyCsv,
} from "../routes/tee-pricing.js";
import { sendForecastAccuracyScheduleEmail } from "../lib/mailer.js";

const mailerMock = vi.mocked(sendForecastAccuracyScheduleEmail);

let orgId: number;
let userId: number;
let courseId: number;

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
  await db.delete(forecastAccuracyEmailSchedulesTable).where(eq(forecastAccuracyEmailSchedulesTable.organizationId, orgId));
}

async function seedCompletedForecast(opts: {
  projected: number;
  actualRevenue: number;
  windowStartDays?: number;
  windowEndDays?: number;
}) {
  const windowStart = dateStr(opts.windowStartDays ?? -30);
  const windowEnd = dateStr(opts.windowEndDays ?? -1);
  await db.insert(teePricingForecastsTable).values({
    organizationId: orgId,
    courseId,
    actorUserId: userId,
    scenario: "active",
    label: "weekly-digest-test",
    horizonDays: 30,
    windowStart,
    windowEnd,
    projectedRevenue: opts.projected.toFixed(2),
    projectedAvgPrice: "0",
    projectedSeatsBooked: 0,
    projectedSeatsTotal: 0,
    assumptions: { historicalSampleDays: 90 },
  });
  if (opts.actualRevenue > 0) {
    const [s] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: dayOffset(opts.windowStartDays ? opts.windowStartDays + 1 : -15),
      slotTime: "10:00", capacity: 4,
    }).returning();
    await db.insert(teeBookingsTable).values({
      slotId: s.id, organizationId: orgId, leadUserId: userId,
      partySize: 3, status: "confirmed",
      totalAmount: opts.actualRevenue.toFixed(2), currency: "INR",
    });
  }
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `ForecastAccuracyDigest_${stamp}`,
    slug: `forecast-acc-digest-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `forecast-acc-digest-${stamp}`,
    username: `forecast_acc_digest_${stamp}`,
    email: `forecast_acc_digest_${stamp}@example.com`,
    displayName: "Digest Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId, role: "org_admin",
  });

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Digest Course",
    slug: `digest-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseId = course.id;
});

afterAll(async () => {
  if (orgId) {
    await clearFixtures();
    await db.delete(coursesTable).where(eq(coursesTable.organizationId, orgId));
    await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  }
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  await clearFixtures();
  mailerMock.mockClear();
});

describe("forecast accuracy email schedule cron", () => {
  it("CSV builder uses the same column header set as the manual download", async () => {
    await seedCompletedForecast({ projected: 10000, actualRevenue: 9800 });
    const { csv, rowCount } = await buildForecastAccuracyCsv({
      orgId, from: dayOffset(-60), to: new Date(),
    });
    expect(rowCount).toBe(1);
    const header = csv.split("\n")[0];
    expect(header).toBe(
      "window_start,window_end,scenario,label,projected_revenue,actual_revenue,error_pct,accuracy_pct,bucket"
    );
    // Row should reflect the high-bucket case (projection within ~3% of actual).
    const row = csv.split("\n")[1].split(",");
    expect(row[2]).toBe("active");
    expect(row[3]).toBe("weekly-digest-test");
    expect(Number(row[4])).toBeCloseTo(10000, 1);
    expect(Number(row[5])).toBeCloseTo(9800, 1);
    expect(row[8]).toBe("high");
  });

  // Task #1476 — per-day companion sheet
  it("per-day companion CSV uses the projected_revenue_by_day snapshot when present", async () => {
    // Seed a forecast whose snapshot says 1000/2000/3000 across three days.
    const windowStart = dateStr(-3);
    const windowEnd = dateStr(0);
    const [forecast] = await db.insert(teePricingForecastsTable).values({
      organizationId: orgId,
      courseId,
      actorUserId: userId,
      scenario: "active",
      label: "per-day-snapshot",
      horizonDays: 3,
      windowStart,
      windowEnd,
      projectedRevenue: "6000.00",
      projectedAvgPrice: "0",
      projectedSeatsBooked: 0,
      projectedSeatsTotal: 0,
      projectedRevenueByDay: [
        { day: dateStr(-3), revenue: 1000 },
        { day: dateStr(-2), revenue: 2000 },
        { day: dateStr(-1), revenue: 3000 },
      ],
      assumptions: {},
    }).returning();

    // Seed an actual booking on the middle day so we can verify the
    // per-day actual matches the day-level revenue.
    const [slot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: dayOffset(-2),
      slotTime: "10:00", capacity: 4,
    }).returning();
    await db.insert(teeBookingsTable).values({
      slotId: slot.id, organizationId: orgId, leadUserId: userId,
      partySize: 2, status: "confirmed",
      totalAmount: "1900.00", currency: "INR",
    });

    const { perDayCsv, perDayRowCount } = await buildForecastAccuracyCsv({
      orgId, from: dayOffset(-60), to: new Date(),
    });

    const perDayLines = perDayCsv.split("\n");
    expect(perDayLines[0]).toBe(
      "forecast_id,window_start,window_end,scenario,label,day,projected_revenue,actual_revenue,revenue_delta,projection_source"
    );
    // Three days inside the elapsed window (window_end is exclusive in
    // the CSV builder — matches the manual download's day generator).
    expect(perDayRowCount).toBe(3);

    const dayRows = perDayLines.slice(1, 4).map(l => l.split(","));
    // Each row should reference this forecast id and label.
    for (const r of dayRows) {
      expect(r[0]).toBe(String(forecast.id));
      expect(r[3]).toBe("active");
      expect(r[4]).toBe("per-day-snapshot");
      expect(r[9]).toBe("snapshot");
    }
    const byDay = new Map(dayRows.map(r => [r[5], r]));
    const day1 = byDay.get(dateStr(-3))!;
    const day2 = byDay.get(dateStr(-2))!;
    const day3 = byDay.get(dateStr(-1))!;
    expect(Number(day1[6])).toBeCloseTo(1000, 1);
    expect(Number(day1[7])).toBeCloseTo(0, 1);
    expect(Number(day2[6])).toBeCloseTo(2000, 1);
    expect(Number(day2[7])).toBeCloseTo(1900, 1);
    expect(Number(day2[8])).toBeCloseTo(-100, 1); // actual - projected
    expect(Number(day3[6])).toBeCloseTo(3000, 1);
    expect(Number(day3[7])).toBeCloseTo(0, 1);
  });

  // Task #1476 — legacy fallback for forecasts written before
  // projected_revenue_by_day existed.
  it("per-day companion CSV falls back to flat distribution when the snapshot is missing", async () => {
    const windowStart = dateStr(-2);
    const windowEnd = dateStr(0);
    const [forecast] = await db.insert(teePricingForecastsTable).values({
      organizationId: orgId,
      courseId,
      actorUserId: userId,
      scenario: "active",
      label: "legacy-no-snapshot",
      horizonDays: 2,
      windowStart,
      windowEnd,
      projectedRevenue: "1000.00",
      projectedAvgPrice: "0",
      projectedSeatsBooked: 0,
      projectedSeatsTotal: 0,
      projectedRevenueByDay: null, // legacy row
      assumptions: {},
    }).returning();

    const { perDayCsv, perDayRowCount } = await buildForecastAccuracyCsv({
      orgId, from: dayOffset(-60), to: new Date(),
    });

    expect(perDayRowCount).toBe(2);
    const perDayLines = perDayCsv.split("\n");
    const dayRows = perDayLines.slice(1, 3).map(l => l.split(","));
    for (const r of dayRows) {
      expect(r[0]).toBe(String(forecast.id));
      // 1000 / 2 horizon days = 500 per day flat.
      expect(Number(r[6])).toBeCloseTo(500, 1);
      expect(r[9]).toBe("flat");
    }
  });

  it("excludes pending (in-progress) forecast windows from the digest CSV", async () => {
    // One completed window (projection close to actual) and one pending
    // window straddling the future — only the completed one should land
    // in the CSV, matching the manual download's default behaviour.
    await seedCompletedForecast({ projected: 10000, actualRevenue: 9800 });
    await db.insert(teePricingForecastsTable).values({
      organizationId: orgId, courseId, actorUserId: userId,
      scenario: "active", horizonDays: 14,
      windowStart: dateStr(0), windowEnd: dateStr(14),
      projectedRevenue: "5000.00", projectedAvgPrice: "0",
      projectedSeatsBooked: 0, projectedSeatsTotal: 0,
      assumptions: {},
    });
    const { csv, rowCount } = await buildForecastAccuracyCsv({
      orgId, from: dayOffset(-60), to: dayOffset(30),
    });
    expect(rowCount).toBe(1);
    expect(csv.split("\n").length).toBe(2); // header + 1 row
  });

  it("runs a due weekly schedule end-to-end: emails the CSV and records a 'sent' history row", async () => {
    await seedCompletedForecast({ projected: 10000, actualRevenue: 9800 });

    // Schedule that came due an hour ago.
    const dueAt = new Date(Date.now() - 60 * 60 * 1000);
    const myRecipient = `finance-weekly-${stamp}@example.com`;
    const [sched] = await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: [myRecipient],
      enabled: true,
      nextRunAt: dueAt,
      createdByUserId: userId,
    }).returning();

    await runDueForecastAccuracyEmailSchedules();

    const ourCalls = mailerMock.mock.calls.filter(c => (c[0].to as string[])?.includes(myRecipient));
    expect(ourCalls).toHaveLength(1);
    const call = ourCalls[0][0];
    expect(call.to).toEqual([myRecipient]);
    expect(call.frequency).toBe("weekly");
    expect(call.rowCount).toBe(1);
    expect(call.csv.startsWith(
      "window_start,window_end,scenario,label,projected_revenue,actual_revenue,error_pct,accuracy_pct,bucket"
    )).toBe(true);

    const [updated] = await db.select().from(forecastAccuracyEmailSchedulesTable)
      .where(eq(forecastAccuracyEmailSchedulesTable.id, sched.id));
    expect(updated.lastSentAt).not.toBeNull();
    // nextRunAt advanced to ~7 days after the run.
    const drift = Math.abs(
      updated.nextRunAt.getTime() - (Date.now() + 7 * 24 * 60 * 60 * 1000)
    );
    expect(drift).toBeLessThan(60 * 1000);

    const runs = await db.select().from(forecastAccuracyEmailRunsTable)
      .where(eq(forecastAccuracyEmailRunsTable.scheduleId, sched.id))
      .orderBy(desc(forecastAccuracyEmailRunsTable.sentAt));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("sent");
    expect(runs[0].rowCount).toBe(1);
    expect(runs[0].recipients).toEqual(["finance@example.com"]);
  });

  it("advances nextRunAt by 1 day for the daily cadence so rapid-iteration pricing experiments get a same-day digest", async () => {
    await seedCompletedForecast({ projected: 10000, actualRevenue: 9800 });

    const dueAt = new Date(Date.now() - 60 * 60 * 1000);
    const myDailyRecipient = `finance-daily-${stamp}@example.com`;
    const [sched] = await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "daily",
      recipients: [myDailyRecipient],
      enabled: true,
      nextRunAt: dueAt,
      createdByUserId: userId,
    }).returning();

    await runDueForecastAccuracyEmailSchedules();

    const ourDailyCalls = mailerMock.mock.calls.filter(c => (c[0].to as string[])?.includes(myDailyRecipient));
    expect(ourDailyCalls).toHaveLength(1);
    expect(ourDailyCalls[0][0].frequency).toBe("daily");

    const [updated] = await db.select().from(forecastAccuracyEmailSchedulesTable)
      .where(eq(forecastAccuracyEmailSchedulesTable.id, sched.id));
    // nextRunAt advanced to ~1 day after the run.
    const drift = Math.abs(
      updated.nextRunAt.getTime() - (Date.now() + 24 * 60 * 60 * 1000)
    );
    expect(drift).toBeLessThan(60 * 1000);
  });

  it("does not send for paused (enabled=false) schedules — pause preserves recipients without emailing", async () => {
    await seedCompletedForecast({ projected: 10000, actualRevenue: 9800 });

    const dueAt = new Date(Date.now() - 60 * 60 * 1000);
    const [sched] = await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["finance@example.com"],
      enabled: false, // paused
      nextRunAt: dueAt,
      createdByUserId: userId,
    }).returning();

    await runDueForecastAccuracyEmailSchedules();

    expect(mailerMock).not.toHaveBeenCalled();
    const [reloaded] = await db.select().from(forecastAccuracyEmailSchedulesTable)
      .where(eq(forecastAccuracyEmailSchedulesTable.id, sched.id));
    // Schedule untouched: recipients preserved, cadence not advanced.
    expect(reloaded.recipients).toEqual(["finance@example.com"]);
    expect(reloaded.lastSentAt).toBeNull();
    expect(reloaded.nextRunAt.getTime()).toBe(dueAt.getTime());
    const runs = await db.select().from(forecastAccuracyEmailRunsTable)
      .where(eq(forecastAccuracyEmailRunsTable.scheduleId, sched.id));
    expect(runs).toHaveLength(0);
  });

  it("does not send for schedules whose next_run_at is still in the future", async () => {
    await seedCompletedForecast({ projected: 10000, actualRevenue: 9800 });

    const futureAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow
    await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["finance@example.com"],
      enabled: true,
      nextRunAt: futureAt,
      createdByUserId: userId,
    });

    await runDueForecastAccuracyEmailSchedules();
    expect(mailerMock).not.toHaveBeenCalled();
  });

  it("records a 'skipped' run with no email when recipients are empty", async () => {
    await seedCompletedForecast({ projected: 10000, actualRevenue: 9800 });

    const dueAt = new Date(Date.now() - 60 * 60 * 1000);
    const [sched] = await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: [],
      enabled: true,
      nextRunAt: dueAt,
      createdByUserId: userId,
    }).returning();

    const result = await runOneForecastAccuracyEmailSchedule(sched.id);
    expect(result.status).toBe("skipped");
    expect(mailerMock).not.toHaveBeenCalled();
    const runs = await db.select().from(forecastAccuracyEmailRunsTable)
      .where(eq(forecastAccuracyEmailRunsTable.scheduleId, sched.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("skipped");

    // Cadence still advances so the cron doesn't re-skip on every poll and
    // accumulate duplicate skipped history rows until a recipient is added.
    const [updated] = await db.select().from(forecastAccuracyEmailSchedulesTable)
      .where(eq(forecastAccuracyEmailSchedulesTable.id, sched.id));
    expect(updated.nextRunAt.getTime()).toBeGreaterThan(dueAt.getTime());
    expect(updated.lastSentAt).not.toBeNull();
    const drift = Math.abs(
      updated.nextRunAt.getTime() - (Date.now() + 7 * 24 * 60 * 60 * 1000)
    );
    expect(drift).toBeLessThan(60 * 1000);
  });

  // Task #1804 — daily cadence covers a 1-day elapsed window and will
  // frequently land on days where no forecasts completed. The cron used
  // to mail finance a header-only CSV in that case; we now skip the
  // email entirely (mirrors the empty-recipients 'skipped' contract).
  it("daily cadence with no completed forecast windows skips the email and records a 'skipped' history row", async () => {
    // No forecasts seeded — `beforeEach` clears the org, so this org has
    // zero completed windows in the elapsed daily period.
    const dueAt = new Date(Date.now() - 60 * 60 * 1000);
    const [sched] = await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "daily",
      recipients: ["finance@example.com"],
      enabled: true,
      nextRunAt: dueAt,
      createdByUserId: userId,
    }).returning();

    const result = await runOneForecastAccuracyEmailSchedule(sched.id);

    expect(result.status).toBe("skipped");
    expect(result.rowCount).toBe(0);
    expect(mailerMock).not.toHaveBeenCalled();

    const runs = await db.select().from(forecastAccuracyEmailRunsTable)
      .where(eq(forecastAccuracyEmailRunsTable.scheduleId, sched.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("skipped");
    expect(runs[0].rowCount).toBe(0);
    expect(runs[0].recipients).toEqual(["finance@example.com"]);

    // Cadence still advances so the cron doesn't re-skip on every poll.
    const [updated] = await db.select().from(forecastAccuracyEmailSchedulesTable)
      .where(eq(forecastAccuracyEmailSchedulesTable.id, sched.id));
    expect(updated.nextRunAt.getTime()).toBeGreaterThan(dueAt.getTime());
    const drift = Math.abs(
      updated.nextRunAt.getTime() - (Date.now() + 24 * 60 * 60 * 1000)
    );
    expect(drift).toBeLessThan(60 * 1000);
  });

  // Task #1804 — guard against the daily-skip carve-out leaking into
  // weekly/monthly. A weekly digest with zero rows is rare enough that
  // finance still wants the heartbeat email confirming the cron ran.
  it("weekly cadence with no completed forecast windows STILL emails (skip-when-empty is daily-only)", async () => {
    const dueAt = new Date(Date.now() - 60 * 60 * 1000);
    const [sched] = await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["finance@example.com"],
      enabled: true,
      nextRunAt: dueAt,
      createdByUserId: userId,
    }).returning();

    const result = await runOneForecastAccuracyEmailSchedule(sched.id);
    expect(result.status).toBe("sent");
    expect(result.rowCount).toBe(0);
    expect(mailerMock).toHaveBeenCalledTimes(1);
    expect(mailerMock.mock.calls[0][0].frequency).toBe("weekly");
    expect(mailerMock.mock.calls[0][0].rowCount).toBe(0);
  });

  it("records a 'failed' run AND advances cadence when the mailer throws — broken inboxes don't get hammered every poll", async () => {
    await seedCompletedForecast({ projected: 10000, actualRevenue: 9800 });
    mailerMock.mockRejectedValueOnce(new Error("smtp blew up"));

    const dueAt = new Date(Date.now() - 60 * 60 * 1000);
    const [sched] = await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["finance@example.com"],
      enabled: true,
      nextRunAt: dueAt,
      createdByUserId: userId,
    }).returning();

    const result = await runOneForecastAccuracyEmailSchedule(sched.id);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("smtp blew up");

    const [updated] = await db.select().from(forecastAccuracyEmailSchedulesTable)
      .where(eq(forecastAccuracyEmailSchedulesTable.id, sched.id));
    // Cadence advanced even on failure.
    expect(updated.nextRunAt.getTime()).toBeGreaterThan(dueAt.getTime());

    const runs = await db.select().from(forecastAccuracyEmailRunsTable)
      .where(eq(forecastAccuracyEmailRunsTable.scheduleId, sched.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].errorMessage).toContain("smtp blew up");
  });
});
