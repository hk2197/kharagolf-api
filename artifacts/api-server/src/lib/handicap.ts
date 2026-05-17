/**
 * WHS Handicap Engine — Rules of Handicapping 2024/2026
 *
 * Course Handicap  = HI × (Slope / 113) + (CourseRating − CoursePar)
 * Playing Handicap = CourseHandicap × (allowance% / 100), rounded to nearest integer
 *
 * Implements all WHS sections: §3.1, §5.1, §5.1b, §5.1d, §5.3, §5.4, §5.7, §5.8, §5.9, §6.1, §6.2
 */

// ─── COURSE & PLAYING HANDICAP ─────────────────────────────────────────────

/** Compute WHS Course Handicap for a player. */
export function computeCourseHandicap(
  handicapIndex: number,
  slope: number | null | undefined,
  rating: number | null | undefined,
  coursePar: number,
): number {
  const s = slope ?? 113;
  const r = rating ?? coursePar;
  return Math.round(handicapIndex * (s / 113) + (r - coursePar));
}

/** Compute WHS Playing Handicap (Course Handicap × allowance). */
export function computePlayingHandicap(
  handicapIndex: number,
  slope: number | null | undefined,
  rating: number | null | undefined,
  coursePar: number,
  allowancePct: number = 100,
): number {
  const courseHandicap = computeCourseHandicap(handicapIndex, slope, rating, coursePar);
  return Math.round(courseHandicap * (allowancePct / 100));
}

/**
 * WHS §6.2 named allowances by competition format.
 * Returns the allowance percentage for a given format name.
 */
export function playingHandicapAllowance(format: string): number {
  switch (format) {
    case "stroke_play":
    case "net_stroke":
    case "stableford":       return 95;
    case "match_play":       return 100;
    case "best_ball":
    case "four_ball":        return 85;
    case "scramble":
    case "texas_scramble":   return 35;
    case "foursomes":
    case "greensomes":       return 50;
    default:                 return 100;
  }
}

/**
 * Strokes received on a given hole for a player.
 * SI = Stroke Index (1 = hardest, 18 = easiest)
 * Positive PH: receives extra strokes on lowest SI holes.
 * Negative PH (plus marker): gives strokes on lowest SI holes.
 */
export function strokesOnHole(si: number | null | undefined, playingHandicap: number): number {
  if (si == null || si < 1) {
    const base = Math.floor(Math.abs(playingHandicap) / 18);
    return playingHandicap >= 0 ? base : -base;
  }

  if (playingHandicap >= 0) {
    const base = Math.floor(playingHandicap / 18);
    const extra = si <= (playingHandicap % 18) ? 1 : 0;
    return base + extra;
  } else {
    const absPH = Math.abs(playingHandicap);
    const base = Math.floor(absPH / 18);
    const extra = absPH % 18 > 0 && si <= (absPH % 18) ? 1 : 0;
    return -(base + extra);
  }
}

/**
 * Custom Stableford points table.
 * Keys map score-relative-to-adjusted-par → points.
 * Defaults to WHS standard (eagle 4, birdie 3, par 2, bogey 1, double+ 0).
 */
export type StablefordPointsConfig = {
  eagle?: number;
  birdie?: number;
  par?: number;
  bogey?: number;
  double?: number;
  worse?: number;
  /** For team_stableford: how many players' scores to count per hole (default = floor(teamSize/2)) */
  bestOf?: number;
};

/**
 * Stableford points for a single hole.
 * diff = par + strokesReceived - strokes (+ve = under par)
 * WHS default: max(0, diff + 2) — eagle=4, birdie=3, par=2, bogey=1, double+=0
 * Custom config: maps diff threshold → configurable points value.
 */
export function stablefordPointsForHole(
  strokes: number,
  par: number,
  si: number | null | undefined,
  playingHandicap: number,
  config?: StablefordPointsConfig | null,
): number {
  const received = strokesOnHole(si, playingHandicap);
  const diff = par + received - strokes;
  if (config) {
    if (diff >= 2) return config.eagle ?? 4;
    if (diff === 1) return config.birdie ?? 3;
    if (diff === 0) return config.par ?? 2;
    if (diff === -1) return config.bogey ?? 1;
    if (diff === -2) return config.double ?? 0;
    return config.worse ?? 0;
  }
  return Math.max(0, diff + 2);
}

/**
 * Resolve effective handicap for a player — uses `handicapOverride` if set, else `handicapIndex`.
 */
export function effectiveHandicapIndex(
  handicapIndex: string | null | undefined,
  handicapOverride: string | null | undefined,
): number {
  if (handicapOverride != null) return Number(handicapOverride);
  return handicapIndex ? Number(handicapIndex) : 0;
}

// ─── WHS SCORE DIFFERENTIAL ────────────────────────────────────────────────

/**
 * §5.1 Score Differential for a full 18-hole round.
 * Formula: (113 / slopeRating) × (adjustedGrossScore − courseRating − pcc)
 * Rounded to 1 decimal place.
 */
export function scoreDifferential18(
  adjustedGrossScore: number,
  courseRating: number,
  slopeRating: number,
  pcc: number = 0,
): number {
  const raw = (113 / slopeRating) * (adjustedGrossScore - courseRating - pcc);
  return Math.round(raw * 10) / 10;
}

/**
 * §5.1b 9-hole score combination.
 * Combines actual 9-hole differential with expected differential from H.I.
 * expectedDifferential = max(0, handicapIndex / 2)
 * pccFor9 = pcc / 2 (halved for 9-hole rounds)
 */
export function scoreDifferential9(
  adjustedGrossScore9: number,
  courseRating9: number,
  slopeRating: number,
  currentHandicapIndex: number,
  pcc: number = 0,
): number {
  const pcc9 = pcc / 2;
  const actualDiff = (113 / slopeRating) * (adjustedGrossScore9 - courseRating9 - pcc9);
  const expectedDiff = Math.max(0, currentHandicapIndex / 2);
  const combined = actualDiff + expectedDiff;
  return Math.round(combined * 10) / 10;
}

/**
 * §5.1d Rounds of 10–17 holes — prorated formula.
 * Scales course rating by (holesPlayed / 18) and adds expected score for unplayed holes.
 */
export function scoreDifferentialPartialRound(
  adjustedGrossScore: number,
  courseRating: number,
  slopeRating: number,
  holesPlayed: number,
  currentHandicapIndex: number,
  pcc: number = 0,
): number {
  const ratingProrated = courseRating * (holesPlayed / 18);
  const unplayedHoles = 18 - holesPlayed;
  const expectedScoreUnplayed = (currentHandicapIndex / 18) * unplayedHoles;
  const effectiveScore = adjustedGrossScore + expectedScoreUnplayed;
  const raw = (113 / slopeRating) * (effectiveScore - ratingProrated - pcc);
  return Math.round(raw * 10) / 10;
}

// ─── WHS EXCEPTIONAL SCORE REDUCTION (§5.9) ────────────────────────────────

/**
 * §5.9 Exceptional Score Reduction.
 * Applied automatically to the differential before storage.
 * Returns the amount to subtract (0, 1.0, or 2.0).
 */
export function esrReduction(differential: number, currentHandicapIndex: number): number {
  const improvement = currentHandicapIndex - differential;
  if (improvement >= 10) return 2.0;
  if (improvement >= 7) return 1.0;
  return 0;
}

/**
 * Apply ESR to a differential.
 * Returns { rawDifferential, esrAdjustment, finalDifferential }.
 */
export function applyESR(
  differential: number,
  currentHandicapIndex: number | null,
): { rawDifferential: number; esrAdjustment: number; finalDifferential: number } {
  if (currentHandicapIndex === null) {
    return { rawDifferential: differential, esrAdjustment: 0, finalDifferential: differential };
  }
  const reduction = esrReduction(differential, currentHandicapIndex);
  return {
    rawDifferential: differential,
    esrAdjustment: reduction,
    finalDifferential: Math.round((differential - reduction) * 10) / 10,
  };
}

// ─── WHS HANDICAP INDEX CALCULATION (§5.3) ─────────────────────────────────

/** WHS Phase 2 initial establishment table.
 * Returns { count: number of differentials to use, adjustment: fixed adjustment to apply }
 */
function phase2Selection(n: number): { count: number; adjustment: number } {
  if (n === 3) return { count: 1, adjustment: -2.0 };
  if (n === 4) return { count: 1, adjustment: -1.0 };
  if (n === 5) return { count: 1, adjustment: 0.0 };
  if (n === 6) return { count: 2, adjustment: -1.0 };
  if (n <= 8) return { count: 2, adjustment: 0.0 };
  if (n <= 10) return { count: 3, adjustment: 0.0 };
  if (n <= 12) return { count: 4, adjustment: 0.0 };
  if (n <= 14) return { count: 5, adjustment: 0.0 };
  if (n <= 17) return { count: 6, adjustment: 0.0 };
  return { count: 7, adjustment: 0.0 }; // 18-19
}

/**
 * §5.3 Calculate Handicap Index from score differentials.
 *
 * Phase 1 (<3 differentials): null (not yet established)
 * Phase 2 (3-19 differentials): selection table, no 0.96 factor
 * Phase 3 (≥20 differentials): best 8 of last 20 × 0.96, cap at 54.0
 *
 * @param differentials  Array of final differentials (most recent last, max 20 used).
 * @returns Handicap Index (to 1 decimal) or null if not yet established (Phase 1).
 */
export function calculateHandicapIndex(differentials: number[]): number | null {
  const n = differentials.length;

  if (n < 3) return null;

  let hi: number;

  if (n >= 20) {
    // Phase 3: use last 20 differentials
    const last20 = differentials.slice(-20).sort((a, b) => a - b);
    const best8 = last20.slice(0, 8);
    const avg = best8.reduce((s, d) => s + d, 0) / 8;
    hi = Math.round(avg * 0.96 * 10) / 10;
  } else {
    // Phase 2: use selection table
    const sorted = [...differentials].sort((a, b) => a - b);
    const { count, adjustment } = phase2Selection(n);
    const selected = sorted.slice(0, count);
    const avg = selected.reduce((s, d) => s + d, 0) / count;
    hi = Math.round((avg + adjustment) * 10) / 10;
  }

  return Math.min(54.0, Math.max(-9.9, hi));
}

// ─── WHS CAPS: SOFT CAP & HARD CAP (§5.4, §5.7, §5.8) ─────────────────────

/**
 * §5.4 / §5.7 / §5.8 Soft Cap and Hard Cap.
 *
 * Soft Cap: applied when candidate H.I. > Low H.I. + 3.0
 *   excess = candidate − (lowHI + 3.0)
 *   softCapped = (lowHI + 3.0) + excess × 0.5
 *
 * Hard Cap: result never exceeds Low H.I. + 5.0
 *
 * @param candidateHI  The uncapped Handicap Index candidate.
 * @param lowHI        The player's Low H.I. over the rolling 365-day window.
 * @returns The capped Handicap Index.
 */
export function applyCaps(candidateHI: number, lowHI: number): number {
  const softCapThreshold = lowHI + 3.0;
  const hardCapMax = lowHI + 5.0;

  let result = candidateHI;

  if (result > softCapThreshold) {
    const excess = result - softCapThreshold;
    result = softCapThreshold + excess * 0.5;
  }

  result = Math.min(result, hardCapMax);
  return Math.round(result * 10) / 10;
}

/**
 * Update Low H.I. given a new candidate H.I. and the current Low H.I.
 * Low H.I. is the lowest Handicap Index achieved within the rolling 365-day window.
 * This function returns the new Low H.I. — callers must filter their differentials
 * to the 365-day window before computing the candidate.
 */
export function updateLowHI(
  newHI: number,
  currentLowHI: number | null,
): number {
  if (currentLowHI === null) return newHI;
  return Math.min(newHI, currentLowHI);
}

// ─── FULL RECALCULATION RESULT ──────────────────────────────────────────────

export interface HandicapRecalcResult {
  phase: 1 | 2 | 3;
  handicapIndex: number | null;
  cappedHandicapIndex: number | null;
  lowHandicapIndex: number | null;
  isProvisional: boolean;
  differentialsUsed: number;
}

/**
 * Full WHS recalculation from a list of score differentials and current Low H.I.
 *
 * @param differentials  All recorded final differentials for the player, chronological order.
 * @param currentLowHI   The player's current Low H.I. (null on first calculation).
 * @returns Full recalculation result including phase, capped H.I., and new Low H.I.
 */
export function recalcHandicapIndex(
  differentials: number[],
  currentLowHI: number | null,
): HandicapRecalcResult {
  const n = differentials.length;

  const phase: 1 | 2 | 3 = n < 3 ? 1 : n < 20 ? 2 : 3;
  const hi = calculateHandicapIndex(differentials);

  if (hi === null) {
    return { phase: 1, handicapIndex: null, cappedHandicapIndex: null, lowHandicapIndex: currentLowHI, isProvisional: true, differentialsUsed: n };
  }

  const newLowHI = updateLowHI(hi, currentLowHI);
  const cappedHI = applyCaps(hi, newLowHI);

  return {
    phase,
    handicapIndex: hi,
    cappedHandicapIndex: cappedHI,
    lowHandicapIndex: newLowHI,
    isProvisional: phase !== 3,
    differentialsUsed: n,
  };
}
