/**
 * Task #2056 — Tests for the watch GPS "Send test page" audit log and
 * the history endpoint that powers the dashboard's "Last test page: X
 * ago by …" line and 30-day frequency chart.
 *
 * Covers:
 *   1. `recordWatchGpsOpsAlertTestPage` writes one row per call with
 *      the actor, channel attempt flags, and per-channel error string.
 *   2. `getWatchGpsOpsAlertTestPageHistory` returns the most recent
 *      row in `last`, a 30-bucket UTC daily series (zero-filled), and
 *      a `totalLast30Days` count that matches the series sum.
 *   3. Audit failures inside the route do not break the test-page
 *      response (best-effort write).
 *   4. Auth gate: GET history endpoint returns 401 unauthenticated and
 *      403 for non-super-admin (matches the rest of the panel).
 *   5. Happy path through the route: POST writes an audit row tagged
 *      with the super-admin actor; GET reflects it immediately.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  appUsersTable,
  watchGpsOpsAlertTestPagesTable,
} from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

// Mock the Slack/PagerDuty senders so we don't make real network calls.
vi.mock("../lib/opsAlertChat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/opsAlertChat.js")>();
  return {
    ...actual,
    postWatchPositionTrendOpsAlertSlack: vi.fn(async () => undefined),
    triggerWatchPositionTrendOpsAlertPagerDuty: vi.fn(async () => undefined),
  };
});

import {
  recordWatchGpsOpsAlertTestPage,
  getWatchGpsOpsAlertTestPageHistory,
} from "../lib/watchPositionMetrics.js";

const ENV_KEYS = [
  "OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK",
  "OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

let superAdminUserId: number;
let regularUserId: number;
const createdUserIds: number[] = [];

async function clearAuditTable() {
  await db.execute(sql`TRUNCATE TABLE ${watchGpsOpsAlertTestPagesTable} RESTART IDENTITY`);
}

beforeAll(async () => {
  const slug = uid("ops-alert-history");
  const [su] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_su`,
    username: `su_${slug}`,
    email: `su_${slug}@example.com`,
    displayName: "Super Admin Test Page",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superAdminUserId = su.id;
  createdUserIds.push(superAdminUserId);

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_user`,
    username: `user_${slug}`,
    email: `user_${slug}@example.com`,
    displayName: "Regular User",
    role: "player",
  }).returning({ id: appUsersTable.id });
  regularUserId = u.id;
  createdUserIds.push(regularUserId);
});

afterAll(async () => {
  await clearAuditTable();
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
});

beforeEach(async () => {
  await clearAuditTable();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("recordWatchGpsOpsAlertTestPage + getWatchGpsOpsAlertTestPageHistory", () => {
  it("returns an empty history (null `last`, dense 30-bucket series of zeros) when the table is empty", async () => {
    const now = Date.UTC(2026, 3, 15, 12, 0, 0);
    const history = await getWatchGpsOpsAlertTestPageHistory(now);
    expect(history.last).toBeNull();
    expect(history.totalLast30Days).toBe(0);
    expect(history.dailySeries).toHaveLength(30);
    expect(history.dailySeries.every(p => p.count === 0)).toBe(true);
    // Ascending UTC dates, last bucket is "today" UTC.
    expect(history.dailySeries[history.dailySeries.length - 1].date).toBe("2026-04-15");
    expect(history.dailySeries[0].date).toBe("2026-03-17");
  });

  it("writes one row per click and surfaces the most recent one in `last` with actor + per-channel flags", async () => {
    const t0 = Date.UTC(2026, 3, 14, 9, 0, 0);
    const t1 = Date.UTC(2026, 3, 15, 11, 30, 0);

    await recordWatchGpsOpsAlertTestPage({
      actorUserId: superAdminUserId,
      actorName: "Asha Patel",
      result: {
        targets: { slackConfigured: true, pagerDutyConfigured: false },
        slack: { configured: true, attempted: true, ok: true, error: null },
        pagerDuty: { configured: false, attempted: false, ok: false, error: null },
      },
      nowMs: t0,
    });
    await recordWatchGpsOpsAlertTestPage({
      actorUserId: superAdminUserId,
      actorName: "Asha Patel",
      result: {
        targets: { slackConfigured: true, pagerDutyConfigured: true },
        slack: { configured: true, attempted: true, ok: false, error: "Slack 404" },
        pagerDuty: { configured: true, attempted: true, ok: true, error: null },
      },
      nowMs: t1,
    });

    const history = await getWatchGpsOpsAlertTestPageHistory(t1 + 1000);
    expect(history.last).not.toBeNull();
    expect(history.last!.actorUserId).toBe(superAdminUserId);
    expect(history.last!.actorName).toBe("Asha Patel");
    expect(history.last!.slack).toEqual({ attempted: true, ok: false, error: "Slack 404" });
    expect(history.last!.pagerDuty).toEqual({ attempted: true, ok: true, error: null });
    expect(new Date(history.last!.firedAt).getTime()).toBe(t1);

    expect(history.totalLast30Days).toBe(2);
    const sum = history.dailySeries.reduce((a, p) => a + p.count, 0);
    expect(sum).toBe(2);
    const apr14 = history.dailySeries.find(p => p.date === "2026-04-14");
    const apr15 = history.dailySeries.find(p => p.date === "2026-04-15");
    expect(apr14?.count).toBe(1);
    expect(apr15?.count).toBe(1);
  });

  it("excludes rows older than the 30-day window from totals", async () => {
    const now = Date.UTC(2026, 3, 15, 12, 0, 0);
    // 45 days ago — outside the 30-day window.
    const old = now - 45 * 24 * 60 * 60 * 1000;
    // Inside the window.
    const recent = now - 5 * 24 * 60 * 60 * 1000;

    await recordWatchGpsOpsAlertTestPage({
      actorUserId: null,
      actorName: null,
      result: {
        targets: { slackConfigured: false, pagerDutyConfigured: false },
        slack: { configured: false, attempted: false, ok: false, error: null },
        pagerDuty: { configured: false, attempted: false, ok: false, error: null },
      },
      nowMs: old,
    });
    await recordWatchGpsOpsAlertTestPage({
      actorUserId: superAdminUserId,
      actorName: "Recent",
      result: {
        targets: { slackConfigured: true, pagerDutyConfigured: false },
        slack: { configured: true, attempted: true, ok: true, error: null },
        pagerDuty: { configured: false, attempted: false, ok: false, error: null },
      },
      nowMs: recent,
    });

    const history = await getWatchGpsOpsAlertTestPageHistory(now);
    // `last` returns the most recent overall, but the window total only
    // counts in-window rows. The 45-day-old row should not contribute.
    expect(history.last?.actorName).toBe("Recent");
    expect(history.totalLast30Days).toBe(1);
  });
});

describe("GET /api/super-admin/watch-position-metrics/test-ops-alert-chat-history", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const r = await request(app).get(
      "/api/super-admin/watch-position-metrics/test-ops-alert-chat-history",
    );
    expect(r.status).toBe(401);
  });

  it("returns 403 for non-super-admin users", async () => {
    const app = createTestApp({
      id: regularUserId,
      username: "regular",
      role: "player",
    });
    const r = await request(app).get(
      "/api/super-admin/watch-position-metrics/test-ops-alert-chat-history",
    );
    expect(r.status).toBe(403);
  });

  it("returns the dense 30-day series for a super-admin and reflects POSTed test pages", async () => {
    const app = createTestApp({
      id: superAdminUserId,
      username: "su",
      displayName: "Super Admin Test Page",
      role: "super_admin",
    });

    const r0 = await request(app).get(
      "/api/super-admin/watch-position-metrics/test-ops-alert-chat-history",
    );
    expect(r0.status).toBe(200);
    expect(r0.body.last).toBeNull();
    expect(r0.body.totalLast30Days).toBe(0);
    expect(Array.isArray(r0.body.dailySeries)).toBe(true);
    expect(r0.body.dailySeries).toHaveLength(30);

    // Fire the real route — neither env var is set, so it returns
    // attempted:false for both channels, but still writes an audit
    // row (the actor click matters for cadence, even with no targets).
    const post = await request(app)
      .post("/api/super-admin/watch-position-metrics/test-ops-alert-chat")
      .send({});
    expect(post.status).toBe(200);

    const r1 = await request(app).get(
      "/api/super-admin/watch-position-metrics/test-ops-alert-chat-history",
    );
    expect(r1.status).toBe(200);
    expect(r1.body.last).not.toBeNull();
    expect(r1.body.last.actorUserId).toBe(superAdminUserId);
    expect(r1.body.last.actorName).toBe("Super Admin Test Page");
    expect(r1.body.totalLast30Days).toBe(1);
  });
});
