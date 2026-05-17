export interface ClubStat {
  club: string;
  avgCarry: number;
  stddevCarry: number;
  shotCount: number;
  source: "shots" | "manual" | "fallback";
}

export interface RankedClub {
  club: string;
  carry: number;
  stddev: number;
  shotCount: number;
  source: ClubStat["source"];
  onGreenProb: number;
  surplusYards: number;
}

export interface CaddieRecommendation {
  distanceYards: number;
  effectiveYards: number;
  windAdjustmentYards: number;
  headwindComponent: number;
  crosswindComponent: number;
  lateralStddevYards: number;
  aimOffsetYards: { forward: number; lateral: number };
  aimLatLngOffset: { lat: number; lng: number } | null;
  rankedClubs: RankedClub[];
  recommended: RankedClub | null;
  alternate: RankedClub | null;
  rationale: string[];
  usingFallback: boolean;
  snapshot: {
    generatedAt: string;
    distanceYards: number;
    effectiveYards: number;
    recommendedClub: string | null;
    alternateClub: string | null;
    aim: { lat: number; lng: number } | null;
  };
}

const FALLBACK_DISTANCES: Array<[string, number]> = [
  ["Driver", 220], ["3 Wood", 195], ["5 Wood", 180], ["4 Hybrid", 170],
  ["4 Iron", 160], ["5 Iron", 150], ["6 Iron", 140], ["7 Iron", 130],
  ["8 Iron", 120], ["9 Iron", 110], ["Pitching Wedge", 100],
  ["Gap Wedge", 90], ["Sand Wedge", 75], ["Lob Wedge", 60],
];

function fallbackStddev(handicap: number | null): number {
  const h = handicap ?? 18;
  return Math.max(6, 6 + h * 0.4);
}

function normalCdf(x: number, mean: number, stddev: number): number {
  if (stddev <= 0) return x >= mean ? 1 : 0;
  const z = (x - mean) / (stddev * Math.SQRT2);
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

function probWithinBand(targetYds: number, carry: number, stddev: number, tolerance = 10): number {
  const upper = normalCdf(targetYds + tolerance, carry, stddev);
  const lower = normalCdf(targetYds - tolerance, carry, stddev);
  return Math.max(0, Math.min(1, upper - lower));
}

/**
 * Convert a (forward, lateral) offset around the pin (yards) into a (lat, lng)
 * delta to add to pin coordinates.
 *
 * Convention:
 *   - `bearingDeg` is the player→pin compass bearing (0=N, 90=E).
 *   - `forwardYds` is measured along that bearing: +ve = past the pin (long),
 *     -ve = short of the pin (toward the player).
 *   - `lateralYds` is +ve to the right of the player→pin axis.
 */
export function offsetYardsToLatLng(
  pinLat: number,
  forwardYds: number,
  lateralYds: number,
  bearingDeg: number,
): { lat: number; lng: number } {
  const yardsToMeters = 0.9144;
  const fwdM = forwardYds * yardsToMeters;
  const latM = lateralYds * yardsToMeters;
  const bRad = bearingDeg * Math.PI / 180;
  // Forward axis components: north=cos(b), east=sin(b).
  // Lateral axis (90° clockwise of forward): north=-sin(b), east=cos(b).
  const northM = fwdM * Math.cos(bRad) - latM * Math.sin(bRad);
  const eastM = fwdM * Math.sin(bRad) + latM * Math.cos(bRad);
  const metersPerDegLat = 111111;
  const metersPerDegLng = 111111 * Math.cos(pinLat * Math.PI / 180);
  return {
    lat: northM / metersPerDegLat,
    lng: eastM / metersPerDegLng,
  };
}

export type LieType = "tee" | "fairway" | "rough" | "sand" | "bunker" | "hazard" | "green" | "unknown";

/**
 * Per-lie adjustments applied to the engine.
 * - `distanceMultiplier` inflates the effective yardage (>1 means the ball
 *   comes off the face hotter and stops sooner, so you need more club).
 * - `dispersionMultiplier` inflates per-club carry stddev to reflect the
 *   reduced control from worse lies.
 * Values are conservative defaults derived from PGA Tour proximity-by-lie
 * data; they aim to nudge club selection rather than dominate it.
 */
const LIE_ADJUSTMENTS: Record<string, { distanceMultiplier: number; dispersionMultiplier: number; label: string }> = {
  tee:     { distanceMultiplier: 1.00, dispersionMultiplier: 1.00, label: "tee" },
  fairway: { distanceMultiplier: 1.00, dispersionMultiplier: 1.00, label: "fairway" },
  green:   { distanceMultiplier: 1.00, dispersionMultiplier: 1.00, label: "green" },
  rough:   { distanceMultiplier: 1.05, dispersionMultiplier: 1.30, label: "rough" },
  sand:    { distanceMultiplier: 1.15, dispersionMultiplier: 1.50, label: "bunker" },
  bunker:  { distanceMultiplier: 1.15, dispersionMultiplier: 1.50, label: "bunker" },
  hazard:  { distanceMultiplier: 1.10, dispersionMultiplier: 1.40, label: "hazard" },
  unknown: { distanceMultiplier: 1.00, dispersionMultiplier: 1.00, label: "unknown" },
};

function lieAdjustmentFor(lie: string | null | undefined) {
  if (!lie) return LIE_ADJUSTMENTS.fairway;
  return LIE_ADJUSTMENTS[lie.toLowerCase()] ?? LIE_ADJUSTMENTS.fairway;
}

/**
 * Normalise a raw stored lie string ("Sand", "BUNKER", "fairway", etc.) to
 * the canonical label used to key per-lie acceptance buckets.
 */
export function lieAdjustmentLabel(lie: string | null | undefined): string {
  return lieAdjustmentFor(lie).label;
}

export interface RecommendInput {
  distanceYards: number;
  windSpeedMph?: number;
  /** Meteorological direction the wind blows FROM (degrees). */
  windDirectionDeg?: number;
  /** Compass bearing the player is hitting toward (degrees). */
  windBearingDeg?: number;
  pinLat?: number | null;
  bearingToPinDeg?: number | null;
  clubStats: ClubStat[];
  handicap?: number | null;
  /** Average lateral miss bias in yards (+right). */
  missBiasLateralYards?: number;
  /**
   * Per-club acceptance rate from this player's prior overrides.
   * Values in [0,1]: 1 = always accepted recommendation, 0 = always overridden.
   * Used as a small multiplicative bias so historically over-ridden clubs are
   * weighted slightly lower than equally-likely alternatives.
   */
  acceptanceByClub?: Record<string, number>;
  /**
   * Per-(lie, club) acceptance rate from this player's prior overrides.
   * Outer key is the normalised lie label (matching `LIE_ADJUSTMENTS`, e.g.
   * "fairway", "rough", "bunker"); inner key is the club name. When the
   * current shot is from a known lie and a per-lie rate exists for the
   * candidate club, it is blended with the per-club rate so lie-specific
   * overrides (e.g. always taking one more club from the bunker) bias the
   * model on top of the existing per-club bias.
   */
  acceptanceByLie?: Record<string, Record<string, number>>;
  /**
   * Elevation change to the green in yards (pin elevation minus player
   * elevation). +ve = uphill (plays longer), -ve = downhill (plays shorter).
   */
  elevationDeltaYards?: number;
  /** Player's current lie. Used to penalise distance and dispersion. */
  lieType?: LieType | string | null;
  /**
   * Task #1348 — per-club proximity-gap data, keyed by the raw club label
   * (matching `ClubStat.club`). When the engine recommends a club for which
   * the player has a known gap vs the tour proximity benchmark, a one-line
   * coaching hint is appended to the rationale so the on-course advice
   * stays consistent with the post-round "work on this club" callout in
   * the Shot Analytics panel.
   */
  proximityGapsByClub?: Record<string, { gapVsTourFt: number; aimLongFt: number; caddieHint: string }>;
}

export function buildClubStatsFromAggregates(rows: Array<{
  club: string;
  avgCarry: number | null;
  stddevCarry: number | null;
  count: number;
}>, manualOverrides: Map<string, number>, handicap: number | null): ClubStat[] {
  const stats = new Map<string, ClubStat>();
  for (const r of rows) {
    if (!r.club || r.avgCarry == null || r.count < 2) continue;
    stats.set(r.club, {
      club: r.club,
      avgCarry: Math.round(r.avgCarry),
      stddevCarry: Math.max(4, Math.round(r.stddevCarry ?? fallbackStddev(handicap))),
      shotCount: r.count,
      source: "shots",
    });
  }
  for (const [club, carry] of manualOverrides) {
    const existing = stats.get(club);
    stats.set(club, {
      club,
      avgCarry: carry,
      stddevCarry: existing?.stddevCarry ?? fallbackStddev(handicap),
      shotCount: existing?.shotCount ?? 0,
      source: "manual",
    });
  }
  return [...stats.values()];
}

export function fallbackClubStats(handicap: number | null): ClubStat[] {
  const sd = fallbackStddev(handicap);
  return FALLBACK_DISTANCES.map(([club, carry]) => ({
    club,
    avgCarry: carry,
    stddevCarry: sd,
    shotCount: 0,
    source: "fallback" as const,
  }));
}

export function recommend(input: RecommendInput): CaddieRecommendation {
  const {
    distanceYards,
    windSpeedMph = 0,
    windDirectionDeg = 0,
    windBearingDeg = 0,
    pinLat,
    bearingToPinDeg,
    clubStats,
    handicap = null,
    missBiasLateralYards = 0,
    acceptanceByClub = {},
    acceptanceByLie = {},
    elevationDeltaYards = 0,
    lieType = null,
    proximityGapsByClub = {},
  } = input;

  // Normalise the current lie to the same label space as `LIE_ADJUSTMENTS`
  // so that "sand" and "bunker" share a single per-lie acceptance bucket.
  const currentLieKey = lieType ? lieAdjustmentFor(lieType).label : null;
  const lieAcceptanceForCurrent = currentLieKey ? acceptanceByLie[currentLieKey] ?? null : null;

  const windFromRad = windDirectionDeg * Math.PI / 180;
  const hitTowardRad = windBearingDeg * Math.PI / 180;
  const angle = windFromRad - hitTowardRad;
  const headwindComponent = windSpeedMph * Math.cos(angle);
  const crosswindComponent = windSpeedMph * Math.sin(angle);

  const windYardAdjustment = headwindComponent > 0
    ? headwindComponent * 1.0
    : headwindComponent * 0.6;
  // Uphill plays longer roughly 1y per 1y of rise; downhill releases so the
  // benefit is only ~70% of the drop.
  const elevationYardAdjustment = elevationDeltaYards >= 0
    ? elevationDeltaYards * 1.0
    : elevationDeltaYards * 0.7;
  const lieAdj = lieAdjustmentFor(lieType);
  const lieYardAdjustment = distanceYards * (lieAdj.distanceMultiplier - 1);
  const effectiveYards = Math.max(
    20,
    distanceYards + windYardAdjustment + elevationYardAdjustment + lieYardAdjustment,
  );

  const usingFallback = clubStats.every(s => s.source === "fallback");
  const stats = clubStats.length > 0 ? clubStats : fallbackClubStats(handicap);

  const sorted = [...stats].sort((a, b) => b.avgCarry - a.avgCarry);

  const ranked: RankedClub[] = sorted.map(s => {
    // Inflate per-club dispersion when hitting from a tougher lie so
    // probability bands widen and longer/safer clubs are weighted up.
    const adjustedStddev = Math.max(4, s.stddevCarry * lieAdj.dispersionMultiplier);
    const baseProb = probWithinBand(effectiveYards, s.avgCarry, adjustedStddev, 10);
    // Acceptance bias: nudge probability by ±5% based on prior accept/override
    // history for this club. When the player has lie-specific history for the
    // current lie, blend it with the per-club rate (60% lie / 40% overall) so
    // lie-context overrides (e.g. always taking one more club from the bunker)
    // dominate the bias. Defaults to neutral when no history exists.
    const baseAccept = acceptanceByClub[s.club];
    const lieAccept = lieAcceptanceForCurrent?.[s.club];
    let combinedAccept: number | undefined;
    if (lieAccept != null && baseAccept != null) combinedAccept = 0.4 * baseAccept + 0.6 * lieAccept;
    else if (lieAccept != null) combinedAccept = lieAccept;
    else if (baseAccept != null) combinedAccept = baseAccept;
    const personalisation = combinedAccept == null ? 1 : 0.95 + 0.10 * combinedAccept;
    return {
      club: s.club,
      carry: s.avgCarry,
      stddev: Math.round(adjustedStddev),
      shotCount: s.shotCount,
      source: s.source,
      onGreenProb: Math.max(0, Math.min(1, baseProb * personalisation)),
      surplusYards: s.avgCarry - effectiveYards,
    };
  });

  const sortedByProb = [...ranked].sort((a, b) => b.onGreenProb - a.onGreenProb);
  let recommended = sortedByProb[0] ?? null;

  // Within-5% tie-break: prefer the longer club to avoid coming up short.
  if (recommended && sortedByProb.length > 1) {
    const close = sortedByProb.filter(r => recommended!.onGreenProb - r.onGreenProb < 0.05);
    if (close.length > 1) {
      recommended = close.reduce((best, r) => r.carry > best.carry ? r : best, close[0]);
    }
  }

  const alternate = sortedByProb.find(r => r.club !== recommended?.club) ?? null;
  const rankedClubs = sortedByProb.slice(0, 3);

  const lateralStddev = recommended ? Math.max(4, recommended.stddev * 0.7) : fallbackStddev(handicap);
  const crosswindDriftYards = (crosswindComponent * 0.8) * (effectiveYards / 100);
  const aimLateralYards = -crosswindDriftYards - missBiasLateralYards;
  const forwardTrim = recommended && recommended.surplusYards > recommended.stddev
    ? Math.min(8, recommended.surplusYards - recommended.stddev)
    : 0;
  const aimForwardYards = -forwardTrim;

  const aimOffsetYards = { forward: aimForwardYards, lateral: aimLateralYards };
  const aimLatLngOffset = (pinLat != null && bearingToPinDeg != null)
    ? offsetYardsToLatLng(pinLat, aimForwardYards, aimLateralYards, bearingToPinDeg)
    : null;

  const rationale: string[] = [];
  if (recommended) {
    const surplus = Math.round(recommended.surplusYards);
    if (Math.abs(surplus) <= 3) rationale.push(`${recommended.club} carries ${recommended.carry}y — right on the number`);
    else if (surplus > 0) rationale.push(`${recommended.club} carries ${recommended.carry}y (+${surplus}y over the target)`);
    else rationale.push(`${recommended.club} carries ${recommended.carry}y (${surplus}y short of target — playing safe)`);
    rationale.push(`${Math.round(recommended.onGreenProb * 100)}% chance of finishing within 10y of pin distance`);
    if (recommended.shotCount >= 5) rationale.push(`based on ${recommended.shotCount} of your tracked ${recommended.club} shots`);
    else if (recommended.source === "manual") rationale.push("using your manual carry override");
    else if (recommended.source === "fallback") rationale.push("using handicap-based estimates (track shots to personalise)");
    const accept = acceptanceByClub[recommended.club];
    const lieAccept = lieAcceptanceForCurrent?.[recommended.club];
    if (lieAccept != null && currentLieKey) {
      rationale.push(`you've taken this club ${Math.round(lieAccept * 100)}% of the time from the ${currentLieKey}`);
    } else if (accept != null && accept >= 0.7) {
      rationale.push(`you've taken this club ${Math.round(accept * 100)}% of the time when suggested`);
    }
  }
  if (Math.abs(headwindComponent) > 3) {
    const dir = headwindComponent > 0 ? "headwind" : "tailwind";
    rationale.push(`${Math.abs(Math.round(headwindComponent))}mph ${dir} — playing ${Math.abs(Math.round(windYardAdjustment))}y ${headwindComponent > 0 ? "longer" : "shorter"}`);
  }
  if (Math.abs(elevationDeltaYards) >= 3) {
    const dir = elevationDeltaYards > 0 ? "uphill" : "downhill";
    rationale.push(`${Math.abs(Math.round(elevationDeltaYards))}y ${dir} — playing ${Math.abs(Math.round(elevationYardAdjustment))}y ${elevationDeltaYards > 0 ? "longer" : "shorter"}`);
  }
  if (lieAdj.distanceMultiplier !== 1) {
    const extra = Math.max(1, Math.round(lieYardAdjustment));
    const dispPct = Math.round((lieAdj.dispersionMultiplier - 1) * 100);
    rationale.push(`from the ${lieAdj.label} — playing ${extra}y longer with +${dispPct}% dispersion`);
  }
  if (Math.abs(crosswindComponent) > 4) {
    const dir = crosswindComponent > 0 ? "left-to-right" : "right-to-left";
    rationale.push(`${Math.abs(Math.round(crosswindComponent))}mph ${dir} crosswind — aim ${Math.abs(Math.round(crosswindDriftYards))}y ${crosswindComponent > 0 ? "left" : "right"} of pin`);
  }
  if (Math.abs(missBiasLateralYards) > 3) {
    rationale.push(`adjusting for your ${Math.round(Math.abs(missBiasLateralYards))}y average miss ${missBiasLateralYards > 0 ? "right" : "left"}`);
  }
  if (forwardTrim > 0) {
    rationale.push(`aiming ${Math.round(forwardTrim)}y short — your ${recommended?.club} runs long`);
  }
  // Task #1348 — when the recommended club has a known proximity-vs-tour gap,
  // append the same coaching hint surfaced in the post-round Shot Analytics
  // panel. Keeps the on-course advice consistent with what the player sees
  // when reviewing rounds.
  if (recommended) {
    const gap = proximityGapsByClub[recommended.club];
    if (gap && gap.gapVsTourFt >= 3) {
      rationale.push(gap.caddieHint);
    }
  }

  return {
    distanceYards,
    effectiveYards: Math.round(effectiveYards),
    windAdjustmentYards: Math.round(windYardAdjustment),
    headwindComponent: Math.round(headwindComponent * 10) / 10,
    crosswindComponent: Math.round(crosswindComponent * 10) / 10,
    lateralStddevYards: Math.round(lateralStddev * 10) / 10,
    aimOffsetYards: { forward: Math.round(aimOffsetYards.forward * 10) / 10, lateral: Math.round(aimOffsetYards.lateral * 10) / 10 },
    aimLatLngOffset,
    rankedClubs,
    recommended,
    alternate,
    rationale,
    usingFallback,
    snapshot: {
      generatedAt: new Date().toISOString(),
      distanceYards,
      effectiveYards: Math.round(effectiveYards),
      recommendedClub: recommended?.club ?? null,
      alternateClub: alternate?.club ?? null,
      aim: aimLatLngOffset,
    },
  };
}
