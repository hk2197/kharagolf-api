/**
 * Integration tests for the watch GPS position-rate metrics (Task #877).
 *
 * Confirms that the in-process bucket roller flushes one-minute counts to the
 * `watch_position_metrics` table, that aggregations recover the rate, and that
 * the prune cron only deletes rows older than 90 days.
 *
 * Hits the real PostgreSQL database (DATABASE_URL).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, watchPositionMetricsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  recordWatchPosition,
  flushWatchPositionSession,
  getWatchPositionMetricsSummary,
  getTopSessionsForBucket,
  pruneWatchPositionMetrics,
  _resetWatchPositionMetricsForTests,
  _peekWatchPositionAccumulatorForTests,
} from "../lib/watchPositionMetrics";

async function clearTable() {
  await db.execute(sql`TRUNCATE TABLE ${watchPositionMetricsTable} RESTART IDENTITY`);
}

// The persistence path is fire-and-forget (`void db.insert(...)`), but the
// in-process insert resolves on the next microtask. Wait one round-trip so
// the row is visible to subsequent reads.
async function tick(ms = 50) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("watchPositionMetrics", () => {
  beforeEach(async () => {
    _resetWatchPositionMetricsForTests();
    await clearTable();
  });

  afterAll(async () => {
    await clearTable();
  });

  it("returns empty windows when nothing has been recorded", async () => {
    const s = await getWatchPositionMetricsSummary();
    expect(s.windows["24h"].bucketCount).toBe(0);
    expect(s.windows["7d"].bucketCount).toBe(0);
    expect(s.windows["30d"].bucketCount).toBe(0);
    expect(s.windows["24h"].totalMessages).toBe(0);
    expect(s.recent).toEqual([]);
  });

  it("buffers within a minute and flushes when the bucket rolls forward", async () => {
    const sessionId = "sess-roll-1";
    const minuteA = Math.floor(Date.now() / 60_000) * 60_000;
    const minuteB = minuteA + 60_000;

    // Three messages all in minute A — should accumulate, not persist yet.
    recordWatchPosition({ userId: 42, sessionId, tournamentId: 7, batteryMode: false, nowMs: minuteA + 1_000 });
    recordWatchPosition({ userId: 42, sessionId, tournamentId: 7, batteryMode: false, nowMs: minuteA + 5_000 });
    recordWatchPosition({ userId: 42, sessionId, tournamentId: 7, batteryMode: false, nowMs: minuteA + 30_000 });

    const acc = _peekWatchPositionAccumulatorForTests(sessionId);
    expect(acc?.count).toBe(3);
    expect(acc?.bucketMinuteMs).toBe(minuteA);

    // First message in minute B triggers a flush of minute A.
    recordWatchPosition({ userId: 42, sessionId, tournamentId: 7, batteryMode: false, nowMs: minuteB + 2_000 });
    await tick();

    const rowsAfterRoll = await db.select().from(watchPositionMetricsTable);
    expect(rowsAfterRoll).toHaveLength(1);
    expect(rowsAfterRoll[0].positionCount).toBe(3);
    expect(rowsAfterRoll[0].sessionId).toBe(sessionId);
    expect(rowsAfterRoll[0].userId).toBe(42);
    expect(rowsAfterRoll[0].tournamentId).toBe(7);
    expect(rowsAfterRoll[0].bucketMinute.getTime()).toBe(minuteA);

    // Minute B accumulator now holds 1.
    const accB = _peekWatchPositionAccumulatorForTests(sessionId);
    expect(accB?.count).toBe(1);
    expect(accB?.bucketMinuteMs).toBe(minuteB);
  });

  it("flushes the partial bucket on session close so per-minute totals aren't lost", async () => {
    const sessionId = "sess-close-1";
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    recordWatchPosition({ userId: 1, sessionId, tournamentId: null, batteryMode: true, nowMs: minute + 1_000 });
    recordWatchPosition({ userId: 1, sessionId, tournamentId: null, batteryMode: true, nowMs: minute + 2_000 });

    flushWatchPositionSession(sessionId);
    await tick();

    const rows = await db.select().from(watchPositionMetricsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].positionCount).toBe(2);
    expect(rows[0].batteryMode).toBe(true);
    expect(rows[0].tournamentId).toBeNull();
    // Accumulator is removed.
    expect(_peekWatchPositionAccumulatorForTests(sessionId)).toBeUndefined();
  });

  it("aggregates rate stats across sessions in the 24h window", async () => {
    // Two sessions, two minutes each → 4 buckets total.
    // session A: 5 + 7 messages
    // session B: 10 + 12 messages
    // Counts per session-minute: [5, 7, 10, 12] → avg 8.5, max 12, p50 ~8.5
    const base = Math.floor(Date.now() / 60_000) * 60_000 - 60_000 * 5;

    for (const [sid, uid, counts] of [
      ["sess-A", 1, [5, 7]],
      ["sess-B", 2, [10, 12]],
    ] as const) {
      counts.forEach((count, i) => {
        const minuteMs = base + i * 60_000;
        for (let n = 0; n < count; n++) {
          recordWatchPosition({
            userId: uid,
            sessionId: sid,
            tournamentId: 99,
            batteryMode: false,
            nowMs: minuteMs + 1_000 + n * 10,
          });
        }
      });
      // Force flush of the last bucket.
      flushWatchPositionSession(sid);
    }
    await tick();

    const s = await getWatchPositionMetricsSummary();
    const w = s.windows["24h"];
    expect(w.bucketCount).toBe(4);
    expect(w.totalMessages).toBe(5 + 7 + 10 + 12);
    expect(w.activeSessionCount).toBe(2);
    expect(w.avgMessagesPerSessionMinute).toBe(8.5);
    expect(w.maxMessagesPerSessionMinute).toBe(12);
    expect(w.p95MessagesPerSessionMinute).toBeGreaterThanOrEqual(11);
    expect(s.recent.length).toBe(4);
  });

  it("survives a 'restart' — aggregates re-read from the DB", async () => {
    const sessionId = "sess-restart";
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    for (let i = 0; i < 4; i++) {
      recordWatchPosition({ userId: 5, sessionId, tournamentId: 1, batteryMode: false, nowMs: minute + i * 1_000 });
    }
    flushWatchPositionSession(sessionId);
    await tick();

    // Simulate process restart: in-memory accumulators are gone; DB rows stay.
    _resetWatchPositionMetricsForTests();

    const s = await getWatchPositionMetricsSummary();
    expect(s.windows["24h"].bucketCount).toBe(1);
    expect(s.windows["24h"].totalMessages).toBe(4);
    expect(s.recent).toHaveLength(1);
  });

  // ── getTopSessionsForBucket (Task #1195 — chart drill-down) ─────────────
  describe("getTopSessionsForBucket", () => {
    it("returns top sessions in a bucket ordered by total messages desc", async () => {
      // Build three sessions across two minute-rows inside a single 5-minute
      // window. Totals: A = 3, B = 30, C = 12.
      const minute0 = Math.floor(Date.now() / 60_000) * 60_000 - 60_000 * 10;
      const rows = [
        { sessionId: "sess-A", userId: 100, tournamentId: 11, batteryMode: false, bucketMinute: new Date(minute0), positionCount: 1 },
        { sessionId: "sess-A", userId: 100, tournamentId: 11, batteryMode: false, bucketMinute: new Date(minute0 + 60_000), positionCount: 2 },
        { sessionId: "sess-B", userId: 200, tournamentId: 22, batteryMode: true, bucketMinute: new Date(minute0), positionCount: 18 },
        { sessionId: "sess-B", userId: 200, tournamentId: 22, batteryMode: true, bucketMinute: new Date(minute0 + 60_000), positionCount: 12 },
        { sessionId: "sess-C", userId: 300, tournamentId: null, batteryMode: false, bucketMinute: new Date(minute0 + 60_000), positionCount: 12 },
      ];
      await db.insert(watchPositionMetricsTable).values(rows);

      // Bucket spans 5 minutes — covers all of the rows above.
      const top = await getTopSessionsForBucket(minute0, minute0 + 5 * 60_000, 10);
      expect(top.map((s) => s.sessionId)).toEqual(["sess-B", "sess-C", "sess-A"]);
      expect(top[0]).toMatchObject({
        sessionId: "sess-B",
        userId: 200,
        tournamentId: 22,
        positionCount: 30,
        bucketCount: 2,
        batteryMode: true,
      });
      expect(top[1]).toMatchObject({
        sessionId: "sess-C",
        userId: 300,
        tournamentId: null,
        positionCount: 12,
        bucketCount: 1,
        batteryMode: false,
      });
      expect(top[2]).toMatchObject({
        sessionId: "sess-A",
        userId: 100,
        tournamentId: 11,
        positionCount: 3,
        bucketCount: 2,
        batteryMode: false,
      });
    });

    it("excludes rows outside the [start, end) bucket window", async () => {
      const minute = Math.floor(Date.now() / 60_000) * 60_000 - 60_000 * 30;
      await db.insert(watchPositionMetricsTable).values([
        { sessionId: "sess-in", userId: 1, tournamentId: 1, batteryMode: false, bucketMinute: new Date(minute), positionCount: 5 },
        // One minute before the window — excluded.
        { sessionId: "sess-before", userId: 2, tournamentId: 1, batteryMode: false, bucketMinute: new Date(minute - 60_000), positionCount: 100 },
        // Exactly at the end — excluded (half-open interval).
        { sessionId: "sess-end", userId: 3, tournamentId: 1, batteryMode: false, bucketMinute: new Date(minute + 60_000), positionCount: 50 },
      ]);

      const top = await getTopSessionsForBucket(minute, minute + 60_000, 10);
      expect(top).toHaveLength(1);
      expect(top[0].sessionId).toBe("sess-in");
      expect(top[0].positionCount).toBe(5);
    });

    it("respects the limit and clamps it to a sane range", async () => {
      const minute = Math.floor(Date.now() / 60_000) * 60_000 - 60_000 * 5;
      const inserts = Array.from({ length: 6 }, (_, i) => ({
        sessionId: `sess-${i}`,
        userId: i + 1,
        tournamentId: 1,
        batteryMode: false,
        bucketMinute: new Date(minute),
        positionCount: 10 - i, // descending so order is deterministic
      }));
      await db.insert(watchPositionMetricsTable).values(inserts);

      const top3 = await getTopSessionsForBucket(minute, minute + 60_000, 3);
      expect(top3).toHaveLength(3);
      expect(top3.map((s) => s.sessionId)).toEqual(["sess-0", "sess-1", "sess-2"]);

      // Bogus limit (0) is clamped up to 1.
      const top0 = await getTopSessionsForBucket(minute, minute + 60_000, 0);
      expect(top0).toHaveLength(1);
    });

    it("returns an empty array for malformed bucket bounds", async () => {
      expect(await getTopSessionsForBucket(NaN, Date.now(), 10)).toEqual([]);
      expect(await getTopSessionsForBucket(Date.now(), NaN, 10)).toEqual([]);
      // end <= start
      const t = Date.now();
      expect(await getTopSessionsForBucket(t, t, 10)).toEqual([]);
      expect(await getTopSessionsForBucket(t + 1000, t, 10)).toEqual([]);
    });

    it("returns an empty array when no rows fall inside the bucket", async () => {
      const minute = Math.floor(Date.now() / 60_000) * 60_000 - 60_000 * 100;
      const top = await getTopSessionsForBucket(minute, minute + 60_000, 10);
      expect(top).toEqual([]);
    });
  });

  // ── seriesByWindow bucketing (Task #1028 / #1196) ────────────────────────
  //
  // The summary now exposes a `seriesByWindow` shape so the dashboard can
  // render a chart alongside the headline numbers. Bucket sizes are:
  //   - 24h → per minute   (60 s)
  //   - 7d  → per hour     (3 600 s)
  //   - 30d → per 6 hours  (21 600 s)
  //
  // These tests assert the rollup math directly: insert rows at known
  // bucket_minute timestamps and check the per-window aggregator collapses
  // them into the right number of points with the right avg/p95/max and
  // battery-vs-normal splits. Direct INSERTs (not recordWatchPosition()) so
  // we can place rows in past minutes/hours/days deterministically.
  describe("seriesByWindow", () => {
    it("exposes the documented bucket sizes for each window", async () => {
      const s = await getWatchPositionMetricsSummary();
      expect(s.seriesBucketSeconds).toEqual({
        "24h": 60,
        "7d": 60 * 60,
        "30d": 6 * 60 * 60,
      });
    });

    it("buckets the 24h series by minute and aggregates avg/max per bucket", async () => {
      // Anchor 1 h ago so we're well inside the 24h window but never in the
      // current (still-incrementing) minute.
      const HOUR_MS = 60 * 60_000;
      const minuteAnchor = Math.floor((Date.now() - HOUR_MS) / 60_000) * 60_000;
      const minuteA = new Date(minuteAnchor);
      const minuteB = new Date(minuteAnchor + 5 * 60_000);

      // Two sessions in minute A → counts 6 and 10.
      // One session in minute B → count 4.
      await db.insert(watchPositionMetricsTable).values([
        { userId: 1, sessionId: "s24h-a1", tournamentId: null, batteryMode: false, bucketMinute: minuteA, positionCount: 6 },
        { userId: 2, sessionId: "s24h-a2", tournamentId: null, batteryMode: false, bucketMinute: minuteA, positionCount: 10 },
        { userId: 3, sessionId: "s24h-b1", tournamentId: null, batteryMode: false, bucketMinute: minuteB, positionCount: 4 },
      ]);

      const s = await getWatchPositionMetricsSummary();
      const series = s.seriesByWindow["24h"];

      // Two distinct minute buckets → two points.
      expect(series).toHaveLength(2);

      const pointA = series.find((p) => new Date(p.bucket).getTime() === minuteA.getTime());
      const pointB = series.find((p) => new Date(p.bucket).getTime() === minuteB.getTime());
      expect(pointA).toBeDefined();
      expect(pointB).toBeDefined();

      // Bucket A: two samples (sessions s24h-a1, s24h-a2 with counts 6, 10).
      expect(pointA!.sampleCount).toBe(2);
      expect(pointA!.avg).toBe(8); // (6 + 10) / 2
      expect(pointA!.max).toBe(10);
      // p95 with only two data points lands on the upper sample (10).
      expect(pointA!.p95).toBeGreaterThanOrEqual(9.5);

      // Bucket B: single sample.
      expect(pointB!.sampleCount).toBe(1);
      expect(pointB!.avg).toBe(4);
      expect(pointB!.max).toBe(4);
    });

    it("buckets the 7d series by hour, collapsing minutes inside the same hour", async () => {
      // Anchor 3 days ago — outside 24h, inside 7d.
      const HOUR_MS = 60 * 60_000;
      const DAY_MS = 24 * HOUR_MS;
      const hourAnchor = Math.floor((Date.now() - 3 * DAY_MS) / HOUR_MS) * HOUR_MS;
      const hour1Min1 = new Date(hourAnchor + 1 * 60_000);
      const hour1Min50 = new Date(hourAnchor + 50 * 60_000);
      const hour2Min5 = new Date(hourAnchor + HOUR_MS + 5 * 60_000);

      // Two distinct minute rows in hour 1 → must collapse to one hourly bucket.
      // One row in hour 2 → second hourly bucket.
      await db.insert(watchPositionMetricsTable).values([
        { userId: 10, sessionId: "s7d-h1m1", tournamentId: null, batteryMode: false, bucketMinute: hour1Min1, positionCount: 5 },
        { userId: 11, sessionId: "s7d-h1m50", tournamentId: null, batteryMode: false, bucketMinute: hour1Min50, positionCount: 9 },
        { userId: 12, sessionId: "s7d-h2m5", tournamentId: null, batteryMode: false, bucketMinute: hour2Min5, positionCount: 6 },
      ]);

      const s = await getWatchPositionMetricsSummary();

      // 3 days ago is outside the 24h window → no 24h points from these rows.
      expect(s.seriesByWindow["24h"]).toHaveLength(0);

      const series7d = s.seriesByWindow["7d"];
      expect(series7d).toHaveLength(2);

      const hourBucket1 = new Date(hourAnchor);
      const hourBucket2 = new Date(hourAnchor + HOUR_MS);
      const p1 = series7d.find((p) => new Date(p.bucket).getTime() === hourBucket1.getTime());
      const p2 = series7d.find((p) => new Date(p.bucket).getTime() === hourBucket2.getTime());
      expect(p1).toBeDefined();
      expect(p2).toBeDefined();

      // Hour 1: both per-minute rows fold into one hourly point.
      expect(p1!.sampleCount).toBe(2);
      expect(p1!.avg).toBe(7); // (5 + 9) / 2
      expect(p1!.max).toBe(9);
      // Hour 2: single sample.
      expect(p2!.sampleCount).toBe(1);
      expect(p2!.avg).toBe(6);
      expect(p2!.max).toBe(6);

      // 30d also covers them — same number of hourly rows folded into 6h
      // buckets. They both fall inside one 6h bucket here, so 30d sees one.
      const series30d = s.seriesByWindow["30d"];
      const SIX_H_MS = 6 * HOUR_MS;
      const expected6hStart = Math.floor(hourAnchor / SIX_H_MS) * SIX_H_MS;
      // hour1 + hour2 are within the same 6h window iff hourAnchor's hour-of-bucket
      // leaves room for one more hour, which is true unless hourAnchor sits on a
      // 6h boundary's last slot. For our 3-day-ago anchor this collapses to
      // either one or two buckets depending on alignment — we only assert the
      // first bucket exists at the expected 6h boundary and includes hour1.
      const point30d = series30d.find((p) => new Date(p.bucket).getTime() === expected6hStart);
      expect(point30d).toBeDefined();
      expect(point30d!.sampleCount).toBeGreaterThanOrEqual(1);
    });

    it("buckets the 30d series by 6h and splits battery-vs-normal stats", async () => {
      // Anchor 10 days ago — outside 7d, inside 30d. Pin to a 6h boundary
      // so we have full control over which rows share a bucket.
      const HOUR_MS = 60 * 60_000;
      const DAY_MS = 24 * HOUR_MS;
      const SIX_H_MS = 6 * HOUR_MS;
      const sixHAnchor = Math.floor((Date.now() - 10 * DAY_MS) / SIX_H_MS) * SIX_H_MS;

      // Bucket 1 (00:00–06:00 of that 6h window): mixed battery + normal.
      const b1Battery = new Date(sixHAnchor + 30 * 60_000); // +30 min, battery
      const b1Normal = new Date(sixHAnchor + 5 * HOUR_MS + 30 * 60_000); // +5h30, normal
      // Bucket 2 (next 6h window): single normal sample.
      const b2Normal = new Date(sixHAnchor + 7 * HOUR_MS); // +7h, normal

      await db.insert(watchPositionMetricsTable).values([
        { userId: 20, sessionId: "s30d-b1-batt", tournamentId: null, batteryMode: true, bucketMinute: b1Battery, positionCount: 10 },
        { userId: 21, sessionId: "s30d-b1-norm", tournamentId: null, batteryMode: false, bucketMinute: b1Normal, positionCount: 4 },
        { userId: 22, sessionId: "s30d-b2-norm", tournamentId: null, batteryMode: false, bucketMinute: b2Normal, positionCount: 7 },
      ]);

      const s = await getWatchPositionMetricsSummary();

      // 10d ago is outside both 24h and 7d → no points there.
      expect(s.seriesByWindow["24h"]).toHaveLength(0);
      expect(s.seriesByWindow["7d"]).toHaveLength(0);

      const series30d = s.seriesByWindow["30d"];
      expect(series30d).toHaveLength(2);

      const bucket1Start = sixHAnchor;
      const bucket2Start = sixHAnchor + SIX_H_MS;
      const point1 = series30d.find((p) => new Date(p.bucket).getTime() === bucket1Start);
      const point2 = series30d.find((p) => new Date(p.bucket).getTime() === bucket2Start);
      expect(point1).toBeDefined();
      expect(point2).toBeDefined();

      // Bucket 1 — battery + normal mixed.
      expect(point1!.sampleCount).toBe(2);
      expect(point1!.avg).toBe(7); // (10 + 4) / 2
      expect(point1!.max).toBe(10);
      // Battery split: one battery row (10), one normal row (4).
      expect(point1!.batterySampleCount).toBe(1);
      expect(point1!.batteryAvg).toBe(10);
      expect(point1!.normalSampleCount).toBe(1);
      expect(point1!.normalAvg).toBe(4);

      // Bucket 2 — single normal row, no battery contribution.
      expect(point2!.sampleCount).toBe(1);
      expect(point2!.avg).toBe(7);
      expect(point2!.max).toBe(7);
      expect(point2!.batterySampleCount).toBe(0);
      expect(point2!.batteryAvg).toBeNull();
      expect(point2!.normalSampleCount).toBe(1);
      expect(point2!.normalAvg).toBe(7);
    });

    it("returns empty series arrays for every window when no rows exist", async () => {
      const s = await getWatchPositionMetricsSummary();
      expect(s.seriesByWindow["24h"]).toEqual([]);
      expect(s.seriesByWindow["7d"]).toEqual([]);
      expect(s.seriesByWindow["30d"]).toEqual([]);
    });
  });

  it("prune deletes rows older than 90 days", async () => {
    // Recent row — should survive.
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    recordWatchPosition({ userId: 1, sessionId: "sess-keep", tournamentId: null, batteryMode: false, nowMs: minute });
    flushWatchPositionSession("sess-keep");
    await tick();

    // Backdated row — should be pruned.
    await db.insert(watchPositionMetricsTable).values({
      userId: 999,
      sessionId: "sess-old",
      tournamentId: null,
      batteryMode: false,
      bucketMinute: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
      positionCount: 50,
    });

    const { deleted } = await pruneWatchPositionMetrics();
    expect(deleted).toBe(1);
    const rows = await db.select().from(watchPositionMetricsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("sess-keep");
  });
});
