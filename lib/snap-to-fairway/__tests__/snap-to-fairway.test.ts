/**
 * Unit test: snap-to-fairway helpers (Task #1158 / #1322).
 *
 * The mobile and web apps used to each carry their own copy of these
 * helpers, with a sibling vitest file in each artifact. Task #1322 hoisted
 * the helpers into this shared package, so the two duplicate test files
 * have been collapsed into this single canonical suite. It exercises
 * `pointInRing`, `snapToFairway`, and the `findSnapTarget` priority rule
 * (green > hazard > fairway).
 */
import { describe, it, expect } from "vitest";
import {
  SNAP_THRESHOLD_M,
  pointInRing,
  snapToFairway,
  findSnapTarget,
  lieTypeForHazard,
  haversineMeters,
  metersToYards,
  bearingDeg,
  metersPerPixel,
} from "../src/index";

const LAT0 = 12.97;
const LAT1 = 12.971;
const LNG0 = 77.59;
const LNG1 = 77.591;

const COS_LAT = Math.cos((((LAT0 + LAT1) / 2) * Math.PI) / 180);
const M_PER_DEG_LNG = 111111 * COS_LAT;

const FAIRWAY = {
  holeNumber: 1,
  geometry: {
    type: "Polygon" as const,
    // GeoJSON ring: [lng, lat], closed.
    coordinates: [
      [
        [LNG0, LAT0],
        [LNG1, LAT0],
        [LNG1, LAT1],
        [LNG0, LAT1],
        [LNG0, LAT0],
      ],
    ],
  },
  label: "Fairway 1",
};

const INSIDE_LAT = (LAT0 + LAT1) / 2;
const INSIDE_LNG = (LNG0 + LNG1) / 2;

describe("snap-to-fairway helpers", () => {
  it("pointInRing detects a point inside the polygon", () => {
    const ring = (FAIRWAY.geometry.coordinates as [number, number][][])[0];
    expect(pointInRing(INSIDE_LNG, INSIDE_LAT, ring)).toBe(true);
    // Far-away point clearly outside the polygon.
    expect(pointInRing(LNG1 + 0.01, INSIDE_LAT, ring)).toBe(false);
  });

  it("snapToFairway keeps a drop inside the fairway in place", () => {
    const snap = snapToFairway(INSIDE_LAT, INSIDE_LNG, [FAIRWAY]);
    expect(snap).not.toBeNull();
    expect(snap!.label).toBe("Fairway 1");
    expect(snap!.lat).toBeCloseTo(INSIDE_LAT, 9);
    expect(snap!.lng).toBeCloseTo(INSIDE_LNG, 9);
  });

  it("snapToFairway pulls a near-miss (within 4 yds) onto the nearest edge", () => {
    // Sit ~2 m east of the east edge — well within the ~3.66 m threshold.
    const offsetM = 2;
    const lng = LNG1 + offsetM / M_PER_DEG_LNG;
    const lat = INSIDE_LAT;
    expect(offsetM).toBeLessThan(SNAP_THRESHOLD_M);

    const snap = snapToFairway(lat, lng, [FAIRWAY]);
    expect(snap).not.toBeNull();
    // Snapped lng should be the east edge (LNG1), lat unchanged.
    expect(snap!.lng).toBeCloseTo(LNG1, 9);
    expect(snap!.lat).toBeCloseTo(lat, 9);
  });

  it("snapToFairway ignores drops further than the snap threshold", () => {
    // 10 m east of the edge — too far to snap.
    const lng = LNG1 + 10 / M_PER_DEG_LNG;
    const snap = snapToFairway(INSIDE_LAT, lng, [FAIRWAY]);
    expect(snap).toBeNull();
  });

  it("findSnapTarget: a hazard match wins over an overlapping fairway match", () => {
    // Hazard sits inside the fairway polygon. The fallback rule says we must
    // still report the hazard (richer lie info), never the fairway.
    const hazard = {
      lat: INSIDE_LAT.toFixed(6),
      lng: INSIDE_LNG.toFixed(6),
      hazardType: "bunker",
      radiusMeters: 5,
      name: "Greenside Bunker",
    };
    const target = findSnapTarget(
      INSIDE_LAT,
      INSIDE_LNG,
      [hazard],
      [],
      [FAIRWAY],
    );
    expect(target).not.toBeNull();
    expect(target!.kind).toBe("hazard");
    expect(target!.lieType).toBe("Bunker");
    expect(target!.label).toBe("Greenside Bunker");
  });

  it("findSnapTarget: falls back to the fairway when no green/hazard matches", () => {
    const target = findSnapTarget(
      INSIDE_LAT,
      INSIDE_LNG,
      [],
      [],
      [FAIRWAY],
    );
    expect(target).not.toBeNull();
    expect(target!.kind).toBe("fairway");
    expect(target!.lieType).toBe("Fairway");
    expect(target!.label).toBe("Fairway 1");
  });

  it("lieTypeForHazard maps hazard types to scorecard lie labels", () => {
    expect(lieTypeForHazard("bunker")).toBe("Bunker");
    expect(lieTypeForHazard("water")).toBe("Hazard");
    expect(lieTypeForHazard("ob")).toBe("Hazard");
    expect(lieTypeForHazard("tree_line")).toBe("Rough");
    expect(lieTypeForHazard("unknown_type")).toBe("Rough");
  });
});

// ── Map math helpers (Task #1576) ──────────────────────────────────────────
describe("map math helpers", () => {
  it("haversineMeters: identical points are 0 m apart", () => {
    expect(haversineMeters(LAT0, LNG0, LAT0, LNG0)).toBeCloseTo(0, 6);
  });

  it("haversineMeters: 1 degree of latitude is ~111.195 km", () => {
    // Meridional arc length per degree on a 6371 km sphere ≈ 111195 m.
    const d = haversineMeters(0, 0, 1, 0);
    expect(d).toBeGreaterThan(111000);
    expect(d).toBeLessThan(111400);
  });

  it("haversineMeters: known-good distance — JFK → LAX ≈ 3970 km", () => {
    // Tolerance is ±10 km; great-circle distance for these well-known
    // airport coordinates is documented as 3,974 km.
    const jfkLat = 40.6413;
    const jfkLng = -73.7781;
    const laxLat = 33.9416;
    const laxLng = -118.4085;
    const m = haversineMeters(jfkLat, jfkLng, laxLat, laxLng);
    expect(m).toBeGreaterThan(3_960_000);
    expect(m).toBeLessThan(3_990_000);
  });

  it("metersToYards rounds 1 m to 1 yd and 100 m to 109 yds", () => {
    expect(metersToYards(0)).toBe(0);
    expect(metersToYards(1)).toBe(1);
    expect(metersToYards(100)).toBe(109);
  });

  it("bearingDeg: cardinal-direction sanity checks", () => {
    // Due north — destination directly above origin → 0°.
    expect(bearingDeg(0, 0, 1, 0)).toBeCloseTo(0, 6);
    // Due east at the equator → 90°.
    expect(bearingDeg(0, 0, 0, 1)).toBeCloseTo(90, 6);
    // Due south — destination directly below origin → 180°.
    expect(bearingDeg(1, 0, 0, 0)).toBeCloseTo(180, 6);
    // Due west at the equator → 270°.
    expect(bearingDeg(0, 1, 0, 0)).toBeCloseTo(270, 6);
  });

  it("metersPerPixel: equator zoom 0 ≈ 156543 m/px, halves per zoom level", () => {
    const eq0 = metersPerPixel(0, 0);
    expect(eq0).toBeCloseTo(156543.03392, 4);
    // Each zoom level doubles tile resolution, so m/px halves.
    expect(metersPerPixel(0, 1)).toBeCloseTo(eq0 / 2, 6);
    // Higher latitudes shrink (cos(lat) factor).
    expect(metersPerPixel(60, 0)).toBeCloseTo(eq0 * Math.cos(Math.PI / 3), 6);
  });
});
