/**
 * Task #1877 — pure-function unit tests for `computeReceiptDigestOverdueBy`.
 *
 * The dashboard panel relies on this helper to decide whether to render
 * the "missed scheduled run" banner. The boundary cases below pin the
 * contract that:
 *   1. The cron is on schedule when `nextRunAt - now <= one period`
 *      (so brief jitter does not raise the banner).
 *   2. A run that has already executed at-or-after `nextRunAt` is
 *      considered "caught up" and suppresses the warning even when the
 *      next-run pointer hasn't been advanced yet.
 *   3. Disabled / missing schedules and missing `nextRunAt` never
 *      surface as overdue.
 */
import { describe, it, expect } from "vitest";
import { computeReceiptDigestOverdueBy } from "../routes/side-games-v2";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

describe("computeReceiptDigestOverdueBy (Task #1877)", () => {
  const now = new Date("2026-04-30T12:00:00.000Z");

  it("returns null when the schedule is null", () => {
    expect(computeReceiptDigestOverdueBy(null, [], now)).toBeNull();
  });

  it("returns null when the schedule is paused", () => {
    expect(computeReceiptDigestOverdueBy(
      { frequency: "weekly", enabled: false, nextRunAt: new Date("2026-04-01T07:00:00.000Z") },
      [],
      now,
    )).toBeNull();
  });

  it("returns null when the schedule has no nextRunAt set yet", () => {
    expect(computeReceiptDigestOverdueBy(
      { frequency: "weekly", enabled: true, nextRunAt: null },
      [],
      now,
    )).toBeNull();
  });

  it("returns null when nextRunAt is in the future", () => {
    expect(computeReceiptDigestOverdueBy(
      { frequency: "weekly", enabled: true, nextRunAt: new Date(now.getTime() + DAY_MS) },
      [],
      now,
    )).toBeNull();
  });

  it("returns null when nextRunAt is overdue but within one period of slack (weekly)", () => {
    // 6 days late on a weekly cadence — within the one-period grace window.
    const nextRunAt = new Date(now.getTime() - 6 * DAY_MS);
    expect(computeReceiptDigestOverdueBy(
      { frequency: "weekly", enabled: true, nextRunAt },
      [],
      now,
    )).toBeNull();
  });

  it("returns null exactly at the one-period boundary (weekly)", () => {
    // Exactly one period late — still within the grace window (we
    // require strictly more than one period to alert).
    const nextRunAt = new Date(now.getTime() - WEEK_MS);
    expect(computeReceiptDigestOverdueBy(
      { frequency: "weekly", enabled: true, nextRunAt },
      [],
      now,
    )).toBeNull();
  });

  it("flags as overdue when nextRunAt is more than one period in the past (weekly)", () => {
    // 14 days late on a weekly cadence — well beyond the grace window.
    const nextRunAt = new Date(now.getTime() - 14 * DAY_MS);
    const result = computeReceiptDigestOverdueBy(
      { frequency: "weekly", enabled: true, nextRunAt },
      [],
      now,
    );
    expect(result).not.toBeNull();
    expect(result?.overdueByMs).toBe(14 * DAY_MS);
    expect(result?.periodMs).toBe(WEEK_MS);
    expect(result?.expectedAt).toBe(nextRunAt.toISOString());
  });

  it("flags as overdue on the daily cadence after >1 day", () => {
    // 2 days late on a daily cadence.
    const nextRunAt = new Date(now.getTime() - 2 * DAY_MS);
    const result = computeReceiptDigestOverdueBy(
      { frequency: "daily", enabled: true, nextRunAt },
      [],
      now,
    );
    expect(result).not.toBeNull();
    expect(result?.periodMs).toBe(DAY_MS);
  });

  it("suppresses the warning when a history row caught up at-or-after nextRunAt", () => {
    // Defensive: nextRunAt is 14 days in the past, but a run already
    // executed shortly after the planned time. The cron isn't stalled —
    // `nextRunAt` just hasn't been advanced by the next poll yet.
    const nextRunAt = new Date(now.getTime() - 14 * DAY_MS);
    const caughtUpRun = { sentAt: new Date(nextRunAt.getTime() + 60 * 1000) };
    expect(computeReceiptDigestOverdueBy(
      { frequency: "weekly", enabled: true, nextRunAt },
      [caughtUpRun],
      now,
    )).toBeNull();
  });

  it("still flags as overdue when history rows exist but are all older than nextRunAt", () => {
    const nextRunAt = new Date(now.getTime() - 14 * DAY_MS);
    const oldRun = { sentAt: new Date(nextRunAt.getTime() - DAY_MS) };
    const result = computeReceiptDigestOverdueBy(
      { frequency: "weekly", enabled: true, nextRunAt },
      [oldRun],
      now,
    );
    expect(result).not.toBeNull();
  });
});
