/**
 * Tests for the notification-retry exhaustion ops alert's
 * Slack / PagerDuty chat dispatch (Task #1652). Mirrors the structure
 * of `watch-position-trend-ops-alert-chat.test.ts`:
 *
 *   - Target resolution: dedicated env vars
 *     `OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK` /
 *     `OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY` win, with a
 *     fallback to the shared
 *     `OPS_ALERT_SLACK_WEBHOOK` / `OPS_ALERT_PAGERDUTY_ROUTING_KEY`
 *     pair so most deploys only need to set one pair.
 *   - Dispatch: Slack only / PD only / both / neither matrix, plus
 *     per-channel failure independence (Slack outage doesn't suppress
 *     PD trigger and vice versa).
 *   - Test mode (`isTest: true`): clearly-labelled headline, salted PD
 *     dedup_key so a test page never collapses onto a real incident.
 *
 * Drives the exported `_dispatchNotifyRetryExhaustionChatForTests`
 * helper rather than spinning the full job through the DB — the chat
 * branch is independent of the email recipient list / dedup state, so
 * the unit-level helper is sufficient.
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
    postNotifyRetryExhaustionOpsAlertSlack: vi.fn(async () => undefined),
    triggerNotifyRetryExhaustionOpsAlertPagerDuty: vi.fn(async () => undefined),
  };
});

import {
  postNotifyRetryExhaustionOpsAlertSlack,
  triggerNotifyRetryExhaustionOpsAlertPagerDuty,
} from "../lib/opsAlertChat.js";
import {
  _dispatchNotifyRetryExhaustionChatForTests,
  _resolveNotifyRetryExhaustionChatTargetsForTests,
} from "../lib/notifyExhaustionOpsAlert.js";

const slackMock = vi.mocked(postNotifyRetryExhaustionOpsAlertSlack);
const pdMock = vi.mocked(triggerNotifyRetryExhaustionOpsAlertPagerDuty);

const ENV_KEYS = [
  "OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK",
  "OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY",
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
const FIXED_SINCE = new Date("2026-04-28T12:34:56.000Z");

const SAMPLE_SUMMARY = {
  windowHours: 24,
  threshold: 5,
  coachPayout: { push: 2, sms: 1, rows: 3 },
  levyReceipt: { push: 4, sms: 0, rows: 4 },
  totalRows: 7,
};

async function dispatch(opts: { isTest?: boolean } = {}): Promise<void> {
  _dispatchNotifyRetryExhaustionChatForTests({
    summary: SAMPLE_SUMMARY,
    since: FIXED_SINCE,
    now: FIXED_NOW,
    isTest: opts.isTest,
  });
  // Fire-and-forget: dispatcher uses `void send...().catch(...)`, so
  // let the queued microtasks drain before asserting.
  await new Promise((r) => setTimeout(r, 0));
}

describe("notify-retry exhaustion → chat target resolution", () => {
  it("returns both nulls when no env var is set", () => {
    expect(_resolveNotifyRetryExhaustionChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: null,
    });
  });

  it("picks up the dedicated Slack webhook when set", () => {
    process.env.OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/NRA/HOOK";
    expect(_resolveNotifyRetryExhaustionChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/NRA/HOOK",
      pagerDutyRoutingKey: null,
    });
  });

  it("picks up the dedicated PagerDuty routing key when set", () => {
    process.env.OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY = "NRAPDKEY";
    expect(_resolveNotifyRetryExhaustionChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: "NRAPDKEY",
    });
  });

  it("falls back to OPS_ALERT_SLACK_WEBHOOK when the dedicated Slack var is unset", () => {
    process.env.OPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/SHARED/HOOK";
    expect(_resolveNotifyRetryExhaustionChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/SHARED/HOOK",
      pagerDutyRoutingKey: null,
    });
  });

  it("falls back to OPS_ALERT_PAGERDUTY_ROUTING_KEY when the dedicated PD var is unset", () => {
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "SHAREDPDKEY";
    expect(_resolveNotifyRetryExhaustionChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: "SHAREDPDKEY",
    });
  });

  it("dedicated env vars win over the shared fallback when both are set", () => {
    process.env.OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/DEDICATED";
    process.env.OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY = "DEDICATEDPDKEY";
    process.env.OPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/SHARED";
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "SHAREDPDKEY";
    expect(_resolveNotifyRetryExhaustionChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/DEDICATED",
      pagerDutyRoutingKey: "DEDICATEDPDKEY",
    });
  });

  it("treats whitespace-only values as unset (and falls through to the shared fallback)", () => {
    process.env.OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK = "   ";
    process.env.OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY = "\n";
    process.env.OPS_ALERT_SLACK_WEBHOOK = "  https://hooks.slack.com/services/SHARED  ";
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "  SHAREDPDKEY\t";
    expect(_resolveNotifyRetryExhaustionChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/SHARED",
      pagerDutyRoutingKey: "SHAREDPDKEY",
    });
  });
});

describe("notify-retry exhaustion → chat dispatch", () => {
  it("does not dispatch on either channel when no chat target is configured (warn-only)", async () => {
    await dispatch();
    expect(slackMock).not.toHaveBeenCalled();
    expect(pdMock).not.toHaveBeenCalled();
  });

  it("posts to Slack only when only the Slack webhook is configured", async () => {
    process.env.OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/NRA/HOOK";

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).not.toHaveBeenCalled();
    const arg = slackMock.mock.calls[0][0];
    expect(arg.webhookUrl).toBe("https://hooks.slack.com/services/NRA/HOOK");
    expect(arg.summary).toEqual(SAMPLE_SUMMARY);
    expect(arg.since).toBe(FIXED_SINCE);
    expect(arg.now).toBe(FIXED_NOW);
    expect(arg.isTest).toBeUndefined();
  });

  it("triggers PagerDuty only when only the routing key is configured", async () => {
    process.env.OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY = "NRAPDKEY";

    await dispatch();

    expect(pdMock).toHaveBeenCalledTimes(1);
    expect(slackMock).not.toHaveBeenCalled();
    const arg = pdMock.mock.calls[0][0];
    expect(arg.routingKey).toBe("NRAPDKEY");
    expect(arg.summary).toEqual(SAMPLE_SUMMARY);
  });

  it("dispatches to both channels when both env vars are configured", async () => {
    process.env.OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/NRA/HOOK";
    process.env.OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY = "NRAPDKEY";

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });

  it("uses the shared OPS_ALERT_* fallback when no dedicated var is set", async () => {
    process.env.OPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/SHARED";
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "SHAREDPDKEY";

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
    expect(slackMock.mock.calls[0][0].webhookUrl).toBe("https://hooks.slack.com/services/SHARED");
    expect(pdMock.mock.calls[0][0].routingKey).toBe("SHAREDPDKEY");
  });

  it("a Slack failure does not suppress the PagerDuty trigger", async () => {
    process.env.OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/NRA/HOOK";
    process.env.OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY = "NRAPDKEY";
    slackMock.mockRejectedValueOnce(new Error("slack down"));

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });

  it("a PagerDuty failure does not suppress the Slack post", async () => {
    process.env.OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/NRA/HOOK";
    process.env.OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY = "NRAPDKEY";
    pdMock.mockRejectedValueOnce(new Error("pd down"));

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });

  it("propagates `isTest: true` to both channel senders so they can shape the test page", async () => {
    process.env.OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK = "https://hooks.slack.com/services/NRA/HOOK";
    process.env.OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY = "NRAPDKEY";

    await dispatch({ isTest: true });

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
    expect(slackMock.mock.calls[0][0].isTest).toBe(true);
    expect(pdMock.mock.calls[0][0].isTest).toBe(true);
  });
});

// ── Sender-level shape assertions ────────────────────────────────────────
//
// The Slack / PagerDuty wrappers are pure functions that translate
// the dispatcher's domain inputs into channel-specific payloads — the
// tests above mock them out, so verify their shape directly here.

describe("notify-retry exhaustion → Slack / PagerDuty payload shape", () => {
  it("Slack: real-alert headline starts with :warning: and embeds the totals", async () => {
    // Re-import the real wrappers (the suite's top-level mock only
    // replaces the dispatcher-facing senders; the message-building
    // logic still lives in the real module).
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok", { status: 200 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.postNotifyRetryExhaustionOpsAlertSlack({
        webhookUrl: "https://hooks.slack.com/services/SHAPE/CHECK",
        summary: SAMPLE_SUMMARY,
        since: FIXED_SINCE,
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
    expect(body.text).toContain("Notification retries exhausted");
    expect(body.text).toContain("7"); // totalRows
    expect(body.text).toContain("24h"); // windowHours
    // Block Kit: header (plain text, no emoji shortcode) + section.
    expect(body.blocks[0].type).toBe("header");
    expect(body.blocks[0].text.text).toBe("Notification retries exhausted");
    expect(body.blocks[1].type).toBe("section");
    const sectionText = body.blocks[1].text.text as string;
    expect(sectionText).toContain("*When:*");
    expect(sectionText).toContain("*Total exhausted rows:* 7");
    expect(sectionText).toContain("*Coach payout (push / SMS / rows):* 2 / 1 / 3");
    expect(sectionText).toContain("*Levy receipt (push / SMS / rows):* 4 / 0 / 4");
    expect(sectionText).toContain("One alert per UTC day per replica");
  });

  it("Slack: TEST-alert headline carries [TEST] and notes the synthetic counts", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok", { status: 200 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.postNotifyRetryExhaustionOpsAlertSlack({
        webhookUrl: "https://hooks.slack.com/services/SHAPE/CHECK",
        summary: SAMPLE_SUMMARY,
        since: FIXED_SINCE,
        now: FIXED_NOW,
        isTest: true,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.text).toContain("[TEST]");
    expect(body.text).toContain("synthetic");
    expect(body.blocks[0].text.text).toBe("Notification retry exhaustion — test alert");
    const sectionText = body.blocks[1].text.text as string;
    expect(sectionText).toContain("Test pages do not consume the daily dedup");
  });

  it("PagerDuty: real-alert dedup_key is scoped to the UTC date", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok", { status: 202 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.triggerNotifyRetryExhaustionOpsAlertPagerDuty({
        routingKey: "SHAPECHECK",
        summary: SAMPLE_SUMMARY,
        since: FIXED_SINCE,
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
    expect(body.dedup_key).toBe("notify-retry-exhaustion-2026-04-29");
    expect(body.payload.severity).toBe("warning");
    expect(body.payload.source).toBe("api-server/notifyExhaustionOpsAlert");
    expect(body.payload.group).toBe("ops-alerts");
    expect(body.payload.class).toBe("retry-exhaustion");
    expect(body.payload.custom_details.is_test).toBe(false);
    expect(body.payload.custom_details.total_rows).toBe(7);
    expect(body.payload.custom_details.window_hours).toBe(24);
    expect(body.payload.custom_details.threshold).toBe(5);
  });

  it("PagerDuty: TEST-alert dedup_key is salted (full timestamp) so it never collapses onto a real incident", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok", { status: 202 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.triggerNotifyRetryExhaustionOpsAlertPagerDuty({
        routingKey: "SHAPECHECK",
        summary: SAMPLE_SUMMARY,
        since: FIXED_SINCE,
        now: FIXED_NOW,
        isTest: true,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    // Includes the full ISO timestamp so concurrent test pages don't
    // collapse, and never matches the date-scoped real-alert key.
    expect(body.dedup_key).toBe("notify-retry-exhaustion-test-2026-04-29T12:34:56.000Z");
    expect(body.dedup_key).not.toBe("notify-retry-exhaustion-2026-04-29");
    expect(body.payload.severity).toBe("info");
    expect(body.payload.summary).toContain("[TEST]");
    expect(body.payload.custom_details.is_test).toBe(true);
  });
});
