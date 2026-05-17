/**
 * UI test: Shot Analytics weather charts low-sample caption (Task #1609).
 *
 * Mounts <ShotAnalyticsPanel /> with a mocked weather-correlation response
 * containing buckets with mixed sample sizes (1, 5, 10 rounds). Asserts:
 *   - The "Limited sample (faded bars)" caption appears under each chart
 *     and lists the bucket(s) with fewer than 3 rounds.
 *   - When all buckets in a chart have >=3 rounds, no caption appears for
 *     that chart.
 *
 * The visual opacity change on the bars themselves is harder to assert
 * directly under jsdom (recharts SVG geometry isn't laid out), so we
 * cover it by exercising the same MIN_TRUSTWORTHY_ROUNDS threshold
 * through the caption rendering — both branches share the same predicate.
 *
 * Backend behaviour (which buckets exist, round counts, sgDelta values)
 * is not relevant here — the panel just trusts the API response shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ShotAnalyticsPanel } from "../stats";

interface WeatherBucket {
  label: string;
  min: number;
  max: number;
  rounds: number;
  meanSgTotal: number | null;
  sgDelta: number | null;
}

interface WeatherCorrResponse {
  windowDays: number;
  baselineSgTotal: number | null;
  baselineRoundCount: number;
  windBuckets: WeatherBucket[];
  temperatureBuckets: WeatherBucket[];
  humidityBuckets: WeatherBucket[];
  precipitationBuckets: WeatherBucket[];
  temperatureAvailable: boolean;
  humidityAvailable: boolean;
  precipitationAvailable: boolean;
}

function bucket(label: string, rounds: number, sgDelta: number | null = -0.5): WeatherBucket {
  return { label, min: 0, max: 1, rounds, meanSgTotal: -0.2, sgDelta };
}

function installFetch(weather: WeatherCorrResponse) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/portal/player/weather-correlation")) {
      return new Response(JSON.stringify(weather), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // Other panel queries — return empty so the panel renders without errors.
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ShotAnalyticsPanel />
    </QueryClientProvider>,
  );
}

const baseResponse: WeatherCorrResponse = {
  windowDays: 30,
  baselineSgTotal: 0.5,
  baselineRoundCount: 10,
  windBuckets: [bucket("Calm", 5), bucket("Breezy", 4), bucket("Windy", 1)],
  temperatureBuckets: [bucket("Cool", 6), bucket("Mild", 8), bucket("Warm", 2)],
  humidityBuckets: [bucket("Dry", 7), bucket("Muggy", 4), bucket("Humid", 1)],
  precipitationBuckets: [bucket("Dry", 8), bucket("Light", 2), bucket("Heavy", 1)],
  temperatureAvailable: true,
  humidityAvailable: true,
  precipitationAvailable: true,
};

describe("ShotAnalyticsPanel weather low-sample caption", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders a 'Limited sample' caption listing buckets with <3 rounds", async () => {
    installFetch(baseResponse);
    renderPanel();
    vi.useRealTimers();

    // Each of the four weather charts should produce its own caption.
    await waitFor(() => {
      const captions = screen.getAllByTestId("weather-limited-sample");
      expect(captions).toHaveLength(4);
    });

    const captionTexts = screen
      .getAllByTestId("weather-limited-sample")
      .map(el => el.textContent ?? "");

    // Wind chart — only "Windy" has 1 round.
    expect(captionTexts.some(t => t.includes("Windy (1 round)"))).toBe(true);
    // Temperature chart — only "Warm" has 2 rounds.
    expect(captionTexts.some(t => t.includes("Warm (2 rounds)"))).toBe(true);
    // Humidity chart — only "Humid" has 1 round.
    expect(captionTexts.some(t => t.includes("Humid (1 round)"))).toBe(true);
    // Rain chart — both "Light" (2 rounds) and "Heavy" (1 round) are below threshold.
    expect(
      captionTexts.some(t => t.includes("Light (2 rounds)") && t.includes("Heavy (1 round)")),
    ).toBe(true);
  });

  it("omits the caption for charts where every bucket has >= 3 rounds", async () => {
    installFetch({
      ...baseResponse,
      // Wind: every bucket has 3+ rounds → no caption expected for wind.
      windBuckets: [bucket("Calm", 5), bucket("Breezy", 4), bucket("Windy", 3)],
    });
    renderPanel();
    vi.useRealTimers();

    await waitFor(() => {
      const captions = screen.getAllByTestId("weather-limited-sample");
      // Temperature, humidity, precipitation still have low-sample buckets, but wind no longer does.
      expect(captions).toHaveLength(3);
    });

    const captionTexts = screen
      .getAllByTestId("weather-limited-sample")
      .map(el => el.textContent ?? "");

    // No caption should mention the wind bucket labels.
    expect(captionTexts.some(t => t.includes("Calm") || t.includes("Breezy") || t.includes("Windy"))).toBe(false);
  });
});
