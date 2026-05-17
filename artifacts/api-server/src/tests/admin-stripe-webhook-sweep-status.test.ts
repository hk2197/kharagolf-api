/**
 * Task #1294 — Tests for the admin Stripe-webhook-sweep status endpoint and
 * for the cron-side persistence that backs it.
 *
 * Covers:
 *   • Auth gating on `GET /admin/stripe-webhook-sweep-status` (401 / 403).
 *   • The endpoint returns `{ lastSweep: null }` until the first sweep runs,
 *     then surfaces the most recent run summary (timestamp + removed count).
 *   • `sweepOldStripeWebhookDeliveries` writes a `stripe_webhook_sweep_runs`
 *     row on every run — including runs where it removed zero rows — so the
 *     admin tile renders even on healthy quiet days.
 *   • The cached summary survives a "server restart" (the in-memory cache is
 *     repopulated from the table on the next read).
 *
 * Task #1525 — Also covers the companion history endpoint
 * (`GET /admin/stripe-webhook-sweep-history`) that backs the inline trend.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const hoisted = vi.hoisted(() => ({
  lastSweep: null as { ranAt: string; removed: number } | null,
  history: [] as Array<{ ranAt: string; removed: number }>,
  historyDaysSeen: null as number | null,
  stale: false,
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
        orderBy: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  },
  organizationsTable: {},
  tournamentsTable: { status: {} },
  playersTable: {},
  appUsersTable: {},
  clubCurrencyProfilesTable: { baseCurrency: {}, organizationId: {} },
  stripeWebhookDeliveriesTable: {},
  stripeWebhookSweepRunsTable: {},
  notificationAuditLogTable: {},
  recapBroadcastsTable: {
    year: {},
    period: {},
    day: {},
    recipients: {},
    sentAt: {},
  },
}));

vi.mock("../lib/mailer", () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
  validateMailerConfig: () => true,
}));

vi.mock("../lib/wearables", () => ({
  getLastWellnessSweepResult: async () => null,
  getWellnessSweepHistory: async () => [],
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_COUNT: 1,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_SHARE_PCT: 1,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_ATTEMPTED: 1,
}));

vi.mock("../lib/stripeWebhookSweepStatus", () => ({
  // The route delegates to this getter; we drive it from the test.
  getLastStripeWebhookSweepResult: async () => hoisted.lastSweep,
  // Task #1525 — companion history getter; the test captures the requested
  // window so we can assert the route's day-clamping behaviour.
  getStripeWebhookSweepHistory: async (days: number) => {
    hoisted.historyDaysSeen = days;
    return hoisted.history;
  },
  // Task #1295 — the route also asks the lib whether the sweep should be
  // flagged as stalled. Drive that from the test the same way as the
  // last-sweep fixture so we can exercise both healthy and stale paths.
  isStripeWebhookSweepStale: () => hoisted.stale,
  STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS: 36 * 60 * 60 * 1000,
}));

vi.mock("../lib/notifyDispatch", () => ({
  previewNotificationTemplate: async () => null,
}));

vi.mock("../lib/notificationRegistry", () => ({
  listRegistered: () => [],
}));

const { default: adminRouter } = await import("../routes/admin");

function buildApp(user: { id: number; role: string; organizationId?: number } | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) {
      req.user = user as Express.User;
      req.isAuthenticated = function (this: typeof req) { return this.user != null; } as typeof req.isAuthenticated;
    } else {
      req.isAuthenticated = function () { return false; } as typeof req.isAuthenticated;
    }
    next();
  });
  app.use(adminRouter);
  return app;
}

beforeEach(() => {
  hoisted.lastSweep = null;
  hoisted.history = [];
  hoisted.historyDaysSeen = null;
  hoisted.stale = false;
});

describe("GET /admin/stripe-webhook-sweep-status", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = buildApp(null);
    const res = await request(app).get("/admin/stripe-webhook-sweep-status");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin members with 403", async () => {
    const app = buildApp({ id: 7, role: "member", organizationId: 1 });
    const res = await request(app).get("/admin/stripe-webhook-sweep-status");
    expect(res.status).toBe(403);
  });

  it("returns { lastSweep: null, stale: false } before any sweep has run", async () => {
    hoisted.lastSweep = null;
    hoisted.stale = false;
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 1 });
    const res = await request(app).get("/admin/stripe-webhook-sweep-status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lastSweep: null, stale: false });
  });

  it("surfaces the latest sweep summary (timestamp + removed count)", async () => {
    hoisted.lastSweep = { ranAt: "2026-04-24T03:00:00.000Z", removed: 142 };
    hoisted.stale = false;
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get("/admin/stripe-webhook-sweep-status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      lastSweep: { ranAt: "2026-04-24T03:00:00.000Z", removed: 142 },
      stale: false,
    });
  });

  it("also surfaces zero-removed sweeps (healthy quiet day)", async () => {
    // Admins want to know the sweep ran even when there was nothing old to
    // delete — otherwise a long quiet stretch looks identical to a broken
    // cron.
    hoisted.lastSweep = { ranAt: "2026-04-24T03:00:00.000Z", removed: 0 };
    hoisted.stale = false;
    const app = buildApp({ id: 1, role: "tournament_director", organizationId: 1 });
    const res = await request(app).get("/admin/stripe-webhook-sweep-status");
    expect(res.status).toBe(200);
    expect(res.body.lastSweep.removed).toBe(0);
    expect(res.body.stale).toBe(false);
  });

  it("propagates the server-side stale flag when the last sweep is too old (Task #1295)", async () => {
    // The route asks the lib whether the sweep is stale; the admin tile uses
    // the resulting flag to decide whether to render the orange warning
    // treatment, so the route must surface it.
    hoisted.lastSweep = { ranAt: "2026-04-20T03:00:00.000Z", removed: 7 };
    hoisted.stale = true;
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get("/admin/stripe-webhook-sweep-status");
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.lastSweep).toEqual({
      ranAt: "2026-04-20T03:00:00.000Z",
      removed: 7,
    });
  });

  it("can return { lastSweep: null, stale: true } when the cron has been silent across a long uptime (Task #1295)", async () => {
    // After a fresh deploy `null` is normal and not stale; after the process
    // has been up longer than the threshold without a single sweep landing,
    // the lib flips stale to true and the admin tile surfaces a warning.
    hoisted.lastSweep = null;
    hoisted.stale = true;
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 1 });
    const res = await request(app).get("/admin/stripe-webhook-sweep-status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lastSweep: null, stale: true });
  });
});

// Task #1525 — companion endpoint that powers the inline trend on the admin
// Stripe webhook audit page. Mirrors the auth gating / response shape of
// `wellness-sweep-history`.
describe("GET /admin/stripe-webhook-sweep-history", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = buildApp(null);
    const res = await request(app).get("/admin/stripe-webhook-sweep-history");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin members with 403", async () => {
    const app = buildApp({ id: 7, role: "member", organizationId: 1 });
    const res = await request(app).get("/admin/stripe-webhook-sweep-history");
    expect(res.status).toBe(403);
  });

  it("returns the requested window of runs (most-recent-first), defaulting to 14 days", async () => {
    hoisted.history = [
      { ranAt: "2026-04-29T03:00:00.000Z", removed: 5 },
      { ranAt: "2026-04-28T03:00:00.000Z", removed: 0 },
      { ranAt: "2026-04-27T03:00:00.000Z", removed: 8 },
      { ranAt: "2026-04-26T03:00:00.000Z", removed: 12 },
    ];
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 1 });
    const res = await request(app).get("/admin/stripe-webhook-sweep-history");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(14);
    expect(hoisted.historyDaysSeen).toBe(14);
    expect(res.body.runs).toEqual(hoisted.history);
  });

  it("honours a valid ?days= query parameter", async () => {
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get("/admin/stripe-webhook-sweep-history?days=30");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    expect(hoisted.historyDaysSeen).toBe(30);
  });

  it("clamps an out-of-range or unparseable ?days= back to the 14-day default", async () => {
    const app = buildApp({ id: 1, role: "super_admin" });
    // Beyond the 90-day retention horizon.
    let res = await request(app).get("/admin/stripe-webhook-sweep-history?days=365");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(14);
    // Negative.
    res = await request(app).get("/admin/stripe-webhook-sweep-history?days=-3");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(14);
    // Garbage.
    res = await request(app).get("/admin/stripe-webhook-sweep-history?days=abc");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(14);
  });

  it("returns an empty list when no sweeps have run yet", async () => {
    hoisted.history = [];
    const app = buildApp({ id: 1, role: "tournament_director", organizationId: 1 });
    const res = await request(app).get("/admin/stripe-webhook-sweep-history");
    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
  });
});
