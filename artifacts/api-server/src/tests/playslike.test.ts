/**
 * Tests for GET /api/public/playslike
 *
 * Covers Task #358's combined wind + elevation + temperature + altitude
 * "plays like" yardage. We pass weather/elevation explicitly so we never
 * touch the live Open-Meteo / OpenWeatherMap endpoints during tests.
 *
 * Reference physics (mirrors src/lib/playsLike.ts):
 *   - wind:    +1 yd / 10 km/h headwind / 100 yds, 0.5x for tailwind
 *   - elev:    +1.09361 yd / m uphill, 0.7x downhill
 *   - temp:    +2 yd per 10°C below 21°C, scaled by raw/100
 *   - alt:     -2% per 1000 m above sea level
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "./helpers.js";

const app = createTestApp();

// Belt-and-braces: fail loudly if any test path triggers an outbound HTTP call.
// Every scenario below supplies all weather/elevation factors explicitly, so
// the route's auto-fill branches must not fire. If the suite ever regresses
// (e.g. someone drops `altitudeMeters: 0`), this surfaces it immediately
// instead of flaking on a real network call.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
    throw new Error(
      `Unexpected outbound fetch in playslike tests: ${String(input)} — ` +
      `tests must supply weather/elev params explicitly.`,
    );
  });
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// Player at equator, target due north → bearing = 0°.
// Wind FROM south (180°) blows TOWARD north → tailwind for a north-bound shot.
const PLAYER = { lat: 0, lng: 0 };
const TARGET_NORTH = { lat: 0.001, lng: 0 }; // ~111 m north

function url(params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  return `/api/public/playslike?${qs}`;
}

describe("GET /api/public/playslike", () => {
  it("rejects requests without rawYards", async () => {
    const res = await request(app).get("/api/public/playslike");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rawYards/);
  });

  it("returns rawYards unchanged when no factors are supplied", async () => {
    const res = await request(app).get(url({ rawYards: 150 }));
    expect(res.status).toBe(200);
    expect(res.body.rawYards).toBe(150);
    expect(res.body.playsLikeYards).toBe(150);
    expect(res.body.windAdj).toBe(0);
    expect(res.body.elevAdj).toBe(0);
    expect(res.body.tempAdj).toBe(0);
    expect(res.body.altitudeAdj).toBe(0);
  });

  it("adds yardage for a pure headwind", async () => {
    // Target due north, wind FROM north (0°) → blows toward south → headwind.
    // All factors supplied explicitly so the route NEVER calls Open-Meteo /
    // OpenWeatherMap (auto-fill triggers only when a factor is null).
    const res = await request(app).get(url({
      lat: PLAYER.lat, lng: PLAYER.lng,
      targetLat: TARGET_NORTH.lat, targetLng: TARGET_NORTH.lng,
      rawYards: 150,
      windSpeedKmh: 20, windDirDeg: 0,
      temperatureC: 21, // neutral
      elevDiffMeters: 0, altitudeMeters: 0,
    }));
    expect(res.status).toBe(200);
    // 20 km/h headwind, 150 yds → +(20/10)*(150/100)*1.0 = +3
    expect(res.body.windAdj).toBe(3);
    expect(res.body.playsLikeYards).toBeGreaterThan(150);
  });

  it("subtracts yardage (with 0.5x factor) for a pure tailwind", async () => {
    // Wind FROM south (180°) → blows toward north → tailwind for north shot.
    const res = await request(app).get(url({
      lat: PLAYER.lat, lng: PLAYER.lng,
      targetLat: TARGET_NORTH.lat, targetLng: TARGET_NORTH.lng,
      rawYards: 150,
      windSpeedKmh: 20, windDirDeg: 180,
      temperatureC: 21,
      elevDiffMeters: 0, altitudeMeters: 0,
    }));
    expect(res.status).toBe(200);
    // -(20/10)*(150/100)*0.5 = -1.5 → rounded to -2 (Math.round half away)
    expect(res.body.windAdj).toBeLessThan(0);
    expect(res.body.playsLikeYards).toBeLessThan(150);
  });

  it("treats a perfectly perpendicular wind as ~zero net yardage", async () => {
    // Wind FROM east (90°) blows west → perpendicular to north shot.
    const res = await request(app).get(url({
      lat: PLAYER.lat, lng: PLAYER.lng,
      targetLat: TARGET_NORTH.lat, targetLng: TARGET_NORTH.lng,
      rawYards: 150,
      windSpeedKmh: 30, windDirDeg: 90,
      temperatureC: 21,
      elevDiffMeters: 0, altitudeMeters: 0,
    }));
    expect(res.status).toBe(200);
    expect(Math.abs(res.body.windAdj)).toBeLessThanOrEqual(1);
  });

  it("adds full uphill metres-to-yards for elevation gain", async () => {
    const res = await request(app).get(url({
      rawYards: 150,
      elevDiffMeters: 10, // 10 m uphill
      temperatureC: 21,
    }));
    expect(res.status).toBe(200);
    // +10 * 1.09361 ≈ +11
    expect(res.body.elevAdj).toBe(11);
    expect(res.body.playsLikeYards).toBe(150 + 11);
  });

  it("subtracts a fraction of metres for downhill (0.7x)", async () => {
    const res = await request(app).get(url({
      rawYards: 150,
      elevDiffMeters: -10,
      temperatureC: 21,
    }));
    expect(res.status).toBe(200);
    // -10 * 0.7 * 1.09361 ≈ -7.66 → rounded to -8
    expect(res.body.elevAdj).toBe(-8);
    expect(res.body.playsLikeYards).toBe(150 - 8);
  });

  it("plays longer in cool air (denser air shortens ball flight)", async () => {
    const res = await request(app).get(url({
      rawYards: 200,
      temperatureC: 5, // 16°C below standard
    }));
    expect(res.status).toBe(200);
    // (21-5)/10 * (200/100) * 2 = 6.4 → 6
    expect(res.body.tempAdj).toBe(6);
    expect(res.body.playsLikeYards).toBe(206);
  });

  it("plays shorter in hot air", async () => {
    const res = await request(app).get(url({
      rawYards: 200,
      temperatureC: 41,
    }));
    expect(res.status).toBe(200);
    // (21-41)/10 * 2 * 2 = -8
    expect(res.body.tempAdj).toBe(-8);
    expect(res.body.playsLikeYards).toBe(192);
  });

  it("plays shorter at high altitude (thinner air = ball flies further)", async () => {
    const res = await request(app).get(url({
      rawYards: 250,
      temperatureC: 21,
      altitudeMeters: 2000,
    }));
    expect(res.status).toBe(200);
    // -(2000/1000) * 0.02 * 250 = -10
    expect(res.body.altitudeAdj).toBe(-10);
    expect(res.body.playsLikeYards).toBe(240);
  });

  it("combines all four factors correctly", async () => {
    // Cold (5°C), uphill 5 m, headwind 15 km/h from north, altitude 1500 m.
    const res = await request(app).get(url({
      lat: PLAYER.lat, lng: PLAYER.lng,
      targetLat: TARGET_NORTH.lat, targetLng: TARGET_NORTH.lng,
      rawYards: 200,
      windSpeedKmh: 15, windDirDeg: 0,
      temperatureC: 5,
      elevDiffMeters: 5,
      altitudeMeters: 1500,
    }));
    // No factor was null → route did not call any external service.
    expect(res.status).toBe(200);
    // wind: (15/10)*(200/100)*1 = +3
    // elev: 5*1.09361 ≈ +5.47 → +5
    // temp: (16/10)*(200/100)*2 = +6.4 → +6
    // alt:  -(1500/1000)*0.02*200 = -6
    expect(res.body.windAdj).toBe(3);
    expect(res.body.elevAdj).toBe(5);
    expect(res.body.tempAdj).toBe(6);
    expect(res.body.altitudeAdj).toBe(-6);
    // Sum on the un-rounded numbers: 3 + 5.4681 + 6.4 + -6 ≈ 8.87 → 209
    expect(res.body.playsLikeYards).toBe(209);
  });

  it("tolerates negative altitude (e.g. coastal courses below sea level) by ignoring it", async () => {
    const res = await request(app).get(url({
      rawYards: 150,
      temperatureC: 21,
      altitudeMeters: -5,
    }));
    expect(res.status).toBe(200);
    expect(res.body.altitudeAdj).toBe(0);
    expect(res.body.playsLikeYards).toBe(150);
  });
});
