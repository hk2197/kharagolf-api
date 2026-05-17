/**
 * Tests for Task #1374 — when the in-process watch GPS message-rate
 * trend detector in `watchPositionMetrics.ts` fires, it now also pages
 * on-call via Slack and/or PagerDuty in addition to the existing
 * `logger.warn` + ops email branch.
 *
 * Covers:
 *   - Target resolution: `OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK` and
 *     `OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY` are independent;
 *     either, both, or neither may be set; whitespace/empty strings
 *     are normalized to "unset".
 *   - End-to-end dispatch when the trend fires: Slack webhook + PD
 *     routing key are each posted exactly once with the right shape
 *     (recent / baseline numbers, window size, multiplier).
 *   - Cooldown coupling: a second qualifying push within the warn
 *     cooldown does NOT re-dispatch (mirrors the warn-log + email
 *     throttle).
 *   - Unset env: a qualifying spike with no chat targets configured
 *     dispatches zero chat pages (and warn-logs once via the cooldown).
 *   - Independence: a Slack failure doesn't suppress the PagerDuty
 *     trigger and vice versa.
 *
 * The Slack/PagerDuty senders are mocked so no real HTTP traffic is
 * attempted. The mailer is mocked too so the email branch from
 * Task #1189 doesn't try to send anything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendWatchPositionTrendOpsAlertEmail: vi.fn(async () => undefined),
}));

// Task #1652 — `watchPositionMetrics` now resolves chat targets via the
// shared `resolveOpsAlertChatTargets` helper exported from this module.
// Use a partial mock (importOriginal) so the senders are stubbed for
// dispatch assertions while the real env-resolver runs against
// `process.env` in the resolver tests below.
vi.mock("../lib/opsAlertChat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/opsAlertChat.js")>();
  return {
    ...actual,
    postWatchPositionTrendOpsAlertSlack: vi.fn(async () => undefined),
    triggerWatchPositionTrendOpsAlertPagerDuty: vi.fn(async () => undefined),
  };
});

import {
  _resetWatchPositionMetricsForTests,
  _resolveWatchGpsOpsAlertChatTargetsForTests,
  _pushTrendForTests,
} from "../lib/watchPositionMetrics.js";
import {
  postWatchPositionTrendOpsAlertSlack,
  triggerWatchPositionTrendOpsAlertPagerDuty,
} from "../lib/opsAlertChat.js";

const slackMock = vi.mocked(postWatchPositionTrendOpsAlertSlack);
const pdMock = vi.mocked(triggerWatchPositionTrendOpsAlertPagerDuty);

const ENV_KEYS = [
  "OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK",
  "OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY",
  // Task #1652 — shared chat-target fallback. Tracked here so the
  // resolver tests below see a known starting point regardless of
  // whether a developer has these set in their local env.
  "OPS_ALERT_SLACK_WEBHOOK",
  "OPS_ALERT_PAGERDUTY_ROUTING_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  slackMock.mockReset();
  slackMock.mockResolvedValue(undefined);
  pdMock.mockReset();
  pdMock.mockResolvedValue(undefined);
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

describe("watch GPS spike → chat target resolution", () => {
  it("returns both nulls when neither env var is set", () => {
    expect(_resolveWatchGpsOpsAlertChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: null,
    });
  });

  it("picks up just the Slack webhook when only that var is set", () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/AAA/BBB/CCC";
    expect(_resolveWatchGpsOpsAlertChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/AAA/BBB/CCC",
      pagerDutyRoutingKey: null,
    });
  });

  it("picks up just the PagerDuty routing key when only that var is set", () => {
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "R0UT1NGK3Y";
    expect(_resolveWatchGpsOpsAlertChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: "R0UT1NGK3Y",
    });
  });

  it("picks up both when both vars are set", () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/AAA/BBB/CCC";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "R0UT1NGK3Y";
    expect(_resolveWatchGpsOpsAlertChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/AAA/BBB/CCC",
      pagerDutyRoutingKey: "R0UT1NGK3Y",
    });
  });

  it("treats whitespace-only values as unset", () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "   ";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "\t\n";
    expect(_resolveWatchGpsOpsAlertChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: null,
    });
  });

  it("trims surrounding whitespace from set values", () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "  https://hooks.slack.com/services/AAA/BBB/CCC  ";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "  R0UT1NGK3Y\n";
    expect(_resolveWatchGpsOpsAlertChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/AAA/BBB/CCC",
      pagerDutyRoutingKey: "R0UT1NGK3Y",
    });
  });

  // ── Task #1652 — shared chat-target fallback ──────────────────────────
  // Each ops-alert flow may opt in to its own dedicated channel via
  // dedicated env vars; otherwise the resolver falls back to the
  // shared `OPS_ALERT_SLACK_WEBHOOK` / `OPS_ALERT_PAGERDUTY_ROUTING_KEY`
  // pair so a deploy can configure ops paging once and have every flow
  // (watch GPS, notify-retry exhaustion, future flows) page on it.

  it("falls back to OPS_ALERT_SLACK_WEBHOOK when the dedicated Slack var is unset", () => {
    process.env.OPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/SHARED/WEBHOOK";
    expect(_resolveWatchGpsOpsAlertChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/SHARED/WEBHOOK",
      pagerDutyRoutingKey: null,
    });
  });

  it("falls back to OPS_ALERT_PAGERDUTY_ROUTING_KEY when the dedicated PD var is unset", () => {
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "SHAREDPDKEY";
    expect(_resolveWatchGpsOpsAlertChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: "SHAREDPDKEY",
    });
  });

  it("dedicated env vars win over the shared fallback when both are set", () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/DEDICATED";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "DEDICATEDPDKEY";
    process.env.OPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/SHARED";
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "SHAREDPDKEY";
    expect(_resolveWatchGpsOpsAlertChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/DEDICATED",
      pagerDutyRoutingKey: "DEDICATEDPDKEY",
    });
  });

  it("a whitespace-only dedicated value still falls through to the shared fallback", () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "   ";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "\n";
    process.env.OPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/SHARED";
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "SHAREDPDKEY";
    expect(_resolveWatchGpsOpsAlertChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/SHARED",
      pagerDutyRoutingKey: "SHAREDPDKEY",
    });
  });
});

describe("watch GPS spike → chat dispatch", () => {
  it("posts to Slack when only the Slack webhook is configured", async () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/AAA/BBB/CCC";

    await fillRingWithSpike(1, 10);

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).not.toHaveBeenCalled();
    const arg = slackMock.mock.calls[0][0];
    expect(arg.webhookUrl).toBe("https://hooks.slack.com/services/AAA/BBB/CCC");
    expect(arg.recentAvg).toBe(10);
    expect(arg.baselineAvg).toBe(1);
    expect(arg.windowSize).toBe(20);
    expect(arg.multiplier).toBe(3);
    expect(arg.cooldownMinutes).toBe(10);
    expect(arg.now).toBeInstanceOf(Date);
  });

  it("triggers PagerDuty when only the routing key is configured", async () => {
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "R0UT1NGK3Y";

    await fillRingWithSpike(1, 10);

    expect(pdMock).toHaveBeenCalledTimes(1);
    expect(slackMock).not.toHaveBeenCalled();
    const arg = pdMock.mock.calls[0][0];
    expect(arg.routingKey).toBe("R0UT1NGK3Y");
    expect(arg.recentAvg).toBe(10);
    expect(arg.baselineAvg).toBe(1);
    expect(arg.windowSize).toBe(20);
    expect(arg.multiplier).toBe(3);
    expect(arg.cooldownMinutes).toBe(10);
    expect(arg.now).toBeInstanceOf(Date);
  });

  it("dispatches to both channels when both env vars are configured", async () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/AAA/BBB/CCC";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "R0UT1NGK3Y";

    await fillRingWithSpike(1, 10);

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when neither chat env var is set (warn-only)", async () => {
    await fillRingWithSpike(1, 10);
    expect(slackMock).not.toHaveBeenCalled();
    expect(pdMock).not.toHaveBeenCalled();
  });

  it("does not dispatch when the trend stays below the spike threshold", async () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/AAA/BBB/CCC";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "R0UT1NGK3Y";

    // Recent / baseline ratio is only 2× — under the 3× multiplier.
    await fillRingWithSpike(5, 10);

    expect(slackMock).not.toHaveBeenCalled();
    expect(pdMock).not.toHaveBeenCalled();
  });

  it("suppresses repeats inside the warn cooldown window", async () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/AAA/BBB/CCC";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "R0UT1NGK3Y";

    await fillRingWithSpike(1, 10);
    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);

    // Continue piling on more high values immediately. Each push
    // re-runs `maybeWarnOnTrend`, but the cooldown gate (10 min)
    // suppresses re-dispatch on both channels.
    for (let i = 0; i < 20; i++) _pushTrendForTests(10);
    await new Promise((r) => setTimeout(r, 0));

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });

  it("a Slack failure does not suppress the PagerDuty trigger", async () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/AAA/BBB/CCC";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "R0UT1NGK3Y";
    slackMock.mockRejectedValueOnce(new Error("slack down"));

    await fillRingWithSpike(1, 10);
    await new Promise((r) => setTimeout(r, 0));

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });

  it("a PagerDuty failure does not suppress the Slack post", async () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/AAA/BBB/CCC";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "R0UT1NGK3Y";
    pdMock.mockRejectedValueOnce(new Error("pd down"));

    await fillRingWithSpike(1, 10);
    await new Promise((r) => setTimeout(r, 0));

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });
});
