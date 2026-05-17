/**
 * Wave 1 W1-B — Course geometry math.
 *
 * Reads polygons stored in the Wave 0 `course_hole_geometry` table and
 * derives the "front / center / back of green" yardages a player needs
 * during a round, plus an optional PlaysLike adjustment for elevation
 * delta.
 *
 * Distance math is plain spherical (haversine). Greens at golf scale
 * (≤ 50 yd across) are well-modelled as flat, so we skip the WGS84
 * ellipsoid corrections; sub-yard error is below the GPS noise floor.
 */

export interface LngLat {
  lng: number;
  lat: number;
}

export type GeometryFeature = "green" | "fairway" | "hazard_water"
  | "hazard_bunker" | "hazard_oob" | "tee_box" | "cart_path";

export interface HoleGeometry {
  holeNumber: number;
  featureType: GeometryFeature;
  geometry: {
    type: "Polygon" | "LineString" | "Point" | "MultiPolygon";
    coordinates: unknown;
  };
}

const EARTH_RADIUS_M = 6_371_000;
const M_TO_YD = 1.09361;

function toRad(deg: number) { return (deg * Math.PI) / 180; }

/** Great-circle distance between two lng/lat points, in metres. */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(x)));
}

export function metersToYards(m: number) { return m * M_TO_YD; }

/**
 * Walk every vertex of a polygon (or multipolygon) and collect them as
 * flat `LngLat[]`. We use vertices (not edge interpolation) because at
 * golf scale a green polygon is small enough that the closest vertex
 * is within 1–2 yd of the closest edge point.
 */
function flattenPolygonVertices(geom: HoleGeometry["geometry"]): LngLat[] {
  const out: LngLat[] = [];
  const push = (rings: unknown) => {
    if (!Array.isArray(rings)) return;
    for (const ring of rings) {
      if (!Array.isArray(ring)) continue;
      for (const pt of ring) {
        if (Array.isArray(pt) && pt.length >= 2
            && typeof pt[0] === "number" && typeof pt[1] === "number") {
          out.push({ lng: pt[0], lat: pt[1] });
        }
      }
    }
  };
  if (geom.type === "Polygon") push(geom.coordinates);
  else if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
    for (const poly of geom.coordinates) push(poly);
  } else if (geom.type === "Point" && Array.isArray(geom.coordinates)) {
    const c = geom.coordinates as unknown[];
    if (c.length >= 2 && typeof c[0] === "number" && typeof c[1] === "number") {
      out.push({ lng: c[0] as number, lat: c[1] as number });
    }
  }
  return out;
}

export interface GreenYardages {
  front: number;
  center: number;
  back: number;
  /** PlaysLike-adjusted center (when elevationDeltaMeters provided). */
  centerPlaysLike?: number;
}

/**
 * Compute F/C/B-of-green yardages for a player's position relative to
 * a hole's green polygon. Uses the bearing from player → polygon
 * centroid as the front/back axis: the vertex with the smallest signed
 * along-axis distance is "front", the largest is "back", centroid is
 * "center".
 *
 * `elevationDeltaMeters` (target − player, positive = uphill) optionally
 * applies the conventional 1.5%-per-metre PlaysLike adjustment to the
 * centre yardage.
 */
export function computeGreenYardages(
  playerPos: LngLat,
  greenGeometry: HoleGeometry["geometry"],
  opts: { elevationDeltaMeters?: number } = {},
): GreenYardages | null {
  const verts = flattenPolygonVertices(greenGeometry);
  if (verts.length === 0) return null;

  // Centroid (simple average — sufficient for golf-green-sized polygons).
  const centroid: LngLat = {
    lng: verts.reduce((s, v) => s + v.lng, 0) / verts.length,
    lat: verts.reduce((s, v) => s + v.lat, 0) / verts.length,
  };

  // Bearing from player to centroid sets the depth axis.
  const bearingRad = Math.atan2(
    Math.sin(toRad(centroid.lng - playerPos.lng)) * Math.cos(toRad(centroid.lat)),
    Math.cos(toRad(playerPos.lat)) * Math.sin(toRad(centroid.lat))
      - Math.sin(toRad(playerPos.lat)) * Math.cos(toRad(centroid.lat))
        * Math.cos(toRad(centroid.lng - playerPos.lng)),
  );

  // For each vertex compute its distance from player and the signed
  // projection onto the depth axis. Smallest projection ≈ front edge,
  // largest ≈ back edge.
  let frontDist = Infinity;
  let backDist = -Infinity;
  for (const v of verts) {
    const d = haversineMeters(playerPos, v);
    const vBearing = Math.atan2(
      Math.sin(toRad(v.lng - playerPos.lng)) * Math.cos(toRad(v.lat)),
      Math.cos(toRad(playerPos.lat)) * Math.sin(toRad(v.lat))
        - Math.sin(toRad(playerPos.lat)) * Math.cos(toRad(v.lat))
          * Math.cos(toRad(v.lng - playerPos.lng)),
    );
    // Project onto depth axis: cos(angle between vertex bearing and centroid bearing) * d
    const projected = d * Math.cos(vBearing - bearingRad);
    if (projected < frontDist) frontDist = projected;
    if (projected > backDist) backDist = projected;
  }
  const centerDist = haversineMeters(playerPos, centroid);

  const result: GreenYardages = {
    front: Math.round(metersToYards(Math.max(0, frontDist))),
    center: Math.round(metersToYards(centerDist)),
    back: Math.round(metersToYards(Math.max(0, backDist))),
  };

  // PlaysLike: center * (1 + 1.5%-per-m elevation delta), clamped to ±25%.
  if (typeof opts.elevationDeltaMeters === "number") {
    const factor = Math.max(0.75, Math.min(1.25, 1 + opts.elevationDeltaMeters * 0.015));
    result.centerPlaysLike = Math.round(result.center * factor);
  }

  return result;
}
