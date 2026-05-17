/**
 * Task #1680 — Direct coverage for the `isWatchSessionMuted` short-circuit
 * inside the `position` handler in `routes/ws-watch.ts`.
 *
 * The super-admin endpoint that toggles the mute is already exercised end-to-
 * end (`super-admin-watch-session-mute.test.ts`), but the actual WS handler
 * path that consumes the mute flag is only covered indirectly there. A future
 * refactor of the `position` branch could quietly move the mute check below
 * the metric/sample writes (or drop it altogether) without any of the
 * existing tests failing — silently re-flooding the rate-limiter the
 * super-admin tool relies on.
 *
 * To pin the contract, this suite drives `handleMessage` directly with a
 * stub WebSocket session and asserts:
 *   1. While muted, a `position` frame advances neither the per-session
 *      bucket counter (`recordWatchPosition`) nor the live-position
 *      sample ring (`recordWatchPositionSample`), and the session's
 *      cached GPS state is not mutated either.
 *   2. After `unmuteWatchSession`, the same frame DOES advance both the
 *      counter and the sample ring, and updates the cached GPS — proving
 *      the only thing that changed was the mute flag.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, watchPositionMetricsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { WebSocket } from "ws";
import { handleMessage, type WatchSession } from "../routes/ws-watch.js";
import { issueWatchToken } from "../lib/watch-token.js";
import {
  muteWatchSession,
  unmuteWatchSession,
  isWatchSessionMuted,
  getRecentWatchPositionSamples,
  _peekWatchPositionAccumulatorForTests,
  _resetWatchPositionMetricsForTests,
} from "../lib/watchPositionMetrics.js";

function makeStubSession(sessionId: string): {
  session: WatchSession;
  sent: object[];
} {
  const sent: object[] = [];
  const ws = {
    readyState: 1, // WebSocket.OPEN — `send()` in ws-watch.ts gates on this.
    send: (data: string) => {
      sent.push(JSON.parse(data) as object);
    },
  } as unknown as WebSocket;
  const session: WatchSession = {
    ws,
    userId: null,
    tournamentId: null,
    round: 1,
    sessionId,
    pushIntervalId: null,
    batteryMode: false,
    playerLat: null,
    playerLng: null,
  };
  return { session, sent };
}

async function authStubSession(
  session: WatchSession,
  userId: number,
): Promise<void> {
  const token = issueWatchToken(userId);
  await handleMessage(session, JSON.stringify({ type: "auth", token }));
}

describe("/ws/watch position handler — muted-session short-circuit (Task #1680)", () => {
  beforeEach(async () => {
    _resetWatchPositionMetricsForTests();
    await db.execute(
      sql`TRUNCATE TABLE ${watchPositionMetricsTable} RESTART IDENTITY`,
    );
  });

  afterAll(async () => {
    _resetWatchPositionMetricsForTests();
    await db.execute(
      sql`TRUNCATE TABLE ${watchPositionMetricsTable} RESTART IDENTITY`,
    );
  });

  it("does not advance the metric counter or the live-position sample ring while muted", async () => {
    const sessionId = `sess-mute-${Date.now()}`;
    const userId = 990_001;
    const { session, sent } = makeStubSession(sessionId);
    await authStubSession(session, userId);

    // Baseline: a single accepted frame advances both pipelines and caches
    // the GPS on the session so the next periodic push uses it. We assert
    // the baseline first so the muted-frame assertions below are meaningful
    // (i.e. "stayed at 1" rather than "stayed at 0 because nothing works").
    await handleMessage(
      session,
      JSON.stringify({ type: "position", lat: 12.34, lng: 56.78, accuracy: 5 }),
    );
    expect(_peekWatchPositionAccumulatorForTests(sessionId)?.count).toBe(1);
    expect((await getRecentWatchPositionSamples(sessionId)).totalSamples).toBe(1);
    expect(session.playerLat).toBe(12.34);
    expect(session.playerLng).toBe(56.78);

    // Mute via the same helper the super-admin endpoint calls.
    muteWatchSession(sessionId);
    expect(isWatchSessionMuted(sessionId)).toBe(true);

    // Drive another `position` frame through the WS handler. The mute
    // short-circuit must kick in *before* both write paths.
    await handleMessage(
      session,
      JSON.stringify({ type: "position", lat: 20, lng: 40, accuracy: 8 }),
    );

    // (a) No metric counter advanced — accumulator is still at 1, not 2.
    expect(_peekWatchPositionAccumulatorForTests(sessionId)?.count).toBe(1);

    // (b) No live-position broadcast was emitted to the ops sample ring.
    const samples = await getRecentWatchPositionSamples(sessionId);
    expect(samples.totalSamples).toBe(1);
    // The single sample we have is the pre-mute one, not the muted frame.
    expect(samples.samples[0].lat).toBe(12.34);
    expect(samples.samples[0].lng).toBe(56.78);

    // The cached GPS on the session was likewise not overwritten — a future
    // hole_context push will keep using the last accepted fix instead of
    // the muted (potentially bogus / spammy) one.
    expect(session.playerLat).toBe(12.34);
    expect(session.playerLng).toBe(56.78);

    // The handler returned silently, no `error` frame on the wire — the
    // mute is invisible to the watch by design (it just sees its messages
    // get acknowledged at the TCP layer).
    const errors = sent.filter(
      (m) => (m as { type?: string }).type === "error",
    );
    expect(errors).toEqual([]);
  });

  it("resumes counting and broadcasting once unmuteWatchSession is called", async () => {
    const sessionId = `sess-unmute-${Date.now()}`;
    const userId = 990_002;
    const { session } = makeStubSession(sessionId);
    await authStubSession(session, userId);

    // Mute first, then send a frame — proves the gate is active.
    muteWatchSession(sessionId);
    await handleMessage(
      session,
      JSON.stringify({ type: "position", lat: 1, lng: 2, accuracy: 3 }),
    );
    expect(_peekWatchPositionAccumulatorForTests(sessionId)).toBeUndefined();
    expect((await getRecentWatchPositionSamples(sessionId)).totalSamples).toBe(0);
    expect(session.playerLat).toBeNull();
    expect(session.playerLng).toBeNull();

    // Lift the mute (the same helper the "unmute early" admin tool will call).
    unmuteWatchSession(sessionId);
    expect(isWatchSessionMuted(sessionId)).toBe(false);

    // Same shape of frame — this time everything must flow through.
    await handleMessage(
      session,
      JSON.stringify({ type: "position", lat: 10, lng: 20, accuracy: 4 }),
    );

    // Counter advances from 0 → 1 (a brand-new accumulator is created on
    // the first accepted frame after unmute).
    expect(_peekWatchPositionAccumulatorForTests(sessionId)?.count).toBe(1);

    // Live-position sample ring records the post-unmute fix.
    const samples = await getRecentWatchPositionSamples(sessionId);
    expect(samples.totalSamples).toBe(1);
    expect(samples.samples[0].lat).toBe(10);
    expect(samples.samples[0].lng).toBe(20);
    expect(samples.samples[0].accuracy).toBe(4);

    // And the cached session GPS is now the post-unmute fix.
    expect(session.playerLat).toBe(10);
    expect(session.playerLng).toBe(20);
  });
});
