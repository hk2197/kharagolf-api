// Plays-like yardage helpers (Task #1965).
//
// Combines wind, elevation, temperature and altitude adjustments into a
// single "plays like" yardage. Mirrors GolfLogix / Garmin behaviour. All
// adjustment factors are intentionally optional so callers that only have
// wind + elevation (the watch widget, the web Hole Map panel) get the same
// numbers as callers that pass the full set (the mobile Hole Map sheet,
// the api-server `/playslike` endpoint).
//
// These helpers used to be duplicated in:
//   - artifacts/kharagolf-mobile/components/HoleMapSheet.tsx
//   - artifacts/kharagolf-web/src/components/HoleMapPanel.tsx
//   - artifacts/api-server/src/lib/playsLike.ts
// and would silently disagree if anyone tweaked a coefficient on one side.
// Hoisting them here means the four surfaces (mobile, web, watch, api-server)
// can never drift again. The module has zero React Native / DOM imports so
// it can be consumed safely from either runtime.

export interface PlaysLikeInput {
  rawYards: number;
  /** Compass bearing from player to target, in degrees (0=N, 90=E). */
  bearingDeg?: number | null;
  /** Wind speed in km/h. */
  windSpeedKmh?: number | null;
  /** Wind direction in degrees (where the wind is coming FROM). */
  windDirDeg?: number | null;
  /** Elevation difference target − player in metres (positive = uphill). */
  elevDiffMeters?: number | null;
  /** Air temperature in °C (cool air is denser, ball flies shorter). */
  temperatureC?: number | null;
  /** Course altitude above sea level in metres (high altitude = thinner air = ball flies longer). */
  altitudeMeters?: number | null;
}

export interface PlaysLikeBreakdown {
  rawYards: number;
  playsLikeYards: number;
  windAdj: number;
  elevAdj: number;
  tempAdj: number;
  altitudeAdj: number;
}

/**
 * Compute the wind component along the target line, in km/h.
 *
 * Sign convention: positive = headwind (plays longer), negative = tailwind
 * (plays shorter). `windDirDeg` is meteorological (where the wind comes
 * FROM), so wind blows TOWARD `windDirDeg + 180`. When that toward-vector
 * lines up with `bearingDeg` the wind is helping (tailwind) → component
 * must be negative, hence the leading minus sign.
 */
function windComponentAlongShot(
  windSpeedKmh: number,
  windDirDeg: number,
  bearingDeg: number,
): number {
  const windToward = (windDirDeg + 180) % 360;
  const angleDiff = Math.abs(bearingDeg - windToward);
  const normalised = Math.min(angleDiff, 360 - angleDiff);
  return -windSpeedKmh * Math.cos((normalised * Math.PI) / 180);
}

/**
 * Canonical plays-like calculation. Returns the rounded plays-like yardage
 * along with the per-factor (rounded) contributions so callers can render
 * "plays X yds (+W wind / +E elev / +T temp / +A alt)" without recomputing.
 *
 * Any of the optional factor inputs may be null/undefined; missing factors
 * contribute zero adjustment. The factor coefficients are documented inline
 * — keep them in sync here (and only here) if real-world physics warrants
 * a tweak.
 */
export function computePlaysLike(input: PlaysLikeInput): PlaysLikeBreakdown {
  const raw = input.rawYards;
  let wind = 0;
  let elev = 0;
  let temp = 0;
  let alt = 0;

  // Wind: ~1 yd per 10 km/h headwind per 100 yds, half effect for tailwind.
  if (
    input.windSpeedKmh != null &&
    input.windDirDeg != null &&
    input.bearingDeg != null
  ) {
    const wc = windComponentAlongShot(
      input.windSpeedKmh,
      input.windDirDeg,
      input.bearingDeg,
    );
    wind =
      wc > 0
        ? (wc / 10) * (raw / 100) * 1.0
        : (wc / 10) * (raw / 100) * 0.5;
  }

  // Elevation: +1 yd per metre uphill, -0.7 yd per metre downhill.
  // 1 m ≈ 1.09361 yds.
  if (input.elevDiffMeters != null) {
    elev =
      input.elevDiffMeters > 0
        ? input.elevDiffMeters * 1.09361
        : input.elevDiffMeters * 0.7 * 1.09361;
  }

  // Temperature: standard reference is 21°C (70°F). Cool air is denser →
  // ball flies shorter (need more yardage). ~2 yds per 10°C below standard,
  // scaled by raw yardage.
  if (input.temperatureC != null) {
    const delta = 21 - input.temperatureC;
    temp = (delta / 10) * (raw / 100) * 2.0;
  }

  // Altitude: at high altitude air is thinner → ball flies further.
  // ~2% per 1000 metres above sea level (PGA Tour standard).
  if (input.altitudeMeters != null && input.altitudeMeters > 0) {
    alt = -(input.altitudeMeters / 1000) * 0.02 * raw;
  }

  const playsLike = raw + wind + elev + temp + alt;
  return {
    rawYards: raw,
    playsLikeYards: Math.round(playsLike),
    windAdj: Math.round(wind),
    elevAdj: Math.round(elev),
    tempAdj: Math.round(temp),
    altitudeAdj: Math.round(alt),
  };
}

/**
 * Positional convenience wrapper around {@link computePlaysLike}, retained
 * because the mobile and web components historically called it this way.
 * New code should prefer the object-based {@link computePlaysLike}.
 *
 *   - windDir: meteorological direction the wind is coming FROM (degrees)
 *   - bearingToGreen: direction from player to target (degrees)
 *   - elevDiffMeters: greenElevation − playerElevation (positive = uphill)
 *   - temperatureC: ambient air temp; 21°C is reference
 *   - altitudeMeters: course elevation above sea level
 */
export function playsLikeBreakdown(
  rawYards: number,
  windSpeedKmh: number,
  windDir: number,
  bearingToGreen: number,
  elevDiffMeters?: number,
  temperatureC?: number,
  altitudeMeters?: number,
): PlaysLikeBreakdown {
  return computePlaysLike({
    rawYards,
    windSpeedKmh,
    windDirDeg: windDir,
    bearingDeg: bearingToGreen,
    elevDiffMeters,
    temperatureC,
    altitudeMeters,
  });
}

/**
 * Thin positional wrapper that returns only the final yardage. Retained for
 * call-sites (the watch bridge, the in-sheet F/C/B distance row, the
 * existing test suites) that only care about the headline number. New
 * callers should prefer {@link playsLikeBreakdown} so they can render the
 * per-factor breakdown.
 */
export function playsLikeYards(
  rawYards: number,
  windSpeedKmh: number,
  windDir: number,
  bearingToGreen: number,
  elevDiffMeters?: number,
  temperatureC?: number,
  altitudeMeters?: number,
): number {
  return playsLikeBreakdown(
    rawYards,
    windSpeedKmh,
    windDir,
    bearingToGreen,
    elevDiffMeters,
    temperatureC,
    altitudeMeters,
  ).playsLikeYards;
}
