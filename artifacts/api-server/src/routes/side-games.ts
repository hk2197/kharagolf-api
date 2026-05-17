import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  sideGamesConfigTable, sideGameResultsTable, playersTable, scoresTable, tournamentsTable, sponsorsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

const router: IRouter = Router({ mergeParams: true });

function verifyAdmin(req: Request, res: Response): boolean {
  const role = req.user?.role;
  if (!["super_admin", "org_admin", "tournament_director"].includes(role ?? "")) {
    res.status(403).json({ error: "Admin access required" });
    return false;
  }
  return true;
}

/** Verify the tournament belongs to the org — returns false and sends 404 if not. */
async function verifyTournamentOwnership(orgId: number, tournamentId: number, res: Response): Promise<boolean> {
  const [t] = await db
    .select({ organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));
  if (!t || t.organizationId !== orgId) {
    res.status(404).json({ error: "Tournament not found in this organization" });
    return false;
  }
  return true;
}

// GET /api/orgs/:orgId/tournaments/:tournamentId/side-games/config/sponsors
router.get("/config/sponsors", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await verifyTournamentOwnership(orgId, tournamentId, res))) return;
  const sponsors = await db
    .select({ id: sponsorsTable.id, name: sponsorsTable.name, tier: sponsorsTable.tier })
    .from(sponsorsTable)
    .where(sql`${sponsorsTable.organizationId} = ${orgId} AND ${sponsorsTable.isActive} = true AND (${sponsorsTable.tournamentId} IS NULL OR ${sponsorsTable.tournamentId} = ${tournamentId})`)
    .orderBy(sponsorsTable.name);
  res.json(sponsors);
});

// GET /api/orgs/:orgId/tournaments/:tournamentId/side-games/config
router.get("/config", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await verifyTournamentOwnership(orgId, tournamentId, res))) return;
  const [cfg] = await db
    .select()
    .from(sideGamesConfigTable)
    .where(eq(sideGamesConfigTable.tournamentId, tournamentId));

  res.json(cfg ?? {
    tournamentId,
    skinsEnabled: false, skinsPrize: null,
    ctpEnabled: false, ctpHoles: [], ctpPrize: null, ctpSponsorId: null,
    ldEnabled: false, ldHoles: [], ldPrize: null, ldSponsorId: null,
    greeniesEnabled: false, greeniesPrize: null,
  });
});

// PUT /api/orgs/:orgId/tournaments/:tournamentId/side-games/config
router.put("/config", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await verifyTournamentOwnership(orgId, tournamentId, res))) return;
  const {
    skinsEnabled, skinsPrize,
    ctpEnabled, ctpHoles, ctpPrize, ctpSponsorId,
    ldEnabled, ldHoles, ldPrize, ldSponsorId,
    greeniesEnabled, greeniesPrize,
  } = req.body;

  const [cfg] = await db
    .insert(sideGamesConfigTable)
    .values({
      tournamentId,
      skinsEnabled: skinsEnabled ?? false,
      skinsPrize: skinsPrize ?? null,
      ctpEnabled: ctpEnabled ?? false,
      ctpHoles: ctpHoles ?? [],
      ctpPrize: ctpPrize ?? null,
      ctpSponsorId: ctpSponsorId ?? null,
      ldEnabled: ldEnabled ?? false,
      ldHoles: ldHoles ?? [],
      ldPrize: ldPrize ?? null,
      ldSponsorId: ldSponsorId ?? null,
      greeniesEnabled: greeniesEnabled ?? false,
      greeniesPrize: greeniesPrize ?? null,
    })
    .onConflictDoUpdate({
      target: [sideGamesConfigTable.tournamentId],
      set: {
        skinsEnabled: skinsEnabled ?? false,
        skinsPrize: skinsPrize ?? null,
        ctpEnabled: ctpEnabled ?? false,
        ctpHoles: ctpHoles ?? [],
        ctpPrize: ctpPrize ?? null,
        ctpSponsorId: ctpSponsorId ?? null,
        ldEnabled: ldEnabled ?? false,
        ldHoles: ldHoles ?? [],
        ldPrize: ldPrize ?? null,
        ldSponsorId: ldSponsorId ?? null,
        greeniesEnabled: greeniesEnabled ?? false,
        greeniesPrize: greeniesPrize ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  res.json(cfg);
});

// GET /api/orgs/:orgId/tournaments/:tournamentId/side-games/results
router.get("/results", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await verifyTournamentOwnership(orgId, tournamentId, res))) return;

  const [cfg] = await db
    .select()
    .from(sideGamesConfigTable)
    .where(eq(sideGamesConfigTable.tournamentId, tournamentId));

  const manualResults = await db
    .select({
      id: sideGameResultsTable.id,
      gameType: sideGameResultsTable.gameType,
      holeNumber: sideGameResultsTable.holeNumber,
      round: sideGameResultsTable.round,
      notes: sideGameResultsTable.notes,
      prize: sideGameResultsTable.prize,
      recordedAt: sideGameResultsTable.recordedAt,
      playerId: sideGameResultsTable.playerId,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
    })
    .from(sideGameResultsTable)
    .leftJoin(playersTable, eq(playersTable.id, sideGameResultsTable.playerId))
    .where(eq(sideGameResultsTable.tournamentId, tournamentId))
    .orderBy(sideGameResultsTable.recordedAt);

  // Auto-calculate skins if enabled
  let skinsResults: Array<{
    hole: number; round: number; winnerId: number | null; winnerName: string | null; winnerScore: number | null; tied: boolean; carriedFrom: number | null;
  }> = [];

  if (cfg?.skinsEnabled) {
    const [tournament] = await db
      .select({ courseId: tournamentsTable.courseId, rounds: tournamentsTable.rounds })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, tournamentId));

    const holeCount = 18;

    const allScores = await db
      .select({
        playerId: scoresTable.playerId,
        holeNumber: scoresTable.holeNumber,
        strokes: scoresTable.strokes,
        round: scoresTable.round,
        firstName: playersTable.firstName,
        lastName: playersTable.lastName,
      })
      .from(scoresTable)
      .leftJoin(playersTable, eq(playersTable.id, scoresTable.playerId))
      .where(eq(scoresTable.tournamentId, tournamentId));

    const rounds = tournament?.rounds ?? 1;
    for (let r = 1; r <= rounds; r++) {
      const roundScores = allScores.filter(s => s.round === r);
      let carryHole: number | null = null;

      for (let hole = 1; hole <= holeCount; hole++) {
        const holeScores = roundScores.filter(s => s.holeNumber === hole);
        if (holeScores.length === 0) {
          skinsResults.push({ hole, round: r, winnerId: null, winnerName: null, winnerScore: null, tied: false, carriedFrom: null });
          continue;
        }

        const minStrokes = Math.min(...holeScores.map(s => s.strokes));
        const winners = holeScores.filter(s => s.strokes === minStrokes);
        const tied = winners.length > 1;

        if (tied) {
          carryHole = hole;
          skinsResults.push({ hole, round: r, winnerId: null, winnerName: null, winnerScore: minStrokes, tied: true, carriedFrom: null });
        } else {
          const w = winners[0];
          skinsResults.push({
            hole,
            round: r,
            winnerId: w.playerId,
            winnerName: `${w.firstName} ${w.lastName}`,
            winnerScore: w.strokes,
            tied: false,
            carriedFrom: carryHole,
          });
          carryHole = null;
        }
      }
    }
  }

  res.json({
    config: cfg ?? null,
    manual: manualResults,
    skins: skinsResults,
  });
});

// POST /api/orgs/:orgId/tournaments/:tournamentId/side-games/results — award CTP/LD/Greenie/manual
router.post("/results", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await verifyTournamentOwnership(orgId, tournamentId, res))) return;
  const { playerId, gameType, holeNumber, round = 1, notes, prize } = req.body;

  if (!playerId || !gameType) {
    res.status(400).json({ error: "playerId and gameType are required" });
    return;
  }

  const [player] = await db
    .select({ id: playersTable.id })
    .from(playersTable)
    .where(and(eq(playersTable.id, parseInt(playerId)), eq(playersTable.tournamentId, tournamentId)));

  if (!player) {
    res.status(404).json({ error: "Player not found in this tournament" });
    return;
  }

  const [result] = await db
    .insert(sideGameResultsTable)
    .values({
      tournamentId,
      playerId: parseInt(playerId),
      gameType,
      holeNumber: holeNumber ? parseInt(holeNumber) : null,
      round,
      notes: notes ?? null,
      prize: prize ?? null,
    })
    .returning();

  res.status(201).json(result);
});

// DELETE /api/orgs/:orgId/tournaments/:tournamentId/side-games/results/:resultId
router.delete("/results/:resultId", async (req: Request, res: Response) => {
  if (!verifyAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await verifyTournamentOwnership(orgId, tournamentId, res))) return;
  const resultId = parseInt(String((req.params as Record<string, string>).resultId));
  const deleted = await db
    .delete(sideGameResultsTable)
    .where(and(eq(sideGameResultsTable.id, resultId), eq(sideGameResultsTable.tournamentId, tournamentId)))
    .returning({ id: sideGameResultsTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "Result not found in this tournament" });
    return;
  }
  res.json({ deleted: true });
});

export default router;
