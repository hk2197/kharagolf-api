/**
 * Tests for the badge-share rollup stale ops alert's
 * Slack / PagerDuty chat dispatch (Task #2054). Mirrors the structure
 * of `notify-retry-exhaustion-ops-alert-chat.test.ts`:
 *
 *   - Target resolution: dedicated env vars
 *     `OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK` /
 *     `OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY` win, with a
 *     fallback to the shared
 *     `OPS_ALERT_SLACK_WEBHOOK` / `OPS_ALERT_PAGERDUTY_ROUTING_KEY`
 *     pair so most deploys only need to set one pair.
 *   - Dispatch: Slack only / PD only / both / neither matrix, plus
 *     per-channel failure independence (Slack outage doesn't suppress
 *     PD trigger and vice versa).
 *   - Payload shape: rollup age + raw-event count in headline,
 *     dashboard URL, hour-scoped PD `dedup_key`, last-run details
 *     relayed.
 *
 * Drives the exported `_dispatchBadgeShareRollupStaleChatForTests`
 * helper rather than spinning the full job through the DB — the chat
 * branch is independent of the email recipient list / persisted
 * cooldown.
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
    postBadgeShareRollupStaleOpsAlertSlack: vi.fn(async () => undefined),
    triggerBadgeShareRollupStaleOpsAlertPagerDuty: vi.fn(async () => undefined),
  };
});

import {
  postBadgeShareRollupStaleOpsAlertSlack,
  triggerBadgeShareRollupStaleOpsAlertPagerDuty,
} from "../lib/opsAlertChat.js";
import {
  _dispatchBadgeShareRollupStaleChatForTests,
  _resolveBadgeShareRollupStaleChatTargetsForTests,
} from "../lib/badgeShareRollupOpsAlert.js";

const slackMock = vi.mocked(postBadgeShareRollupStaleOpsAlertSlack);
const pdMock = vi.mocked(triggerBadgeShareRollupStaleOpsAlertPagerDuty);

const ENV_KEYS = [
  "OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK",
  "OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY",
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

const SAMPLE_SUMMARY = {
  currentRawEventCount: 12345,
  currentAggregateRowCount: 678,
  // 38h — past the 36h stale threshold.
  rollupAgeMs: 38 * 60 * 60 * 1000,
  staleThresholdMs: 36 * 60 * 60 * 1000,
  lastRun: {
    ranAt: "2026-04-27T22:34:56.000Z",
    rolledUpEvents: 9999,
  },
};

const DASHBOARD_URL = "https://kharagolf.com/super-admin/badge-share-rollup";

async function dispatch(
  overrides: { lastRun?: typeof SAMPLE_SUMMARY.lastRun | null } = {},
): Promise<void> {
  _dispatchBadgeShareRollupStaleChatForTests({
    summary: {
      ...SAMPLE_SUMMARY,
      lastRun: overrides.lastRun !== undefined ? overrides.lastRun : SAMPLE_SUMMARY.lastRun,
    },
    cooldownHours: 6,
    dashboardUrl: DASHBOARD_URL,
    now: FIXED_NOW,
  });
  // Fire-and-forget: dispatcher uses `void send...().catch(...)`, so
  // let the queued microtasks drain before asserting.
  await new Promise((r) => setTimeout(r, 0));
}

describe("badge-share rollup stale → chat target resolution", () => {
  it("returns both nulls when no env var is set", () => {
    expect(_resolveBadgeShareRollupStaleChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: null,
    });
  });

  it("picks up the dedicated Slack webhook when set", () => {
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/BSR/HOOK";
    expect(_resolveBadgeShareRollupStaleChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/BSR/HOOK",
      pagerDutyRoutingKey: null,
    });
  });

  it("picks up the dedicated PagerDuty routing key when set", () => {
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY = "BSRPDKEY";
    expect(_resolveBadgeShareRollupStaleChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: "BSRPDKEY",
    });
  });

  it("falls back to OPS_ALERT_SLACK_WEBHOOK when the dedicated Slack var is unset", () => {
    process.env.OPS_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/SHARED/HOOK";
    expect(_resolveBadgeShareRollupStaleChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/SHARED/HOOK",
      pagerDutyRoutingKey: null,
    });
  });

  it("falls back to OPS_ALERT_PAGERDUTY_ROUTING_KEY when the dedicated PD var is unset", () => {
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "SHAREDPDKEY";
    expect(_resolveBadgeShareRollupStaleChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: "SHAREDPDKEY",
    });
  });

  it("dedicated env vars win over the shared fallback when both are set", () => {
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/DEDICATED";
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY =
      "DEDICATEDPDKEY";
    process.env.OPS_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/SHARED";
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "SHAREDPDKEY";
    expect(_resolveBadgeShareRollupStaleChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/DEDICATED",
      pagerDutyRoutingKey: "DEDICATEDPDKEY",
    });
  });

  it("treats whitespace-only values as unset (and falls through to the shared fallback)", () => {
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK = "   ";
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY = "\n";
    process.env.OPS_ALERT_SLACK_WEBHOOK =
      "  https://hooks.slack.com/services/SHARED  ";
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "  SHAREDPDKEY\t";
    expect(_resolveBadgeShareRollupStaleChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/SHARED",
      pagerDutyRoutingKey: "SHAREDPDKEY",
    });
  });
});

describe("badge-share rollup stale → chat dispatch", () => {
  it("does not dispatch on either channel when no chat target is configured (warn-only)", async () => {
    await dispatch();
    expect(slackMock).not.toHaveBeenCalled();
    expect(pdMock).not.toHaveBeenCalled();
  });

  it("posts to Slack only when only the Slack webhook is configured", async () => {
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/BSR/HOOK";

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).not.toHaveBeenCalled();
    const arg = slackMock.mock.calls[0][0];
    expect(arg.webhookUrl).toBe("https://hooks.slack.com/services/BSR/HOOK");
    expect(arg.summary).toEqual(SAMPLE_SUMMARY);
    expect(arg.cooldownHours).toBe(6);
    expect(arg.dashboardUrl).toBe(DASHBOARD_URL);
    expect(arg.now).toBe(FIXED_NOW);
  });

  it("triggers PagerDuty only when only the routing key is configured", async () => {
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY = "BSRPDKEY";

    await dispatch();

    expect(pdMock).toHaveBeenCalledTimes(1);
    expect(slackMock).not.toHaveBeenCalled();
    const arg = pdMock.mock.calls[0][0];
    expect(arg.routingKey).toBe("BSRPDKEY");
    expect(arg.summary).toEqual(SAMPLE_SUMMARY);
  });

  it("dispatches to both channels when both env vars are configured", async () => {
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/BSR/HOOK";
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY = "BSRPDKEY";

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
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/BSR/HOOK";
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY = "BSRPDKEY";
    slackMock.mockRejectedValueOnce(new Error("slack down"));

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });

  it("a PagerDuty failure does not suppress the Slack post", async () => {
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/BSR/HOOK";
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY = "BSRPDKEY";
    pdMock.mockRejectedValueOnce(new Error("pd down"));

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });

  it("relays a null lastRun (fresh deploy) without crashing", async () => {
    process.env.OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/BSR/HOOK";

    await dispatch({ lastRun: null });

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(slackMock.mock.calls[0][0].summary.lastRun).toBeNull();
  });
});

// ── Sender-level shape assertions ────────────────────────────────────────
//
// The Slack / PagerDuty wrappers are pure functions that translate
// the dispatcher's domain inputs into channel-specific payloads — the
// tests above mock them out, so verify their shape directly here.

describe("badge-share rollup stale → Slack / PagerDuty payload shape", () => {
  it("Slack: headline carries :warning:, age, raw-event count, dashboard URL", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("ok", { status: 200 }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.postBadgeShareRollupStaleOpsAlertSlack({
        webhookUrl: "https://hooks.slack.com/services/SHAPE/CHECK",
        summary: SAMPLE_SUMMARY,
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
    expect(body.text).toContain("Badge-share rollup is stale");
    expect(body.text).toContain("38h ago");
    expect(body.text).toContain("12345 raw events waiting");
    expect(body.blocks[0].type).toBe("header");
    expect(body.blocks[0].text.text).toBe("Badge-share rollup is stale");
    const sectionText = body.blocks[1].text.text as string;
    expect(sectionText).toContain("*Rollup age:* 38h (stale threshold 36h)");
    expect(sectionText).toContain("*Raw events waiting:* 12345");
    expect(sectionText).toContain("*Aggregate rows:* 678");
    expect(sectionText).toContain(
      "*Last successful run:* 2026-04-27T22:34:56.000Z (rolled up 9999 events)",
    );
    expect(sectionText).toContain(`*Dashboard:* ${DASHBOARD_URL}`);
    expect(sectionText).toContain(
      "Repeat alerts suppressed for 6h via the persisted singleton cooldown.",
    );
  });

  it("Slack: lastRun=null renders 'never' rather than crashing", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("ok", { status: 200 }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.postBadgeShareRollupStaleOpsAlertSlack({
        webhookUrl: "https://hooks.slack.com/services/SHAPE/CHECK",
        summary: { ...SAMPLE_SUMMARY, lastRun: null },
        cooldownHours: 6,
        dashboardUrl: DASHBOARD_URL,
        now: FIXED_NOW,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    const sectionText = body.blocks[1].text.text as string;
    expect(sectionText).toContain("*Last successful run:* never");
  });

  it("PagerDuty: dedup_key is hour-scoped so a sustained stall folds into one PD incident", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("ok", { status: 202 }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.triggerBadgeShareRollupStaleOpsAlertPagerDuty({
        routingKey: "SHAPECHECK",
        summary: SAMPLE_SUMMARY,
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
    expect(body.dedup_key).toBe("badge-share-rollup-stale-2026-04-29T12");
    expect(body.payload.severity).toBe("warning");
    expect(body.payload.source).toBe("api-server/badgeShareRollupOpsAlert");
    expect(body.payload.group).toBe("ops-alerts");
    expect(body.payload.class).toBe("rollup-stale");
    expect(body.payload.component).toBe("badge-share-rollup");
    expect(body.payload.summary).toContain("Badge-share rollup is stale");
    expect(body.payload.summary).toContain("38h ago");
    expect(body.payload.summary).toContain("12345 raw events waiting");
    const cd = body.payload.custom_details;
    expect(cd.rollup_age_ms).toBe(SAMPLE_SUMMARY.rollupAgeMs);
    expect(cd.stale_threshold_ms).toBe(SAMPLE_SUMMARY.staleThresholdMs);
    expect(cd.raw_events_waiting).toBe(12345);
    expect(cd.aggregate_row_count).toBe(678);
    expect(cd.last_run_at).toBe(SAMPLE_SUMMARY.lastRun.ranAt);
    expect(cd.last_run_rolled_up_events).toBe(9999);
    expect(cd.cooldown_hours).toBe(6);
    expect(cd.dashboard_url).toBe(DASHBOARD_URL);
  });

  it("PagerDuty: lastRun=null relays as null custom-details fields rather than crashing", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("ok", { status: 202 }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.triggerBadgeShareRollupStaleOpsAlertPagerDuty({
        routingKey: "SHAPECHECK",
        summary: { ...SAMPLE_SUMMARY, lastRun: null },
        cooldownHours: 6,
        dashboardUrl: DASHBOARD_URL,
        now: FIXED_NOW,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.payload.custom_details.last_run_at).toBeNull();
    expect(body.payload.custom_details.last_run_rolled_up_events).toBeNull();
  });
});
