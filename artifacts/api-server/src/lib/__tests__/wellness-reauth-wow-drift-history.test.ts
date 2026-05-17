/**
 * Integration tests for Task #1577 — read-only N-week trend of average
 * `needs_reauth` per sweep run that powers the admin dashboard chart
 * underneath the WoW drift tile.
 *
 * Covers:
 *   1. Returns N consecutive non-overlapping 7-day buckets, oldest-first,
 *      with each bucket's aggregates matching the rows seeded into that
 *      week's window.
 *   2. The last bucket's aggregates are identical to the
 *      `getWeeklyReauthDriftSnapshot().thisWeek` aggregates so the chart
 *      and the tile can never disagree.
 *   3. `weeks` is clamped to `[MIN, MAX]` and falls back to the default on
 *      malformed values.
 *   4. Per-bucket `hasSufficientData` honors the `minRuns` config knob.
 */
import { describe, it, expect, afterAll, vi } from "vitest";

vi.mock("../mailer.js", async () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
}));

import { db, wellnessSweepRunsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

import {
  getWeeklyReauthDriftHistory,
  getWeeklyReauthDriftSnapshot,
  WELLNESS_REAUTH_WOW_HISTORY_DEFAULT_WEEKS,
  WELLNESS_REAUTH_WOW_HISTORY_MAX_WEEKS,
  WELLNESS_REAUTH_WOW_HISTORY_MIN_WEEKS,
  WELLNESS_REAUTH_WOW_WINDOW_DAYS,
} from "../wearables.js";

const insertedRunIds: number[] = [];

/**
 * Seed `count` rows into the half-open week-bucket
 * `[now - (weekIdx+1)*7d, now - weekIdx*7d)`, evenly spaced (one per hour
 * starting just after the bucket's start) so they all land inside it.
 */
async function seedWeek(now: Date, weekIdx: number, count: number, needsReauth: number): Promise<void> {
  const day = 24 * 60 * 60 * 1000;
  const start = new Date(now.getTime() - (weekIdx + 1) * 7 * day);
  for (let i = 0; i < count; i++) {
    const ranAt = new Date(start.getTime() + (i + 1) * 60 * 60 * 1000);
    const [row] = await db.insert(wellnessSweepRunsTable).values({
      ranAt,
      attempted: 100,
      succeeded: 100 - needsReauth,
      needsReauth,
      alerted: false,
    }).returning({ id: wellnessSweepRunsTable.id });
    insertedRunIds.push(row.id);
  }
}

afterAll(async () => {
  if (insertedRunIds.length > 0) {
    await db.delete(wellnessSweepRunsTable).where(inArray(wellnessSweepRunsTable.id, insertedRunIds));
  }
});

describe("getWeeklyReauthDriftHistory — bucketing", () => {
  it("returns N consecutive 7-day buckets, oldest-first, with per-bucket aggregates", async () => {
    // Distant-past anchor so this test's windows do not overlap with rows
    // seeded by sibling tests (snapshot test uses 2019-01..04).
    const now = new Date("2018-06-15T12:00:00Z");

    // Seed enough rows in each of the 4 most recent weeks to clear minRuns.
    await seedWeek(now, 0, 30, 5); // newest week, avg 5
    await seedWeek(now, 1, 30, 4);
    await seedWeek(now, 2, 30, 3);
    await seedWeek(now, 3, 30, 2);
    // Older weeks (4..7) intentionally left empty to verify the helper still
    // returns a row for them with runs=0 / hasSufficientData=false.

    const hist = await getWeeklyReauthDriftHistory({ now, weeks: 8 });
    expect(hist.weeks).toBe(8);
    expect(hist.buckets).toHaveLength(8);
    expect(hist.windowDays).toBe(WELLNESS_REAUTH_WOW_WINDOW_DAYS);
    expect(hist.threshold).toBeGreaterThan(0);
    expect(hist.minRuns).toBeGreaterThan(0);

    // Buckets are oldest-first → indexes 0..3 are the empty older weeks,
    // indexes 4..7 are the seeded ones with averages 2,3,4,5.
    expect(hist.buckets.slice(0, 4).every(b => b.runs === 0)).toBe(true);
    expect(hist.buckets.slice(0, 4).every(b => b.hasSufficientData === false)).toBe(true);

    expect(hist.buckets[4].averageNeedsReauth).toBeCloseTo(2, 5);
    expect(hist.buckets[5].averageNeedsReauth).toBeCloseTo(3, 5);
    expect(hist.buckets[6].averageNeedsReauth).toBeCloseTo(4, 5);
    expect(hist.buckets[7].averageNeedsReauth).toBeCloseTo(5, 5);
    expect(hist.buckets.slice(4).every(b => b.runs === 30)).toBe(true);
    expect(hist.buckets.slice(4).every(b => b.hasSufficientData === true)).toBe(true);

    // Buckets are non-overlapping and contiguous: each bucket's end ===
    // next bucket's start.
    for (let i = 0; i < hist.buckets.length - 1; i++) {
      expect(hist.buckets[i].weekEnd).toBe(hist.buckets[i + 1].weekStart);
    }
    // Final bucket ends at `now`.
    expect(hist.buckets[hist.buckets.length - 1].weekEnd).toBe(now.toISOString());
  });

  it("last bucket aggregates match getWeeklyReauthDriftSnapshot().thisWeek so the chart and tile cannot disagree", async () => {
    const now = new Date("2018-07-15T12:00:00Z");
    // Seed only the most recent two weeks so we have non-zero matches.
    await seedWeek(now, 0, 30, 7);
    await seedWeek(now, 1, 30, 1);

    const [hist, snap] = await Promise.all([
      getWeeklyReauthDriftHistory({ now, weeks: 4 }),
      getWeeklyReauthDriftSnapshot(null, { now }),
    ]);

    const last = hist.buckets[hist.buckets.length - 1];
    expect(last.runs).toBe(snap.thisWeek.runs);
    expect(last.totalNeedsReauth).toBe(snap.thisWeek.totalNeedsReauth);
    expect(last.averageNeedsReauth).toBeCloseTo(snap.thisWeek.averageNeedsReauth, 5);

    const prior = hist.buckets[hist.buckets.length - 2];
    expect(prior.runs).toBe(snap.lastWeek.runs);
    expect(prior.totalNeedsReauth).toBe(snap.lastWeek.totalNeedsReauth);
    expect(prior.averageNeedsReauth).toBeCloseTo(snap.lastWeek.averageNeedsReauth, 5);

    // And the chart's threshold matches the snapshot/cron threshold.
    expect(hist.threshold).toBe(snap.threshold);
  });
});

describe("getWeeklyReauthDriftHistory — `weeks` clamping", () => {
  it("clamps a too-large `weeks` down to MAX and a too-small one up to MIN", async () => {
    const now = new Date("2018-08-15T12:00:00Z");
    const tooBig = await getWeeklyReauthDriftHistory({ now, weeks: 999 });
    expect(tooBig.weeks).toBe(WELLNESS_REAUTH_WOW_HISTORY_MAX_WEEKS);
    expect(tooBig.buckets).toHaveLength(WELLNESS_REAUTH_WOW_HISTORY_MAX_WEEKS);

    const tooSmall = await getWeeklyReauthDriftHistory({ now, weeks: 1 });
    expect(tooSmall.weeks).toBe(WELLNESS_REAUTH_WOW_HISTORY_MIN_WEEKS);
    expect(tooSmall.buckets).toHaveLength(WELLNESS_REAUTH_WOW_HISTORY_MIN_WEEKS);
  });

  it("falls back to the default on malformed `weeks` (NaN, 0, negative)", async () => {
    const now = new Date("2018-09-15T12:00:00Z");
    for (const bad of [Number.NaN, 0, -3, Number.POSITIVE_INFINITY]) {
      const hist = await getWeeklyReauthDriftHistory({ now, weeks: bad });
      expect(hist.weeks).toBe(WELLNESS_REAUTH_WOW_HISTORY_DEFAULT_WEEKS);
      expect(hist.buckets).toHaveLength(WELLNESS_REAUTH_WOW_HISTORY_DEFAULT_WEEKS);
    }
  });

  it("uses the default when no `weeks` option is provided", async () => {
    const now = new Date("2018-10-15T12:00:00Z");
    const hist = await getWeeklyReauthDriftHistory({ now });
    expect(hist.weeks).toBe(WELLNESS_REAUTH_WOW_HISTORY_DEFAULT_WEEKS);
    expect(hist.buckets).toHaveLength(WELLNESS_REAUTH_WOW_HISTORY_DEFAULT_WEEKS);
  });
});
