import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  fantasyLeaguesTable, fantasyTeamsTable, fantasyDraftPicksTable,
  fantasyScoringRulesTable, fantasyStandingsTable, fantasyMatchupsTable,
  playersTable, appUsersTable, tournamentsTable,
  scoresTable, holeDetailsTable,
} from "@workspace/db";
import { eq, sql, and, desc, asc, count, sum } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import { sendTransactionalPush } from "../lib/comms";
import { logger } from "../lib/logger";
import crypto from "crypto";
import { notifyFantasyUpdate } from "../lib/realtime";

const router: IRouter = Router({ mergeParams: true });

// ─── Default scoring rules ────────────────────────────────────────────────
const DEFAULT_SCORING_RULES: Array<{ event: string; points: number }> = [
  { event: "hole_in_one", points: 20 },
  { event: "eagle", points: 8 },
  { event: "birdie", points: 3 },
  { event: "par", points: 1 },
  { event: "bogey", points: 0 },
  { event: "double_bogey", points: -1 },
  { event: "triple_bogey_plus", points: -2 },
  { event: "finish_1st", points: 15 },
  { event: "finish_2nd", points: 10 },
  { event: "finish_3rd", points: 7 },
  { event: "finish_top5", points: 5 },
  { event: "finish_top10", points: 3 },
  { event: "under_par_round", points: 2 },
  { event: "par_round", points: 1 },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCallerUserId(req: Request): number | null {
  const caller = req.user as { id?: number } | undefined;
  return caller?.id ?? null;
}

function generateInviteCode(): string {
  return crypto.randomBytes(5).toString("hex").toUpperCase();
}

/**
 * Recalculate fantasy points for all teams in a fantasy league.
 * Called after each real score is submitted for a linked tournament.
 */
async function recalcFantasyPoints(fantasyLeagueId: number): Promise<void> {
  try {
    const fl = await db
      .select()
      .from(fantasyLeaguesTable)
      .where(eq(fantasyLeaguesTable.id, fantasyLeagueId));
    if (!fl.length || !fl[0].tournamentId) return;
    const tournamentId = fl[0].tournamentId;

    // Get all scoring rules for this fantasy league
    const rules = await db
      .select()
      .from(fantasyScoringRulesTable)
      .where(eq(fantasyScoringRulesTable.fantasyLeagueId, fantasyLeagueId));
    const ruleMap = new Map(rules.map(r => [r.event, r.points]));

    // Get hole pars for the tournament's course
    const [tournament] = await db
      .select({ courseId: tournamentsTable.courseId })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, tournamentId));
    if (!tournament?.courseId) return;

    const holes = await db
      .select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
      .from(holeDetailsTable)
      .where(eq(holeDetailsTable.courseId, tournament.courseId));
    const parMap = new Map(holes.map(h => [h.holeNumber, h.par]));

    // Get all draft picks for this fantasy league
    const picks = await db
      .select({
        fantasyTeamId: fantasyDraftPicksTable.fantasyTeamId,
        playerId: fantasyDraftPicksTable.playerId,
        fantasyLeagueId: fantasyDraftPicksTable.fantasyLeagueId,
      })
      .from(fantasyDraftPicksTable)
      .where(eq(fantasyDraftPicksTable.fantasyLeagueId, fantasyLeagueId));

    // For each pick, compute fantasy points from real scores
    for (const pick of picks) {
      const scores = await db
        .select()
        .from(scoresTable)
        .where(and(
          eq(scoresTable.playerId, pick.playerId),
          eq(scoresTable.tournamentId, tournamentId),
        ));

      const breakdown: Record<string, number> = {};
      let total = 0;

      for (const score of scores) {
        const par = parMap.get(score.holeNumber) ?? 4;
        const diff = score.strokes - par;
        let event: string | null = null;
        if (score.strokes === 1) event = "hole_in_one";
        else if (diff <= -2) event = "eagle";
        else if (diff === -1) event = "birdie";
        else if (diff === 0) event = "par";
        else if (diff === 1) event = "bogey";
        else if (diff === 2) event = "double_bogey";
        else if (diff >= 3) event = "triple_bogey_plus";

        if (event) {
          const pts = ruleMap.get(event as never) ?? 0;
          breakdown[event] = (breakdown[event] ?? 0) + pts;
          total += pts;
        }
      }

      // Check if all holes are played — award finishing position bonus
      if (scores.length >= 18) {
        // Get leaderboard position: count players whose total strokes is lower
        const totalStrokes = scores.reduce((s, r) => s + r.strokes, 0);
        const betterPlayersResult = await db.execute(sql`
          SELECT COUNT(*)::int AS n
          FROM (
            SELECT player_id
            FROM scores
            WHERE tournament_id = ${tournamentId}
              AND player_id != ${pick.playerId}
            GROUP BY player_id
            HAVING SUM(strokes) < ${totalStrokes}
          ) sub
        `);
        const position = (Number((betterPlayersResult.rows[0] as { n: number })?.n ?? 0)) + 1;
        let posEvent: string | null = null;
        if (position === 1) posEvent = "finish_1st";
        else if (position === 2) posEvent = "finish_2nd";
        else if (position === 3) posEvent = "finish_3rd";
        else if (position <= 5) posEvent = "finish_top5";
        else if (position <= 10) posEvent = "finish_top10";

        if (posEvent) {
          const pts = ruleMap.get(posEvent as never) ?? 0;
          breakdown[posEvent] = pts;
          total += pts;
        }

        // Under par / par round bonus
        const totalPar = Array.from(parMap.values()).reduce((a, b) => a + b, 0);
        if (totalStrokes < totalPar) {
          const pts = ruleMap.get("under_par_round" as never) ?? 0;
          breakdown["under_par_round"] = pts;
          total += pts;
        } else if (totalStrokes === totalPar) {
          const pts = ruleMap.get("par_round" as never) ?? 0;
          breakdown["par_round"] = pts;
          total += pts;
        }
      }

      // Upsert fantasy_standings
      await db
        .insert(fantasyStandingsTable)
        .values({
          fantasyLeagueId,
          fantasyTeamId: pick.fantasyTeamId,
          playerId: pick.playerId,
          fantasyPoints: total,
          pointsBreakdown: breakdown,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [fantasyStandingsTable.fantasyTeamId, fantasyStandingsTable.playerId],
          set: {
            fantasyPoints: total,
            pointsBreakdown: breakdown,
            updatedAt: new Date(),
          },
        });
    }

    // Update total_fantasy_points per team
    const teams = await db
      .select({ id: fantasyTeamsTable.id })
      .from(fantasyTeamsTable)
      .where(eq(fantasyTeamsTable.fantasyLeagueId, fantasyLeagueId));

    for (const team of teams) {
      const [pts] = await db
        .select({ total: sum(fantasyStandingsTable.fantasyPoints) })
        .from(fantasyStandingsTable)
        .where(eq(fantasyStandingsTable.fantasyTeamId, team.id));
      await db
        .update(fantasyTeamsTable)
        .set({ totalFantasyPoints: Number(pts?.total ?? 0) })
        .where(eq(fantasyTeamsTable.id, team.id));
    }

    // Compute positions
    const allTeams = await db
      .select({ id: fantasyTeamsTable.id, totalFantasyPoints: fantasyTeamsTable.totalFantasyPoints })
      .from(fantasyTeamsTable)
      .where(eq(fantasyTeamsTable.fantasyLeagueId, fantasyLeagueId))
      .orderBy(desc(fantasyTeamsTable.totalFantasyPoints));

    for (let i = 0; i < allTeams.length; i++) {
      await db
        .update(fantasyTeamsTable)
        .set({ position: i + 1 })
        .where(eq(fantasyTeamsTable.id, allTeams[i].id));
    }

    // Notify SSE subscribers
    const updatedTeams = await db
      .select({
        id: fantasyTeamsTable.id,
        name: fantasyTeamsTable.name,
        totalFantasyPoints: fantasyTeamsTable.totalFantasyPoints,
        position: fantasyTeamsTable.position,
      })
      .from(fantasyTeamsTable)
      .where(eq(fantasyTeamsTable.fantasyLeagueId, fantasyLeagueId))
      .orderBy(asc(fantasyTeamsTable.position));
    notifyFantasyUpdate(fantasyLeagueId, { teams: updatedTeams });
  } catch (err) {
    logger.warn({ err, fantasyLeagueId }, "[fantasy] recalcFantasyPoints failed");
  }
}

// Export for use by scores route
export { recalcFantasyPoints };

// ─── GET /organizations/:orgId/fantasy ─────────────────────────────────────
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const leagues = await db
    .select({
      id: fantasyLeaguesTable.id,
      name: fantasyLeaguesTable.name,
      description: fantasyLeaguesTable.description,
      status: fantasyLeaguesTable.status,
      format: fantasyLeaguesTable.format,
      draftType: fantasyLeaguesTable.draftType,
      rosterSize: fantasyLeaguesTable.rosterSize,
      maxTeams: fantasyLeaguesTable.maxTeams,
      draftDeadlineAt: fantasyLeaguesTable.draftDeadlineAt,
      rosterLockAt: fantasyLeaguesTable.rosterLockAt,
      inviteCode: fantasyLeaguesTable.inviteCode,
      leagueId: fantasyLeaguesTable.leagueId,
      tournamentId: fantasyLeaguesTable.tournamentId,
      commissionerUserId: fantasyLeaguesTable.commissionerUserId,
      createdAt: fantasyLeaguesTable.createdAt,
    })
    .from(fantasyLeaguesTable)
    .where(eq(fantasyLeaguesTable.organizationId, orgId))
    .orderBy(desc(fantasyLeaguesTable.createdAt));

  const results = await Promise.all(leagues.map(async (fl) => {
    const [tc] = await db.select({ count: count() }).from(fantasyTeamsTable).where(eq(fantasyTeamsTable.fantasyLeagueId, fl.id));
    return { ...fl, teamCount: Number(tc?.count ?? 0) };
  }));

  res.json(results);
});

// ─── POST /organizations/:orgId/fantasy ─────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    name, description, format, draftType, rosterSize, maxTeams,
    draftDeadlineAt, rosterLockAt, leagueId, tournamentId,
  } = req.body as {
    name?: string; description?: string; format?: string; draftType?: string;
    rosterSize?: number; maxTeams?: number; draftDeadlineAt?: string;
    rosterLockAt?: string; leagueId?: number; tournamentId?: number;
  };

  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }
  if (!tournamentId) { { res.status(400).json({ error: "tournamentId is required" }); return; } }

  const userId = getCallerUserId(req);
  const inviteCode = generateInviteCode();

  const [fl] = await db
    .insert(fantasyLeaguesTable)
    .values({
      organizationId: orgId,
      leagueId: leagueId ?? null,
      tournamentId,
      name,
      description,
      format: (format as "overall_standings" | "head_to_head") ?? "overall_standings",
      draftType: (draftType as "snake" | "simultaneous") ?? "snake",
      rosterSize: rosterSize ?? 5,
      maxTeams: maxTeams ?? null,
      draftDeadlineAt: draftDeadlineAt ? new Date(draftDeadlineAt) : null,
      rosterLockAt: rosterLockAt ? new Date(rosterLockAt) : null,
      inviteCode,
      commissionerUserId: userId,
    })
    .returning();

  // Seed default scoring rules
  type ScoreEvent = "hole_in_one" | "eagle" | "birdie" | "par" | "bogey" | "double_bogey" | "triple_bogey_plus"
    | "finish_1st" | "finish_2nd" | "finish_3rd" | "finish_top5" | "finish_top10"
    | "under_par_round" | "par_round";
  await db.insert(fantasyScoringRulesTable).values(
    DEFAULT_SCORING_RULES.map(r => ({
      fantasyLeagueId: fl.id,
      event: r.event as ScoreEvent,
      points: r.points,
    })),
  ).onConflictDoNothing();

  res.status(201).json({ ...fl, teamCount: 0 });
});

// ─── GET /organizations/:orgId/fantasy/:fantasyLeagueId ─────────────────────
router.get("/:fantasyLeagueId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fantasyLeagueId = parseInt(String((req.params as Record<string, string>).fantasyLeagueId));

  const [fl] = await db
    .select()
    .from(fantasyLeaguesTable)
    .where(and(
      eq(fantasyLeaguesTable.id, fantasyLeagueId),
      eq(fantasyLeaguesTable.organizationId, orgId),
    ));

  if (!fl) { { res.status(404).json({ error: "Fantasy league not found" }); return; } }

  const teams = await db
    .select({
      id: fantasyTeamsTable.id,
      name: fantasyTeamsTable.name,
      draftOrder: fantasyTeamsTable.draftOrder,
      totalFantasyPoints: fantasyTeamsTable.totalFantasyPoints,
      position: fantasyTeamsTable.position,
      userId: fantasyTeamsTable.userId,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      profileImage: appUsersTable.profileImage,
    })
    .from(fantasyTeamsTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, fantasyTeamsTable.userId))
    .where(eq(fantasyTeamsTable.fantasyLeagueId, fantasyLeagueId))
    .orderBy(asc(fantasyTeamsTable.position));

  const scoringRules = await db
    .select()
    .from(fantasyScoringRulesTable)
    .where(eq(fantasyScoringRulesTable.fantasyLeagueId, fantasyLeagueId));

  const picks = await db
    .select({
      id: fantasyDraftPicksTable.id,
      fantasyTeamId: fantasyDraftPicksTable.fantasyTeamId,
      playerId: fantasyDraftPicksTable.playerId,
      pickNumber: fantasyDraftPicksTable.pickNumber,
      round: fantasyDraftPicksTable.round,
      pickedAt: fantasyDraftPicksTable.pickedAt,
      playerFirstName: playersTable.firstName,
      playerLastName: playersTable.lastName,
      playerHandicap: playersTable.handicapIndex,
    })
    .from(fantasyDraftPicksTable)
    .innerJoin(playersTable, eq(playersTable.id, fantasyDraftPicksTable.playerId))
    .where(eq(fantasyDraftPicksTable.fantasyLeagueId, fantasyLeagueId))
    .orderBy(asc(fantasyDraftPicksTable.pickNumber));

  const standings = await db
    .select({
      id: fantasyStandingsTable.id,
      fantasyTeamId: fantasyStandingsTable.fantasyTeamId,
      playerId: fantasyStandingsTable.playerId,
      fantasyPoints: fantasyStandingsTable.fantasyPoints,
      pointsBreakdown: fantasyStandingsTable.pointsBreakdown,
      playerFirstName: playersTable.firstName,
      playerLastName: playersTable.lastName,
    })
    .from(fantasyStandingsTable)
    .innerJoin(playersTable, eq(playersTable.id, fantasyStandingsTable.playerId))
    .where(eq(fantasyStandingsTable.fantasyLeagueId, fantasyLeagueId));

  const matchups = fl.format === "head_to_head"
    ? await db
      .select()
      .from(fantasyMatchupsTable)
      .where(eq(fantasyMatchupsTable.fantasyLeagueId, fantasyLeagueId))
      .orderBy(asc(fantasyMatchupsTable.round))
    : [];

  res.json({ ...fl, teams, scoringRules, picks, standings, matchups });
});

// ─── PUT /organizations/:orgId/fantasy/:fantasyLeagueId ─────────────────────
router.put("/:fantasyLeagueId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fantasyLeagueId = parseInt(String((req.params as Record<string, string>).fantasyLeagueId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    name, description, status, format, draftType, rosterSize, maxTeams,
    draftDeadlineAt, rosterLockAt,
  } = req.body as {
    name?: string; description?: string; status?: string; format?: string;
    draftType?: string; rosterSize?: number; maxTeams?: number;
    draftDeadlineAt?: string; rosterLockAt?: string;
  };

  const [fl] = await db
    .update(fantasyLeaguesTable)
    .set({
      name,
      description,
      status: status as "setup" | "drafting" | "active" | "completed" | undefined,
      format: format as "overall_standings" | "head_to_head" | undefined,
      draftType: draftType as "snake" | "simultaneous" | undefined,
      rosterSize,
      maxTeams,
      draftDeadlineAt: draftDeadlineAt ? new Date(draftDeadlineAt) : undefined,
      rosterLockAt: rosterLockAt ? new Date(rosterLockAt) : undefined,
      updatedAt: new Date(),
    })
    .where(and(
      eq(fantasyLeaguesTable.id, fantasyLeagueId),
      eq(fantasyLeaguesTable.organizationId, orgId),
    ))
    .returning();

  if (!fl) { { res.status(404).json({ error: "Fantasy league not found" }); return; } }
  res.json(fl);
});

// ─── PUT /organizations/:orgId/fantasy/:fantasyLeagueId/scoring-rules ────────
router.put("/:fantasyLeagueId/scoring-rules", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fantasyLeagueId = parseInt(String((req.params as Record<string, string>).fantasyLeagueId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Verify the fantasy league belongs to this org
  const [leagueCheck] = await db
    .select({ id: fantasyLeaguesTable.id })
    .from(fantasyLeaguesTable)
    .where(and(eq(fantasyLeaguesTable.id, fantasyLeagueId), eq(fantasyLeaguesTable.organizationId, orgId)));
  if (!leagueCheck) { { res.status(404).json({ error: "Fantasy league not found" }); return; } }

  const { rules } = req.body as { rules: Array<{ event: string; points: number }> };
  if (!Array.isArray(rules)) { { res.status(400).json({ error: "rules must be an array" }); return; } }

  type ScoreEventKey = "hole_in_one" | "eagle" | "birdie" | "par" | "bogey" | "double_bogey" | "triple_bogey_plus"
    | "finish_1st" | "finish_2nd" | "finish_3rd" | "finish_top5" | "finish_top10"
    | "under_par_round" | "par_round";
  for (const rule of rules) {
    await db
      .insert(fantasyScoringRulesTable)
      .values({
        fantasyLeagueId,
        event: rule.event as ScoreEventKey,
        points: rule.points,
      })
      .onConflictDoUpdate({
        target: [fantasyScoringRulesTable.fantasyLeagueId, fantasyScoringRulesTable.event],
        set: { points: rule.points },
      });
  }

  const updated = await db
    .select()
    .from(fantasyScoringRulesTable)
    .where(eq(fantasyScoringRulesTable.fantasyLeagueId, fantasyLeagueId));
  res.json(updated);
});

// ─── POST /organizations/:orgId/fantasy/:fantasyLeagueId/join ────────────────
router.post("/:fantasyLeagueId/join", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fantasyLeagueId = parseInt(String((req.params as Record<string, string>).fantasyLeagueId));
  const userId = getCallerUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const { teamName, inviteCode } = req.body as { teamName?: string; inviteCode?: string };

  const [fl] = await db
    .select()
    .from(fantasyLeaguesTable)
    .where(and(
      eq(fantasyLeaguesTable.id, fantasyLeagueId),
      eq(fantasyLeaguesTable.organizationId, orgId),
    ));

  if (!fl) { { res.status(404).json({ error: "Fantasy league not found" }); return; } }
  if (fl.inviteCode && fl.inviteCode !== inviteCode) {
    res.status(403).json({ error: "Invalid invite code" }); return;
  }
  if (fl.status !== "setup" && fl.status !== "drafting") {
    res.status(400).json({ error: "This fantasy league is no longer accepting new teams" }); return;
  }

  const [teamCount] = await db
    .select({ count: count() })
    .from(fantasyTeamsTable)
    .where(eq(fantasyTeamsTable.fantasyLeagueId, fantasyLeagueId));

  if (fl.maxTeams && Number(teamCount?.count ?? 0) >= fl.maxTeams) {
    res.status(400).json({ error: "This fantasy league is full" }); return;
  }

  const [user] = await db
    .select({ displayName: appUsersTable.displayName, username: appUsersTable.username })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, userId));

  const name = teamName?.trim() || `${user?.displayName ?? user?.username ?? "Team"}'s Team`;

  const [team] = await db
    .insert(fantasyTeamsTable)
    .values({
      fantasyLeagueId,
      userId,
      name,
    })
    .onConflictDoNothing()
    .returning();

  if (!team) {
    const [existing] = await db
      .select()
      .from(fantasyTeamsTable)
      .where(and(
        eq(fantasyTeamsTable.fantasyLeagueId, fantasyLeagueId),
        eq(fantasyTeamsTable.userId, userId),
      ));
    res.json(existing);
    return;
  }

  res.status(201).json(team);
});

// ─── POST /organizations/:orgId/fantasy/:fantasyLeagueId/start-draft ─────────
router.post("/:fantasyLeagueId/start-draft", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fantasyLeagueId = parseInt(String((req.params as Record<string, string>).fantasyLeagueId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [fl] = await db
    .select()
    .from(fantasyLeaguesTable)
    .where(and(
      eq(fantasyLeaguesTable.id, fantasyLeagueId),
      eq(fantasyLeaguesTable.organizationId, orgId),
    ));
  if (!fl) { { res.status(404).json({ error: "Fantasy league not found" }); return; } }

  const teams = await db
    .select()
    .from(fantasyTeamsTable)
    .where(eq(fantasyTeamsTable.fantasyLeagueId, fantasyLeagueId));

  if (teams.length < 2) {
    res.status(400).json({ error: "Need at least 2 teams to start the draft" }); return;
  }

  // Randomly assign draft orders
  const shuffled = [...teams].sort(() => Math.random() - 0.5);
  for (let i = 0; i < shuffled.length; i++) {
    await db
      .update(fantasyTeamsTable)
      .set({ draftOrder: i + 1 })
      .where(eq(fantasyTeamsTable.id, shuffled[i].id));
  }

  await db
    .update(fantasyLeaguesTable)
    .set({ status: "drafting", updatedAt: new Date() })
    .where(eq(fantasyLeaguesTable.id, fantasyLeagueId));

  // Notify all team owners it's time to draft
  const userIds = teams
    .map(t => t.userId)
    .filter((id): id is number => id != null);
  if (userIds.length) {
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendTransactionalPush(
      userIds,
      "Fantasy Draft Started!",
      `The draft for "${fl.name}" has begun. Make your picks!`,
      { type: "fantasy_draft_start", fantasyLeagueId },
    ).catch(() => {});
  }

  res.json({ message: "Draft started", teams: shuffled });
});

// ─── POST /organizations/:orgId/fantasy/:fantasyLeagueId/pick ─────────────────
router.post("/:fantasyLeagueId/pick", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fantasyLeagueId = parseInt(String((req.params as Record<string, string>).fantasyLeagueId));
  const userId = getCallerUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const { playerId } = req.body as { playerId?: number };
  if (!playerId) { { res.status(400).json({ error: "playerId is required" }); return; } }

  const [fl] = await db
    .select()
    .from(fantasyLeaguesTable)
    .where(and(
      eq(fantasyLeaguesTable.id, fantasyLeagueId),
      eq(fantasyLeaguesTable.organizationId, orgId),
    ));
  if (!fl) { { res.status(404).json({ error: "Fantasy league not found" }); return; } }
  if (fl.status !== "drafting") {
    res.status(400).json({ error: "Draft is not currently active" }); return;
  }

  // Enforce draft deadline
  if (fl.draftDeadlineAt && new Date() > new Date(fl.draftDeadlineAt)) {
    res.status(400).json({ error: "Draft deadline has passed" }); return;
  }

  // Enforce roster lock (typically tournament start)
  if (fl.rosterLockAt && new Date() > new Date(fl.rosterLockAt)) {
    res.status(400).json({ error: "Rosters are locked — the tournament has started" }); return;
  }

  // Verify caller owns a team
  const [myTeam] = await db
    .select()
    .from(fantasyTeamsTable)
    .where(and(
      eq(fantasyTeamsTable.fantasyLeagueId, fantasyLeagueId),
      eq(fantasyTeamsTable.userId, userId),
    ));
  if (!myTeam) { { res.status(403).json({ error: "You don't have a team in this fantasy league" }); return; } }

  // Verify player is in the tournament
  if (fl.tournamentId) {
    const [p] = await db
      .select({ id: playersTable.id })
      .from(playersTable)
      .where(and(
        eq(playersTable.id, playerId),
        eq(playersTable.tournamentId, fl.tournamentId),
      ));
    if (!p) { { res.status(400).json({ error: "Player is not registered in the linked tournament" }); return; } }
  }

  // Check player not already picked
  const [existingPick] = await db
    .select()
    .from(fantasyDraftPicksTable)
    .where(and(
      eq(fantasyDraftPicksTable.fantasyLeagueId, fantasyLeagueId),
      eq(fantasyDraftPicksTable.playerId, playerId),
    ));
  if (existingPick) { { res.status(400).json({ error: "This player has already been drafted" }); return; } }

  // Check my roster isn't full
  const [rosterCount] = await db
    .select({ count: count() })
    .from(fantasyDraftPicksTable)
    .where(eq(fantasyDraftPicksTable.fantasyTeamId, myTeam.id));
  if (Number(rosterCount?.count ?? 0) >= fl.rosterSize) {
    res.status(400).json({ error: "Your roster is full" }); return;
  }

  // For snake draft: verify it's this team's turn
  if (fl.draftType === "snake") {
    const allPicks = await db
      .select()
      .from(fantasyDraftPicksTable)
      .where(eq(fantasyDraftPicksTable.fantasyLeagueId, fantasyLeagueId))
      .orderBy(asc(fantasyDraftPicksTable.pickNumber));

    const teams = await db
      .select()
      .from(fantasyTeamsTable)
      .where(eq(fantasyTeamsTable.fantasyLeagueId, fantasyLeagueId))
      .orderBy(asc(fantasyTeamsTable.draftOrder));

    const totalPicks = allPicks.length;
    const numTeams = teams.length;
    const draftRound = Math.floor(totalPicks / numTeams);
    const pickInRound = totalPicks % numTeams;
    const isEvenRound = draftRound % 2 === 0;
    const teamIdx = isEvenRound ? pickInRound : (numTeams - 1 - pickInRound);
    const expectedTeam = teams[teamIdx];

    if (expectedTeam?.id !== myTeam.id) {
      res.status(400).json({ error: "It is not your turn to pick" }); return;
    }
  }

  const [nextPick] = await db
    .select({ max: sql<number>`COALESCE(MAX(${fantasyDraftPicksTable.pickNumber}), 0)` })
    .from(fantasyDraftPicksTable)
    .where(eq(fantasyDraftPicksTable.fantasyLeagueId, fantasyLeagueId));

  const pickNumber = Number(nextPick?.max ?? 0) + 1;
  const teamCountRows = await db.select({ count: count() }).from(fantasyTeamsTable).where(eq(fantasyTeamsTable.fantasyLeagueId, fantasyLeagueId));
  const draftRoundNum = Math.ceil(pickNumber / Number(teamCountRows[0]?.count ?? 1));

  const [pick] = await db
    .insert(fantasyDraftPicksTable)
    .values({
      fantasyLeagueId,
      fantasyTeamId: myTeam.id,
      playerId,
      pickNumber,
      round: draftRoundNum,
    })
    .returning();

  // Notify next team (for snake draft)
  const allPicks = await db
    .select()
    .from(fantasyDraftPicksTable)
    .where(eq(fantasyDraftPicksTable.fantasyLeagueId, fantasyLeagueId));
  const teams = await db
    .select()
    .from(fantasyTeamsTable)
    .where(eq(fantasyTeamsTable.fantasyLeagueId, fantasyLeagueId))
    .orderBy(asc(fantasyTeamsTable.draftOrder));

  const totalPicks = allPicks.length;
  const numTeams = teams.length;
  const maxPicks = fl.rosterSize * numTeams;

  if (totalPicks < maxPicks) {
    if (fl.draftType === "snake") {
      const draftRound2 = Math.floor(totalPicks / numTeams);
      const pickInRound2 = totalPicks % numTeams;
      const isEvenRound2 = draftRound2 % 2 === 0;
      const nextTeamIdx = isEvenRound2 ? pickInRound2 : (numTeams - 1 - pickInRound2);
      const nextTeam = teams[nextTeamIdx];
      if (nextTeam?.userId) {
        // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
        // telemetry consumed downstream, classifier intentionally not used.
        sendTransactionalPush(
          [nextTeam.userId],
          "Your Pick!",
          `It's your turn to draft in "${fl.name}". Pick #${totalPicks + 1}`,
          { type: "fantasy_draft_turn", fantasyLeagueId },
        ).catch(() => {});
      }
    }
  } else {
    // Draft complete — activate the league
    await db
      .update(fantasyLeaguesTable)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(fantasyLeaguesTable.id, fantasyLeagueId));

    const userIds = teams
      .map(t => t.userId)
      .filter((id): id is number => id != null);
    if (userIds.length) {
      // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
      // telemetry consumed downstream, classifier intentionally not used.
      sendTransactionalPush(
        userIds,
        "Draft Complete!",
        `The draft for "${fl.name}" is complete. The fantasy league is now live!`,
        { type: "fantasy_draft_complete", fantasyLeagueId },
      ).catch(() => {});
    }

    // Generate head-to-head matchups if needed
    if (fl.format === "head_to_head" && teams.length >= 2) {
      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          await db.insert(fantasyMatchupsTable).values({
            fantasyLeagueId,
            round: 1,
            homeTeamId: teams[i].id,
            awayTeamId: teams[j].id,
          }).onConflictDoNothing();
        }
      }
    }
  }

  res.status(201).json(pick);
});

// ─── GET /organizations/:orgId/fantasy/:fantasyLeagueId/available-players ────
router.get("/:fantasyLeagueId/available-players", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fantasyLeagueId = parseInt(String((req.params as Record<string, string>).fantasyLeagueId));

  const [fl] = await db
    .select({ tournamentId: fantasyLeaguesTable.tournamentId })
    .from(fantasyLeaguesTable)
    .where(and(
      eq(fantasyLeaguesTable.id, fantasyLeagueId),
      eq(fantasyLeaguesTable.organizationId, orgId),
    ));
  if (!fl) { { res.status(404).json({ error: "Fantasy league not found" }); return; } }

  if (!fl.tournamentId) {
    res.json([]); return;
  }

  // Get already-drafted player IDs
  const draftedPicks = await db
    .select({ playerId: fantasyDraftPicksTable.playerId })
    .from(fantasyDraftPicksTable)
    .where(eq(fantasyDraftPicksTable.fantasyLeagueId, fantasyLeagueId));
  const draftedIds = draftedPicks.map(p => p.playerId);

  const allPlayers = await db
    .select({
      id: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      handicapIndex: playersTable.handicapIndex,
      flight: playersTable.flight,
      checkedIn: playersTable.checkedIn,
    })
    .from(playersTable)
    .where(and(
      eq(playersTable.tournamentId, fl.tournamentId),
      eq(playersTable.dns, false),
    ))
    .orderBy(asc(playersTable.lastName));

  const available = draftedIds.length > 0
    ? allPlayers.filter(p => !draftedIds.includes(p.id))
    : allPlayers;

  res.json(available);
});

// ─── GET /organizations/:orgId/fantasy/:fantasyLeagueId/leaderboard ──────────
router.get("/:fantasyLeagueId/leaderboard", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fantasyLeagueId = parseInt(String((req.params as Record<string, string>).fantasyLeagueId));

  const [fl] = await db
    .select()
    .from(fantasyLeaguesTable)
    .where(and(
      eq(fantasyLeaguesTable.id, fantasyLeagueId),
      eq(fantasyLeaguesTable.organizationId, orgId),
    ));
  if (!fl) { { res.status(404).json({ error: "Fantasy league not found" }); return; } }

  const teams = await db
    .select({
      id: fantasyTeamsTable.id,
      name: fantasyTeamsTable.name,
      draftOrder: fantasyTeamsTable.draftOrder,
      totalFantasyPoints: fantasyTeamsTable.totalFantasyPoints,
      position: fantasyTeamsTable.position,
      userId: fantasyTeamsTable.userId,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      profileImage: appUsersTable.profileImage,
    })
    .from(fantasyTeamsTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, fantasyTeamsTable.userId))
    .where(eq(fantasyTeamsTable.fantasyLeagueId, fantasyLeagueId))
    .orderBy(asc(fantasyTeamsTable.position), desc(fantasyTeamsTable.totalFantasyPoints));

  // Enrich with per-player breakdown
  const teamsWithRoster = await Promise.all(teams.map(async (team) => {
    const roster = await db
      .select({
        playerId: fantasyStandingsTable.playerId,
        fantasyPoints: fantasyStandingsTable.fantasyPoints,
        pointsBreakdown: fantasyStandingsTable.pointsBreakdown,
        playerFirstName: playersTable.firstName,
        playerLastName: playersTable.lastName,
      })
      .from(fantasyStandingsTable)
      .innerJoin(playersTable, eq(playersTable.id, fantasyStandingsTable.playerId))
      .where(eq(fantasyStandingsTable.fantasyTeamId, team.id));
    return { ...team, roster };
  }));

  res.json({ fantasyLeague: fl, teams: teamsWithRoster });
});

// ─── POST /organizations/:orgId/fantasy/:fantasyLeagueId/recalc ──────────────
router.post("/:fantasyLeagueId/recalc", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const fantasyLeagueId = parseInt(String((req.params as Record<string, string>).fantasyLeagueId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Verify the fantasy league belongs to this org
  const [leagueCheck] = await db
    .select({ id: fantasyLeaguesTable.id })
    .from(fantasyLeaguesTable)
    .where(and(eq(fantasyLeaguesTable.id, fantasyLeagueId), eq(fantasyLeaguesTable.organizationId, orgId)));
  if (!leagueCheck) { { res.status(404).json({ error: "Fantasy league not found" }); return; } }

  await recalcFantasyPoints(fantasyLeagueId);
  res.json({ message: "Fantasy points recalculated" });
});

// ─── GET /organizations/:orgId/fantasy/join/:inviteCode ──────────────────────
router.get("/join/:inviteCode", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { inviteCode } = (req.params as Record<string, string>);

  const [fl] = await db
    .select({
      id: fantasyLeaguesTable.id,
      name: fantasyLeaguesTable.name,
      description: fantasyLeaguesTable.description,
      status: fantasyLeaguesTable.status,
      format: fantasyLeaguesTable.format,
      maxTeams: fantasyLeaguesTable.maxTeams,
      rosterSize: fantasyLeaguesTable.rosterSize,
      organizationId: fantasyLeaguesTable.organizationId,
    })
    .from(fantasyLeaguesTable)
    .where(and(
      eq(fantasyLeaguesTable.inviteCode, inviteCode),
      eq(fantasyLeaguesTable.organizationId, orgId),
    ));

  if (!fl) { { res.status(404).json({ error: "Invalid invite code" }); return; } }
  res.json(fl);
});

export default router;
