/**
 * Tests for the manual-entry alert health ops alert's
 * Slack / PagerDuty chat dispatch (Task #2054). Mirrors the structure
 * of `notify-retry-exhaustion-ops-alert-chat.test.ts`:
 *
 *   - Target resolution: dedicated env vars
 *     `OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK` /
 *     `OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY` win, with a
 *     fallback to the shared
 *     `OPS_ALERT_SLACK_WEBHOOK` / `OPS_ALERT_PAGERDUTY_ROUTING_KEY`
 *     pair so most deploys only need to set one pair.
 *   - Dispatch: Slack only / PD only / both / neither matrix, plus
 *     per-channel failure independence (Slack outage doesn't suppress
 *     PD trigger and vice versa).
 *   - Payload shape: real-alert headline, dashboard URL, hour-scoped
 *     PD `dedup_key`, breach kinds and 7d window stats relayed.
 *
 * Drives the exported `_dispatchManualEntryAlertHealthChatForTests`
 * helper rather than spinning the full job through the DB — the chat
 * branch is independent of the email recipient list / dedup state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../lib/opsAlertChat.js", async () => {
  // Pull through the real `resolveOpsAlertChatTargets` so the
  // env-resolution tests below exercise the same code path the
  // dispatcher uses in production. Only the network-touching senders
  // are mocked.
  const actual = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
    "../lib/opsAlertChat.js",
  );
  return {
    ...actual,
    postManualEntryAlertHealthOpsAlertSlack: vi.fn(async () => undefined),
    triggerManualEntryAlertHealthOpsAlertPagerDuty: vi.fn(async () => undefined),
  };
});

import {
  postManualEntryAlertHealthOpsAlertSlack,
  triggerManualEntryAlertHealthOpsAlertPagerDuty,
} from "../lib/opsAlertChat.js";
import {
  _dispatchManualEntryAlertHealthChatForTests,
  _resolveManualEntryAlertHealthChatTargetsForTests,
} from "../lib/manualEntryAlertHealthOpsAlert.js";

const slackMock = vi.mocked(postManualEntryAlertHealthOpsAlertSlack);
const pdMock = vi.mocked(triggerManualEntryAlertHealthOpsAlertPagerDuty);

const ENV_KEYS = [
  "OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK",
  "OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY",
  "OPS_ALERT_SLACK_WEBHOOK",
  "OPS_ALERT_PAGERDUTY_ROUTING_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  slackMock.mockReset();
  pdMock.mockReset();
  slackMock.mockResolvedValue(undefined);
  pdMock.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const FIXED_NOW = new Date("2026-04-29T12:34:56.000Z");

const SAMPLE_BREACHES = [
  {
    kind: "delivery_rate" as const,
    detail:
      "7d any-delivery rate 42% < threshold 80% (alertCount=12, minSample=3)",
  },
  {
    kind: "consecutive_zero" as const,
    detail: "Last 5 consecutive alerts had zero deliveries on any channel",
  },
];

const SAMPLE_SUMMARY_7D = {
  alertCount: 12,
  anyDeliveryRate: 42,
  pushDeliveryRate: 30,
  emailDeliveryRate: 20,
  zeroDeliveryCount: 7,
};

const DASHBOARD_URL = "https://kharagolf.com/super-admin/manual-entry-alerts";

async function dispatch(): Promise<void> {
  _dispatchManualEntryAlertHealthChatForTests({
    breaches: SAMPLE_BREACHES,
    summary7d: SAMPLE_SUMMARY_7D,
    thresholdPct: 80,
    minSample: 3,
    consecutiveZero: 5,
    cooldownHours: 6,
    dashboardUrl: DASHBOARD_URL,
    now: FIXED_NOW,
  });
  // Fire-and-forget: dispatcher uses `void send...().catch(...)`, so
  // let the queued microtasks drain before asserting.
  await new Promise((r) => setTimeout(r, 0));
}

describe("manual-entry alert health → chat target resolution", () => {
  it("returns both nulls when no env var is set", () => {
    expect(_resolveManualEntryAlertHealthChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: null,
    });
  });

  it("picks up the dedicated Slack webhook when set", () => {
    process.env.OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/MEA/HOOK";
    expect(_resolveManualEntryAlertHealthChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/MEA/HOOK",
      pagerDutyRoutingKey: null,
    });
  });

  it("picks up the dedicated PagerDuty routing key when set", () => {
    process.env.OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY = "MEAPDKEY";
    expect(_resolveManualEntryAlertHealthChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: "MEAPDKEY",
    });
  });

  it("falls back to OPS_ALERT_SLACK_WEBHOOK when the dedicated Slack var is unset", () => {
    process.env.OPS_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/SHARED/HOOK";
    expect(_resolveManualEntryAlertHealthChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/SHARED/HOOK",
      pagerDutyRoutingKey: null,
    });
  });

  it("falls back to OPS_ALERT_PAGERDUTY_ROUTING_KEY when the dedicated PD var is unset", () => {
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "SHAREDPDKEY";
    expect(_resolveManualEntryAlertHealthChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: "SHAREDPDKEY",
    });
  });

  it("dedicated env vars win over the shared fallback when both are set", () => {
    process.env.OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/DEDICATED";
    process.env.OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY = "DEDICATEDPDKEY";
    process.env.OPS_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/SHARED";
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "SHAREDPDKEY";
    expect(_resolveManualEntryAlertHealthChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/DEDICATED",
      pagerDutyRoutingKey: "DEDICATEDPDKEY",
    });
  });

  it("treats whitespace-only values as unset (and falls through to the shared fallback)", () => {
    process.env.OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK = "   ";
    process.env.OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY = "\n";
    process.env.OPS_ALERT_SLACK_WEBHOOK =
      "  https://hooks.slack.com/services/SHARED  ";
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "  SHAREDPDKEY\t";
    expect(_resolveManualEntryAlertHealthChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/SHARED",
      pagerDutyRoutingKey: "SHAREDPDKEY",
    });
  });
});

describe("manual-entry alert health → chat dispatch", () => {
  it("does not dispatch on either channel when no chat target is configured (warn-only)", async () => {
    await dispatch();
    expect(slackMock).not.toHaveBeenCalled();
    expect(pdMock).not.toHaveBeenCalled();
  });

  it("posts to Slack only when only the Slack webhook is configured", async () => {
    process.env.OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/MEA/HOOK";

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).not.toHaveBeenCalled();
    const arg = slackMock.mock.calls[0][0];
    expect(arg.webhookUrl).toBe("https://hooks.slack.com/services/MEA/HOOK");
    expect(arg.breaches).toEqual(SAMPLE_BREACHES);
    expect(arg.summary7d).toEqual(SAMPLE_SUMMARY_7D);
    expect(arg.thresholdPct).toBe(80);
    expect(arg.minSample).toBe(3);
    expect(arg.consecutiveZero).toBe(5);
    expect(arg.cooldownHours).toBe(6);
    expect(arg.dashboardUrl).toBe(DASHBOARD_URL);
    expect(arg.now).toBe(FIXED_NOW);
  });

  it("triggers PagerDuty only when only the routing key is configured", async () => {
    process.env.OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY = "MEAPDKEY";

    await dispatch();

    expect(pdMock).toHaveBeenCalledTimes(1);
    expect(slackMock).not.toHaveBeenCalled();
    const arg = pdMock.mock.calls[0][0];
    expect(arg.routingKey).toBe("MEAPDKEY");
    expect(arg.breaches).toEqual(SAMPLE_BREACHES);
    expect(arg.summary7d).toEqual(SAMPLE_SUMMARY_7D);
  });

  it("dispatches to both channels when both env vars are configured", async () => {
    process.env.OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/MEA/HOOK";
    process.env.OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY = "MEAPDKEY";

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });

  it("uses the shared OPS_ALERT_* fallback when no dedicated var is set", async () => {
    process.env.OPS_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/SHARED";
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "SHAREDPDKEY";

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
    expect(slackMock.mock.calls[0][0].webhookUrl).toBe(
      "https://hooks.slack.com/services/SHARED",
    );
    expect(pdMock.mock.calls[0][0].routingKey).toBe("SHAREDPDKEY");
  });

  it("a Slack failure does not suppress the PagerDuty trigger", async () => {
    process.env.OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/MEA/HOOK";
    process.env.OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY = "MEAPDKEY";
    slackMock.mockRejectedValueOnce(new Error("slack down"));

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });

  it("a PagerDuty failure does not suppress the Slack post", async () => {
    process.env.OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/MEA/HOOK";
    process.env.OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY = "MEAPDKEY";
    pdMock.mockRejectedValueOnce(new Error("pd down"));

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });
});

// ── Sender-level shape assertions ────────────────────────────────────────
//
// The Slack / PagerDuty wrappers are pure functions that translate
// the dispatcher's domain inputs into channel-specific payloads — the
// tests above mock them out, so verify their shape directly here.

describe("manual-entry alert health → Slack / PagerDuty payload shape", () => {
  it("Slack: headline starts with :warning:, lists every breach, names the dashboard", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("ok", { status: 200 }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.postManualEntryAlertHealthOpsAlertSlack({
        webhookUrl: "https://hooks.slack.com/services/SHAPE/CHECK",
        breaches: SAMPLE_BREACHES,
        summary7d: SAMPLE_SUMMARY_7D,
        thresholdPct: 80,
        minSample: 3,
        consecutiveZero: 5,
        cooldownHours: 6,
        dashboardUrl: DASHBOARD_URL,
        now: FIXED_NOW,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/services/SHAPE/CHECK");
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain(":warning:");
    expect(body.text).toContain("Manual-entry alerts not reaching anyone");
    expect(body.text).toContain("delivery_rate");
    expect(body.text).toContain("consecutive_zero");
    expect(body.blocks[0].type).toBe("header");
    expect(body.blocks[0].text.text).toBe("Manual-entry alert health breach");
    const sectionText = body.blocks[1].text.text as string;
    expect(sectionText).toContain("*7d any-delivery rate:* 42% (threshold 80%)");
    expect(sectionText).toContain(
      "*7d push / email delivery rate:* 30% / 20%",
    );
    expect(sectionText).toContain(
      "*7d alerts (zero-delivery / total):* 7 / 12",
    );
    expect(sectionText).toContain(
      "*Min sample / consecutive-zero trigger:* 3 / 5",
    );
    expect(sectionText).toContain(`*Dashboard:* ${DASHBOARD_URL}`);
    expect(sectionText).toContain("*Breaches:*");
    expect(sectionText).toContain(SAMPLE_BREACHES[0].detail);
    expect(sectionText).toContain(SAMPLE_BREACHES[1].detail);
    expect(sectionText).toContain("Repeat alerts suppressed for 6h");
  });

  it("PagerDuty: dedup_key is hour-scoped so a sustained outage folds into one PD incident", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("ok", { status: 202 }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.triggerManualEntryAlertHealthOpsAlertPagerDuty({
        routingKey: "SHAPECHECK",
        breaches: SAMPLE_BREACHES,
        summary7d: SAMPLE_SUMMARY_7D,
        thresholdPct: 80,
        minSample: 3,
        consecutiveZero: 5,
        cooldownHours: 6,
        dashboardUrl: DASHBOARD_URL,
        now: FIXED_NOW,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.routing_key).toBe("SHAPECHECK");
    expect(body.event_action).toBe("trigger");
    // Hour-scoped — first 13 chars of ISO timestamp = "2026-04-29T12".
    expect(body.dedup_key).toBe("manual-entry-alert-health-2026-04-29T12");
    expect(body.payload.severity).toBe("warning");
    expect(body.payload.source).toBe("api-server/manualEntryAlertHealthOpsAlert");
    expect(body.payload.group).toBe("ops-alerts");
    expect(body.payload.class).toBe("delivery-health");
    expect(body.payload.component).toBe("manual-entry-alerts");
    expect(body.payload.summary).toContain("Manual-entry alerts not reaching anyone");
    expect(body.payload.summary).toContain("42%");
    const cd = body.payload.custom_details;
    expect(cd.breach_kinds).toBe("delivery_rate,consecutive_zero");
    expect(cd.breach_details).toContain(SAMPLE_BREACHES[0].detail);
    expect(cd.breach_details).toContain(SAMPLE_BREACHES[1].detail);
    expect(cd.window).toBe("7d");
    expect(cd.alert_count_7d).toBe(12);
    expect(cd.any_delivery_rate_7d).toBe(42);
    expect(cd.push_delivery_rate_7d).toBe(30);
    expect(cd.email_delivery_rate_7d).toBe(20);
    expect(cd.zero_delivery_count_7d).toBe(7);
    expect(cd.threshold_pct).toBe(80);
    expect(cd.min_sample).toBe(3);
    expect(cd.consecutive_zero).toBe(5);
    expect(cd.cooldown_hours).toBe(6);
    expect(cd.dashboard_url).toBe(DASHBOARD_URL);
  });
});
