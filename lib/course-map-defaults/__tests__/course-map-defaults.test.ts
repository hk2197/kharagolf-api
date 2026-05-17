/**
 * Unit test: shared course-mapper centre helpers (Task #1934).
 *
 * Pins the geometry-centroid arithmetic the mapper UI and the
 * `backfill:course-map-defaults` script both rely on, so a future tweak
 * to one branch (e.g. switching to area-weighted polygon centroids) is
 * caught before it can drift between the two callers.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_REMEMBERED_ZOOM,
  geometryCentroid,
} from "../src/index";

describe("DEFAULT_REMEMBERED_ZOOM", () => {
  it("is 17 (mapper UI's flyTo zoom for a remembered centre without a stored zoom)", () => {
    expect(DEFAULT_REMEMBERED_ZOOM).toBe(17);
  });
});

describe("geometryCentroid", () => {
  it("returns the coordinate itself for a Point", () => {
    expect(geometryCentroid({ type: "Point", coordinates: [-82.02, 33.5] })).toEqual([-82.02, 33.5]);
  });

  it("returns null for a Point with non-finite coordinates", () => {
    expect(geometryCentroid({ type: "Point", coordinates: [NaN, 33.5] })).toBeNull();
    expect(geometryCentroid({ type: "Point", coordinates: [] })).toBeNull();
  });

  it("averages outer-ring vertices for a Polygon, dropping the closing duplicate", () => {
    // Square with four distinct vertices around (33.505, -82.015).
    const c = geometryCentroid({
      type: "Polygon",
      coordinates: [[
        [-82.02, 33.5],
        [-82.01, 33.5],
        [-82.01, 33.51],
        [-82.02, 33.51],
        [-82.02, 33.5], // closing dup — must NOT be double-counted
      ]],
    });
    expect(c).not.toBeNull();
    expect(c![0]).toBeCloseTo(-82.015, 6);
    expect(c![1]).toBeCloseTo(33.505, 6);
  });

  it("averages all vertices for a LineString", () => {
    const c = geometryCentroid({
      type: "LineString",
      coordinates: [
        [-82.02, 33.5],
        [-82.0, 33.5],
        [-82.01, 33.52],
      ],
    });
    expect(c).not.toBeNull();
    expect(c![0]).toBeCloseTo((-82.02 + -82.0 + -82.01) / 3, 6);
    expect(c![1]).toBeCloseTo((33.5 + 33.5 + 33.52) / 3, 6);
  });

  it("averages across the outer ring of every polygon for a MultiPolygon", () => {
    // Two unit squares, one centred at (-82.015, 33.505) and one at
    // (-82.005, 33.505). Closing duplicate dropped per ring, weighted by
    // ring vertex count exactly like the Polygon branch — i.e. the eight
    // distinct vertices average to (-82.01, 33.505).
    const c = geometryCentroid({
      type: "MultiPolygon",
      coordinates: [
        [[
          [-82.02, 33.5],
          [-82.01, 33.5],
          [-82.01, 33.51],
          [-82.02, 33.51],
          [-82.02, 33.5],
        ]],
        [[
          [-82.01, 33.5],
          [-82.0, 33.5],
          [-82.0, 33.51],
          [-82.01, 33.51],
          [-82.01, 33.5],
        ]],
      ],
    });
    expect(c).not.toBeNull();
    expect(c![0]).toBeCloseTo(-82.01, 6);
    expect(c![1]).toBeCloseTo(33.505, 6);
  });

  it("returns null for an empty Polygon ring", () => {
    expect(
      geometryCentroid({ type: "Polygon", coordinates: [[]] }),
    ).toBeNull();
  });

  it("returns null for an empty LineString", () => {
    expect(
      geometryCentroid({ type: "LineString", coordinates: [] }),
    ).toBeNull();
  });

  it("returns null for an empty MultiPolygon", () => {
    expect(
      geometryCentroid({ type: "MultiPolygon", coordinates: [] }),
    ).toBeNull();
  });

  it("skips non-finite vertices instead of polluting the average", () => {
    const c = geometryCentroid({
      type: "Polygon",
      coordinates: [[
        [-82.02, 33.5],
        [Number.NaN, 33.5],
        [-82.01, 33.51],
        [-82.02, 33.51],
        [-82.02, 33.5],
      ]],
    });
    // Three valid vertices, NaN row dropped.
    expect(c).not.toBeNull();
    expect(c![0]).toBeCloseTo((-82.02 + -82.01 + -82.02) / 3, 6);
    expect(c![1]).toBeCloseTo((33.5 + 33.51 + 33.51) / 3, 6);
  });
});
