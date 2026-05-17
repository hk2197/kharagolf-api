/**
 * Task #1317 — `reportPushOpened` is the small fetch wrapper that the
 * mobile app's notification-tap handlers call so the analytics dashboard
 * sees native push opens, not just web/portal in-app opens.
 *
 * Pinned behaviours:
 *   • POSTs to /api/portal/notifications/push-opened with the bearer
 *     token in the Authorization header.
 *   • Forwards `messageId`, `type`, `url` and the small allow-list of
 *     context keys (tournamentId, payoutId, reelId, …) verbatim.
 *   • Forwards `organizationId` when the push payload supplies it (so
 *     the server can validate membership and stamp the analytics row).
 *   • Skips the network call entirely when there's no auth token (signed
 *     out) or no push payload — analytics must never crash the app.
 *   • Swallows fetch failures so a flaky network never blocks the deep
 *     link the user just tapped.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/utils/api", () => ({
  getApiUrl: (path: string) => `https://kharagolf.example.test/api${path}`,
}));

import { reportPushOpened } from "@/utils/reportPushOpened";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
  // @ts-expect-error — assign to the global for the duration of each test
  globalThis.fetch = fetchMock;
});

function lastBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("reportPushOpened", () => {
  it("POSTs to /api/portal/notifications/push-opened with the bearer token", async () => {
    await reportPushOpened({
      authToken: "tok-123",
      data: { type: "handicap_case_update" },
      messageId: "expo-msg-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://kharagolf.example.test/api/portal/notifications/push-opened");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-123");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("forwards type, url, messageId and allow-listed context keys verbatim", async () => {
    await reportPushOpened({
      authToken: "tok-123",
      messageId: "expo-msg-42",
      data: {
        type: "highlight_render_complete",
        url: "/highlights",
        reelId: 4242,
        tournamentId: 99,
        payoutId: "PAY-XYZ",
        // Keys outside the allow-list are dropped on the client side too,
        // matching the server's allow-list — a defence-in-depth check.
        ssn: "leak-me-not",
      },
    });

    const body = lastBody();
    expect(body).toEqual({
      messageId: "expo-msg-42",
      type: "highlight_render_complete",
      url: "/highlights",
      reelId: 4242,
      tournamentId: 99,
      payoutId: "PAY-XYZ",
    });
    expect(body).not.toHaveProperty("ssn");
  });

  it("forwards organizationId from the push payload when present", async () => {
    await reportPushOpened({
      authToken: "tok-123",
      data: { type: "coach_payout_paid", organizationId: 7, payoutId: 42 },
      messageId: "id-1",
    });

    const body = lastBody();
    expect(body.organizationId).toBe(7);
    expect(body.payoutId).toBe(42);
    expect(body.type).toBe("coach_payout_paid");
  });

  it("skips the network call when the user is signed out (no auth token)", async () => {
    await reportPushOpened({
      authToken: null,
      data: { type: "handicap_case_update" },
      messageId: "id-1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still reports a tap when the push has no data payload (messageId-only fallback)", async () => {
    // Some malformed / legacy notifications arrive without a `data`
    // blob. We still want the dashboard to count the tap so reach
    // vs engagement stays accurate — the server accepts an empty body
    // and writes a row with null discriminators.
    await reportPushOpened({
      authToken: "tok-123",
      data: undefined,
      messageId: "expo-msg-noop",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = lastBody();
    expect(body).toEqual({
      messageId: "expo-msg-noop",
      type: null,
      url: null,
    });
    // No allow-listed context keys leak in when there's no data.
    expect(body).not.toHaveProperty("organizationId");
    expect(body).not.toHaveProperty("tournamentId");
  });

  it("normalises a missing messageId to null in the request body", async () => {
    await reportPushOpened({
      authToken: "tok-123",
      data: { type: "handicap_case_update" },
    });
    const body = lastBody();
    expect(body.messageId).toBeNull();
    expect(body.type).toBe("handicap_case_update");
  });

  it("returns silently and does NOT throw when fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(reportPushOpened({
      authToken: "tok-123",
      data: { type: "handicap_case_update" },
      messageId: "id-1",
    })).resolves.toBeUndefined();
  });
});
