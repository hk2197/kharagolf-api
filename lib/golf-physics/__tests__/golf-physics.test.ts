/**
 * Unit tests: shared plays-like yardage helpers (Task #1965).
 *
 * The mobile, web, watch, and api-server surfaces all converge on this
 * single module so they can never disagree on a coefficient. The cases
 * below pin down the four directions of drift that historically caused
 * confusion:
 *
 *   - headwind plays longer; tailwind plays shorter (and only at half
 *     strength, matching real-world ball flight)
 *   - uphill plays longer; downhill plays shorter (with the asymmetric
 *     0.7× downhill scaling)
 *   - rounding is to the nearest whole yard
 *   - missing factors contribute zero (so a watch caller passing only
 *     wind+elev gets the same number as a phone caller passing
 *     wind+elev+temp+alt with the temp/alt set to defaults).
 */
import { describe, it, expect } from "vitest";
import {
  computePlaysLike,
  playsLikeBreakdown,
  playsLikeYards,
} from "../src/index";

const RAW = 150;
const BEARING_NORTH = 0;

describe("computePlaysLike — wind", () => {
  it("treats wind blowing FROM the north as a headwind on a north-bound shot", () => {
    // Wind from north → blowing south. Player aims north → headwind.
    // Per the formula: 1 yd / 10 km/h / 100 yds → 20 km/h * 150 yds = 3 yds.
    const r = computePlaysLike({
      rawYards: RAW,
      bearingDeg: BEARING_NORTH,
      windSpeedKmh: 20,
      windDirDeg: 0,
    });
    expect(r.windAdj).toBe(3);
    expect(r.playsLikeYards).toBe(153);
  });

  it("treats wind blowing FROM the south as a tailwind (half effect)", () => {
    // Wind from south → blowing north. Player aims north → tailwind.
    // Tailwinds get 0.5× scaling: -20 km/h * (150/100) * 0.5 / (km/h per 10) = -1.5
    // Math.round(-1.5) === -1 in JavaScript (rounds half toward +∞).
    const r = computePlaysLike({
      rawYards: RAW,
      bearingDeg: BEARING_NORTH,
      windSpeedKmh: 20,
      windDirDeg: 180,
    });
    expect(r.windAdj).toBe(-1);
    // Final yardage uses the un-rounded contribution (150 + -1.5 = 148.5 → 149).
    expect(r.playsLikeYards).toBe(149);
  });

  it("contributes zero adjustment for a pure crosswind", () => {
    const r = computePlaysLike({
      rawYards: RAW,
      bearingDeg: BEARING_NORTH,
      windSpeedKmh: 30,
      windDirDeg: 90, // wind from the east, blowing west — perpendicular
    });
    // cos(90°) is exactly 0 in IEEE float terms after `-x * 0` we may get -0;
    // either signed zero is fine for the player-facing yardage.
    expect(Math.abs(r.windAdj)).toBe(0);
    expect(r.playsLikeYards).toBe(150);
  });

  it("omits the wind factor when bearing is missing", () => {
    const r = computePlaysLike({
      rawYards: RAW,
      windSpeedKmh: 20,
      windDirDeg: 0,
    });
    expect(r.windAdj).toBe(0);
    expect(r.playsLikeYards).toBe(150);
  });
});

describe("computePlaysLike — elevation", () => {
  it("rounds an uphill 5 m delta to +5 yds (1 m ≈ 1.09361 yds)", () => {
    const r = computePlaysLike({ rawYards: RAW, elevDiffMeters: 5 });
    expect(r.elevAdj).toBe(5); // 5 * 1.09361 = 5.47 → rounds to 5
    expect(r.playsLikeYards).toBe(155);
  });

  it("rounds a downhill 5 m delta to -4 yds (0.7× scaling)", () => {
    const r = computePlaysLike({ rawYards: RAW, elevDiffMeters: -5 });
    // -5 * 0.7 * 1.09361 = -3.83 → rounds to -4
    expect(r.elevAdj).toBe(-4);
    expect(r.playsLikeYards).toBe(146);
  });

  it("contributes zero when elevDiff is missing", () => {
    const r = computePlaysLike({ rawYards: RAW });
    expect(r.elevAdj).toBe(0);
    expect(r.playsLikeYards).toBe(150);
  });
});

describe("playsLikeBreakdown / playsLikeYards positional wrappers", () => {
  it("matches computePlaysLike when given the same inputs", () => {
    const positional = playsLikeBreakdown(RAW, 20, 0, BEARING_NORTH, 5);
    const object = computePlaysLike({
      rawYards: RAW,
      windSpeedKmh: 20,
      windDirDeg: 0,
      bearingDeg: BEARING_NORTH,
      elevDiffMeters: 5,
    });
    expect(positional).toEqual(object);
  });

  it("playsLikeYards returns just the headline number", () => {
    const yds = playsLikeYards(RAW, 20, 0, BEARING_NORTH, 5);
    expect(yds).toBe(playsLikeBreakdown(RAW, 20, 0, BEARING_NORTH, 5).playsLikeYards);
  });

  it("a watch-style caller (wind+elev only) and a phone-style caller (wind+elev+temp@21+alt=0) agree", () => {
    const watch = playsLikeBreakdown(RAW, 20, 0, BEARING_NORTH, 5);
    const phone = playsLikeBreakdown(RAW, 20, 0, BEARING_NORTH, 5, 21, 0);
    expect(watch.playsLikeYards).toBe(phone.playsLikeYards);
  });
});
