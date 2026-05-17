/**
 * Strokes-Gained (SG) calculation engine — shot-level implementation.
 *
 * Consumes per-shot data from `shotsTable` (distanceToPin, shotType, holeNumber,
 * round, playerId, tournamentId). SG per shot is:
 *
 *   SG_shot = E(strokes from start position) − E(strokes from end position) − 1
 *
 * "End position" = the next shot's distanceToPin in the same hole/round,
 * or 0 (holed) when there is no subsequent shot.
 *
 * Expected-strokes lookup tables are based on PGA Tour ShotLink® averages
 * 2019-2023 (USGA/R&A handicap studies for 10/18-hcp baselines).
 *
 * Categories:
 *   SG:OTT      — tee shots on par-4/5 holes
 *   SG:Approach — fairway/approach shots
 *   SG:ATG      — chips, pitches, and sand shots (around-the-green)
 *   SG:Putting  — putts (shotType = "putt")
 *   SG:Total    — sum of all tracked categories
 *
 * Gating: require ≥5 rounds with at least one shot tracked before surfacing
 * any SG figure, to avoid noisy single-round estimates.
 */

import { db, shotsTable, scoresTable } from "@workspace/db";
import { and, inArray, isNotNull } from "drizzle-orm";

export type SGBaseline = "scratch" | "10" | "18";

/** What drove the resolved SG baseline — surfaced to the UI for copy. */
export type SgBaselineSource =
  | "preference" // player pinned this baseline manually
  | "handicap"   // derived from current handicap index
  | "default";   // no handicap on file → fall back to broadest cohort

/**
 * Pick the strokes-gained baseline a player should compare themselves
 * against by default, based on their current handicap index. Mirrors the
 * shape of `pickPrimaryProximityBaseline` so the SG card uses the same
 * personalisation pattern as the proximity-by-club card.
 *
 *   - HI ≤ 4   → scratch  (low-single-digit / scratch-class players)
 *   - HI ≤ 12  → 10       (mid-amateurs around the 10-hcp baseline)
 *   - HI > 12  → 18       (mid- and high-handicappers)
 *   - HI null  → 18       (no handicap on file → assume the broadest cohort
 *                          so a brand-new player isn't dropped straight
 *                          into a scratch comparison they have no chance of
 *                          beating)
 *
 * Thresholds intentionally mirror `pickPrimaryProximityBaseline` (≤4 / ≤12)
 * so the SG card and the proximity-by-club card always recommend the same
 * cohort tier for a given handicap — keeping the two personalisation
 * patterns in lockstep avoids confusing players with mismatched defaults.
 */
export function pickPrimarySgBaseline(handicapIndex: number | null | undefined): SGBaseline {
  if (handicapIndex === null || handicapIndex === undefined || !Number.isFinite(handicapIndex)) {
    return "18";
  }
  if (handicapIndex <= 4) return "scratch";
  if (handicapIndex <= 12) return "10";
  return "18";
}

/**
 * Resolve the effective SG baseline given:
 *   - an optional override from the request (`?baseline=...`)
 *   - the player's persisted preference (`app_users.preferred_sg_baseline`)
 *   - their current handicap index (auto-derivation fallback)
 *
 * The override and preference accept the literal string "auto" to mean
 * "use the handicap-derived baseline". Anything unrecognised is treated
 * as "auto" so a stale client never wedges the chart on a bogus value.
 */
export function resolveSgBaseline(input: {
  override?: string | null;
  preference?: string | null;
  handicapIndex?: number | null;
}): { primary: SGBaseline; source: SgBaselineSource } {
  const isPinned = (v: string | null | undefined): v is SGBaseline =>
    v === "scratch" || v === "10" || v === "18";

  if (isPinned(input.override)) return { primary: input.override, source: "preference" };
  if (isPinned(input.preference)) return { primary: input.preference, source: "preference" };
  if (input.handicapIndex !== null && input.handicapIndex !== undefined && Number.isFinite(input.handicapIndex)) {
    return { primary: pickPrimarySgBaseline(input.handicapIndex), source: "handicap" };
  }
  return { primary: pickPrimarySgBaseline(null), source: "default" };
}

/**
 * Lie types recognised by the SG engine. Off-green expected-strokes are
 * adjusted by a small additive penalty per non-fairway lie based on PGA
 * ShotLink lie/proximity studies (rough +0.10, sand +0.25, recovery +0.40).
 */
export type LieType = "tee" | "fairway" | "rough" | "sand" | "recovery" | "green";

const LIE_PENALTY: Record<LieType, number> = {
  tee:      0,
  fairway:  0,
  rough:    0.10,
  sand:     0.25,
  recovery: 0.40,
  green:    0,
};

export interface RoundSGResult {
  tournamentId: number;
  round: number;
  sgPutting: number | null;
  sgApproach: number | null;
  sgATG: number | null;
  sgOTT: number | null;
  sgTotal: number | null;
  shotsTracked: number;
  /**
   * How this round's SG-Putting was sourced:
   *   "measured"  — at least one putt-typed shot was tracked on the green
   *   "estimated" — SG-Putting derived entirely from the scorecard putt-count
   *                 fallback (no per-shot putt tracking on any hole)
   *   null        — the round did not contribute an SG-Putting figure
   */
  sgPuttingSource: "measured" | "estimated" | null;
}

export interface PlayerSGSummary {
  sgPutting: number | null;
  sgApproach: number | null;
  sgATG: number | null;
  sgOTT: number | null;
  sgTotal: number | null;
  trackedRounds: number;
  baseline: SGBaseline;
  roundResults: RoundSGResult[];
  /** Rounds whose SG-Putting figure came from per-shot tracking on the green. */
  sgPuttingMeasuredRounds: number;
  /** Rounds whose SG-Putting figure was estimated from the scorecard putt count. */
  sgPuttingEstimatedRounds: number;
}

// ── Expected-strokes lookup tables ────────────────────────────────────────────
//
// All distances are in YARDS from the pin.
// Tables: [distanceYards, expectedStrokes] pairs, interpolated linearly.

/** Expected strokes from a given PUTTING distance (yards on green). */
const PUTT_TABLE_SCRATCH: [number, number][] = [
  [0,    0],
  [0.5,  1.02],  // ~1.5 ft
  [1,    1.06],  // 3 ft
  [2,    1.24],  // 6 ft
  [3,    1.42],  // 9 ft
  [5,    1.62],  // 15 ft
  [7,    1.73],  // 21 ft
  [10,   1.93],  // 30 ft
  [13,   2.04],  // 40 ft
  [17,   2.12],  // 50 ft
  [20,   2.18],  // 60 ft
  [27,   2.25],  // 80 ft
  [40,   2.35],  // 120 ft
];

/** Expected strokes from off-green positions (chips, approach, tee). */
const OFFGREEN_TABLE_SCRATCH: [number, number][] = [
  [0,    0],
  [2,    1.80],  // fringe/very tight chip
  [5,    2.10],  // short chip
  [10,   2.35],
  [20,   2.55],
  [30,   2.70],
  [50,   2.85],
  [75,   3.00],
  [100,  3.17],
  [125,  3.30],
  [150,  3.40],
  [175,  3.50],
  [200,  3.60],
  [250,  3.75],
  [300,  3.90],
  [400,  4.10],
  [500,  4.30],
];

/**
 * Handicap adjustment per expected-strokes value.
 * We add this to the scratch baseline to get the handicap-level baseline.
 * (Higher handicap expects more strokes from the same position.)
 */
const BASELINE_ADJUSTMENT: Record<SGBaseline, number> = {
  scratch: 0,
  "10":    0.10,   // 10-hcp uses about 10% more strokes on average
  "18":    0.20,   // 18-hcp uses about 20% more strokes on average
};

/** Linear interpolation into a sorted [x, y][] lookup table. */
function interpolate(table: [number, number][], x: number): number {
  if (x <= 0) return 0;
  if (x >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
    }
  }
  return table[table.length - 1][1];
}

/** Expected strokes for a given shot position, baseline, lie, and whether it's a putt. */
function expectedStrokes(distanceYards: number, isPutt: boolean, baseline: SGBaseline, lie: LieType = "fairway"): number {
  const table = isPutt ? PUTT_TABLE_SCRATCH : OFFGREEN_TABLE_SCRATCH;
  const base = interpolate(table, distanceYards);
  if (base <= 0) return 0;
  const lieAdj = isPutt ? 0 : (LIE_PENALTY[lie] ?? 0);
  return base + BASELINE_ADJUSTMENT[baseline] + lieAdj;
}

/**
 * Per-shot SG breakdown — used by the per-hole review UI and AI Caddie feeds.
 * Returned in the same order as the input shots within each hole.
 */
export interface ShotSG {
  holeNumber: number;
  shotNumber: number;
  shotType: string;
  club: string | null;
  lieType: string | null;
  distanceBeforeYards: number | null;
  distanceAfterYards: number;
  category: "OTT" | "Approach" | "ATG" | "Putting";
  sg: number;
}

export interface HoleSG {
  holeNumber: number;
  par: number;
  shotsOnHole: number;
  sgPutting: number;
  sgApproach: number;
  sgATG: number;
  sgOTT: number;
  sgTotal: number;
  /**
   * True when SG-Putting for this hole was derived from the scorecard putt
   * count rather than per-shot tracking on the green. Players see a small
   * "~" prefix or muted style in the UI to set expectations.
   */
  puttingEstimated: boolean;
  shots: ShotSG[];
}

// ── Main SG computation ───────────────────────────────────────────────────────

const MIN_ROUNDS_FOR_SG = 5;
const MIN_SHOTS_PER_ROUND = 18; // at least one shot per hole on 18-hole round

/**
 * Structural shape required by the SG and analytics helpers. Nullable on
 * tournament/player so the same row type can describe both tournament shots
 * and casual general-play shots without forcing callers to cast.
 *
 * Made non-strict on optional fields so a `shotsTable.$inferSelect` row from
 * Drizzle (which may surface tournamentId/playerId as `number` in stale
 * generated dist types) is still assignable to `ShotRow`.
 */
export type ShotRow = {
  id: number;
  tournamentId: number | null;
  playerId: number | null;
  generalPlayRoundId?: number | null;
  userId?: number | null;
  round: number;
  holeNumber: number;
  shotNumber: number;
  shotType: string;
  club?: string | null;
  lieType?: string | null;
  missDirection?: string | null;
  distanceToPin: string | null;
  distanceCarried?: string | null;
  recordedAt: Date;
};

/** Field subset actually consumed by the analytics functions below. */
type AnalyticsShot = {
  tournamentId?: number | null;
  generalPlayRoundId?: number | null;
  round: number;
  holeNumber: number;
  shotNumber: number;
  shotType: string;
  club?: string | null;
  lieType?: string | null;
  missDirection?: string | null;
  distanceToPin: string | null;
  distanceCarried?: string | null;
  // Task #2039 — weekly proximity sparkline needs a per-shot timestamp to
  // bucket each approach into one of the trailing N weeks. Optional so
  // existing aggregators (`computeProximityByClub`, etc.) keep working when
  // callers don't bother to populate it.
  recordedAt?: Date | null;
};

export type HoleParMap = Map<number, number>; // holeNumber → par
export type HolePuttsMap = Map<number, number>; // holeNumber → recorded putt count (scorecard)

export interface RoundShotData {
  tournamentId: number;
  round: number;
  shots: ShotRow[];
  holePars: HoleParMap;
  /**
   * Optional per-hole putt counts from the scorecard (`scoresTable.putts` or
   * `generalPlayHoleScoresTable.putts`). When provided, holes without any
   * putt-typed shots in `shots` fall back to a scorecard-derived SG-Putting
   * estimate so rounds without full shot tracking still get a putting number.
   */
  holePutts?: HolePuttsMap;
}

/**
 * Expected strokes a baseline player needs to hole out from a "typical" first
 * putt distance (≈33 ft / 11 yards — the PGA Tour mean first-putt distance
 * after a green-in-regulation). Used as the expected-strokes value when we
 * derive SG-Putting from a scorecard putt count rather than per-shot data.
 *
 * When `distanceYards` is provided, that explicit starting distance is used
 * instead of the 11-yard default — letting partially-tracked holes use the
 * actual approach landing distance for a sharper SG-Putting estimate.
 */
export function expectedFirstPuttStrokes(baseline: SGBaseline = "scratch", distanceYards: number = 11): number {
  return expectedStrokes(distanceYards, true, baseline);
}

/**
 * Maximum distance (yards) we'll trust a non-putt shot's `distanceToPin` as a
 * proxy for a first-putt starting distance. Anything beyond this is almost
 * certainly off the green and not a meaningful putt-length estimate.
 */
const FIRST_PUTT_INFERENCE_MAX_YARDS = 30;

/**
 * If the last tracked shot on a hole was a non-putt that finished close enough
 * to the pin to plausibly be on the green, return its `distanceToPin` (yards)
 * to use as the starting first-putt distance for the scorecard fallback.
 * Returns `null` when no usable inference is available.
 */
function inferFirstPuttDistanceYards(holeShots: ReadonlyArray<ShotRow>): number | null {
  if (holeShots.length === 0) return null;
  const last = holeShots[holeShots.length - 1];
  if (last.shotType === "putt") return null;
  if (last.distanceToPin === null) return null;
  const d = parseFloat(last.distanceToPin);
  if (!Number.isFinite(d) || d <= 0) return null;
  return d <= FIRST_PUTT_INFERENCE_MAX_YARDS ? d : null;
}

/**
 * Compute SG metrics for a single round's shot data.
 */
export function computeRoundSGFromShots(
  round: RoundShotData,
  baseline: SGBaseline = "scratch",
): RoundSGResult {
  const base: RoundSGResult = {
    tournamentId: round.tournamentId, round: round.round,
    sgPutting: null, sgApproach: null, sgATG: null, sgOTT: null, sgTotal: null,
    shotsTracked: round.shots.length,
    sgPuttingSource: null,
  };

  const hasFullShotData = round.shots.length >= MIN_SHOTS_PER_ROUND;
  const hasPuttsFallback = (round.holePutts?.size ?? 0) > 0;
  if (!hasFullShotData && !hasPuttsFallback) return base;

  // Group shots by hole number, sorted by shotNumber
  const byHole = new Map<number, ShotRow[]>();
  for (const s of round.shots) {
    if (!byHole.has(s.holeNumber)) byHole.set(s.holeNumber, []);
    byHole.get(s.holeNumber)!.push(s);
  }
  for (const arr of byHole.values()) arr.sort((a, b) => a.shotNumber - b.shotNumber);

  let sgP = 0, sgA = 0, sgAtg = 0, sgO = 0;
  let cntP = 0, cntA = 0, cntAtg = 0, cntO = 0;

  // Track which holes have at least one tracked putt so we know whether to
  // fall back to a scorecard-derived SG-Putting estimate for that hole.
  const holesWithPuttShots = new Set<number>();

  if (hasFullShotData) for (const [holeNum, shots] of byHole.entries()) {
    const par = round.holePars.get(holeNum) ?? 4;

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const nextShot = shots[i + 1];

      const distBefore = shot.distanceToPin !== null ? parseFloat(shot.distanceToPin) : null;
      if (distBefore === null) continue; // no GPS data, skip

      const distAfter = nextShot?.distanceToPin !== null && nextShot?.distanceToPin !== undefined
        ? parseFloat(nextShot.distanceToPin)
        : 0; // holed

      const isPutt = shot.shotType === "putt";
      const isNextPutt = nextShot?.shotType === "putt" || nextShot === undefined;

      const E_before = expectedStrokes(distBefore, isPutt, baseline);
      const E_after = expectedStrokes(distAfter, isNextPutt, baseline);

      const sg = E_before - E_after - 1;

      // Categorise by shot type
      if (isPutt) {
        sgP += sg; cntP++;
        holesWithPuttShots.add(holeNum);
      } else if (shot.shotType === "tee" && par >= 4) {
        sgO += sg; cntO++;
      } else if (shot.shotType === "chip" || shot.shotType === "sand") {
        sgAtg += sg; cntAtg++;
      } else {
        // fairway / approach
        sgA += sg; cntA++;
      }
    }
  }

  // Scorecard-derived SG-Putting fallback: for any hole with a recorded putt
  // count but no putt-typed shots (no per-shot tracking on the green), estimate
  // SG-Putting against the typical first-putt baseline. This lets rounds with
  // voice/manual scorecard putt entry contribute to SG-Putting even when full
  // shot tracking is absent.
  if (round.holePutts) {
    const eFirstPuttDefault = expectedFirstPuttStrokes(baseline);
    for (const [holeNum, putts] of round.holePutts.entries()) {
      if (holesWithPuttShots.has(holeNum)) continue;
      if (!Number.isFinite(putts) || putts <= 0) continue;
      const inferredDist = inferFirstPuttDistanceYards(byHole.get(holeNum) ?? []);
      const eFirstPutt = inferredDist !== null
        ? expectedFirstPuttStrokes(baseline, inferredDist)
        : eFirstPuttDefault;
      sgP += eFirstPutt - putts;
      cntP++;
    }
  }

  const round2dp = (v: number) => Math.round(v * 100) / 100;
  const resultP  = cntP  > 0 ? round2dp(sgP)  : null;
  const resultA  = cntA  > 0 ? round2dp(sgA)  : null;
  const resultAtg = cntAtg > 0 ? round2dp(sgAtg) : null;
  const resultO  = cntO  > 0 ? round2dp(sgO)  : null;

  const parts = [resultP, resultA, resultAtg, resultO].filter(v => v !== null) as number[];
  const resultTotal = parts.length > 0 ? round2dp(parts.reduce((a, b) => a + b, 0)) : null;

  const sgPuttingSource: RoundSGResult["sgPuttingSource"] =
    resultP === null ? null : (holesWithPuttShots.size > 0 ? "measured" : "estimated");

  return {
    ...base,
    sgPutting: resultP, sgApproach: resultA, sgATG: resultAtg, sgOTT: resultO, sgTotal: resultTotal,
    shotsTracked: round.shots.length,
    sgPuttingSource,
  };
}

/**
 * Fetch all shot data for a set of player IDs and compute their SG summary.
 * This is the primary API called from the stats endpoint.
 *
 * @param tournamentHolePars   fallback per-tournament hole par map (single course)
 * @param tournamentRoundHolePars  optional per-tournament per-round hole par map;
 *   when provided, the round-specific map takes precedence over the tournament-level
 *   fallback, enabling correct SG baselines for multi-course championships.
 */
export async function computePlayerSGFromDB(
  playerIds: number[],
  baseline: SGBaseline = "scratch",
  tournamentHolePars: Map<number, HoleParMap> = new Map(),
  tournamentRoundHolePars: Map<number, Map<number, HoleParMap>> = new Map(),
): Promise<PlayerSGSummary> {
  const empty: PlayerSGSummary = {
    sgPutting: null, sgApproach: null, sgATG: null, sgOTT: null, sgTotal: null,
    trackedRounds: 0, baseline, roundResults: [],
    sgPuttingMeasuredRounds: 0, sgPuttingEstimatedRounds: 0,
  };

  if (playerIds.length === 0) return empty;

  // Fetch all shots and per-hole putt counts for these players in parallel.
  // Putt counts feed the SG-Putting fallback for rounds whose green play
  // isn't covered by per-shot tracking but where putts were captured via
  // voice / manual scorecard entry.
  const [allShots, allPuttRows] = await Promise.all([
    db.select().from(shotsTable).where(inArray(shotsTable.playerId, playerIds)),
    db.select({
      playerId: scoresTable.playerId,
      tournamentId: scoresTable.tournamentId,
      round: scoresTable.round,
      holeNumber: scoresTable.holeNumber,
      putts: scoresTable.putts,
    }).from(scoresTable).where(and(
      inArray(scoresTable.playerId, playerIds),
      isNotNull(scoresTable.putts),
    )),
  ]);

  if (allShots.length === 0 && allPuttRows.length === 0) return empty;

  // Group by playerId+tournamentId+round
  const roundMap = new Map<string, { tournamentId: number; playerId: number; round: number; shots: ShotRow[]; holePutts: HolePuttsMap }>();
  const ensureRound = (playerId: number, tournamentId: number, round: number) => {
    const k = `${playerId}-${tournamentId}-${round}`;
    let r = roundMap.get(k);
    if (!r) {
      r = { tournamentId, playerId, round, shots: [], holePutts: new Map() };
      roundMap.set(k, r);
    }
    return r;
  };
  for (const s of allShots) {
    if (s.playerId == null || s.tournamentId == null) continue;
    ensureRound(s.playerId, s.tournamentId, s.round).shots.push(s as ShotRow);
  }
  for (const p of allPuttRows) {
    if (p.putts === null) continue;
    ensureRound(p.playerId, p.tournamentId, p.round).holePutts.set(p.holeNumber, p.putts);
  }

  // Compute SG for each round
  const roundResults: RoundSGResult[] = [];
  for (const { tournamentId, round, shots, holePutts } of roundMap.values()) {
    // Prefer per-round par map (multi-course) over per-tournament fallback
    const holePars =
      tournamentRoundHolePars.get(tournamentId)?.get(round)
      ?? tournamentHolePars.get(tournamentId)
      ?? new Map<number, number>();
    const result = computeRoundSGFromShots({ tournamentId, round, shots, holePars, holePutts }, baseline);
    // Include the round if it has a usable SG-Putting estimate from the
    // scorecard fallback, even when full shot tracking is missing.
    if (result.shotsTracked >= MIN_SHOTS_PER_ROUND || result.sgPutting !== null) {
      roundResults.push(result);
    }
  }

  const trackedRounds = roundResults.length;
  const sgPuttingMeasuredRounds = roundResults.filter(r => r.sgPuttingSource === "measured").length;
  const sgPuttingEstimatedRounds = roundResults.filter(r => r.sgPuttingSource === "estimated").length;
  if (trackedRounds < MIN_ROUNDS_FOR_SG) {
    return { ...empty, trackedRounds, roundResults, sgPuttingMeasuredRounds, sgPuttingEstimatedRounds };
  }

  // Average each category across all rounds that have data for it
  function avgOf(key: keyof Pick<RoundSGResult, "sgPutting" | "sgApproach" | "sgATG" | "sgOTT" | "sgTotal">): number | null {
    const vals = roundResults.map(r => r[key]).filter(v => v !== null) as number[];
    if (vals.length < 3) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  }

  const sgPutting = avgOf("sgPutting");
  const sgApproach = avgOf("sgApproach");
  const sgATG = avgOf("sgATG");
  const sgOTT = avgOf("sgOTT");
  const parts = [sgPutting, sgApproach, sgATG, sgOTT].filter(v => v !== null) as number[];
  const sgTotal = parts.length > 0 ? Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100 : null;

  return { sgPutting, sgApproach, sgATG, sgOTT, sgTotal, trackedRounds, baseline, roundResults: roundResults.slice(-20), sgPuttingMeasuredRounds, sgPuttingEstimatedRounds };
}

// ── Per-hole / per-shot SG breakdown ──────────────────────────────────────────

/**
 * Compute strokes-gained for a single round broken down by hole and by shot.
 * Used for the per-hole SG card in the mobile app and for AI Caddie feeds —
 * we deliberately skip the ≥5-rounds gating since this is a deterministic
 * per-shot calculation, not an aggregate over noisy estimates.
 */
export function computePerHoleSGFromShots(
  shots: ShotRow[],
  holePars: HoleParMap,
  baseline: SGBaseline = "scratch",
  holePutts?: HolePuttsMap,
): HoleSG[] {
  if (shots.length === 0 && (holePutts?.size ?? 0) === 0) return [];

  const byHole = new Map<number, ShotRow[]>();
  for (const s of shots) {
    if (!byHole.has(s.holeNumber)) byHole.set(s.holeNumber, []);
    byHole.get(s.holeNumber)!.push(s);
  }
  for (const arr of byHole.values()) arr.sort((a, b) => a.shotNumber - b.shotNumber);

  // Iterate the union of holes that have shots and holes that only have a
  // scorecard-derived putt count, so the per-hole card surfaces SG-Putting
  // even on holes (or whole rounds) without per-shot tracking.
  const allHoleNumbers = new Set<number>(byHole.keys());
  if (holePutts) for (const h of holePutts.keys()) allHoleNumbers.add(h);

  const eFirstPuttDefault = expectedFirstPuttStrokes(baseline);

  const out: HoleSG[] = [];
  for (const holeNumber of [...allHoleNumbers].sort((a, b) => a - b)) {
    const holeShots = byHole.get(holeNumber) ?? [];
    const par = holePars.get(holeNumber) ?? 4;
    const shotSGs: ShotSG[] = [];
    let sgP = 0, sgA = 0, sgAtg = 0, sgO = 0;
    let hasPuttShot = false;

    for (let i = 0; i < holeShots.length; i++) {
      const shot = holeShots[i];
      const next = holeShots[i + 1];
      const distBefore = shot.distanceToPin !== null ? parseFloat(shot.distanceToPin) : null;
      if (distBefore === null) continue;
      const distAfter = next?.distanceToPin !== null && next?.distanceToPin !== undefined ? parseFloat(next.distanceToPin) : 0;

      const isPutt = shot.shotType === "putt";
      const isNextPutt = next?.shotType === "putt" || next === undefined;
      const lie = (shot.lieType as LieType | null) ?? (isPutt ? "green" : "fairway");

      const E_before = expectedStrokes(distBefore, isPutt, baseline, lie);
      const E_after = expectedStrokes(distAfter, isNextPutt, baseline, isNextPutt ? "green" : "fairway");
      const sg = Math.round((E_before - E_after - 1) * 100) / 100;

      let category: ShotSG["category"];
      if (isPutt) { category = "Putting"; sgP += sg; hasPuttShot = true; }
      else if (shot.shotType === "tee" && par >= 4) { category = "OTT"; sgO += sg; }
      else if (shot.shotType === "chip" || shot.shotType === "sand") { category = "ATG"; sgAtg += sg; }
      else { category = "Approach"; sgA += sg; }

      shotSGs.push({
        holeNumber, shotNumber: shot.shotNumber, shotType: shot.shotType,
        club: shot.club ?? null, lieType: shot.lieType ?? null,
        distanceBeforeYards: distBefore, distanceAfterYards: distAfter,
        category, sg,
      });
    }

    // Scorecard fallback: if no putt-typed shots were tracked on this hole but
    // a putt count was recorded (voice/manual scorecard entry), estimate the
    // hole's SG-Putting from the typical first-putt baseline.
    const recordedPutts = holePutts?.get(holeNumber);
    if (!hasPuttShot && recordedPutts !== undefined && Number.isFinite(recordedPutts) && recordedPutts > 0) {
      const inferredDist = inferFirstPuttDistanceYards(holeShots);
      const eFirstPutt = inferredDist !== null
        ? expectedFirstPuttStrokes(baseline, inferredDist)
        : eFirstPuttDefault;
      sgP += eFirstPutt - recordedPutts;
    }

    const r2 = (v: number) => Math.round(v * 100) / 100;
    const puttingEstimated =
      !hasPuttShot &&
      recordedPutts !== undefined &&
      Number.isFinite(recordedPutts) &&
      recordedPutts > 0;
    out.push({
      holeNumber, par, shotsOnHole: holeShots.length,
      sgPutting: r2(sgP), sgApproach: r2(sgA), sgATG: r2(sgAtg), sgOTT: r2(sgO),
      sgTotal: r2(sgP + sgA + sgAtg + sgO),
      puttingEstimated,
      shots: shotSGs,
    });
  }
  return out;
}

// ── Analytics helpers (dispersion / proximity / putting make-rate) ────────────

/** Distance bands used for the proximity-by-distance-band chart (yards). */
export const PROXIMITY_BANDS: Array<{ label: string; min: number; max: number }> = [
  { label: "<50",     min: 0,   max: 50 },
  { label: "50-100",  min: 50,  max: 100 },
  { label: "100-150", min: 100, max: 150 },
  { label: "150-175", min: 150, max: 175 },
  { label: "175-200", min: 175, max: 200 },
  { label: "200-225", min: 200, max: 225 },
  { label: "225+",    min: 225, max: 9999 },
];

export interface ProximityBandStat {
  band: string;
  shots: number;
  avgProximityFt: number | null;
  greensHit: number;
  greenInRegPct: number | null;
}

/**
 * Group approach/wedge shots into yardage bands, returning average proximity
 * to the pin (in feet) after the shot and a green-in-regulation rate.
 * A shot is considered to "hit the green" if the next shot in the hole is a putt.
 */
export function computeProximityBands(shots: AnalyticsShot[]): ProximityBandStat[] {
  const byHole = new Map<string, AnalyticsShot[]>();
  for (const s of shots) {
    const k = `${s.tournamentId ?? "g"}-${s.generalPlayRoundId ?? "t"}-${s.round}-${s.holeNumber}`;
    if (!byHole.has(k)) byHole.set(k, []);
    byHole.get(k)!.push(s);
  }
  for (const arr of byHole.values()) arr.sort((a, b) => a.shotNumber - b.shotNumber);

  const buckets: Record<string, { proxFt: number[]; hits: number; total: number }> =
    Object.fromEntries(PROXIMITY_BANDS.map(b => [b.label, { proxFt: [], hits: 0, total: 0 }]));

  for (const arr of byHole.values()) {
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (s.shotType === "putt" || s.shotType === "tee") continue;
      const dist = s.distanceToPin !== null ? parseFloat(s.distanceToPin) : null;
      if (dist === null) continue;
      const band = PROXIMITY_BANDS.find(b => dist >= b.min && dist < b.max);
      if (!band) continue;
      const next = arr[i + 1];
      const nextDist = next?.distanceToPin !== null && next?.distanceToPin !== undefined ? parseFloat(next.distanceToPin) : 0;
      buckets[band.label].total++;
      buckets[band.label].proxFt.push(nextDist * 3); // yards → feet
      if (next?.shotType === "putt" || next === undefined) buckets[band.label].hits++;
    }
  }

  return PROXIMITY_BANDS.map(b => {
    const bk = buckets[b.label];
    return {
      band: b.label,
      shots: bk.total,
      avgProximityFt: bk.proxFt.length > 0 ? Math.round((bk.proxFt.reduce((a, c) => a + c, 0) / bk.proxFt.length) * 10) / 10 : null,
      greensHit: bk.hits,
      greenInRegPct: bk.total > 0 ? Math.round((bk.hits / bk.total) * 1000) / 10 : null,
    };
  });
}

export interface PuttingMakeRate {
  band: string;
  attempts: number;
  makes: number;
  makePct: number | null;
}

/** Putting make-rates bucketed by remaining distance (in feet). */
export const PUTT_BANDS: Array<{ label: string; min: number; max: number }> = [
  { label: "<3 ft",  min: 0,  max: 3 },
  { label: "3-5",    min: 3,  max: 5 },
  { label: "5-10",   min: 5,  max: 10 },
  { label: "10-15",  min: 10, max: 15 },
  { label: "15-25",  min: 15, max: 25 },
  { label: "25+",    min: 25, max: 999 },
];

export function computePuttingMakeRates(shots: AnalyticsShot[]): PuttingMakeRate[] {
  const byHole = new Map<string, AnalyticsShot[]>();
  for (const s of shots) {
    const k = `${s.tournamentId ?? "g"}-${s.generalPlayRoundId ?? "t"}-${s.round}-${s.holeNumber}`;
    if (!byHole.has(k)) byHole.set(k, []);
    byHole.get(k)!.push(s);
  }
  for (const arr of byHole.values()) arr.sort((a, b) => a.shotNumber - b.shotNumber);

  const buckets: Record<string, { attempts: number; makes: number }> =
    Object.fromEntries(PUTT_BANDS.map(b => [b.label, { attempts: 0, makes: 0 }]));

  for (const arr of byHole.values()) {
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (s.shotType !== "putt") continue;
      const distYards = s.distanceToPin !== null ? parseFloat(s.distanceToPin) : null;
      if (distYards === null) continue;
      const distFt = distYards * 3;
      const band = PUTT_BANDS.find(b => distFt >= b.min && distFt < b.max);
      if (!band) continue;
      buckets[band.label].attempts++;
      const next = arr[i + 1];
      if (next === undefined) buckets[band.label].makes++; // last shot in hole = made putt
    }
  }
  return PUTT_BANDS.map(b => ({
    band: b.label,
    attempts: buckets[b.label].attempts,
    makes: buckets[b.label].makes,
    makePct: buckets[b.label].attempts > 0
      ? Math.round((buckets[b.label].makes / buckets[b.label].attempts) * 1000) / 10
      : null,
  }));
}

export interface ProximityBenchmark {
  /** Canonical club key the player's club resolved to (e.g. "7i", "pw"). */
  clubKey: string;
  /** PGA Tour mean proximity (ft) — based on 2019-2023 ShotLink iron studies. */
  tourMeanFt: number;
  /** Scratch / low-handicap amateur mean proximity (ft). */
  scratchMeanFt: number;
  /** Mid-handicap (≈15-18 hcp) mean proximity (ft). */
  midHandicapMeanFt: number;
}

/**
 * Which of the three proximity benchmarks the chart should treat as the
 * "primary" comparison for the player. The other two stay available behind
 * a toggle so players can still see them, but only the primary is in the
 * default view + tooltip headline.
 */
export type ProximityPrimaryBaseline = "tour" | "scratch" | "mid";

/** What drove the resolved primary baseline — surfaced to the UI for copy. */
export type ProximityBaselineSource =
  | "preference" // player pinned this baseline manually
  | "handicap"   // derived from current handicap index
  | "default";   // no handicap on file → fall back to mid-handicap

/**
 * Pick the proximity benchmark a player should compare themselves against by
 * default, based on their current handicap index. The thresholds match the
 * shape of `PROXIMITY_BENCHMARKS_FT` (tour < scratch < mid-handicap):
 *
 *   - HI ≤ 4   → tour     (low-single-digit / scratch-class players)
 *   - HI ≤ 12  → scratch  (good amateurs, club champions)
 *   - HI > 12  → mid      (mid- and high-handicappers)
 *   - HI null  → mid      (no handicap on file → assume the broadest cohort)
 *
 * Choosing "mid" as the unknown-handicap fallback (rather than "tour") avoids
 * dropping a 22-handicap newcomer straight into a tour comparison the moment
 * they sign up but haven't posted a handicap yet.
 */
export function pickPrimaryProximityBaseline(handicapIndex: number | null | undefined): ProximityPrimaryBaseline {
  if (handicapIndex === null || handicapIndex === undefined || !Number.isFinite(handicapIndex)) {
    return "mid";
  }
  if (handicapIndex <= 4) return "tour";
  if (handicapIndex <= 12) return "scratch";
  return "mid";
}

/**
 * Resolve the effective primary baseline given:
 *   - an optional override from the request (`?baseline=...`)
 *   - the player's persisted preference (`app_users.preferred_proximity_baseline`)
 *   - their current handicap index (auto-derivation fallback)
 *
 * The override and preference accept the literal string "auto" to mean
 * "use the handicap-derived baseline". Anything unrecognised is treated as
 * "auto" so a stale client never wedges the chart on a bogus value.
 */
export function resolveProximityBaseline(input: {
  override?: string | null;
  preference?: string | null;
  handicapIndex?: number | null;
}): { primary: ProximityPrimaryBaseline; source: ProximityBaselineSource } {
  const isPinned = (v: string | null | undefined): v is ProximityPrimaryBaseline =>
    v === "tour" || v === "scratch" || v === "mid";

  if (isPinned(input.override)) return { primary: input.override, source: "preference" };
  if (isPinned(input.preference)) return { primary: input.preference, source: "preference" };
  if (input.handicapIndex !== null && input.handicapIndex !== undefined && Number.isFinite(input.handicapIndex)) {
    return { primary: pickPrimaryProximityBaseline(input.handicapIndex), source: "handicap" };
  }
  return { primary: pickPrimaryProximityBaseline(null), source: "default" };
}

/**
 * Per-club mean approach-proximity benchmarks (in feet) derived from public
 * PGA Tour ShotLink® summaries 2019-2023 (tour) and Arccos / USGA handicap
 * proximity studies (scratch and mid-hcp). These are intentionally a static
 * table — they don't need to react to a player's actual yardages, only to the
 * club used. A player whose 7-iron averages 30 ft from any distance is still
 * "tour-tight" with that club.
 *
 * Keys are the canonical, normalised club identifiers produced by
 * `normalizeClubForBenchmark` (see below).
 */
export const PROXIMITY_BENCHMARKS_FT: Record<string, Omit<ProximityBenchmark, "clubKey">> = {
  driver: { tourMeanFt: 65, scratchMeanFt: 78, midHandicapMeanFt: 110 },
  "3w":   { tourMeanFt: 55, scratchMeanFt: 66, midHandicapMeanFt: 95 },
  "5w":   { tourMeanFt: 50, scratchMeanFt: 60, midHandicapMeanFt: 86 },
  "7w":   { tourMeanFt: 45, scratchMeanFt: 54, midHandicapMeanFt: 78 },
  "2h":   { tourMeanFt: 48, scratchMeanFt: 58, midHandicapMeanFt: 82 },
  "3h":   { tourMeanFt: 45, scratchMeanFt: 54, midHandicapMeanFt: 76 },
  "4h":   { tourMeanFt: 42, scratchMeanFt: 50, midHandicapMeanFt: 70 },
  "5h":   { tourMeanFt: 39, scratchMeanFt: 47, midHandicapMeanFt: 65 },
  "3i":   { tourMeanFt: 44, scratchMeanFt: 52, midHandicapMeanFt: 73 },
  "4i":   { tourMeanFt: 41, scratchMeanFt: 49, midHandicapMeanFt: 68 },
  "5i":   { tourMeanFt: 38, scratchMeanFt: 45, midHandicapMeanFt: 62 },
  "6i":   { tourMeanFt: 35, scratchMeanFt: 41, midHandicapMeanFt: 56 },
  "7i":   { tourMeanFt: 31, scratchMeanFt: 36, midHandicapMeanFt: 50 },
  "8i":   { tourMeanFt: 27, scratchMeanFt: 32, midHandicapMeanFt: 44 },
  "9i":   { tourMeanFt: 24, scratchMeanFt: 28, midHandicapMeanFt: 39 },
  pw:     { tourMeanFt: 21, scratchMeanFt: 25, midHandicapMeanFt: 34 },
  gw:     { tourMeanFt: 19, scratchMeanFt: 23, midHandicapMeanFt: 31 },
  sw:     { tourMeanFt: 18, scratchMeanFt: 22, midHandicapMeanFt: 30 },
  lw:     { tourMeanFt: 17, scratchMeanFt: 21, midHandicapMeanFt: 29 },
};

/**
 * Normalise a free-text club label into one of the canonical benchmark keys
 * above. Handles the most common ways players spell their clubs in the app:
 *   "7i", "7 iron", "7-iron", "iron 7", "7" → "7i"
 *   "PW", "pitching wedge", "wedge"        → "pw"
 *   "AW", "GW", "gap wedge", "approach wedge" → "gw"
 *   "SW", "sand wedge", "56°"              → "sw"
 *   "LW", "lob wedge", "60°"               → "lw"
 *   "Driver", "1w", "D"                    → "driver"
 *   "3w", "3 wood"                         → "3w"
 *   "3h", "3-hybrid", "hybrid 3"           → "3h"
 *
 * Returns `null` when the club can't be confidently mapped (e.g. "putter",
 * "chipper", or an unrecognised value) — callers should treat that as "no
 * benchmark available" rather than guess.
 */
export function normalizeClubForBenchmark(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const c = raw.trim().toLowerCase().replace(/[\s\-_°]/g, "");
  if (c.length === 0) return null;
  if (PROXIMITY_BENCHMARKS_FT[c]) return c;

  // Direct word aliases
  const aliases: Record<string, string> = {
    driver: "driver", "1w": "driver", d: "driver",
    pitching: "pw", pitchingwedge: "pw", wedge: "pw", p: "pw",
    aw: "gw", approach: "gw", approachwedge: "gw", gap: "gw", gapwedge: "gw",
    sand: "sw", sandwedge: "sw",
    lob: "lw", lobwedge: "lw",
  };
  if (c in aliases) return aliases[c];

  // Loft → wedge mapping (degrees as written or stripped)
  const loftMatch = c.match(/^(\d{2})$/);
  if (loftMatch) {
    const deg = parseInt(loftMatch[1], 10);
    if (deg >= 58) return "lw";
    if (deg >= 55) return "sw";
    if (deg >= 50) return "gw";
    if (deg >= 45) return "pw";
  }

  // "7iron" / "iron7"
  const ironMatch = c.match(/^(\d)i(?:ron)?$/) ?? c.match(/^iron(\d)$/);
  if (ironMatch) {
    const key = `${ironMatch[1]}i`;
    if (PROXIMITY_BENCHMARKS_FT[key]) return key;
  }

  // "3hybrid" / "hybrid3"
  const hybridMatch = c.match(/^(\d)h(?:ybrid)?$/) ?? c.match(/^hybrid(\d)$/);
  if (hybridMatch) {
    const key = `${hybridMatch[1]}h`;
    if (PROXIMITY_BENCHMARKS_FT[key]) return key;
  }

  // "3wood" / "wood3"
  const woodMatch = c.match(/^(\d)w(?:ood)?$/) ?? c.match(/^wood(\d)$/);
  if (woodMatch) {
    const key = `${woodMatch[1]}w`;
    if (PROXIMITY_BENCHMARKS_FT[key]) return key;
  }

  // Bare digit "3"-"9" → assume iron
  const numAlone = c.match(/^([3-9])$/);
  if (numAlone) {
    const key = `${numAlone[1]}i`;
    if (PROXIMITY_BENCHMARKS_FT[key]) return key;
  }

  return null;
}

/** Look up the static tour / scratch / mid-handicap proximity benchmark for a club. */
export function lookupProximityBenchmark(clubLabel: string | null | undefined): ProximityBenchmark | null {
  const key = normalizeClubForBenchmark(clubLabel ?? null);
  if (key === null) return null;
  const row = PROXIMITY_BENCHMARKS_FT[key];
  if (!row) return null;
  return { clubKey: key, ...row };
}

export interface ProximityByClubStat {
  club: string;
  shots: number;
  meanProximityFt: number | null;
  p90ProximityFt: number | null;
  greenInRegPct: number | null;
  /**
   * Static tour / scratch / mid-handicap mean-proximity benchmarks for this
   * club, when we can normalise the player's club label to a known canonical
   * key. `null` when the label can't be mapped (e.g. unusual spellings).
   */
  benchmark: ProximityBenchmark | null;
}

/**
 * Group approach/wedge shots by *club* and report mean & p90 proximity to the
 * pin (in feet) for the next-shot landing distance, plus a green-in-regulation
 * rate. A shot is considered to "hit the green" when the next shot in the hole
 * is a putt (or there is no next shot — i.e. holed out from off the green).
 *
 * Mirrors `computeProximityBands` but slices by club rather than yardage band,
 * giving players a "with my 7-iron I average X feet from the pin" view.
 */
export function computeProximityByClub(shots: AnalyticsShot[]): ProximityByClubStat[] {
  const byHole = new Map<string, AnalyticsShot[]>();
  for (const s of shots) {
    const k = `${s.tournamentId ?? "g"}-${s.generalPlayRoundId ?? "t"}-${s.round}-${s.holeNumber}`;
    if (!byHole.has(k)) byHole.set(k, []);
    byHole.get(k)!.push(s);
  }
  for (const arr of byHole.values()) arr.sort((a, b) => a.shotNumber - b.shotNumber);

  const buckets = new Map<string, { proxFt: number[]; hits: number; total: number }>();

  for (const arr of byHole.values()) {
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (!s.club) continue;
      if (s.shotType === "putt" || s.shotType === "tee") continue;
      // Only count shots played from outside the green — these are the
      // "approach"-style shots where proximity-by-club matters. We use the
      // distance-to-pin of the *current* shot as its "from" distance and the
      // *next* shot's distance-to-pin as the proximity outcome.
      const fromDist = s.distanceToPin !== null ? parseFloat(s.distanceToPin) : null;
      if (fromDist === null) continue;
      const next = arr[i + 1];
      const nextDist = next?.distanceToPin !== null && next?.distanceToPin !== undefined
        ? parseFloat(next.distanceToPin)
        : 0;
      const club = s.club;
      if (!buckets.has(club)) buckets.set(club, { proxFt: [], hits: 0, total: 0 });
      const b = buckets.get(club)!;
      b.total++;
      b.proxFt.push(nextDist * 3); // yards → feet
      if (next?.shotType === "putt" || next === undefined) b.hits++;
    }
  }

  const out: ProximityByClubStat[] = [];
  for (const [club, b] of buckets.entries()) {
    const sorted = [...b.proxFt].sort((a, c) => a - c);
    const mean = sorted.length > 0 ? sorted.reduce((a, c) => a + c, 0) / sorted.length : null;
    // p90 = the value below which 90% of observations fall. With <10 shots we
    // fall back to the maximum so the chart still has a "worst-case" data point.
    const p90 = sorted.length > 0
      ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]
      : null;
    out.push({
      club,
      shots: b.total,
      meanProximityFt: mean !== null ? Math.round(mean * 10) / 10 : null,
      p90ProximityFt: p90 !== null ? Math.round(p90 * 10) / 10 : null,
      greenInRegPct: b.total > 0 ? Math.round((b.hits / b.total) * 1000) / 10 : null,
      benchmark: lookupProximityBenchmark(club),
    });
  }
  // Sort by mean proximity ascending (best clubs first) so the chart reads
  // left-to-right from "tightest" to "loosest" club.
  return out.sort((a, b) => (a.meanProximityFt ?? Infinity) - (b.meanProximityFt ?? Infinity));
}

// ── Task #1348 — proximity-vs-tour coaching tips ─────────────────────────────
//
// Players already see the per-club tour benchmark on the proximity chart
// (Task #1168). The chart shows the gap, but a player still has to read it
// and decide what to do about it. The functions below convert the raw gap
// into a short coaching tip — names the club, quotes the current and
// reference proximities, and suggests a practice distance — so the data
// becomes an action ("work on this club") rather than a number to interpret.
//
// The same shape is consumed by the AI Caddie engine so on-course advice
// ("you're 8 ft worse with the 7-iron — aim 5 ft long of pin") stays
// consistent with the post-round coaching callout.

/**
 * Typical practice distance (yards) for each canonical club key. These are
 * the distances a player would set up at on a range or on-course practice
 * facility to dial in that club. Conservative amateur reference values —
 * not tour distances, since the coaching tip is aimed at the player who
 * sees a gap they want to close.
 */
const PRACTICE_DISTANCE_YARDS_BY_CLUB: Record<string, number> = {
  driver: 250,
  "3w":   220,
  "5w":   200,
  "7w":   180,
  "2h":   200,
  "3h":   190,
  "4h":   180,
  "5h":   170,
  "3i":   190,
  "4i":   180,
  "5i":   170,
  "6i":   160,
  "7i":   150,
  "8i":   140,
  "9i":   130,
  pw:     110,
  gw:      95,
  sw:      75,
  lw:      55,
};

/**
 * Look up the typical amateur practice distance (yards) for a canonical
 * benchmark club key (e.g. "7i", "pw"). Returns `null` if unknown so the
 * caller can omit the "Practice from N yds" sentence rather than make
 * something up.
 */
export function practiceDistanceYardsForClubKey(clubKey: string | null | undefined): number | null {
  if (!clubKey) return null;
  return PRACTICE_DISTANCE_YARDS_BY_CLUB[clubKey] ?? null;
}

export interface ProximityCoachingTip {
  /** Raw club label as it appears in the player's shot history. */
  club: string;
  /** Canonical normalised club key the benchmark resolved to. */
  clubKey: string;
  /** How many tracked approach shots back this gap. */
  shots: number;
  meanProximityFt: number;
  tourMeanFt: number;
  scratchMeanFt: number;
  midHandicapMeanFt: number;
  /** mean − tour, rounded to 0.1 ft. Always > 0 (we only surface losses). */
  gapVsTourFt: number;
  /** mean − scratch, rounded to 0.1 ft. Negative ⇒ player already ≤ scratch. */
  gapVsScratchFt: number;
  /** Typical practice distance for this club (yards), or null if unknown. */
  practiceDistanceYards: number | null;
  /**
   * Suggested aim adjustment (feet long of pin) the AI Caddie can use to
   * compensate for the typical short bias driving the gap. Half-the-gap
   * heuristic with a 2 ft floor.
   */
  aimLongFt: number;
  /**
   * Player-facing coaching message. e.g.
   *   "Your 7-iron is 8 ft worse than tour. 3 more feet would be
   *    scratch-level. Practice from 150 yds."
   */
  message: string;
  /**
   * Compact one-liner suitable for the AI Caddie rationale list. e.g.
   *   "you're 8 ft worse with the 7-iron — aim 5 ft long of pin"
   *
   * Switches to encouragement when the player's gap is closing past the
   * `TREND_ENCOURAGEMENT_FT` threshold ("you're closing the gap with the
   * 7-iron — keep it up"), so the on-course advice notices momentum.
   */
  caddieHint: string;
  // ── Task #1640 — trend vs the prior comparison window ─────────────────────
  /**
   * Player's mean proximity (ft) in the *previous* comparison window. `null`
   * when no usable previous-window data was supplied or the player had too
   * few shots with this club to make the trend meaningful.
   */
  previousMeanProximityFt: number | null;
  /**
   * Change in the gap-vs-tour figure between the previous window and the
   * current window, rounded to 0.1 ft.
   *   - Positive ⇒ gap is *widening* (player is slipping vs tour)
   *   - Negative ⇒ gap is *closing* (player is improving vs tour)
   *   - Around zero ⇒ no meaningful movement
   *   - `null` ⇒ no usable previous-window baseline
   */
  trendVsTourFt: number | null;
  /**
   * Pre-formatted player-facing trend annotation for the "Work on This Club"
   * callout. e.g. "−2.1 ft from prev 30d", "no change", "+1.4 ft — slipping".
   * `null` when `trendVsTourFt` is null.
   */
  trendLabel: string | null;
  // ── Task #2039 — weekly gap-vs-tour sparkline ─────────────────────────────
  /**
   * Trailing weekly gap-vs-tour history for this club, oldest first. Powers
   * the inline sparkline next to the trend label so players can see whether
   * they're trending steadily in the right direction or just had one good /
   * bad week. `null` when no shots history was supplied to enrich the tip
   * (the helper itself doesn't compute this — the route handler attaches it
   * after-the-fact since per-club shot lookup needs the raw shot rows).
   */
  weeklyGapHistory: WeeklyGapBucket[] | null;
}

// ── Task #2039 — weekly proximity history bucketing ──────────────────────────
//
// The "Work on This Club" callout shows a single gap-vs-tour delta for the
// current 30-day window vs the prior one (Task #1640). That tells the player
// the *direction* of movement but hides whether they're trending steadily or
// the most recent week wrecked an otherwise-improving run. A 6-bucket inline
// sparkline of weekly gap-vs-tour fixes that without adding a second chart.
//
// Buckets are anchored to "now" and walk backwards in fixed 7-day windows, so
// the rightmost bucket is always the trailing week and the leftmost is six
// weeks ago. Each bucket reports the player's mean approach proximity (ft) for
// that club in that week and the gap vs the tour benchmark — `null` when the
// player tracked no shots that week (the sparkline renders gaps as flatlined
// points so the chart still has a continuous line).

/** A single weekly proximity bucket for one club. */
export interface WeeklyGapBucket {
  /** Bucket window start as an ISO timestamp (UTC). */
  weekStart: string;
  /** How many tracked approach shots fell into this bucket. */
  shots: number;
  /** Player's mean proximity (ft) for the club this week, or null if no shots. */
  meanProximityFt: number | null;
  /** mean − tourMeanFt, rounded to 0.1 ft. `null` when `meanProximityFt` is null. */
  gapVsTourFt: number | null;
}

/**
 * Bucket the supplied shots for a single raw club label into the trailing
 * `weeks` weekly windows and report mean proximity + gap-vs-tour per bucket.
 *
 * Mirrors `computeProximityByClub`'s "approach shots only, next-shot
 * distance-to-pin = proximity outcome" logic so the per-week numbers stay
 * consistent with the headline mean shown on the chart.
 *
 * Buckets are returned oldest first so callers can render them left-to-right
 * without a reverse step.
 */
export function computeWeeklyProximityHistory(
  shots: AnalyticsShot[],
  options: {
    /**
     * Raw club label as it appears in shot rows (`shots[i].club`). Match is
     * exact — callers pass `tip.club` here, which itself came from the same
     * raw-label set, so this is the right join key.
     */
    club: string;
    /** Tour benchmark mean (ft) used to compute the per-bucket gap. */
    tourMeanFt: number;
    /** Number of weekly buckets, oldest first. Default 6, clamped 1..52. */
    weeks?: number;
    /** Anchor "now" timestamp in ms. Defaults to `Date.now()` at call time. */
    nowMs?: number;
  },
): WeeklyGapBucket[] {
  const weeks = Math.max(1, Math.min(52, options.weeks ?? 6));
  const nowMs = options.nowMs ?? Date.now();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // Build the buckets oldest first. Bucket `i` covers
  // [now − (weeks − i) * WEEK_MS, now − (weeks − i − 1) * WEEK_MS).
  const buckets: { startMs: number; endMs: number; proxFt: number[] }[] = [];
  for (let i = 0; i < weeks; i++) {
    const endMs = nowMs - (weeks - 1 - i) * WEEK_MS;
    const startMs = endMs - WEEK_MS;
    buckets.push({ startMs, endMs, proxFt: [] });
  }

  // Same hole-grouping logic as `computeProximityByClub` so we can use the
  // *next* shot's distance-to-pin as the proximity outcome of each approach.
  const byHole = new Map<string, AnalyticsShot[]>();
  for (const s of shots) {
    const k = `${s.tournamentId ?? "g"}-${s.generalPlayRoundId ?? "t"}-${s.round}-${s.holeNumber}`;
    if (!byHole.has(k)) byHole.set(k, []);
    byHole.get(k)!.push(s);
  }
  for (const arr of byHole.values()) arr.sort((a, b) => a.shotNumber - b.shotNumber);

  for (const arr of byHole.values()) {
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (!s.club || s.club !== options.club) continue;
      if (s.shotType === "putt" || s.shotType === "tee") continue;
      const fromDist = s.distanceToPin !== null ? parseFloat(s.distanceToPin) : null;
      if (fromDist === null) continue;
      const recordedMs = s.recordedAt instanceof Date ? s.recordedAt.getTime() : null;
      if (recordedMs === null) continue;
      const next = arr[i + 1];
      const nextDist = next?.distanceToPin !== null && next?.distanceToPin !== undefined
        ? parseFloat(next.distanceToPin)
        : 0;
      const proxFt = nextDist * 3; // yards → feet, mirrors computeProximityByClub.

      // Drop the shot into the matching bucket. Falls through harmlessly when
      // the shot is older than the oldest bucket or somehow newer than `now`.
      for (const b of buckets) {
        if (recordedMs >= b.startMs && recordedMs < b.endMs) {
          b.proxFt.push(proxFt);
          break;
        }
      }
    }
  }

  return buckets.map(b => {
    const count = b.proxFt.length;
    const meanRaw = count > 0 ? b.proxFt.reduce((a, c) => a + c, 0) / count : null;
    const mean = meanRaw !== null ? Math.round(meanRaw * 10) / 10 : null;
    const gap = mean !== null ? Math.round((mean - options.tourMeanFt) * 10) / 10 : null;
    return {
      weekStart: new Date(b.startMs).toISOString(),
      shots: count,
      meanProximityFt: mean,
      gapVsTourFt: gap,
    };
  });
}

/** Minimum gap (ft) over tour before we'll surface a "work on this club" tip. */
const MIN_GAP_FT_FOR_TIP = 3;
/** Minimum tracked shots in the window before we trust the gap signal. */
const MIN_SHOTS_FOR_TIP = 3;
/**
 * Task #1640 — magnitude (ft) of trend movement we'll call "no change". Smaller
 * deltas than this are reported as flat so a single-shot wobble doesn't flip
 * the player-facing label between "closing" and "slipping" between visits.
 */
const TREND_NO_CHANGE_FT = 0.5;
/**
 * Task #1640 — when the gap-vs-tour has shrunk by at least this much from the
 * previous window, the AI Caddie's hint switches to encouragement instead of
 * the "you're X ft worse" framing. Threshold is comfortably outside the
 * "no change" band so the encouragement is reserved for genuine improvement.
 */
const TREND_ENCOURAGEMENT_FT = -1.5;
/**
 * Task #1640 — minimum shots in the previous window before we trust its mean
 * enough to compute a trend. We deliberately allow this to be looser than
 * `MIN_SHOTS_FOR_TIP` (which gates the *current* tip) since the player has
 * already cleared the bar; we just need enough prior data to be meaningful.
 */
const MIN_SHOTS_FOR_TREND = 2;

/**
 * Pick the 1-2 clubs with the largest mean-proximity gap vs tour and shape
 * each one into a coaching tip. Inputs are the same per-club stats returned
 * by `computeProximityByClub` — callers can pass the full list straight
 * through.
 *
 * Filters:
 *   - benchmark must be available (unmapped clubs are skipped)
 *   - shots ≥ MIN_SHOTS_FOR_TIP
 *   - mean − tour ≥ MIN_GAP_FT_FOR_TIP (player must actually be losing
 *     ground vs tour; "you're already tour-tight" doesn't need a tip)
 *
 * Sorted by gap descending so the biggest opportunity comes first.
 */
export function computeProximityCoachingTips(
  stats: ProximityByClubStat[],
  opts: {
    maxTips?: number;
    /**
     * Task #1640 — per-club proximity stats from the *previous* comparison
     * window (e.g. the 30 days before the current 30-day window). Used to
     * compute a `trendVsTourFt` per tip so players see whether their gap is
     * closing, holding, or widening, and so the AI Caddie can flip its hint
     * to encouragement when the gap is meaningfully shrinking.
     *
     * Matched to the current stats by canonical `benchmark.clubKey`, so a
     * relabelling between windows (e.g. "7i" ↔ "7-iron") still pairs up.
     */
    previousStats?: ProximityByClubStat[];
    /**
     * Player-facing label for the previous window (default `"prev 30d"`).
     * Surfaced verbatim in the trend annotation so the UI doesn't have to
     * know the window length.
     */
    previousWindowLabel?: string;
  } = {},
): ProximityCoachingTip[] {
  const maxTips = Math.max(1, Math.min(5, opts.maxTips ?? 2));
  const previousLabel = opts.previousWindowLabel ?? "prev 30d";

  // Index previous-window stats by canonical clubKey so we can pair them up
  // even when the raw club label differs between windows.
  const prevByClubKey = new Map<string, ProximityByClubStat>();
  if (opts.previousStats) {
    for (const p of opts.previousStats) {
      const key = p.benchmark?.clubKey;
      if (!key) continue;
      if (p.meanProximityFt === null) continue;
      if (p.shots < MIN_SHOTS_FOR_TREND) continue;
      // First match wins — `computeProximityByClub` returns one row per raw
      // club label, but normalisation can collapse multiples; take the one
      // with the most shots so the previous-window mean is most reliable.
      const existing = prevByClubKey.get(key);
      if (!existing || p.shots > existing.shots) prevByClubKey.set(key, p);
    }
  }

  const candidates: ProximityCoachingTip[] = [];

  for (const s of stats) {
    if (!s.benchmark) continue;
    if (s.shots < MIN_SHOTS_FOR_TIP) continue;
    if (s.meanProximityFt === null) continue;
    const gap = s.meanProximityFt - s.benchmark.tourMeanFt;
    if (gap < MIN_GAP_FT_FOR_TIP) continue;

    const gapRounded = Math.round(gap * 10) / 10;
    const gapDisplay = Math.max(1, Math.round(gap));
    const gapVsScratch = Math.round((s.meanProximityFt - s.benchmark.scratchMeanFt) * 10) / 10;
    const aimLongFt = Math.max(2, Math.round(gap * 0.6));
    const practiceYards = practiceDistanceYardsForClubKey(s.benchmark.clubKey);

    // Trend computation — match by canonical club key so a label drift
    // between windows still pairs up the comparison.
    const prev = prevByClubKey.get(s.benchmark.clubKey);
    let previousMeanProximityFt: number | null = null;
    let trendVsTourFt: number | null = null;
    let trendLabel: string | null = null;
    if (prev && prev.meanProximityFt !== null) {
      previousMeanProximityFt = prev.meanProximityFt;
      const previousGap = prev.meanProximityFt - s.benchmark.tourMeanFt;
      const trend = gap - previousGap; // positive ⇒ gap widening
      trendVsTourFt = Math.round(trend * 10) / 10;
      if (Math.abs(trend) < TREND_NO_CHANGE_FT) {
        trendLabel = "no change";
      } else if (trend < 0) {
        // Gap closing — render as a negative ft delta. U+2212 minus sign
        // matches the example wording in the task spec.
        trendLabel = `\u2212${Math.abs(trendVsTourFt).toFixed(1)} ft from ${previousLabel}`;
      } else {
        trendLabel = `+${trendVsTourFt.toFixed(1)} ft \u2014 slipping`;
      }
    }

    const sentences: string[] = [];
    sentences.push(`Your ${s.club} is ${gapDisplay} ft worse than tour.`);
    if (s.meanProximityFt > s.benchmark.scratchMeanFt) {
      const toScratch = Math.max(1, Math.round(s.meanProximityFt - s.benchmark.scratchMeanFt));
      sentences.push(`${toScratch} more ${toScratch === 1 ? "foot" : "feet"} would be scratch-level.`);
    } else {
      sentences.push(`You're already at scratch level — keep grooving it.`);
    }
    if (practiceYards !== null) {
      sentences.push(`Practice from ${practiceYards} yds.`);
    }

    // Caddie hint defaults to the existing "you're X ft worse" framing, but
    // flips to encouragement when the gap has measurably shrunk so the AI
    // Caddie's rationale notices momentum and de-emphasises the warning.
    const isClosingFast = trendVsTourFt !== null && trendVsTourFt <= TREND_ENCOURAGEMENT_FT;
    const caddieHint = isClosingFast
      ? `you're closing the gap with the ${s.club} — keep it up`
      : `you're ${gapDisplay} ft worse with the ${s.club} — aim ${aimLongFt} ft long of pin`;

    candidates.push({
      club: s.club,
      clubKey: s.benchmark.clubKey,
      shots: s.shots,
      meanProximityFt: s.meanProximityFt,
      tourMeanFt: s.benchmark.tourMeanFt,
      scratchMeanFt: s.benchmark.scratchMeanFt,
      midHandicapMeanFt: s.benchmark.midHandicapMeanFt,
      gapVsTourFt: gapRounded,
      gapVsScratchFt: gapVsScratch,
      practiceDistanceYards: practiceYards,
      aimLongFt,
      message: sentences.join(" "),
      caddieHint,
      previousMeanProximityFt,
      trendVsTourFt,
      trendLabel,
      // Task #2039 — left null here; the route handler enriches each tip with
      // a 6-bucket weekly history after-the-fact since the per-club shot
      // lookup needs the raw shot rows the aggregator doesn't have.
      weeklyGapHistory: null,
    });
  }

  candidates.sort((a, b) => b.gapVsTourFt - a.gapVsTourFt);
  return candidates.slice(0, maxTips);
}

export interface ClubDispersion {
  club: string;
  shots: number;
  avgCarryYards: number | null;
  carryStdDev: number | null;
  leftMissPct: number | null;
  rightMissPct: number | null;
  centrePct: number | null;
}

/**
 * Per-club dispersion summary. Carry distance comes from `distanceCarried`
 * when available; lateral dispersion is approximated from `missDirection`
 * categorical labels (left/right/centre) since true XY scatter requires
 * shot end-coordinates which we only have for ~30% of shots in practice.
 */
export function computeClubDispersion(shots: AnalyticsShot[]): ClubDispersion[] {
  const byClub = new Map<string, AnalyticsShot[]>();
  for (const s of shots) {
    if (!s.club) continue;
    if (s.shotType === "putt") continue;
    if (!byClub.has(s.club)) byClub.set(s.club, []);
    byClub.get(s.club)!.push(s);
  }
  const out: ClubDispersion[] = [];
  for (const [club, arr] of byClub.entries()) {
    const carries = arr.map(s => s.distanceCarried != null ? parseFloat(s.distanceCarried) : null)
      .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
    const avg = carries.length > 0 ? carries.reduce((a, c) => a + c, 0) / carries.length : null;
    const variance = avg !== null && carries.length > 1
      ? carries.reduce((a, c) => a + (c - avg) ** 2, 0) / (carries.length - 1)
      : null;
    const std = variance !== null ? Math.sqrt(variance) : null;

    const total = arr.length;
    const left = arr.filter(s => s.missDirection === "left").length;
    const right = arr.filter(s => s.missDirection === "right").length;
    const centre = total - left - right;
    const pct = (n: number) => total > 0 ? Math.round((n / total) * 1000) / 10 : null;

    out.push({
      club,
      shots: total,
      avgCarryYards: avg !== null ? Math.round(avg * 10) / 10 : null,
      carryStdDev: std !== null ? Math.round(std * 10) / 10 : null,
      leftMissPct: pct(left),
      rightMissPct: pct(right),
      centrePct: pct(centre),
    });
  }
  return out.sort((a, b) => (b.avgCarryYards ?? 0) - (a.avgCarryYards ?? 0));
}
