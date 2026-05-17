/**
 * Tests for Task #1653 — `testMode` payload formatting on the watch GPS
 * Slack / PagerDuty senders in `opsAlertChat.ts`.
 *
 * The super-admin "Send test page" button on the ops dashboard goes
 * through these same senders so a typo in the webhook URL or routing
 * key surfaces immediately. The point of these tests is to make sure
 * the test page is *clearly* labelled as a wiring verification — if
 * someone refactors the payload and accidentally drops the "[TEST]"
 * marker, on-call would think the test page is a real spike and start
 * paging engineering at 3am.
 *
 * Mocks `fetch` so no real HTTP traffic is attempted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  postWatchPositionTrendOpsAlertSlack,
  triggerWatchPositionTrendOpsAlertPagerDuty,
} from "../lib/opsAlertChat.js";

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" } as Response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SHARED_OPTS = {
  recentAvg: 0,
  baselineAvg: 0,
  windowSize: 20,
  multiplier: 3,
  cooldownMinutes: 10,
  now: new Date("2025-01-15T12:00:00Z"),
};

describe("postWatchPositionTrendOpsAlertSlack — testMode", () => {
  it("labels the message clearly as a wiring test (not a real spike)", async () => {
    await postWatchPositionTrendOpsAlertSlack({
      webhookUrl: "https://hooks.slack.com/services/AAA/BBB/CCC",
      ...SHARED_OPTS,
      testMode: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/AAA/BBB/CCC");
    const body = JSON.parse((init as RequestInit).body as string);
    // Headline + header text both include the "[TEST]" marker so the
    // recipient can tell at a glance this isn't a real incident.
    expect(body.text).toContain("[TEST]");
    expect(body.text).toContain("no real spike");
    expect(body.blocks[0].text.text).toContain("[TEST]");
    expect(body.blocks[1].text.text).toContain("test page");
    // Real-spike fields like the "ratio" / "recent vs baseline" sentences
    // are NOT in the test-mode body — they would imply a real spike.
    expect(body.blocks[1].text.text).not.toContain("Recent 20-bucket avg");
  });

  it("renders the real spike body when testMode is omitted (regression check)", async () => {
    await postWatchPositionTrendOpsAlertSlack({
      webhookUrl: "https://hooks.slack.com/services/AAA/BBB/CCC",
      ...SHARED_OPTS,
      recentAvg: 10,
      baselineAvg: 1,
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).not.toContain("[TEST]");
    expect(body.blocks[0].text.text).toBe("Watch GPS message rate spiking");
    expect(body.blocks[1].text.text).toContain("Recent 20-bucket avg");
  });
});

describe("triggerWatchPositionTrendOpsAlertPagerDuty — testMode", () => {
  it("labels the incident clearly and uses a separate dedup_key + info severity", async () => {
    await triggerWatchPositionTrendOpsAlertPagerDuty({
      routingKey: "R0UT1NGK3Y",
      ...SHARED_OPTS,
      testMode: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://events.pagerduty.com/v2/enqueue");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.routing_key).toBe("R0UT1NGK3Y");
    expect(body.event_action).toBe("trigger");
    // Test pages get their own dedup_key so a wiring test doesn't collapse
    // into (or silence) the open incident from a real spike in flight.
    expect(body.dedup_key).toBe("watch-position-trend-spike-test");
    // Severity is downgraded to "info" so a test page doesn't escalate
    // through a "warning"-only paging policy.
    expect(body.payload.severity).toBe("info");
    expect(body.payload.summary).toContain("[TEST]");
    expect(body.payload.summary).toContain("no real spike");
    expect(body.payload.class).toBe("trend-spike-wiring-test");
    expect(body.payload.custom_details.test_page).toBe(true);
    // Real-spike fields are NOT in the test-mode custom_details — those
    // would imply a real spike worth charting.
    expect(body.payload.custom_details.recent_avg_msgs_per_session_minute).toBeUndefined();
  });

  it("renders the real spike payload when testMode is omitted (regression check)", async () => {
    await triggerWatchPositionTrendOpsAlertPagerDuty({
      routingKey: "R0UT1NGK3Y",
      ...SHARED_OPTS,
      recentAvg: 10,
      baselineAvg: 1,
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.dedup_key).toBe("watch-position-trend-spike");
    expect(body.payload.severity).toBe("warning");
    expect(body.payload.summary).not.toContain("[TEST]");
    expect(body.payload.class).toBe("trend-spike");
    expect(body.payload.custom_details.recent_avg_msgs_per_session_minute).toBe(10);
    expect(body.payload.custom_details.baseline_avg_msgs_per_session_minute).toBe(1);
  });

  it("propagates HTTP errors so the dashboard surfaces a misconfigured routing key", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "invalid routing_key",
    } as Response);
    await expect(
      triggerWatchPositionTrendOpsAlertPagerDuty({
        routingKey: "WRONG-KEY",
        ...SHARED_OPTS,
        testMode: true,
      }),
    ).rejects.toThrow(/PagerDuty Events API returned 401/);
  });
});
