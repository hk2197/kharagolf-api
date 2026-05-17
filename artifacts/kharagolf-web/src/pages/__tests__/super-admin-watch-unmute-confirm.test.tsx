/**
 * Task #2092 — UI test for the "confirm before lifting a watch mute"
 * dialog on the super-admin Active mutes panel.
 *
 * Locks down the protective behavior so a future refactor can't slip
 * back to the one-click DELETE that this task is fixing:
 *
 *   1. Clicking the row's Unmute button does NOT immediately call the
 *      DELETE endpoint — it opens the confirmation dialog instead.
 *   2. Cancelling closes the dialog without firing any DELETE.
 *   3. Confirming with a typed reason POSTs DELETE with `{ reason }` in
 *      the JSON body so the audit row gets the operator's justification
 *      instead of the canned default.
 *   4. Confirming with no typed reason still works; the body is `{}`
 *      so the server falls back to the canned reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 1, role: "super_admin" },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/super-admin", vi.fn()],
}));

import SuperAdminPage from "../super-admin";

const MUTED_SESSION_ID = "sess-runaway-abc-123";
const MUTED_SESSION = {
  sessionId: MUTED_SESSION_ID,
  userId: 99,
  tournamentId: 7,
  mutedByUserId: 1,
  mutedByName: "Super Admin",
  mutedByRole: "super_admin",
  mutedAt: "2026-04-30T10:00:00.000Z",
  expiresAt: "2026-04-30T11:00:00.000Z",
  remainingMs: 30 * 60 * 1000,
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SuperAdminPage />
    </QueryClientProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
let deleteCalls: { url: string; body: unknown }[];

beforeEach(() => {
  deleteCalls = [];
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/super-admin/watch-position-metrics/muted-sessions") && method === "GET") {
      return jsonResponse({ sessions: [MUTED_SESSION] });
    }
    if (
      url.startsWith(`/api/super-admin/watch-position-metrics/sessions/`) &&
      url.endsWith("/mute") &&
      method === "DELETE"
    ) {
      const parsed = init?.body ? JSON.parse(String(init.body)) : null;
      deleteCalls.push({ url, body: parsed });
      return jsonResponse({ ok: true, sessionId: MUTED_SESSION_ID });
    }
    if (url.startsWith("/api/super-admin/dashboard") && method === "GET") {
      return jsonResponse({
        totalClubs: 0, activeClubs: 0, totalUsers: 0, totalTournaments: 0,
        activeTournaments: 0,
        tierBreakdown: { free: 0, starter: 0, pro: 0, enterprise: 0 },
        estimatedMrr: 0, bookingsThisMonth: 0, bookingRevenueThisMonth: 0,
        bookingsByClub: [],
      });
    }
    if (url.startsWith("/api/super-admin/caddie-prompt-metrics") && method === "GET") {
      return jsonResponse({
        total: 0, windowStart: null, windowEnd: null,
        byMode: { shots: 0, rounds: 0 },
        avgEstimatedInputTokens: 0, p50EstimatedInputTokens: 0,
        p95EstimatedInputTokens: 0, maxEstimatedInputTokens: 0,
        avgTotalTrackedShots: 0, avgRoundCount: 0, recent: [],
      });
    }
    if (url.startsWith("/api/super-admin/watch-position-metrics/test-ops-alert-chat-history") && method === "GET") {
      // Minimum shape: the dashboard reads `last`, `dailySeries.length`,
      // and `totalLast30Days`. No history → empty series + null last.
      return jsonResponse({
        last: null,
        dailySeries: [],
        totalLast30Days: 0,
      });
    }
    if (url.startsWith("/api/super-admin/ops-alert-settings/chat-targets") && method === "GET") {
      // Minimum shape so `data.flows.notifyRetryExhaustion` doesn't
      // throw — the dashboard reads `flows.notifyRetryExhaustion` when
      // rendering the wiring badge next to the alert card.
      const channel = { configured: false, sharedWithSpike: false };
      return jsonResponse({
        flows: {
          notifyRetryExhaustion: { slack: channel, pagerDuty: channel },
        },
      });
    }
    if (url.startsWith("/api/super-admin/watch-position-metrics") && method === "GET") {
      // The Active mutes panel only mounts when the watch panel has
      // metrics — `bucketCount === 0` swaps the entire panel for an
      // empty-state copy. Give the 24h window a non-zero bucket so the
      // mutes panel renders.
      const populated = {
        totalMessages: 5, bucketCount: 1, activeSessionCount: 1,
        avgMessagesPerSessionMinute: 5, p50MessagesPerSessionMinute: 5,
        p95MessagesPerSessionMinute: 5, maxMessagesPerSessionMinute: 5,
      };
      const empty = {
        totalMessages: 0, bucketCount: 0, activeSessionCount: 0,
        avgMessagesPerSessionMinute: 0, p50MessagesPerSessionMinute: 0,
        p95MessagesPerSessionMinute: 0, maxMessagesPerSessionMinute: 0,
      };
      return jsonResponse({
        windows: { "24h": populated, "7d": empty, "30d": empty },
        seriesByWindow: {
          "24h": [
            { bucket: "2026-04-30T10:00:00.000Z", sampleCount: 1, avg: 5, p95: 5, max: 5, batteryAvg: null, batterySampleCount: 0, normalAvg: 5, normalSampleCount: 1 },
          ],
          "7d": [], "30d": [],
        },
        seriesBucketSeconds: { "24h": 60, "7d": 3600, "30d": 6 * 3600 },
        recent: [],
      });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("Super-admin Active mutes — Unmute confirmation dialog", () => {
  it("opens a confirm dialog instead of firing DELETE on the row's Unmute click", async () => {
    const user = userEvent.setup();
    renderPage();

    const unmuteBtn = await screen.findByTestId(
      `button-unmute-watch-session-${MUTED_SESSION_ID}`,
    );
    await user.click(unmuteBtn);

    // The dialog mounts...
    await screen.findByTestId("dialog-confirm-unmute-watch-session");
    // ...and NO DELETE has been fired yet — the original bug was firing
    // it inline on the click, which is exactly what we're guarding.
    expect(deleteCalls).toHaveLength(0);
  });

  it("Cancel closes the dialog without firing DELETE", async () => {
    const user = userEvent.setup();
    renderPage();

    const unmuteBtn = await screen.findByTestId(
      `button-unmute-watch-session-${MUTED_SESSION_ID}`,
    );
    await user.click(unmuteBtn);
    await screen.findByTestId("dialog-confirm-unmute-watch-session");

    await user.click(screen.getByTestId("button-cancel-unmute-watch-session"));

    await waitFor(() => {
      expect(screen.queryByTestId("dialog-confirm-unmute-watch-session")).toBeNull();
    });
    expect(deleteCalls).toHaveLength(0);
  });

  it("forwards the typed reason in the DELETE body when confirmed", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByTestId(`button-unmute-watch-session-${MUTED_SESSION_ID}`),
    );
    await screen.findByTestId("dialog-confirm-unmute-watch-session");

    const reason = "False positive — high-cadence drill";
    await user.type(screen.getByTestId("input-unmute-reason"), reason);
    await user.click(screen.getByTestId("button-confirm-unmute-watch-session"));

    await waitFor(() => {
      expect(deleteCalls).toHaveLength(1);
    });
    expect(deleteCalls[0].url).toContain(`/sessions/${MUTED_SESSION_ID}/mute`);
    expect(deleteCalls[0].body).toEqual({ reason });
  });

  it("sends an empty body when no reason is typed so the server uses its canned default", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByTestId(`button-unmute-watch-session-${MUTED_SESSION_ID}`),
    );
    await screen.findByTestId("dialog-confirm-unmute-watch-session");

    await user.click(screen.getByTestId("button-confirm-unmute-watch-session"));

    await waitFor(() => {
      expect(deleteCalls).toHaveLength(1);
    });
    expect(deleteCalls[0].body).toEqual({});
  });
});
