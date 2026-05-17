/**
 * Tests for Task #1653 — `sendWatchGpsOpsAlertTestPage`.
 *
 * The super-admin "Send test page" button on the watch GPS metrics
 * dashboard fires a clearly-labelled test page through the same Slack /
 * PagerDuty senders the real spike alert uses, so a typo in
 * `OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK` /
 * `OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY` surfaces immediately
 * instead of silently swallowing the next real spike.
 *
 * Covers:
 *   - Per-channel target resolution mirrors `_resolveWatchGpsOpsAlertChatTargetsForTests`
 *     (either / both / neither configured) and the public
 *     `getWatchGpsOpsAlertChatTargetsStatus` exposes the same shape
 *     without leaking the credentials.
 *   - When configured, the channel's sender is invoked exactly once
 *     with `testMode: true` so the recipient can tell it from a real
 *     spike, and with the configured webhook / routing key passed
 *     through unchanged.
 *   - Per-channel independence: a Slack failure doesn't suppress the
 *     PagerDuty trigger and vice versa, and per-channel `error` /
 *     `ok` fields reflect what actually happened.
 *   - "Neither configured" returns a result with `attempted: false`
 *     for both channels and no senders are invoked (the dashboard uses
 *     this to render a "no chat channels configured" message).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendWatchPositionTrendOpsAlertEmail: vi.fn(async () => undefined),
}));

vi.mock("../lib/opsAlertChat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/opsAlertChat.js")>();
  return {
    ...actual,
    postWatchPositionTrendOpsAlertSlack: vi.fn(async () => undefined),
    triggerWatchPositionTrendOpsAlertPagerDuty: vi.fn(async () => undefined),
  };
});

import {
  sendWatchGpsOpsAlertTestPage,
  getWatchGpsOpsAlertChatTargetsStatus,
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
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  slackMock.mockReset();
  slackMock.mockResolvedValue(undefined);
  pdMock.mockReset();
  pdMock.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

describe("getWatchGpsOpsAlertChatTargetsStatus", () => {
  it("reports both channels unconfigured when neither env var is set", () => {
    expect(getWatchGpsOpsAlertChatTargetsStatus()).toEqual({
      slackConfigured: false,
      pagerDutyConfigured: false,
    });
  });

  it("only flips the Slack flag when only OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK is set", () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/AAA/BBB/CCC";
    expect(getWatchGpsOpsAlertChatTargetsStatus()).toEqual({
      slackConfigured: true,
      pagerDutyConfigured: false,
    });
  });

  it("only flips the PagerDuty flag when only the routing key is set", () => {
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "R0UT1NGK3Y";
    expect(getWatchGpsOpsAlertChatTargetsStatus()).toEqual({
      slackConfigured: false,
      pagerDutyConfigured: true,
    });
  });

  it("treats whitespace-only env values as unset (matches the dispatch path)", () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "   ";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "\t\n";
    expect(getWatchGpsOpsAlertChatTargetsStatus()).toEqual({
      slackConfigured: false,
      pagerDutyConfigured: false,
    });
  });
});

describe("sendWatchGpsOpsAlertTestPage", () => {
  it("returns attempted:false for both channels when neither env var is set, and invokes no senders", async () => {
    const result = await sendWatchGpsOpsAlertTestPage();
    expect(slackMock).not.toHaveBeenCalled();
    expect(pdMock).not.toHaveBeenCalled();
    expect(result.targets).toEqual({ slackConfigured: false, pagerDutyConfigured: false });
    expect(result.slack).toEqual({ configured: false, attempted: false, ok: false, error: null });
    expect(result.pagerDuty).toEqual({ configured: false, attempted: false, ok: false, error: null });
  });

  it("posts to Slack with testMode=true when only the Slack webhook is configured", async () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/AAA/BBB/CCC";

    const result = await sendWatchGpsOpsAlertTestPage();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).not.toHaveBeenCalled();
    const arg = slackMock.mock.calls[0][0];
    expect(arg.webhookUrl).toBe("https://hooks.slack.com/services/AAA/BBB/CCC");
    expect(arg.testMode).toBe(true);
    // Real-spike numeric fields are still passed (the senders ignore them in
    // testMode, but a buggy renderer that reads them shouldn't see a fake spike).
    expect(arg.recentAvg).toBe(0);
    expect(arg.baselineAvg).toBe(0);

    expect(result.slack).toEqual({ configured: true, attempted: true, ok: true, error: null });
    expect(result.pagerDuty).toEqual({ configured: false, attempted: false, ok: false, error: null });
  });

  it("triggers PagerDuty with testMode=true when only the routing key is configured", async () => {
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "R0UT1NGK3Y";

    const result = await sendWatchGpsOpsAlertTestPage();

    expect(pdMock).toHaveBeenCalledTimes(1);
    expect(slackMock).not.toHaveBeenCalled();
    const arg = pdMock.mock.calls[0][0];
    expect(arg.routingKey).toBe("R0UT1NGK3Y");
    expect(arg.testMode).toBe(true);

    expect(result.pagerDuty).toEqual({ configured: true, attempted: true, ok: true, error: null });
    expect(result.slack).toEqual({ configured: false, attempted: false, ok: false, error: null });
  });

  it("dispatches to both channels when both env vars are configured", async () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/AAA/BBB/CCC";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "R0UT1NGK3Y";

    const result = await sendWatchGpsOpsAlertTestPage();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
    expect(result.slack.ok).toBe(true);
    expect(result.pagerDuty.ok).toBe(true);
  });

  it("a Slack failure does not suppress the PagerDuty trigger and surfaces the error per channel", async () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/AAA/BBB/CCC";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "R0UT1NGK3Y";
    slackMock.mockRejectedValueOnce(new Error("Slack webhook returned 404"));

    const result = await sendWatchGpsOpsAlertTestPage();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
    expect(result.slack).toEqual({
      configured: true,
      attempted: true,
      ok: false,
      error: "Slack webhook returned 404",
    });
    expect(result.pagerDuty).toEqual({
      configured: true,
      attempted: true,
      ok: true,
      error: null,
    });
  });

  it("a PagerDuty failure does not suppress the Slack post and surfaces the error per channel", async () => {
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/AAA/BBB/CCC";
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = "R0UT1NGK3Y";
    pdMock.mockRejectedValueOnce(new Error("PagerDuty Events API returned 401"));

    const result = await sendWatchGpsOpsAlertTestPage();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
    expect(result.slack).toEqual({
      configured: true,
      attempted: true,
      ok: true,
      error: null,
    });
    expect(result.pagerDuty).toEqual({
      configured: true,
      attempted: true,
      ok: false,
      error: "PagerDuty Events API returned 401",
    });
  });
});
