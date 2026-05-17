/**
 * Wave 2 W2-D — Tournament cut handler.
 *
 * After round N closes, applies the tournament's configured cut and
 * marks the players who fall outside it as withdrawn ("cut"); the
 * survivors are returned in leaderboard order so the caller can
 * re-group them for round N+1.
 *
 * Two cut modes are supported, matching `computeLeaderboard`:
 *
 *   1. `cutLine` — "+N over par". Survivors satisfy
 *      `totalStrokes <= totalPar + cutLine`, where `totalPar` is the
 *      sum of the actual course par for each round played up to and
 *      including `throughRound` (Task #1599). For multi-course
 *      tournaments, the per-round course is read from
 *      `tournament_rounds.course_id`; rounds without a per-round
 *      assignment fall back to `tournaments.course_id`. Per course,
 *      we prefer the sum of `hole_details.par` when the seeded hole
 *      count matches `courses.holes`, otherwise we fall back to the
 *      course-level `courses.par` (which itself defaults to 72).
 *   2. `cutPosition` — "topN" or "topN_ties". Survivors are the top
 *      N players by total strokes (with ties handling that mirrors
 *      `realtime.ts`).
 *
 * If both are configured, `cutPosition` takes precedence (matches
 * `computeLeaderboard`, which overwrites the cutLine-derived
 * `madeCut` with the position-based result). If neither is
 * configured, this is a no-op.
 *
 * Persistence (Task #1004): we record the cut on the players table
 * via the `cut_at` column. Survivors get `cut_at = NULL` so the cut
 * can be re-run safely (e.g. after a score correction). The
 * leaderboard treats `cut_at != NULL` as `madeCut = false` regardless
 * of any other cut-math heuristic in `computeLeaderboard`.
 */

import {
  db,
  tournamentsTable,
  scoresTable,
  playersTable,
  tournamentRoundsTable,
  coursesTable,
  holeDetailsTable,
} from "@workspace/db";
import { and, eq, inArray, lte, sql } from "drizzle-orm";

const DEFAULT_PAR_PER_ROUND = 72;

/**
 * Compute the total course par across rounds 1..throughRound for a
 * tournament. Multi-course tournaments are handled by reading the
 * per-round course assignment from `tournament_rounds`; rounds with
 * no entry fall back to the tournament-level `courseId`. Per course
 * we prefer the sum of `hole_details.par` when the seeded hole count
 * matches `courses.holes`, otherwise we fall back to `courses.par`.
 * Rounds whose course can't be resolved at all contribute the legacy
 * 72 default so callers always get a usable number.
 */
async function computeTotalParThroughRound(
  tournamentId: number,
  throughRound: number,
  defaultCourseId: number | null,
): Promise<number> {
  if (throughRound <= 0) return 0;

  const roundRows = await db
    .select({
      roundNumber: tournamentRoundsTable.roundNumber,
      courseId: tournamentRoundsTable.courseId,
    })
    .from(tournamentRoundsTable)
    .where(and(
      eq(tournamentRoundsTable.tournamentId, tournamentId),
      lte(tournamentRoundsTable.roundNumber, throughRound),
    ));

  const perRoundCourseId = new Map<number, number | null>();
  for (const r of roundRows) perRoundCourseId.set(r.roundNumber, r.courseId);

  // Resolve the course for every round in [1..throughRound]; per-round
  // assignment wins, otherwise fall back to the tournament's courseId.
  const resolvedCourseIdByRound: Array<number | null> = [];
  const courseIdsNeeded = new Set<number>();
  for (let rn = 1; rn <= throughRound; rn++) {
    const cid = perRoundCourseId.has(rn)
      ? perRoundCourseId.get(rn) ?? defaultCourseId
      : defaultCourseId;
    resolvedCourseIdByRound.push(cid ?? null);
    if (cid != null) courseIdsNeeded.add(cid);
  }

  // Compute par per course: prefer the sum of hole_details.par when the
  // hole count matches courses.holes; otherwise use courses.par.
  const parByCourse = new Map<number, number>();
  if (courseIdsNeeded.size > 0) {
    const ids = [...courseIdsNeeded];

    const courseRows = await db
      .select({
        id: coursesTable.id,
        par: coursesTable.par,
        holes: coursesTable.holes,
      })
      .from(coursesTable)
      .where(inArray(coursesTable.id, ids));

    const holeRows = await db
      .select({
        courseId: holeDetailsTable.courseId,
        sumPar: sql<number>`coalesce(sum(${holeDetailsTable.par}), 0)::int`.as("sum_par"),
        holeCount: sql<number>`count(*)::int`.as("hole_count"),
      })
      .from(holeDetailsTable)
      .where(inArray(holeDetailsTable.courseId, ids))
      .groupBy(holeDetailsTable.courseId);

    const courseMeta = new Map(courseRows.map(c => [c.id, { par: c.par, holes: c.holes }]));
    const holeAggByCourse = new Map(
      holeRows.map(h => [h.courseId, { sumPar: Number(h.sumPar), holeCount: Number(h.holeCount) }]),
    );

    for (const cid of ids) {
      const meta = courseMeta.get(cid);
      const expectedHoles = meta?.holes ?? 18;
      const fallback = meta?.par ?? DEFAULT_PAR_PER_ROUND;
      const agg = holeAggByCourse.get(cid);
      // Use the seeded hole-by-hole par only when every hole on the
      // course has a row — partial seeds would understate the round's
      // par and cut too few players.
      parByCourse.set(cid, agg && agg.holeCount === expectedHoles ? agg.sumPar : fallback);
    }
  }

  let totalPar = 0;
  for (const cid of resolvedCourseIdByRound) {
    if (cid != null && parByCourse.has(cid)) {
      totalPar += parByCourse.get(cid)!;
    } else {
      totalPar += DEFAULT_PAR_PER_ROUND;
    }
  }
  return totalPar;
}

export interface CutResult {
  applied: boolean;
  reason?: string;
  /** Set when the cut was driven by `cutLine`. */
  cutLineStrokes?: number;
  /** Set when the cut was driven by `cutPosition`. */
  cutPositionSize?: number;
  /** Set when the cut was driven by `cutPosition` (top-N tie threshold). */
  cutThresholdStrokes?: number;
  /** "line" | "position" — which rule actually decided the cut. */
  mode?: "line" | "position";
  /** ordered by total strokes asc */
  survivors: Array<{ playerId: number; totalStrokes: number }>;
  cut: Array<{ playerId: number; totalStrokes: number }>;
  /** number of player rows updated with cut_at (null for survivors, now() for cut) */
  persistedCount?: number;
}

export async function applyCut(tournamentId: number, throughRound: number): Promise<CutResult> {
  const [tournament] = await db.select().from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId)).limit(1);
  if (!tournament) return { applied: false, reason: "tournament_not_found", survivors: [], cut: [] };

  const cutLineRaw = tournament.cutLine;
  const cutPositionRaw = tournament.cutPosition;
  if (cutLineRaw == null && (cutPositionRaw == null || cutPositionRaw === "")) {
    return { applied: false, reason: "no_cut_line", survivors: [], cut: [] };
  }

  // Total strokes for every player through `throughRound`.
  const rows = await db
    .select({
      playerId: scoresTable.playerId,
      totalStrokes: sql<number>`coalesce(sum(${scoresTable.strokes}), 0)::int`.as("total"),
    })
    .from(scoresTable)
    .where(and(
      eq(scoresTable.tournamentId, tournamentId),
      lte(scoresTable.round, throughRound),
    ))
    .groupBy(scoresTable.playerId);

  // Sort by total strokes asc, then by playerId asc to make tie-breaking
  // deterministic (matters for non-ties cutPosition where rank at the
  // boundary decides who is cut).
  const totals = rows.map(r => ({ playerId: r.playerId, totalStrokes: Number(r.totalStrokes) }))
    .sort((a, b) => a.totalStrokes - b.totalStrokes || a.playerId - b.playerId);

  // Decide which rule applies. Position takes precedence when both are
  // set, matching computeLeaderboard.
  let survivors: Array<{ playerId: number; totalStrokes: number }>;
  let cut: Array<{ playerId: number; totalStrokes: number }>;
  let cutLineStrokes: number | undefined;
  let cutPositionSize: number | undefined;
  let cutThresholdStrokes: number | undefined;
  let mode: "line" | "position";

  if (cutPositionRaw) {
    const posMatch = cutPositionRaw.match(/^top(\d+)(_ties)?$/);
    if (!posMatch) {
      return { applied: false, reason: "invalid_cut_position", survivors: [], cut: [] };
    }
    cutPositionSize = parseInt(posMatch[1], 10);
    // top0 / top0_ties is parseable but meaningless (would dereference
    // totals[-1]) — reject explicitly so callers see a clear error
    // instead of a runtime crash.
    if (cutPositionSize < 1) {
      return { applied: false, reason: "invalid_cut_position", survivors: [], cut: [] };
    }
    mode = "position";
    const includeTies = posMatch[2] === "_ties";

    if (totals.length === 0) {
      survivors = [];
      cut = [];
    } else if (includeTies) {
      // Threshold = strokes of the player at rank `cutPositionSize`. If
      // fewer than that many players have scores, everyone survives.
      const thresholdIdx = Math.min(cutPositionSize - 1, totals.length - 1);
      cutThresholdStrokes = totals[thresholdIdx].totalStrokes;
      survivors = totals.filter(p => p.totalStrokes <= cutThresholdStrokes!);
      cut = totals.filter(p => p.totalStrokes > cutThresholdStrokes!);
    } else {
      // Strict top-N by sorted rank (mirrors computeLeaderboard's
      // `rank < cutSize` branch). Ties at the boundary are broken by
      // sort order, same as the leaderboard does.
      survivors = totals.slice(0, cutPositionSize);
      cut = totals.slice(cutPositionSize);
    }
  } else {
    mode = "line";
    // Resolve "+N" → strokes by computing the actual course par across
    // the rounds played so far (Task #1599). cutLine stores the
    // strokes-over-par the admin configured. Multi-course tournaments
    // are handled inside the helper.
    const totalPar = await computeTotalParThroughRound(
      tournamentId,
      throughRound,
      tournament.courseId ?? null,
    );
    cutLineStrokes = totalPar + Number(cutLineRaw);
    survivors = totals.filter(p => p.totalStrokes <= cutLineStrokes!);
    cut = totals.filter(p => p.totalStrokes > cutLineStrokes!);
  }

  // Persist the cut to players.cut_at. Survivors get NULL (so a second
  // run after a score correction lifts an incorrect cut), the cut group
  // gets a fresh now() stamp.
  const now = new Date();
  let persistedCount = 0;
  if (cut.length > 0) {
    const result = await db.update(playersTable)
      .set({ cutAt: now })
      .where(and(
        eq(playersTable.tournamentId, tournamentId),
        inArray(playersTable.id, cut.map(c => c.playerId)),
      ));
    persistedCount += (result as { rowCount?: number }).rowCount ?? cut.length;
  }
  if (survivors.length > 0) {
    const result = await db.update(playersTable)
      .set({ cutAt: null })
      .where(and(
        eq(playersTable.tournamentId, tournamentId),
        inArray(playersTable.id, survivors.map(s => s.playerId)),
      ));
    persistedCount += (result as { rowCount?: number }).rowCount ?? survivors.length;
  }

  return {
    applied: true,
    mode,
    cutLineStrokes,
    cutPositionSize,
    cutThresholdStrokes,
    survivors,
    cut,
    persistedCount,
  };
}
