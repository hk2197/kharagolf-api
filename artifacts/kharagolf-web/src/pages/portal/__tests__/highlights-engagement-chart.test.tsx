/**
 * Task #1013 — Component coverage for the producer-facing highlights
 * gallery's engagement chart + trend toggle.
 *
 * The companion API integration test
 *   artifacts/api-server/src/tests/highlight-engagement-timeseries.test.ts
 * locks down the server contract. This test verifies the *client wiring*
 * that previously had no automated coverage:
 *
 *   1. The compact 4-bar EngagementMiniChart renders for every reel,
 *      with one bar per event type (view / feed_share / share / download)
 *      and the right counts surfaced.
 *   2. The trend panel is collapsed by default and only fetches
 *      /engagement-timeseries on the *first* expand (lazy load) — no
 *      unnecessary network traffic on page load.
 *   3. Once the timeseries arrives, the SVG sparkline renders the two
 *      overlay paths (Views vs Re-shares) the chart promises.
 *   4. Re-toggling the panel does NOT refetch — the result is cached
 *      keyed by (reelId, days) so producers can flip it open/closed
 *      without spamming the API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import PortalHighlightsPage from "../highlights";

interface FetchCall { url: string; method: string }

let fetchCalls: FetchCall[];

function makeReel(overrides: Record<string, unknown> = {}) {
  return {
    id: 77,
    title: "Spring Open Highlights",
    templateId: "classic",
    status: "ready",
    outputUrl: "/objects/reels/spring.mp4",
    thumbnailUrl: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    durationSeconds: 32,
    tournamentId: null,
    feedPostId: null,
    options: {},
    attempts: 1,
    maxAttempts: 3,
    downloadCount: 4,
    shareCount: 2,
    viewCount: 17,
    feedShareCount: 5,
    ...overrides,
  };
}

function makeTimeseries(days = 7) {
  const base = Date.now();
  return {
    reelId: 77,
    days,
    series: Array.from({ length: days }, (_, i) => {
      const d = new Date(base - (days - 1 - i) * 86_400_000);
      return {
        date: d.toISOString().slice(0, 10),
        download: 0,
        share: 0,
        view: i,            // ascending so the sparkline has a real curve
        feed_share: days - i,
      };
    }),
  };
}

// Task #1646 — mirrors the mobile suite's makeHourly: a 24-cell payload with
// one "spike" hour so the heatmap has a clear winner the test can assert on.
function makeHourly(opts: { bestHour?: number | null } = {}) {
  const bestHour = opts.bestHour ?? null;
  return {
    reelId: 77,
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      download: 0,
      share: 0,
      view: hour === bestHour ? 12 : 1,
      feed_share: 0,
      // The API surfaces `total` already summed; mirror that here so the
      // heatmap intensity calculation lines up with the production payload.
      total: hour === bestHour ? 12 : 1,
    })),
    bestHour,
  };
}

function installFetch(opts: { reels?: unknown[]; timeseries?: unknown; hourly?: unknown } = {}) {
  const reels = opts.reels ?? [makeReel()];
  const timeseries = opts.timeseries ?? makeTimeseries(7);
  const hourly = opts.hourly ?? makeHourly();

  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    fetchCalls.push({ url, method });

    if (url.includes("/api/portal/highlights/templates")) {
      return new Response(JSON.stringify({ templates: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/api/portal/my-tournaments")) {
      return new Response(JSON.stringify({ tournaments: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/engagement-timeseries")) {
      return new Response(JSON.stringify(timeseries), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/engagement-hourly")) {
      return new Response(JSON.stringify(hourly), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/api/portal/highlights") && method === "GET") {
      // Top-level list endpoint.
      return new Response(JSON.stringify({
        reels,
        quota: { monthlyLimit: 9999, usedThisMonth: 0, remaining: 9999 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  fetchCalls = [];
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Task #1013 — engagement chart + lazy trend toggle", () => {
  it("renders the 4-bar engagement chart with one bar per event type and the right counts", async () => {
    installFetch();
    render(<PortalHighlightsPage />);

    // Wait for the reel to land.
    await screen.findByTestId("engagement-chart-77");

    // One bar per event type, in the documented order.
    for (const key of ["view", "feed_share", "share", "download"]) {
      expect(screen.getByTestId(`bar-${key}-77`)).toBeInTheDocument();
    }

    // The bar's leading number is the count surfaced by the API. We
    // assert per-bar so a refactor that swaps the keys would fail loudly.
    expect(screen.getByTestId("bar-view-77").textContent).toContain("17");
    expect(screen.getByTestId("bar-feed_share-77").textContent).toContain("5");
    expect(screen.getByTestId("bar-share-77").textContent).toContain("2");
    expect(screen.getByTestId("bar-download-77").textContent).toContain("4");

    // The trend panel must NOT be open and the timeseries must NOT have
    // been fetched on initial load — that's the whole point of the lazy
    // toggle.
    expect(screen.queryByTestId("trend-panel-77")).toBeNull();
    expect(fetchCalls.some(c => c.url.includes("/engagement-timeseries"))).toBe(false);
  });

  it("clicking the trend toggle lazy-loads the timeseries and renders the sparkline overlay", async () => {
    installFetch();
    render(<PortalHighlightsPage />);

    const toggle = await screen.findByTestId("btn-trend-77");

    // Lazy-load: no timeseries fetch before the first toggle.
    expect(fetchCalls.filter(c => c.url.includes("/engagement-timeseries")).length).toBe(0);

    fireEvent.click(toggle);

    // Panel opens.
    const panel = await screen.findByTestId("trend-panel-77");
    expect(panel).toBeInTheDocument();

    // …and the timeseries endpoint was hit exactly once for the default
    // 7-day window.
    await waitFor(() => {
      const ts = fetchCalls.filter(c => c.url.includes("/engagement-timeseries"));
      expect(ts.length).toBe(1);
      expect(ts[0].url).toContain("/api/portal/highlights/77/engagement-timeseries");
      expect(ts[0].url).toContain("days=7");
    });

    // The sparkline renders two SVG paths — one for Views, one for
    // Re-shares — exactly as the chart promises.
    await waitFor(() => {
      const svg = panel.querySelector("svg");
      expect(svg).toBeTruthy();
      const paths = svg!.querySelectorAll("path");
      expect(paths.length).toBe(2);
    });
  });

  it("re-toggling the trend panel hits the cache instead of refetching", async () => {
    installFetch();
    render(<PortalHighlightsPage />);

    const toggle = await screen.findByTestId("btn-trend-77");

    fireEvent.click(toggle); // open (fetch #1)
    await screen.findByTestId("trend-panel-77");
    await waitFor(() => {
      expect(fetchCalls.filter(c => c.url.includes("/engagement-timeseries")).length).toBe(1);
    });

    fireEvent.click(toggle); // close
    await waitFor(() => expect(screen.queryByTestId("trend-panel-77")).toBeNull());

    fireEvent.click(toggle); // re-open — must hit the cache, not refetch
    await screen.findByTestId("trend-panel-77");

    // Give any stray request a tick to land.
    await new Promise(r => setTimeout(r, 0));
    expect(fetchCalls.filter(c => c.url.includes("/engagement-timeseries")).length).toBe(1);
  });
});

/**
 * Task #1646 — Web parity for the hour-of-day heatmap component coverage
 * the mobile suite gained in Task #1372.
 *
 * The producer dashboard renders the same `HourHeatmap` (24 cells, same
 * testIDs, same purple-outline "best hour" highlight) and the same
 * lazy-loaded `/engagement-hourly` fetch alongside the timeseries. Without
 * these assertions, a future change to `loadTrend` or `HourHeatmap` could
 * silently stop drawing the heatmap or surface the wrong best hour to web
 * producers and we'd only find out from a customer report.
 */
describe("Task #1646 — hour-of-day heatmap inside the trend panel", () => {
  const hourlyCalls = () => fetchCalls.filter(c => c.url.includes("/engagement-hourly"));

  it("renders the 24-cell heatmap inside the trend panel and highlights only the best hour", async () => {
    const BEST_HOUR = 19;
    installFetch({ hourly: makeHourly({ bestHour: BEST_HOUR }) });
    render(<PortalHighlightsPage />);

    const toggle = await screen.findByTestId("btn-trend-77");

    // Heatmap is gated on the trend panel — it must NOT be in the DOM
    // before the producer expands the panel.
    expect(screen.queryByTestId("hour-heatmap")).toBeNull();
    expect(screen.queryByTestId(`heatmap-hour-${BEST_HOUR}`)).toBeNull();

    fireEvent.click(toggle);

    // Wait for the heatmap to land alongside the timeseries sparkline.
    await screen.findByTestId("hour-heatmap");

    // All 24 cells render — one per hour — under their documented testIDs.
    for (let h = 0; h < 24; h++) {
      expect(screen.getByTestId(`heatmap-hour-${h}`)).toBeInTheDocument();
    }

    // The "best hour" cell is outlined in purple (#a855f7). React serialises
    // the inline style via the CSSOM, which may emit either the original
    // hex or `rgb(168, 85, 247)`, so accept both forms.
    const PURPLE = /(#a855f7|rgb\(168,\s*85,\s*247\))/;
    const bestCell = screen.getByTestId(`heatmap-hour-${BEST_HOUR}`);
    const bestStyle = (bestCell.getAttribute("style") ?? "").toLowerCase();
    expect(bestStyle).toMatch(PURPLE);

    // Every other cell must NOT pick up the purple highlight — otherwise a
    // regression that highlights *every* cell (or the wrong cell) would
    // pass silently. The non-best cells use `borderColor: 'transparent'`.
    for (let h = 0; h < 24; h++) {
      if (h === BEST_HOUR) continue;
      const s = (screen.getByTestId(`heatmap-hour-${h}`).getAttribute("style") ?? "").toLowerCase();
      expect(s).not.toMatch(PURPLE);
    }
  });

  it("fetches /engagement-hourly exactly once on first expand and re-uses the cache on subsequent toggles", async () => {
    installFetch({ hourly: makeHourly({ bestHour: 8 }) });
    render(<PortalHighlightsPage />);

    const toggle = await screen.findByTestId("btn-trend-77");

    // Lazy-load: no hourly fetch before the first toggle. The producer
    // shouldn't pay for the heatmap query until they actually expand the
    // trend panel — same contract as the timeseries.
    expect(hourlyCalls().length).toBe(0);

    fireEvent.click(toggle); // open (fetch #1)
    await screen.findByTestId("hour-heatmap");
    await waitFor(() => {
      const calls = hourlyCalls();
      expect(calls.length).toBe(1);
      expect(calls[0].url).toContain("/api/portal/highlights/77/engagement-hourly");
      expect(calls[0].url).toContain("days=7");
      // The web client also stamps the producer's local TZ offset onto the
      // request so the heatmap buckets honour their wall-clock hours.
      expect(calls[0].url).toContain("tzOffsetMinutes=");
    });

    fireEvent.click(toggle); // close
    await waitFor(() => expect(screen.queryByTestId("hour-heatmap")).toBeNull());

    fireEvent.click(toggle); // re-open — must hit the cache, not refetch
    await screen.findByTestId("hour-heatmap");

    // Give any stray request a tick to land before asserting we did NOT refetch.
    await new Promise(r => setTimeout(r, 0));
    expect(hourlyCalls().length).toBe(1);
  });
});
