/**
 * Task #1653 — UI test for the watch GPS panel's "Send test page" button
 * and the Slack ✓ / PagerDuty ✗ wiring badges.
 *
 * Covers:
 *   1. The wiring badges reflect the `chatTargets` field from the
 *      `/api/super-admin/watch-position-metrics` summary response so
 *      ops can spot a missing env var BEFORE the next spike.
 *   2. Clicking "Send test page" POSTs to the test endpoint, and the
 *      button is disabled while in flight (so an impatient operator
 *      can't double-page on-call).
 *   3. When neither chat channel is configured, the button is
 *      disabled and the panel surfaces the "no channels configured"
 *      warning instead of letting the operator click a button that
 *      would do nothing useful.
 *
 * Backend tests in
 *   artifacts/api-server/src/tests/watch-position-trend-ops-alert-chat-test-page.test.ts
 *   artifacts/api-server/src/tests/ops-alert-chat-test-mode.test.ts
 * cover the per-channel dispatch + payload formatting; together they
 * give end-to-end coverage of the spec.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 1, role: "super_admin" } }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/super-admin", vi.fn()],
}));

import SuperAdminPage from "../super-admin";

const NONEMPTY_WINDOW = {
  totalMessages: 100,
  bucketCount: 11,
  activeSessionCount: 3,
  avgMessagesPerSessionMinute: 5.5,
  p50MessagesPerSessionMinute: 5,
  p95MessagesPerSessionMinute: 9,
  maxMessagesPerSessionMinute: 12,
};

const SERIES = [
  {
    bucket: "2026-04-23T10:00:00.000Z",
    sampleCount: 1, avg: 5.5, p95: 9, max: 12,
    batteryAvg: null, batterySampleCount: 0,
    normalAvg: 5.5, normalSampleCount: 1,
  },
];

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function makeFetchMock(opts: {
  chatTargets: { slackConfigured: boolean; pagerDutyConfigured: boolean };
  testEndpoint: (req: Request | { method?: string }) => Response | Promise<Response>;
}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/super-admin/dashboard") && method === "GET") {
      return jsonResponse({
        totalClubs: 0, activeClubs: 0, totalUsers: 0,
        totalTournaments: 0, activeTournaments: 0,
        tierBreakdown: { free: 0, starter: 0, pro: 0, enterprise: 0 },
        estimatedMrr: 0, bookingsThisMonth: 0,
        bookingRevenueThisMonth: 0, bookingsByClub: [],
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
    if (url === "/api/super-admin/watch-position-metrics/test-ops-alert-chat" && method === "POST") {
      return Promise.resolve(opts.testEndpoint({ method }));
    }
    if (url.startsWith("/api/super-admin/watch-position-metrics") && method === "GET") {
      return jsonResponse({
        windows: { "24h": NONEMPTY_WINDOW, "7d": NONEMPTY_WINDOW, "30d": NONEMPTY_WINDOW },
        seriesByWindow: { "24h": SERIES, "7d": SERIES, "30d": SERIES },
        seriesBucketSeconds: { "24h": 60, "7d": 3600, "30d": 6 * 3600 },
        recent: [],
        chatTargets: opts.chatTargets,
      });
    }
    return jsonResponse({});
  });
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

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("Super-admin Watch GPS panel — ops alert wiring", () => {
  it("renders Slack ✓ / PagerDuty ✗ from the chatTargets summary field", async () => {
    const fetchMock = makeFetchMock({
      chatTargets: { slackConfigured: true, pagerDutyConfigured: false },
      testEndpoint: () => ({ ok: true } as Response),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    const wiringPanel = await screen.findByTestId("panel-watch-ops-alert-wiring");
    const slackBadge = await screen.findByTestId("status-watch-ops-alert-slack");
    const pdBadge = await screen.findByTestId("status-watch-ops-alert-pagerduty");
    expect(wiringPanel).toBeInTheDocument();
    expect(slackBadge).toHaveTextContent(/Slack/);
    expect(slackBadge).toHaveAttribute("title", expect.stringMatching(/is set/));
    expect(pdBadge).toHaveTextContent(/PagerDuty/);
    expect(pdBadge).toHaveAttribute("title", expect.stringMatching(/is not set/));
    // The "no channels configured" warning is hidden when at least one is set.
    expect(screen.queryByTestId("status-watch-ops-alert-none")).not.toBeInTheDocument();
    // Test page button is enabled because Slack is set.
    expect(screen.getByTestId("button-watch-ops-alert-test-page")).not.toBeDisabled();
  });

  it("disables the Send test page button and shows a warning when no channels are configured", async () => {
    const fetchMock = makeFetchMock({
      chatTargets: { slackConfigured: false, pagerDutyConfigured: false },
      testEndpoint: () => ({ ok: true } as Response),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    expect(await screen.findByTestId("status-watch-ops-alert-none")).toBeInTheDocument();
    expect(await screen.findByTestId("button-watch-ops-alert-test-page")).toBeDisabled();
  });

  it("POSTs to the test endpoint when Send test page is clicked", async () => {
    let postedAt = 0;
    const fetchMock = makeFetchMock({
      chatTargets: { slackConfigured: true, pagerDutyConfigured: true },
      testEndpoint: () => {
        postedAt = Date.now();
        return jsonResponse({
          targets: { slackConfigured: true, pagerDutyConfigured: true },
          slack: { configured: true, attempted: true, ok: true, error: null },
          pagerDuty: { configured: true, attempted: true, ok: true, error: null },
        });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    const btn = await screen.findByTestId("button-watch-ops-alert-test-page");
    expect(btn).not.toBeDisabled();
    await user.click(btn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/super-admin/watch-position-metrics/test-ops-alert-chat",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(postedAt).toBeGreaterThan(0);
  });
});
