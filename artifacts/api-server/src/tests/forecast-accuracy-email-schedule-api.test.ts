/**
 * Integration tests for the forecast-accuracy email-schedule HTTP endpoints
 * (Task #1472). Task #1254 introduced the cron loop and CSV builder unit
 * tests, but the routes themselves were only exercised indirectly through
 * the cron-loop suite. This file pins the public contract of:
 *
 *   GET    /tee-pricing/forecast-accuracy/email-schedule
 *   PUT    /tee-pricing/forecast-accuracy/email-schedule
 *   DELETE /tee-pricing/forecast-accuracy/email-schedule
 *   GET    /tee-pricing/forecast-accuracy/email-schedule/preview
 *   POST   /tee-pricing/forecast-accuracy/email-schedule/send-now
 *
 * Coverage:
 *   - PUT creates a new schedule, then a follow-up PUT updates it in place
 *     (one-row-per-org invariant: `forecast_accuracy_email_schedules` has a
 *     unique index on `organization_id`).
 *   - PUT validates the frequency (only weekly/monthly), the recipient
 *     emails (basic shape), the empty-list case, and the 20-recipient cap.
 *     Whitespace is trimmed and duplicates are de-duplicated.
 *   - PUT recomputes `next_run_at` when the cadence changes or a paused
 *     schedule is re-enabled, and otherwise preserves it.
 *   - GET returns the saved schedule alongside the most recent send history
 *     so the BookingsForecastAccuracyDigestCard can render both panes from
 *     a single round trip.
 *   - DELETE clears the schedule (and cascades to its history rows).
 *   - /preview returns a renderable shape (subject, html, filename,
 *     rowCount, recipients, frequency, periodStart/End ISO, csvSample) and
 *     404s when no schedule is configured — this is the contract the
 *     "Preview email" button on the admin UI keys off of.
 *   - /send-now invokes the shared dispatcher and 404s when no schedule is
 *     configured. The mailer is mocked so no SMTP traffic happens.
 *   - Permission gates: unauthenticated callers get 401 and non-admin
 *     callers (e.g. `player`) get 403 on every endpoint, matching the rest
 *     of the tee-pricing admin surface.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Mailer mock — must be hoisted before the routes module imports it.
vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendForecastAccuracyScheduleEmail: vi.fn(async () => undefined),
  };
});

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
  teePricingForecastsTable,
  forecastAccuracyEmailSchedulesTable,
  forecastAccuracyEmailRunsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";
import { sendForecastAccuracyScheduleEmail } from "../lib/mailer.js";

const mailerMock = vi.mocked(sendForecastAccuracyScheduleEmail);

let orgId: number;
let adminUserId: number;
let playerUserId: number;
let courseId: number;

let adminApp: ReturnType<typeof createTestApp>;
let playerApp: ReturnType<typeof createTestApp>;
let anonApp: ReturnType<typeof createTestApp>;

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const BASE = () =>
  `/api/organizations/${orgId}/tee-pricing/forecast-accuracy/email-schedule`;

function dayOffset(days: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}
function dateStr(days: number): string {
  return dayOffset(days).toISOString().split("T")[0];
}

/** Drop everything tied to this org's schedule so each test is independent. */
async function clearScheduleFixtures() {
  await db.delete(forecastAccuracyEmailSchedulesTable)
    .where(eq(forecastAccuracyEmailSchedulesTable.organizationId, orgId));
  // The runs table cascades from schedules but mop up any orphans defensively.
  await db.delete(forecastAccuracyEmailRunsTable)
    .where(eq(forecastAccuracyEmailRunsTable.organizationId, orgId));
}

/** Seed a single completed forecast + matching booking so /preview and
 *  /send-now have at least one row to put into the CSV. */
async function seedCompletedForecast() {
  const windowStart = dateStr(-30);
  const windowEnd = dateStr(-1);
  await db.insert(teePricingForecastsTable).values({
    organizationId: orgId,
    courseId,
    actorUserId: adminUserId,
    scenario: "active",
    label: "api-test",
    horizonDays: 30,
    windowStart,
    windowEnd,
    projectedRevenue: "10000.00",
    projectedAvgPrice: "0",
    projectedSeatsBooked: 0,
    projectedSeatsTotal: 0,
    assumptions: { historicalSampleDays: 90 },
  });
  const [s] = await db.insert(courseTeeSlotTable).values({
    courseId,
    organizationId: orgId,
    slotDate: dayOffset(-15),
    slotTime: "10:00",
    capacity: 4,
  }).returning();
  await db.insert(teeBookingsTable).values({
    slotId: s.id,
    organizationId: orgId,
    leadUserId: adminUserId,
    partySize: 3,
    status: "confirmed",
    totalAmount: "9800.00",
    currency: "INR",
  });
}

async function clearForecastFixtures() {
  const bookings = await db.select({ id: teeBookingsTable.id })
    .from(teeBookingsTable)
    .where(eq(teeBookingsTable.organizationId, orgId));
  for (const b of bookings) {
    await db.delete(teeBookingPlayersTable)
      .where(eq(teeBookingPlayersTable.bookingId, b.id));
  }
  await db.delete(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
  await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.organizationId, orgId));
  await db.delete(teePricingForecastsTable).where(eq(teePricingForecastsTable.organizationId, orgId));
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `ForecastAccuracyApi_${stamp}`,
    slug: `forecast-acc-api-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: uid("forecast-acc-api-admin"),
    username: `forecast_acc_api_admin_${stamp}`,
    email: `forecast_acc_api_admin_${stamp}@example.com`,
    displayName: "API Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = admin.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: adminUserId, role: "org_admin",
  });

  const [player] = await db.insert(appUsersTable).values({
    replitUserId: uid("forecast-acc-api-player"),
    username: `forecast_acc_api_player_${stamp}`,
    email: `forecast_acc_api_player_${stamp}@example.com`,
    displayName: "API Player",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  playerUserId = player.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "API Test Course",
    slug: `forecast-acc-api-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  adminApp = createTestApp({
    id: adminUserId,
    username: `forecast_acc_api_admin_${stamp}`,
    role: "org_admin",
    organizationId: orgId,
  } satisfies TestUser);
  playerApp = createTestApp({
    id: playerUserId,
    username: `forecast_acc_api_player_${stamp}`,
    role: "player",
    organizationId: orgId,
  } satisfies TestUser);
  anonApp = createTestApp();
});

afterAll(async () => {
  await clearForecastFixtures();
  await clearScheduleFixtures();
  if (courseId) await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  if (orgId) await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (playerUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, playerUserId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  await clearScheduleFixtures();
  mailerMock.mockClear();
  mailerMock.mockResolvedValue(undefined);
});

describe("PUT /tee-pricing/forecast-accuracy/email-schedule — create & update", () => {
  it("creates a new schedule and computes next_run_at from the cadence", async () => {
    const before = Date.now();
    const res = await request(adminApp).put(BASE()).send({
      frequency: "weekly",
      recipients: ["finance@example.com"],
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body.schedule).toMatchObject({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["finance@example.com"],
      enabled: true,
    });
    expect(res.body.schedule.id).toEqual(expect.any(Number));
    // next_run_at should be ~7 days from now (weekly cadence).
    const nextRun = new Date(res.body.schedule.nextRunAt).getTime();
    const expected = before + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(nextRun - expected)).toBeLessThan(60 * 1000);

    // Database invariant: exactly one row for the org.
    const rows = await db.select()
      .from(forecastAccuracyEmailSchedulesTable)
      .where(eq(forecastAccuracyEmailSchedulesTable.organizationId, orgId));
    expect(rows).toHaveLength(1);
  });

  it("updates the existing schedule in place — no second row is created", async () => {
    // Seed a schedule via the API.
    const create = await request(adminApp).put(BASE()).send({
      frequency: "weekly",
      recipients: ["a@example.com"],
    });
    expect(create.status, create.text).toBe(200);
    const originalId = create.body.schedule.id;
    const originalNextRun = new Date(create.body.schedule.nextRunAt).getTime();

    // Same cadence, different recipients — id must be preserved and
    // next_run_at must NOT be reset (admins editing the recipient list
    // should not push the next email out by another week).
    const update = await request(adminApp).put(BASE()).send({
      frequency: "weekly",
      recipients: ["a@example.com", "b@example.com"],
    });
    expect(update.status, update.text).toBe(200);
    expect(update.body.schedule.id).toBe(originalId);
    expect(update.body.schedule.recipients).toEqual(["a@example.com", "b@example.com"]);
    expect(new Date(update.body.schedule.nextRunAt).getTime()).toBe(originalNextRun);

    const rows = await db.select()
      .from(forecastAccuracyEmailSchedulesTable)
      .where(eq(forecastAccuracyEmailSchedulesTable.organizationId, orgId));
    expect(rows).toHaveLength(1);
  });

  it("recomputes next_run_at when the cadence changes (weekly → monthly)", async () => {
    await request(adminApp).put(BASE())
      .send({ frequency: "weekly", recipients: ["a@example.com"] })
      .expect(200);

    const before = Date.now();
    const res = await request(adminApp).put(BASE())
      .send({ frequency: "monthly", recipients: ["a@example.com"] });
    expect(res.status, res.text).toBe(200);
    expect(res.body.schedule.frequency).toBe("monthly");
    const nextRun = new Date(res.body.schedule.nextRunAt).getTime();
    const expected = before + 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(nextRun - expected)).toBeLessThan(60 * 1000);
  });

  it("recomputes next_run_at when a paused schedule is re-enabled", async () => {
    // Create a paused schedule with a stale next_run_at.
    const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["a@example.com"],
      enabled: false,
      nextRunAt: stale,
      createdByUserId: adminUserId,
    });

    const before = Date.now();
    const res = await request(adminApp).put(BASE())
      .send({ frequency: "weekly", recipients: ["a@example.com"], enabled: true });
    expect(res.status, res.text).toBe(200);
    expect(res.body.schedule.enabled).toBe(true);
    // next_run_at must NOT still be the 10-day-old stale value.
    const nextRun = new Date(res.body.schedule.nextRunAt).getTime();
    expect(nextRun).toBeGreaterThan(stale.getTime() + 24 * 60 * 60 * 1000);
    const expected = before + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(nextRun - expected)).toBeLessThan(60 * 1000);
  });

  it("trims whitespace and de-duplicates recipient emails", async () => {
    const res = await request(adminApp).put(BASE()).send({
      frequency: "weekly",
      recipients: ["  ops@example.com  ", "ops@example.com", "", "finance@example.com"],
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body.schedule.recipients).toEqual(["ops@example.com", "finance@example.com"]);
  });
});

describe("PUT /tee-pricing/forecast-accuracy/email-schedule — validation", () => {
  it("rejects an unknown frequency value", async () => {
    const res = await request(adminApp).put(BASE())
      .send({ frequency: "yearly", recipients: ["a@example.com"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/frequency/i);
  });

  it("rejects an empty recipient list (admins must opt at least one inbox in)", async () => {
    const res = await request(adminApp).put(BASE())
      .send({ frequency: "weekly", recipients: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/recipient/i);
  });

  it("rejects a malformed recipient email and surfaces which one", async () => {
    const res = await request(adminApp).put(BASE())
      .send({ frequency: "weekly", recipients: ["not-an-email"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid recipient email/i);
    expect(res.body.error).toMatch(/not-an-email/);
  });

  it("rejects more than 20 recipients (per-schedule cap)", async () => {
    const recipients = Array.from({ length: 21 }, (_, i) => `r${i}@example.com`);
    const res = await request(adminApp).put(BASE())
      .send({ frequency: "weekly", recipients });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/20 recipients/);
  });

  it("accepts exactly 20 recipients (cap is inclusive)", async () => {
    const recipients = Array.from({ length: 20 }, (_, i) => `r${i}@example.com`);
    const res = await request(adminApp).put(BASE())
      .send({ frequency: "weekly", recipients });
    expect(res.status, res.text).toBe(200);
    expect(res.body.schedule.recipients).toHaveLength(20);
  });
});

describe("GET /tee-pricing/forecast-accuracy/email-schedule", () => {
  it("returns null + empty history when no schedule exists yet", async () => {
    const res = await request(adminApp).get(BASE());
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ schedule: null, history: [] });
  });

  it("returns the saved schedule plus its run history", async () => {
    const [sched] = await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["finance@example.com"],
      enabled: true,
      nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdByUserId: adminUserId,
    }).returning();
    await db.insert(forecastAccuracyEmailRunsTable).values({
      scheduleId: sched.id,
      organizationId: orgId,
      periodStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      periodEnd: new Date(),
      recipients: ["finance@example.com"],
      rowCount: 3,
      status: "sent",
    });

    const res = await request(adminApp).get(BASE());
    expect(res.status, res.text).toBe(200);
    expect(res.body.schedule).toMatchObject({
      id: sched.id,
      frequency: "weekly",
      recipients: ["finance@example.com"],
    });
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0]).toMatchObject({
      scheduleId: sched.id,
      status: "sent",
      rowCount: 3,
      recipients: ["finance@example.com"],
    });
  });
});

describe("DELETE /tee-pricing/forecast-accuracy/email-schedule", () => {
  it("removes the schedule (and cascades to its runs)", async () => {
    const [sched] = await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["finance@example.com"],
      enabled: true,
      nextRunAt: new Date(),
      createdByUserId: adminUserId,
    }).returning();
    await db.insert(forecastAccuracyEmailRunsTable).values({
      scheduleId: sched.id,
      organizationId: orgId,
      periodEnd: new Date(),
      recipients: ["finance@example.com"],
      rowCount: 0,
      status: "sent",
    });

    const res = await request(adminApp).delete(BASE());
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const remaining = await db.select()
      .from(forecastAccuracyEmailSchedulesTable)
      .where(eq(forecastAccuracyEmailSchedulesTable.organizationId, orgId));
    expect(remaining).toHaveLength(0);
    const remainingRuns = await db.select()
      .from(forecastAccuracyEmailRunsTable)
      .where(eq(forecastAccuracyEmailRunsTable.scheduleId, sched.id));
    expect(remainingRuns).toHaveLength(0);
  });
});

describe("GET /tee-pricing/forecast-accuracy/email-schedule/preview", () => {
  it("404s when no schedule has been configured", async () => {
    const res = await request(adminApp).get(`${BASE()}/preview`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no forecast accuracy schedule/i);
  });

  it("returns the renderable preview shape (subject/html/filename + csvSample)", async () => {
    await clearForecastFixtures();
    await seedCompletedForecast();
    await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["finance@example.com"],
      enabled: true,
      nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdByUserId: adminUserId,
    });

    const res = await request(adminApp).get(`${BASE()}/preview`);
    expect(res.status, res.text).toBe(200);

    expect(typeof res.body.subject).toBe("string");
    expect(res.body.subject.length).toBeGreaterThan(0);
    expect(typeof res.body.html).toBe("string");
    expect(res.body.html.length).toBeGreaterThan(0);
    expect(typeof res.body.filename).toBe("string");
    expect(res.body.filename).toMatch(/\.csv$/i);
    expect(res.body.frequency).toBe("weekly");
    expect(res.body.recipients).toEqual(["finance@example.com"]);
    expect(typeof res.body.periodStart).toBe("string");
    expect(typeof res.body.periodEnd).toBe("string");
    // periodStart must be parseable and strictly before periodEnd.
    expect(new Date(res.body.periodStart).getTime())
      .toBeLessThan(new Date(res.body.periodEnd).getTime());

    expect(res.body.csvSample).toBeDefined();
    expect(res.body.csvSample.header).toBe(
      "window_start,window_end,scenario,label,projected_revenue,actual_revenue,error_pct,accuracy_pct,bucket"
    );
    expect(Array.isArray(res.body.csvSample.rows)).toBe(true);
    expect(res.body.csvSample.totalRows).toBe(res.body.rowCount);
    expect(res.body.csvSample.sampleSize).toBe(res.body.csvSample.rows.length);
    expect(res.body.csvSample.rows.length).toBeLessThanOrEqual(10);

    // Preview must NEVER record a run row or mutate the schedule.
    const runs = await db.select()
      .from(forecastAccuracyEmailRunsTable)
      .where(eq(forecastAccuracyEmailRunsTable.organizationId, orgId));
    expect(runs).toHaveLength(0);
    expect(mailerMock).not.toHaveBeenCalled();
  });
});

describe("POST /tee-pricing/forecast-accuracy/email-schedule/send-now", () => {
  it("404s when no schedule has been configured", async () => {
    const res = await request(adminApp).post(`${BASE()}/send-now`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no forecast accuracy schedule/i);
  });

  it("dispatches the email immediately and records a 'sent' run", async () => {
    await clearForecastFixtures();
    await seedCompletedForecast();
    const [sched] = await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["finance@example.com"],
      enabled: true,
      nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdByUserId: adminUserId,
    }).returning();

    const res = await request(adminApp).post(`${BASE()}/send-now`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.recipients).toEqual(["finance@example.com"]);
    expect(res.body.rowCount).toBeGreaterThanOrEqual(0);

    expect(mailerMock).toHaveBeenCalledTimes(1);
    const call = mailerMock.mock.calls[0][0];
    expect(call.to).toEqual(["finance@example.com"]);
    expect(call.frequency).toBe("weekly");

    const runs = await db.select()
      .from(forecastAccuracyEmailRunsTable)
      .where(eq(forecastAccuracyEmailRunsTable.scheduleId, sched.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("sent");
  });
});

describe("permission gates — non-admins must be rejected on every endpoint", () => {
  // Each endpoint rejects unauthenticated callers with 401 and authenticated
  // non-admin callers (e.g. `player`) with 403. Keeps the schedule editor
  // gated to org admins, matching the rest of the tee-pricing surface.
  const cases: Array<{
    label: string;
    invoke: (app: ReturnType<typeof createTestApp>) => request.Test;
  }> = [
    { label: "GET schedule",        invoke: (app) => request(app).get(BASE()) },
    { label: "PUT schedule",        invoke: (app) => request(app).put(BASE()).send({ frequency: "weekly", recipients: ["a@example.com"] }) },
    { label: "DELETE schedule",     invoke: (app) => request(app).delete(BASE()) },
    { label: "GET preview",         invoke: (app) => request(app).get(`${BASE()}/preview`) },
    { label: "POST send-now",       invoke: (app) => request(app).post(`${BASE()}/send-now`) },
  ];

  for (const c of cases) {
    it(`${c.label}: 401 for unauthenticated callers`, async () => {
      const res = await c.invoke(anonApp);
      expect(res.status).toBe(401);
    });
    it(`${c.label}: 403 for a non-admin (player) caller`, async () => {
      const res = await c.invoke(playerApp);
      expect(res.status).toBe(403);
    });
  }

  it("non-admins cannot trigger send-now (mailer is never invoked)", async () => {
    await clearForecastFixtures();
    await seedCompletedForecast();
    await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency: "weekly",
      recipients: ["finance@example.com"],
      enabled: true,
      nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdByUserId: adminUserId,
    });

    const res = await request(playerApp).post(`${BASE()}/send-now`);
    expect(res.status).toBe(403);
    expect(mailerMock).not.toHaveBeenCalled();
  });
});
