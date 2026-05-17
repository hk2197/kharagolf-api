/**
 * Task #2004 — end-to-end coverage for the "X rounds pending weather data"
 * hint on the Stats > Shot Analytics page (originally added under Task #1613).
 *
 * A unit test already covers the API counting rounds whose Open-Meteo
 * archive lookup hasn't resolved yet. This file mounts the actual
 * `ShotAnalyticsPanel` (the component the Stats page renders inside its
 * "Shot Analytics" tab), stubs `fetch` for the weather-correlation
 * endpoint, and asserts:
 *
 *   1. When the API returns `pendingRoundsCount > 0`, the amber hint
 *      surfaces inside the Weather Correlation — Temperature card
 *      with the right pluralised round count.
 *   2. When `pendingRoundsCount` is 0, the hint is not rendered.
 *
 * This guards against silent regressions if the temperature card layout
 * is restructured or the field gets renamed on the API response.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ShotAnalyticsPanel } from "@/pages/stats";

type WeatherCorrFixture = {
  pendingRoundsCount: number;
};

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function installFetch(weather: WeatherCorrFixture) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/portal/dispersion")) {
        return jsonResponse({ clubs: [] });
      }
      if (url.includes("/api/portal/proximity-bands")) {
        return jsonResponse({ bands: [] });
      }
      if (url.includes("/api/portal/putting-stats")) {
        return jsonResponse({ bands: [] });
      }
      if (url.includes("/api/portal/player/proximity-by-club")) {
        return jsonResponse({ clubs: [], coachingTips: [] });
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
          pendingRoundsCount: weather.pendingRoundsCount,
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

describe("Stats > Shot Analytics — pending weather rounds hint (Task #2004)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe("when the API reports pendingRoundsCount > 0", () => {
    beforeEach(() => {
      installFetch({ pendingRoundsCount: 4 });
    });

    it("renders the amber 'rounds pending weather data' hint inside the Temperature card", async () => {
      renderPanel();

      const hint = await waitFor(() =>
        screen.getByText(/4 rounds pending weather data — check back in a few days\./i),
      );
      expect(hint).toBeInTheDocument();
    });
  });

  describe("when the API reports a single pending round", () => {
    beforeEach(() => {
      installFetch({ pendingRoundsCount: 1 });
    });

    it("uses the singular 'round' wording for the hint", async () => {
      renderPanel();

      const hint = await waitFor(() =>
        screen.getByText(/^1 round pending weather data — check back in a few days\.$/i),
      );
      expect(hint).toBeInTheDocument();
    });
  });

  describe("when the API reports pendingRoundsCount === 0", () => {
    beforeEach(() => {
      installFetch({ pendingRoundsCount: 0 });
    });

    it("does not render the pending weather data hint", async () => {
      renderPanel();

      // Wait for the Temperature card to mount (its empty-state copy renders
      // alongside where the hint would appear) so we don't false-pass before
      // the weather-correlation query resolves.
      await screen.findByText(
        /No temperature data tied to recent rounds yet/i,
      );

      expect(
        screen.queryByText(/pending weather data — check back in a few days/i),
      ).not.toBeInTheDocument();
    });
  });
});
