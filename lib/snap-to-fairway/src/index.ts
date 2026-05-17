// Snap-to-feature helpers (Task #858 / #999 / #1322).
//
// When a player drags a shot marker close to a known feature (green
// centre/front/back, a hazard polygon, or a fairway outline/centreline),
// snap the drop to that feature and pre-fill the matching `lieType`.
//
// These helpers used to live in two duplicate copies inside
// `artifacts/kharagolf-mobile/components/HoleMapSheet.tsx` and
// `artifacts/kharagolf-web/src/components/HoleMapPanel.tsx`. They are now
// hoisted into this shared package so mobile and web can never drift in
// behaviour again. The module has zero React Native / DOM imports so it can
// be consumed safely from either runtime.

const SNAP_THRESHOLD_YARDS = 4;
export const SNAP_THRESHOLD_M = SNAP_THRESHOLD_YARDS * 0.9144;

// ── Map math helpers ────────────────────────────────────────────────────────
//
// These four pure helpers (`haversineMeters`, `metersToYards`, `bearingDeg`,
// `metersPerPixel`) used to be duplicated inside `HoleMapSheet.tsx` (mobile)
// and `HoleMapPanel.tsx` (web). Task #1576 hoisted them here so the two
// apps can never drift on geometry constants again. They have zero React
// Native / DOM imports, so both runtimes can consume them safely.

// Great-circle distance in metres between two lat/lng points.
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Round metres to whole yards (1 m ≈ 1.09361 yds).
export function metersToYards(m: number): number {
  return Math.round(m * 1.09361);
}

// Initial bearing from point 1 to point 2, in degrees (0 = N, 90 = E).
export function bearingDeg(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
) {
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const la1 = (lat1 * Math.PI) / 180;
  const la2 = (lat2 * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x =
    Math.cos(la1) * Math.sin(la2) -
    Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Web Mercator metres-per-pixel at a given latitude and tile zoom level.
// Uses the standard Web Mercator equator constant (156543.03392).
export function metersPerPixel(lat: number, zoom: number) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

// Map a hazard's `hazardType` string to the lie label the scorecard expects.
export function lieTypeForHazard(hzType: string): string {
  switch (hzType) {
    case "bunker":
      return "Bunker";
    case "water":
      return "Hazard";
    case "ob":
      return "Hazard";
    case "tree_line":
      return "Rough";
    default:
      return "Rough";
  }
}

export interface SnapTarget {
  lat: number;
  lng: number;
  lieType: string;
  label: string;
  kind: "green" | "hazard" | "fairway";
}

export interface SnapCandidateGreen {
  lat: number;
  lng: number;
  label: string;
}

// Hazard input matches the row shape the apps already pass in (lat/lng come
// from the DB as strings).
export interface SnapHazardInput {
  lat: string;
  lng: string;
  hazardType: string;
  radiusMeters: number | null;
  name: string | null;
}

// Fairway geometry — sourced from `course_hole_geometry` (Task #999). Each
// row is a GeoJSON Polygon / MultiPolygon (fairway outline) or LineString
// (fairway centreline). Coordinates use GeoJSON order: [lng, lat].
export interface FairwayInfo {
  holeNumber: number;
  geometry: {
    type: "Polygon" | "MultiPolygon" | "LineString" | "Point";
    coordinates: unknown;
  } | null;
  label?: string | null;
}

// Ray-casting point-in-polygon (lng/lat degree space — fine at fairway scale).
export function pointInRing(
  lng: number,
  lat: number,
  ring: [number, number][],
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Closest point on segment a→b to (lat,lng), worked in local metres so the
// returned distance is metres for a SNAP_THRESHOLD_M comparison.
export function closestPointOnSegmentM(
  lat: number,
  lng: number,
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
  cosLat: number,
): { lat: number; lng: number; distM: number } {
  const mLat = 111111;
  const mLng = 111111 * cosLat;
  const px = (lng - aLng) * mLng;
  const py = (lat - aLat) * mLat;
  const bx = (bLng - aLng) * mLng;
  const by = (bLat - aLat) * mLat;
  const len2 = bx * bx + by * by;
  let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = bx * t;
  const cy = by * t;
  const dx = px - cx;
  const dy = py - cy;
  return {
    lat: aLat + cy / mLat,
    lng: aLng + cx / mLng,
    distM: Math.sqrt(dx * dx + dy * dy),
  };
}

export function snapToFairway(
  lat: number,
  lng: number,
  fairways: FairwayInfo[],
): { lat: number; lng: number; label: string } | null {
  let best: { lat: number; lng: number; label: string; dist: number } | null = null;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  for (const fw of fairways) {
    const g = fw.geometry;
    if (!g || !g.coordinates) continue;
    const label = fw.label ?? "Fairway";
    const rings: [number, number][][] = [];
    const lines: [number, number][][] = [];
    if (g.type === "Polygon") {
      const c = g.coordinates as [number, number][][];
      if (Array.isArray(c) && c.length > 0 && Array.isArray(c[0])) rings.push(c[0]);
    } else if (g.type === "MultiPolygon") {
      const c = g.coordinates as [number, number][][][];
      if (Array.isArray(c)) {
        for (const poly of c) {
          if (Array.isArray(poly) && poly.length > 0 && Array.isArray(poly[0]))
            rings.push(poly[0]);
        }
      }
    } else if (g.type === "LineString") {
      const c = g.coordinates as [number, number][];
      if (Array.isArray(c)) lines.push(c);
    }
    for (const ring of rings) {
      if (ring.length < 3) continue;
      if (pointInRing(lng, lat, ring)) {
        // Inside the polygon — keep the drop where it is, distance 0.
        if (!best || best.dist > 0) best = { lat, lng, label, dist: 0 };
        continue;
      }
      for (let i = 0; i < ring.length - 1; i++) {
        const [aLng, aLat] = ring[i];
        const [bLng, bLat] = ring[i + 1];
        const c = closestPointOnSegmentM(lat, lng, aLat, aLng, bLat, bLng, cosLat);
        if (c.distM <= SNAP_THRESHOLD_M && (!best || c.distM < best.dist)) {
          best = { lat: c.lat, lng: c.lng, label, dist: c.distM };
        }
      }
    }
    for (const line of lines) {
      if (line.length < 2) continue;
      for (let i = 0; i < line.length - 1; i++) {
        const [aLng, aLat] = line[i];
        const [bLng, bLat] = line[i + 1];
        const c = closestPointOnSegmentM(lat, lng, aLat, aLng, bLat, bLng, cosLat);
        if (c.distM <= SNAP_THRESHOLD_M && (!best || c.distM < best.dist)) {
          best = { lat: c.lat, lng: c.lng, label, dist: c.distM };
        }
      }
    }
  }
  return best;
}

export function findSnapTarget(
  lat: number,
  lng: number,
  hazards: SnapHazardInput[],
  greenPoints: SnapCandidateGreen[],
  fairways: FairwayInfo[] = [],
): SnapTarget | null {
  let best: { target: SnapTarget; rank: number } | null = null;
  // Green centre/front/back: simple radial threshold.
  for (const gp of greenPoints) {
    const d = haversineMeters(lat, lng, gp.lat, gp.lng);
    if (d <= SNAP_THRESHOLD_M && (!best || d < best.rank)) {
      best = {
        target: { lat: gp.lat, lng: gp.lng, lieType: "Green", label: gp.label, kind: "green" },
        rank: d,
      };
    }
  }
  // Hazards: snap if within (radius + threshold). Drop inside hazard keeps
  // its position; drop just outside snaps to the nearest edge point.
  for (const hz of hazards) {
    const hLat = parseFloat(hz.lat);
    const hLng = parseFloat(hz.lng);
    if (!isFinite(hLat) || !isFinite(hLng)) continue;
    const radius = Math.max(1, hz.radiusMeters ?? 5);
    const d = haversineMeters(lat, lng, hLat, hLng);
    const reach = radius + SNAP_THRESHOLD_M;
    if (d > reach) continue;
    let snapLat = lat;
    let snapLng = lng;
    if (d > radius) {
      // Push the marker back to the nearest point on the circle's edge.
      const t = radius / d;
      snapLat = hLat + (lat - hLat) * t;
      snapLng = hLng + (lng - hLng) * t;
    }
    const rank = Math.max(0, d - radius);
    if (!best || rank < best.rank) {
      best = {
        target: {
          lat: snapLat,
          lng: snapLng,
          lieType: lieTypeForHazard(hz.hazardType),
          label: hz.name ?? hz.hazardType,
          kind: "hazard",
        },
        rank,
      };
    }
  }
  // Fairway is a fallback: only used when no green/hazard match. Bunkers
  // typically sit *inside* fairway polygons and carry richer lie info, so we
  // never let a fairway match override a hazard match (Task #999).
  if (!best) {
    const fwSnap = snapToFairway(lat, lng, fairways);
    if (fwSnap) {
      best = {
        target: {
          lat: fwSnap.lat,
          lng: fwSnap.lng,
          lieType: "Fairway",
          label: fwSnap.label,
          kind: "fairway",
        },
        rank: 0,
      };
    }
  }
  return best?.target ?? null;
}
