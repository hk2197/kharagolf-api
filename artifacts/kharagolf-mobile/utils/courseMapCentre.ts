// Task #1940 — Mobile mirror of the web `formatMapCentre` helper
// (artifacts/kharagolf-web/src/pages/courses.tsx) and the public course
// detail endpoint's `latitude` -> `mapDefaultLat` fallback
// (artifacts/api-server/src/routes/marketing-site.ts), so the "Located
// near …" label stays in lockstep across web, mobile, and the API.

export interface CourseCentreFields {
  latitude?: number | string | null;
  longitude?: number | string | null;
  mapDefaultLat?: number | string | null;
  mapDefaultLng?: number | string | null;
}

function toFiniteNumber(raw: number | string | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Format a lat/lng pair as "37.78°N, 122.42°W" (2-dp ≈ 1km), or null
 * when either value is missing/blank/non-numeric. */
export function formatMapCentre(
  latRaw: number | string | null | undefined,
  lngRaw: number | string | null | undefined,
): string | null {
  const lat = toFiniteNumber(latRaw);
  const lng = toFiniteNumber(lngRaw);
  if (lat == null || lng == null) return null;
  const ns = lat >= 0 ? "N" : "S";
  const ew = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lng).toFixed(2)}°${ew}`;
}

/** Resolve the effective course centre: explicit `latitude`/`longitude`
 * pair wins, else the `mapDefault*` pair, else null. The fallback is
 * pair-based — half a pair from one source plus half from the other is
 * never combined, so we don't surface a Frankenstein coordinate. */
export function getCourseCentre(course: CourseCentreFields): { lat: number; lng: number } | null {
  const explicitLat = toFiniteNumber(course.latitude);
  const explicitLng = toFiniteNumber(course.longitude);
  if (explicitLat != null && explicitLng != null) {
    return { lat: explicitLat, lng: explicitLng };
  }
  const fallbackLat = toFiniteNumber(course.mapDefaultLat);
  const fallbackLng = toFiniteNumber(course.mapDefaultLng);
  if (fallbackLat != null && fallbackLng != null) {
    return { lat: fallbackLat, lng: fallbackLng };
  }
  return null;
}

/** Composed convenience: the human-readable label for a course's
 * effective centre, or null when no usable pair exists. */
export function formatCourseMapCentre(course: CourseCentreFields): string | null {
  const centre = getCourseCentre(course);
  if (!centre) return null;
  return formatMapCentre(centre.lat, centre.lng);
}
