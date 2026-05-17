/**
 * Task #1967 — Route-level tests for the two admin "WoW drift" GET endpoints.
 *
 *   • GET /admin/wellness-reauth-wow-drift          (snapshot tile, Task #1324)
 *   • GET /admin/wellness-reauth-wow-drift-history  (trend chart,   Task #1577)
 *
 * The lib helpers `getWeeklyReauthDriftSnapshot` and
 * `getWeeklyReauthDriftHistory` already have integration coverage in
 * `lib/__tests__/wellness-reauth-wow-drift-*.test.ts` (window math, threshold
 * clamping, etc.). What was missing — and what this file pins down — is the
 * *route* layer: auth gating per role, query-string parsing, and the helper
 * call shape, all exercised against the express router itself.
 *
 * Mocking pattern mirrors `admin-recap-broadcasts.test.ts`: stub `@workspace/db`
 * so admin.ts can import without a live DB, neutralize the lib side-effect
 * imports (mailer, wearable helpers we don't care about, etc.), and replace
 * the two drift helpers with `vi.fn`s so we can capture the args the route
 * forwarded and return canned shapes for the response body assertions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const hoisted = vi.hoisted(() => ({
  snapshotMock: vi.fn(),
  historyMock: vi.fn(),
}));

vi.mock("@workspace/db", () => {
  // The drift routes never touch `db` directly — the lib helpers do, and
  // those helpers are mocked below. We still have to expose every
  // table/column admin.ts (and the adminEventMuteRegistry it walks at
  // import-time) references, otherwise the import crashes before any
  // route is registered.
  const buildSelectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.leftJoin = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => Promise.resolve([]);
    chain.offset = () => Promise.resolve([]);
    return chain;
  };
  return {
    db: { select: () => buildSelectChain() },
    organizationsTable: { id: {}, name: {}, wearableReauthWowAlertLastSentAt: {} },
    tournamentsTable: { status: {} },
    playersTable: {},
    appUsersTable: { id: {}, organizationId: {}, displayName: {}, username: {}, email: {} },
    clubCurrencyProfilesTable: { baseCurrency: {}, organizationId: {} },
    stripeWebhookDeliveriesTable: {},
    stripeWebhookSweepRunsTable: {},
    notificationAuditLogTable: {
      id: {},
      notificationKey: {},
      userId: {},
      channel: {},
      status: {},
      reason: {},
      payload: {},
      createdAt: {},
    },
    recapBroadcastsTable: {
      year: {},
      period: {},
      day: {},
      recipients: {},
      sentAt: {},
    },
    recapShareEventsTable: { id: {} },
    recapShareDailyAggregatesTable: {},
    wearableReauthWowAcknowledgmentsTable: {},
    swingVideoFpsProbesTable: {},
    orgMembershipsTable: { userId: {}, organizationId: {} },
    userNotificationPrefsTable: new Proxy({}, { get: () => ({}) }),
  };
});

vi.mock("../lib/mailer", () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
  validateMailerConfig: () => true,
}));

// The two drift helpers are the only things the routes under test actually
// call. Replace them with vi.fn so we can both (a) capture the args the
// route forwarded and (b) return canned shapes the JSON-pass-through can be
// asserted against. The other exports are passive constants admin.ts pulls
// in at import time — keep them in sync with `WELLNESS_REAUTH_WOW_*` so the
// route's `?? DEFAULT` fallback resolves to the real default.
vi.mock("../lib/wearables", () => ({
  getLastWellnessSweepResult: async () => null,
  getWellnessSweepHistory: async () => [],
  getWeeklyReauthDriftSnapshot: hoisted.snapshotMock,
  getWeeklyReauthDriftHistory: hoisted.historyMock,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_COUNT: 1,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_SHARE_PCT: 1,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_ATTEMPTED: 1,
  WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA: 0.05,
  WELLNESS_REAUTH_WOW_HISTORY_DEFAULT_WEEKS: 8,
}));

vi.mock("../lib/stripeWebhookSweepStatus", () => ({
  getLastStripeWebhookSweepResult: async () => null,
  isStripeWebhookSweepStale: () => false,
  STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS: 36 * 60 * 60 * 1000,
}));

vi.mock("../lib/notifyDispatch", () => ({
  previewNotificationTemplate: async () => null,
}));

vi.mock("../lib/notificationRegistry", () => ({
  listRegistered: () => [],
}));

const { default: adminRouter } = await import("../routes/admin");

function buildApp(user: { id: number; role: string; organizationId?: number | null } | null) {
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

const SNAPSHOT_FIXTURE = {
  evaluatedAt: "2026-04-30T00:00:00.000Z",
  windowDays: 7,
  rateLimitDays: 7,
  thisWeek: { runs: 10, averageNeedsReauth: 0.4, totalNeedsReauth: 4 },
  lastWeek: { runs: 9, averageNeedsReauth: 0.2, totalNeedsReauth: 2 },
  delta: 0.2,
  threshold: 0.05,
  minRuns: 5,
  hasSufficientData: true,
  exceedsThreshold: true,
  org: {
    id: 42,
    name: "Pebble Beach GC",
    lastSentAt: "2026-04-23T00:00:00.000Z",
    nextEligibleAt: "2026-04-30T00:00:00.000Z",
    lastAcknowledgment: null,
  },
};

const HISTORY_FIXTURE = {
  evaluatedAt: "2026-04-30T00:00:00.000Z",
  windowDays: 7,
  weeks: 8,
  threshold: 0.05,
  minRuns: 5,
  buckets: [
    { weekStart: "2026-03-05T00:00:00.000Z", weekEnd: "2026-03-12T00:00:00.000Z", runs: 7, averageNeedsReauth: 0.10, totalNeedsReauth: 1, hasSufficientData: true },
    { weekStart: "2026-03-12T00:00:00.000Z", weekEnd: "2026-03-19T00:00:00.000Z", runs: 7, averageNeedsReauth: 0.12, totalNeedsReauth: 1, hasSufficientData: true },
    { weekStart: "2026-03-19T00:00:00.000Z", weekEnd: "2026-03-26T00:00:00.000Z", runs: 8, averageNeedsReauth: 0.15, totalNeedsReauth: 1, hasSufficientData: true },
    { weekStart: "2026-03-26T00:00:00.000Z", weekEnd: "2026-04-02T00:00:00.000Z", runs: 8, averageNeedsReauth: 0.18, totalNeedsReauth: 1, hasSufficientData: true },
    { weekStart: "2026-04-02T00:00:00.000Z", weekEnd: "2026-04-09T00:00:00.000Z", runs: 9, averageNeedsReauth: 0.20, totalNeedsReauth: 2, hasSufficientData: true },
    { weekStart: "2026-04-09T00:00:00.000Z", weekEnd: "2026-04-16T00:00:00.000Z", runs: 9, averageNeedsReauth: 0.25, totalNeedsReauth: 2, hasSufficientData: true },
    { weekStart: "2026-04-16T00:00:00.000Z", weekEnd: "2026-04-23T00:00:00.000Z", runs: 10, averageNeedsReauth: 0.30, totalNeedsReauth: 3, hasSufficientData: true },
    { weekStart: "2026-04-23T00:00:00.000Z", weekEnd: "2026-04-30T00:00:00.000Z", runs: 10, averageNeedsReauth: 0.40, totalNeedsReauth: 4, hasSufficientData: true },
  ],
};

beforeEach(() => {
  hoisted.snapshotMock.mockReset();
  hoisted.snapshotMock.mockResolvedValue(SNAPSHOT_FIXTURE);
  hoisted.historyMock.mockReset();
  hoisted.historyMock.mockResolvedValue(HISTORY_FIXTURE);
});

describe("GET /admin/wellness-reauth-wow-drift", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = buildApp(null);
    const res = await request(app).get("/admin/wellness-reauth-wow-drift");
    expect(res.status).toBe(401);
    expect(hoisted.snapshotMock).not.toHaveBeenCalled();
  });

  it("rejects non-admin members with 403", async () => {
    const app = buildApp({ id: 7, role: "member", organizationId: 1 });
    const res = await request(app).get("/admin/wellness-reauth-wow-drift");
    expect(res.status).toBe(403);
    expect(hoisted.snapshotMock).not.toHaveBeenCalled();
  });

  it("allows org_admin / super_admin / tournament_director and returns the helper's snapshot verbatim", async () => {
    for (const role of ["org_admin", "super_admin", "tournament_director"] as const) {
      hoisted.snapshotMock.mockClear();
      const app = buildApp({ id: 1, role, organizationId: 42 });
      const res = await request(app).get("/admin/wellness-reauth-wow-drift");
      expect(res.status, `role=${role}`).toBe(200);
      // JSON pass-through preserves the helper's exact shape (dates are
      // already ISO strings in the fixture, so no Date round-trip drift).
      expect(res.body).toEqual(SNAPSHOT_FIXTURE);
      expect(hoisted.snapshotMock).toHaveBeenCalledTimes(1);
    }
  });

  it("forwards the caller's organizationId to the helper", async () => {
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 42 });
    await request(app).get("/admin/wellness-reauth-wow-drift");
    expect(hoisted.snapshotMock).toHaveBeenCalledWith(42);
  });

  it("forwards null when the caller has no organizationId (super_admin not scoped to an org)", async () => {
    const app = buildApp({ id: 1, role: "super_admin" });
    await request(app).get("/admin/wellness-reauth-wow-drift");
    expect(hoisted.snapshotMock).toHaveBeenCalledWith(null);
  });

  it("returns 500 when the helper throws", async () => {
    hoisted.snapshotMock.mockRejectedValueOnce(new Error("kaboom"));
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 42 });
    const res = await request(app).get("/admin/wellness-reauth-wow-drift");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load week-over-week drift snapshot" });
  });
});

describe("GET /admin/wellness-reauth-wow-drift-history", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = buildApp(null);
    const res = await request(app).get("/admin/wellness-reauth-wow-drift-history");
    expect(res.status).toBe(401);
    expect(hoisted.historyMock).not.toHaveBeenCalled();
  });

  it("rejects non-admin members with 403", async () => {
    const app = buildApp({ id: 7, role: "member", organizationId: 1 });
    const res = await request(app).get("/admin/wellness-reauth-wow-drift-history");
    expect(res.status).toBe(403);
    expect(hoisted.historyMock).not.toHaveBeenCalled();
  });

  it("allows org_admin / super_admin / tournament_director and returns the helper's payload verbatim", async () => {
    for (const role of ["org_admin", "super_admin", "tournament_director"] as const) {
      hoisted.historyMock.mockClear();
      const app = buildApp({ id: 1, role, organizationId: 42 });
      const res = await request(app).get("/admin/wellness-reauth-wow-drift-history");
      expect(res.status, `role=${role}`).toBe(200);
      expect(res.body).toEqual(HISTORY_FIXTURE);
      expect(hoisted.historyMock).toHaveBeenCalledTimes(1);
    }
  });

  it("forwards the default weeks value (8) when ?weeks is omitted", async () => {
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 42 });
    await request(app).get("/admin/wellness-reauth-wow-drift-history");
    expect(hoisted.historyMock).toHaveBeenCalledWith({ weeks: 8 });
  });

  it("forwards a finite numeric ?weeks=N to the helper unchanged (clamping is the helper's job)", async () => {
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 42 });

    await request(app).get("/admin/wellness-reauth-wow-drift-history?weeks=4");
    expect(hoisted.historyMock).toHaveBeenLastCalledWith({ weeks: 4 });

    await request(app).get("/admin/wellness-reauth-wow-drift-history?weeks=12");
    expect(hoisted.historyMock).toHaveBeenLastCalledWith({ weeks: 12 });

    // Above the helper's MAX_WEEKS (26) — the route still forwards as-is;
    // the helper is the one that clamps. Round-trip the value to prove
    // the route did not silently drop / coerce it.
    await request(app).get("/admin/wellness-reauth-wow-drift-history?weeks=999");
    expect(hoisted.historyMock).toHaveBeenLastCalledWith({ weeks: 999 });
  });

  it("forwards `undefined` for non-numeric ?weeks (helper falls back to default rather than 4xx-ing)", async () => {
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 42 });
    await request(app).get("/admin/wellness-reauth-wow-drift-history?weeks=not-a-number");
    expect(hoisted.historyMock).toHaveBeenLastCalledWith({ weeks: undefined });
  });

  it("response shape matches WeeklyReauthDriftHistoryResult (oldest-first buckets + threshold + windowDays)", async () => {
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get("/admin/wellness-reauth-wow-drift-history");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      evaluatedAt: expect.any(String),
      windowDays: 7,
      weeks: 8,
      threshold: 0.05,
      minRuns: 5,
    });
    expect(Array.isArray(res.body.buckets)).toBe(true);
    expect(res.body.buckets).toHaveLength(8);
    // Oldest-first ordering must survive JSON pass-through.
    const firstStart = new Date(res.body.buckets[0].weekStart).getTime();
    const lastStart = new Date(res.body.buckets[res.body.buckets.length - 1].weekStart).getTime();
    expect(firstStart).toBeLessThan(lastStart);
    // Each bucket exposes the trend-chart-required fields.
    for (const b of res.body.buckets) {
      expect(b).toMatchObject({
        weekStart: expect.any(String),
        weekEnd: expect.any(String),
        runs: expect.any(Number),
        averageNeedsReauth: expect.any(Number),
        totalNeedsReauth: expect.any(Number),
        hasSufficientData: expect.any(Boolean),
      });
    }
  });

  it("returns 500 when the helper throws", async () => {
    hoisted.historyMock.mockRejectedValueOnce(new Error("kaboom"));
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 42 });
    const res = await request(app).get("/admin/wellness-reauth-wow-drift-history");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load week-over-week drift history" });
  });
});
