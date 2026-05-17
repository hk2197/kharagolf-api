import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { matchResultsTable, playersTable, tournamentsTable } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";

const router: IRouter = Router({ mergeParams: true });

/** Verify tournament belongs to org; returns the tournament row or responds 404. */
async function verifyOwnership(req: Request, res: Response): Promise<{ id: number } | null> {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const [tournament] = await db
    .select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!tournament) {
    res.status(404).json({ error: "Tournament not found" });
    return null;
  }
  return tournament;
}

// GET /organizations/:orgId/tournaments/:tournamentId/match-results
router.get("/match-results", async (req: Request, res: Response) => {
  if (!await verifyOwnership(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { round } = req.query;

  const conditions = [eq(matchResultsTable.tournamentId, tournamentId)];
  if (round) conditions.push(eq(matchResultsTable.round, parseInt(round as string)));

  const rows = await db.select().from(matchResultsTable).where(and(...conditions)).orderBy(matchResultsTable.round, matchResultsTable.id);

  const pFields = { id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName };
  const results = await Promise.all(rows.map(async (r) => {
    const [p1] = await db.select(pFields).from(playersTable).where(eq(playersTable.id, r.player1Id));
    const [p2] = await db.select(pFields).from(playersTable).where(eq(playersTable.id, r.player2Id));
    const winner = r.winnerId
      ? await db.select(pFields).from(playersTable).where(eq(playersTable.id, r.winnerId)).then(rows => rows[0])
      : null;
    return { ...r, player1: p1 ?? null, player2: p2 ?? null, winner: winner ?? null };
  }));

  res.json(results);
});

// POST /organizations/:orgId/tournaments/:tournamentId/match-results
// Upsert: if a match for the same round+player pair exists, return it; otherwise insert.
router.post("/match-results", async (req: Request, res: Response) => {
  if (!await verifyOwnership(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { round, player1Id, player2Id } = req.body;

  if (!player1Id || !player2Id) {
    res.status(400).json({ error: "player1Id and player2Id are required" });
    return;
  }

  const p1 = parseInt(player1Id);
  const p2 = parseInt(player2Id);
  const r = round ?? 1;

  // Upsert: check for existing match with the same players in this round (either order)
  const [existing] = await db.select().from(matchResultsTable).where(
    and(
      eq(matchResultsTable.tournamentId, tournamentId),
      eq(matchResultsTable.round, r),
      sql`(
        (${matchResultsTable.player1Id} = ${p1} AND ${matchResultsTable.player2Id} = ${p2}) OR
        (${matchResultsTable.player1Id} = ${p2} AND ${matchResultsTable.player2Id} = ${p1})
      )`
    )
  );

  if (existing) {
    res.status(200).json(existing);
    return;
  }

  const [match] = await db.insert(matchResultsTable).values({
    tournamentId,
    round: r,
    player1Id: p1,
    player2Id: p2,
  }).returning();

  res.status(201).json(match);
});

// POST /organizations/:orgId/tournaments/:tournamentId/match-results/generate
// Auto-generate seeded bracket from tournament players
router.post("/match-results/generate", async (req: Request, res: Response) => {
  if (!await verifyOwnership(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { round } = req.body;
  const r = round ?? 1;

  // Get all players sorted by handicap for seeding
  const players = await db
    .select()
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tournamentId))
    .orderBy(playersTable.handicapIndex);

  if (players.length < 2) {
    res.status(400).json({ error: "Need at least 2 players to generate bracket" });
    return;
  }

  // Delete existing matches for this round to allow regeneration
  await db.delete(matchResultsTable).where(
    and(eq(matchResultsTable.tournamentId, tournamentId), eq(matchResultsTable.round, r))
  );

  // Seeded bracket: 1 vs last, 2 vs second-last, etc. Odd player gets a bye (skipped)
  const created = [];
  const n = players.length;
  for (let i = 0; i < Math.floor(n / 2); i++) {
    const [match] = await db.insert(matchResultsTable).values({
      tournamentId,
      round: r,
      player1Id: players[i].id,
      player2Id: players[n - 1 - i].id,
    }).returning();
    created.push(match);
  }

  res.json(created);
});

// PUT /organizations/:orgId/tournaments/:tournamentId/match-results/:matchId
router.put("/match-results/:matchId", async (req: Request, res: Response) => {
  if (!await verifyOwnership(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const matchId = parseInt(String((req.params as Record<string, string>).matchId));
  const { winnerId, result, player1Holes, player2Holes, notes } = req.body;

  const isComplete = !!(winnerId || result);

  // Scope update to this tournament (ownership already verified above)
  const [updated] = await db.update(matchResultsTable)
    .set({
      winnerId: winnerId ? parseInt(winnerId) : undefined,
      result: result ?? undefined,
      player1Holes: player1Holes ?? undefined,
      player2Holes: player2Holes ?? undefined,
      notes: notes ?? undefined,
      isComplete,
      updatedAt: new Date(),
    })
    .where(and(eq(matchResultsTable.id, matchId), eq(matchResultsTable.tournamentId, tournamentId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Match not found" });
    return;
  }

  // Auto-advance bracket: if this round is now complete, generate next round
  if (updated.isComplete && updated.winnerId) {
    const currentRound = updated.round;
    const roundMatches = await db.select().from(matchResultsTable).where(
      and(eq(matchResultsTable.tournamentId, tournamentId), eq(matchResultsTable.round, currentRound))
    );

    const allComplete = roundMatches.every(m => m.isComplete && m.winnerId);
    if (allComplete && roundMatches.length >= 2) {
      // Check if next round already exists to avoid creating duplicates
      const [nextRoundExists] = await db.select({ id: matchResultsTable.id }).from(matchResultsTable).where(
        and(eq(matchResultsTable.tournamentId, tournamentId), eq(matchResultsTable.round, currentRound + 1))
      );

      if (!nextRoundExists) {
        const winners = roundMatches
          .sort((a, b) => a.id - b.id)
          .map(m => m.winnerId!);

        const nextRoundCreated = [];
        for (let i = 0; i + 1 < winners.length; i += 2) {
          const [nextMatch] = await db.insert(matchResultsTable).values({
            tournamentId,
            round: currentRound + 1,
            player1Id: winners[i],
            player2Id: winners[i + 1],
          }).returning();
          nextRoundCreated.push(nextMatch);
        }

        res.json({ ...updated, nextRound: nextRoundCreated }); return;
      }
    }
  }

  res.json(updated);
});

export default router;
