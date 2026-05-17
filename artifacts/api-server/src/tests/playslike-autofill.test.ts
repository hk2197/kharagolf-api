/**
 * Tests for the auto-fill branch of GET /api/public/playslike.
 *
 * The route falls back to live weather (getWeather) and Open-Meteo elevation
 * (fetchElevations) when the caller omits those params. The main playslike
 * suite supplies every factor explicitly, so this branch was previously
 * uncovered. Here we mock both helpers to:
 *   1. verify the route invokes them when only lat/lng/target/rawYards are
 *      supplied, and folds the returned values into the breakdown
 *   2. verify the route still returns a sensible (raw == playsLike) breakdown
 *      when the helpers fail (graceful degradation)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getWeatherMock, fetchElevationsMock } = vi.hoisted(() => ({
  getWeatherMock: vi.fn(),
  fetchElevationsMock: vi.fn(),
}));

vi.mock("../lib/weather.js", () => ({
  getWeather: getWeatherMock,
}));

vi.mock("../lib/playsLike.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/playsLike.js")>(
    "../lib/playsLike.js",
  );
  return {
    ...actual,
    fetchElevations: fetchElevationsMock,
  };
});

import request from "supertest";
import { createTestApp } from "./helpers.js";

const app = createTestApp();

// Player at equator, target ~111 m due north → bearing ≈ 0°.
const PLAYER = { lat: 0, lng: 0 };
const TARGET = { lat: 0.001, lng: 0 };

function url(params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  return `/api/public/playslike?${qs}`;
}

beforeEach(() => {
  getWeatherMock.mockReset();
  fetchElevationsMock.mockReset();
});

describe("GET /api/public/playslike — weather/elevation auto-fill", () => {
  it("calls getWeather + fetchElevations when only lat/lng/target/rawYards are supplied", async () => {
    // 20 km/h wind FROM north → headwind on a north-bound shot.
    getWeatherMock.mockResolvedValueOnce({
      temperature: 21,
      windSpeed: 20,
      windDirection: 0,
      precipitation: 0,
      weatherCode: 0,
      description: "Clear",
      humidity: 50,
      feelsLike: 21,
      alerts: [],
      source: "open-meteo",
    });
    // Player at 100 m, green at 110 m → +10 m uphill.
    fetchElevationsMock.mockResolvedValueOnce([100, 110]);

    const res = await request(app).get(url({
      lat: PLAYER.lat, lng: PLAYER.lng,
      targetLat: TARGET.lat, targetLng: TARGET.lng,
      rawYards: 150,
    }));

    expect(res.status).toBe(200);
    expect(getWeatherMock).toHaveBeenCalledTimes(1);
    expect(getWeatherMock).toHaveBeenCalledWith(PLAYER.lat, PLAYER.lng);
    expect(fetchElevationsMock).toHaveBeenCalledTimes(1);
    expect(fetchElevationsMock).toHaveBeenCalledWith([
      { lat: PLAYER.lat, lng: PLAYER.lng },
      { lat: TARGET.lat, lng: TARGET.lng },
    ]);

    // Wind: (20/10)*(150/100)*1.0 = +3
    expect(res.body.windAdj).toBe(3);
    // Elev: +10 * 1.09361 ≈ +11
    expect(res.body.elevAdj).toBe(11);
    // Temp at 21°C → neutral
    expect(res.body.tempAdj).toBe(0);
    // Altitude 100 m → -(100/1000)*0.02*150 = -0.3 → 0 after Math.round
    expect(res.body.altitudeAdj).toBe(0);
    expect(res.body.playsLikeYards).toBe(150 + 3 + 11);
  });

  it("returns a sensible breakdown when getWeather and fetchElevations both fail", async () => {
    getWeatherMock.mockRejectedValueOnce(new Error("weather provider down"));
    fetchElevationsMock.mockResolvedValueOnce(null);

    const res = await request(app).get(url({
      lat: PLAYER.lat, lng: PLAYER.lng,
      targetLat: TARGET.lat, targetLng: TARGET.lng,
      rawYards: 150,
    }));

    expect(res.status).toBe(200);
    expect(getWeatherMock).toHaveBeenCalledTimes(1);
    expect(fetchElevationsMock).toHaveBeenCalledTimes(1);

    // No factors could be filled → every adjustment is zero and the route
    // still returns the raw yardage rather than 5xx-ing or omitting fields.
    expect(res.body.rawYards).toBe(150);
    expect(res.body.playsLikeYards).toBe(150);
    expect(res.body.windAdj).toBe(0);
    expect(res.body.elevAdj).toBe(0);
    expect(res.body.tempAdj).toBe(0);
    expect(res.body.altitudeAdj).toBe(0);
  });
});
