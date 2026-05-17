/**
 * Unit tests for `computePlaysLikeForHole` (Task #564).
 *
 * Covers the watch-side `PL` calculation that powers
 * `/api/portal/watch/hole-context` and the WS `hole_context` event:
 *
 *   - returns null when raw yardage or green coordinates are missing
 *   - applies headwind (+) and tailwind (-) adjustments along the shot line
 *   - accounts for uphill (+) and downhill (-) elevation between tee and green
 *   - omits the field (returns null) when EITHER weather OR elevation lookups fail
 *
 * Both `getWeather` and `fetchElevations` are mocked via `vi.hoisted` so the
 * suite never touches the live Open-Meteo / OpenWeatherMap endpoints.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const { getWeatherMock } = vi.hoisted(() => ({
  getWeatherMock: vi.fn(),
}));

vi.mock("../weather.js", () => ({
  getWeather: getWeatherMock,
}));

import { computePlaysLikeForHole } from "../playsLike.js";

// `fetchElevations` is defined in the same module as the unit under test, so
// a vi.mock partial override doesn't intercept the in-module call. Instead we
// stub the global `fetch` that `fetchElevations` itself uses, which exercises
// the real elevation parser end-to-end.
const realFetch = globalThis.fetch;
type ElevResponse = number[] | "error" | "throw";
const fetchElevationsMock = vi.fn<() => Promise<ElevResponse>>();

beforeAll(() => {
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("/v1/elevation")) {
      throw new Error(`Unexpected fetch in playsLike unit tests: ${url}`);
    }
    const next = await fetchElevationsMock();
    if (next === "throw") throw new Error("network error");
    if (next === "error") {
      return new Response("oops", { status: 500 });
    }
    return new Response(JSON.stringify({ elevation: next }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

// Player at the equator, green ~111 m due north → bearing ≈ 0°.
const PLAYER_LAT = 0;
const PLAYER_LNG = 0;
const GREEN_LAT = 0.001;
const GREEN_LNG = 0;

function mockWeatherOk(windSpeed: number, windDirection: number) {
  getWeatherMock.mockResolvedValue({
    temperature: 21,
    windSpeed,
    windDirection,
    precipitation: 0,
    weatherCode: 0,
    description: "Clear",
    humidity: 50,
    feelsLike: 21,
    alerts: [],
    source: "open-meteo",
  });
}

beforeEach(() => {
  getWeatherMock.mockReset();
  fetchElevationsMock.mockReset();
  // Default to a flat course so wind-only tests don't have to set elevation.
  fetchElevationsMock.mockResolvedValue([0, 0]);
});

describe("computePlaysLikeForHole — input validation", () => {
  it("returns null when rawYards is null", async () => {
    const result = await computePlaysLikeForHole({
      rawYards: null,
      greenLat: GREEN_LAT,
      greenLng: GREEN_LNG,
      playerLat: PLAYER_LAT,
      playerLng: PLAYER_LNG,
    });
    expect(result).toBeNull();
    // Short-circuits BEFORE touching the live weather / elevation services.
    expect(getWeatherMock).not.toHaveBeenCalled();
    expect(fetchElevationsMock).not.toHaveBeenCalled();
  });

  it("returns null when rawYards is undefined", async () => {
    const result = await computePlaysLikeForHole({
      rawYards: undefined,
      greenLat: GREEN_LAT,
      greenLng: GREEN_LNG,
      playerLat: PLAYER_LAT,
      playerLng: PLAYER_LNG,
    });
    expect(result).toBeNull();
    expect(getWeatherMock).not.toHaveBeenCalled();
  });

  it("returns null when rawYards is zero or negative", async () => {
    expect(
      await computePlaysLikeForHole({
        rawYards: 0,
        greenLat: GREEN_LAT,
        greenLng: GREEN_LNG,
        playerLat: PLAYER_LAT,
        playerLng: PLAYER_LNG,
      }),
    ).toBeNull();
    expect(
      await computePlaysLikeForHole({
        rawYards: -50,
        greenLat: GREEN_LAT,
        greenLng: GREEN_LNG,
        playerLat: PLAYER_LAT,
        playerLng: PLAYER_LNG,
      }),
    ).toBeNull();
    expect(getWeatherMock).not.toHaveBeenCalled();
  });

  it("returns null when greenLat is missing", async () => {
    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: null,
      greenLng: GREEN_LNG,
      playerLat: PLAYER_LAT,
      playerLng: PLAYER_LNG,
    });
    expect(result).toBeNull();
    expect(getWeatherMock).not.toHaveBeenCalled();
  });

  it("returns null when greenLng is missing", async () => {
    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: GREEN_LAT,
      greenLng: null,
      playerLat: PLAYER_LAT,
      playerLng: PLAYER_LNG,
    });
    expect(result).toBeNull();
    expect(getWeatherMock).not.toHaveBeenCalled();
  });

  it("returns null when neither player nor course coordinates are provided", async () => {
    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: GREEN_LAT,
      greenLng: GREEN_LNG,
    });
    expect(result).toBeNull();
    // No tee proxy → cannot even compute bearing, short-circuits before weather.
    expect(getWeatherMock).not.toHaveBeenCalled();
  });
});

describe("computePlaysLikeForHole — wind adjustments", () => {
  it("adds yardage for a headwind (wind FROM north on a north-bound shot)", async () => {
    // 20 km/h headwind on 150 yds → +(20/10) * (150/100) * 1.0 = +3 yds.
    // Flat course (no elevation diff) so the result is purely the wind delta.
    mockWeatherOk(20, 0);
    fetchElevationsMock.mockResolvedValue([100, 100]);

    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: GREEN_LAT,
      greenLng: GREEN_LNG,
      playerLat: PLAYER_LAT,
      playerLng: PLAYER_LNG,
    });
    expect(result).toBe(153);
  });

  it("subtracts yardage (with the 0.5x dampening) for a tailwind", async () => {
    // 20 km/h tailwind: -(20/10) * (150/100) * 0.5 = -1.5 → 150 - 1.5 = 148.5
    // JS Math.round rounds half toward +∞, so 148.5 → 149.
    mockWeatherOk(20, 180);
    fetchElevationsMock.mockResolvedValue([100, 100]);

    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: GREEN_LAT,
      greenLng: GREEN_LNG,
      playerLat: PLAYER_LAT,
      playerLng: PLAYER_LNG,
    });
    expect(result).toBe(149);
  });

  it("treats a perfectly perpendicular wind as ~zero net yardage", async () => {
    // 30 km/h wind FROM east (90°) blows west — perpendicular to a north shot.
    mockWeatherOk(30, 90);
    fetchElevationsMock.mockResolvedValue([100, 100]);

    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: GREEN_LAT,
      greenLng: GREEN_LNG,
      playerLat: PLAYER_LAT,
      playerLng: PLAYER_LNG,
    });
    expect(result).not.toBeNull();
    const yards = result!.playsLikeYards;
    // Should round to within 1 yd of the raw yardage.
    expect(Math.abs(yards - 150)).toBeLessThanOrEqual(1);
  });
});

describe("computePlaysLikeForHole — elevation adjustments", () => {
  it("adds full metres-to-yards conversion for an uphill green", async () => {
    // No wind, 10 m uphill → +10 * 1.09361 ≈ +10.94 → +11 yds (rounded).
    mockWeatherOk(0, 0);
    fetchElevationsMock.mockResolvedValue([100, 110]);

    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: GREEN_LAT,
      greenLng: GREEN_LNG,
      playerLat: PLAYER_LAT,
      playerLng: PLAYER_LNG,
    });
    expect(result).toBe(161);
  });

  it("subtracts a fraction of metres for a downhill green (0.7x)", async () => {
    // 10 m downhill → -10 * 0.7 * 1.09361 ≈ -7.66 → 150 - 7.66 = 142.34 → 142.
    mockWeatherOk(0, 0);
    fetchElevationsMock.mockResolvedValue([110, 100]);

    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: GREEN_LAT,
      greenLng: GREEN_LNG,
      playerLat: PLAYER_LAT,
      playerLng: PLAYER_LNG,
    });
    expect(result).toBe(142);
  });
});

describe("computePlaysLikeForHole — graceful degradation", () => {
  it("returns null when getWeather throws (provider down)", async () => {
    getWeatherMock.mockRejectedValue(new Error("weather provider down"));
    fetchElevationsMock.mockResolvedValue([100, 110]);

    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: GREEN_LAT,
      greenLng: GREEN_LNG,
      playerLat: PLAYER_LAT,
      playerLng: PLAYER_LNG,
    });
    expect(result).toBeNull();
  });

  it("returns null when weather payload lacks finite wind data", async () => {
    getWeatherMock.mockResolvedValue({
      temperature: 21,
      windSpeed: NaN,
      windDirection: NaN,
      precipitation: 0,
      weatherCode: 0,
      description: "",
      humidity: 50,
      feelsLike: 21,
      alerts: [],
      source: "open-meteo",
    });
    fetchElevationsMock.mockResolvedValue([100, 110]);

    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: GREEN_LAT,
      greenLng: GREEN_LNG,
      playerLat: PLAYER_LAT,
      playerLng: PLAYER_LNG,
    });
    expect(result).toBeNull();
  });

  it("returns null when elevation lookup fails (HTTP 500)", async () => {
    mockWeatherOk(20, 0);
    fetchElevationsMock.mockResolvedValue("error");

    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: GREEN_LAT,
      greenLng: GREEN_LNG,
      playerLat: PLAYER_LAT,
      playerLng: PLAYER_LNG,
    });
    expect(result).toBeNull();
  });

  it("returns null when both weather AND elevation fail", async () => {
    getWeatherMock.mockRejectedValue(new Error("weather provider down"));
    fetchElevationsMock.mockResolvedValue("throw");

    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: GREEN_LAT,
      greenLng: GREEN_LNG,
      playerLat: PLAYER_LAT,
      playerLng: PLAYER_LNG,
    });
    expect(result).toBeNull();
  });
});

describe("computePlaysLikeForHole — coordinate handling", () => {
  it("falls back to course centre when player coords are not provided", async () => {
    // 20 km/h headwind, flat course → +3 yds, same as the headwind unit test
    // above but with the tee proxy coming from courseLat/Lng instead of player.
    mockWeatherOk(20, 0);
    fetchElevationsMock.mockResolvedValue([100, 100]);

    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: GREEN_LAT,
      greenLng: GREEN_LNG,
      courseLat: PLAYER_LAT,
      courseLng: PLAYER_LNG,
    });
    expect(result).toBe(153);
  });

  it("accepts string coordinates (drizzle numeric columns return strings)", async () => {
    mockWeatherOk(0, 0);
    fetchElevationsMock.mockResolvedValue([100, 100]);

    const result = await computePlaysLikeForHole({
      rawYards: 150,
      greenLat: "0.001",
      greenLng: "0",
      playerLat: "0",
      playerLng: "0",
    });
    expect(result).toBe(150);
  });
});
