/**
 * Task #1677 — End-to-end test: watch sends `position` over /ws/watch,
 * the super-admin "View positions" endpoint surfaces what was sent.
 *
 * Why this exists:
 *   `watch-position-metrics.test.ts` exercises the per-session ring buffer
 *   in isolation, but nothing covers the full path
 *     `position` WS frame → `recordWatchPositionSample` →
 *     `/super-admin/watch-position-metrics/session/:sessionId`.
 *   A future refactor of the WS handler could silently stop feeding the
 *   ring buffer (e.g. dropping the second `recordWatchPositionSample`
 *   call) without breaking any unit test. This test would catch that.
 *
 * Wire flow exercised:
 *   1. Spin up an HTTP server with attachWatchWebSocketServer attached.
 *   2. Connect a real `ws` client to ws://127.0.0.1:<port>/ws/watch.
 *   3. Authenticate with a token issued via `issueWatchToken` (the same
 *      issuer used by /api/portal/watch-token in production).
 *   4. Send three `position` frames (varying lat/lon/accuracy).
 *   5. Toggle battery mode on, send one more `position`.
 *   6. GET /api/super-admin/watch-position-metrics/session/:sessionId via
 *      supertest as a super-admin and assert the rows match (lat/lon/
 *      accuracy/batteryMode/order).
 *
 * Discovering the sessionId:
 *   The server allocates `sessionId = randomUUID()` per socket and does
 *   not echo it to clients (it's a server-only debugging key). Rather
 *   than change the wire protocol, the test peeks at the per-session
 *   sample map via `_peekWatchPositionSampleSessionsForTests`. The state
 *   is cleared in `beforeEach` so the lookup is unambiguous.
 *
 * Hits the real PostgreSQL database (DATABASE_URL) for fixture rows but
 * the position payloads themselves stay in-process (the ring buffer is
 * deliberately not persisted — see watchPositionMetrics.ts for the
 * per-replica trade-off documented on the endpoint).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import WebSocket, { type RawData } from "ws";
import request from "supertest";
import { db, organizationsTable, appUsersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { attachWatchWebSocketServer } from "../routes/ws-watch.js";
import { issueWatchToken } from "../lib/watch-token.js";
import { createTestApp, uid } from "./helpers.js";
import {
  _resetWatchPositionMetricsForTests,
  _peekWatchPositionSampleSessionsForTests,
  getRecentWatchPositionSamples,
} from "../lib/watchPositionMetrics.js";

let httpServer: http.Server;
let port: number;
let userId: number;
let superAdminUserId: number;
let orgId: number;
const createdUserIds: number[] = [];
const createdOrgIds: number[] = [];

beforeAll(async () => {
  const slug = uid("ws-pos-e2e");
  const [org] = await db.insert(organizationsTable).values({
    name: `Org ${slug}`,
    slug,
    subscriptionTier: "pro",
    subscriptionStatus: "active",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  createdOrgIds.push(orgId);

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_p`,
    username: `player_${slug}`,
    email: `player_${slug}@example.com`,
    displayName: "Watch Player",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
  createdUserIds.push(userId);

  const [su] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_su`,
    username: `su_${slug}`,
    email: `su_${slug}@example.com`,
    displayName: "Super Admin Positions E2E",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superAdminUserId = su.id;
  createdUserIds.push(superAdminUserId);

  httpServer = http.createServer();
  attachWatchWebSocketServer(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  if (createdUserIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(() => {
  // Clear in-process accumulators / sample rings / mute map so the
  // sessionId lookup below is unambiguous and prior runs don't bleed in.
  _resetWatchPositionMetricsForTests();
});

interface InboundMessage { type?: string; [k: string]: unknown }

function nextMessage(
  ws: WebSocket,
  predicate: (m: InboundMessage) => boolean,
  timeoutMs = 5_000,
): Promise<InboundMessage> {
  return new Promise((resolve, reject) => {
    const listener = (data: RawData) => {
      let msg: InboundMessage;
      try { msg = JSON.parse(data.toString()) as InboundMessage; } catch { return; }
      if (predicate(msg)) {
        clearTimeout(t);
        ws.off("message", listener);
        resolve(msg);
      }
    };
    const t = setTimeout(() => {
      ws.off("message", listener);
      reject(new Error("timed out waiting for matching ws message"));
    }, timeoutMs);
    ws.on("message", listener);
  });
}

/**
 * Poll the per-session sample ring until it holds `target` samples for the
 * single active session in this test, then return the sessionId. Avoids
 * arbitrary `sleep()` calls and keeps the test deterministic.
 */
async function waitForSampleCount(target: number, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = -1;
  while (Date.now() <= deadline) {
    const sessions = _peekWatchPositionSampleSessionsForTests();
    if (sessions.length === 1) {
      const sessionId = sessions[0]!;
      const { samples } = await getRecentWatchPositionSamples(sessionId, 100);
      lastSeen = samples.length;
      if (samples.length >= target) return sessionId;
    } else if (sessions.length > 1) {
      throw new Error(
        `expected exactly one active sample session, got ${sessions.length}: ${sessions.join(", ")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${target} samples (last seen ${lastSeen})`);
}

describe("e2e: WS /ws/watch positions → /super-admin/watch-position-metrics/session/:sessionId", () => {
  it("surfaces the lat/lon/accuracy/batteryMode/order of every position frame the watch sent", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/watch`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    try {
      // 1. Auth with a real watch token (HMAC-signed; same issuer as portal.ts).
      const token = issueWatchToken(userId);
      const authPromise = nextMessage(ws, (m) => m.type === "auth_ok");
      ws.send(JSON.stringify({ type: "auth", token }));
      const auth = await authPromise;
      expect(auth.userId).toBe(userId);

      // 2. First three position frames, batteryMode = false (default for a
      //    fresh session). Order must be preserved server-side.
      const normalPayloads = [
        { lat: 37.7749, lng: -122.4194, accuracy: 5 },
        { lat: 37.7750, lng: -122.4193, accuracy: 8 },
        { lat: 37.7751, lng: -122.4192, accuracy: 12 },
      ];
      for (const p of normalPayloads) {
        ws.send(JSON.stringify({ type: "position", ...p }));
      }
      // Wait for the server to drain all three onto the ring before we
      // toggle battery mode (so the toggle doesn't race with them).
      await waitForSampleCount(3);

      // 3. Toggle battery mode on (no tournamentId so the push-loop branch
      //    is skipped; the ack message is only sent when subscribed). We
      //    don't need an ack — the next position frame must record
      //    batteryMode=true regardless.
      ws.send(JSON.stringify({ type: "battery_mode", enabled: true }));

      // 4. Send one more position frame, this time in battery mode and
      //    deliberately without `accuracy` so we also assert the null
      //    fallback path documented on `WatchPositionSamplePayload`.
      const batteryPayload = { lat: 37.7752, lng: -122.4191 };
      ws.send(JSON.stringify({ type: "position", ...batteryPayload }));

      const sessionId = await waitForSampleCount(4);

      // 5. Hit the super-admin endpoint as a super_admin. Shares process
      //    state with the WS server (same vitest worker, single-process
      //    pool — see vitest.config.ts).
      const app = createTestApp({
        id: superAdminUserId,
        username: "su",
        displayName: "Super Admin Positions E2E",
        role: "super_admin",
      });
      const res = await request(app)
        .get(`/api/super-admin/watch-position-metrics/session/${sessionId}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.sessionId).toBe(sessionId);
      expect(res.body.totalSamples).toBe(4);
      expect(res.body.samples).toHaveLength(4);
      expect(typeof res.body.ringSize).toBe("number");
      expect(typeof res.body.ttlSeconds).toBe("number");

      // The endpoint returns most-recent first; reverse to compare to the
      // insertion order we drove from the watch.
      const inOrder = [...res.body.samples].reverse() as Array<{
        timestamp: string;
        lat: number;
        lng: number;
        accuracy: number | null;
        batteryMode: boolean;
      }>;

      for (let i = 0; i < normalPayloads.length; i++) {
        const expected = normalPayloads[i]!;
        const got = inOrder[i]!;
        expect(got.lat).toBeCloseTo(expected.lat, 6);
        expect(got.lng).toBeCloseTo(expected.lng, 6);
        expect(got.accuracy).toBe(expected.accuracy);
        expect(got.batteryMode).toBe(false);
        expect(typeof got.timestamp).toBe("string");
        // ISO-8601 → must be a valid Date.
        expect(Number.isFinite(new Date(got.timestamp).getTime())).toBe(true);
      }

      const battery = inOrder[3]!;
      expect(battery.lat).toBeCloseTo(batteryPayload.lat, 6);
      expect(battery.lng).toBeCloseTo(batteryPayload.lng, 6);
      // Watch omitted accuracy → endpoint surfaces null, not 0/undefined.
      expect(battery.accuracy).toBeNull();
      expect(battery.batteryMode).toBe(true);

      // Timestamps are non-decreasing (samples are pushed in order).
      const timestamps = inOrder.map((s) => new Date(s.timestamp).getTime());
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]!);
      }
    } finally {
      ws.close();
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
        ws.once("close", () => resolve());
      });
    }
  });
});
