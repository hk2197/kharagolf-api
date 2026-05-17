import { describe, it, expect } from "vitest";
import { haversineMeters, computeGreenYardages } from "../courseGeometry";

describe("courseGeometry", () => {
  it("haversineMeters: same point is 0", () => {
    expect(haversineMeters({ lng: 0, lat: 0 }, { lng: 0, lat: 0 })).toBe(0);
  });

  it("haversineMeters: 1 deg lat ≈ 111 km", () => {
    const d = haversineMeters({ lng: 0, lat: 0 }, { lng: 0, lat: 1 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it("computeGreenYardages: returns sane front/center/back for a small green ~150yd away", () => {
    // Player ~150 yards south of green (~137 m). Green is a small
    // square ~25 yd across centred on (0, 0.001231) which is ~137 m
    // north of (0, 0). 25 yd ≈ 23 m ≈ 0.000206 deg lat.
    const player = { lng: 0, lat: 0 };
    const greenLat = 0.001231;
    const half = 0.000103;
    const green = {
      type: "Polygon" as const,
      coordinates: [[
        [-half, greenLat - half],
        [ half, greenLat - half],
        [ half, greenLat + half],
        [-half, greenLat + half],
        [-half, greenLat - half],
      ]],
    };
    const y = computeGreenYardages(player, green);
    expect(y).not.toBeNull();
    if (!y) return;
    // Sanity: ordering must be front <= center <= back.
    expect(y.front).toBeLessThanOrEqual(y.center);
    expect(y.center).toBeLessThanOrEqual(y.back);
    // Center should be roughly 150 yd; allow ±5 yd from spherical math.
    expect(y.center).toBeGreaterThan(140);
    expect(y.center).toBeLessThan(160);
  });

  it("computeGreenYardages: PlaysLike adds ~9% for +6m uphill", () => {
    const player = { lng: 0, lat: 0 };
    const green = {
      type: "Polygon" as const,
      coordinates: [[
        [-0.0001, 0.0012], [ 0.0001, 0.0012],
        [ 0.0001, 0.0014], [-0.0001, 0.0014], [-0.0001, 0.0012],
      ]],
    };
    const y = computeGreenYardages(player, green, { elevationDeltaMeters: 6 });
    expect(y).not.toBeNull();
    if (!y || y.centerPlaysLike == null) return;
    // 1 + 6 * 0.015 = 1.09 → 9% increase.
    expect(y.centerPlaysLike).toBeGreaterThan(y.center);
    const ratio = y.centerPlaysLike / y.center;
    expect(ratio).toBeGreaterThan(1.07);
    expect(ratio).toBeLessThan(1.11);
  });

  it("computeGreenYardages: returns null for an empty polygon", () => {
    const player = { lng: 0, lat: 0 };
    const green = { type: "Polygon" as const, coordinates: [] };
    expect(computeGreenYardages(player, green)).toBeNull();
  });
});
