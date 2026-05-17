import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  matchPlayBracketTable,
  bracketRoundsTable,
  bracketMatchesTable,
  ryderCupConfigTable,
  ryderCupSessionsTable,
  ryderCupMatchesTable,
  playersTable,
  tournamentsTable,
} from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// GET /api/public/brackets/:shareToken
// Spectator view — no auth, read-only bracket data + tournament summary.
router.get("/brackets/:shareToken", async (req: Request, res: Response) => {
  const shareToken = (req.params as Record<string, string>).shareToken;
  if (!shareToken) { res.status(400).json({ error: "Invalid share token" }); return; }
  try {
    const [bracket] = await db.select().from(matchPlayBracketTable)
      .where(eq(matchPlayBracketTable.shareToken, shareToken));
    if (!bracket) { res.status(404).json({ error: "Bracket not found" }); return; }

    const [tournament] = await db.select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      startDate: tournamentsTable.startDate,
      endDate: tournamentsTable.endDate,
      status: tournamentsTable.status,
    }).from(tournamentsTable).where(eq(tournamentsTable.id, bracket.tournamentId));

    const rounds = await db.select().from(bracketRoundsTable)
      .where(eq(bracketRoundsTable.bracketId, bracket.id))
      .orderBy(asc(bracketRoundsTable.bracketType), asc(bracketRoundsTable.roundNumber));

    const matches = await db.select().from(bracketMatchesTable)
      .where(eq(bracketMatchesTable.bracketId, bracket.id))
      .orderBy(asc(bracketMatchesTable.roundId), asc(bracketMatchesTable.matchNumber));

    const playerList = await db.select({
      id: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      handicapIndex: playersTable.handicapIndex,
    }).from(playersTable).where(eq(playersTable.tournamentId, bracket.tournamentId));
    const playerMap = new Map(playerList.map(p => [p.id, p]));

    const enriched = matches.map(m => ({
      ...m,
      player1: m.player1Id ? (playerMap.get(m.player1Id) ?? null) : null,
      player2: m.player2Id ? (playerMap.get(m.player2Id) ?? null) : null,
      winner: m.winnerId ? (playerMap.get(m.winnerId) ?? null) : null,
    }));

    res.json({ tournament, bracket, rounds, matches: enriched });
  } catch (err) {
    logger.error({ err }, "Failed to fetch public bracket");
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/public/ryder-cup/:shareToken
router.get("/ryder-cup/:shareToken", async (req: Request, res: Response) => {
  const shareToken = (req.params as Record<string, string>).shareToken;
  if (!shareToken) { res.status(400).json({ error: "Invalid share token" }); return; }
  try {
    const [config] = await db.select().from(ryderCupConfigTable)
      .where(eq(ryderCupConfigTable.shareToken, shareToken));
    if (!config) { res.status(404).json({ error: "Ryder Cup not found" }); return; }

    const [tournament] = await db.select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      startDate: tournamentsTable.startDate,
      endDate: tournamentsTable.endDate,
      status: tournamentsTable.status,
    }).from(tournamentsTable).where(eq(tournamentsTable.id, config.tournamentId));

    const sessions = await db.select().from(ryderCupSessionsTable)
      .where(eq(ryderCupSessionsTable.tournamentId, config.tournamentId))
      .orderBy(asc(ryderCupSessionsTable.sessionNumber));

    const matches = await db.select().from(ryderCupMatchesTable)
      .where(eq(ryderCupMatchesTable.tournamentId, config.tournamentId))
      .orderBy(asc(ryderCupMatchesTable.sessionId), asc(ryderCupMatchesTable.matchNumber));

    const playerList = await db.select({
      id: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
    }).from(playersTable).where(eq(playersTable.tournamentId, config.tournamentId));
    const playerMap = new Map(playerList.map(p => [p.id, p]));

    const enriched = matches.map(m => ({
      ...m,
      team1Player1: m.team1Player1Id ? (playerMap.get(m.team1Player1Id) ?? null) : null,
      team1Player2: m.team1Player2Id ? (playerMap.get(m.team1Player2Id) ?? null) : null,
      team2Player1: m.team2Player1Id ? (playerMap.get(m.team2Player1Id) ?? null) : null,
      team2Player2: m.team2Player2Id ? (playerMap.get(m.team2Player2Id) ?? null) : null,
    }));

    let team1Total = 0, team2Total = 0;
    for (const m of matches) { team1Total += Number(m.team1Points); team2Total += Number(m.team2Points); }

    res.json({
      tournament,
      config,
      sessions,
      matches: enriched,
      runningTotals: { team1: team1Total, team2: team2Total },
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch public Ryder Cup");
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
