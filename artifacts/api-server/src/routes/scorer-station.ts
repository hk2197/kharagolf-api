/**
 * Scorer Station — group-centric mobile scoring flow
 *
 * GET    /scorer/groups                 List scorer's groups for the day (by PIN)
 * GET    /scorer/groups/:groupId        Get group detail with hole scores
 * POST   /scorer/groups/:groupId/score  Submit hole score for a player
 * POST   /scorer/groups/:groupId/submit Submit the entire group's round
 * GET    /scorer/course-holes           Get course holes for a tournament
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  scorerPinsTable,
  teeTimesTable,
  teeTimePlayersTable,
  playersTable,
  scoresTable,
  shotsTable,
  tournamentsTable,
  holeDetailsTable,
  coursesTable,
  flightsTable,
  playerFlightsTable,
} from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { computeLeaderboard, notifyLeaderboardUpdate } from "../lib/realtime";

async function broadcastLeaderboardUpdate(orgId: number, tournamentId: number) {
  const leaderboard = await computeLeaderboard(tournamentId);
  notifyLeaderboardUpdate(tournamentId, leaderboard);
}

const router: IRouter = Router({ mergeParams: true });

function getScorerSession(req: Request): { tournamentId: number; orgId: number; pinId: number } | null {
  const session = (req as unknown as { scorerSession?: { tournamentId: number; orgId: number; pinId: number } }).scorerSession;
  return session ?? null;
}

// ─── GET /scorer/groups — list groups for scorer's tournament ──────────────

router.get("/scorer/groups", async (req: Request, res: Response) => {
  const session = getScorerSession(req);
  if (!session) { { res.status(401).json({ error: "Scorer session required" }); return; } }

  const { tournamentId } = session;

  // Get all tee time groups for this tournament
  const groups = await db
    .select({
      teeTimeId: teeTimesTable.id,
      teeTime: teeTimesTable.teeTime,
      startingHole: teeTimesTable.startingHole,
      round: teeTimesTable.round,
    })
    .from(teeTimesTable)
    .where(eq(teeTimesTable.tournamentId, tournamentId))
    .orderBy(teeTimesTable.teeTime);

  const groupsWithPlayers = await Promise.all(groups.map(async (g) => {
    const players = await db
      .select({
        playerId: playersTable.id,
        firstName: playersTable.firstName,
        lastName: playersTable.lastName,
        handicapIndex: playersTable.handicapIndex,
        teamName: playersTable.teamName,
      })
      .from(teeTimePlayersTable)
      .innerJoin(playersTable, eq(teeTimePlayersTable.playerId, playersTable.id))
      .where(eq(teeTimePlayersTable.teeTimeId, g.teeTimeId));

    return { ...g, players };
  }));

  res.json(groupsWithPlayers);
});

// ─── GET /scorer/groups/:groupId — group detail with scores ────────────────

router.get("/scorer/groups/:groupId", async (req: Request, res: Response) => {
  const session = getScorerSession(req);
  if (!session) { { res.status(401).json({ error: "Scorer session required" }); return; } }

  const { tournamentId } = session;
  const teeTimeId = parseInt(String((req.params as Record<string, string>).groupId));
  const round = parseInt(String(req.query.round ?? 1));

  const [teeTime] = await db.select().from(teeTimesTable).where(and(eq(teeTimesTable.id, teeTimeId), eq(teeTimesTable.tournamentId, tournamentId)));
  if (!teeTime) { { res.status(404).json({ error: "Group not found" }); return; } }

  const players = await db
    .select({
      playerId: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      handicapIndex: playersTable.handicapIndex,
      handicapOverride: playersTable.handicapOverride,
    })
    .from(teeTimePlayersTable)
    .innerJoin(playersTable, eq(teeTimePlayersTable.playerId, playersTable.id))
    .where(eq(teeTimePlayersTable.teeTimeId, teeTimeId));

  const [tournament] = await db.select({ courseId: tournamentsTable.courseId }).from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));

  const courseHoles = tournament?.courseId
    ? await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournament.courseId)).orderBy(holeDetailsTable.holeNumber)
    : [];

  const playerIds = players.map(p => p.playerId);
  const scores = playerIds.length > 0
    ? await db.select().from(scoresTable).where(
        and(
          eq(scoresTable.tournamentId, tournamentId),
          eq(scoresTable.round, round),
          inArray(scoresTable.playerId, playerIds),
        )
      )
    : [];

  // Task #1015 — return shots already logged for these players so the mobile
  // scorer screen can render a compact "shots so far" list per (player, hole)
  // and seed the local shotNumber counter from server state.
  const shots = playerIds.length > 0
    ? await db.select({
        id: shotsTable.id,
        playerId: shotsTable.playerId,
        round: shotsTable.round,
        holeNumber: shotsTable.holeNumber,
        shotNumber: shotsTable.shotNumber,
        shotType: shotsTable.shotType,
        club: shotsTable.club,
        lieType: shotsTable.lieType,
        missDirection: shotsTable.missDirection,
        shotShape: shotsTable.shotShape,
        penaltyReason: shotsTable.penaltyReason,
        latitude: shotsTable.latitude,
        longitude: shotsTable.longitude,
        distanceToPin: shotsTable.distanceToPin,
        distanceCarried: shotsTable.distanceCarried,
        source: shotsTable.source,
      }).from(shotsTable).where(
        and(
          eq(shotsTable.tournamentId, tournamentId),
          eq(shotsTable.round, round),
          inArray(shotsTable.playerId, playerIds),
        )
      ).orderBy(shotsTable.holeNumber, shotsTable.shotNumber)
    : [];

  res.json({ teeTime, players, courseHoles, scores, shots, round });
});

// ─── POST /scorer/groups/:groupId/score — save hole score ─────────────────

router.post("/scorer/groups/:groupId/score", async (req: Request, res: Response) => {
  const session = getScorerSession(req);
  if (!session) { { res.status(401).json({ error: "Scorer session required" }); return; } }

  const { tournamentId, orgId } = session;
  const { playerId, holeNumber, strokes, putts, round = 1 } = req.body;

  if (!playerId || !holeNumber || strokes == null) {
    res.status(400).json({ error: "playerId, holeNumber, strokes required" }); return;
  }

  // Verify player belongs to tournament
  const [player] = await db.select().from(playersTable).where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)));
  if (!player) { { res.status(404).json({ error: "Player not in this tournament" }); return; } }

  const [score] = await db.insert(scoresTable).values({
    tournamentId,
    playerId,
    holeNumber,
    round,
    strokes,
    putts: putts ?? null,
  }).onConflictDoUpdate({
    target: [scoresTable.playerId, scoresTable.holeNumber, scoresTable.round],
    set: { strokes, putts: putts ?? null },
  }).returning();

  // Broadcast real-time update
  broadcastLeaderboardUpdate(orgId, tournamentId).catch(() => {});

  res.json(score);
});

// ─── POST /scorer/groups/:groupId/submit — submit group round ──────────────

router.post("/scorer/groups/:groupId/submit", async (req: Request, res: Response) => {
  const session = getScorerSession(req);
  if (!session) { { res.status(401).json({ error: "Scorer session required" }); return; } }

  const { tournamentId, orgId } = session;
  const teeTimeId = parseInt(String((req.params as Record<string, string>).groupId));
  const { round = 1 } = req.body;

  const [teeTime] = await db.select().from(teeTimesTable).where(and(eq(teeTimesTable.id, teeTimeId), eq(teeTimesTable.tournamentId, tournamentId)));
  if (!teeTime) { { res.status(404).json({ error: "Group not found" }); return; } }

  // Final broadcast
  broadcastLeaderboardUpdate(orgId, tournamentId).catch(() => {});

  logger.info({ tournamentId, teeTimeId, round }, "[scorer] Group round submitted");
  res.json({ success: true, message: "Round submitted successfully" });
});

// ─── POST /scorer/groups/:groupId/shots — log a shot on behalf of a player ─
//
// Tournament scorers entering shots from a station insert into the shots
// table with `source: "scorer"` so the round map / per-source analytics
// can colour-code and filter scorer entries (HoleMapPanel renders them
// amber). The shot tuple (playerId, tournamentId, round, holeNumber,
// shotNumber) is unique — repeated submits update in place.
// Mirror shotTypeEnum in lib/db/src/schema/golf.ts. Keep this aligned with
// the DB enum so an invalid type fails request validation (400) rather than
// reaching Postgres and surfacing as a 500.
const ALLOWED_SHOT_TYPES = new Set(["tee", "fairway", "approach", "chip", "sand", "putt"]);

router.post("/scorer/groups/:groupId/shots", async (req: Request, res: Response) => {
  const session = getScorerSession(req);
  if (!session) { { res.status(401).json({ error: "Scorer session required" }); return; } }

  const { tournamentId } = session;
  const teeTimeId = parseInt(String((req.params as Record<string, string>).groupId));
  const {
    playerId, holeNumber, shotNumber, round = 1,
    shotType, club, lieType, missDirection, shotShape, penaltyReason,
    latitude, longitude, distanceToPin, distanceCarried,
  } = req.body as {
    playerId?: number; holeNumber?: number; shotNumber?: number; round?: number;
    shotType?: string; club?: string; lieType?: string; missDirection?: string;
    shotShape?: string; penaltyReason?: string;
    latitude?: number; longitude?: number;
    distanceToPin?: number; distanceCarried?: number;
  };

  if (!playerId || !holeNumber || !shotNumber) {
    res.status(400).json({ error: "playerId, holeNumber, shotNumber required" }); return;
  }
  if (shotType !== undefined && !ALLOWED_SHOT_TYPES.has(shotType)) {
    res.status(400).json({ error: `Invalid shotType. Allowed: ${[...ALLOWED_SHOT_TYPES].join(", ")}` }); return;
  }

  // Verify the player belongs to the tournament *and* to this scorer's group,
  // so a scorer PIN can only post shots for the players they're scoring.
  const [member] = await db
    .select({ playerId: teeTimePlayersTable.playerId })
    .from(teeTimePlayersTable)
    .innerJoin(teeTimesTable, eq(teeTimePlayersTable.teeTimeId, teeTimesTable.id))
    .where(and(
      eq(teeTimePlayersTable.teeTimeId, teeTimeId),
      eq(teeTimePlayersTable.playerId, playerId),
      eq(teeTimesTable.tournamentId, tournamentId),
    ));
  if (!member) { { res.status(404).json({ error: "Player not in this group/tournament" }); return; } }

  const insertValues: typeof shotsTable.$inferInsert = {
    tournamentId,
    playerId,
    round,
    holeNumber,
    shotNumber,
    shotType: (shotType as typeof shotsTable.$inferInsert["shotType"]) ?? "fairway",
    club: club ?? null,
    lieType: lieType ?? null,
    missDirection: missDirection ?? null,
    shotShape: shotShape ?? null,
    penaltyReason: penaltyReason ?? null,
    latitude: latitude != null ? String(latitude) : null,
    longitude: longitude != null ? String(longitude) : null,
    distanceToPin: distanceToPin != null ? String(distanceToPin) : null,
    distanceCarried: distanceCarried != null ? String(distanceCarried) : null,
    source: "scorer",
  };

  try {
    await db.insert(shotsTable).values(insertValues).onConflictDoUpdate({
      target: [shotsTable.playerId, shotsTable.tournamentId, shotsTable.round, shotsTable.holeNumber, shotsTable.shotNumber],
      targetWhere: sql`player_id IS NOT NULL AND tournament_id IS NOT NULL`,
      set: {
        shotType: insertValues.shotType,
        club: insertValues.club,
        lieType: insertValues.lieType,
        missDirection: insertValues.missDirection,
        shotShape: insertValues.shotShape,
        penaltyReason: insertValues.penaltyReason,
        latitude: insertValues.latitude,
        longitude: insertValues.longitude,
        distanceToPin: insertValues.distanceToPin,
        distanceCarried: insertValues.distanceCarried,
        source: "scorer",
      },
    });
  } catch (err) {
    logger.error({ err, tournamentId, playerId, holeNumber, shotNumber }, "[scorer] Failed to upsert shot");
    res.status(500).json({ error: "Failed to save shot" });
    return;
  }

  const [row] = await db.select().from(shotsTable).where(and(
    eq(shotsTable.playerId, playerId),
    eq(shotsTable.tournamentId, tournamentId),
    eq(shotsTable.round, round),
    eq(shotsTable.holeNumber, holeNumber),
    eq(shotsTable.shotNumber, shotNumber),
  ));

  res.json({ ok: true, shot: row });
});

// ─── DELETE /scorer/groups/:groupId/shots/:shotId — remove mistaken shot ──
//
// Scorers occasionally double-tap "Save shot" or pick the wrong player and
// need a way to remove a row that's already in the DB. We verify the shot
// belongs to a player in this scorer's group (and tournament) before
// deleting so a PIN can't reach into another group's shots.
router.delete("/scorer/groups/:groupId/shots/:shotId", async (req: Request, res: Response) => {
  const session = getScorerSession(req);
  if (!session) { { res.status(401).json({ error: "Scorer session required" }); return; } }

  const { tournamentId } = session;
  const teeTimeId = parseInt(String((req.params as Record<string, string>).groupId));
  const shotId = parseInt(String((req.params as Record<string, string>).shotId));

  if (!Number.isFinite(teeTimeId) || !Number.isFinite(shotId)) {
    res.status(400).json({ error: "Invalid groupId or shotId" }); return;
  }

  // Look up the shot and confirm it belongs to a player in this scorer's group.
  const [shot] = await db
    .select({
      id: shotsTable.id,
      playerId: shotsTable.playerId,
      tournamentId: shotsTable.tournamentId,
    })
    .from(shotsTable)
    .innerJoin(teeTimePlayersTable, eq(teeTimePlayersTable.playerId, shotsTable.playerId))
    .innerJoin(teeTimesTable, eq(teeTimePlayersTable.teeTimeId, teeTimesTable.id))
    .where(and(
      eq(shotsTable.id, shotId),
      eq(shotsTable.tournamentId, tournamentId),
      eq(teeTimePlayersTable.teeTimeId, teeTimeId),
      eq(teeTimesTable.tournamentId, tournamentId),
    ));

  if (!shot) {
    res.status(404).json({ error: "Shot not found in this group/tournament" });
    return;
  }

  try {
    await db.delete(shotsTable).where(eq(shotsTable.id, shotId));
  } catch (err) {
    logger.error({ err, tournamentId, teeTimeId, shotId }, "[scorer] Failed to delete shot");
    res.status(500).json({ error: "Failed to delete shot" });
    return;
  }

  res.json({ ok: true, shotId });
});

// ─── GET /scorer/course-holes — course holes for the tournament ────────────

router.get("/scorer/course-holes", async (req: Request, res: Response) => {
  const session = getScorerSession(req);
  if (!session) { { res.status(401).json({ error: "Scorer session required" }); return; } }

  const { tournamentId } = session;
  const [tournament] = await db.select({
    courseId: tournamentsTable.courseId,
    localRules: tournamentsTable.localRules,
    localRulesConfig: tournamentsTable.localRulesConfig,
  }).from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));

  const localRules = tournament?.localRules ?? null;
  const localRulesConfig = tournament?.localRulesConfig ?? null;

  if (!tournament?.courseId) {
    res.json({ holes: [], localRules, localRulesConfig });
    return;
  }

  const holes = await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournament.courseId)).orderBy(holeDetailsTable.holeNumber);
  res.json({ holes, localRules, localRulesConfig });
});

export default router;
