/**
 * Tests for the wellness sweep rate-limit / retry behaviour (Task #694).
 *
 * Covers:
 *   1. fetchWithRetry retries 5xx and 429 responses (with exponential backoff)
 *      and eventually returns the successful response.
 *   2. fetchWithRetry honors the Retry-After header on 429 responses.
 *   3. 401 / 403 responses are NOT retried — they short-circuit immediately
 *      so auth failures still flip the connection to needs_reauth promptly.
 *   4. sweepWellnessConnections caps in-flight requests per provider so a
 *      large backlog cannot burst-hit the upstream API.
 *   5. A transient 503 from the Whoop recovery endpoint during a sweep is
 *      retried and the connection ultimately syncs successfully — the
 *      connection is NOT marked as a sync miss / needs_reauth.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  db,
  appUsersTable,
  wearableConnectionsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  sweepWellnessConnections,
  fetchWithRetry,
  refreshWhoopToken,
  refreshGoogleFitToken,
  syncWearableData,
  handleWhoopCallback,
  handleGoogleFitCallback,
  handleGarminCallback,
  handleArccosCallback,
  createOAuthState,
} from "../wearables.js";

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const ORIG_ENV = {
  WHOOP_CLIENT_ID: process.env.WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET: process.env.WHOOP_CLIENT_SECRET,
  GOOGLE_FIT_CLIENT_ID: process.env.GOOGLE_FIT_CLIENT_ID,
  GOOGLE_FIT_CLIENT_SECRET: process.env.GOOGLE_FIT_CLIENT_SECRET,
  GARMIN_CONSUMER_KEY: process.env.GARMIN_CONSUMER_KEY,
  GARMIN_CONSUMER_SECRET: process.env.GARMIN_CONSUMER_SECRET,
  ARCCOS_CLIENT_ID: process.env.ARCCOS_CLIENT_ID,
  ARCCOS_CLIENT_SECRET: process.env.ARCCOS_CLIENT_SECRET,
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
  process.env.GARMIN_CONSUMER_KEY = "test-garmin-key";
  process.env.GARMIN_CONSUMER_SECRET = "test-garmin-secret";
  process.env.ARCCOS_CLIENT_ID = "test-arccos-client";
  process.env.ARCCOS_CLIENT_SECRET = "test-arccos-secret";
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
    throw new Error(`Unexpected outbound fetch in rate-limit tests: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

let userCounter = 0;
const createdUserIds: number[] = [];
async function newUser(label: string): Promise<number> {
  userCounter++;
  const stamp = `${Date.now()}_${userCounter}_${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `wellness-rate-${label}-${stamp}`,
    username: `wellness_rate_${label}_${stamp}`,
    role: "player",
  }).returning();
  createdUserIds.push(u.id);
  return u.id;
}

afterAll(async () => {
  // Explicitly delete wearable_connections first (don't rely on FK cascade)
  // so we never leak rows into other test files' globally-scoped sweep queries.
  for (const id of createdUserIds) {
    await db.delete(wearableConnectionsTable).where(eq(wearableConnectionsTable.userId, id));
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
});

async function getConn(userId: number, provider: "whoop" | "google_fit" | "garmin" | "arccos") {
  const [row] = await db.select()
    .from(wearableConnectionsTable)
    .where(and(
      eq(wearableConnectionsTable.userId, userId),
      eq(wearableConnectionsTable.provider, provider),
    ));
  return row;
}

// A no-op sleep so retries don't actually wait wall-clock time.
const noSleep = async (_ms: number) => {};

describe("fetchWithRetry — transient failure behaviour", () => {
  it("retries 5xx responses and returns the eventual success", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      if (calls < 3) return new Response("oops", { status: 503 });
      return jsonResponse({ ok: true });
    });

    const res = await fetchWithRetry("https://example.test/x", {}, {
      sleepFn: async ms => { sleeps.push(ms); },
      rng: () => 0,
      baseDelayMs: 10,
    });

    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    // Two retries -> two sleeps (after attempt 0 and attempt 1).
    expect(sleeps).toHaveLength(2);
    // Exponential growth: 10 then 20.
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
  });

  it("honors Retry-After on 429 responses", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "7" },
        });
      }
      return jsonResponse({ ok: true });
    });

    const res = await fetchWithRetry("https://example.test/x", {}, {
      sleepFn: async ms => { sleeps.push(ms); },
      rng: () => 0,
      baseDelayMs: 10,
    });

    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    // Retry-After: 7s should dominate the 10ms base backoff.
    expect(sleeps[0]).toBeGreaterThanOrEqual(7000);
  });

  it("does NOT retry 401 / 403 — auth failures short-circuit", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      return new Response("unauthorized", { status: 401 });
    });

    const res = await fetchWithRetry("https://example.test/x", {}, {
      sleepFn: noSleep,
      baseDelayMs: 10,
    });

    expect(res.status).toBe(401);
    expect(calls).toBe(1);
  });

  it("returns the final response after exhausting retries", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      return new Response("still down", { status: 503 });
    });

    const res = await fetchWithRetry("https://example.test/x", {}, {
      sleepFn: noSleep,
      maxRetries: 2,
      baseDelayMs: 1,
    });

    expect(res.status).toBe(503);
    // 1 initial attempt + 2 retries = 3 total
    expect(calls).toBe(3);
  });
});

describe("sweepWellnessConnections — per-provider concurrency cap", () => {
  it("never has more than perProviderConcurrency requests in flight per provider", async () => {
    const N = 6;
    const userIds: number[] = [];
    const now = Date.now();
    for (let i = 0; i < N; i++) {
      const uid = await newUser(`conc${i}`);
      userIds.push(uid);
      await db.insert(wearableConnectionsTable).values({
        userId: uid,
        provider: "whoop",
        status: "connected",
        accessToken: `tok-${i}`,
        refreshToken: `rt-${i}`,
        tokenExpiresAt: new Date(now + 60 * 60 * 1000),
        lastSyncAt: null,
      });
    }

    let inFlight = 0;
    let maxInFlight = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("/recovery") && !url.includes("/activity/sleep")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield a few macrotasks so other workers actually start while we wait.
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return jsonResponse({ records: [] });
    });

    const result = await sweepWellnessConnections({
      perProviderConcurrency: 2,
      sleepFn: noSleep,
    });

    expect(result.attempted).toBeGreaterThanOrEqual(N);
    // syncWhoopWellness fires recovery + sleep in parallel per user, so a
    // concurrency cap of 2 users gives at most 4 in-flight HTTP calls.
    expect(maxInFlight).toBeLessThanOrEqual(2 * 2);
    expect(maxInFlight).toBeGreaterThan(0);
  });
});

describe("sweepWellnessConnections — transient 503 is retried, not treated as failure", () => {
  it("retries 503 from Whoop and ultimately succeeds without flipping needs_reauth", async () => {
    const userId = await newUser("retry503");
    const now = Date.now();
    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "whoop",
      status: "connected",
      accessToken: "tok",
      refreshToken: "rt",
      tokenExpiresAt: new Date(now + 60 * 60 * 1000),
      lastSyncAt: null,
    });

    let recoveryCalls = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/recovery")) {
        recoveryCalls++;
        if (recoveryCalls < 3) return new Response("upstream down", { status: 503 });
        return jsonResponse({ records: [] });
      }
      if (url.includes("/activity/sleep")) {
        return jsonResponse({ records: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await sweepWellnessConnections({
      sleepFn: noSleep,
      baseDelayMs: 1,
      maxRetries: 3,
    });

    // The 503s were retried, so the recovery endpoint was hit at least 3 times
    // for this single user.
    expect(recoveryCalls).toBeGreaterThanOrEqual(3);
    expect(result.attempted).toBeGreaterThanOrEqual(1);
    expect(result.succeeded).toBeGreaterThanOrEqual(1);
    expect(result.needsReauth).toBe(0);

    const after = await getConn(userId, "whoop");
    expect(after.status).toBe("connected");
    expect(after.lastSyncAt).not.toBeNull();
  });
});

describe("refreshWhoopToken — transient 5xx is retried, not treated as a failure (Task #847)", () => {
  it("retries 503 from the Whoop OAuth token endpoint and refreshes successfully", async () => {
    const userId = await newUser("whoop-refresh-retry");
    const now = Date.now();
    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "whoop",
      status: "connected",
      accessToken: "tok",
      refreshToken: "rt",
      tokenExpiresAt: new Date(now - 60_000), // already expired so refresh runs
    });
    const conn = await getConn(userId, "whoop");

    let calls = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("/oauth/oauth2/token")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      calls++;
      if (calls < 3) return new Response("upstream down", { status: 503 });
      return jsonResponse({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });
    });

    const out = await refreshWhoopToken(conn, {
      sleepFn: noSleep,
      baseDelayMs: 1,
      maxRetries: 3,
    });

    expect(out).toBe("new-access");
    expect(calls).toBe(3);

    const after = await getConn(userId, "whoop");
    // Crucially: the connection was NOT flipped into needs_reauth by the
    // transient 503s — it stayed healthy and the new token was persisted.
    expect(after.status).toBe("connected");
    expect(after.tokenExpiresAt).not.toBeNull();
  });

  it("still flips to needs_reauth on 401 without retrying", async () => {
    const userId = await newUser("whoop-refresh-401");
    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "whoop",
      status: "connected",
      accessToken: "tok",
      refreshToken: "rt",
      tokenExpiresAt: new Date(Date.now() - 60_000),
    });
    const conn = await getConn(userId, "whoop");

    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      return new Response("unauthorized", { status: 401 });
    });

    const out = await refreshWhoopToken(conn, {
      sleepFn: noSleep,
      baseDelayMs: 1,
      maxRetries: 3,
    });

    expect(out).toBeNull();
    // 401 must NOT be retried — short-circuit on the first call.
    expect(calls).toBe(1);
    const after = await getConn(userId, "whoop");
    expect(after.status).toBe("needs_reauth");
  });
});

describe("refreshGoogleFitToken — transient 5xx is retried, not treated as a failure (Task #1561)", () => {
  it("retries 503 from the Google OAuth token endpoint and refreshes successfully", async () => {
    const userId = await newUser("gfit-refresh-retry");
    const now = Date.now();
    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "google_fit",
      status: "connected",
      accessToken: "tok",
      refreshToken: "rt",
      tokenExpiresAt: new Date(now - 60_000), // already expired so refresh runs
    });
    const conn = await getConn(userId, "google_fit");

    let calls = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("oauth2.googleapis.com/token")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      calls++;
      if (calls < 3) return new Response("upstream down", { status: 503 });
      return jsonResponse({
        access_token: "new-gfit-access",
        expires_in: 3600,
      });
    });

    const out = await refreshGoogleFitToken(conn, {
      sleepFn: noSleep,
      baseDelayMs: 1,
      maxRetries: 3,
    });

    expect(out).toBe("new-gfit-access");
    expect(calls).toBe(3);

    const after = await getConn(userId, "google_fit");
    // Crucially: the connection was NOT flipped into needs_reauth by the
    // transient 503s — it stayed healthy and the new token was persisted.
    expect(after.status).toBe("connected");
    expect(after.tokenExpiresAt).not.toBeNull();
  });

  it("still flips to needs_reauth on 401 without retrying", async () => {
    const userId = await newUser("gfit-refresh-401");
    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "google_fit",
      status: "connected",
      accessToken: "tok",
      refreshToken: "rt",
      tokenExpiresAt: new Date(Date.now() - 60_000),
    });
    const conn = await getConn(userId, "google_fit");

    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      return new Response("unauthorized", { status: 401 });
    });

    const out = await refreshGoogleFitToken(conn, {
      sleepFn: noSleep,
      baseDelayMs: 1,
      maxRetries: 3,
    });

    expect(out).toBeNull();
    // 401 must NOT be retried — short-circuit on the first call.
    expect(calls).toBe(1);
    const after = await getConn(userId, "google_fit");
    expect(after.status).toBe("needs_reauth");
  });
});

describe("syncWearableData — on-demand sync retries transient provider failures (Task #987)", () => {
  it("retries 503 from the Garmin Health API activity-list fetch and ultimately succeeds", async () => {
    const userId = await newUser("garmin-sync-retry");
    await db.insert(wearableConnectionsTable).values({
      userId,
      provider: "garmin",
      status: "connected",
      accessToken: "garmin-tok",
      refreshToken: "garmin-secret",
    });

    let calls = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("healthapi.garmin.com")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      calls++;
      if (calls < 3) return new Response("upstream down", { status: 503 });
      return jsonResponse({ activityList: [{ id: 1 }, { id: 2 }] });
    });

    const result = await syncWearableData(userId, "garmin", {
      sleepFn: noSleep,
      baseDelayMs: 1,
      maxRetries: 3,
    });

    // The 503s were retried — the user got a successful sync, not a hard
    // "Garmin sync returned HTTP 503" error.
    expect(calls).toBe(3);
    expect(result.synced).toBe(true);
    expect(result.activities).toBe(2);
  });
});

describe("handleWhoopCallback — transient 5xx during OAuth code→token exchange is retried (Task #987)", () => {
  it("retries 503 from the Whoop OAuth token endpoint and persists the connection as 'connected'", async () => {
    const userId = await newUser("whoop-cb-retry");
    const state = createOAuthState(userId);

    let calls = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("api.prod.whoop.com/oauth/oauth2/token")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      calls++;
      if (calls < 3) return new Response("upstream down", { status: 503 });
      return jsonResponse({
        access_token: "whoop-access",
        refresh_token: "whoop-refresh",
        expires_in: 3600,
      });
    });

    const out = await handleWhoopCallback("auth-code", state, userId, "https://example.test");

    expect(out.ok).toBe(true);
    // The 503s must have been retried — we expect 2 retries before success.
    expect(calls).toBe(3);

    const after = await getConn(userId, "whoop");
    expect(after).toBeDefined();
    expect(after.status).toBe("connected");
    expect(after.accessToken).toBeTruthy();
    expect(after.tokenExpiresAt).not.toBeNull();
  });

  it("does NOT retry an immediate 401 from Whoop's OAuth host and returns the existing error", async () => {
    const userId = await newUser("whoop-cb-401");
    const state = createOAuthState(userId);

    let calls = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("api.prod.whoop.com/oauth/oauth2/token")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      calls++;
      return new Response("unauthorized", { status: 401 });
    });

    const out = await handleWhoopCallback("auth-code", state, userId, "https://example.test");

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error).toContain("HTTP 401");
    }
    // 401 is short-circuited inside fetchWithRetry — exactly one call.
    expect(calls).toBe(1);

    // No connection row should have been persisted on the auth failure.
    const after = await getConn(userId, "whoop");
    expect(after).toBeUndefined();
  });
});

describe("handleGoogleFitCallback — transient 5xx during OAuth code→token exchange is retried (Task #987)", () => {
  it("retries 503 from the Google OAuth token endpoint and persists the connection as 'connected'", async () => {
    const userId = await newUser("gfit-cb-retry");
    const state = createOAuthState(userId);

    let calls = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("oauth2.googleapis.com/token")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      calls++;
      if (calls < 3) return new Response("upstream down", { status: 503 });
      return jsonResponse({
        access_token: "gfit-access",
        refresh_token: "gfit-refresh",
        expires_in: 3600,
      });
    });

    const out = await handleGoogleFitCallback("auth-code", state, userId, "https://example.test");

    expect(out.ok).toBe(true);
    expect(calls).toBe(3);

    const after = await getConn(userId, "google_fit");
    expect(after).toBeDefined();
    expect(after.status).toBe("connected");
    expect(after.accessToken).toBeTruthy();
    expect(after.tokenExpiresAt).not.toBeNull();
  });

  it("does NOT retry an immediate 401 from Google's OAuth host and returns the existing error", async () => {
    const userId = await newUser("gfit-cb-401");
    const state = createOAuthState(userId);

    let calls = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("oauth2.googleapis.com/token")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      calls++;
      return new Response("unauthorized", { status: 401 });
    });

    const out = await handleGoogleFitCallback("auth-code", state, userId, "https://example.test");

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error).toContain("HTTP 401");
    }
    expect(calls).toBe(1);

    const after = await getConn(userId, "google_fit");
    expect(after).toBeUndefined();
  });
});

describe("handleGarminCallback — transient 5xx during OAuth code→token exchange is retried (Task #1320)", () => {
  it("retries 503 from the Garmin OAuth token endpoint and persists the connection as 'connected'", async () => {
    const userId = await newUser("garmin-cb-retry");
    const state = createOAuthState(userId);

    let tokenCalls = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("connectapi.garmin.com/oauth-service/oauth/access_token")) {
        tokenCalls++;
        if (tokenCalls < 3) return new Response("upstream down", { status: 503 });
        // Garmin OAuth1 token endpoint returns form-encoded text, not JSON.
        return new Response(
          new URLSearchParams({
            oauth_token: "garmin-access",
            oauth_token_secret: "garmin-secret",
          }).toString(),
          {
            status: 200,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          },
        );
      }
      if (url.includes("healthapi.garmin.com/wellness-api/rest/user/id")) {
        // The post-token user-ID lookup — return a stable value so the
        // callback reaches the persist step. Not the subject of this test.
        return jsonResponse({ userId: "garmin-user-123" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const out = await handleGarminCallback("auth-code", state, userId);

    expect(out.ok).toBe(true);
    // The 503s must have been retried — we expect 2 retries before success.
    expect(tokenCalls).toBe(3);

    const after = await getConn(userId, "garmin");
    expect(after).toBeDefined();
    expect(after.status).toBe("connected");
    expect(after.accessToken).toBeTruthy();
  });

  it("does NOT retry an immediate 401 from Garmin's OAuth host and returns the existing error", async () => {
    const userId = await newUser("garmin-cb-401");
    const state = createOAuthState(userId);

    let calls = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("connectapi.garmin.com/oauth-service/oauth/access_token")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      calls++;
      return new Response("unauthorized", { status: 401 });
    });

    const out = await handleGarminCallback("auth-code", state, userId);

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error).toContain("HTTP 401");
    }
    // 401 is short-circuited inside fetchWithRetry — exactly one call.
    expect(calls).toBe(1);

    // No connection row should have been persisted on the auth failure.
    const after = await getConn(userId, "garmin");
    expect(after).toBeUndefined();
  });
});

describe("handleArccosCallback — transient 5xx during OAuth code→token exchange is retried (Task #1320)", () => {
  it("retries 503 from the Arccos OAuth token endpoint and persists the connection as 'connected'", async () => {
    const userId = await newUser("arccos-cb-retry");
    const state = createOAuthState(userId);

    let calls = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("arccosgolf.com/oauth/token")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      calls++;
      if (calls < 3) return new Response("upstream down", { status: 503 });
      return jsonResponse({ access_token: "arccos-access" });
    });

    const out = await handleArccosCallback("auth-code", state, userId, "https://example.test");

    expect(out.ok).toBe(true);
    expect(calls).toBe(3);

    const after = await getConn(userId, "arccos");
    expect(after).toBeDefined();
    expect(after.status).toBe("connected");
    expect(after.accessToken).toBeTruthy();
  });

  it("does NOT retry an immediate 401 from Arccos's OAuth host and returns the existing error", async () => {
    const userId = await newUser("arccos-cb-401");
    const state = createOAuthState(userId);

    let calls = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("arccosgolf.com/oauth/token")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      calls++;
      return new Response("unauthorized", { status: 401 });
    });

    const out = await handleArccosCallback("auth-code", state, userId, "https://example.test");

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.error).toContain("HTTP 401");
    }
    expect(calls).toBe(1);

    const after = await getConn(userId, "arccos");
    expect(after).toBeUndefined();
  });
});
