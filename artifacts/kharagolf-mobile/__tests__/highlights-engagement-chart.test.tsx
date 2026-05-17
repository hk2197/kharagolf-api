/**
 * Task #1185 — Mobile parity for the producer-facing highlights gallery's
 * engagement chart + lazy trend toggle.
 *
 * The web counterpart
 *   artifacts/kharagolf-web/src/pages/portal/__tests__/highlights-engagement-chart.test.tsx
 * already locks down the producer dashboard. The mobile highlights screen
 * renders the same compact 4-bar chart (`EngagementMiniChart`) and the
 * same lazy-loaded trend panel, but had no equivalent coverage — so a
 * future change to the mobile-side wiring could silently break the chart
 * for producers using the app. This test mirrors the web suite as closely
 * as React Native + jsdom allow:
 *
 *   1. The compact 4-bar chart renders one bar per event type
 *      (view / feed_share / share / download) with the right counts
 *      surfaced from the API payload.
 *   2. The trend panel is collapsed by default and the
 *      /engagement-timeseries endpoint is NOT hit on initial load (lazy).
 *   3. Tapping the trend toggle opens the panel and fires the timeseries
 *      fetch exactly once for the default 7-day window.
 *   4. Re-toggling the panel hits the in-memory cache instead of
 *      refetching — producers can flip it open/closed without spamming
 *      the API.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("expo-av", () => {
  const ReactInner = require("react") as typeof React;
  const Video = ReactInner.forwardRef((_props: unknown, _ref: unknown) =>
    ReactInner.createElement("div", { "data-testid": "stub-video" }),
  );
  return {
    Video,
    ResizeMode: { COVER: "cover", CONTAIN: "contain" },
  };
});

vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(_dir: string, name: string) { this.uri = `file:///cache/${name}`; }
    get exists() { return false; }
    delete() {}
    static downloadFileAsync = vi.fn(async (_remote: string, target: { uri: string }) => target);
  }
  return { File, Paths: { cache: "file:///cache" } };
});

vi.mock("expo-media-library", () => ({
  requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
  saveToLibraryAsync: vi.fn(async () => undefined),
  createAssetAsync: vi.fn(async () => ({ id: "asset-1" })),
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn(async () => true),
  shareAsync: vi.fn(async () => undefined),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "test-token", user: { id: 99 }, orgId: 42 }),
}));

vi.mock("@expo/vector-icons", () => {
  const Stub = (props: { name?: string }) =>
    React.createElement("span", { "data-icon": props?.name ?? "icon" });
  return { Feather: Stub, Ionicons: Stub, MaterialIcons: Stub };
});

import HighlightsScreen from "../app/highlights";

const REEL_ID = 77;

interface FetchCall { url: string; method: string }

let fetchCalls: FetchCall[];

function makeReel(overrides: Record<string, unknown> = {}) {
  return {
    id: REEL_ID,
    title: "Spring Open Highlights",
    templateId: "classic",
    status: "ready" as const,
    outputUrl: "/objects/reels/spring.mp4",
    outputObjectPath: null,
    feedPostId: null,
    durationSeconds: 32,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    organizationId: 42,
    tournamentId: null,
    options: {},
    attempts: 1,
    maxAttempts: 3,
    downloadCount: 4,
    shareCount: 2,
    viewCount: 17,
    feedShareCount: 5,
    bestHour: null,
    ...overrides,
  };
}

function makeTimeseries(days = 7) {
  const base = Date.now();
  return {
    reelId: REEL_ID,
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

function makeHourly(opts: { bestHour?: number | null } = {}) {
  const bestHour = opts.bestHour ?? null;
  return {
    reelId: REEL_ID,
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      download: 0,
      share: 0,
      view: hour === bestHour ? 12 : 1,
      feed_share: 0,
      // The API surfaces `total` already summed; keep the heatmap intensity
      // calculation honest by mirroring that here.
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

    if (url.includes("/portal/highlights/templates")) {
      return new Response(JSON.stringify({ templates: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/portal/my-tournaments")) {
      return new Response(JSON.stringify([]), {
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
    if (url.includes("/portal/highlights") && method === "GET") {
      // Top-level list endpoint.
      return new Response(JSON.stringify({
        reels,
        quota: { monthlyLimit: 9999, usedThisMonth: 0, remaining: 9999 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
  }) as typeof fetch;
}

const tsCalls = () => fetchCalls.filter(c => c.url.includes("/engagement-timeseries"));
const hourlyCalls = () => fetchCalls.filter(c => c.url.includes("/engagement-hourly"));

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Task #1185 — mobile engagement chart + lazy trend toggle", () => {
  it("renders the 4-bar engagement chart with one bar per event type and the right counts", async () => {
    installFetch();
    render(<HighlightsScreen />);

    // Wait for the reel card (and the chart inside it) to land.
    await screen.findByTestId(`engagement-chart-${REEL_ID}`);

    // One bar per event type, in the documented order.
    for (const key of ["view", "feed_share", "share", "download"]) {
      expect(screen.getByTestId(`bar-${key}-${REEL_ID}`)).toBeInTheDocument();
    }

    // The bar's leading number is the count surfaced by the API. We
    // assert per-bar so a refactor that swaps the keys would fail loudly.
    expect(screen.getByTestId(`bar-view-${REEL_ID}`).textContent).toContain("17");
    expect(screen.getByTestId(`bar-feed_share-${REEL_ID}`).textContent).toContain("5");
    expect(screen.getByTestId(`bar-share-${REEL_ID}`).textContent).toContain("2");
    expect(screen.getByTestId(`bar-download-${REEL_ID}`).textContent).toContain("4");

    // The trend panel must NOT be open and the timeseries must NOT have
    // been fetched on initial load — that's the whole point of the lazy
    // toggle.
    expect(screen.queryByTestId(`trend-panel-${REEL_ID}`)).toBeNull();
    expect(tsCalls().length).toBe(0);
  });

  it("tapping the trend toggle lazy-loads the timeseries and opens the trend panel", async () => {
    installFetch();
    render(<HighlightsScreen />);

    const toggle = await screen.findByTestId(`btn-trend-${REEL_ID}`);

    // Lazy-load: no timeseries fetch before the first toggle.
    expect(tsCalls().length).toBe(0);

    act(() => { fireEvent.click(toggle); });

    // Panel opens.
    const panel = await screen.findByTestId(`trend-panel-${REEL_ID}`);
    expect(panel).toBeInTheDocument();

    // …and the timeseries endpoint was hit exactly once for the default
    // 7-day window.
    await waitFor(() => {
      const ts = tsCalls();
      expect(ts.length).toBe(1);
      expect(ts[0].url).toContain(`/portal/highlights/${REEL_ID}/engagement-timeseries`);
      expect(ts[0].url).toContain("days=7");
    });
  });

  it("renders the 24-cell hour-of-day heatmap inside the trend panel and highlights only the best hour", async () => {
    // Task #1372 — without this assertion a future change to the
    // /engagement-hourly wiring (or the HourHeatmap render) could
    // silently stop drawing the heatmap or surface the wrong "best
    // hour" cell to producers.
    const BEST_HOUR = 19;
    installFetch({ hourly: makeHourly({ bestHour: BEST_HOUR }) });
    render(<HighlightsScreen />);

    const toggle = await screen.findByTestId(`btn-trend-${REEL_ID}`);

    // Heatmap is gated on the trend panel — it must NOT be in the DOM
    // before the producer expands the panel.
    expect(screen.queryByTestId("hour-heatmap")).toBeNull();
    expect(screen.queryByTestId(`heatmap-hour-${BEST_HOUR}`)).toBeNull();

    act(() => { fireEvent.click(toggle); });

    // Wait for the heatmap to land alongside the timeseries sparkline.
    await screen.findByTestId("hour-heatmap");

    // All 24 cells render — one per hour — under their documented testIDs.
    for (let h = 0; h < 24; h++) {
      const cell = screen.getByTestId(`heatmap-hour-${h}`);
      expect(cell).toBeInTheDocument();
    }

    // The "best hour" cell is outlined in purple (#a855f7). react-native-web
    // expands `borderColor` into the four per-side CSS props, and jsdom may
    // serialise the colour as either the original hex or rgb(168, 85, 247),
    // so we accept both forms on every side.
    const PURPLE = /(#a855f7|rgb\(168,\s*85,\s*247\))/;
    const bestCell = screen.getByTestId(`heatmap-hour-${BEST_HOUR}`);
    const bestStyle = (bestCell.getAttribute("style") ?? "").toLowerCase();
    for (const side of ["top", "right", "bottom", "left"] as const) {
      expect(bestStyle).toMatch(new RegExp(`border-${side}-color:\\s*${PURPLE.source}`));
    }

    // Every other cell must NOT pick up the purple highlight — otherwise
    // a regression that highlights *every* cell (or the wrong cell) would
    // pass silently.
    for (let h = 0; h < 24; h++) {
      if (h === BEST_HOUR) continue;
      const cell = screen.getByTestId(`heatmap-hour-${h}`);
      const s = (cell.getAttribute("style") ?? "").toLowerCase();
      expect(s).not.toMatch(PURPLE);
    }
  });

  it("fetches /engagement-hourly exactly once on first expand and re-uses the cache on subsequent toggles", async () => {
    installFetch({ hourly: makeHourly({ bestHour: 8 }) });
    render(<HighlightsScreen />);

    const toggle = await screen.findByTestId(`btn-trend-${REEL_ID}`);

    // Lazy-load: no hourly fetch before the first toggle. The producer
    // shouldn't pay for the heatmap query until they actually expand
    // the trend panel.
    expect(hourlyCalls().length).toBe(0);

    act(() => { fireEvent.click(toggle); }); // open (fetch #1)
    await screen.findByTestId("hour-heatmap");
    await waitFor(() => {
      const calls = hourlyCalls();
      expect(calls.length).toBe(1);
      expect(calls[0].url).toContain(`/portal/highlights/${REEL_ID}/engagement-hourly`);
      expect(calls[0].url).toContain("days=7");
    });

    act(() => { fireEvent.click(toggle); }); // close
    await waitFor(() => expect(screen.queryByTestId("hour-heatmap")).toBeNull());

    act(() => { fireEvent.click(toggle); }); // re-open — must hit the cache, not refetch
    await screen.findByTestId("hour-heatmap");

    // Give any stray request a tick to land before asserting we did NOT refetch.
    await new Promise(r => setTimeout(r, 0));
    expect(hourlyCalls().length).toBe(1);
  });

  it("re-toggling the trend panel hits the cache instead of refetching", async () => {
    installFetch();
    render(<HighlightsScreen />);

    const toggle = await screen.findByTestId(`btn-trend-${REEL_ID}`);

    act(() => { fireEvent.click(toggle); }); // open (fetch #1)
    await screen.findByTestId(`trend-panel-${REEL_ID}`);
    await waitFor(() => {
      expect(tsCalls().length).toBe(1);
    });

    act(() => { fireEvent.click(toggle); }); // close
    await waitFor(() => expect(screen.queryByTestId(`trend-panel-${REEL_ID}`)).toBeNull());

    act(() => { fireEvent.click(toggle); }); // re-open — must hit the cache, not refetch
    await screen.findByTestId(`trend-panel-${REEL_ID}`);

    // Give any stray request a tick to land.
    await new Promise(r => setTimeout(r, 0));
    expect(tsCalls().length).toBe(1);
  });
});
