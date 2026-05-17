/**
 * Task #1196 — UI test for the super-admin "Watch GPS position rate" panel.
 *
 * Task #1028 added a chart and a 24h / 7d / 30d window selector. This test
 * locks down the wiring so a future refactor can't silently break the only
 * ops view of watch GPS volume:
 *
 *   1. The panel mounts on the dashboard view, defaults to "24h", and the
 *      headline tiles (avg / p50/p95 / max / active sessions) reflect the
 *      `windows["24h"]` numbers from the mocked summary endpoint.
 *   2. Clicking the 7d / 30d buttons swaps the headline numbers AND the
 *      chart sub-heading bucket label ("minute" → "hour" → "6h"), proving
 *      `seriesByWindow[watchWindow]` is what's being rendered.
 *
 * The backend tests in
 *   artifacts/api-server/src/tests/watch-position-metrics.test.ts
 * cover the per-window bucketing + battery-vs-normal split on the server
 * side; together they give end-to-end coverage of the spec.
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

// Per-window summaries with deliberately distinct numbers so we can tell
// which window is rendered without inspecting any internal state.
const WINDOWS = {
  "24h": {
    totalMessages: 100,
    bucketCount: 11,
    activeSessionCount: 3,
    avgMessagesPerSessionMinute: 5.5,
    p50MessagesPerSessionMinute: 5,
    p95MessagesPerSessionMinute: 9,
    maxMessagesPerSessionMinute: 12,
  },
  "7d": {
    totalMessages: 700,
    bucketCount: 77,
    activeSessionCount: 21,
    avgMessagesPerSessionMinute: 6.6,
    p50MessagesPerSessionMinute: 6,
    p95MessagesPerSessionMinute: 14,
    maxMessagesPerSessionMinute: 22,
  },
  "30d": {
    totalMessages: 3000,
    bucketCount: 333,
    activeSessionCount: 88,
    avgMessagesPerSessionMinute: 7.7,
    p50MessagesPerSessionMinute: 7,
    p95MessagesPerSessionMinute: 17,
    maxMessagesPerSessionMinute: 33,
  },
} as const;

// Each window gets its own series with a distinct bucket count so we can
// assert the chart re-renders. (Recharts inside jsdom will draw an SVG with
// no actual layout, but the chart sub-heading "Messages per session-{label}"
// is a deterministic, render-once-per-data signal.)
const SERIES = {
  "24h": [
    { bucket: "2026-04-23T10:00:00.000Z", sampleCount: 2, avg: 5.5, p95: 9, max: 12, batteryAvg: null, batterySampleCount: 0, normalAvg: 5.5, normalSampleCount: 2 },
    { bucket: "2026-04-23T10:01:00.000Z", sampleCount: 1, avg: 4, p95: 4, max: 4, batteryAvg: null, batterySampleCount: 0, normalAvg: 4, normalSampleCount: 1 },
  ],
  "7d": [
    { bucket: "2026-04-22T10:00:00.000Z", sampleCount: 5, avg: 6.6, p95: 14, max: 22, batteryAvg: 8, batterySampleCount: 1, normalAvg: 6.2, normalSampleCount: 4 },
    { bucket: "2026-04-22T11:00:00.000Z", sampleCount: 3, avg: 5, p95: 7, max: 7, batteryAvg: null, batterySampleCount: 0, normalAvg: 5, normalSampleCount: 3 },
    { bucket: "2026-04-22T12:00:00.000Z", sampleCount: 2, avg: 4, p95: 4, max: 4, batteryAvg: null, batterySampleCount: 0, normalAvg: 4, normalSampleCount: 2 },
  ],
  "30d": [
    { bucket: "2026-04-15T00:00:00.000Z", sampleCount: 8, avg: 7.7, p95: 17, max: 33, batteryAvg: 10, batterySampleCount: 2, normalAvg: 7, normalSampleCount: 6 },
    { bucket: "2026-04-15T06:00:00.000Z", sampleCount: 4, avg: 5, p95: 8, max: 8, batteryAvg: null, batterySampleCount: 0, normalAvg: 5, normalSampleCount: 4 },
  ],
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

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/super-admin/dashboard") && method === "GET") {
      return jsonResponse({
        totalClubs: 0,
        activeClubs: 0,
        totalUsers: 0,
        totalTournaments: 0,
        activeTournaments: 0,
        tierBreakdown: { free: 0, starter: 0, pro: 0, enterprise: 0 },
        estimatedMrr: 0,
        bookingsThisMonth: 0,
        bookingRevenueThisMonth: 0,
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
    if (url.startsWith("/api/super-admin/watch-position-metrics") && method === "GET") {
      return jsonResponse({
        windows: WINDOWS,
        seriesByWindow: SERIES,
        seriesBucketSeconds: { "24h": 60, "7d": 3600, "30d": 6 * 3600 },
        recent: [
          {
            bucketMinute: "2026-04-23T10:00:00.000Z",
            sessionId: "sess-x",
            userId: 99,
            tournamentId: null,
            batteryMode: false,
            positionCount: 12,
          },
        ],
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

describe("Super-admin Watch GPS chart — window selector", () => {
  it("renders 24h numbers by default and swaps headline tiles + chart label when 7d / 30d are clicked", async () => {
    const user = userEvent.setup();
    renderPage();

    // Wait for the panel + 24h tiles to render (all four headline tiles).
    const avgTile = await screen.findByTestId("text-watch-avg-rate");
    const percentilesTile = screen.getByTestId("text-watch-percentiles");
    const maxTile = screen.getByTestId("text-watch-max-rate");
    const sessionsTile = screen.getByTestId("text-watch-sessions");
    const chart = screen.getByTestId("chart-watch-position-rate");

    // 24h is the default — assert each tile shows a 24h-only number.
    // toLocaleString() may round trip "5.5" verbatim; we match the
    // significant digits with a tolerant regex so locale quirks don't bite.
    expect(avgTile).toHaveTextContent(/5\.5/);
    expect(percentilesTile).toHaveTextContent(/5/);
    expect(percentilesTile).toHaveTextContent(/9/);
    expect(maxTile).toHaveTextContent(/^12$/);
    expect(sessionsTile).toHaveTextContent(/^3$/);
    // Chart sub-heading reflects the 24h bucket size (60 s → "minute").
    expect(chart).toHaveTextContent(/Messages per session-minute/);

    // 24h-distinguishing assertions: NONE of the 7d/30d numbers leak in.
    expect(avgTile).not.toHaveTextContent(/6\.6/);
    expect(avgTile).not.toHaveTextContent(/7\.7/);
    expect(maxTile.textContent).not.toMatch(/22|33/);
    expect(sessionsTile.textContent).not.toMatch(/21|88/);

    // ── Switch to 7d ───────────────────────────────────────────────────
    await user.click(screen.getByTestId("button-watch-window-7d"));

    await waitFor(() => {
      expect(screen.getByTestId("text-watch-avg-rate")).toHaveTextContent(/6\.6/);
    });
    expect(screen.getByTestId("text-watch-percentiles")).toHaveTextContent(/14/);
    expect(screen.getByTestId("text-watch-max-rate")).toHaveTextContent(/^22$/);
    expect(screen.getByTestId("text-watch-sessions")).toHaveTextContent(/^21$/);
    // Chart sub-heading now uses the per-hour label.
    expect(screen.getByTestId("chart-watch-position-rate")).toHaveTextContent(
      /Messages per session-hour/,
    );
    // Per-window total tiles (these always show all three windows side by
    // side) prove the 7d total survives the switch.
    expect(screen.getByTestId("text-watch-total-7d")).toHaveTextContent(/700/);

    // ── Switch to 30d ──────────────────────────────────────────────────
    await user.click(screen.getByTestId("button-watch-window-30d"));

    await waitFor(() => {
      expect(screen.getByTestId("text-watch-avg-rate")).toHaveTextContent(/7\.7/);
    });
    expect(screen.getByTestId("text-watch-percentiles")).toHaveTextContent(/17/);
    expect(screen.getByTestId("text-watch-max-rate")).toHaveTextContent(/^33$/);
    expect(screen.getByTestId("text-watch-sessions")).toHaveTextContent(/^88$/);
    // 30d uses 6-hour buckets → label is "6h", not "minute" / "hour".
    const chart30 = screen.getByTestId("chart-watch-position-rate");
    expect(chart30).toHaveTextContent(/Messages per session-6h/);
    expect(chart30).not.toHaveTextContent(/Messages per session-minute/);
    expect(chart30).not.toHaveTextContent(/Messages per session-hour/);
    expect(screen.getByTestId("text-watch-total-30d")).toHaveTextContent(/3,000|3000/);

    // ── Switch back to 24h ─────────────────────────────────────────────
    await user.click(screen.getByTestId("button-watch-window-24h"));

    await waitFor(() => {
      expect(screen.getByTestId("text-watch-avg-rate")).toHaveTextContent(/5\.5/);
    });
    expect(screen.getByTestId("chart-watch-position-rate")).toHaveTextContent(
      /Messages per session-minute/,
    );
  });

  it("shows the empty-state placeholder when the selected window has no buckets", async () => {
    // Override fetch so 24h is empty but 7d/30d have data.
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
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
      if (url.startsWith("/api/super-admin/watch-position-metrics") && method === "GET") {
        const empty = {
          totalMessages: 0, bucketCount: 0, activeSessionCount: 0,
          avgMessagesPerSessionMinute: 0, p50MessagesPerSessionMinute: 0,
          p95MessagesPerSessionMinute: 0, maxMessagesPerSessionMinute: 0,
        };
        return jsonResponse({
          windows: { "24h": empty, "7d": WINDOWS["7d"], "30d": WINDOWS["30d"] },
          seriesByWindow: { "24h": [], "7d": SERIES["7d"], "30d": SERIES["30d"] },
          seriesBucketSeconds: { "24h": 60, "7d": 3600, "30d": 6 * 3600 },
          recent: [],
        });
      }
      return jsonResponse({});
    });

    const user = userEvent.setup();
    renderPage();

    // Default 24h has no data → empty-state copy shows.
    await screen.findByTestId("text-watch-empty");
    expect(screen.getByTestId("text-watch-empty")).toHaveTextContent(/last 24h/);
    // No tiles or chart in this branch.
    expect(screen.queryByTestId("text-watch-avg-rate")).toBeNull();
    expect(screen.queryByTestId("chart-watch-position-rate")).toBeNull();

    // Switching to 7d brings the chart and tiles back.
    await user.click(screen.getByTestId("button-watch-window-7d"));
    await waitFor(() => {
      expect(screen.queryByTestId("text-watch-empty")).toBeNull();
    });
    expect(screen.getByTestId("text-watch-avg-rate")).toHaveTextContent(/6\.6/);
    expect(screen.getByTestId("chart-watch-position-rate")).toHaveTextContent(
      /Messages per session-hour/,
    );
  });
});
