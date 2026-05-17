// Estimate the elevation at the actual pin position by interpolating between
// the front, centre, and back elevations Open-Meteo returns for the green.
//
// We project the pin onto the green's front→back axis to find its position
// along the green (t = 0 at front, 0.5 at centre, 1 at back), then linearly
// interpolate elevation piecewise (front→centre, then centre→back). On flat
// or nearly-flat greens this yields the centre value, matching the previous
// behaviour. On sloped greens it tracks the actual pin-position elevation,
// which can swing the AI Caddie's "plays-like" yardage by a club or two.

export function interpolatePinElevation(
  pinLat: number,
  pinLng: number,
  frontLat: number,
  frontLng: number,
  centreLat: number,
  centreLng: number,
  backLat: number,
  backLng: number,
  elev: { front: number; centre: number; back: number },
): number {
  // Project the pin onto the front→back axis to get a parameter t in [0,1].
  const dLat = backLat - frontLat;
  const dLng = backLng - frontLng;
  const len2 = dLat * dLat + dLng * dLng;
  if (len2 < 1e-14) return elev.centre;
  const pLat = pinLat - frontLat;
  const pLng = pinLng - frontLng;
  let t = (pLat * dLat + pLng * dLng) / len2;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  // The centre point isn't always the geometric midpoint of the front→back
  // axis, so locate it explicitly (tCentre) and interpolate piecewise
  // front→centre / centre→back. Falls back to 0.5 when the projection is
  // numerically degenerate (centre coincides with front or back).
  const cLat = centreLat - frontLat;
  const cLng = centreLng - frontLng;
  let tCentre = (cLat * dLat + cLng * dLng) / len2;
  if (!(tCentre > 0 && tCentre < 1)) tCentre = 0.5;
  if (t <= tCentre) {
    return elev.front + (elev.centre - elev.front) * (t / tCentre);
  }
  return elev.centre + (elev.back - elev.centre) * ((t - tCentre) / (1 - tCentre));
}
