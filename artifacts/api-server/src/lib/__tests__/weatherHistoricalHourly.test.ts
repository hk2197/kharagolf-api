/**
 * Unit tests for `getHistoricalHourlyWeather` (Task #1608).
 *
 * Verifies the helper used by the caddie-recommendation weather backfill:
 *   - parses Open-Meteo's hourly archive response and returns the
 *     observation matching the requested UTC hour
 *   - reuses the per-day cache so multiple calls for the same
 *     (lat, lng, date) only fetch once
 *   - returns nulls when the archive returns no data, when the hour is
 *     missing from the response, and when the network call fails
 *
 * `fetch` is stubbed via `vi.spyOn(globalThis, "fetch")` so the suite never
 * touches the real archive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getHistoricalHourlyWeather } from "../weather.js";

interface ArchivePayload {
  hourly?: {
    time?: string[];
    relative_humidity_2m?: (number | null)[];
    precipitation?: (number | null)[];
  };
}

function mockFetchOk(payload: ArchivePayload): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response);
}

function buildHours(humidity: (number | null)[], precipitation: (number | null)[]): ArchivePayload {
  // 24-hour day starting at "2024-04-12T00:00".
  const time: string[] = [];
  for (let h = 0; h < 24; h++) {
    time.push(`2024-04-12T${String(h).padStart(2, "0")}:00`);
  }
  return { hourly: { time, relative_humidity_2m: humidity, precipitation } };
}

describe("getHistoricalHourlyWeather", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the observation matching the requested UTC hour", async () => {
    const hum = Array.from({ length: 24 }, (_, h) => 50 + h);    // 50..73
    const prc = Array.from({ length: 24 }, (_, h) => h * 0.1);   // 0.0..2.3
    const fetchMock = mockFetchOk(buildHours(hum, prc));

    // Use a unique lat/lng per test so the in-module cache doesn't bleed
    // across cases (caches keep entries for 24h between tests).
    const at = new Date(Date.UTC(2024, 3, 12, 14, 30, 0));
    const obs = await getHistoricalHourlyWeather(11.11, 22.22, at);

    expect(obs.humidity).toBe(64);          // hour 14 → 50 + 14
    expect(obs.precipitation).toBeCloseTo(1.4, 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("archive-api.open-meteo.com");
    expect(url).toContain("hourly=relative_humidity_2m,precipitation");
    expect(url).toContain("timezone=UTC");
    expect(url).toContain("start_date=2024-04-12");
    expect(url).toContain("end_date=2024-04-12");
  });

  it("caches per (lat, lng, date) so a second hour lookup reuses the fetch", async () => {
    const hum = Array.from({ length: 24 }, () => 70);
    const prc = Array.from({ length: 24 }, () => 0.5);
    const fetchMock = mockFetchOk(buildHours(hum, prc));

    const at1 = new Date(Date.UTC(2024, 3, 12,  9, 0, 0));
    const at2 = new Date(Date.UTC(2024, 3, 12, 17, 0, 0));
    const a = await getHistoricalHourlyWeather(33.33, 44.44, at1);
    const b = await getHistoricalHourlyWeather(33.33, 44.44, at2);

    expect(a.humidity).toBe(70);
    expect(b.humidity).toBe(70);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns nulls when the archive responds without data for that hour", async () => {
    const hum = Array.from({ length: 24 }, () => null);
    const prc = Array.from({ length: 24 }, () => null);
    mockFetchOk(buildHours(hum, prc));

    const at = new Date(Date.UTC(2024, 3, 12, 8, 0, 0));
    const obs = await getHistoricalHourlyWeather(55.55, 66.66, at);

    expect(obs.humidity).toBeNull();
    expect(obs.precipitation).toBeNull();
  });

  it("returns nulls when the response omits the requested hour entirely", async () => {
    // Only first 6 hours present, but we ask for hour 18.
    const payload: ArchivePayload = {
      hourly: {
        time: Array.from({ length: 6 }, (_, h) => `2024-04-12T${String(h).padStart(2, "0")}:00`),
        relative_humidity_2m: [60, 61, 62, 63, 64, 65],
        precipitation: [0, 0, 0, 0, 0, 0],
      },
    };
    mockFetchOk(payload);

    const at = new Date(Date.UTC(2024, 3, 12, 18, 0, 0));
    const obs = await getHistoricalHourlyWeather(77.77, 88.88, at);

    expect(obs.humidity).toBeNull();
    expect(obs.precipitation).toBeNull();
  });

  it("swallows fetch failures and returns nulls", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));

    const at = new Date(Date.UTC(2024, 3, 13, 12, 0, 0));
    const obs = await getHistoricalHourlyWeather(99.11, 12.34, at);

    expect(obs.humidity).toBeNull();
    expect(obs.precipitation).toBeNull();
  });

  it("returns nulls when the archive responds with !ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as unknown as Response);

    const at = new Date(Date.UTC(2024, 3, 14, 6, 0, 0));
    const obs = await getHistoricalHourlyWeather(13.57, 24.68, at);

    expect(obs.humidity).toBeNull();
    expect(obs.precipitation).toBeNull();
  });
});
