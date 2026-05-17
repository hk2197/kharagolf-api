/**
 * Integration tests for the shared `watch_position_samples` table backing
 * the watch GPS drill-down (Task #1392, promoted to a shared table in
 * Task #1676).
 *
 * Drives `recordWatchPositionSample` + `getRecentWatchPositionSamples` and
 * asserts:
 *   (a) Most-recent first ordering.
 *   (b) Per-session ring cap drops the oldest entry on insert.
 *   (c) `limit` parameter is honored and clamped.
 *   (d) TTL eviction excludes stale rows on read.
 *   (e) `pruneWatchPositionSamples` deletes rows older than the TTL.
 *   (f) Non-finite lat/lng or accuracy are filtered/normalised.
 *   (g) Per-session isolation (one session never bleeds into another).
 *   (h) Empty state for an unknown session.
 *
 * Hits the real PostgreSQL database (DATABASE_URL) — the in-process Map
 * was promoted to a shared table in Task #1676 so these are integration
 * tests now.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, watchPositionSamplesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  recordWatchPositionSample,
  getRecentWatchPositionSamples,
  pruneWatchPositionSamples,
} from "../watchPositionMetrics.js";

// Mirrors the constants in watchPositionMetrics.ts. Kept private there on
// purpose — these tests are the contract that locks them in.
const RING_SIZE = 100;
const TTL_MS = 30 * 60 * 1000;

const SESSION = "watch-sample-test-session";
const OTHER_SESSION = "watch-sample-test-other";

async function clearTable() {
  await db.execute(
    sql`DELETE FROM ${watchPositionSamplesTable} WHERE session_id LIKE 'watch-sample-test-%'`,
  );
}

beforeEach(async () => {
  await clearTable();
});

afterAll(async () => {
  await clearTable();
});

describe("watch position-sample shared store", () => {
  it("returns an empty response for an unknown session", async () => {
    const r = await getRecentWatchPositionSamples(SESSION);
    expect(r.sessionId).toBe(SESSION);
    expect(r.samples).toEqual([]);
    expect(r.totalSamples).toBe(0);
    expect(r.ringSize).toBe(RING_SIZE);
    expect(r.ttlSeconds).toBe(TTL_MS / 1000);
  });

  it("returns most-recent samples first", async () => {
    const t0 = Date.now() - 10 * 60_000; // recent so the TTL filter doesn't eat them
    await recordWatchPositionSample({ sessionId: SESSION, lat: 1.1, lng: 1.2, batteryMode: false, nowMs: t0 });
    await recordWatchPositionSample({ sessionId: SESSION, lat: 2.1, lng: 2.2, batteryMode: false, nowMs: t0 + 1_000 });
    await recordWatchPositionSample({ sessionId: SESSION, lat: 3.1, lng: 3.2, batteryMode: true,  nowMs: t0 + 2_000, accuracy: 4.5 });

    const r = await getRecentWatchPositionSamples(SESSION, 50, t0 + 3_000);
    expect(r.totalSamples).toBe(3);
    expect(r.samples).toHaveLength(3);
    // Newest first
    expect(r.samples[0].lat).toBe(3.1);
    expect(r.samples[0].batteryMode).toBe(true);
    expect(r.samples[0].accuracy).toBe(4.5);
    expect(r.samples[1].lat).toBe(2.1);
    expect(r.samples[1].accuracy).toBeNull(); // not provided
    expect(r.samples[2].lat).toBe(1.1);
    // Timestamps are ISO strings of the nowMs we injected.
    expect(r.samples[0].timestamp).toBe(new Date(t0 + 2_000).toISOString());
  });

  it("caps the per-session ring at RING_SIZE, dropping the oldest", async () => {
    const t0 = Date.now() - 10 * 60_000;
    // Record RING_SIZE + 5 samples, each 1 ms apart so the ordering is
    // unambiguous and lat carries the original index for assertion.
    for (let i = 0; i < RING_SIZE + 5; i++) {
      await recordWatchPositionSample({
        sessionId: SESSION,
        lat: i,
        lng: i,
        batteryMode: false,
        nowMs: t0 + i,
      });
    }
    const r = await getRecentWatchPositionSamples(SESSION, RING_SIZE, t0 + RING_SIZE + 100);
    expect(r.totalSamples).toBe(RING_SIZE);
    expect(r.samples).toHaveLength(RING_SIZE);
    // Newest sample is the last one we recorded.
    expect(r.samples[0].lat).toBe(RING_SIZE + 4);
    // Oldest still in the buffer is index 5 (samples 0..4 were evicted).
    expect(r.samples[r.samples.length - 1].lat).toBe(5);
  });

  it("honors and clamps the `limit` parameter", async () => {
    const t0 = Date.now() - 10 * 60_000;
    for (let i = 0; i < 10; i++) {
      await recordWatchPositionSample({ sessionId: SESSION, lat: i, lng: i, batteryMode: false, nowMs: t0 + i });
    }
    const r5 = await getRecentWatchPositionSamples(SESSION, 5, t0 + 100);
    expect(r5.samples).toHaveLength(5);
    expect(r5.totalSamples).toBe(10); // total isn't reduced by `limit`
    expect(r5.samples[0].lat).toBe(9);
    expect(r5.samples[4].lat).toBe(5);

    // Bogus limit (0) is clamped up to 1.
    const r0 = await getRecentWatchPositionSamples(SESSION, 0, t0 + 100);
    expect(r0.samples).toHaveLength(1);

    // Massive limit is clamped down to RING_SIZE.
    const rBig = await getRecentWatchPositionSamples(SESSION, 10_000, t0 + 100);
    expect(rBig.samples).toHaveLength(10); // we only have 10 entries
  });

  it("excludes samples older than the TTL on read", async () => {
    const t0 = Date.now() - 10 * 60_000;
    // 3 samples spaced over ~5 minutes.
    await recordWatchPositionSample({ sessionId: SESSION, lat: 1, lng: 1, batteryMode: false, nowMs: t0 });
    await recordWatchPositionSample({ sessionId: SESSION, lat: 2, lng: 2, batteryMode: false, nowMs: t0 + 60_000 });
    await recordWatchPositionSample({ sessionId: SESSION, lat: 3, lng: 3, batteryMode: false, nowMs: t0 + 5 * 60_000 });

    // Read right after — all three visible.
    const fresh = await getRecentWatchPositionSamples(SESSION, 50, t0 + 5 * 60_000);
    expect(fresh.totalSamples).toBe(3);

    // Jump forward TTL + 1 ms past the oldest sample → only the newest two
    // (60 s + 5 min from t0) remain in the read.
    const partial = await getRecentWatchPositionSamples(SESSION, 50, t0 + TTL_MS + 1);
    expect(partial.totalSamples).toBe(2);
    expect(partial.samples.map((s) => s.lat)).toEqual([3, 2]);

    // Jump well past the newest → buffer for the session reads as empty.
    const stale = await getRecentWatchPositionSamples(SESSION, 50, t0 + 5 * 60_000 + TTL_MS + 1);
    expect(stale.totalSamples).toBe(0);
    expect(stale.samples).toEqual([]);
  });

  it("pruneWatchPositionSamples deletes rows older than the TTL", async () => {
    const t0 = Date.now() - 10 * 60_000;
    await recordWatchPositionSample({ sessionId: SESSION, lat: 1, lng: 1, batteryMode: false, nowMs: t0 });
    await recordWatchPositionSample({ sessionId: SESSION, lat: 2, lng: 2, batteryMode: false, nowMs: t0 + 5 * 60_000 });

    // Run prune at a point where only the oldest is past TTL.
    const r = await pruneWatchPositionSamples(t0 + TTL_MS + 1);
    expect(r.deleted).toBe(1);

    // Sanity: the surviving row is still readable.
    const after = await getRecentWatchPositionSamples(SESSION, 50, t0 + TTL_MS + 1);
    expect(after.totalSamples).toBe(1);
    expect(after.samples[0].lat).toBe(2);
  });

  it("ignores non-finite lat/lng and normalises bad accuracy to null", async () => {
    const t0 = Date.now() - 10 * 60_000;
    // NaN lat → dropped silently.
    await recordWatchPositionSample({ sessionId: SESSION, lat: Number.NaN, lng: 1, batteryMode: false, nowMs: t0 });
    // Infinity lng → dropped silently.
    await recordWatchPositionSample({ sessionId: SESSION, lat: 1, lng: Number.POSITIVE_INFINITY, batteryMode: false, nowMs: t0 });
    // Valid coords + non-finite accuracy → kept, accuracy normalised to null.
    await recordWatchPositionSample({
      sessionId: SESSION,
      lat: 4.4,
      lng: 5.5,
      accuracy: Number.NaN,
      batteryMode: true,
      nowMs: t0 + 1_000,
    });

    const r = await getRecentWatchPositionSamples(SESSION, 50, t0 + 2_000);
    expect(r.totalSamples).toBe(1);
    expect(r.samples[0]).toMatchObject({ lat: 4.4, lng: 5.5, accuracy: null, batteryMode: true });
  });

  it("isolates samples per session", async () => {
    const t0 = Date.now() - 10 * 60_000;
    await recordWatchPositionSample({ sessionId: SESSION, lat: 1, lng: 1, batteryMode: false, nowMs: t0 });
    await recordWatchPositionSample({ sessionId: OTHER_SESSION, lat: 2, lng: 2, batteryMode: true, nowMs: t0 + 1 });
    await recordWatchPositionSample({ sessionId: OTHER_SESSION, lat: 3, lng: 3, batteryMode: true, nowMs: t0 + 2 });

    const a = await getRecentWatchPositionSamples(SESSION, 50, t0 + 100);
    const b = await getRecentWatchPositionSamples(OTHER_SESSION, 50, t0 + 100);
    expect(a.totalSamples).toBe(1);
    expect(a.samples[0].lat).toBe(1);
    expect(b.totalSamples).toBe(2);
    expect(b.samples.map((s) => s.lat)).toEqual([3, 2]);
  });

  it("makes inserts visible across separate read calls (cross-replica visibility)", async () => {
    // The whole point of Task #1676: the read doesn't depend on whichever
    // in-process Map happened to receive the writes. Once the row is
    // committed it's visible to *any* read against the same DB. We can't
    // simulate two replicas here, but we can prove the read goes through
    // the durable store by writing, then asserting the read finds the
    // exact row independent of any process-local state.
    const t0 = Date.now() - 10 * 60_000;
    await recordWatchPositionSample({ sessionId: SESSION, lat: 9.9, lng: 8.8, batteryMode: false, nowMs: t0 });

    const direct = await db
      .select()
      .from(watchPositionSamplesTable)
      .where(sql`session_id = ${SESSION}`);
    expect(direct).toHaveLength(1);
    expect(Number(direct[0].lat)).toBe(9.9);

    const viaApi = await getRecentWatchPositionSamples(SESSION, 50, t0 + 100);
    expect(viaApi.totalSamples).toBe(1);
    expect(viaApi.samples[0].lat).toBe(9.9);
  });
});
