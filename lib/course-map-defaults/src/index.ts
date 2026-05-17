// Shared course-mapper centre helpers (Task #1934).
//
// `DEFAULT_REMEMBERED_ZOOM` and `geometryCentroid` used to live as
// duplicate copies in two places that have to agree exactly:
//   - `artifacts/kharagolf-web/src/pages/course-mapper.tsx` (the in-house
//     mapper UI; persists a remembered centre after the first save on a
//     previously-blank course, see Task #1312)
//   - `artifacts/api-server/scripts/backfillCourseMapDefaults.ts` (the
//     one-shot backfill that fills the remembered centre for courses
//     whose geometry pre-dated #1312, see Task #1559)
//
// If anyone tweaks how the mapper picks a centre (e.g. switches polygon
// centroid to area-weighted, or changes the default zoom) the two copies
// would silently drift and admins would get a different reopen behaviour
// from the backfill than from a fresh save. Hoisting the helpers here is
// the standard monorepo pattern (see `@workspace/snap-to-fairway`).
//
// The module has zero React Native / DOM imports so it is safe to consume
// from the browser bundle and from a Node-side backfill alike.

// Default Leaflet zoom we fly to when a course has a remembered centre
// but no remembered zoom yet. The mapper UI also falls back to this when
// reopening a course that has lat/lng saved but `mapDefaultZoom` is null.
export const DEFAULT_REMEMBERED_ZOOM = 17;

// GeoJSON coordinate in [lng, lat] order (matches the on-disk format the
// `course_hole_geometry` table stores and what Leaflet's GeoJSON helpers
// produce/consume).
export type LngLat = [number, number];

// Geometry input accepted by `geometryCentroid`. Mirrors the union the
// `course_hole_geometry` schema allows:
//   - Polygon       (e.g. green / fairway outline)
//   - MultiPolygon  (e.g. fairway split by a hazard)
//   - LineString    (e.g. fairway centreline)
//   - Point         (e.g. green centre / front / back)
//
// Coordinates are typed as `unknown` so this type is assignable from both
// the mapper UI's narrowly-typed `GeoJsonGeom` union (no MultiPolygon,
// strict tuple coordinates) and the api-server's looser DB row shape
// (coordinates inferred as `unknown` after JSON parse).
export interface CentroidGeometry {
  type: "Polygon" | "MultiPolygon" | "LineString" | "Point";
  coordinates: unknown;
}

// Type-guard helpers — kept private so the public surface stays just
// `DEFAULT_REMEMBERED_ZOOM` and `geometryCentroid`.
function isFinitePair(p: unknown): p is LngLat {
  return (
    Array.isArray(p)
    && p.length >= 2
    && typeof p[0] === "number"
    && typeof p[1] === "number"
    && Number.isFinite(p[0])
    && Number.isFinite(p[1])
  );
}

// Compute the centroid of a single feature so the mapper can remember a
// sensible centre on the very first save for a previously-blank course
// and the backfill can derive one from existing geometry.
//
// Strategy (kept identical to the original mapper UI helper, with the
// MultiPolygon branch the backfill needed):
//   - Point        → the coordinate itself
//   - Polygon      → mean of outer-ring vertices, dropping the closing
//                    duplicate so it isn't double-counted
//   - LineString   → mean of all vertices
//   - MultiPolygon → mean across the outer ring of every polygon (closing
//                    duplicate dropped per ring), so the result stays
//                    weighted by ring vertex count exactly like the
//                    Polygon branch handles it.
//
// Returns `null` for empty / malformed geometries so callers can simply
// skip them rather than feed NaN into a stored centre.
export function geometryCentroid(g: CentroidGeometry): LngLat | null {
  if (g.type === "Point") {
    return isFinitePair(g.coordinates) ? [g.coordinates[0], g.coordinates[1]] : null;
  }

  const pts: LngLat[] = [];
  if (g.type === "Polygon") {
    const rings = g.coordinates as unknown;
    if (Array.isArray(rings) && Array.isArray(rings[0])) {
      // Drop the closing duplicate vertex so it isn't double-counted.
      const ring = (rings[0] as unknown[]).slice(0, -1);
      for (const p of ring) if (isFinitePair(p)) pts.push([p[0], p[1]]);
    }
  } else if (g.type === "LineString") {
    const line = g.coordinates as unknown;
    if (Array.isArray(line)) {
      for (const p of line) if (isFinitePair(p)) pts.push([p[0], p[1]]);
    }
  } else if (g.type === "MultiPolygon") {
    const polys = g.coordinates as unknown;
    if (Array.isArray(polys)) {
      for (const poly of polys) {
        if (!Array.isArray(poly) || !Array.isArray(poly[0])) continue;
        const ring = (poly[0] as unknown[]).slice(0, -1);
        for (const p of ring) if (isFinitePair(p)) pts.push([p[0], p[1]]);
      }
    }
  }

  if (pts.length === 0) return null;
  let lng = 0;
  let lat = 0;
  for (const [x, y] of pts) {
    lng += x;
    lat += y;
  }
  return [lng / pts.length, lat / pts.length];
}
