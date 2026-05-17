/**
 * Cross-Club Ladder auto-feed (Task #462)
 *
 * Hooks invoked by general-play and tournament completion code to automatically
 * credit ladder entries when a qualifying round is verified at a participating
 * club, removing the need for an explicit POST to
 * /api/cross-club-ladders/:id/results in the common case.
 *
 * Both helpers are idempotent: re-invoking them for the same source round will
 * not create duplicate ladder result rows.
 */

import { db } from "@workspace/db";
import {
  crossClubLaddersTable,
  crossClubLadderClubsTable,
  crossClubLadderEntriesTable,
  crossClubLadderResultsTable,
  generalPlayRoundsTable,
  generalPlayHoleScoresTable,
  holeDetailsTable,
  tournamentsTable,
  playersTable,
  type CrossClubLadder,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { stablefordPointsForHole } from "./handicap";
import { computeLeaderboard } from "./realtime";
import { recomputeStandings } from "./cross-club-ladder-standings";
import { logger } from "./logger";

function pointsForFormat(
  ladder: CrossClubLadder,
  opts: { stableford: number | null; net: number | null; gross: number | null },
): number {
  if (ladder.format === "stableford" || ladder.format === "national_ladder") {
    return opts.stableford ?? 0;
  }
  if (ladder.format === "stroke") {
    if (opts.net != null) return Math.max(0, 100 - opts.net);
    if (opts.gross != null) return Math.max(0, 100 - opts.gross);
    return 0;
  }
  return opts.stableford ?? (opts.net != null ? Math.max(0, 100 - opts.net) : 0);
}

function withinSeason(ladder: CrossClubLadder, when: Date): boolean {
  const t = when.getTime();
  return t >= new Date(ladder.seasonStart).getTime() && t <= new Date(ladder.seasonEnd).getTime();
}

async function findActiveLaddersForOrg(orgId: number): Promise<CrossClubLadder[]> {
  const rows = await db
    .select({ ladder: crossClubLaddersTable })
    .from(crossClubLadderClubsTable)
    .innerJoin(crossClubLaddersTable, eq(crossClubLaddersTable.id, crossClubLadderClubsTable.ladderId))
    .where(eq(crossClubLadderClubsTable.organizationId, orgId));
  return rows
    .map(r => r.ladder)
    .filter(l => l.status === "active" || l.status === "open");
}

/**
 * Credit a confirmed general-play round to any cross-club ladder where:
 *   - the round's organization is a participating club
 *   - the round's user has a registered entry
 *   - the ladder is open/active and the round date falls within its season
 *
 * Idempotent on (ladderId, generalPlayRoundId).
 */
export async function creditGeneralPlayRoundToLadders(roundId: number): Promise<void> {
  const [round] = await db.select().from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, roundId));
  if (!round || round.status !== "confirmed" || !round.userId) return;

  const ladders = await findActiveLaddersForOrg(round.organizationId);
  if (ladders.length === 0) return;

  // Find all matching ladder entries for this user across the eligible ladders.
  const eligible = ladders.filter(l => withinSeason(l, new Date(round.playedAt)));
  if (eligible.length === 0) return;

  const entries = await db
    .select()
    .from(crossClubLadderEntriesTable)
    .where(and(
      inArray(crossClubLadderEntriesTable.ladderId, eligible.map(l => l.id)),
      eq(crossClubLadderEntriesTable.userId, round.userId),
    ));
  if (entries.length === 0) return;

  // Skip ladders that have already credited this round.
  const existing = await db
    .select({ ladderId: crossClubLadderResultsTable.ladderId })
    .from(crossClubLadderResultsTable)
    .where(and(
      eq(crossClubLadderResultsTable.generalPlayRoundId, roundId),
      inArray(crossClubLadderResultsTable.ladderId, eligible.map(l => l.id)),
    ));
  const alreadyCredited = new Set(existing.map(e => e.ladderId));

  // Determine if any eligible ladder needs per-hole stableford computation.
  const stablefordFormats = new Set(["stableford", "national_ladder", "team_series", "knockout_cup"]);
  const needsStableford = entries.some(e => {
    const ladder = eligible.find(l => l.id === e.ladderId);
    return ladder && !alreadyCredited.has(ladder.id) && stablefordFormats.has(ladder.format);
  });

  let holes: Array<{ holeNumber: number; strokes: number | null }> = [];
  let courseHoles: Array<{ holeNumber: number; par: number; handicap: number | null }> = [];
  if (needsStableford) {
    holes = await db
      .select({ holeNumber: generalPlayHoleScoresTable.holeNumber, strokes: generalPlayHoleScoresTable.strokes })
      .from(generalPlayHoleScoresTable)
      .where(eq(generalPlayHoleScoresTable.roundId, roundId));
    courseHoles = await db
      .select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par, handicap: holeDetailsTable.handicap })
      .from(holeDetailsTable)
      .where(eq(holeDetailsTable.courseId, round.courseId));
  }

  const gross = round.grossScore ?? null;

  for (const entry of entries) {
    const ladder = eligible.find(l => l.id === entry.ladderId);
    if (!ladder || alreadyCredited.has(ladder.id)) continue;

    // Compute per-entry net & stableford using THIS entry's handicap snapshot —
    // a player can be registered in multiple ladders with different handicaps.
    const playingHandicap = entry.handicapAtRegistration != null
      ? Math.round(Number(entry.handicapAtRegistration))
      : 0;
    const net = gross != null && entry.handicapAtRegistration != null
      ? gross - playingHandicap
      : null;

    let stableford: number | null = null;
    if (stablefordFormats.has(ladder.format) && courseHoles.length > 0) {
      let total = 0;
      for (const ch of courseHoles) {
        const played = holes.find(h => h.holeNumber === ch.holeNumber);
        if (!played?.strokes) continue;
        total += stablefordPointsForHole(played.strokes, ch.par, ch.handicap, playingHandicap, null);
      }
      stableford = total;
    }

    const pointsAwarded = pointsForFormat(ladder, { stableford, net, gross });

    try {
      await db.insert(crossClubLadderResultsTable).values({
        ladderId: ladder.id,
        entryId: entry.id,
        organizationId: round.organizationId,
        generalPlayRoundId: roundId,
        tournamentId: null,
        roundDate: round.playedAt,
        grossScore: gross,
        netScore: net,
        stablefordPoints: stableford,
        pointsAwarded,
        notes: "Auto-credited from confirmed general-play round.",
      });
      await recomputeStandings(ladder.id);
      logger.info({ ladderId: ladder.id, entryId: entry.id, roundId, pointsAwarded },
        "[ladder-feed] Credited general-play round to ladder");
    } catch (err) {
      logger.error({ err, ladderId: ladder.id, roundId },
        "[ladder-feed] Failed to credit general-play round");
    }
  }
}

/**
 * Credit a completed tournament's results to any cross-club ladder where:
 *   - the tournament's organization is a participating club
 *   - one or more registered players have ladder entries
 *   - the ladder is open/active and the tournament date falls within its season
 *
 * Idempotent on (ladderId, entryId, tournamentId).
 */
export async function creditTournamentResultsToLadders(tournamentId: number): Promise<void> {
  const [tournament] = await db.select().from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!tournament || tournament.status !== "completed") return;

  const ladders = await findActiveLaddersForOrg(tournament.organizationId);
  if (ladders.length === 0) return;

  const tournamentDate = new Date(tournament.startDate ?? tournament.createdAt ?? new Date());
  const eligible = ladders.filter(l => withinSeason(l, tournamentDate));
  if (eligible.length === 0) return;

  const players = await db
    .select({ id: playersTable.id, userId: playersTable.userId })
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tournamentId));
  const userIds = players.map(p => p.userId).filter((u): u is number => typeof u === "number" && u > 0);
  if (userIds.length === 0) return;

  const entries = await db
    .select()
    .from(crossClubLadderEntriesTable)
    .where(and(
      inArray(crossClubLadderEntriesTable.ladderId, eligible.map(l => l.id)),
      inArray(crossClubLadderEntriesTable.userId, userIds),
    ));
  if (entries.length === 0) return;

  const existing = await db
    .select({
      ladderId: crossClubLadderResultsTable.ladderId,
      entryId: crossClubLadderResultsTable.entryId,
    })
    .from(crossClubLadderResultsTable)
    .where(and(
      eq(crossClubLadderResultsTable.tournamentId, tournamentId),
      inArray(crossClubLadderResultsTable.ladderId, eligible.map(l => l.id)),
    ));
  const alreadyCredited = new Set(existing.map(e => `${e.ladderId}:${e.entryId}`));

  let leaderboard: Awaited<ReturnType<typeof computeLeaderboard>> | null = null;
  try {
    leaderboard = await computeLeaderboard(tournamentId);
  } catch (err) {
    logger.error({ err, tournamentId }, "[ladder-feed] computeLeaderboard failed");
    return;
  }
  if (!leaderboard) return;

  const playerIdToUserId = new Map(players.map(p => [p.id, p.userId]));

  const touchedLadders = new Set<number>();

  for (const lbEntry of leaderboard.entries) {
    const userId = playerIdToUserId.get(lbEntry.playerId);
    if (!userId) continue;
    // Skip players with no scored round (DNS, withdrew, no scores entered).
    // Crediting zero-point rows would inflate roundsCounted and distort
    // best-of-N standings.
    const hasAnyScore =
      lbEntry.grossScore != null ||
      lbEntry.netScore != null ||
      lbEntry.stablefordPoints != null;
    if (!hasAnyScore) continue;
    const matchingEntries = entries.filter(e => e.userId === userId);
    for (const entry of matchingEntries) {
      const ladder = eligible.find(l => l.id === entry.ladderId);
      if (!ladder) continue;
      if (alreadyCredited.has(`${ladder.id}:${entry.id}`)) continue;

      const pointsAwarded = pointsForFormat(ladder, {
        stableford: lbEntry.stablefordPoints,
        net: lbEntry.netScore,
        gross: lbEntry.grossScore,
      });

      try {
        await db.insert(crossClubLadderResultsTable).values({
          ladderId: ladder.id,
          entryId: entry.id,
          organizationId: tournament.organizationId,
          generalPlayRoundId: null,
          tournamentId,
          roundDate: tournamentDate,
          grossScore: lbEntry.grossScore,
          netScore: lbEntry.netScore,
          stablefordPoints: lbEntry.stablefordPoints,
          pointsAwarded,
          notes: `Auto-credited from completed tournament: ${tournament.name}.`,
        });
        touchedLadders.add(ladder.id);
        logger.info({ ladderId: ladder.id, entryId: entry.id, tournamentId, pointsAwarded },
          "[ladder-feed] Credited tournament result to ladder");
      } catch (err) {
        logger.error({ err, ladderId: ladder.id, tournamentId, entryId: entry.id },
          "[ladder-feed] Failed to credit tournament result");
      }
    }
  }

  for (const ladderId of touchedLadders) {
    try {
      await recomputeStandings(ladderId);
    } catch (err) {
      logger.error({ err, ladderId }, "[ladder-feed] recomputeStandings failed");
    }
  }
}
