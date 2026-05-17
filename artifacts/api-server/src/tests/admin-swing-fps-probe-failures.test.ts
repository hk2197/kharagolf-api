/**
 * Task #1705 — Admin diagnostics endpoints for the swing-video fps-probe
 * queue. Backs a small panel that lets admins triage rows the worker has
 * given up on after MAX_FPS_PROBE_ATTEMPTS (Task #1412 deliberately keeps
 * those rows in `swing_video_fps_probes`).
 *
 * Covers:
 *   • Auth gating on all three endpoints (401 / 403).
 *   • GET returns `{ failures, failureCount }`, only `failed` rows, with
 *     a truncated error preview alongside the full message.
 *   • POST `/reenqueue` deletes the failed row inside a transaction and
 *     re-enqueues a fresh probe via `enqueueFpsProbe` (so attempts reset
 *     to 0). Refuses non-failed rows with 409.
 *   • POST `/dismiss` deletes the failed row and 404s if it's already
 *     gone or has been re-enqueued in the meantime.
 *   • Invalid id (non-numeric / negative) is rejected with 400.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

interface ProbeRow {
  id: number;
  swingVideoId: number;
  objectPath: string;
  status: "queued" | "probing" | "done" | "failed";
  attempts: number;
  errorMessage: string | null;
  completedAt: Date | null;
  updatedAt: Date | null;
}

const hoisted = vi.hoisted(() => ({
  rows: [] as ProbeRow[],
  // Capture every db.delete() so each test can pin which probeId is
  // about to be deleted (the chainable stub doesn't have access to the
  // SQL it's pretending to run).
  pendingDeleteId: null as number | null,
  enqueueCalls: [] as Array<{ swingVideoId: number; objectPath: string; insideTx: boolean }>,
}));

vi.mock("@workspace/db", () => {
  const isFailed = (r: ProbeRow) => r.status === "failed";

  // --- top-level db.select({...}).from(t)... ---
  // Two call shapes:
  //   1) list:  select({ ... fields ... }).from(t).where(c).orderBy(o).limit(n)
  //   2) count: select({ value: count() }).from(t).where(c)
  function makeSelectChain(selection?: Record<string, unknown>) {
    const isCount = !!selection
      && Object.prototype.hasOwnProperty.call(selection, "value");

    if (isCount) {
      // Count branch: `.from().where()` resolves to [{ value: N }].
      return {
        from: () => ({
          where: () => Promise.resolve([{ value: hoisted.rows.filter(isFailed).length }]),
        }),
      };
    }

    // List branch: `.from().where().orderBy().limit()` resolves to rows.
    return {
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => Promise.resolve(hoisted.rows.filter(isFailed).slice(0, n)),
          }),
        }),
      }),
    };
  }

  // --- transaction(tx => …) executor used by reenqueue. ---
  // Reenqueue does:
  //   tx.select({id, swingVideoId, objectPath, status}).from(t)
  //     .where(eq(id, probeId)).for("update")  → [row | nothing]
  //   tx.delete(t).where(eq(id, probeId))      → ()
  // Plus the route awaits enqueueFpsProbe(swingVideoId, objectPath, tx).
  const txExecutor = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: (_mode: string) => {
            const id = hoisted.pendingDeleteId;
            if (id == null) return Promise.resolve([]);
            const row = hoisted.rows.find(r => r.id === id);
            return Promise.resolve(row ? [row] : []);
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => {
        const id = hoisted.pendingDeleteId;
        if (id != null) hoisted.rows = hoisted.rows.filter(r => r.id !== id);
        return Promise.resolve();
      },
    }),
  };

  return {
    db: {
      select: (selection?: Record<string, unknown>) => makeSelectChain(selection),
      // dismiss path: `db.delete(t).where(and(...)).returning({...})`
      delete: () => ({
        where: () => ({
          returning: () => {
            const id = hoisted.pendingDeleteId;
            if (id == null) return Promise.resolve([]);
            const target = hoisted.rows.find(r => r.id === id && r.status === "failed");
            if (!target) return Promise.resolve([]);
            hoisted.rows = hoisted.rows.filter(r => r.id !== target.id);
            return Promise.resolve([{ id: target.id, swingVideoId: target.swingVideoId }]);
          },
        }),
      }),
      transaction: async <T>(fn: (tx: typeof txExecutor) => Promise<T>): Promise<T> => fn(txExecutor),
    },
    // Schema shims — opaque tokens accepted by the chainable stub above.
    organizationsTable: {},
    tournamentsTable: { status: {} },
    playersTable: {},
    appUsersTable: {},
    clubCurrencyProfilesTable: { baseCurrency: {}, organizationId: {} },
    stripeWebhookDeliveriesTable: {
      id: {}, eventId: {}, eventType: {}, receivedAt: {}, sourceIp: {},
      signatureValid: {}, applied: {}, responseStatus: {}, errorReason: {},
    },
    notificationAuditLogTable: {},
    recapBroadcastsTable: { year: {}, period: {}, day: {}, recipients: {}, sentAt: {} },
    recapShareEventsTable: { id: {} },
    recapShareDailyAggregatesTable: {},
    wearableReauthWowAcknowledgmentsTable: {},
    swingVideoFpsProbesTable: {
      id: {},
      swingVideoId: {},
      objectPath: {},
      status: {},
      attempts: {},
      errorMessage: {},
      completedAt: {},
      updatedAt: {},
    },
  };
});

vi.mock("../lib/swingFpsProbeQueue", () => ({
  enqueueFpsProbe: vi.fn(async (swingVideoId: number, objectPath: string, executor?: unknown) => {
    hoisted.enqueueCalls.push({
      swingVideoId,
      objectPath,
      // Reenqueue must pass the open tx as the third arg so the
      // delete + re-enqueue land atomically.
      insideTx: !!executor,
    });
  }),
}));

vi.mock("../lib/mailer", () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
  validateMailerConfig: () => true,
}));
vi.mock("../lib/wearables", () => ({
  getLastWellnessSweepResult: async () => null,
  getWellnessSweepHistory: async () => [],
  getWeeklyReauthDriftSnapshot: async () => null,
  getWeeklyReauthDriftHistory: async () => null,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_COUNT: 1,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_SHARE_PCT: 1,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_ATTEMPTED: 1,
  WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA: 1,
  WELLNESS_REAUTH_WOW_HISTORY_DEFAULT_WEEKS: 8,
}));
vi.mock("../lib/stripeWebhookSweepStatus", () => ({
  getLastStripeWebhookSweepResult: async () => null,
  getStripeWebhookSweepHistory: async () => [],
  isStripeWebhookSweepStale: () => false,
}));
vi.mock("../lib/notifyDispatch", () => ({
  previewNotificationTemplate: async () => null,
}));
vi.mock("../lib/notificationRegistry", () => ({
  listRegistered: () => [],
  listRegisteredDetails: () => [],
}));
vi.mock("../lib/notifyExhaustionOpsAlert", () => ({
  getExhaustionHistoryByDay: async () => [],
  getConfiguredOpsAlertRecipients: async () => [],
  listExhaustedRowsForDay: async () => [],
  clearChannelExhaustion: async () => 0,
  retryExhaustedChannel: async () => null,
}));
vi.mock("../lib/year-in-golf-cron", () => ({
  RECAP_NOTIFICATION_KEY: "recap",
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
    req.log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as typeof req.log;
    next();
  });
  app.use(adminRouter);
  return app;
}

function makeFailed(overrides: Partial<ProbeRow> = {}): ProbeRow {
  return {
    id: 100,
    swingVideoId: 9000,
    objectPath: "swing-videos/foo.mp4",
    status: "failed",
    attempts: 5,
    errorMessage: "ffprobe returned no usable frame rate",
    completedAt: new Date("2026-04-29T12:00:00Z"),
    updatedAt: new Date("2026-04-29T12:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.rows = [];
  hoisted.enqueueCalls = [];
  hoisted.pendingDeleteId = null;
});

describe("GET /admin/swing-fps-probe-failures", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = buildApp(null);
    const res = await request(app).get("/admin/swing-fps-probe-failures");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin members with 403", async () => {
    const app = buildApp({ id: 7, role: "member", organizationId: 1 });
    const res = await request(app).get("/admin/swing-fps-probe-failures");
    expect(res.status).toBe(403);
  });

  it("returns failed probes plus a failureCount, with a truncated error preview", async () => {
    const longError = "x".repeat(450);
    hoisted.rows = [
      makeFailed({ id: 1, swingVideoId: 11, errorMessage: "boom" }),
      makeFailed({ id: 2, swingVideoId: 12, errorMessage: longError }),
      // A non-failed row should never be returned by the failures endpoint.
      makeFailed({ id: 3, swingVideoId: 13, status: "queued" }),
    ];
    const app = buildApp({ id: 1, role: "org_admin", organizationId: 1 });
    const res = await request(app).get("/admin/swing-fps-probe-failures");
    expect(res.status).toBe(200);
    expect(res.body.failureCount).toBe(2);
    expect(res.body.failures).toHaveLength(2);
    expect(res.body.failures.every((f: { id: number }) => f.id !== 3)).toBe(true);
    const longRow = res.body.failures.find((f: { id: number }) => f.id === 2);
    expect(longRow.errorMessage).toBe(longError);
    // Preview must be capped at 200 chars per the constant in the route.
    expect(longRow.errorMessagePreview.length).toBe(200);
  });
});

describe("POST /admin/swing-fps-probe-failures/:id/reenqueue", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = buildApp(null);
    const res = await request(app).post("/admin/swing-fps-probe-failures/1/reenqueue");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin members with 403", async () => {
    const app = buildApp({ id: 7, role: "member", organizationId: 1 });
    const res = await request(app).post("/admin/swing-fps-probe-failures/1/reenqueue");
    expect(res.status).toBe(403);
  });

  it("rejects non-numeric ids with 400", async () => {
    const app = buildApp({ id: 1, role: "super_admin" });
    const res = await request(app).post("/admin/swing-fps-probe-failures/abc/reenqueue");
    expect(res.status).toBe(400);
  });

  it("deletes the failed row and re-enqueues a fresh probe via enqueueFpsProbe", async () => {
    hoisted.rows = [
      makeFailed({ id: 42, swingVideoId: 9001, objectPath: "bucket/clip.mp4" }),
    ];
    hoisted.pendingDeleteId = 42;
    const app = buildApp({ id: 5, role: "tournament_director", organizationId: 1 });
    const res = await request(app).post("/admin/swing-fps-probe-failures/42/reenqueue");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, swingVideoId: 9001 });
    // The route must hand the open tx to enqueueFpsProbe so the
    // delete + re-enqueue land atomically.
    expect(hoisted.enqueueCalls).toHaveLength(1);
    expect(hoisted.enqueueCalls[0]).toMatchObject({
      swingVideoId: 9001,
      objectPath: "bucket/clip.mp4",
      insideTx: true,
    });
    // The original failed row must be gone (otherwise the next worker
    // tick would race the fresh enqueue against a still-present row).
    expect(hoisted.rows.find(r => r.id === 42)).toBeUndefined();
  });

  it("refuses to re-enqueue a row that's no longer failed (409)", async () => {
    hoisted.rows = [
      makeFailed({ id: 42, status: "queued" }),
    ];
    hoisted.pendingDeleteId = 42;
    const app = buildApp({ id: 5, role: "super_admin" });
    const res = await request(app).post("/admin/swing-fps-probe-failures/42/reenqueue");
    expect(res.status).toBe(409);
    expect(hoisted.enqueueCalls).toHaveLength(0);
    // The non-failed row must still be present.
    expect(hoisted.rows.find(r => r.id === 42)).toBeDefined();
  });
});

describe("POST /admin/swing-fps-probe-failures/:id/dismiss", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = buildApp(null);
    const res = await request(app).post("/admin/swing-fps-probe-failures/1/dismiss");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin members with 403", async () => {
    const app = buildApp({ id: 7, role: "member", organizationId: 1 });
    const res = await request(app).post("/admin/swing-fps-probe-failures/1/dismiss");
    expect(res.status).toBe(403);
  });

  it("removes the failed row", async () => {
    hoisted.rows = [
      makeFailed({ id: 77, swingVideoId: 5000 }),
    ];
    hoisted.pendingDeleteId = 77;
    const app = buildApp({ id: 5, role: "org_admin", organizationId: 1 });
    const res = await request(app).post("/admin/swing-fps-probe-failures/77/dismiss");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(hoisted.rows.find(r => r.id === 77)).toBeUndefined();
    // Dismiss must never accidentally re-enqueue.
    expect(hoisted.enqueueCalls).toHaveLength(0);
  });

  it("404s when the row is missing or has already been re-enqueued", async () => {
    hoisted.rows = [
      makeFailed({ id: 77, status: "queued" }),
    ];
    hoisted.pendingDeleteId = 77;
    const app = buildApp({ id: 5, role: "super_admin" });
    const res = await request(app).post("/admin/swing-fps-probe-failures/77/dismiss");
    expect(res.status).toBe(404);
    expect(hoisted.rows.find(r => r.id === 77)).toBeDefined();
  });
});
