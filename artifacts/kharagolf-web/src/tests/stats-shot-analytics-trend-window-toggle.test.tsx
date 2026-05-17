/**
 * Task #2041 — coverage for the 30d/60d/90d trend window toggle that lets
 * players choose how far back the "Work on This Club" trend annotation
 * looks. The Stats > Shot Analytics card renders a toggle next to the
 * heading; clicking it should:
 *
 *   1. Re-fetch /api/portal/player/proximity-by-club with the new `?days=`.
 *   2. Persist the selection to localStorage so the next mount restores it.
 *   3. Restore the persisted selection on the next mount (without the user
 *      having to pick it again).
 *
 * We mount the real ShotAnalyticsPanel and stub fetch so we can assert the
 * exact URL the panel hits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ShotAnalyticsPanel } from "@/pages/stats";

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function tipFixture(windowDays: number) {
  return {
    windowDays,
    clubs: [],
    coachingTips: [
      {
        club: "9i",
        clubKey: "9i",
        shots: 6,
        meanProximityFt: 90,
        tourMeanFt: 24,
        scratchMeanFt: 32,
        midHandicapMeanFt: 48,
        gapVsTourFt: 66,
        gapVsScratchFt: 58,
        practiceDistanceYards: 130,
        aimLongFt: 5,
        message: "You're 66 ft worse with the 9i — aim 5 ft long of pin.",
        caddieHint: "9i: aim 5 ft long",
        previousMeanProximityFt: 36,
        trendVsTourFt: 54,
        trendLabel: `+54.0 ft vs prev ${windowDays}d — slipping`,
      },
    ],
  };
}

function installFetch(seenUrls: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      seenUrls.push(url);
      if (url.includes("/api/portal/dispersion")) return jsonResponse({ clubs: [] });
      if (url.includes("/api/portal/proximity-bands")) return jsonResponse({ bands: [] });
      if (url.includes("/api/portal/putting-stats")) return jsonResponse({ bands: [] });
      if (url.includes("/api/portal/player/proximity-by-club")) {
        const m = url.match(/[?&]days=(\d+)/);
        const days = m ? parseInt(m[1], 10) : 30;
        return jsonResponse(tipFixture(days));
      }
      if (url.includes("/api/portal/player/weather-correlation")) {
        return jsonResponse({
          windowDays: 30,
          baselineSgTotal: null,
          baselineRoundCount: 0,
          windBuckets: [],
          temperatureBuckets: [],
          humidityBuckets: [],
          precipitationBuckets: [],
          temperatureAvailable: false,
          humidityAvailable: false,
          precipitationAvailable: false,
          pendingRoundsCount: 0,
          pendingWindRoundsCount: 0,
        });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch,
  );
}

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ShotAnalyticsPanel />
    </QueryClientProvider>,
  );
}

describe("ShotAnalyticsPanel — trend window toggle (Task #2041)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("defaults to 30d, hits ?days=30, and reflects the trend label", async () => {
    const seen: string[] = [];
    installFetch(seen);
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId("trend-window-toggle")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(seen.some(u => u.includes("/api/portal/player/proximity-by-club?days=30"))).toBe(true);
    });
    expect(screen.getByTestId("trend-window-30d")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("trend-window-60d")).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => {
      expect(screen.getByTestId("coaching-tip-trend-9i").textContent).toContain("prev 30d");
    });
  });

  it("re-fetches with ?days=60 when the 60d button is clicked, and persists the choice", async () => {
    const seen: string[] = [];
    installFetch(seen);
    renderPanel();

    // Wait for the panel to fetch + render the coaching tip card so the
    // toggle exists before we try to click it.
    const sixtyBtn = await screen.findByTestId("trend-window-60d");
    fireEvent.click(sixtyBtn);

    await waitFor(() => {
      expect(seen.some(u => u.includes("/api/portal/player/proximity-by-club?days=60"))).toBe(true);
    });
    expect(screen.getByTestId("trend-window-60d")).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("workOnThisClub.trendWindowDays")).toBe("60");
    await waitFor(() => {
      expect(screen.getByTestId("coaching-tip-trend-9i").textContent).toContain("prev 60d");
    });
  });

  it("restores the persisted window on the next mount (no user click required)", async () => {
    window.localStorage.setItem("workOnThisClub.trendWindowDays", "90");
    const seen: string[] = [];
    installFetch(seen);
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId("trend-window-toggle")).toBeInTheDocument();
    });
    expect(seen.some(u => u.includes("/api/portal/player/proximity-by-club?days=90"))).toBe(true);
    expect(screen.getByTestId("trend-window-90d")).toHaveAttribute("aria-pressed", "true");
    // proximity-by-club must NOT be hit with ?days=30 — the persisted choice
    // should win over the legacy default. (weather-correlation also hits
    // ?days=30, so we filter to the proximity endpoint specifically.)
    expect(seen.some(u =>
      u.includes("/api/portal/player/proximity-by-club") && /[?&]days=30(\b|&)/.test(u)
    )).toBe(false);
  });
});
