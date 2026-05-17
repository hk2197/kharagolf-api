import { describe, it, expect } from "vitest";
import { offsetYardsToLatLng, recommend, fallbackClubStats } from "../lib/caddie";

const M_PER_YARD = 0.9144;
const M_PER_DEG_LAT = 111111;

describe("offsetYardsToLatLng", () => {
  it("places a +forward offset PAST the pin (north when bearing=0)", () => {
    const off = offsetYardsToLatLng(0, 10, 0, 0);
    // Pin at equator, bearing N → past pin = north → positive lat delta.
    expect(off.lat).toBeGreaterThan(0);
    expect(off.lng).toBeCloseTo(0, 6);
    expect(off.lat * M_PER_DEG_LAT).toBeCloseTo(10 * M_PER_YARD, 4);
  });

  it("places a -forward offset SHORT of the pin (south when bearing=0)", () => {
    const off = offsetYardsToLatLng(0, -10, 0, 0);
    expect(off.lat).toBeLessThan(0);
    expect(off.lng).toBeCloseTo(0, 6);
    expect(off.lat * M_PER_DEG_LAT).toBeCloseTo(-10 * M_PER_YARD, 4);
  });

  it("places a +lateral offset to the RIGHT of the player→pin axis", () => {
    // Bearing east (90°): right of east is south → negative lat.
    const off = offsetYardsToLatLng(0, 0, 10, 90);
    expect(off.lat).toBeLessThan(0);
    expect(off.lng).toBeCloseTo(0, 6);
  });

  it("bearing south, +forward goes south (negative lat)", () => {
    const off = offsetYardsToLatLng(0, 10, 0, 180);
    expect(off.lat).toBeLessThan(0);
  });

  it("bearing west, +lateral (right) goes north", () => {
    const off = offsetYardsToLatLng(0, 0, 10, 270);
    expect(off.lat).toBeGreaterThan(0);
  });
});

describe("recommend", () => {
  it("falls back to handicap-based clubs when no shot history", () => {
    const r = recommend({
      distanceYards: 150,
      clubStats: fallbackClubStats(18),
    });
    expect(r.usingFallback).toBe(true);
    expect(r.recommended).not.toBeNull();
    expect(r.rankedClubs.length).toBeGreaterThan(0);
  });

  it("biases tie-breaks toward the longer club", () => {
    const stats = [
      { club: "7 Iron", avgCarry: 150, stddevCarry: 8, shotCount: 10, source: "shots" as const },
      { club: "8 Iron", avgCarry: 140, stddevCarry: 8, shotCount: 10, source: "shots" as const },
    ];
    const r = recommend({ distanceYards: 145, clubStats: stats });
    expect(r.recommended?.club).toBe("7 Iron");
  });

  it("applies acceptance bias when override history is provided", () => {
    const stats = [
      { club: "7 Iron", avgCarry: 150, stddevCarry: 8, shotCount: 10, source: "shots" as const },
      { club: "6 Iron", avgCarry: 160, stddevCarry: 8, shotCount: 10, source: "shots" as const },
    ];
    const baseline = recommend({ distanceYards: 150, clubStats: stats });
    const personalised = recommend({
      distanceYards: 150,
      clubStats: stats,
      acceptanceByClub: { "7 Iron": 0.0, "6 Iron": 1.0 },
    });
    const baseline7 = baseline.rankedClubs.find(c => c.club === "7 Iron")!.onGreenProb;
    const personal7 = personalised.rankedClubs.find(c => c.club === "7 Iron")!.onGreenProb;
    expect(personal7).toBeLessThan(baseline7);
  });
});
