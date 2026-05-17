/**
 * Wave 1 W1-D — Personal-baseline strokes-gained computation.
 *
 * "How does this round compare with my trailing-N-day average?"
 *
 * We compute SG categories on demand from the existing shots library
 * (no separate persisted SG table). For a per-day window we group the
 * player's shots by (round identity, round number), compute SG totals
 * per round via the existing strokes-gained helpers, then average each
 * category across rounds in the window.
 */

import { db, shotsTable, tournamentsTable, generalPlayRoundsTable, holeDetailsTable } from "@workspace/db";
import { and, eq, gte, inArray } from "drizzle-orm";
import {
  computeRoundSGFromShots,
  type RoundShotData,
  type ShotRow,
  type HoleParMap,
} from "./strokes-gained.js";

export interface BaselineCategoryStat {
  /** Trailing-window average across rounds, null when no rounds qualify. */
  baseline: number | null;
  /** This-round value when the caller supplied a roundId, null otherwise. */
  thisRound: number | null;
  /** Convenience delta: thisRound - baseline. Null when either side missing. */
  delta: number | null;
  /** Count of rounds the baseline averages over. */
  baselineRoundCount: number;
}

export interface BaselineResult {
  windowDays: number;
  windowStart: string; // ISO
  categories: {
    sgPutting: BaselineCategoryStat;
    sgApproach: BaselineCategoryStat;
    sgATG: BaselineCategoryStat;
    sgOTT: BaselineCategoryStat;
    sgTotal: BaselineCategoryStat;
  };
}

interface RoundContext {
  tournamentId: number | null;
  generalPlayRoundId: number | null;
  round: number;
  courseId: number | null;
  shots: ShotRow[];
}

const CATEGORIES = ["sgPutting", "sgApproach", "sgATG", "sgOTT", "sgTotal"] as const;

function emptyCategory(roundCount: number): BaselineCategoryStat {
  return { baseline: null, thisRound: null, delta: null, baselineRoundCount: roundCount };
}

export async function computePlayerBaseline(
  userId: number,
  opts: { windowDays?: number; thisRoundKey?: { tournamentId?: number; generalPlayRoundId?: number; round?: number } } = {},
): Promise<BaselineResult> {
  const windowDays = Math.max(1, Math.min(365, opts.windowDays ?? 30));
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Pull every shot the player has within the window. Joins to par
  // info happen in a follow-up query (one query per course).
  const rows = await db
    .select({
      id: shotsTable.id,
      tournamentId: shotsTable.tournamentId,
      playerId: shotsTable.playerId,
      generalPlayRoundId: shotsTable.generalPlayRoundId,
      userId: shotsTable.userId,
      round: shotsTable.round,
      holeNumber: shotsTable.holeNumber,
      shotNumber: shotsTable.shotNumber,
      shotType: shotsTable.shotType,
      club: shotsTable.club,
      lieType: shotsTable.lieType,
      missDirection: shotsTable.missDirection,
      distanceToPin: shotsTable.distanceToPin,
      distanceCarried: shotsTable.distanceCarried,
      recordedAt: shotsTable.recordedAt,
    })
    .from(shotsTable)
    .where(and(
      eq(shotsTable.userId, userId),
      gte(shotsTable.recordedAt, since),
    ));

  // Group into rounds keyed by (tournamentId|gp, round).
  const groups = new Map<string, RoundContext>();
  for (const r of rows) {
    const key = `${r.tournamentId ?? "g"}-${r.generalPlayRoundId ?? "t"}-${r.round}`;
    if (!groups.has(key)) {
      groups.set(key, {
        tournamentId: r.tournamentId,
        generalPlayRoundId: r.generalPlayRoundId,
        round: r.round,
        courseId: null,
        shots: [],
      });
    }
    groups.get(key)!.shots.push(r as ShotRow);
  }

  // Resolve courseId per group.
  const tIds = [...new Set([...groups.values()].map(g => g.tournamentId).filter((v): v is number => v !== null))];
  const gpIds = [...new Set([...groups.values()].map(g => g.generalPlayRoundId).filter((v): v is number => v !== null))];
  const courseByT = new Map<number, number | null>();
  const courseByG = new Map<number, number | null>();
  if (tIds.length > 0) {
    const t = await db.select({ id: tournamentsTable.id, courseId: tournamentsTable.courseId })
      .from(tournamentsTable).where(inArray(tournamentsTable.id, tIds));
    for (const row of t) courseByT.set(row.id, row.courseId);
  }
  if (gpIds.length > 0) {
    const g = await db.select({ id: generalPlayRoundsTable.id, courseId: generalPlayRoundsTable.courseId })
      .from(generalPlayRoundsTable).where(inArray(generalPlayRoundsTable.id, gpIds));
    for (const row of g) courseByG.set(row.id, row.courseId);
  }
  for (const g of groups.values()) {
    g.courseId = g.tournamentId ? (courseByT.get(g.tournamentId) ?? null)
      : g.generalPlayRoundId ? (courseByG.get(g.generalPlayRoundId) ?? null)
      : null;
  }

  // Pull pars for every course we encountered.
  const courseIds = [...new Set([...groups.values()].map(g => g.courseId).filter((v): v is number => v !== null))];
  const parsByCourse = new Map<number, HoleParMap>();
  if (courseIds.length > 0) {
    const pars = await db.select({
      courseId: holeDetailsTable.courseId,
      holeNumber: holeDetailsTable.holeNumber,
      par: holeDetailsTable.par,
    }).from(holeDetailsTable).where(inArray(holeDetailsTable.courseId, courseIds));
    for (const p of pars) {
      if (!parsByCourse.has(p.courseId)) parsByCourse.set(p.courseId, new Map());
      parsByCourse.get(p.courseId)!.set(p.holeNumber, p.par);
    }
  }

  // Compute SG per round + average across the window. Identify the
  // "this round" group separately so we can also surface its values.
  const sums = { sgPutting: 0, sgApproach: 0, sgATG: 0, sgOTT: 0, sgTotal: 0 };
  const counts = { sgPutting: 0, sgApproach: 0, sgATG: 0, sgOTT: 0, sgTotal: 0 };
  let thisRoundResult: { [K in typeof CATEGORIES[number]]: number | null } | null = null;
  const thisKey = opts.thisRoundKey
    ? `${opts.thisRoundKey.tournamentId ?? "g"}-${opts.thisRoundKey.generalPlayRoundId ?? "t"}-${opts.thisRoundKey.round ?? 1}`
    : null;

  for (const [k, g] of groups) {
    const holePars: HoleParMap = (g.courseId && parsByCourse.get(g.courseId)) || new Map();
    const r: RoundShotData = { tournamentId: g.tournamentId ?? 0, round: g.round, shots: g.shots, holePars };
    const sg = computeRoundSGFromShots(r, "scratch");
    for (const c of CATEGORIES) {
      const v = sg[c];
      if (v !== null) { sums[c] += v; counts[c]++; }
    }
    if (k === thisKey) {
      thisRoundResult = {
        sgPutting: sg.sgPutting, sgApproach: sg.sgApproach,
        sgATG: sg.sgATG, sgOTT: sg.sgOTT, sgTotal: sg.sgTotal,
      };
    }
  }

  const categories = {} as BaselineResult["categories"];
  const roundCount = Math.max(...CATEGORIES.map(c => counts[c]));
  for (const c of CATEGORIES) {
    if (counts[c] === 0) {
      categories[c] = emptyCategory(roundCount);
      if (thisRoundResult) {
        categories[c].thisRound = thisRoundResult[c];
      }
      continue;
    }
    const baseline = Math.round((sums[c] / counts[c]) * 100) / 100;
    const thisRound = thisRoundResult?.[c] ?? null;
    categories[c] = {
      baseline,
      thisRound,
      delta: thisRound !== null ? Math.round((thisRound - baseline) * 100) / 100 : null,
      baselineRoundCount: counts[c],
    };
  }

  return {
    windowDays,
    windowStart: since.toISOString(),
    categories,
  };
}
