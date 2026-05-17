/**
 * Wave 1 W1-B — courseBundle util.
 *
 * Asserts the cache-first / 24h-TTL / offline-fallback contract that
 * `prefetchCourseBundle` honours when called at round start.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/utils/api", () => ({ BASE_URL: "https://example.test" }));

const memoryStore = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (k: string) => Promise.resolve(memoryStore.get(k) ?? null),
    setItem: (k: string, v: string) => { memoryStore.set(k, v); return Promise.resolve(); },
    removeItem: (k: string) => { memoryStore.delete(k); return Promise.resolve(); },
    getAllKeys: () => Promise.resolve(Array.from(memoryStore.keys())),
  },
}));

import {
  prefetchCourseBundle,
  loadCachedCourseBundle,
  loadCachedCourseBundleForRound,
  bundleToHazards,
  bundleToFairways,
  bundleToHolesResponse,
  COURSE_BUNDLE_KEY_PREFIX,
  COURSE_BUNDLE_TTL_MS,
} from "@/utils/courseBundle";

beforeEach(() => { memoryStore.clear(); });

const sampleBundle = {
  courseId: 99,
  course: { id: 99, name: "Test", organizationId: 7 },
  holes: [{ courseId: 99, holeNumber: 1, par: 4 }],
  geometry: [],
  roundContext: { tournamentId: 11, leagueId: null, generalPlayRoundId: null, aiCaddieMode: "open" as const },
  cachedAt: new Date().toISOString(),
};

describe("prefetchCourseBundle", () => {
  it("fetches the bundle and caches it under course_bundle_<courseId>", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => sampleBundle,
    } as Response));

    const out = await prefetchCourseBundle(7, 99, { token: "tkn", tournamentId: 11, fetcher });
    expect(out?.courseId).toBe(99);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = fetcher.mock.calls[0][0] as string;
    expect(url).toContain("/api/organizations/7/courses/99/bundle");
    expect(url).toContain("tournamentId=11");

    const cached = await loadCachedCourseBundle(99);
    expect(cached?.courseId).toBe(99);
  });

  it("skips the network on a fresh cache hit (within 24h TTL)", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => sampleBundle } as Response));
    await prefetchCourseBundle(7, 99, { token: "tkn", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Second call inside the TTL: no second fetch.
    await prefetchCourseBundle(7, 99, { token: "tkn", fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the cache passes the 24h TTL", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => sampleBundle } as Response));
    const t0 = 1_000_000;
    await prefetchCourseBundle(7, 99, { token: "tkn", fetcher, now: () => t0 });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await prefetchCourseBundle(7, 99, { token: "tkn", fetcher, now: () => t0 + COURSE_BUNDLE_TTL_MS + 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falls back to the cached copy when the network call fails", async () => {
    const okFetcher = vi.fn(async () => ({ ok: true, json: async () => sampleBundle } as Response));
    await prefetchCourseBundle(7, 99, { token: "tkn", fetcher: okFetcher });

    const failingFetcher = vi.fn(async () => { throw new Error("offline"); });
    const out = await prefetchCourseBundle(7, 99, {
      token: "tkn", fetcher: failingFetcher, forceRefresh: true,
    });
    expect(out?.courseId).toBe(99);
    expect(failingFetcher).toHaveBeenCalled();
  });
});

// Task #1160 — fallback helpers used by HoleMapSheet, CaddieCard, and the
// score screen when in-round network calls fail mid-round.
describe("loadCachedCourseBundleForRound", () => {
  it("returns the bundle whose roundContext matches the supplied tournamentId", async () => {
    const bundleA = {
      ...sampleBundle, courseId: 99,
      roundContext: { tournamentId: 11, leagueId: null, generalPlayRoundId: null, aiCaddieMode: "open" as const },
    };
    const bundleB = {
      ...sampleBundle, courseId: 100,
      roundContext: { tournamentId: 22, leagueId: null, generalPlayRoundId: null, aiCaddieMode: "open" as const },
    };
    memoryStore.set(`${COURSE_BUNDLE_KEY_PREFIX}99`, JSON.stringify({ fetchedAt: Date.now(), bundle: bundleA }));
    memoryStore.set(`${COURSE_BUNDLE_KEY_PREFIX}100`, JSON.stringify({ fetchedAt: Date.now(), bundle: bundleB }));

    const found = await loadCachedCourseBundleForRound({ tournamentId: 22 });
    expect(found?.courseId).toBe(100);
  });

  it("returns null when no cached bundle matches", async () => {
    memoryStore.set(`${COURSE_BUNDLE_KEY_PREFIX}99`, JSON.stringify({ fetchedAt: Date.now(), bundle: sampleBundle }));
    const found = await loadCachedCourseBundleForRound({ tournamentId: 9999 });
    expect(found).toBeNull();
  });
});

describe("bundleToHazards / bundleToFairways", () => {
  const polygonRing: [number, number][] = [
    [-100.0010, 40.0010],
    [-100.0000, 40.0010],
    [-100.0000, 40.0000],
    [-100.0010, 40.0000],
    [-100.0010, 40.0010],
  ];

  it("projects polygon water/bunker features into centroid + bounded radius", () => {
    const bundle = {
      ...sampleBundle,
      geometry: [
        {
          courseId: 99, holeNumber: 4, featureType: "hazard_water",
          geometry: { type: "Polygon", coordinates: [polygonRing] }, label: "Pond",
        },
        {
          courseId: 99, holeNumber: 7, featureType: "hazard_bunker",
          geometry: { type: "Point", coordinates: [-100.5, 40.5] }, label: null,
        },
        {
          courseId: 99, holeNumber: 1, featureType: "tee_box",
          geometry: { type: "Point", coordinates: [-100.6, 40.6] }, label: null,
        },
      ],
    };
    const hazards = bundleToHazards(bundle);
    // tee_box must be skipped (not a hazard).
    expect(hazards).toHaveLength(2);
    const water = hazards.find(h => h.hazardType === "water")!;
    expect(water.holeNumber).toBe(4);
    expect(water.name).toBe("Pond");
    expect(parseFloat(water.lat)).toBeCloseTo(40.0005, 3);
    expect(parseFloat(water.lng)).toBeCloseTo(-100.0005, 3);
    expect(water.radiusMeters!).toBeGreaterThan(0);
    const bunker = hazards.find(h => h.hazardType === "bunker")!;
    expect(bunker.holeNumber).toBe(7);
    // Single point falls back to a small fixed radius.
    expect(bunker.radiusMeters).toBe(5);
  });

  it("returns only fairway features in bundleToFairways", () => {
    const bundle = {
      ...sampleBundle,
      geometry: [
        {
          courseId: 99, holeNumber: 1, featureType: "fairway",
          geometry: { type: "Polygon", coordinates: [polygonRing] }, label: "Hole 1 fairway",
        },
        {
          courseId: 99, holeNumber: 1, featureType: "green",
          geometry: { type: "Polygon", coordinates: [polygonRing] }, label: null,
        },
      ],
    };
    const fairways = bundleToFairways(bundle);
    expect(fairways).toHaveLength(1);
    expect(fairways[0].holeNumber).toBe(1);
    expect(fairways[0].label).toBe("Hole 1 fairway");
    expect(fairways[0].geometry?.type).toBe("Polygon");
  });

  // Task #1333 — MultiPolygon hazards (split bunker complexes etc.) must
  // contribute every constituent ring to the centroid + bounding radius.
  it("projects MultiPolygon hazards using points from every ring", () => {
    const ringWest: [number, number][] = [
      [-100.0010, 40.0010],
      [-100.0000, 40.0010],
      [-100.0000, 40.0000],
      [-100.0010, 40.0000],
      [-100.0010, 40.0010],
    ];
    const ringEast: [number, number][] = [
      [-99.9990, 40.0010],
      [-99.9980, 40.0010],
      [-99.9980, 40.0000],
      [-99.9990, 40.0000],
      [-99.9990, 40.0010],
    ];
    const bundle = {
      ...sampleBundle,
      geometry: [
        {
          courseId: 99, holeNumber: 3, featureType: "hazard_bunker",
          geometry: { type: "MultiPolygon", coordinates: [[ringWest], [ringEast]] },
          label: "Twin bunkers",
        },
      ],
    };
    const hazards = bundleToHazards(bundle);
    expect(hazards).toHaveLength(1);
    const h = hazards[0];
    expect(h.hazardType).toBe("bunker");
    expect(h.holeNumber).toBe(3);
    expect(h.name).toBe("Twin bunkers");
    // Centroid sits between the two rings (around -99.9995, 40.0005).
    expect(parseFloat(h.lng)).toBeCloseTo(-99.9995, 3);
    expect(parseFloat(h.lat)).toBeCloseTo(40.0005, 3);
    // Bounding radius must reflect the wider footprint that spans both
    // rings, not just one. ~0.003 deg lng at 40°N ≈ 255m wide → radius
    // is at least the half-diagonal of that bbox.
    expect(h.radiusMeters).toBeGreaterThan(120);
  });

  // Task #1333 — exact centroid + bounded-radius math for a polygon hazard.
  // Pinning the numbers prevents silent regressions in the projection
  // helpers the offline hole map depends on.
  it("computes the centroid and bounding radius for a polygon hazard", () => {
    // Square ring spanning 0.0010°lng × 0.0010°lat, centred on (-100.0005, 40.0005).
    // mPerLat = 111111 → dy = 0.0010 * 111111 ≈ 111.11 m
    // mPerLng = 111111 * cos(40° * π/180) ≈ 85101.4 → dx ≈ 85.10 m
    // radius = sqrt(dx² + dy²) / 2 ≈ sqrt(85.10² + 111.11²) / 2 ≈ 70 m
    const ring: [number, number][] = [
      [-100.0010, 40.0010],
      [-100.0000, 40.0010],
      [-100.0000, 40.0000],
      [-100.0010, 40.0000],
      [-100.0010, 40.0010],
    ];
    const bundle = {
      ...sampleBundle,
      geometry: [
        {
          courseId: 99, holeNumber: 2, featureType: "hazard_oob",
          geometry: { type: "Polygon", coordinates: [ring] }, label: null,
        },
      ],
    };
    const [hz] = bundleToHazards(bundle);
    expect(hz.hazardType).toBe("ob");
    // The closing point of the ring is repeated (5 vertices for a square),
    // so the simple-average centroid is nudged 1/5 of an edge toward that
    // duplicated corner — (-100.0006, 40.0006) instead of the true centre.
    expect(parseFloat(hz.lat)).toBeCloseTo(40.0006, 4);
    expect(parseFloat(hz.lng)).toBeCloseTo(-100.0006, 4);
    // Bounding radius is computed off min/max so the duplication doesn't
    // shift it: half the bbox diagonal ≈ 70 m.
    expect(hz.radiusMeters).toBe(70);
  });

  // Task #1333 — bundleToFairways preserves the geometry payload as-is so
  // the snap-to-fairway logic can run against MultiPolygon courses.
  it("passes MultiPolygon fairway geometry through unchanged", () => {
    const ringA: [number, number][] = [
      [-100.0010, 40.0010],
      [-100.0000, 40.0010],
      [-100.0000, 40.0000],
      [-100.0010, 40.0000],
      [-100.0010, 40.0010],
    ];
    const ringB: [number, number][] = [
      [-99.9990, 40.0010],
      [-99.9980, 40.0010],
      [-99.9980, 40.0000],
      [-99.9990, 40.0000],
      [-99.9990, 40.0010],
    ];
    const multi = { type: "MultiPolygon", coordinates: [[ringA], [ringB]] };
    const bundle = {
      ...sampleBundle,
      geometry: [
        {
          courseId: 99, holeNumber: 5, featureType: "fairway",
          geometry: multi, label: "Hole 5 split fairway",
        },
      ],
    };
    const [fw] = bundleToFairways(bundle);
    expect(fw.geometry?.type).toBe("MultiPolygon");
    expect(fw.geometry?.coordinates).toEqual(multi.coordinates);
    expect(fw.label).toBe("Hole 5 split fairway");
    expect(fw.holeNumber).toBe(5);
  });

  it("preserves Point fairway geometry (centre marker)", () => {
    const bundle = {
      ...sampleBundle,
      geometry: [
        {
          courseId: 99, holeNumber: 6, featureType: "fairway",
          geometry: { type: "Point", coordinates: [-100.5, 40.5] }, label: null,
        },
      ],
    };
    const [fw] = bundleToFairways(bundle);
    expect(fw.geometry?.type).toBe("Point");
    expect(fw.geometry?.coordinates).toEqual([-100.5, 40.5]);
  });
});

describe("bundleToHolesResponse", () => {
  it("maps cached bundle holes into the HolesResponse shape the score screen expects", () => {
    const bundle = {
      ...sampleBundle,
      holes: [
        { courseId: 99, holeNumber: 1, par: 4, handicap: 7, yardageWhite: 380,
          greenCentreLat: "40.001", greenCentreLng: "-100.001" },
        { courseId: 99, holeNumber: 2, par: 5, yardageWhite: 510,
          greenCentreLat: "40.002", greenCentreLng: "-100.002" },
      ],
    };
    const projected = bundleToHolesResponse(bundle);
    expect(projected.courseId).toBe(99);
    expect(projected.organizationId).toBe(7);
    expect(projected.holes).toHaveLength(2);
    expect(projected.holes[0].par).toBe(4);
    expect(projected.holes[0].greenCentreLat).toBe("40.001");
    expect(projected.coursePar).toBe(9);
  });
});
