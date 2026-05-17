import { getWeather } from "./weather";
import {
  computePlaysLike as sharedComputePlaysLike,
  type PlaysLikeInput as SharedPlaysLikeInput,
  type PlaysLikeBreakdown as SharedPlaysLikeBreakdown,
} from "@workspace/golf-physics";

/**
 * PlaysLike distance calculation — combines wind, elevation, temperature and altitude
 * adjustments into a single "plays like" yardage. Mirrors GolfLogix / Garmin behaviour.
 *
 * All inputs are optional; missing factors contribute zero adjustment. The function
 * returns both the final adjusted yardage and a per-factor breakdown so the UI can
 * display a clear hierarchy ("plays 12 yds longer: +6 wind, +4 elevation, +2 cool air").
 *
 * The actual maths lives in `@workspace/golf-physics` so the mobile Hole Map
 * sheet, the web Hole Map panel, the watch widget, and this api-server
 * endpoint all share one canonical formula and can never drift on a
 * coefficient (Task #1965).
 */

export type PlaysLikeInput = SharedPlaysLikeInput;
export type PlaysLikeBreakdown = SharedPlaysLikeBreakdown;

export const computePlaysLike = sharedComputePlaysLike;

/**
 * Bearing from point 1 to point 2 in degrees (0=N, 90=E).
 */
export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const la1 = lat1 * Math.PI / 180;
  const la2 = lat2 * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

/**
 * Subset of {@link PlaysLikeBreakdown} surfaced to clients that only care
 * about the two factors most golfers intuit (wind + elevation). Returned by
 * {@link computePlaysLikeForHole} so the phone scorecard, watch widget, and
 * Wear OS Tile can all show a consistent number with the same breakdown.
 */
export interface HolePlaysLike {
  playsLikeYards: number;
  windAdj: number;
  elevAdj: number;
  /**
   * Compass bearing from player → green, degrees (0=N, 90=E). Surfaced so
   * clients can rotate the wind arrow relative to the player's shot line
   * (Task #878) without having to re-run the bearing maths client-side.
   */
  bearingDeg: number;
  /**
   * Compass direction the wind is blowing FROM, degrees (0=N, 90=E).
   * Combined with `bearingDeg`, clients render a small arrow at angle
   * `(windDirDeg + 180) - bearingDeg` so head/cross/tail wind is obvious
   * at a glance (Task #878).
   */
  windDirDeg: number;
}

/**
 * Compute plays-like yardage for a specific hole using the live weather feed
 * and Open-Meteo elevation. Returns null when the inputs are insufficient
 * (missing yardage, missing green coordinates, weather fetch failure, etc.)
 * so callers can simply omit the field from their response.
 *
 * Wind & elevation are the only adjustments applied here — temperature and
 * altitude are intentionally left to richer endpoints (`/playslike`) so the
 * watch's tiny `PL` field stays focused on the two factors players intuit.
 *
 * Returns the rounded plays-like yardage along with the per-factor wind and
 * elevation contributions so callers can render "plays X yds (+W wind / +E
 * elev)" without recomputing anything client-side.
 */
export async function computePlaysLikeForHole(opts: {
  rawYards: number | null | undefined;
  greenLat: number | string | null | undefined;
  greenLng: number | string | null | undefined;
  /** Player position. Falls back to course centre when omitted. */
  playerLat?: number | string | null;
  playerLng?: number | string | null;
  courseLat?: number | string | null;
  courseLng?: number | string | null;
}): Promise<HolePlaysLike | null> {
  const raw = typeof opts.rawYards === "number" ? opts.rawYards : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return null;

  const toNum = (v: number | string | null | undefined): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  const gLat = toNum(opts.greenLat);
  const gLng = toNum(opts.greenLng);
  if (gLat == null || gLng == null) return null;

  const tLat = toNum(opts.playerLat) ?? toNum(opts.courseLat);
  const tLng = toNum(opts.playerLng) ?? toNum(opts.courseLng);
  if (tLat == null || tLng == null) return null;

  // Per the watch contract we only emit playsLikeYards when BOTH the wind
  // (speed + direction) AND the tee→green elevation delta are known. If
  // either lookup fails we return null so the caller omits the field.
  let windSpeedKmh: number;
  let windDirDeg: number;
  try {
    const w = await getWeather(gLat, gLng);
    if (!Number.isFinite(w.windSpeed) || !Number.isFinite(w.windDirection)) return null;
    windSpeedKmh = w.windSpeed;
    windDirDeg = w.windDirection;
  } catch {
    return null;
  }

  const elevs = await fetchElevations([
    { lat: tLat, lng: tLng },
    { lat: gLat, lng: gLng },
  ]);
  if (!elevs || elevs.length !== 2 || !Number.isFinite(elevs[0]) || !Number.isFinite(elevs[1])) {
    return null;
  }
  const elevDiffMeters = elevs[1]! - elevs[0]!;

  const bearing = bearingDeg(tLat, tLng, gLat, gLng);
  const breakdown = computePlaysLike({
    rawYards: raw,
    bearingDeg: bearing,
    windSpeedKmh,
    windDirDeg,
    elevDiffMeters,
  });
  return {
    playsLikeYards: breakdown.playsLikeYards,
    windAdj: breakdown.windAdj,
    elevAdj: breakdown.elevAdj,
    bearingDeg: Math.round(bearing),
    windDirDeg: Math.round(windDirDeg),
  };
}

/**
 * Fetch elevation for one or more lat/lng pairs from Open-Meteo.
 * Returns null on any error so callers can degrade gracefully.
 */
export async function fetchElevations(points: { lat: number; lng: number }[]): Promise<number[] | null> {
  if (points.length === 0) return [];
  try {
    const lats = points.map(p => p.lat).join(",");
    const lngs = points.map(p => p.lng).join(",");
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`);
    if (!res.ok) return null;
    const json = await res.json() as { elevation?: number[] };
    return json.elevation ?? null;
  } catch {
    return null;
  }
}
