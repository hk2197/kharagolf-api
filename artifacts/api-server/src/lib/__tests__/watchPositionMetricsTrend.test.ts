/**
 * Unit tests for the watch GPS spike trend warning in
 * `lib/watchPositionMetrics.ts` (TREND_WINDOW / TREND_BASELINE_MULTIPLIER /
 * TREND_MIN_RATE / TREND_WARN_COOLDOWN_MS).
 *
 * Drives `recordWatchPosition` + `flushWatchPositionSession` to push
 * fully-formed buckets through the in-process trend ring and asserts on a
 * spy of the shared pino logger:
 *
 *   (a) No warn fires before the ring is full (first TREND_RING_SIZE buckets).
 *   (b) Warn fires once the recent rolling avg crosses
 *       baseline avg × TREND_BASELINE_MULTIPLIER (and clears TREND_MIN_RATE).
 *   (c) Cooldown suppresses repeated warns while the spike persists.
 *   (d) A recent avg below the floor (TREND_MIN_RATE) stays quiet even when
 *       the multiplier ratio would otherwise be exceeded.
 *   (e) A recent avg that fails the multiplier check stays quiet even when
 *       both windows clear the floor.
 *
 * `@workspace/db` is mocked so the trend logic can be exercised without the
 * test schema bootstrap — the production code's `void db.insert(...)` path
 * is fire-and-forget, so the chain is only required to look thenable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@workspace/db", () => {
  const onConflictDoUpdate = vi.fn(() => Promise.resolve());
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  // `flushWatchPositionSession` calls `unmuteWatchSession`, which now
  // (Task #1679) fires a best-effort `db.delete(watchSessionMutesTable)`
  // — we don't care about the result here, only that the chain is
  // thenable so the fire-and-forget call resolves silently.
  const deleteWhere = vi.fn(() => Promise.resolve());
  const deleteFrom = vi.fn(() => ({ where: deleteWhere }));
  return {
    db: { insert, delete: deleteFrom },
    watchPositionMetricsTable: {
      sessionId: "session_id",
      bucketMinute: "bucket_minute",
      positionCount: "position_count",
    },
    watchSessionMutesTable: {
      sessionId: "session_id",
      expiresAt: "expires_at",
    },
  };
});

import {
  recordWatchPosition,
  flushWatchPositionSession,
  _resetWatchPositionMetricsForTests,
} from "../watchPositionMetrics.js";
import { logger } from "../logger.js";

const SESSION_ID = "watch-trend-test-session";
const USER_ID = 4242;
const MINUTE_MS = 60_000;
// Mirrors the constants in watchPositionMetrics.ts. Kept private there, so
// duplicated here on purpose — these tests are the contract that locks them in.
const TREND_WINDOW = 20;
const TREND_RING_SIZE = TREND_WINDOW * 2;
const TREND_MIN_RATE = 5;
const TREND_BASELINE_MULTIPLIER = 3;
const TREND_WARN_COOLDOWN_MS = 10 * 60 * 1000;

const TREND_WARN_MSG = "watch GPS msg rate trending up";

let warnSpy: ReturnType<typeof vi.spyOn>;

/**
 * Push exactly `count` position events into a single per-minute bucket and
 * flush the session so the bucket is persisted (and the trend ring updated).
 * Each call uses a fresh sessionId so the in-process accumulator never
 * carries state between buckets — the trend ring is module-level, which is
 * what we're exercising.
 */
function emitBucket(bucketIndex: number, count: number, baseTimeMs: number): void {
  const sessionId = `${SESSION_ID}-${bucketIndex}`;
  const nowMs = baseTimeMs + bucketIndex * MINUTE_MS;
  for (let i = 0; i < count; i++) {
    recordWatchPosition({
      userId: USER_ID,
      sessionId,
      tournamentId: null,
      batteryMode: false,
      nowMs,
    });
  }
  flushWatchPositionSession(sessionId);
}

function trendWarnCalls(): unknown[][] {
  return warnSpy.mock.calls.filter((call: unknown[]) => {
    const msg = call[call.length - 1];
    return typeof msg === "string" && msg.includes(TREND_WARN_MSG);
  });
}

beforeEach(() => {
  _resetWatchPositionMetricsForTests();
  // Freeze wall-clock so the cooldown comparison (`Date.now() - lastTrendWarnAt`)
  // is fully deterministic. Tests advance time explicitly via setSystemTime.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
  warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.useRealTimers();
});

describe("watchPositionMetrics trend warning", () => {
  it("does not warn until the ring is full (TREND_RING_SIZE buckets)", () => {
    // High-magnitude buckets — large enough that the warning would
    // certainly fire if the ring length check weren't gating it.
    const baseTime = Date.now();
    for (let i = 0; i < TREND_RING_SIZE - 1; i++) {
      emitBucket(i, 50, baseTime);
    }
    expect(trendWarnCalls()).toHaveLength(0);
  });

  it("warns when the recent avg crosses baseline × multiplier and clears the floor", () => {
    const baseTime = Date.now();
    // Baseline window: low, but non-zero rate.
    for (let i = 0; i < TREND_WINDOW; i++) {
      emitBucket(i, 2, baseTime);
    }
    // Still no warn — only the baseline half is full.
    expect(trendWarnCalls()).toHaveLength(0);

    // Recent window: 5x the baseline, comfortably above TREND_MIN_RATE.
    // baselineAvg = 2, recentAvg = 10 → 10 >= 2 * 3 ✓ and 10 >= 5 ✓.
    for (let i = 0; i < TREND_WINDOW; i++) {
      emitBucket(TREND_WINDOW + i, 10, baseTime);
    }

    const calls = trendWarnCalls();
    expect(calls).toHaveLength(1);
    const [meta, msg] = calls[0] as [Record<string, unknown>, string];
    expect(msg).toContain(TREND_WARN_MSG);
    expect(meta).toMatchObject({
      watchPosition: true,
      windowSize: TREND_WINDOW,
      multiplier: TREND_BASELINE_MULTIPLIER,
    });
    expect(meta.recentAvgMsgsPerSessionMinute).toBeCloseTo(10, 5);
    expect(meta.baselineAvgMsgsPerSessionMinute).toBeCloseTo(2, 5);
  });

  it("suppresses repeated warns within the cooldown window", () => {
    const baseTime = Date.now();
    // Drive the first warn (baseline 2 → recent 10).
    for (let i = 0; i < TREND_WINDOW; i++) emitBucket(i, 2, baseTime);
    for (let i = 0; i < TREND_WINDOW; i++) emitBucket(TREND_WINDOW + i, 10, baseTime);
    expect(trendWarnCalls()).toHaveLength(1);

    // Within the cooldown window: keep flushing high-rate buckets. The
    // ring keeps churning (still full, still satisfies the ratio + floor)
    // but the cooldown gate must keep the logger silent.
    vi.setSystemTime(new Date(Date.now() + TREND_WARN_COOLDOWN_MS - 1_000));
    for (let i = 0; i < TREND_RING_SIZE; i++) {
      emitBucket(TREND_RING_SIZE + i, 10, baseTime);
    }
    expect(trendWarnCalls()).toHaveLength(1);

    // Past the cooldown: the very next bucket flush that satisfies the
    // ratio re-arms the warn. Keep recent high vs. baseline low by first
    // refilling the baseline half with low values, then the recent half
    // with high values.
    vi.setSystemTime(new Date(Date.now() + 2_000)); // > cooldown by 1s
    for (let i = 0; i < TREND_WINDOW; i++) emitBucket(3 * TREND_RING_SIZE + i, 2, baseTime);
    for (let i = 0; i < TREND_WINDOW; i++) emitBucket(3 * TREND_RING_SIZE + TREND_WINDOW + i, 10, baseTime);
    expect(trendWarnCalls()).toHaveLength(2);
  });

  it("stays quiet when the recent avg is below the rate floor", () => {
    const baseTime = Date.now();
    // Baseline window: very low (1/min). Recent window: 4/min — that's a
    // 4x ratio (over the multiplier) but still under TREND_MIN_RATE = 5,
    // so the warn must not fire.
    for (let i = 0; i < TREND_WINDOW; i++) emitBucket(i, 1, baseTime);
    for (let i = 0; i < TREND_WINDOW; i++) emitBucket(TREND_WINDOW + i, 4, baseTime);
    expect(trendWarnCalls()).toHaveLength(0);
  });

  it("stays quiet when the recent avg fails the multiplier check", () => {
    const baseTime = Date.now();
    // Baseline 5/min, recent 10/min → both above the floor, ratio is only
    // 2x (< TREND_BASELINE_MULTIPLIER = 3). Must not warn.
    for (let i = 0; i < TREND_WINDOW; i++) emitBucket(i, 5, baseTime);
    for (let i = 0; i < TREND_WINDOW; i++) emitBucket(TREND_WINDOW + i, 10, baseTime);
    expect(trendWarnCalls()).toHaveLength(0);
  });

  it("stays quiet when the baseline window has no traffic (baselineAvg = 0)", () => {
    // The `baselineAvg > 0` guard in maybeWarnOnTrend exists so an idle
    // replica that suddenly sees its first burst of watch traffic does
    // not page ops the moment the ring fills. Empty/no-event flushes are
    // dropped by `persistBucket`'s `count <= 0` early-return, so they
    // never reach the trend ring at all — meaning the only way the
    // baseline window can be effectively zero is if no real buckets land
    // there. Verify that even a heavy burst on the recent half does not
    // fire the warning while the baseline half remains untouched.
    const baseTime = Date.now();
    // Baseline window: TREND_WINDOW empty flushes. None of these reach
    // the trend ring (no accumulator was ever created for the session).
    for (let i = 0; i < TREND_WINDOW; i++) {
      flushWatchPositionSession(`${SESSION_ID}-empty-${i}`);
    }
    // Recent window: TREND_WINDOW heavy buckets, way over the floor and
    // any plausible multiplier. The ring still only holds TREND_WINDOW
    // entries (< TREND_RING_SIZE), so the ring-not-full gate keeps the
    // logger silent — this is the same code path that protects against a
    // baselineAvg of 0.
    for (let i = 0; i < TREND_WINDOW; i++) {
      emitBucket(TREND_WINDOW + i, 100, baseTime);
    }
    expect(trendWarnCalls()).toHaveLength(0);
  });
});
