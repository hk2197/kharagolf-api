/**
 * Task #1534 — Tests for the admin Stripe-webhook-deliveries endpoint, with
 * particular focus on the new `failureCount` field that backs the small
 * count badge on the "Failures only" toggle in the admin UI.
 *
 * Covers:
 *   • Auth gating on `GET /admin/stripe-webhook-deliveries` (401 / 403).
 *   • The endpoint returns `{ deliveries, failureCount }`.
 *   • `failureCount` is computed independently of the active filter, so the
 *     badge stays accurate on both the "All" and "Failures only" views.
 *   • `failureCount` is `0` when nothing has failed (de-emphasised badge).
 *
 * Task #1898 — also covers the new `failureCountByReason` map that backs
 * the badge tooltip / inline summary so admins can tell *what kind* of
 * failures make up the count.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

type DeliveryRow = {
  id: number;
  eventId: string;
  eventType: string;
  receivedAt: string;
  sourceIp: string;
  signatureValid: boolean;
  applied: boolean;
  responseStatus: number;
  errorReason: string | null;
};

const hoisted = vi.hoisted(() => ({
  // The full set of rows the mocked `db.select(...).from(deliveries)` is
  // allowed to see. Tests mutate this between runs.
  rows: [] as DeliveryRow[],
  // Captured by the mocked `where()` so we can assert that the route applies
  // the failure filter when (and only when) the `?status=failures` query
  // string is supplied.
  whereCalls: 0,
  // Captured args to `limit()` so we can assert the route honours the
  // capped row limit.
  lastLimit: null as number | null,
  // Whether `select()` was called with a `count()` aggregator (used by the
  // failure-count branch).
  countSelectCalls: 0,
  // Task #1898 — Whether `select()` was called with the per-reason group
  // shape (used by the `failureCountByReason` branch). Helps us assert
  // the route only issues the breakdown query exactly once per request.
  reasonGroupSelectCalls: 0,
}));

function isFailure(row: DeliveryRow): boolean {
  return row.responseStatus >= 300 || row.signatureValid === false;
}

vi.mock("@workspace/db", () => {
  // Build a chainable query-builder stub that distinguishes the three
  // call shapes the route uses:
  //   1) select({ id, eventId, ... }).from(deliveries)[.where(failureCond)]
  //        .orderBy(...).limit(N) → list of rows
  //   2) select({ value: count() }).from(deliveries).where(failureCond)
  //        → [{ value: <number> }]
  //   3) select({ reason, n: count() }).from(deliveries).where(failureCond)
  //        .groupBy(errorReason) → [{ reason, n }, …] for the per-reason
  //        breakdown (Task #1898)
  const makeListChain = () => {
    // The route either calls `.where(failureCondition).orderBy(...).limit()`
    // (when the admin clicked "Failures only") or skips straight to
    // `.orderBy(...).limit()` (when the admin is on "All"). The presence of
    // a preceding `where()` is what tells us the failure filter is active.
    let filtered = false;
    const tail = {
      orderBy: () => ({
        limit: (n: number) => {
          hoisted.lastLimit = n;
          const rows = filtered
            ? hoisted.rows.filter(isFailure)
            : hoisted.rows;
          return Promise.resolve(rows.slice(0, n));
        },
      }),
    };
    return {
      where: () => {
        hoisted.whereCalls += 1;
        filtered = true;
        return tail;
      },
      orderBy: tail.orderBy,
    };
  };

  return {
    db: {
      select: (selection?: Record<string, unknown>) => {
        const isCountSelect =
          !!selection && Object.prototype.hasOwnProperty.call(selection, "value");
        const isReasonGroupSelect =
          !!selection
          && Object.prototype.hasOwnProperty.call(selection, "reason")
          && Object.prototype.hasOwnProperty.call(selection, "n");
        if (isReasonGroupSelect) {
          hoisted.reasonGroupSelectCalls += 1;
          return {
            from: () => ({
              where: () => ({
                groupBy: () => {
                  // Bucket failure rows by their `errorReason`, returning
                  // the same `[{ reason, n }, …]` shape the real
                  // Drizzle query produces.
                  const buckets = new Map<string | null, number>();
                  for (const row of hoisted.rows.filter(isFailure)) {
                    buckets.set(row.errorReason, (buckets.get(row.errorReason) ?? 0) + 1);
                  }
                  return Promise.resolve(
                    Array.from(buckets.entries()).map(([reason, n]) => ({ reason, n })),
                  );
                },
              }),
            }),
          };
        }
        if (isCountSelect) {
          hoisted.countSelectCalls += 1;
          return {
            from: () => ({
              where: () =>
                Promise.resolve([{ value: hoisted.rows.filter(isFailure).length }]),
            }),
          };
        }
        return {
          from: () => makeListChain(),
        };
      },
    },
    organizationsTable: {},
    tournamentsTable: { status: {} },
    playersTable: {},
    appUsersTable: {},
    clubCurrencyProfilesTable: { baseCurrency: {}, organizationId: {} },
    stripeWebhookDeliveriesTable: {
      id: {},
      eventId: {},
      eventType: {},
      receivedAt: {},
      sourceIp: {},
      signatureValid: {},
      applied: {},
      responseStatus: {},
      errorReason: {},
    },
    stripeWebhookSweepRunsTable: {},
    notificationAuditLogTable: {},
    // adminEventMuteRegistry imports `userNotificationPrefsTable` and reads
    // a handful of column references at module init time. We don't exercise
    // those columns in this suite, but they need to exist so the module
    // doesn't throw while it's being loaded.
    userNotificationPrefsTable: {
      notifyWalletRefundDigestFailed: {},
      notifySideGameReceiptDigestFailed: {},
      notifyLevyLedgerDigestFailed: {},
      notifyLevyLedgerOrgDigestFailed: {},
      notifyLevyRemindersDigestFailed: {},
      notifyCoachPayoutAccountChanges: {},
      notifyManualEntryAlerts: {},
      notifyErasureStorageDigest: {},
      notifyErasureStorageDigestPush: {},
      notifyMemberPrefsDigest: {},
      notifyExhaustionAdminDigestFailed: {},
      notifySilentAlertsDigest: {},
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
  getStripeWebhookSweepHistory: async () => [],
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
      req.isAuthenticated = function (this: typeof req) {
        return this.user != null;
      } as typeof req.isAuthenticated;
    } else {
      req.isAuthenticated = function () { return false; } as typeof req.isAuthenticated;
    }
    next();
  });
  app.use(adminRouter);
  return app;
}

function makeRow(overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    id: 1,
    eventId: "evt_1",
    eventType: "checkout.session.completed",
    receivedAt: new Date("2026-04-29T12:00:00Z").toISOString(),
    sourceIp: "3.18.12.63",
    signatureValid: true,
    applied: true,
    responseStatus: 200,
    errorReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.rows = [];
  hoisted.whereCalls = 0;
  hoisted.lastLimit = null;
  hoisted.countSelectCalls = 0;
  hoisted.reasonGroupSelectCalls = 0;
});

describe("GET /admin/stripe-webhook-deliveries", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = buildApp(null);
    const res = await request(app).get("/admin/stripe-webhook-deliveries");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin members with 403", async () => {
    const app = buildApp({ id: 7, role: "member", organizationId: 1 });
    const res = await request(app).get("/admin/stripe-webhook-deliveries");
    expect(res.status).toBe(403);
  });

  it("returns deliveries plus a failureCount badge value (Task #1534)", async () => {
    hoisted.rows = [
      makeRow({ id: 1, responseStatus: 200, signatureValid: true }),
      makeRow({ id: 2, responseStatus: 500, signatureValid: true, errorReason: "reconciliation_failed" }),
      makeRow({ id: 3, responseStatus: 400, signatureValid: false, errorReason: "signature_mismatch" }),
      makeRow({ id: 4, responseStatus: 200, signatureValid: true }),
      makeRow({ id: 5, responseStatus: 503, signatureValid: true }),
    ];
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 1 });
    const res = await request(app).get("/admin/stripe-webhook-deliveries");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.deliveries)).toBe(true);
    // No filter applied → the route returns the full window (capped at limit).
    expect(res.body.deliveries).toHaveLength(5);
    // failureCount counts the three failed rows independently of the filter.
    expect(res.body.failureCount).toBe(3);
    // The endpoint should query the count branch exactly once per request.
    expect(hoisted.countSelectCalls).toBe(1);
  });

  it("returns failureCountByReason summing to failureCount (Task #1898)", async () => {
    // Mix of reasons so the breakdown has more than one bucket. Two
    // signature_mismatch + one reconciliation_failed → admins should be
    // able to tell at a glance this is mostly a secret-rotation issue.
    hoisted.rows = [
      makeRow({ id: 1, responseStatus: 200, signatureValid: true }),
      makeRow({ id: 2, responseStatus: 400, signatureValid: false, errorReason: "signature_mismatch" }),
      makeRow({ id: 3, responseStatus: 400, signatureValid: false, errorReason: "signature_mismatch" }),
      makeRow({ id: 4, responseStatus: 500, signatureValid: true, errorReason: "reconciliation_failed" }),
    ];
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 1 });
    const res = await request(app).get("/admin/stripe-webhook-deliveries");
    expect(res.status).toBe(200);
    expect(res.body.failureCount).toBe(3);
    expect(res.body.failureCountByReason).toEqual({
      signature_mismatch: 2,
      reconciliation_failed: 1,
    });
    // Breakdown bucket counts must always sum back to failureCount so the
    // admin UI can rely on the invariant when rendering the inline summary.
    const sum = Object.values(res.body.failureCountByReason as Record<string, number>)
      .reduce((acc, n) => acc + n, 0);
    expect(sum).toBe(res.body.failureCount);
    // Breakdown query should run exactly once per request, alongside the
    // existing list + count queries (`Promise.all` of three branches).
    expect(hoisted.reasonGroupSelectCalls).toBe(1);
  });

  it("buckets failures with no errorReason under 'unknown' (Task #1898)", async () => {
    // A signature-invalid row with no errorReason captured (older row, or
    // a failure mode the worker didn't tag) should still appear in the
    // breakdown so the bucket counts continue to sum to failureCount.
    hoisted.rows = [
      makeRow({ id: 1, responseStatus: 500, signatureValid: true, errorReason: null }),
      makeRow({ id: 2, responseStatus: 400, signatureValid: false, errorReason: "signature_mismatch" }),
    ];
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get("/admin/stripe-webhook-deliveries");
    expect(res.status).toBe(200);
    expect(res.body.failureCount).toBe(2);
    expect(res.body.failureCountByReason).toEqual({
      unknown: 1,
      signature_mismatch: 1,
    });
  });

  it("returns an empty failureCountByReason map when nothing has failed (Task #1898)", async () => {
    hoisted.rows = [
      makeRow({ id: 1, responseStatus: 200, signatureValid: true }),
      makeRow({ id: 2, responseStatus: 200, signatureValid: true }),
    ];
    const app = buildApp({ id: 1, role: "tournament_director", organizationId: 1 });
    const res = await request(app).get("/admin/stripe-webhook-deliveries");
    expect(res.status).toBe(200);
    expect(res.body.failureCount).toBe(0);
    // An empty object (not `undefined`) so the UI can iterate without
    // null-guarding every render.
    expect(res.body.failureCountByReason).toEqual({});
  });

  it("keeps failureCountByReason accurate when filter=failures is active (Task #1898)", async () => {
    // The breakdown must reflect the underlying total — same as
    // failureCount — regardless of which view the admin is on, so
    // flipping the toggle doesn't change the tooltip's contents.
    hoisted.rows = [
      makeRow({ id: 1, responseStatus: 200, signatureValid: true }),
      makeRow({ id: 2, responseStatus: 502, signatureValid: true, errorReason: "reconciliation_failed" }),
      makeRow({ id: 3, responseStatus: 400, signatureValid: false, errorReason: "signature_mismatch" }),
    ];
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get(
      "/admin/stripe-webhook-deliveries?status=failures",
    );
    expect(res.status).toBe(200);
    expect(res.body.failureCountByReason).toEqual({
      reconciliation_failed: 1,
      signature_mismatch: 1,
    });
  });

  it("returns failureCount even when filter=failures is active so the badge stays accurate", async () => {
    hoisted.rows = [
      makeRow({ id: 1, responseStatus: 200, signatureValid: true }),
      makeRow({ id: 2, responseStatus: 500, signatureValid: true }),
      makeRow({ id: 3, responseStatus: 502, signatureValid: true }),
    ];
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).get(
      "/admin/stripe-webhook-deliveries?status=failures",
    );
    expect(res.status).toBe(200);
    // Filter is applied to the listed rows.
    expect(res.body.deliveries).toHaveLength(2);
    expect(res.body.deliveries.every((r: DeliveryRow) => isFailure(r))).toBe(true);
    // …but failureCount still reflects the underlying total, so the badge
    // value the admin saw before flipping the toggle continues to match.
    expect(res.body.failureCount).toBe(2);
  });

  it("returns failureCount: 0 when there is nothing to investigate", async () => {
    hoisted.rows = [
      makeRow({ id: 1, responseStatus: 200, signatureValid: true }),
      makeRow({ id: 2, responseStatus: 200, signatureValid: true }),
    ];
    const app = buildApp({ id: 1, role: "tournament_director", organizationId: 1 });
    const res = await request(app).get("/admin/stripe-webhook-deliveries");
    expect(res.status).toBe(200);
    expect(res.body.failureCount).toBe(0);
    // It must always be a number, never `undefined` — the UI treats `?? 0`
    // as a fallback but we want the contract to be explicit.
    expect(typeof res.body.failureCount).toBe("number");
  });

  it("honours the row limit (defaults to 10, caps at 50)", async () => {
    hoisted.rows = Array.from({ length: 60 }, (_, i) =>
      makeRow({ id: i + 1, responseStatus: i % 5 === 0 ? 500 : 200 }),
    );
    const app = buildApp({ id: 1, role: "super_admin" });
    // Default
    let res = await request(app).get("/admin/stripe-webhook-deliveries");
    expect(res.status).toBe(200);
    expect(hoisted.lastLimit).toBe(10);
    // Above the cap → capped to 50
    res = await request(app).get("/admin/stripe-webhook-deliveries?limit=999");
    expect(res.status).toBe(200);
    expect(hoisted.lastLimit).toBe(50);
  });
});
