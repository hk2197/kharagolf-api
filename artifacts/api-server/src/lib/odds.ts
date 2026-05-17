/**
 * Task #378 — Live odds & prediction widgets (read-only, NOT gambling).
 *
 * Pure compute helpers that derive entertainment-only "win probability",
 * expected score per hole, and biggest-swing summaries from existing
 * leaderboard + score data. No money is wagered, no odds are offered for
 * stake, and outputs MUST be displayed alongside an "entertainment, not
 * betting" disclosure.
 */

import { db } from "@workspace/db";
import { scoresTable, holeDetailsTable, tournamentsTable, coursesTable, playersTable, tournamentPredictionsTable, appUsersTable, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { computeLeaderboard } from "./realtime";
import { logger } from "./logger";
import { sendPredictionResultsEmail, type EmailBranding } from "./mailer";

export type WinProbabilityRow = {
  playerId: number;
  name: string;
  position: number | null;
  scoreToPar: number | null;
  holesCompleted: number;
  winProbability: number; // 0..1
};

export type ExpectedScoreRow = {
  holeNumber: number;
  par: number;
  expectedStrokes: number;
  sampleSize: number;
  scoringAverageVsPar: number;
};

export type BiggestSwingRow = {
  playerId: number;
  name: string;
  delta: number; // +ve = lost shots vs field avg on this hole; -ve = gained
  holeNumber: number;
  round: number;
  strokes: number;
  par: number;
};

/**
 * Logistic-style win probability from current score-to-par and holes
 * remaining. This is a heuristic for entertainment, not a betting model.
 *
 * Smaller score-to-par + more holes complete → higher confidence.
 * If the field has not started yet, returns uniform probabilities.
 */
export function computeWinProbabilities(
  entries: Array<{ playerId: number; name: string; position: number | null; scoreToPar: number | null; holesCompleted: number; status?: string | null }>,
  totalHoles: number,
): WinProbabilityRow[] {
  const active = entries.filter(e => e.status !== "WD" && e.status !== "DQ" && e.status !== "CUT");
  if (active.length === 0) return [];

  // If no scoring has happened, return uniform probability.
  const anyScored = active.some(e => e.holesCompleted > 0 || (e.scoreToPar ?? 0) !== 0);
  if (!anyScored) {
    const p = 1 / active.length;
    return active.map(e => ({
      playerId: e.playerId,
      name: e.name,
      position: e.position,
      scoreToPar: e.scoreToPar,
      holesCompleted: e.holesCompleted,
      winProbability: p,
    }));
  }

  // Use exp(-k * (toPar - leaderToPar)) weighted by progression.
  // Field uncertainty shrinks linearly as more holes are completed.
  const leaderToPar = Math.min(...active.map(e => e.scoreToPar ?? 0));
  const avgHolesCompleted =
    active.reduce((acc, e) => acc + (e.holesCompleted ?? 0), 0) / active.length;
  const fractionDone = totalHoles > 0 ? Math.min(1, avgHolesCompleted / totalHoles) : 0;

  // k grows with completion: low confidence early (small k), high late (large k).
  const k = 0.25 + 1.5 * fractionDone;

  const weights = active.map(e => {
    const toPar = e.scoreToPar ?? 0;
    const gap = toPar - leaderToPar;
    return Math.exp(-k * gap);
  });
  const total = weights.reduce((a, b) => a + b, 0) || 1;

  return active.map((e, i) => ({
    playerId: e.playerId,
    name: e.name,
    position: e.position,
    scoreToPar: e.scoreToPar,
    holesCompleted: e.holesCompleted,
    winProbability: weights[i] / total,
  }));
}

/** Compute expected (average) strokes per hole for a tournament. */
export async function computeExpectedScores(tournamentId: number): Promise<ExpectedScoreRow[]> {
  const [tournament] = await db
    .select({ id: tournamentsTable.id, courseId: tournamentsTable.courseId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));
  if (!tournament?.courseId) return [];

  const [holes, scores] = await Promise.all([
    db.select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
      .from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournament.courseId)),
    db.select({ holeNumber: scoresTable.holeNumber, strokes: scoresTable.strokes })
      .from(scoresTable).where(eq(scoresTable.tournamentId, tournamentId)),
  ]);

  const parMap = new Map(holes.map(h => [h.holeNumber, h.par]));
  const agg = new Map<number, { total: number; count: number }>();
  for (const s of scores) {
    const a = agg.get(s.holeNumber) ?? { total: 0, count: 0 };
    a.total += s.strokes;
    a.count += 1;
    agg.set(s.holeNumber, a);
  }

  return holes
    .sort((a, b) => a.holeNumber - b.holeNumber)
    .map(h => {
      const a = agg.get(h.holeNumber);
      const expected = a && a.count > 0 ? a.total / a.count : h.par;
      return {
        holeNumber: h.holeNumber,
        par: h.par,
        expectedStrokes: Math.round(expected * 100) / 100,
        sampleSize: a?.count ?? 0,
        scoringAverageVsPar: Math.round((expected - h.par) * 100) / 100,
      };
    });
}

/**
 * Find the biggest individual swings — players who scored well above or
 * below the field average on a single hole. Returns top N by absolute delta.
 */
export async function computeBiggestSwings(
  tournamentId: number,
  limit = 5,
): Promise<BiggestSwingRow[]> {
  const [tournament] = await db
    .select({ id: tournamentsTable.id, courseId: tournamentsTable.courseId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));
  if (!tournament?.courseId) return [];

  const [holes, scores, players] = await Promise.all([
    db.select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
      .from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournament.courseId)),
    db.select().from(scoresTable).where(eq(scoresTable.tournamentId, tournamentId)),
    db.select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName })
      .from(playersTable).where(eq(playersTable.tournamentId, tournamentId)),
  ]);

  const parMap = new Map(holes.map(h => [h.holeNumber, h.par]));
  const nameMap = new Map(players.map(p => [p.id, `${p.firstName} ${p.lastName}`.trim()]));

  // Field average per (round, hole)
  const fieldAgg = new Map<string, { total: number; count: number }>();
  for (const s of scores) {
    const key = `${s.round}:${s.holeNumber}`;
    const a = fieldAgg.get(key) ?? { total: 0, count: 0 };
    a.total += s.strokes;
    a.count += 1;
    fieldAgg.set(key, a);
  }

  const swings: BiggestSwingRow[] = [];
  for (const s of scores) {
    const key = `${s.round}:${s.holeNumber}`;
    const a = fieldAgg.get(key);
    if (!a || a.count < 2) continue; // need a field to compare against
    const fieldAvg = a.total / a.count;
    const delta = s.strokes - fieldAvg;
    swings.push({
      playerId: s.playerId,
      name: nameMap.get(s.playerId) ?? `Player ${s.playerId}`,
      delta: Math.round(delta * 100) / 100,
      holeNumber: s.holeNumber,
      round: s.round,
      strokes: s.strokes,
      par: parMap.get(s.holeNumber) ?? 4,
    });
  }

  swings.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return swings.slice(0, limit);
}

/**
 * Aggregate odds widget payload for the public endpoint.
 */
export async function buildOddsPayload(tournamentId: number) {
  const [lb, expected, swings] = await Promise.all([
    computeLeaderboard(tournamentId),
    computeExpectedScores(tournamentId),
    computeBiggestSwings(tournamentId, 5),
  ]);

  if (!lb) return null;

  const totalHoles = (lb.rounds ?? 1) * 18;
  const winProb = computeWinProbabilities(
    (lb.entries ?? []).map((e: any) => ({
      playerId: e.playerId ?? e.id,
      name: e.name ?? e.playerName ?? "Player",
      position: e.position ?? null,
      scoreToPar: e.scoreToPar ?? null,
      holesCompleted: e.holesCompleted ?? 0,
      status: e.status ?? null,
    })),
    totalHoles,
  )
    .sort((a, b) => b.winProbability - a.winProbability)
    .slice(0, 10);

  return {
    tournamentId,
    tournamentName: lb.tournamentName,
    coursePar: lb.coursePar,
    rounds: lb.rounds ?? 1,
    winProbability: winProb,
    expectedScores: expected,
    biggestSwings: swings,
    disclosure:
      "For entertainment only — not betting. Win probabilities and player insights are derived from live scoring data and are not gambling odds. No wagers, stakes, or affiliate links are offered.",
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Compute a fun-only score for a single prediction submission given the
 * final tournament results.
 *
 * Scoring:
 *   - Correct winner pick: 25 pts
 *   - Each correct top-5 pick (in any order): 5 pts (max 25)
 *   - Low-round guess: 10 pts if exact, else max(0, 10 - |diff|)
 */
export function scorePrediction(
  prediction: { predictedWinnerPlayerId: number | null; predictedTop5: number[]; predictedLowRound: number | null },
  result: { winnerPlayerId: number | null; top5PlayerIds: number[]; lowRoundScore: number | null },
): { total: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = { winner: 0, top5: 0, lowRound: 0 };
  if (
    prediction.predictedWinnerPlayerId != null &&
    result.winnerPlayerId != null &&
    prediction.predictedWinnerPlayerId === result.winnerPlayerId
  ) {
    breakdown.winner = 25;
  }
  const top5Set = new Set(result.top5PlayerIds);
  let top5 = 0;
  for (const pid of prediction.predictedTop5 ?? []) {
    if (top5Set.has(pid)) top5 += 5;
  }
  breakdown.top5 = Math.min(top5, 25);
  if (prediction.predictedLowRound != null && result.lowRoundScore != null) {
    const diff = Math.abs(prediction.predictedLowRound - result.lowRoundScore);
    breakdown.lowRound = Math.max(0, 10 - diff);
  }
  return { total: breakdown.winner + breakdown.top5 + breakdown.lowRound, breakdown };
}

/**
 * Derive the official tournament result (winner, top-5 player IDs, low single
 * round score) from the leaderboard and raw scores.
 */
export async function computeTournamentResult(
  tournamentId: number,
): Promise<{ winnerPlayerId: number | null; top5PlayerIds: number[]; lowRoundScore: number | null }> {
  const lb = await computeLeaderboard(tournamentId);
  type LbEntry = { playerId: number; status?: string | null };
  const rankedEntries: LbEntry[] = ((lb?.entries ?? []) as LbEntry[]).filter(
    (e) => e.status !== "WD" && e.status !== "DQ" && e.status !== "CUT",
  );
  const winnerPlayerId = rankedEntries[0]?.playerId ?? null;
  const top5PlayerIds = rankedEntries.slice(0, 5).map(e => e.playerId).filter((id): id is number => typeof id === "number");

  // Compute low single-round score, considering only fully completed rounds
  // for eligible players (exclude WD/DQ/CUT). A round counts only when the
  // player has posted a stroke for every hole on the course.
  const [tournament] = await db
    .select({ courseId: tournamentsTable.courseId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));
  const courseHoles = tournament?.courseId
    ? await db.select({ holes: coursesTable.holes }).from(coursesTable).where(eq(coursesTable.id, tournament.courseId)).then(r => r[0]?.holes ?? 18)
    : 18;

  const eligiblePlayerIds = new Set(
    rankedEntries.map((e: any) => e.playerId).filter((id: any): id is number => typeof id === "number"),
  );

  const allScores = await db
    .select({ playerId: scoresTable.playerId, round: scoresTable.round, strokes: scoresTable.strokes })
    .from(scoresTable)
    .where(eq(scoresTable.tournamentId, tournamentId));

  const roundAgg = new Map<string, { total: number; holes: number }>();
  for (const s of allScores) {
    if (eligiblePlayerIds.size > 0 && !eligiblePlayerIds.has(s.playerId)) continue;
    const key = `${s.playerId}:${s.round}`;
    const a = roundAgg.get(key) ?? { total: 0, holes: 0 };
    a.total += s.strokes;
    a.holes += 1;
    roundAgg.set(key, a);
  }
  const completedRoundTotals: number[] = [];
  for (const a of roundAgg.values()) {
    if (a.holes >= courseHoles) completedRoundTotals.push(a.total);
  }
  const lowRoundScore = completedRoundTotals.length > 0 ? Math.min(...completedRoundTotals) : null;

  return { winnerPlayerId, top5PlayerIds, lowRoundScore };
}

/**
 * Score every prediction submission for a completed tournament. Idempotent —
 * re-running updates scores in place. Skips rows already scored unless
 * `force` is true.
 */
export async function scorePredictionsForTournament(
  tournamentId: number,
  opts: { force?: boolean } = {},
): Promise<{ scored: number; skipped: number }> {
  const result = await computeTournamentResult(tournamentId);

  const allRows = await db
    .select()
    .from(tournamentPredictionsTable)
    .where(eq(tournamentPredictionsTable.tournamentId, tournamentId));
  const predictions = opts.force ? allRows : allRows.filter(r => r.score == null);
  const skipped = allRows.length - predictions.length;

  let scored = 0;
  for (const p of predictions) {
    const { total, breakdown } = scorePrediction(
      {
        predictedWinnerPlayerId: p.predictedWinnerPlayerId,
        predictedTop5: p.predictedTop5 ?? [],
        predictedLowRound: p.predictedLowRound,
      },
      result,
    );
    await db
      .update(tournamentPredictionsTable)
      .set({ score: total, scoreBreakdown: breakdown, scoredAt: new Date() })
      .where(eq(tournamentPredictionsTable.id, p.id));
    scored += 1;
  }

  logger.info(
    { tournamentId, scored, skipped, result },
    "[predictions] Auto-scored predictions on tournament completion",
  );
  return { scored, skipped };
}


/**
 * Task #501 — Send "you scored X, ranked #Y of Z" emails to every fan who
 * submitted a prediction for a now-completed tournament.
 *
 * Idempotent — predictions whose `resultsEmailSentAt` is already set are
 * skipped, so re-completing a tournament (or repeated background sweeps)
 * never causes duplicate sends. Each successful send writes the timestamp
 * before the next one is attempted, so a partial failure mid-batch will
 * resume cleanly the next time scoring runs.
 *
 * Ranking ties (same score) share the same rank — standard "1224" ordering
 * — so two fans tied at the top both see "1st of N".
 */
export async function sendPredictionResultsEmails(
  tournamentId: number,
  opts: { force?: boolean } = {},
): Promise<{ sent: number; skipped: number; failed: number }> {
  // Need tournament name + org id for branding & subject; bail if it's gone.
  const [tournament] = await db
    .select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      organizationId: tournamentsTable.organizationId,
    })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));
  if (!tournament) return { sent: 0, skipped: 0, failed: 0 };

  // Branding lookup — fall back to KHARAGOLF defaults if the org row is
  // missing or the query fails so we still send a usable email.
  let branding: EmailBranding = { orgName: "KHARAGOLF" };
  if (tournament.organizationId != null) {
    try {
      const [org] = await db
        .select({
          name: organizationsTable.name,
          logoUrl: organizationsTable.logoUrl,
          primaryColor: organizationsTable.primaryColor,
        })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, tournament.organizationId))
        .limit(1);
      branding = {
        orgName: org?.name ?? "KHARAGOLF",
        logoUrl: org?.logoUrl ?? undefined,
        primaryColor: org?.primaryColor ?? undefined,
      };
    } catch (err) {
      logger.warn(
        { tournamentId, err: err instanceof Error ? err.message : String(err) },
        "[predictions-email] Failed to load org branding; using defaults",
      );
    }
  }

  // Pull every prediction joined with the user's email/display name. We need
  // the full set (not just unsent rows) to compute correct ranks.
  const allRows = await db
    .select({
      id: tournamentPredictionsTable.id,
      userId: tournamentPredictionsTable.userId,
      score: tournamentPredictionsTable.score,
      breakdown: tournamentPredictionsTable.scoreBreakdown,
      displayName: tournamentPredictionsTable.displayName,
      resultsEmailSentAt: tournamentPredictionsTable.resultsEmailSentAt,
      email: appUsersTable.email,
      userDisplayName: appUsersTable.displayName,
      username: appUsersTable.username,
      erasedAt: appUsersTable.erasedAt,
    })
    .from(tournamentPredictionsTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, tournamentPredictionsTable.userId))
    .where(eq(tournamentPredictionsTable.tournamentId, tournamentId));

  if (allRows.length === 0) return { sent: 0, skipped: 0, failed: 0 };

  // Standard "1224" ranking on score desc; unscored rows (null) sort last
  // and get rank = N (no point emailing them, they'll be skipped below).
  const ranked = [...allRows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const rankByPredictionId = new Map<number, number>();
  let lastScore: number | null = Number.NaN;
  let lastRank = 0;
  ranked.forEach((row, i) => {
    const s = row.score;
    if (s !== lastScore) {
      lastRank = i + 1;
      lastScore = s;
    }
    rankByPredictionId.set(row.id, lastRank);
  });

  const total = allRows.length;
  const baseUrl = process.env.PUBLIC_BASE_URL ?? "https://kharagolf.com";
  const leaderboardUrl = `${baseUrl}/leaderboard/${tournamentId}`;

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of ranked) {
    if (!opts.force && row.resultsEmailSentAt) {
      skipped += 1;
      continue;
    }
    if (row.score == null) {
      // Not yet scored — caller should run scoring first. Skip silently.
      skipped += 1;
      continue;
    }
    if (!row.email || row.erasedAt) {
      // No deliverable address (or the user has been erased per Task #467).
      // Mark as "sent" so we don't keep retrying every completion sweep.
      await db
        .update(tournamentPredictionsTable)
        .set({ resultsEmailSentAt: new Date() })
        .where(eq(tournamentPredictionsTable.id, row.id));
      skipped += 1;
      continue;
    }
    const breakdown = {
      winner: Number(row.breakdown?.winner ?? 0),
      top5: Number(row.breakdown?.top5 ?? 0),
      lowRound: Number(row.breakdown?.lowRound ?? 0),
    };
    const name = row.displayName || row.userDisplayName || row.username || "Golfer";
    const rank = rankByPredictionId.get(row.id) ?? total;
    try {
      await sendPredictionResultsEmail({
        to: row.email,
        name,
        tournamentName: tournament.name,
        score: row.score,
        rank,
        totalEntries: total,
        breakdown,
        leaderboardUrl,
        branding,
      });
      await db
        .update(tournamentPredictionsTable)
        .set({ resultsEmailSentAt: new Date() })
        .where(eq(tournamentPredictionsTable.id, row.id));
      sent += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        { tournamentId, predictionId: row.id, err: err instanceof Error ? err.message : String(err) },
        "[predictions-email] Failed to send results email",
      );
    }
  }

  logger.info(
    { tournamentId, sent, skipped, failed, total },
    "[predictions-email] Dispatched prediction results emails",
  );
  return { sent, skipped, failed };
}
