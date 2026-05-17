/**
 * Integration tests for the daily wellness sweep (Task #531).
 *
 * Covers:
 *   1. sweepWellnessConnections only processes Whoop / Google Fit accounts
 *      whose lastSyncAt is older than 24 hours (or null).
 *   2. ensureFreshAccessToken (used by both syncWhoopWellness and
 *      syncGoogleFitWellness) refreshes tokens that are within 5 minutes of
 *      expiry, and skips refresh when more than 5 minutes remain.
 *   3. A 401/403 from refreshWhoopToken or refreshGoogleFitToken flips the
 *      connection to status="needs_reauth".
 *   4. A successful Whoop sync writes a wellness_daily_metrics row and
 *      updates the connection's lastSyncAt timestamp.
 *
 * Provider HTTP endpoints are mocked via vi.stubGlobal("fetch", ...); the
 * Postgres database is real (matches the convention used by the other
 * integration tests in src/tests/).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  db,
  appUsersTable,
  wearableConnectionsTable,
  wellnessDailyMetricsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  sweepWellnessConnections,
  refreshWhoopToken,
  refreshGoogleFitToken,
  getLastWellnessSweepResult,
  getWellnessSweepHistory,
  _resetWellnessSweepCacheForTests,
} from "../wearables.js";

// ── Env / fetch fixtures ──────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const ORIG_ENV = {
  WHOOP_CLIENT_ID: process.env.WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET: process.env.WHOOP_CLIENT_SECRET,
  GOOGLE_FIT_CLIENT_ID: process.env.GOOGLE_FIT_CLIENT_ID,
  GOOGLE_FIT_CLIENT_SECRET: process.env.GOOGLE_FIT_CLIENT_SECRET,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeAll(() => {
  process.env.WHOOP_CLIENT_ID = "test-whoop-client";
  process.env.WHOOP_CLIENT_SECRET = "test-whoop-secret";
  process.env.GOOGLE_FIT_CLIENT_ID = "test-gfit-client";
  process.env.GOOGLE_FIT_CLIENT_SECRET = "test-gfit-secret";
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  fetchMock = vi.fn(async (input: string | URL | Request) => {
    throw new Error(`Unexpected outbound fetch in wellness-sweep tests: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

// ── Helpers ───────────────────────────────────────────────────────────────

let userCounter = 0;
async function makeUser(label: string): Promise<number> {
  userCounter++;
  const stamp = `${Date.now()}_${userCounter}_${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `wellness-sweep-${label}-${stamp}`,
    username: `wellness_sweep_${label}_${stamp}`,
    role: "player",
  }).returning();
  return u.id;
}

const createdUserIds: number[] = [];
async function newUser(label: string): Promise<number> {
  const id = await makeUser(label);
  createdUserIds.push(id);
  return id;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // FK ON DELETE CASCADE on wearable_connections + wellness_daily_metrics
    // wipes the dependent rows when we drop the user.
    for (const id of createdUserIds) {
      await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
    }
  }
});

async function getConn(userId: number, provider: "whoop" | "google_fit") {
  const [row] = await db.select()
    .from(wearableConnectionsTable)
    .where(and(
      eq(wearableConnectionsTable.userId, userId),
      eq(wearableConnectionsTable.provider, provider),
    ));
  return row;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("sweepWellnessConnections — 24h dedupe", () => {
  it("only sweeps connections whose lastSyncAt is older than 24h (or null)", async () => {
    const dueUser = await newUser("due24");
    const recentUser = await newUser("recent24");

    const now = Date.now();
    // Recently-synced (1h ago) — must be skipped.
    await db.insert(wearableConnectionsTable).values({
      userId: recentUser,
      provider: "whoop",
      status: "connected",
      accessToken: "ignored-recent",
      refreshToken: "rt-recent",
      tokenExpiresAt: new Date(now + 60 * 60 * 1000), // not expiring
      lastSyncAt: new Date(now - 1 * 60 * 60 * 1000),
    });
    // Stale (30h ago) — must be swept.
    await db.insert(wearableConnectionsTable).values({
      userId: dueUser,
      provider: "whoop",
      status: "connected",
      accessToken: "ignored-due",
      refreshToken: "rt-due",
      tokenExpiresAt: new Date(now + 60 * 60 * 1000), // not expiring
      lastSyncAt: new Date(now - 30 * 60 * 60 * 1000),
    });

    const whoopHosts: string[] = [];
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      whoopHosts.push(url);
      if (url.includes("/recovery") || url.includes("/activity/sleep")) {
        return jsonResponse({ records: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await sweepWellnessConnections();

    expect(result.attempted).toBe(1);
    // Sync calls 2 endpoints (recovery + sleep) for the one due account.
    expect(whoopHosts.length).toBe(2);
    expect(whoopHosts.every(u => u.includes("api.prod.whoop.com"))).toBe(true);

    // The recent connection's lastSyncAt should NOT have been updated.
    const recentConn = await getConn(recentUser, "whoop");
    expect(recentConn.lastSyncAt!.getTime()).toBeLessThan(now - 30 * 60 * 1000);

    // The due connection's lastSyncAt SHOULD have been bumped to ~now.
    const dueConn = await getConn(dueUser, "whoop");
    expect(dueConn.lastSyncAt!.getTime()).toBeGreaterThan(now - 5_000);
  });
});

describe("sweepWellnessConnections — 5-min refresh buffer", () => {
  it("refreshes the token when expiry is within 5 minutes, otherwise skips refresh", async () => {
    const expiringUser = await newUser("expiring");
    const freshUser = await newUser("fresh");

    const now = Date.now();
    // Expiring in 2 minutes — should trigger a token refresh fetch first.
    await db.insert(wearableConnectionsTable).values({
      userId: expiringUser,
      provider: "whoop",
      status: "connected",
      accessToken: "old-access-token",
      refreshToken: "rt-expiring",
      tokenExpiresAt: new Date(now + 2 * 60 * 1000),
      lastSyncAt: null,
    });
    // Expires in 60 minutes — well outside the 5-minute buffer; no refresh.
    await db.insert(wearableConnectionsTable).values({
      userId: freshUser,
      provider: "whoop",
      status: "connected",
      accessToken: "fresh-access-token",
      refreshToken: "rt-fresh",
      tokenExpiresAt: new Date(now + 60 * 60 * 1000),
      lastSyncAt: null,
    });

    const calls: { url: string; auth?: string }[] = [];
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      calls.push({ url, auth });
      if (url.includes("/oauth/oauth2/token")) {
        return jsonResponse({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        });
      }
      if (url.includes("/recovery") || url.includes("/activity/sleep")) {
        return jsonResponse({ records: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await sweepWellnessConnections();

    const refreshCalls = calls.filter(c => c.url.includes("/oauth/oauth2/token"));
    // Exactly one refresh: only for the connection within the 5-minute buffer.
    expect(refreshCalls.length).toBe(1);

    // The Whoop API calls for the freshly-tokened user must use the original
    // access token (no refresh happened); the expiring user's calls must use
    // the freshly-issued token. Crucially, no call may carry the stale
    // pre-refresh token for the expiring connection.
    const whoopApiCalls = calls.filter(c =>
      c.url.includes("/recovery") || c.url.includes("/activity/sleep"),
    );
    const authsUsed = whoopApiCalls.map(c => c.auth);
    expect(authsUsed).toContain("Bearer new-access-token");
    expect(authsUsed).toContain("Bearer fresh-access-token");
    expect(authsUsed).not.toContain("Bearer old-access-token");

    // Refresh must happen before the expiring user's provider API calls.
    const refreshIdx = calls.findIndex(c => c.url.includes("/oauth/oauth2/token"));
    const firstNewTokenCallIdx = calls.findIndex(c => c.auth === "Bearer new-access-token");
    expect(refreshIdx).toBeGreaterThanOrEqual(0);
    expect(firstNewTokenCallIdx).toBeGreaterThan(refreshIdx);
  });
});

describe("sweepWellnessConnections — provider 401 during sync flips to needs_reauth", () => {
  it("flips status to needs_reauth when the Whoop recovery endpoint returns 401", async () => {
    const userId = await newUser("syncauth");
    const now = Date.now();
    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "whoop",
      status: "connected",
      accessToken: "live",
      refreshToken: "rt",
      tokenExpiresAt: new Date(now + 60 * 60 * 1000), // not expiring
      lastSyncAt: null,
    });

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/recovery")) return new Response("unauthorized", { status: 401 });
      if (url.includes("/activity/sleep")) return jsonResponse({ records: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await sweepWellnessConnections();
    expect(result.attempted).toBeGreaterThanOrEqual(1);
    expect(result.needsReauth).toBeGreaterThanOrEqual(1);

    const after = await getConn(userId, "whoop");
    expect(after.status).toBe("needs_reauth");
  });
});

describe("sweepWellnessConnections — alert + status surfaced when many flip to needs_reauth", () => {
  it("getLastWellnessSweepResult returns alerted=true once threshold is exceeded", async () => {
    // Seed 5 stale Whoop connections; mock recovery=401 so each one flips.
    const userIds: number[] = [];
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const uid = await newUser(`alert${i}`);
      userIds.push(uid);
      await db.insert(wearableConnectionsTable).values({
        userId: uid,
        provider: "whoop",
        status: "connected",
        accessToken: "live",
        refreshToken: "rt",
        tokenExpiresAt: new Date(now + 60 * 60 * 1000),
        lastSyncAt: null,
      });
    }

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/recovery")) return new Response("unauthorized", { status: 401 });
      if (url.includes("/activity/sleep")) return jsonResponse({ records: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await sweepWellnessConnections();
    expect(result.attempted).toBeGreaterThanOrEqual(5);
    expect(result.needsReauth).toBeGreaterThanOrEqual(5);

    const last = await getLastWellnessSweepResult();
    expect(last).not.toBeNull();
    expect(last!.alerted).toBe(true);
    expect(last!.needsReauth).toBeGreaterThanOrEqual(5);
    expect(last!.attempted).toBeGreaterThanOrEqual(5);
    expect(typeof last!.ranAt).toBe("string");
    expect(Number.isNaN(Date.parse(last!.ranAt))).toBe(false);
  });
});

describe("sweepWellnessConnections — last result and history survive a restart", () => {
  it("re-hydrates the last sweep result from the DB after the in-memory cache is cleared", async () => {
    // Run a sweep with no due connections so the result is deterministic
    // (attempted=0, succeeded=0, needsReauth=0). The relevant assertion is
    // that AFTER clearing the in-process cache (i.e. simulating a fresh
    // server process), getLastWellnessSweepResult still returns the most
    // recent run because it falls back to the wellness_sweep_runs table.
    const before = await sweepWellnessConnections();
    const cached = await getLastWellnessSweepResult();
    expect(cached).not.toBeNull();
    expect(cached!.attempted).toBe(before.attempted);

    // Simulate a server restart: forget the in-memory cache.
    _resetWellnessSweepCacheForTests();

    const afterRestart = await getLastWellnessSweepResult();
    expect(afterRestart).not.toBeNull();
    expect(afterRestart!.ranAt).toBe(cached!.ranAt);
    expect(afterRestart!.attempted).toBe(cached!.attempted);
    expect(afterRestart!.succeeded).toBe(cached!.succeeded);
    expect(afterRestart!.needsReauth).toBe(cached!.needsReauth);
    expect(afterRestart!.alerted).toBe(cached!.alerted);

    // History endpoint sees this run too.
    const history = await getWellnessSweepHistory(30);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].ranAt).toBe(cached!.ranAt);
  });
});

describe("refreshWhoopToken — 401 flips connection to needs_reauth", () => {
  it("marks status=needs_reauth and returns null on HTTP 401", async () => {
    const userId = await newUser("whoop401");
    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "whoop",
      status: "connected",
      accessToken: "stale",
      refreshToken: "expired-refresh",
      tokenExpiresAt: new Date(Date.now() - 60_000),
    });

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      expect(String(input)).toContain("api.prod.whoop.com/oauth/oauth2/token");
      return new Response("invalid_grant", { status: 401 });
    });

    const conn = await getConn(userId, "whoop");
    const out = await refreshWhoopToken(conn);
    expect(out).toBeNull();

    const after = await getConn(userId, "whoop");
    expect(after.status).toBe("needs_reauth");
  });
});

describe("refreshGoogleFitToken — 403 flips connection to needs_reauth", () => {
  it("marks status=needs_reauth and returns null on HTTP 403", async () => {
    const userId = await newUser("gfit403");
    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "google_fit",
      status: "connected",
      accessToken: "stale",
      refreshToken: "revoked-refresh",
      tokenExpiresAt: new Date(Date.now() - 60_000),
    });

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      expect(String(input)).toContain("oauth2.googleapis.com/token");
      return new Response("forbidden", { status: 403 });
    });

    const conn = await getConn(userId, "google_fit");
    const out = await refreshGoogleFitToken(conn);
    expect(out).toBeNull();

    const after = await getConn(userId, "google_fit");
    expect(after.status).toBe("needs_reauth");
  });
});

describe("sweepWellnessConnections — successful sync writes metrics + bumps lastSyncAt", () => {
  it("upserts a wellness_daily_metrics row and updates lastSyncAt", async () => {
    const userId = await newUser("syncok");
    const now = Date.now();
    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "whoop",
      status: "connected",
      accessToken: "fresh",
      refreshToken: "rt",
      tokenExpiresAt: new Date(now + 60 * 60 * 1000),
      lastSyncAt: null,
    });

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/recovery")) {
        return jsonResponse({
          records: [{
            created_at: "2026-04-15T08:00:00Z",
            score: { recovery_score: 72, resting_heart_rate: 58, hrv_rmssd_milli: 47.2 },
          }],
        });
      }
      if (url.includes("/activity/sleep")) {
        return jsonResponse({
          records: [{
            start: "2026-04-15T00:00:00Z",
            score: {
              sleep_performance_percentage: 88,
              stage_summary: { total_in_bed_time_milli: 28_800_000, total_awake_time_milli: 1_800_000 },
            },
          }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await sweepWellnessConnections();
    expect(result.attempted).toBeGreaterThanOrEqual(1);
    expect(result.succeeded).toBeGreaterThanOrEqual(1);

    const conn = await getConn(userId, "whoop");
    expect(conn.lastSyncAt).not.toBeNull();
    expect(conn.lastSyncAt!.getTime()).toBeGreaterThan(now - 5_000);

    const rows = await db.select()
      .from(wellnessDailyMetricsTable)
      .where(and(
        eq(wellnessDailyMetricsTable.userId, userId),
        eq(wellnessDailyMetricsTable.source, "whoop"),
      ));
    expect(rows.length).toBe(1);
    expect(rows[0].metricDate).toBe("2026-04-15");
    expect(rows[0].readinessScore).toBe(72);
    expect(rows[0].restingHr).toBe(58);
    expect(rows[0].sleepScore).toBe(88);
    // 28_800_000ms in bed - 1_800_000ms awake = 27_000_000ms = 450 minutes asleep
    expect(rows[0].sleepMinutes).toBe(450);
  });
});
