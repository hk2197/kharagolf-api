/**
 * Tests for the swing fps-probe failure backlog ops alert's
 * Slack / PagerDuty chat dispatch (Task #2123). Mirrors the structure
 * of `badge-share-rollup-ops-alert-chat.test.ts`:
 *
 *   - Target resolution: dedicated env vars
 *     `OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK` /
 *     `OPS_FPS_PROBE_FAILED_PAGERDUTY_ROUTING_KEY` win, with a
 *     fallback to the shared
 *     `OPS_ALERT_SLACK_WEBHOOK` / `OPS_ALERT_PAGERDUTY_ROUTING_KEY`
 *     pair so most deploys only need to set one pair.
 *   - Dispatch: Slack only / PD only / both / neither matrix, plus
 *     per-channel failure independence (Slack outage doesn't suppress
 *     PD trigger and vice versa).
 *   - Payload shape: failed-row + growth counts in headline, recent
 *     failures sample inline, dashboard URL, UTC-date-scoped PD
 *     `dedup_key`, trigger flags relayed in Slack section + PD
 *     `custom_details`.
 *
 * Drives the exported `_dispatchSwingFpsProbeFailureChatForTests`
 * helper rather than spinning the full job through the DB — the chat
 * branch is independent of the email recipient list / cooldown.
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
    postSwingFpsProbeFailureOpsAlertSlack: vi.fn(async () => undefined),
    triggerSwingFpsProbeFailureOpsAlertPagerDuty: vi.fn(async () => undefined),
  };
});

import {
  postSwingFpsProbeFailureOpsAlertSlack,
  triggerSwingFpsProbeFailureOpsAlertPagerDuty,
} from "../lib/opsAlertChat.js";
import {
  _dispatchSwingFpsProbeFailureChatForTests,
  _resolveSwingFpsProbeFailureChatTargetsForTests,
} from "../lib/swingFpsProbeFailureOpsAlert.js";

const slackMock = vi.mocked(postSwingFpsProbeFailureOpsAlertSlack);
const pdMock = vi.mocked(triggerSwingFpsProbeFailureOpsAlertPagerDuty);

const ENV_KEYS = [
  "OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK",
  "OPS_FPS_PROBE_FAILED_PAGERDUTY_ROUTING_KEY",
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

const SAMPLE_RECENT = [
  {
    swingVideoId: 1001,
    completedAt: "2026-04-29T12:00:00.000Z",
    errorMessage: "ffprobe exited 1",
  },
  {
    swingVideoId: 1002,
    completedAt: "2026-04-29T11:50:00.000Z",
    errorMessage: "object not found",
  },
];

const DASHBOARD_URL = "https://kharagolf.com/super-admin/swing-video-diagnostics";

const BASE_PAYLOAD = {
  failedRetained: 42,
  threshold: 25,
  cooldownHours: 24,
  growthCount: 7,
  growthDelta: 10,
  growthLookbackHours: 24,
  trigger: { thresholdBreached: true, growthBreached: false },
  recentFailures: SAMPLE_RECENT,
  dashboardUrl: DASHBOARD_URL,
  now: FIXED_NOW,
};

async function dispatch(
  overrides: Partial<typeof BASE_PAYLOAD> = {},
): Promise<void> {
  _dispatchSwingFpsProbeFailureChatForTests({ ...BASE_PAYLOAD, ...overrides });
  // Fire-and-forget: dispatcher uses `void send...().catch(...)`, so
  // let the queued microtasks drain before asserting.
  await new Promise((r) => setTimeout(r, 0));
}

describe("swing fps-probe failure → chat target resolution", () => {
  it("returns both nulls when no env var is set", () => {
    expect(_resolveSwingFpsProbeFailureChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: null,
    });
  });

  it("picks up the dedicated Slack webhook when set", () => {
    process.env.OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/FPS/HOOK";
    expect(_resolveSwingFpsProbeFailureChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/FPS/HOOK",
      pagerDutyRoutingKey: null,
    });
  });

  it("picks up the dedicated PagerDuty routing key when set", () => {
    process.env.OPS_FPS_PROBE_FAILED_PAGERDUTY_ROUTING_KEY = "FPSPDKEY";
    expect(_resolveSwingFpsProbeFailureChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: "FPSPDKEY",
    });
  });

  it("falls back to OPS_ALERT_SLACK_WEBHOOK when the dedicated Slack var is unset", () => {
    process.env.OPS_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/SHARED/HOOK";
    expect(_resolveSwingFpsProbeFailureChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/SHARED/HOOK",
      pagerDutyRoutingKey: null,
    });
  });

  it("falls back to OPS_ALERT_PAGERDUTY_ROUTING_KEY when the dedicated PD var is unset", () => {
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "SHAREDPDKEY";
    expect(_resolveSwingFpsProbeFailureChatTargetsForTests()).toEqual({
      slackWebhook: null,
      pagerDutyRoutingKey: "SHAREDPDKEY",
    });
  });

  it("dedicated env vars win over the shared fallback when both are set", () => {
    process.env.OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/DEDICATED";
    process.env.OPS_FPS_PROBE_FAILED_PAGERDUTY_ROUTING_KEY = "DEDICATEDPDKEY";
    process.env.OPS_ALERT_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/SHARED";
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "SHAREDPDKEY";
    expect(_resolveSwingFpsProbeFailureChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/DEDICATED",
      pagerDutyRoutingKey: "DEDICATEDPDKEY",
    });
  });

  it("treats whitespace-only values as unset (and falls through to the shared fallback)", () => {
    process.env.OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK = "   ";
    process.env.OPS_FPS_PROBE_FAILED_PAGERDUTY_ROUTING_KEY = "\n";
    process.env.OPS_ALERT_SLACK_WEBHOOK =
      "  https://hooks.slack.com/services/SHARED  ";
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "  SHAREDPDKEY\t";
    expect(_resolveSwingFpsProbeFailureChatTargetsForTests()).toEqual({
      slackWebhook: "https://hooks.slack.com/services/SHARED",
      pagerDutyRoutingKey: "SHAREDPDKEY",
    });
  });
});

describe("swing fps-probe failure → chat dispatch", () => {
  it("does not dispatch on either channel when no chat target is configured (warn-only)", async () => {
    await dispatch();
    expect(slackMock).not.toHaveBeenCalled();
    expect(pdMock).not.toHaveBeenCalled();
  });

  it("posts to Slack only when only the Slack webhook is configured", async () => {
    process.env.OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/FPS/HOOK";

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).not.toHaveBeenCalled();
    const arg = slackMock.mock.calls[0][0];
    expect(arg.webhookUrl).toBe("https://hooks.slack.com/services/FPS/HOOK");
    expect(arg.failedRetained).toBe(42);
    expect(arg.threshold).toBe(25);
    expect(arg.growthCount).toBe(7);
    expect(arg.growthDelta).toBe(10);
    expect(arg.growthLookbackHours).toBe(24);
    expect(arg.trigger).toEqual({ thresholdBreached: true, growthBreached: false });
    expect(arg.recentFailures).toEqual(SAMPLE_RECENT);
    expect(arg.dashboardUrl).toBe(DASHBOARD_URL);
    expect(arg.now).toBe(FIXED_NOW);
  });

  it("triggers PagerDuty only when only the routing key is configured", async () => {
    process.env.OPS_FPS_PROBE_FAILED_PAGERDUTY_ROUTING_KEY = "FPSPDKEY";

    await dispatch();

    expect(pdMock).toHaveBeenCalledTimes(1);
    expect(slackMock).not.toHaveBeenCalled();
    const arg = pdMock.mock.calls[0][0];
    expect(arg.routingKey).toBe("FPSPDKEY");
    expect(arg.failedRetained).toBe(42);
    expect(arg.trigger).toEqual({ thresholdBreached: true, growthBreached: false });
  });

  it("dispatches to both channels when both env vars are configured", async () => {
    process.env.OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/FPS/HOOK";
    process.env.OPS_FPS_PROBE_FAILED_PAGERDUTY_ROUTING_KEY = "FPSPDKEY";

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
    process.env.OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/FPS/HOOK";
    process.env.OPS_FPS_PROBE_FAILED_PAGERDUTY_ROUTING_KEY = "FPSPDKEY";
    slackMock.mockRejectedValueOnce(new Error("slack down"));

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });

  it("a PagerDuty failure does not suppress the Slack post", async () => {
    process.env.OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/FPS/HOOK";
    process.env.OPS_FPS_PROBE_FAILED_PAGERDUTY_ROUTING_KEY = "FPSPDKEY";
    pdMock.mockRejectedValueOnce(new Error("pd down"));

    await dispatch();

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pdMock).toHaveBeenCalledTimes(1);
  });

  it("relays an empty recent-failures sample without crashing", async () => {
    process.env.OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/FPS/HOOK";

    await dispatch({ recentFailures: [] });

    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(slackMock.mock.calls[0][0].recentFailures).toEqual([]);
  });

  it("relays both trigger flags when threshold + growth fire on the same run", async () => {
    process.env.OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK =
      "https://hooks.slack.com/services/FPS/HOOK";
    process.env.OPS_FPS_PROBE_FAILED_PAGERDUTY_ROUTING_KEY = "FPSPDKEY";

    await dispatch({
      trigger: { thresholdBreached: true, growthBreached: true },
      growthCount: 18,
      failedRetained: 60,
    });

    expect(slackMock.mock.calls[0][0].trigger).toEqual({
      thresholdBreached: true,
      growthBreached: true,
    });
    expect(pdMock.mock.calls[0][0].trigger).toEqual({
      thresholdBreached: true,
      growthBreached: true,
    });
  });
});

// ── Sender-level shape assertions ────────────────────────────────────────
//
// The Slack / PagerDuty wrappers are pure functions that translate
// the dispatcher's domain inputs into channel-specific payloads — the
// tests above mock them out, so verify their shape directly here.

describe("swing fps-probe failure → Slack / PagerDuty payload shape", () => {
  it("Slack: headline carries :warning:, failed-row count, trigger label, dashboard URL, recent failures sample", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("ok", { status: 200 }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.postSwingFpsProbeFailureOpsAlertSlack({
        webhookUrl: "https://hooks.slack.com/services/SHAPE/CHECK",
        ...BASE_PAYLOAD,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/services/SHAPE/CHECK");
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain(":warning:");
    expect(body.text).toContain("Swing fps-probe failures piling up");
    expect(body.text).toContain("42 failed rows");
    expect(body.text).toContain("(count)");
    expect(body.blocks[0].type).toBe("header");
    expect(body.blocks[0].text.text).toBe("Swing fps-probe failures piling up");
    const sectionText = body.blocks[1].text.text as string;
    expect(sectionText).toContain("*Failed rows:* 42 (threshold 25)");
    expect(sectionText).toContain("*New failures in last 24h:* 7 (growth delta 10)");
    expect(sectionText).toContain("*Trigger:* count");
    expect(sectionText).toContain(`*Dashboard:* ${DASHBOARD_URL}`);
    expect(sectionText).toContain("*Most recent failures:*");
    expect(sectionText).toContain("`swing_video_id=1001`");
    expect(sectionText).toContain("ffprobe exited 1");
    expect(sectionText).toContain("`swing_video_id=1002`");
    expect(sectionText).toContain("object not found");
    expect(sectionText).toContain(
      "Repeat alerts are suppressed for 24h per replica while the issue persists.",
    );
  });

  it("Slack: headline says 'count + growth' when both triggers fire and 'growth' when only growth fires", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("ok", { status: 200 }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.postSwingFpsProbeFailureOpsAlertSlack({
        webhookUrl: "https://hooks.slack.com/services/SHAPE/CHECK",
        ...BASE_PAYLOAD,
        trigger: { thresholdBreached: true, growthBreached: true },
      });
      await real.postSwingFpsProbeFailureOpsAlertSlack({
        webhookUrl: "https://hooks.slack.com/services/SHAPE/CHECK",
        ...BASE_PAYLOAD,
        failedRetained: 12,
        trigger: { thresholdBreached: false, growthBreached: true },
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const both = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(both.text).toContain("(count + growth)");
    const growthOnly = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    );
    expect(growthOnly.text).toContain("(growth)");
    expect(growthOnly.text).toContain("12 failed rows");
  });

  it("Slack: empty recent-failures sample renders an italic placeholder rather than crashing", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("ok", { status: 200 }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.postSwingFpsProbeFailureOpsAlertSlack({
        webhookUrl: "https://hooks.slack.com/services/SHAPE/CHECK",
        ...BASE_PAYLOAD,
        recentFailures: [],
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    const sectionText = body.blocks[1].text.text as string;
    expect(sectionText).toContain("_(no recent failed rows could be loaded)_");
  });

  it("Slack: caps the inline recent-failures sample and notes the truncation count", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("ok", { status: 200 }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const many = Array.from({ length: 9 }, (_, i) => ({
      swingVideoId: 2000 + i,
      completedAt: `2026-04-29T10:0${i}:00.000Z`,
      errorMessage: `error #${i}`,
    }));
    try {
      await real.postSwingFpsProbeFailureOpsAlertSlack({
        webhookUrl: "https://hooks.slack.com/services/SHAPE/CHECK",
        ...BASE_PAYLOAD,
        recentFailures: many,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    const sectionText = body.blocks[1].text.text as string;
    // First 5 ids must appear; the 9th must NOT appear in the section
    // text (only via the truncation note).
    expect(sectionText).toContain("`swing_video_id=2000`");
    expect(sectionText).toContain("`swing_video_id=2004`");
    expect(sectionText).not.toContain("`swing_video_id=2005`");
    expect(sectionText).toContain("…and 4 more");
  });

  it("PagerDuty: dedup_key is UTC-date-scoped so a sustained backlog folds into one PD incident across same-day cron ticks", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("ok", { status: 202 }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      await real.triggerSwingFpsProbeFailureOpsAlertPagerDuty({
        routingKey: "SHAPECHECK",
        ...BASE_PAYLOAD,
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
    expect(body.dedup_key).toBe("swing-fps-probe-failure-2026-04-29");
    expect(body.payload.severity).toBe("warning");
    expect(body.payload.source).toBe("api-server/swingFpsProbeFailureOpsAlert");
    expect(body.payload.group).toBe("ops-alerts");
    expect(body.payload.class).toBe("fps-probe-failure-backlog");
    expect(body.payload.component).toBe("swing-fps-probe");
    expect(body.payload.summary).toContain("Swing fps-probe failures piling up");
    expect(body.payload.summary).toContain("42 failed rows");
    expect(body.payload.summary).toContain("(count)");
    const cd = body.payload.custom_details;
    expect(cd.failed_retained).toBe(42);
    expect(cd.threshold).toBe(25);
    expect(cd.cooldown_hours).toBe(24);
    expect(cd.growth_count).toBe(7);
    expect(cd.growth_delta).toBe(10);
    expect(cd.growth_lookback_hours).toBe(24);
    expect(cd.threshold_breached).toBe(true);
    expect(cd.growth_breached).toBe(false);
    expect(cd.trigger_label).toBe("count");
    expect(cd.dashboard_url).toBe(DASHBOARD_URL);
    expect(cd.recent_failures_count).toBe(2);
    expect(cd.recent_failures_truncated).toBe(0);
    const preview = JSON.parse(cd.recent_failures_preview);
    expect(preview).toHaveLength(2);
    expect(preview[0]).toEqual({
      swing_video_id: 1001,
      completed_at: "2026-04-29T12:00:00.000Z",
      error_message: "ffprobe exited 1",
    });
  });

  it("PagerDuty: caps the recent-failures preview to 5 rows and reports the truncation delta", async () => {
    const real = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
      "../lib/opsAlertChat.js",
    );
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("ok", { status: 202 }),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const many = Array.from({ length: 8 }, (_, i) => ({
      swingVideoId: 3000 + i,
      completedAt: `2026-04-29T10:0${i}:00.000Z`,
      errorMessage: `error #${i}`,
    }));
    try {
      await real.triggerSwingFpsProbeFailureOpsAlertPagerDuty({
        routingKey: "SHAPECHECK",
        ...BASE_PAYLOAD,
        recentFailures: many,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    const cd = body.payload.custom_details;
    expect(cd.recent_failures_count).toBe(8);
    expect(cd.recent_failures_truncated).toBe(3);
    const preview = JSON.parse(cd.recent_failures_preview);
    expect(preview).toHaveLength(5);
    expect(preview[0].swing_video_id).toBe(3000);
    expect(preview[4].swing_video_id).toBe(3004);
  });
});
