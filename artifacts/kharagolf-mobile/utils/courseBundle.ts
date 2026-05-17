/**
 * Wave 1 W1-B — Course bundle pre-cache.
 *
 * The mobile app calls this when a round starts to fetch a single
 * offline-ready payload (`/api/organizations/:orgId/courses/:courseId/bundle`)
 * containing hole details, full geometry, and the resolved AI-Caddie mode.
 * The bundle is cached in AsyncStorage under `course_bundle_${courseId}` for
 * 24h so the mobile app can keep the player on the course even if the device
 * loses connectivity mid-round.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BASE_URL } from "@/utils/api";

export const COURSE_BUNDLE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const COURSE_BUNDLE_KEY_PREFIX = "course_bundle_";

export interface CourseBundleHole {
  id?: number;
  courseId: number;
  holeNumber: number;
  par: number;
  handicap?: number | null;
  yardageBlue?: number | null;
  yardageWhite?: number | null;
  yardageRed?: number | null;
  description?: string | null;
  greenFrontLat?: string | null;
  greenFrontLng?: string | null;
  greenCentreLat?: string | null;
  greenCentreLng?: string | null;
  greenBackLat?: string | null;
  greenBackLng?: string | null;
}

export interface CourseBundleGeometryFeature {
  id?: number;
  courseId: number;
  holeNumber: number;
  featureType: string;
  geometry: unknown;
  source?: string | null;
  label?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CourseBundleRoundContext {
  tournamentId: number | null;
  leagueId: number | null;
  generalPlayRoundId: number | null;
  aiCaddieMode: "open" | "distance_only" | "lockdown";
}

export interface CourseBundle {
  courseId: number;
  course: { id: number; name: string; organizationId: number };
  holes: CourseBundleHole[];
  geometry: CourseBundleGeometryFeature[];
  roundContext: CourseBundleRoundContext;
  cachedAt: string;
}

interface CachedEnvelope {
  fetchedAt: number;
  bundle: CourseBundle;
}

function cacheKey(courseId: number): string {
  return `${COURSE_BUNDLE_KEY_PREFIX}${courseId}`;
}

/**
 * Read a cached bundle if it's present and still within the 24h TTL.
 * Returns null when missing, expired, or unparseable.
 */
export async function loadCachedCourseBundle(
  courseId: number,
  now: number = Date.now(),
): Promise<CourseBundle | null> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(courseId));
    if (!raw) return null;
    const env = JSON.parse(raw) as CachedEnvelope;
    if (!env?.fetchedAt || !env.bundle) return null;
    if (now - env.fetchedAt > COURSE_BUNDLE_TTL_MS) return null;
    return env.bundle;
  } catch {
    return null;
  }
}

export async function clearCachedCourseBundle(courseId: number): Promise<void> {
  try { await AsyncStorage.removeItem(cacheKey(courseId)); } catch { /* ignore */ }
}

/**
 * Scan AsyncStorage for any cached bundle whose roundContext matches the
 * given tournament/league/general-play round. Used by the in-round screens
 * when their primary network call fails and they don't yet know the
 * courseId — the bundle was saved by `prefetchCourseBundle` at round start
 * so we can trace the round back to its course offline (Task #1160).
 */
export async function loadCachedCourseBundleForRound(
  ctx: { tournamentId?: number | null; leagueId?: number | null; generalPlayRoundId?: number | null },
  now: number = Date.now(),
): Promise<CourseBundle | null> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    for (const key of keys) {
      if (!key.startsWith(COURSE_BUNDLE_KEY_PREFIX)) continue;
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      try {
        const env = JSON.parse(raw) as CachedEnvelope;
        if (!env?.fetchedAt || !env.bundle) continue;
        if (now - env.fetchedAt > COURSE_BUNDLE_TTL_MS) continue;
        const rc = env.bundle.roundContext;
        if (
          (ctx.tournamentId != null && rc.tournamentId === ctx.tournamentId) ||
          (ctx.leagueId != null && rc.leagueId === ctx.leagueId) ||
          (ctx.generalPlayRoundId != null && rc.generalPlayRoundId === ctx.generalPlayRoundId)
        ) {
          return env.bundle;
        }
      } catch { /* skip unparseable */ }
    }
    return null;
  } catch {
    return null;
  }
}

/** Bundle hazard projection — Task #1160.
 *
 * The live `/courses/:courseId/holes-hazards` endpoint reads the per-point
 * `holeHazardsTable` (lat/lng + radius). The bundle stores the unified
 * `course_hole_geometry` rows instead, so we project polygon/point hazard
 * features to the same `{ holeNumber, hazardType, lat, lng, radiusMeters,
 * name }` shape the in-round components expect, using a centroid + a
 * coarse bounding-radius. Good enough to keep snap-to-feature working
 * when the network drops.
 */
export interface CachedHazardInfo {
  holeNumber: number;
  hazardType: string;
  lat: string;
  lng: string;
  radiusMeters: number | null;
  name: string | null;
}

const HAZARD_FEATURE_TO_TYPE: Record<string, string> = {
  hazard_water: "water",
  hazard_bunker: "bunker",
  hazard_oob: "ob",
};

function flattenCoords(geom: unknown): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!geom || typeof geom !== "object") return out;
  const g = geom as { type?: string; coordinates?: unknown };
  const pushPoint = (pt: unknown) => {
    if (Array.isArray(pt) && typeof pt[0] === "number" && typeof pt[1] === "number") {
      out.push([pt[0], pt[1]]);
    }
  };
  const walk = (node: unknown) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
      pushPoint(node);
      return;
    }
    for (const child of node) walk(child);
  };
  if (g.type === "Point") pushPoint(g.coordinates);
  else walk(g.coordinates);
  return out;
}

export function bundleToHazards(bundle: CourseBundle): CachedHazardInfo[] {
  const out: CachedHazardInfo[] = [];
  for (const f of bundle.geometry ?? []) {
    const hzType = HAZARD_FEATURE_TO_TYPE[f.featureType];
    if (!hzType) continue;
    const pts = flattenCoords(f.geometry);
    if (pts.length === 0) continue;
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    let sumLng = 0, sumLat = 0;
    for (const [lng, lat] of pts) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      sumLng += lng; sumLat += lat;
    }
    const cLng = sumLng / pts.length;
    const cLat = sumLat / pts.length;
    // Coarse bounding radius in metres — half the bbox diagonal at the centroid.
    const mPerLat = 111111;
    const mPerLng = 111111 * Math.cos(cLat * Math.PI / 180);
    const dx = (maxLng - minLng) * mPerLng;
    const dy = (maxLat - minLat) * mPerLat;
    const radius = pts.length === 1 ? 5 : Math.max(2, Math.sqrt(dx * dx + dy * dy) / 2);
    out.push({
      holeNumber: f.holeNumber,
      hazardType: hzType,
      lat: String(cLat),
      lng: String(cLng),
      radiusMeters: Math.round(radius),
      name: f.label ?? null,
    });
  }
  return out;
}

export interface CachedFairwayInfo {
  holeNumber: number;
  geometry: { type: "Polygon" | "MultiPolygon" | "LineString" | "Point"; coordinates: unknown } | null;
  label: string | null;
}

/** Project a cached CourseBundle into the same shape `/tournaments/:id/holes`
 *  returns, so the score screen can keep rendering distances and the AI
 *  caddie when that endpoint fails mid-round (Task #1160). */
export interface BundleHolesProjection {
  holes: Array<{
    holeNumber: number;
    par: number;
    handicap?: number;
    yardageBlue?: number;
    yardageWhite?: number;
    yardageRed?: number;
    description?: string | null;
    greenFrontLat?: string | null;
    greenFrontLng?: string | null;
    greenCentreLat?: string | null;
    greenCentreLng?: string | null;
    greenBackLat?: string | null;
    greenBackLng?: string | null;
  }>;
  rounds: number;
  courseRating?: number | null;
  courseSlope?: number | null;
  coursePar?: number | null;
  courseId: number;
  organizationId: number;
}

export function bundleToHolesResponse(bundle: CourseBundle): BundleHolesProjection {
  return {
    holes: (bundle.holes ?? []).map(h => ({
      holeNumber: h.holeNumber,
      par: h.par,
      handicap: h.handicap ?? undefined,
      yardageBlue: h.yardageBlue ?? undefined,
      yardageWhite: h.yardageWhite ?? undefined,
      yardageRed: h.yardageRed ?? undefined,
      description: h.description ?? null,
      greenFrontLat: h.greenFrontLat ?? null,
      greenFrontLng: h.greenFrontLng ?? null,
      greenCentreLat: h.greenCentreLat ?? null,
      greenCentreLng: h.greenCentreLng ?? null,
      greenBackLat: h.greenBackLat ?? null,
      greenBackLng: h.greenBackLng ?? null,
    })),
    // Bundle covers the course (not a specific round count); default to 1
    // so the screen at least renders the active round it already knows about.
    rounds: 1,
    courseRating: null,
    courseSlope: null,
    coursePar: (bundle.holes ?? []).reduce((sum, h) => sum + (h.par ?? 0), 0) || null,
    courseId: bundle.courseId,
    organizationId: bundle.course?.organizationId,
  };
}

export function bundleToFairways(bundle: CourseBundle): CachedFairwayInfo[] {
  const out: CachedFairwayInfo[] = [];
  for (const f of bundle.geometry ?? []) {
    if (f.featureType !== "fairway") continue;
    const g = f.geometry as { type?: string; coordinates?: unknown } | null;
    if (!g || typeof g !== "object") continue;
    const t = g.type;
    if (t !== "Polygon" && t !== "MultiPolygon" && t !== "LineString" && t !== "Point") continue;
    out.push({
      holeNumber: f.holeNumber,
      geometry: { type: t, coordinates: g.coordinates },
      label: f.label ?? null,
    });
  }
  return out;
}

interface PrefetchOptions {
  /** Bearer token — required, the bundle endpoint refuses unauthenticated requests with 401. */
  token: string;
  /** Optional round-context hints; when present the server resolves the AI-Caddie mode. */
  tournamentId?: number | null;
  leagueId?: number | null;
  generalPlayRoundId?: number | null;
  /** When true, ignore the cached copy and re-fetch from the server. */
  forceRefresh?: boolean;
  /** Override the network fetcher in tests. */
  fetcher?: typeof fetch;
  /** Override the clock in tests. */
  now?: () => number;
}

/**
 * Fetch the course bundle and persist it to AsyncStorage.
 *
 * - Honours a 24h cache (skip the network when fresh, unless `forceRefresh`).
 * - On any network/HTTP failure, falls back to the cached copy if available
 *   so the player can keep playing offline.
 */
export async function prefetchCourseBundle(
  orgId: number,
  courseId: number,
  options: PrefetchOptions,
): Promise<CourseBundle | null> {
  const now = options.now ? options.now() : Date.now();

  if (!options.forceRefresh) {
    const cached = await loadCachedCourseBundle(courseId, now);
    if (cached) return cached;
  }

  const params = new URLSearchParams();
  if (options.tournamentId != null) params.set("tournamentId", String(options.tournamentId));
  if (options.leagueId != null) params.set("leagueId", String(options.leagueId));
  if (options.generalPlayRoundId != null) params.set("generalPlayRoundId", String(options.generalPlayRoundId));
  const qs = params.toString();
  const url = `${BASE_URL}/api/organizations/${orgId}/courses/${courseId}/bundle${qs ? `?${qs}` : ""}`;

  try {
    const fetchFn = options.fetcher ?? fetch;
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${options.token}` },
    });
    if (!res.ok) {
      // Fall back to the cached copy (within TTL) so the round can still
      // start when the network is flaky. Expired caches are intentionally
      // not returned — clearCachedCourseBundle is the explicit escape hatch.
      return loadCachedCourseBundle(courseId, now);
    }
    const bundle = (await res.json()) as CourseBundle;
    const envelope: CachedEnvelope = { fetchedAt: now, bundle };
    try { await AsyncStorage.setItem(cacheKey(courseId), JSON.stringify(envelope)); } catch { /* ignore */ }
    return bundle;
  } catch {
    return loadCachedCourseBundle(courseId, now);
  }
}
