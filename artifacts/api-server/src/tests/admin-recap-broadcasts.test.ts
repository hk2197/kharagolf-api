/**
 * Task #1276 — Regression test for the admin recap-broadcasts history endpoint.
 *
 * The admin "Year-in-Golf launch history" page reads from
 * `GET /admin/recap-broadcasts`. This test pins down:
 *   • Auth gating: 401 when unauthenticated, 403 for non-admin roles.
 *   • Successful response shape: `{ broadcasts: [...], limit }` ordered
 *     by sent_at desc (the route asks Drizzle for that order, and we
 *     verify it survives the JSON pass-through).
 *   • The `limit` query param: clamped to 1..200, defaults to 50.
 *
 * The DB is mocked so the test exercises only the routing / parsing logic
 * in routes/admin.ts; lib side-effects (mailer / wearables) are stubbed to
 * keep import-time work inert.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const hoisted = vi.hoisted(() => ({
  recapRows: [] as unknown[],
  recipientRows: [] as unknown[],
  recipientCount: 0 as number,
  capturedLimit: null as number | null,
  capturedRecipientWhere: null as unknown,
  capturedRecipientLimit: null as number | null,
  capturedRecipientOffset: null as number | null,
  capturedRecipientCountWhere: null as unknown,
}));

vi.mock("@workspace/db", () => {
  // Three select chains live behind one factory:
  //   • Recap-broadcasts list — no joins, resolves on `.limit()`.
  //   • Recipients page query — joins through `leftJoin`, resolves on
  //     `.offset()` after `.limit()` (Task #1839 added the offset).
  //   • Recipients count query — joins through `leftJoin`, resolves on
  //     `.where()` because count selects don't paginate.
  // We capture the where clause / limit / offset on each chain so tests
  // can assert the (year, period, day, organizationId) filter, the page
  // size, and the offset all survived param parsing.
  const buildSelectChain = (selectArg?: unknown) => {
    const chain: Record<string, unknown> = {};
    let usedJoin = false;
    const isCountQuery = !!selectArg
      && typeof selectArg === "object"
      && Object.keys(selectArg as Record<string, unknown>).length === 1
      && "value" in (selectArg as Record<string, unknown>);
    chain.from = () => chain;
    chain.leftJoin = () => { usedJoin = true; return chain; };
    chain.where = (w: unknown) => {
      if (isCountQuery) {
        hoisted.capturedRecipientCountWhere = w;
        return Promise.resolve([{ value: hoisted.recipientCount }]);
      }
      if (usedJoin) hoisted.capturedRecipientWhere = w;
      return chain;
    };
    chain.orderBy = () => chain;
    chain.limit = (n: number) => {
      if (usedJoin) {
        hoisted.capturedRecipientLimit = n;
        // The recipients page query keeps chaining into `.offset()`; the
        // broadcast-list query terminates here, so it returns a promise.
        return chain;
      }
      hoisted.capturedLimit = n;
      return Promise.resolve(hoisted.recapRows);
    };
    chain.offset = (o: number) => {
      hoisted.capturedRecipientOffset = o;
      return Promise.resolve(hoisted.recipientRows);
    };
    return chain;
  };
  return {
    db: { select: (arg?: unknown) => buildSelectChain(arg) },
    organizationsTable: { id: {}, name: {} },
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
    // Other tables/columns transitively imported by admin.ts and the
    // adminEventMuteRegistry. They aren't exercised by these tests, but
    // the registry walks them at import-time so we have to expose every
    // referenced column as a stub object.
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

vi.mock("../lib/wearables", () => ({
  getLastWellnessSweepResult: async () => null,
  getWellnessSweepHistory: async () => [],
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_COUNT: 1,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_SHARE_PCT: 1,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_ATTEMPTED: 1,
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
  hoisted.recapRows = [];
  hoisted.recipientRows = [];
  hoisted.recipientCount = 0;
  hoisted.capturedLimit = null;
  hoisted.capturedRecipientWhere = null;
  hoisted.capturedRecipientLimit = null;
  hoisted.capturedRecipientOffset = null;
  hoisted.capturedRecipientCountWhere = null;
});

describe("GET /admin/recap-broadcasts", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = buildApp(null);
    const res = await request(app).get("/admin/recap-broadcasts");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin members with 403", async () => {
    const app = buildApp({ id: 7, role: "member", organizationId: 1 });
    const res = await request(app).get("/admin/recap-broadcasts");
    expect(res.status).toBe(403);
  });

  it("returns recent recap broadcasts ordered by sent_at desc", async () => {
    const sentAtNewer = new Date("2026-01-07T12:00:00.000Z");
    const sentAtOlder = new Date("2026-01-04T12:00:00.000Z");
    const sentAtOldest = new Date("2026-01-01T12:00:00.000Z");
    // The route asks Drizzle to order by sent_at desc; we mirror that
    // ordering in the mocked rows so the JSON pass-through preserves
    // newest-first.
    hoisted.recapRows = [
      { year: 2025, period: "year", day: 7, recipients: 412, sentAt: sentAtNewer },
      { year: 2025, period: "year", day: 4, recipients: 415, sentAt: sentAtOlder },
      { year: 2025, period: "year", day: 1, recipients: 420, sentAt: sentAtOldest },
    ];

    const app = buildApp({ id: 1, role: "org_admin", organizationId: 42 });
    const res = await request(app).get("/admin/recap-broadcasts");

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
    expect(Array.isArray(res.body.broadcasts)).toBe(true);
    expect(res.body.broadcasts).toHaveLength(3);

    const [first, second, third] = res.body.broadcasts;
    expect(first).toMatchObject({ year: 2025, period: "year", day: 7, recipients: 412 });
    expect(second).toMatchObject({ year: 2025, period: "year", day: 4, recipients: 415 });
    expect(third).toMatchObject({ year: 2025, period: "year", day: 1, recipients: 420 });
    expect(new Date(first.sentAt).getTime()).toBe(sentAtNewer.getTime());
    expect(new Date(third.sentAt).getTime()).toBe(sentAtOldest.getTime());
  });

  it("allows super_admin and tournament_director roles", async () => {
    for (const role of ["super_admin", "tournament_director"] as const) {
      hoisted.recapRows = [];
      const app = buildApp({ id: 2, role });
      const res = await request(app).get("/admin/recap-broadcasts");
      expect(res.status, `role=${role}`).toBe(200);
      expect(res.body.broadcasts).toEqual([]);
    }
  });

  it("respects the limit query param and clamps it to 200", async () => {
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 42 });

    await request(app).get("/admin/recap-broadcasts?limit=10");
    expect(hoisted.capturedLimit).toBe(10);

    await request(app).get("/admin/recap-broadcasts?limit=10000");
    expect(hoisted.capturedLimit).toBe(200);

    // Garbage / non-numeric falls back to the default (50).
    await request(app).get("/admin/recap-broadcasts?limit=not-a-number");
    expect(hoisted.capturedLimit).toBe(50);

    // Zero / negative also falls back to the default rather than asking
    // the DB for 0 rows.
    await request(app).get("/admin/recap-broadcasts?limit=0");
    expect(hoisted.capturedLimit).toBe(50);
    await request(app).get("/admin/recap-broadcasts?limit=-3");
    expect(hoisted.capturedLimit).toBe(50);
  });
});

// Task #1496 — drill-down endpoint that returns the per-recipient
// dispatch records for a single (year, period, day) recap broadcast.
describe("GET /admin/recap-broadcasts/recipients", () => {
  const validQuery = "year=2025&period=year&day=1";

  it("rejects unauthenticated callers with 401", async () => {
    const app = buildApp(null);
    const res = await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}`);
    expect(res.status).toBe(401);
  });

  it("rejects non-admin members with 403", async () => {
    const app = buildApp({ id: 7, role: "member", organizationId: 1 });
    const res = await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}`);
    expect(res.status).toBe(403);
  });

  it("returns 400 when year is missing or non-numeric", async () => {
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 1 });
    const missing = await request(app).get("/admin/recap-broadcasts/recipients?period=year&day=1");
    expect(missing.status).toBe(400);
    const garbage = await request(app).get("/admin/recap-broadcasts/recipients?year=abc&period=year&day=1");
    expect(garbage.status).toBe(400);
  });

  it("returns 400 when period is unknown", async () => {
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 1 });
    const res = await request(app).get("/admin/recap-broadcasts/recipients?year=2025&period=Q5&day=1");
    expect(res.status).toBe(400);
  });

  it("returns 400 when day is out of range", async () => {
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 1 });
    const tooLow = await request(app).get("/admin/recap-broadcasts/recipients?year=2025&period=year&day=0");
    expect(tooLow.status).toBe(400);
    const tooHigh = await request(app).get("/admin/recap-broadcasts/recipients?year=2025&period=year&day=99");
    expect(tooHigh.status).toBe(400);
  });

  it("returns the recipient list with shape { year, period, day, recipients, page, total, ... }", async () => {
    hoisted.recipientRows = [
      {
        id: 11, userId: 100, channel: "push", status: "sent", reason: null,
        createdAt: new Date("2026-01-01T12:00:00.000Z"),
        username: "alice", displayName: "Alice", email: "alice@example.test",
        organizationId: 9, organizationName: "Pebble Beach GC",
      },
      {
        id: 12, userId: 101, channel: "push", status: "sent", reason: null,
        createdAt: new Date("2026-01-01T12:00:01.000Z"),
        username: "bob", displayName: "Bob", email: "bob@example.test",
        organizationId: 9, organizationName: "Pebble Beach GC",
      },
    ];
    hoisted.recipientCount = 2;
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get("/admin/recap-broadcasts/recipients?year=2025&period=q4&day=4");
    expect(res.status).toBe(200);
    expect(res.body.year).toBe(2025);
    expect(res.body.period).toBe("q4");
    expect(res.body.day).toBe(4);
    expect(res.body.limit).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.total).toBe(2);
    expect(Array.isArray(res.body.recipients)).toBe(true);
    expect(res.body.recipients).toHaveLength(2);
    const [first, second] = res.body.recipients;
    expect(first).toMatchObject({
      userId: 100,
      username: "alice",
      displayName: "Alice",
      email: "alice@example.test",
      organizationId: 9,
      organizationName: "Pebble Beach GC",
      channel: "push",
      status: "sent",
    });
    expect(second).toMatchObject({ userId: 101, username: "bob" });
  });

  it("returns an empty list (no DB call) for org_admin without an organization", async () => {
    const app = buildApp({ id: 1, role: "org_admin" });
    const res = await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}`);
    expect(res.status).toBe(200);
    expect(res.body.recipients).toEqual([]);
    // The misconfigured-admin shortcut still has to expose pagination
    // fields so clients don't special-case the empty response shape.
    expect(res.body.total).toBe(0);
    expect(res.body.page).toBe(1);
    // Confirm we short-circuited before issuing the DB query.
    expect(hoisted.capturedRecipientLimit).toBeNull();
    expect(hoisted.capturedRecipientOffset).toBeNull();
  });

  it("clamps the limit param to 1000 and falls back to 200 for garbage", async () => {
    const app = buildApp({ id: 1, role: "super_admin" });
    await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}&limit=50`);
    expect(hoisted.capturedRecipientLimit).toBe(50);
    await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}&limit=99999`);
    expect(hoisted.capturedRecipientLimit).toBe(1000);
    await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}&limit=not-a-number`);
    expect(hoisted.capturedRecipientLimit).toBe(200);
  });

  it("rejects super_admin's organizationId param when it isn't an integer", async () => {
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}&organizationId=abc`);
    expect(res.status).toBe(400);
  });

  it("echoes the organizationId for super_admin when provided", async () => {
    hoisted.recipientRows = [];
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}&organizationId=42`);
    expect(res.status).toBe(200);
    expect(res.body.organizationId).toBe(42);
  });

  it("auto-scopes org_admin to their own organization (echoed in the response)", async () => {
    hoisted.recipientRows = [];
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 7 });
    // Even if the caller tries to pass a different org, the response
    // should reflect their own org — the route ignores the param for
    // non-super_admin callers.
    const res = await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}&organizationId=999`);
    expect(res.status).toBe(200);
    expect(res.body.organizationId).toBe(7);
  });

  // --- Task #1839: pagination + total ---------------------------------

  it("defaults page to 1 with offset 0 when ?page is omitted", async () => {
    hoisted.recipientCount = 0;
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}&limit=100`);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(hoisted.capturedRecipientLimit).toBe(100);
    expect(hoisted.capturedRecipientOffset).toBe(0);
  });

  it("translates ?page into a (page-1)*limit offset", async () => {
    hoisted.recipientCount = 5_000;
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}&limit=200&page=4`);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(4);
    expect(res.body.limit).toBe(200);
    expect(hoisted.capturedRecipientLimit).toBe(200);
    expect(hoisted.capturedRecipientOffset).toBe(600); // (4 - 1) * 200
  });

  it("falls back to page 1 for non-numeric or non-positive ?page values", async () => {
    const app = buildApp({ id: 1, role: "super_admin" });

    await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}&page=not-a-number`);
    expect(hoisted.capturedRecipientOffset).toBe(0);

    await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}&page=0`);
    expect(hoisted.capturedRecipientOffset).toBe(0);

    await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}&page=-2`);
    expect(hoisted.capturedRecipientOffset).toBe(0);
  });

  it("returns the full total even when only one page of rows fits", async () => {
    // Simulate a platform-wide annual recap: 23,500 recipients, the
    // caller asked for the first 1000-row page.
    hoisted.recipientRows = new Array(1000).fill(null).map((_, i) => ({
      id: i + 1, userId: 1000 + i, channel: "push", status: "sent", reason: null,
      createdAt: new Date("2026-01-01T12:00:00.000Z"),
      username: `u${i}`, displayName: `User ${i}`, email: `u${i}@ex.test`,
      organizationId: 1, organizationName: "Club A",
    }));
    hoisted.recipientCount = 23_500;
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}&limit=1000`);
    expect(res.status).toBe(200);
    expect(res.body.recipients).toHaveLength(1000);
    expect(res.body.total).toBe(23_500);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(1000);
  });

  it("returns an empty page (with the real total) when paged past the end", async () => {
    hoisted.recipientRows = []; // no rows beyond the end
    hoisted.recipientCount = 250; // but the total still reflects reality
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get(`/admin/recap-broadcasts/recipients?${validQuery}&limit=200&page=99`);
    expect(res.status).toBe(200);
    expect(res.body.recipients).toEqual([]);
    expect(res.body.total).toBe(250);
    expect(res.body.page).toBe(99);
    expect(hoisted.capturedRecipientOffset).toBe(19_600); // (99 - 1) * 200
  });
});
