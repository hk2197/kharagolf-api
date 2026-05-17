/**
 * Tests for Task #1189 — when the in-process watch GPS message-rate
 * trend detector in `watchPositionMetrics.ts` fires, it now dispatches
 * an ops alert email in addition to the existing `logger.warn`.
 *
 * Covers:
 *   - Recipient resolution: `OPS_WATCH_GPS_ALERT_EMAILS` (dedicated)
 *     wins over `OPS_ALERT_EMAILS` (shared); falls back when only the
 *     shared list is set; returns no recipients when neither is set.
 *   - End-to-end dispatch: filling the trend ring with a low baseline
 *     followed by a high-recent window triggers exactly one email per
 *     recipient with the correct trend numbers.
 *   - Cooldown coupling: a second qualifying push within the warn
 *     cooldown does NOT re-dispatch (mirrors the warn-log throttle).
 *   - Unset env: a qualifying spike with no recipients configured
 *     dispatches zero emails (and warn-logs once via the cooldown).
 *
 * The mailer is mocked so no SMTP traffic is attempted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendWatchPositionTrendOpsAlertEmail: vi.fn(async () => undefined),
}));

import {
  _resetWatchPositionMetricsForTests,
  _resolveWatchGpsOpsAlertRecipientsForTests,
  _pushTrendForTests,
} from "../lib/watchPositionMetrics.js";
import { sendWatchPositionTrendOpsAlertEmail } from "../lib/mailer.js";

const emailMock = vi.mocked(sendWatchPositionTrendOpsAlertEmail);

const ENV_KEYS = ["OPS_WATCH_GPS_ALERT_EMAILS", "OPS_ALERT_EMAILS"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  _resetWatchPositionMetricsForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

// Drive the trend ring directly: 20 baseline values then 20 recent
// values. The 40th push fills the ring and triggers the spike check
// because recentAvg / baselineAvg crosses the 3× threshold and recent
// clears the 5 msg/session-minute floor.
async function fillRingWithSpike(baseline: number, recent: number) {
  for (let i = 0; i < 20; i++) _pushTrendForTests(baseline);
  for (let i = 0; i < 20; i++) _pushTrendForTests(recent);
  // Fire-and-forget: the dispatch path uses `void send...().catch(...)`,
  // so let the queued microtasks drain before asserting.
  await new Promise((r) => setTimeout(r, 0));
}

describe("watch GPS spike → ops alert recipient resolution", () => {
  it("prefers OPS_WATCH_GPS_ALERT_EMAILS over OPS_ALERT_EMAILS", () => {
    process.env.OPS_WATCH_GPS_ALERT_EMAILS = "watch@example.com, wearables@example.com";
    process.env.OPS_ALERT_EMAILS = "ops@example.com";
    expect(_resolveWatchGpsOpsAlertRecipientsForTests()).toEqual([
      "watch@example.com",
      "wearables@example.com",
    ]);
  });

  it("falls back to OPS_ALERT_EMAILS when the dedicated var is unset", () => {
    process.env.OPS_ALERT_EMAILS = "ops@example.com,oncall@example.com";
    expect(_resolveWatchGpsOpsAlertRecipientsForTests()).toEqual([
      "ops@example.com",
      "oncall@example.com",
    ]);
  });

  it("returns an empty list when both env vars are unset", () => {
    expect(_resolveWatchGpsOpsAlertRecipientsForTests()).toEqual([]);
  });

  it("trims whitespace and drops empty entries", () => {
    process.env.OPS_WATCH_GPS_ALERT_EMAILS = "  a@example.com ,, b@example.com ,";
    expect(_resolveWatchGpsOpsAlertRecipientsForTests()).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });
});

describe("watch GPS spike → ops alert dispatch", () => {
  it("dispatches one email per recipient with recent/baseline numbers when the trend fires", async () => {
    process.env.OPS_WATCH_GPS_ALERT_EMAILS = "watch@example.com, wearables@example.com";

    await fillRingWithSpike(1, 10);

    expect(emailMock).toHaveBeenCalledTimes(2);
    const tos = emailMock.mock.calls.map((c) => c[0].to).sort();
    expect(tos).toEqual(["watch@example.com", "wearables@example.com"]);

    const arg = emailMock.mock.calls[0][0];
    expect(arg.recentAvg).toBe(10);
    expect(arg.baselineAvg).toBe(1);
    expect(arg.windowSize).toBe(20);
    expect(arg.multiplier).toBe(3);
    expect(arg.cooldownMinutes).toBe(10);
    expect(arg.now).toBeInstanceOf(Date);
  });

  it("uses OPS_ALERT_EMAILS when the dedicated var is unset", async () => {
    process.env.OPS_ALERT_EMAILS = "ops@example.com";

    await fillRingWithSpike(1, 10);

    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(emailMock.mock.calls[0][0].to).toBe("ops@example.com");
  });

  it("does not dispatch when neither recipient env var is set (warn-only)", async () => {
    await fillRingWithSpike(1, 10);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("does not dispatch when the trend stays below the spike threshold", async () => {
    process.env.OPS_WATCH_GPS_ALERT_EMAILS = "watch@example.com";

    // Recent / baseline ratio is only 2× — under the 3× multiplier.
    await fillRingWithSpike(5, 10);

    expect(emailMock).not.toHaveBeenCalled();
  });

  it("suppresses repeats inside the warn cooldown window", async () => {
    process.env.OPS_WATCH_GPS_ALERT_EMAILS = "watch@example.com";

    // First spike — fires.
    await fillRingWithSpike(1, 10);
    expect(emailMock).toHaveBeenCalledTimes(1);

    // Continue piling on more high values immediately. Each push
    // re-runs `maybeWarnOnTrend`, but the cooldown gate (10 min)
    // suppresses re-dispatch.
    for (let i = 0; i < 20; i++) _pushTrendForTests(10);
    await new Promise((r) => setTimeout(r, 0));

    expect(emailMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw if the mailer rejects (failures are logged, not surfaced)", async () => {
    process.env.OPS_WATCH_GPS_ALERT_EMAILS = "watch@example.com";
    emailMock.mockRejectedValueOnce(new Error("smtp down"));

    await fillRingWithSpike(1, 10);
    // Let the rejection settle.
    await new Promise((r) => setTimeout(r, 0));
    // Survives the rejection without throwing — assertion is implicit
    // (the test would have errored otherwise).
    expect(emailMock).toHaveBeenCalledTimes(1);
  });
});
