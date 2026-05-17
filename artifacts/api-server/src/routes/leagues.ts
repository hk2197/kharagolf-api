import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  leaguesTable, leagueRoundsTable, leagueMembersTable,
  leagueStandingsTable, coursesTable, leagueFixturesTable,
  leagueRoundResultsTable, holeDetailsTable, organizationsTable,
  leagueDivisionsTable, interclubFixturesTable,
  eventTeamsTable, eventTeamMembersTable,
  eventSurveyFormsTable,
} from "@workspace/db";
import { sendSurveyEmails } from "./event-forms";
import { eq, sql, count, and, inArray, asc, desc } from "drizzle-orm";
import { addAnnouncementClient, removeAnnouncementClient, broadcastAnnouncement, getAnnouncements } from "../lib/realtime";
import { aggregateAndRankTeams, type RoundTeamResult } from "../lib/leagueTeamStandings";
import { sendTransactionalPush } from "../lib/comms";
import { requireLeagueAccess, requireOrgAdmin, orgAdminMiddleware, leagueAccessMiddleware } from "../lib/permissions";
import { gateLeagueCreate } from "../lib/featureGate";
import { generatePocketScorecardPDF, type PocketScorecardData, type PocketPlayerCard } from "../lib/pdfPocketScorecard";
import { dispatchWebhookEvent } from "../lib/webhookDispatch";
import { evaluateLeagueAchievements } from "../lib/achievementEngine";
import { notifyLeagueStandingsUpdated } from "../lib/brandedNotifications";
import { logger } from "../lib/logger";

const router: IRouter = Router({ mergeParams: true });

// GET /organizations/:orgId/leagues
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const leagues = await db
    .select({
      id: leaguesTable.id,
      name: leaguesTable.name,
      description: leaguesTable.description,
      format: leaguesTable.format,
      type: leaguesTable.type,
      status: leaguesTable.status,
      seasonStart: leaguesTable.seasonStart,
      seasonEnd: leaguesTable.seasonEnd,
      maxMembers: leaguesTable.maxMembers,
      entryFee: leaguesTable.entryFee,
      currency: leaguesTable.currency,
      handicapAllowance: leaguesTable.handicapAllowance,
      roundsCount: leaguesTable.roundsCount,
      isPublic: leaguesTable.isPublic,
      createdAt: leaguesTable.createdAt,
      courseName: coursesTable.name,
    })
    .from(leaguesTable)
    .leftJoin(coursesTable, eq(coursesTable.id, leaguesTable.courseId))
    .where(eq(leaguesTable.organizationId, orgId))
    .orderBy(leaguesTable.createdAt);

  const results = await Promise.all(
    leagues.map(async (l) => {
      const [mc] = await db.select({ count: count() }).from(leagueMembersTable).where(eq(leagueMembersTable.leagueId, l.id));
      const [rc] = await db.select({ count: count() }).from(leagueRoundsTable).where(eq(leagueRoundsTable.leagueId, l.id));
      return { ...l, memberCount: Number(mc?.count ?? 0), roundsPlayed: Number(rc?.count ?? 0) };
    }),
  );

  res.json(results);
});

// POST /organizations/:orgId/leagues
router.post("/", gateLeagueCreate(), async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    name, description, format, type, courseId,
    seasonStart, seasonEnd, maxMembers, entryFee, currency,
    handicapAllowance, pointsPerWin, pointsPerDraw, pointsPerLoss,
    roundsCount, isPublic, tiebreakerMethod,
  } = req.body;

  if (!name || !format) {
    res.status(400).json({ error: "name and format are required" });
    return;
  }

  const [league] = await db
    .insert(leaguesTable)
    .values({
      organizationId: orgId,
      courseId: courseId ?? null,
      name,
      description,
      format,
      type: type ?? "individual",
      status: "draft",
      seasonStart: seasonStart ? new Date(seasonStart) : null,
      seasonEnd: seasonEnd ? new Date(seasonEnd) : null,
      maxMembers: maxMembers ?? null,
      entryFee: entryFee ? String(entryFee) : null,
      currency: currency ?? "INR",
      handicapAllowance: handicapAllowance ?? 100,
      pointsPerWin: pointsPerWin ?? 2,
      pointsPerDraw: pointsPerDraw ?? 1,
      pointsPerLoss: pointsPerLoss ?? 0,
      roundsCount: roundsCount ?? 1,
      isPublic: isPublic ?? false,
      tiebreakerMethod: tiebreakerMethod ?? "countback",
    })
    .returning();

  res.status(201).json({ ...league, memberCount: 0, roundsPlayed: 0, courseName: null });
});

// GET /organizations/:orgId/leagues/:leagueId
router.get("/:leagueId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));

  const [league] = await db
    .select({
      id: leaguesTable.id,
      organizationId: leaguesTable.organizationId,
      courseId: leaguesTable.courseId,
      name: leaguesTable.name,
      description: leaguesTable.description,
      format: leaguesTable.format,
      type: leaguesTable.type,
      status: leaguesTable.status,
      seasonStart: leaguesTable.seasonStart,
      seasonEnd: leaguesTable.seasonEnd,
      maxMembers: leaguesTable.maxMembers,
      entryFee: leaguesTable.entryFee,
      currency: leaguesTable.currency,
      handicapAllowance: leaguesTable.handicapAllowance,
      pointsPerWin: leaguesTable.pointsPerWin,
      pointsPerDraw: leaguesTable.pointsPerDraw,
      pointsPerLoss: leaguesTable.pointsPerLoss,
      roundsCount: leaguesTable.roundsCount,
      isPublic: leaguesTable.isPublic,
      tiebreakerMethod: leaguesTable.tiebreakerMethod,
      createdAt: leaguesTable.createdAt,
      courseName: coursesTable.name,
    })
    .from(leaguesTable)
    .leftJoin(coursesTable, eq(coursesTable.id, leaguesTable.courseId))
    .where(sql`${leaguesTable.id} = ${leagueId} AND ${leaguesTable.organizationId} = ${orgId}`);

  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }

  const members = await db
    .select()
    .from(leagueMembersTable)
    .where(eq(leagueMembersTable.leagueId, leagueId))
    .orderBy(leagueMembersTable.joinedAt);

  const rounds = await db
    .select()
    .from(leagueRoundsTable)
    .where(eq(leagueRoundsTable.leagueId, leagueId))
    .orderBy(leagueRoundsTable.roundNumber);

  const standings = await db
    .select({
      id: leagueStandingsTable.id,
      memberId: leagueStandingsTable.memberId,
      roundsPlayed: leagueStandingsTable.roundsPlayed,
      won: leagueStandingsTable.won,
      drawn: leagueStandingsTable.drawn,
      lost: leagueStandingsTable.lost,
      totalPoints: leagueStandingsTable.totalPoints,
      totalGross: leagueStandingsTable.totalGross,
      totalNet: leagueStandingsTable.totalNet,
      totalStableford: leagueStandingsTable.totalStableford,
      bestScore: leagueStandingsTable.bestScore,
      position: leagueStandingsTable.position,
      firstName: leagueMembersTable.firstName,
      lastName: leagueMembersTable.lastName,
      handicapIndex: leagueMembersTable.handicapIndex,
      teamName: leagueMembersTable.teamName,
    })
    .from(leagueStandingsTable)
    .innerJoin(leagueMembersTable, eq(leagueMembersTable.id, leagueStandingsTable.memberId))
    .where(eq(leagueStandingsTable.leagueId, leagueId))
    .orderBy(leagueStandingsTable.position);

  res.json({ ...league, members, rounds, standings });
});

// PUT /organizations/:orgId/leagues/:leagueId
router.put("/:leagueId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;
  const {
    name, description, format, type, status, courseId,
    seasonStart, seasonEnd, maxMembers, entryFee, currency,
    handicapAllowance, pointsPerWin, pointsPerDraw, pointsPerLoss,
    roundsCount, isPublic, oomPointsConfig, tiebreakerMethod,
  } = req.body;

  // Capture previous status for survey auto-send check
  const [prevLeague] = await db.select({ status: leaguesTable.status }).from(leaguesTable)
    .where(sql`${leaguesTable.id} = ${leagueId} AND ${leaguesTable.organizationId} = ${orgId}`);

  const [league] = await db
    .update(leaguesTable)
    .set({
      name, description, format, type, status,
      courseId: courseId ?? null,
      seasonStart: seasonStart ? new Date(seasonStart) : null,
      seasonEnd: seasonEnd ? new Date(seasonEnd) : null,
      maxMembers, entryFee: entryFee ? String(entryFee) : null,
      currency: currency ?? "INR",
      handicapAllowance, pointsPerWin, pointsPerDraw, pointsPerLoss,
      roundsCount, isPublic,
      oomPointsConfig: Array.isArray(oomPointsConfig) ? oomPointsConfig : null,
      ...(tiebreakerMethod ? { tiebreakerMethod } : {}),
      updatedAt: new Date(),
    })
    .where(sql`${leaguesTable.id} = ${leagueId} AND ${leaguesTable.organizationId} = ${orgId}`)
    .returning();

  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }

  // Auto-send survey when league is marked completed
  if (status === "completed" && prevLeague?.status !== "completed") {
    const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    const [survey] = await db.select().from(eventSurveyFormsTable)
      .where(and(eq(eventSurveyFormsTable.organizationId, orgId), eq(eventSurveyFormsTable.eventId, leagueId), eq(eventSurveyFormsTable.eventType, "league")));
    if (survey && survey.isActive && !survey.sentAt) {
      const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "https://kharagolf.com";
      const orgName = org?.name ?? "KHARAGOLF";
      if (survey.sendDelayHours > 0) {
        setTimeout(() => sendSurveyEmails(survey.id, leagueId, "league", orgName, publicBaseUrl).catch(() => undefined), survey.sendDelayHours * 3600 * 1000);
      } else {
        await sendSurveyEmails(survey.id, leagueId, "league", orgName, publicBaseUrl).catch(() => undefined);
      }
    }
  }

  res.json({ ...league, memberCount: 0, courseName: null });
});

// DELETE /organizations/:orgId/leagues/:leagueId
router.delete("/:leagueId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;
  await db.delete(leaguesTable).where(
    sql`${leaguesTable.id} = ${leagueId} AND ${leaguesTable.organizationId} = ${orgId}`
  );
  res.status(204).send();
});

// GET /organizations/:orgId/leagues/:leagueId/standings/teams
router.get("/:leagueId/standings/teams", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));

  // Access control: verify league belongs to org and user has league access
  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;

  // Fetch league format and match-play point config
  const [league] = await db
    .select({
      format: leaguesTable.format,
      pointsPerWin: leaguesTable.pointsPerWin,
      pointsPerDraw: leaguesTable.pointsPerDraw,
      pointsPerLoss: leaguesTable.pointsPerLoss,
    })
    .from(leaguesTable)
    .where(and(eq(leaguesTable.id, leagueId), eq(leaguesTable.organizationId, orgId)));

  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }

  // Fetch all league teams
  const teams = await db
    .select({ id: eventTeamsTable.id, name: eventTeamsTable.name, colour: eventTeamsTable.colour })
    .from(eventTeamsTable)
    .where(eq(eventTeamsTable.leagueId, leagueId))
    .orderBy(asc(eventTeamsTable.id));

  if (teams.length === 0) { { res.json([]); return; } }

  // Fetch team member → leagueMember mappings
  const teamMembers = await db
    .select({ teamId: eventTeamMembersTable.teamId, leagueMemberId: eventTeamMembersTable.leagueMemberId })
    .from(eventTeamMembersTable)
    .where(inArray(eventTeamMembersTable.teamId, teams.map(t => t.id)));

  // Build leagueMemberId → teamId map
  const memberToTeam = new Map<number, number>();
  for (const m of teamMembers) {
    if (m.leagueMemberId != null) memberToTeam.set(m.leagueMemberId, m.teamId);
  }

  // Fetch all round results for this league (from leagueRoundResultsTable, per round per member)
  const roundResults = await db
    .select({
      roundId: leagueRoundResultsTable.roundId,
      memberId: leagueRoundResultsTable.memberId,
      grossScore: leagueRoundResultsTable.grossScore,
      netScore: leagueRoundResultsTable.netScore,
      stablefordPoints: leagueRoundResultsTable.stablefordPoints,
      matchResult: leagueRoundResultsTable.matchResult,
    })
    .from(leagueRoundResultsTable)
    .where(eq(leagueRoundResultsTable.leagueId, leagueId));

  // Group round results by roundId, then by teamId
  const fmt = league.format ?? "stroke_play";
  const isStableford = ["stableford", "better_ball", "alliance", "waltz"].includes(fmt);
  const isMatchPlay = fmt === "match_play";
  const isNet = ["net_stroke", "scramble", "shamble"].includes(fmt);

  // Aggregate per-round team scores
  const teamRoundMap = new Map<number, Map<number, RoundTeamResult>>();

  for (const t of teams) {
    teamRoundMap.set(t.id, new Map());
  }

  // Collect all distinct roundIds
  const allRoundIds = [...new Set(roundResults.map(r => r.roundId))];

  for (const roundId of allRoundIds) {
    const roundData = roundResults.filter(r => r.roundId === roundId);

    // Group by team for this round
    const teamRoundData = new Map<number, typeof roundData>();
    for (const t of teams) teamRoundData.set(t.id, []);

    for (const row of roundData) {
      const tid = memberToTeam.get(row.memberId);
      if (tid == null) continue;
      teamRoundData.get(tid)!.push(row);
    }

    // Compute team round contribution
    for (const [tid, memberResults] of teamRoundData.entries()) {
      if (memberResults.length === 0) continue;
      const roundMap = teamRoundMap.get(tid)!;

      let won = 0, drawn = 0, lost = 0;
      let grossScore: number | null = null;
      let netScore: number | null = null;
      let stablefordPoints: number | null = null;

      if (isMatchPlay) {
        // Match play: sum W/D/L from all team members in this round
        for (const r of memberResults) {
          if (r.matchResult === "win") won++;
          else if (r.matchResult === "halve" || r.matchResult === "draw") drawn++;
          else if (r.matchResult === "loss") lost++;
        }
      } else if (isStableford) {
        // Format-specific stableford aggregation
        const valid = memberResults.filter(r => r.stablefordPoints != null);
        if (valid.length > 0) {
          const pts = valid.map(r => r.stablefordPoints!).sort((a, b) => b - a);
          if (fmt === 'better_ball') {
            // Only the best player's stableford counts per round (better ball rule)
            stablefordPoints = pts[0];
          } else if (fmt === 'alliance') {
            // Sum of best 2 stableford per round
            stablefordPoints = pts.slice(0, 2).reduce((s, v) => s + v, 0);
          } else {
            // Stableford / waltz: aggregate — sum all team members' stableford per round
            stablefordPoints = pts.reduce((s, v) => s + v, 0);
          }
          grossScore = valid.reduce((s, r) => s + (r.grossScore ?? 0), 0);
        }
      } else if (isNet) {
        // Net stroke: best net score among team members for this round
        const valid = memberResults.filter(r => r.netScore != null);
        if (valid.length > 0) {
          netScore = Math.min(...valid.map(r => r.netScore!));
          grossScore = valid.find(r => r.netScore === netScore)?.grossScore ?? null;
          stablefordPoints = valid.find(r => r.netScore === netScore)?.stablefordPoints ?? null;
        }
      } else {
        // Stroke play (gross): best gross score among team members for this round
        const valid = memberResults.filter(r => r.grossScore != null);
        if (valid.length > 0) {
          grossScore = Math.min(...valid.map(r => r.grossScore!));
          netScore = valid.find(r => r.grossScore === grossScore)?.netScore ?? null;
          stablefordPoints = valid.find(r => r.grossScore === grossScore)?.stablefordPoints ?? null;
        }
      }

      roundMap.set(roundId, { won, drawn, lost, grossScore, netScore, stablefordPoints });
    }
  }

  // Accumulate and rank using shared helper (same logic used by public endpoint)
  const ranked = aggregateAndRankTeams(teams, teamRoundMap, league);

  res.json(ranked);
});

// GET /organizations/:orgId/leagues/:leagueId/standings
router.get("/:leagueId/standings", async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));

  const standings = await db
    .select({
      id: leagueStandingsTable.id,
      memberId: leagueStandingsTable.memberId,
      roundsPlayed: leagueStandingsTable.roundsPlayed,
      won: leagueStandingsTable.won,
      drawn: leagueStandingsTable.drawn,
      lost: leagueStandingsTable.lost,
      totalPoints: leagueStandingsTable.totalPoints,
      totalGross: leagueStandingsTable.totalGross,
      totalNet: leagueStandingsTable.totalNet,
      totalStableford: leagueStandingsTable.totalStableford,
      bestScore: leagueStandingsTable.bestScore,
      position: leagueStandingsTable.position,
      firstName: leagueMembersTable.firstName,
      lastName: leagueMembersTable.lastName,
      handicapIndex: leagueMembersTable.handicapIndex,
      teamName: leagueMembersTable.teamName,
    })
    .from(leagueStandingsTable)
    .innerJoin(leagueMembersTable, eq(leagueMembersTable.id, leagueStandingsTable.memberId))
    .where(eq(leagueStandingsTable.leagueId, leagueId))
    .orderBy(leagueStandingsTable.position);

  res.json(standings);
});

// GET /organizations/:orgId/leagues/:leagueId/members
router.get("/:leagueId/members", async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const members = await db
    .select()
    .from(leagueMembersTable)
    .where(eq(leagueMembersTable.leagueId, leagueId))
    .orderBy(leagueMembersTable.joinedAt);
  res.json(members);
});

// POST /organizations/:orgId/leagues/:leagueId/members
router.post("/:leagueId/members", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;
  const { firstName, lastName, email, handicapIndex, teamName, userId } = req.body;

  if (!firstName || !lastName) {
    res.status(400).json({ error: "firstName and lastName are required" });
    return;
  }

  const [member] = await db
    .insert(leagueMembersTable)
    .values({ leagueId, userId: userId ?? null, firstName, lastName, email, handicapIndex, teamName })
    .returning();

  // Create standing row for this member
  await db.insert(leagueStandingsTable).values({ leagueId, memberId: member.id }).onConflictDoNothing();

  res.status(201).json(member);
});

// DELETE /organizations/:orgId/leagues/:leagueId/members/:memberId
router.delete("/:leagueId/members/:memberId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (isNaN(orgId) || isNaN(leagueId) || isNaN(memberId)) { { res.status(400).json({ error: "Invalid id" }); return; } }

  const [membership] = await db
    .select({ id: leagueMembersTable.id })
    .from(leagueMembersTable)
    .innerJoin(leaguesTable, and(eq(leaguesTable.id, leagueMembersTable.leagueId), eq(leaguesTable.organizationId, orgId)))
    .where(and(eq(leagueMembersTable.id, memberId), eq(leagueMembersTable.leagueId, leagueId)));
  if (!membership) { { res.status(404).json({ error: "Member not found in this league" }); return; } }

  await db.transaction(async (tx) => {
    await tx.delete(eventTeamMembersTable).where(eq(eventTeamMembersTable.leagueMemberId, membership.id));
    await tx.delete(leagueRoundResultsTable).where(eq(leagueRoundResultsTable.memberId, membership.id));
    await tx.delete(leagueStandingsTable).where(eq(leagueStandingsTable.memberId, membership.id));
    await tx.delete(leagueMembersTable).where(and(eq(leagueMembersTable.id, membership.id), eq(leagueMembersTable.leagueId, leagueId)));
  });
  res.json({ ok: true });
});

// GET /organizations/:orgId/leagues/:leagueId/rounds
router.get("/:leagueId/rounds", async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const rounds = await db
    .select()
    .from(leagueRoundsTable)
    .where(eq(leagueRoundsTable.leagueId, leagueId))
    .orderBy(leagueRoundsTable.roundNumber);
  res.json(rounds);
});

// POST /organizations/:orgId/leagues/:leagueId/rounds
router.post("/:leagueId/rounds", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;
  const { name, scheduledDate, tournamentId, pointsMultiplier } = req.body;

  const existing = await db
    .select({ roundNumber: leagueRoundsTable.roundNumber })
    .from(leagueRoundsTable)
    .where(eq(leagueRoundsTable.leagueId, leagueId))
    .orderBy(sql`${leagueRoundsTable.roundNumber} DESC`)
    .limit(1);

  const nextRound = (existing[0]?.roundNumber ?? 0) + 1;

  const [round] = await db
    .insert(leagueRoundsTable)
    .values({
      leagueId,
      roundNumber: nextRound,
      name: name ?? `Round ${nextRound}`,
      scheduledDate: scheduledDate ? new Date(scheduledDate) : null,
      tournamentId: tournamentId ?? null,
      pointsMultiplier: pointsMultiplier ? String(pointsMultiplier) : "1.0",
    })
    .returning();

  res.status(201).json(round);
});

// POST /organizations/:orgId/leagues/:leagueId/publish
router.post("/:leagueId/publish", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;

  const [league] = await db
    .update(leaguesTable)
    .set({ status: "upcoming", updatedAt: new Date() })
    .where(sql`${leaguesTable.id} = ${leagueId} AND ${leaguesTable.organizationId} = ${orgId}`)
    .returning();

  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }
  res.json({ ...league, memberCount: 0, courseName: null });
});

/* ─── LEAGUE FIXTURES ─────────────────────────────────────────────── */

// GET /organizations/:orgId/leagues/:leagueId/fixtures
router.get("/:leagueId/fixtures", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));

  const [league] = await db.select({ id: leaguesTable.id }).from(leaguesTable)
    .where(and(eq(leaguesTable.id, leagueId), eq(leaguesTable.organizationId, orgId)));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }

  const fixtures = await db
    .select()
    .from(leagueFixturesTable)
    .where(eq(leagueFixturesTable.leagueId, leagueId))
    .orderBy(leagueFixturesTable.roundNumber, leagueFixturesTable.id);

  const memberFields = { id: leagueMembersTable.id, firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName, handicapIndex: leagueMembersTable.handicapIndex };

  const results = await Promise.all(fixtures.map(async (f) => {
    const [home] = await db.select(memberFields).from(leagueMembersTable).where(eq(leagueMembersTable.id, f.homeId));
    const [away] = await db.select(memberFields).from(leagueMembersTable).where(eq(leagueMembersTable.id, f.awayId));
    return { ...f, home: home ?? null, away: away ?? null };
  }));

  res.json(results);
});

// POST /organizations/:orgId/leagues/:leagueId/fixtures/generate
// Generate round-robin fixtures for all members
router.post("/:leagueId/fixtures/generate", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;

  const [league] = await db.select({ id: leaguesTable.id }).from(leaguesTable)
    .where(and(eq(leaguesTable.id, leagueId), eq(leaguesTable.organizationId, orgId)));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }

  // Default clearExisting to true to prevent accidental duplicate schedules
  const { clearExisting = true } = req.body;

  const members = await db
    .select()
    .from(leagueMembersTable)
    .where(eq(leagueMembersTable.leagueId, leagueId))
    .orderBy(leagueMembersTable.joinedAt);

  if (members.length < 2) {
    res.status(400).json({ error: "Need at least 2 members to generate fixtures" });
    return;
  }

  if (clearExisting) {
    await db.delete(leagueFixturesTable).where(eq(leagueFixturesTable.leagueId, leagueId));
  } else {
    // Guard: if fixtures already exist, refuse to generate more to prevent duplicates
    const [existing] = await db.select({ id: leagueFixturesTable.id })
      .from(leagueFixturesTable)
      .where(eq(leagueFixturesTable.leagueId, leagueId));
    if (existing) {
      res.status(409).json({ error: "Fixtures already exist. Pass clearExisting: true to regenerate." });
      return;
    }
  }

  // Round-robin algorithm (Berger tables)
  // For n players, n-1 rounds if n is even, n rounds if n is odd
  const n = members.length;
  const rounds: Array<Array<[number, number]>> = [];
  const ids = members.map(m => m.id);

  // If odd number, add a "bye" player
  const hasBye = n % 2 !== 0;
  if (hasBye) ids.push(-1); // -1 = bye
  const N = ids.length;

  for (let r = 0; r < N - 1; r++) {
    const roundFixtures: Array<[number, number]> = [];
    for (let i = 0; i < N / 2; i++) {
      const home = ids[i];
      const away = ids[N - 1 - i];
      if (home !== -1 && away !== -1) {
        roundFixtures.push([home, away]);
      }
    }
    rounds.push(roundFixtures);
    // Rotate all except first element
    ids.splice(1, 0, ids.pop()!);
  }

  const created = [];
  for (let r = 0; r < rounds.length; r++) {
    for (const [homeId, awayId] of rounds[r]) {
      const [fixture] = await db.insert(leagueFixturesTable).values({
        leagueId,
        roundNumber: r + 1,
        homeId,
        awayId,
      }).returning();
      created.push(fixture);
    }
  }

  res.json({ generated: created.length, rounds: rounds.length, fixtures: created });
});

// PUT /organizations/:orgId/leagues/:leagueId/fixtures/:fixtureId
// Record a fixture result and recalculate standings
router.put("/:leagueId/fixtures/:fixtureId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const fixtureId = parseInt(String((req.params as Record<string, string>).fixtureId));
  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;

  const [league] = await db.select({ id: leaguesTable.id }).from(leaguesTable)
    .where(and(eq(leaguesTable.id, leagueId), eq(leaguesTable.organizationId, orgId)));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }

  const { homeScore, awayScore, result, notes, scheduledDate } = req.body;

  const [fixture] = await db
    .update(leagueFixturesTable)
    .set({
      homeScore: homeScore ?? null,
      awayScore: awayScore ?? null,
      result: result ?? null,
      notes: notes ?? null,
      scheduledDate: scheduledDate ? new Date(scheduledDate) : undefined,
      isPlayed: result != null,
    })
    .where(sql`${leagueFixturesTable.id} = ${fixtureId} AND ${leagueFixturesTable.leagueId} = ${leagueId}`)
    .returning();

  if (!fixture) { { res.status(404).json({ error: "Fixture not found" }); return; } }

  // Always fully recompute standings from all played fixtures to avoid double-counting on edits
  {
    const [lg] = await db.select().from(leaguesTable).where(eq(leaguesTable.id, leagueId));
    const ppw = lg?.pointsPerWin ?? 2;
    const ppd = lg?.pointsPerDraw ?? 1;
    const ppl = lg?.pointsPerLoss ?? 0;
    const tbMethod = lg?.tiebreakerMethod ?? "lower_handicap";

    // Fetch all league members with their handicap for tiebreaker
    const allMembers = await db.select({ id: leagueMembersTable.id, handicapIndex: leagueMembersTable.handicapIndex })
      .from(leagueMembersTable)
      .where(eq(leagueMembersTable.leagueId, leagueId));
    const handicapMap = new Map<number, number | null>(allMembers.map(m => [m.id, m.handicapIndex !== null ? Number(m.handicapIndex) : null]));

    // Gather all completed fixtures for this league
    const allFixtures = await db.select()
      .from(leagueFixturesTable)
      .where(sql`${leagueFixturesTable.leagueId} = ${leagueId} AND ${leagueFixturesTable.isPlayed} = true AND ${leagueFixturesTable.result} IS NOT NULL`);

    // Accumulate per-member totals deterministically
    const tally = new Map<number, { won: number; drawn: number; lost: number }>();
    const ensure = (id: number) => { if (!tally.has(id)) tally.set(id, { won: 0, drawn: 0, lost: 0 }); return tally.get(id)!; };

    for (const f of allFixtures) {
      const home = ensure(f.homeId);
      const away = ensure(f.awayId);
      if (f.result === 'home_win') { home.won++; away.lost++; }
      else if (f.result === 'away_win') { away.won++; home.lost++; }
      else if (f.result === 'draw') { home.drawn++; away.drawn++; }
    }

    // Capture pre-recompute positions so we can fire
    // `league.standings.updated` only for members whose position
    // actually changed in this recompute pass (Task #2008).
    const priorStandings = await db
      .select({ memberId: leagueStandingsTable.memberId, position: leagueStandingsTable.position })
      .from(leagueStandingsTable)
      .where(eq(leagueStandingsTable.leagueId, leagueId));
    const priorPositionByMember = new Map<number, number | null>(
      priorStandings.map((r) => [r.memberId, r.position]),
    );

    // Delete all existing standings for this league and reinsert
    await db.delete(leagueStandingsTable).where(eq(leagueStandingsTable.leagueId, leagueId));

    const entries = [...tally.entries()];
    // Sort by points DESC, apply configured tiebreakerMethod on tie
    entries.sort(([aId, a], [bId, b]) => {
      const pa = a.won * ppw + a.drawn * ppd + a.lost * ppl;
      const pb = b.won * ppw + b.drawn * ppd + b.lost * ppl;
      if (pb !== pa) return pb - pa;
      // Tiebreaker: for match-play the only applicable methods are no_tiebreaker and lower_handicap
      if (tbMethod === "no_tiebreaker") return 0;
      const aHcp = handicapMap.get(aId) ?? null;
      const bHcp = handicapMap.get(bId) ?? null;
      if (aHcp == null && bHcp == null) return 0;
      if (aHcp == null) return 1;
      if (bHcp == null) return -1;
      return aHcp - bHcp; // lower handicap wins
    });

    for (let i = 0; i < entries.length; i++) {
      const [memberId, { won, drawn, lost }] = entries[i];
      const totalPoints = won * ppw + drawn * ppd + lost * ppl;
      await db.insert(leagueStandingsTable).values({
        leagueId,
        memberId,
        won,
        drawn,
        lost,
        totalPoints,
        roundsPlayed: won + drawn + lost,
        position: i + 1,
      });
    }

    // Fire-and-forget achievement evaluation for league members based on the
    // freshly recomputed standings (e.g. league_winner for position 1).
    const memberRows = await db
      .select({ id: leagueMembersTable.id, userId: leagueMembersTable.userId })
      .from(leagueMembersTable)
      .where(and(
        eq(leagueMembersTable.leagueId, leagueId),
        inArray(leagueMembersTable.id, entries.map(([mid]) => mid)),
      ));
    for (const m of memberRows) {
      if (m.userId) {
        evaluateLeagueAchievements(m.userId, leagueId).catch((err) => {
          logger.warn(
            { err, leagueId, userId: m.userId },
            "evaluateLeagueAchievements failed",
          );
        });
      }
    }

    // Task #2008 — fire `league.standings.updated` for every member whose
    // position actually moved in this recompute pass. Position 1 (and any
    // other change) is interesting; an unchanged position is intentionally
    // silent so a no-op edit doesn't spam the roster. Branding falls back
    // to `lg.organizationId` so the email/push render with the league's
    // club colours.
    const userIdByMemberId = new Map<number, number>(
      memberRows.flatMap((m) => (m.userId != null ? [[m.id, m.userId] as [number, number]] : [])),
    );
    if (lg) {
      // Fan out one notification per moved user so the body copy reports
      // *that user's* new position rather than a shared "top moved"
      // figure that would be misleading for everyone else in the batch.
      for (let i = 0; i < entries.length; i++) {
        const [memberId] = entries[i];
        const newPos = i + 1;
        const oldPos = priorPositionByMember.get(memberId) ?? null;
        if (oldPos === newPos) continue;
        const uid = userIdByMemberId.get(memberId);
        if (uid == null) continue;
        notifyLeagueStandingsUpdated({
          userIds: [uid],
          leagueId,
          leagueName: lg.name ?? undefined,
          newPosition: newPos,
          branding: { orgId: lg.organizationId },
        }).catch((err) => {
          logger.warn(
            { err, leagueId, userId: uid },
            "[leagues] notifyLeagueStandingsUpdated failed",
          );
        });
      }
    }
  }

  res.json(fixture);
});

/* ─── LEAGUE ROUND SCORES ───────────────────────────────────────── */

// GET /organizations/:orgId/leagues/:leagueId/scores — all results for this league (used for eclectic prefill & prev-round totals)
router.get("/:leagueId/scores", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));

  const [league] = await db.select({ id: leaguesTable.id }).from(leaguesTable)
    .where(and(eq(leaguesTable.id, leagueId), eq(leaguesTable.organizationId, orgId)));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }

  const results = await db
    .select()
    .from(leagueRoundResultsTable)
    .where(eq(leagueRoundResultsTable.leagueId, leagueId));

  res.json(results);
});

// GET /organizations/:orgId/leagues/:leagueId/rounds/:roundId/scores
router.get("/:leagueId/rounds/:roundId/scores", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const roundId = parseInt(String((req.params as Record<string, string>).roundId));

  const [league] = await db.select({ id: leaguesTable.id }).from(leaguesTable)
    .where(and(eq(leaguesTable.id, leagueId), eq(leaguesTable.organizationId, orgId)));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }

  const results = await db
    .select()
    .from(leagueRoundResultsTable)
    .where(and(eq(leagueRoundResultsTable.leagueId, leagueId), eq(leagueRoundResultsTable.roundId, roundId)));

  res.json(results);
});

// POST /organizations/:orgId/leagues/:leagueId/rounds/:roundId/scores
// Bulk upsert scores for all members in a round; then recalculate standings.
router.post("/:leagueId/rounds/:roundId/scores", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const roundId = parseInt(String((req.params as Record<string, string>).roundId));
  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;
  const { scores } = req.body;

  if (!Array.isArray(scores) || scores.length === 0) {
    res.status(400).json({ error: "scores array is required" });
    return;
  }

  // Validate league belongs to org
  const [league] = await db.select().from(leaguesTable)
    .where(and(eq(leaguesTable.id, leagueId), eq(leaguesTable.organizationId, orgId)));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }

  // Validate round belongs to this league
  const [round] = await db.select({ id: leagueRoundsTable.id, roundNumber: leagueRoundsTable.roundNumber, name: leagueRoundsTable.name })
    .from(leagueRoundsTable)
    .where(and(eq(leagueRoundsTable.id, roundId), eq(leagueRoundsTable.leagueId, leagueId)));
  if (!round) { { res.status(404).json({ error: "Round not found in this league" }); return; } }

  // Load valid member IDs for this league (to reject cross-league injections)
  const leagueMembers = await db.select({ id: leagueMembersTable.id })
    .from(leagueMembersTable)
    .where(eq(leagueMembersTable.leagueId, leagueId));
  const validMemberIds = new Set(leagueMembers.map(m => m.id));

  // Upsert each member's round result (only for members in this league)
  const saved = [];
  for (const s of scores) {
    if (!s.memberId || !validMemberIds.has(s.memberId)) continue;
    const [row] = await db
      .insert(leagueRoundResultsTable)
      .values({
        leagueId,
        roundId,
        memberId: s.memberId,
        grossScore: s.grossScore ?? null,
        netScore: s.netScore ?? null,
        stablefordPoints: s.stablefordPoints ?? null,
        matchResult: s.matchResult ?? null,
        holeScores: s.holeScores ?? null,
        notes: s.notes ?? null,
      })
      .onConflictDoUpdate({
        target: [leagueRoundResultsTable.roundId, leagueRoundResultsTable.memberId],
        set: {
          grossScore: s.grossScore ?? null,
          netScore: s.netScore ?? null,
          stablefordPoints: s.stablefordPoints ?? null,
          matchResult: s.matchResult ?? null,
          holeScores: s.holeScores ?? null,
          notes: s.notes ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    saved.push(row);
  }

  // Mark round as completed
  await db.update(leagueRoundsTable)
    .set({ status: "completed" })
    .where(and(eq(leagueRoundsTable.id, roundId), eq(leagueRoundsTable.leagueId, leagueId)));

  // Recalculate standings from all round results for this league
  await recalculateLeagueStandings(leagueId, league.format, {
    pointsPerWin:  league.pointsPerWin  ?? 2,
    pointsPerDraw: league.pointsPerDraw ?? 1,
    pointsPerLoss: league.pointsPerLoss ?? 0,
  }, league.oomPointsConfig ?? null, league.tiebreakerMethod ?? "countback");

  // Push: notify league members that standings have been updated
  const members = await db
    .select({ userId: leagueMembersTable.userId })
    .from(leagueMembersTable)
    .where(eq(leagueMembersTable.leagueId, leagueId));
  const memberUserIds = members.map(m => m.userId).filter((id): id is number => typeof id === "number" && id > 0);
  // Task #1240 — fire-and-forget (`.catch(() => undefined)`); no delivery
  // telemetry consumed downstream, classifier intentionally not used.
  sendTransactionalPush(
    memberUserIds,
    "Standings Updated",
    `${league.name} standings have been updated. Check your position!`,
    { type: "standings_updated", leagueId },
  ).catch(() => undefined);

  dispatchWebhookEvent(orgId, "league.round_completed", {
    leagueId,
    roundId,
    leagueName: league.name,
    roundNumber: round.roundNumber,
    completedAt: new Date().toISOString(),
    resultsCount: saved.length,
  });

  res.json({ saved: saved.length });
});

async function recalculateLeagueStandings(leagueId: number, format: string, matchPts = { pointsPerWin: 2, pointsPerDraw: 1, pointsPerLoss: 0 }, customOomPoints: number[] | null = null, tiebreakerMethod = "countback") {
  const members = await db.select().from(leagueMembersTable)
    .where(eq(leagueMembersTable.leagueId, leagueId));
  const allResults = await db.select().from(leagueRoundResultsTable)
    .where(eq(leagueRoundResultsTable.leagueId, leagueId));

  const isMatchPlay   = format === 'match_play';
  const isOOM        = format === 'order_of_merit';
  const isStableford  = ['stableford', 'alliance', 'better_ball', 'waltz'].includes(format);
  const isEclectic    = format === 'eclectic';
  const isBogey       = format === 'bogey';

  // Standard OOM finish-position points table (1st → Nth); overrideable per league
  const DEFAULT_OOM_POINTS = [100, 75, 60, 50, 45, 40, 36, 32, 29, 26, 24, 22, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8];
  const OOM_POINTS = (customOomPoints && customOomPoints.length > 0) ? customOomPoints : DEFAULT_OOM_POINTS;

  type Totals = {
    roundsPlayed: number;
    won: number;
    drawn: number;
    lost: number;
    totalGross: number;
    totalNet: number;
    totalStableford: number;
    totalOOM: number;
    bestScore: number | null;
    handicapIndex: number | null;
    // For eclectic: best score on each hole across all rounds
    bestPerHole: Record<string, number>;
    // Per-round data for recency-based countback
    roundScores: { roundId: number; grossScore: number | null; netScore: number | null; holes: { hole: number; strokes: number }[] }[];
  };

  const totals = new Map<number, Totals>();
  for (const m of members) {
    totals.set(m.id, {
      roundsPlayed: 0, won: 0, drawn: 0, lost: 0,
      totalGross: 0, totalNet: 0, totalStableford: 0, totalOOM: 0,
      bestScore: null,
      handicapIndex: m.handicapIndex != null ? parseFloat(m.handicapIndex) : null,
      bestPerHole: {},
      roundScores: [],
    });
  }

  for (const r of allResults) {
    const t = totals.get(r.memberId);
    if (!t) continue;

    // Only count round as played if a meaningful result exists for this format
    const hasMeaningfulResult =
      (isMatchPlay && r.matchResult != null) ||
      (isStableford && r.stablefordPoints != null) ||
      (isEclectic && r.holeScores != null && Object.keys(r.holeScores as object).length > 0) ||
      (isOOM && r.grossScore != null) ||
      (!isMatchPlay && !isStableford && !isEclectic && !isOOM && r.grossScore != null);
    if (hasMeaningfulResult) t.roundsPlayed++;

    if (isMatchPlay) {
      // Count wins/halves/losses from matchResult field
      if (r.matchResult === 'win')   t.won++;
      else if (r.matchResult === 'halve') t.drawn++;
      else if (r.matchResult === 'loss')  t.lost++;
    }

    if (isEclectic && r.holeScores) {
      // Track best (lowest) score per hole across all rounds
      const holeData = r.holeScores as Record<string, { strokes?: number }>;
      for (const [hole, hs] of Object.entries(holeData)) {
        const strokes = hs.strokes;
        if (strokes == null) continue;
        if (t.bestPerHole[hole] == null || strokes < t.bestPerHole[hole]) {
          t.bestPerHole[hole] = strokes;
        }
      }
    } else {
      if (r.grossScore != null) {
        t.totalGross += r.grossScore;
        if (t.bestScore === null || r.grossScore < t.bestScore) t.bestScore = r.grossScore;
      }
      if (r.netScore != null) t.totalNet += r.netScore;
      if (r.stablefordPoints != null) t.totalStableford += r.stablefordPoints;
    }
    // Track per-round scores and hole data for recency-based countback
    const holeData = r.holeScores as Record<string, { strokes?: number }> | null;
    const holes: { hole: number; strokes: number }[] = holeData
      ? Object.entries(holeData)
          .map(([k, v]) => ({ hole: parseInt(k), strokes: v.strokes ?? 0 }))
          .filter(h => !isNaN(h.hole))
          .sort((a, b) => a.hole - b.hole)
      : [];
    t.roundScores.push({ roundId: r.roundId, grossScore: r.grossScore, netScore: r.netScore, holes });
  }

  // Sort each member's roundScores by roundId descending (most recent first)
  for (const [, t] of totals) {
    t.roundScores.sort((a, b) => b.roundId - a.roundId);
  }

  // For eclectic: sum best-per-hole scores as the total
  if (isEclectic) {
    for (const [, t] of totals) {
      const eclecticTotal = Object.values(t.bestPerHole).reduce((a, b) => a + b, 0);
      if (eclecticTotal > 0) {
        t.totalGross = eclecticTotal;
        t.bestScore = eclecticTotal;
      }
    }
  }

  // For Order of Merit: compute per-round finish-position points then accumulate season total
  if (isOOM) {
    // Group results by roundId
    const byRound = new Map<number, typeof allResults>();
    for (const r of allResults) {
      if (!byRound.has(r.roundId)) byRound.set(r.roundId, []);
      byRound.get(r.roundId)!.push(r);
    }

    for (const [, roundResults] of byRound) {
      // Only rank members who have a gross score for this round; prefer netScore if available
      const withScore = roundResults
        .filter(r => r.grossScore != null)
        .sort((a, b) => {
          // Lower net score is better; fall back to gross
          const aScore = a.netScore ?? a.grossScore!;
          const bScore = b.netScore ?? b.grossScore!;
          return aScore - bScore;
        });

      // Award points by finish position (tied scores share the same slot)
      let pos = 0;
      let prevScore: number | null = null;
      for (let i = 0; i < withScore.length; i++) {
        const r = withScore[i];
        const score = r.netScore ?? r.grossScore!;
        if (score !== prevScore) pos = i; // advance only on different score
        prevScore = score;

        const pts = pos < OOM_POINTS.length ? OOM_POINTS[pos] : 1;
        const t = totals.get(r.memberId);
        if (t) t.totalOOM += pts;
      }
    }
  }

  // Lower-handicap comparison helper (lower = better)
  const lowerHandicap = (a: Totals, b: Totals): number => {
    if (a.handicapIndex == null && b.handicapIndex == null) return 0;
    if (a.handicapIndex == null) return 1;
    if (b.handicapIndex == null) return -1;
    return a.handicapIndex - b.handicapIndex;
  };

  // Hole-score countback on a single round: last-9/6/3/1 holes (lower strokes = better)
  const holeCountback = (aHoles: { hole: number; strokes: number }[], bHoles: { hole: number; strokes: number }[]): number => {
    if (aHoles.length < 18 || bHoles.length < 18) return 0; // incomplete round — no countback
    const sum = (holes: { hole: number; strokes: number }[], from: number) =>
      holes.filter(h => h.hole >= from).reduce((s, h) => s + h.strokes, 0);
    const a9 = sum(aHoles, 10), b9 = sum(bHoles, 10);
    if (a9 !== b9) return a9 - b9;
    const a6 = sum(aHoles, 13), b6 = sum(bHoles, 13);
    if (a6 !== b6) return a6 - b6;
    const a3 = sum(aHoles, 16), b3 = sum(bHoles, 16);
    if (a3 !== b3) return a3 - b3;
    const a1 = aHoles.find(h => h.hole === 18)?.strokes ?? 0;
    const b1 = bHoles.find(h => h.hole === 18)?.strokes ?? 0;
    return a1 - b1;
  };

  // Shared tiebreaker: applied when primary score/points are equal.
  // Stroke formats: hole-score countback (last-9/6/3/1) on most recent round.
  // multi_round_countback: extends to prior rounds if current round is still tied.
  // Points formats (stableford/OOM/match_play): lower handicap is the correct tiebreaker.
  const applyTiebreaker = (a: Totals, b: Totals): number => {
    if (tiebreakerMethod === "no_tiebreaker") return 0;
    if (tiebreakerMethod === "lower_handicap") return lowerHandicap(a, b);

    // Points formats — countback on hole scores is not meaningful; use lower handicap
    if (isStableford || isOOM || isMatchPlay) return lowerHandicap(a, b);

    if (tiebreakerMethod === "net_countback") {
      // League results don't have per-hole net data; compare most recent round net scores
      for (let i = 0; i < Math.max(a.roundScores.length, b.roundScores.length); i++) {
        const aScore = a.roundScores[i]?.netScore ?? a.roundScores[i]?.grossScore ?? null;
        const bScore = b.roundScores[i]?.netScore ?? b.roundScores[i]?.grossScore ?? null;
        if (aScore === null && bScore === null) continue;
        if (aScore === null) return 1;
        if (bScore === null) return -1;
        if (aScore !== bScore) return aScore - bScore;
      }
      return lowerHandicap(a, b);
    }

    // countback: hole-score countback on the most recent round only
    if (tiebreakerMethod === "countback") {
      const aR = a.roundScores[0];
      const bR = b.roundScores[0];
      if (aR && bR) {
        const cb = holeCountback(aR.holes, bR.holes);
        if (cb !== 0) return cb;
      }
      return lowerHandicap(a, b);
    }

    // multi_round_countback: hole-score countback on current round; if still tied, prior rounds
    if (tiebreakerMethod === "multi_round_countback") {
      const maxR = Math.max(a.roundScores.length, b.roundScores.length);
      for (let i = 0; i < maxR; i++) {
        const aR = a.roundScores[i];
        const bR = b.roundScores[i];
        if (!aR || !bR) continue;
        const cb = holeCountback(aR.holes, bR.holes);
        if (cb !== 0) return cb;
      }
      return lowerHandicap(a, b);
    }

    // Fallback
    return lowerHandicap(a, b);
  };

  // Sort for position assignment
  const sorted = [...totals.entries()].sort(([, a], [, b]) => {
    if (isMatchPlay) {
      const aMatchPts = a.won * matchPts.pointsPerWin + a.drawn * matchPts.pointsPerDraw + a.lost * matchPts.pointsPerLoss;
      const bMatchPts = b.won * matchPts.pointsPerWin + b.drawn * matchPts.pointsPerDraw + b.lost * matchPts.pointsPerLoss;
      if (bMatchPts !== aMatchPts) return bMatchPts - aMatchPts;
      // Match-play: always use applyTiebreaker; it correctly falls back to lower_handicap for points formats
      return applyTiebreaker(a, b);
    }
    if (isOOM) {
      if (a.roundsPlayed === 0 && b.roundsPlayed === 0) return 0;
      if (a.roundsPlayed === 0) return 1;
      if (b.roundsPlayed === 0) return -1;
      if (b.totalOOM !== a.totalOOM) return b.totalOOM - a.totalOOM;
      return applyTiebreaker(a, b);
    }
    if (isStableford) {
      if (b.totalStableford !== a.totalStableford) return b.totalStableford - a.totalStableford;
      return applyTiebreaker(a, b);
    }
    if (isBogey) {
      if (a.roundsPlayed === 0 && b.roundsPlayed === 0) return 0;
      if (a.roundsPlayed === 0) return 1;
      if (b.roundsPlayed === 0) return -1;
      if (b.totalGross !== a.totalGross) return b.totalGross - a.totalGross;
      return applyTiebreaker(a, b);
    }
    // Stroke/eclectic: lowest gross wins; members with no scores go last
    if (a.totalGross === 0 && b.totalGross === 0) return 0;
    if (a.totalGross === 0) return 1;
    if (b.totalGross === 0) return -1;
    if (a.totalGross !== b.totalGross) return a.totalGross - b.totalGross;
    return applyTiebreaker(a, b);
  });

  for (let i = 0; i < sorted.length; i++) {
    const [memberId, t] = sorted[i];
    const matchPoints = t.won * matchPts.pointsPerWin + t.drawn * matchPts.pointsPerDraw + t.lost * matchPts.pointsPerLoss;
    const computedTotalPoints = isMatchPlay ? matchPoints : isOOM ? t.totalOOM : t.totalStableford;

    await db.insert(leagueStandingsTable)
      .values({
        leagueId,
        memberId,
        roundsPlayed: t.roundsPlayed,
        won: t.won,
        drawn: t.drawn,
        lost: t.lost,
        totalPoints: computedTotalPoints,
        totalGross: t.totalGross,
        totalNet: t.totalNet,
        totalStableford: t.totalStableford,
        bestScore: t.bestScore,
        position: i + 1,
      })
      .onConflictDoUpdate({
        target: [leagueStandingsTable.leagueId, leagueStandingsTable.memberId],
        set: {
          roundsPlayed: t.roundsPlayed,
          won: t.won,
          drawn: t.drawn,
          lost: t.lost,
          totalPoints: computedTotalPoints,
          totalGross: t.totalGross,
          totalNet: t.totalNet,
          totalStableford: t.totalStableford,
          bestScore: t.bestScore,
          position: i + 1,
          updatedAt: new Date(),
        },
      });
  }
}

/* ─── LEAGUE ANNOUNCEMENTS ──────────────────────────────────────── */

// Helper: verify league belongs to org
async function verifyLeagueOrg(orgId: number, leagueId: number): Promise<boolean> {
  const [l] = await db.select({ organizationId: leaguesTable.organizationId })
    .from(leaguesTable).where(and(eq(leaguesTable.id, leagueId), eq(leaguesTable.organizationId, orgId)));
  return !!l;
}

// GET /organizations/:orgId/leagues/:leagueId/announcements/stream — SSE
router.get("/:leagueId/announcements/stream", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  const leagueId = parseInt((req.params as Record<string, string>).leagueId as string);
  if (!(await verifyLeagueOrg(orgId, leagueId))) {
    res.status(404).json({ error: "League not found" }); return;
  }
  const scope = `league_${leagueId}`;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const existing = getAnnouncements(scope);
  for (const a of existing) {
    res.write(`data: ${JSON.stringify({ type: "announcement", data: a })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  addAnnouncementClient(scope, res);
  req.on("close", () => removeAnnouncementClient(scope, res));
});

// GET /organizations/:orgId/leagues/:leagueId/announcements
router.get("/:leagueId/announcements", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  const leagueId = parseInt((req.params as Record<string, string>).leagueId as string);
  if (!(await verifyLeagueOrg(orgId, leagueId))) {
    res.status(404).json({ error: "League not found" }); return;
  }
  res.json(getAnnouncements(`league_${leagueId}`));
});

// POST /organizations/:orgId/leagues/:leagueId/announcements
router.post("/:leagueId/announcements", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  const leagueId = parseInt((req.params as Record<string, string>).leagueId as string);
  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;
  const { text } = req.body as { text?: string };
  if (!text?.trim()) { { res.status(400).json({ error: "text required" }); return; } }
  const author = req.user ? (req.user.displayName || req.user.username) : "Admin";
  const entry = broadcastAnnouncement(`league_${leagueId}`, text, author ?? "Admin");
  res.json(entry);
});

// GET /organizations/:orgId/leagues/:leagueId/rounds/:roundId/pocket-scorecards/pdf
router.get("/:leagueId/rounds/:roundId/pocket-scorecards/pdf", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  const leagueId = parseInt((req.params as Record<string, string>).leagueId as string);
  const roundId = parseInt((req.params as Record<string, string>).roundId as string);
  if (!await requireLeagueAccess(req, res, orgId, leagueId)) return;

  const [league] = await db
    .select({ id: leaguesTable.id, name: leaguesTable.name, format: leaguesTable.format, courseId: leaguesTable.courseId, organizationId: leaguesTable.organizationId, handicapAllowance: leaguesTable.handicapAllowance })
    .from(leaguesTable)
    .where(and(eq(leaguesTable.id, leagueId), eq(leaguesTable.organizationId, orgId)));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }

  const [round] = await db
    .select({ id: leagueRoundsTable.id, roundNumber: leagueRoundsTable.roundNumber, name: leagueRoundsTable.name, scheduledDate: leagueRoundsTable.scheduledDate })
    .from(leagueRoundsTable)
    .where(and(eq(leagueRoundsTable.id, roundId), eq(leagueRoundsTable.leagueId, leagueId)));
  if (!round) { { res.status(404).json({ error: "Round not found" }); return; } }

  const [org] = await db
    .select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor, website: organizationsTable.website })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));

  const [members, roundFixtures] = await Promise.all([
    db
      .select({ id: leagueMembersTable.id, firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName, handicapIndex: leagueMembersTable.handicapIndex })
      .from(leagueMembersTable)
      .where(eq(leagueMembersTable.leagueId, leagueId))
      .orderBy(leagueMembersTable.firstName),
    db
      .select({ homeId: leagueFixturesTable.homeId, awayId: leagueFixturesTable.awayId })
      .from(leagueFixturesTable)
      .where(eq(leagueFixturesTable.leagueRoundId, roundId)),
  ]);

  if (members.length === 0) { { res.status(400).json({ error: "No members in this league" }); return; } }

  let holeDetails: { holeNumber: number; par: number; handicap?: number | null; yardageWhite?: number | null }[] = [];
  let courseName: string | null = null;
  if (league.courseId) {
    const [c] = await db.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, league.courseId));
    if (c) courseName = c.name;
    holeDetails = await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, league.courseId)).orderBy(holeDetailsTable.holeNumber);
  }

  const dateStr = round.scheduledDate
    ? new Date(round.scheduledDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : "";

  const memberMap = new Map(members.map(m => [m.id, m]));
  const allowance = (league.handicapAllowance ?? 100) / 100;
  const holesArr = holeDetails.map(h => ({ hole: h.holeNumber, yards: h.yardageWhite ?? null, par: h.par, strokeIndex: h.handicap ?? null }));

  type PartnerRef = { name: string; handicapIndex: number };

  const makeCard = (m: typeof members[0], partners: PartnerRef[]): PocketPlayerCard => ({
    playerName: `${m.firstName} ${m.lastName}`,
    handicapIndex: Number(m.handicapIndex ?? 0),
    playingHandicap: Math.round(Number(m.handicapIndex ?? 0) * allowance),
    teeBox: "white",
    teeTime: "",
    startingHole: 1,
    partners,
    holes: holesArr,
  });

  const toPartner = (m: typeof members[0]): PartnerRef => ({
    name: `${m.firstName} ${m.lastName}`,
    handicapIndex: Number(m.handicapIndex ?? 0),
  });

  const playerCards: PocketPlayerCard[] = [];
  const pairedMemberIds = new Set<number>();

  for (const fix of roundFixtures) {
    const home = memberMap.get(fix.homeId);
    const away = memberMap.get(fix.awayId);
    if (home && away) {
      playerCards.push(makeCard(home, [toPartner(away)]));
      playerCards.push(makeCard(away, [toPartner(home)]));
      pairedMemberIds.add(home.id);
      pairedMemberIds.add(away.id);
    } else if (home) {
      playerCards.push(makeCard(home, []));
      pairedMemberIds.add(home.id);
    } else if (away) {
      playerCards.push(makeCard(away, []));
      pairedMemberIds.add(away.id);
    }
  }

  for (const m of members) {
    if (!pairedMemberIds.has(m.id)) {
      playerCards.push(makeCard(m, []));
    }
  }

  const pdfData: PocketScorecardData = {
    organization: { name: org?.name ?? "KHARAGOLF", logoUrl: org?.logoUrl ?? null, primaryColor: org?.primaryColor ?? "#22c55e", website: org?.website ?? undefined },
    tournament: { name: league.name, courseName, date: dateStr, round: round.roundNumber, format: league.format, localRules: null },
    sponsors: [],
    holeSponsors: [],
    sideGames: { ctpHoles: [], ldHoles: [] },
    players: playerCards,
  };

  try {
    const pdfBuffer = await generatePocketScorecardPDF(pdfData);
    const safeName = league.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="PocketScorecards_${safeName}_R${round.roundNumber}.pdf"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

/* ══════════════════════════════════════════════════════════════════════
   LEAGUE DIVISIONS (T72)
   ══════════════════════════════════════════════════════════════════════ */

// GET /organizations/:orgId/leagues/:leagueId/divisions
router.get("/:leagueId/divisions", leagueAccessMiddleware, async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const divisions = await db
    .select({
      id: leagueDivisionsTable.id,
      name: leagueDivisionsTable.name,
      level: leagueDivisionsTable.level,
      promoteCount: leagueDivisionsTable.promoteCount,
      relegateCount: leagueDivisionsTable.relegateCount,
      memberCount: count(leagueMembersTable.id),
    })
    .from(leagueDivisionsTable)
    .leftJoin(leagueMembersTable, eq(leagueMembersTable.divisionId, leagueDivisionsTable.id))
    .where(eq(leagueDivisionsTable.leagueId, leagueId))
    .groupBy(leagueDivisionsTable.id)
    .orderBy(asc(leagueDivisionsTable.level));
  res.json(divisions);
});

// POST /organizations/:orgId/leagues/:leagueId/divisions
router.post("/:leagueId/divisions", orgAdminMiddleware, async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const { name, level, promoteCount, relegateCount } = req.body;
  if (!name) { { res.status(400).json({ error: "name required" }); return; } }
  const [div] = await db.insert(leagueDivisionsTable).values({
    leagueId, name,
    level: level ? parseInt(level) : 1,
    promoteCount: promoteCount ? parseInt(promoteCount) : 0,
    relegateCount: relegateCount ? parseInt(relegateCount) : 0,
  }).returning();
  res.status(201).json(div);
});

// PATCH /organizations/:orgId/leagues/:leagueId/divisions/:divisionId
router.patch("/:leagueId/divisions/:divisionId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const divisionId = parseInt(String((req.params as Record<string, string>).divisionId));
  const { name, level, promoteCount, relegateCount } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (level !== undefined) updates.level = parseInt(level);
  if (promoteCount !== undefined) updates.promoteCount = parseInt(promoteCount);
  if (relegateCount !== undefined) updates.relegateCount = parseInt(relegateCount);
  const [div] = await db.update(leagueDivisionsTable).set(updates).where(eq(leagueDivisionsTable.id, divisionId)).returning();
  res.json(div);
});

// DELETE /organizations/:orgId/leagues/:leagueId/divisions/:divisionId
router.delete("/:leagueId/divisions/:divisionId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const divisionId = parseInt(String((req.params as Record<string, string>).divisionId));
  // Unassign members from this division before deleting
  await db.update(leagueMembersTable).set({ divisionId: null }).where(eq(leagueMembersTable.divisionId, divisionId));
  await db.delete(leagueDivisionsTable).where(eq(leagueDivisionsTable.id, divisionId));
  res.json({ ok: true });
});

// PATCH /organizations/:orgId/leagues/:leagueId/members/:memberId/division
router.patch("/:leagueId/members/:memberId/division", orgAdminMiddleware, async (req: Request, res: Response) => {
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  const divisionId = req.body.divisionId ? parseInt(req.body.divisionId) : null;
  const [m] = await db.update(leagueMembersTable).set({ divisionId }).where(eq(leagueMembersTable.id, memberId)).returning({ id: leagueMembersTable.id, divisionId: leagueMembersTable.divisionId });
  res.json(m);
});

/* ══════════════════════════════════════════════════════════════════════
   INTERCLUB FIXTURES (T72)
   ══════════════════════════════════════════════════════════════════════ */

// GET /organizations/:orgId/leagues/:leagueId/interclub-fixtures
router.get("/:leagueId/interclub-fixtures", leagueAccessMiddleware, async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const fixtures = await db
    .select()
    .from(interclubFixturesTable)
    .where(eq(interclubFixturesTable.leagueId, leagueId))
    .orderBy(desc(interclubFixturesTable.fixtureDate));
  res.json(fixtures);
});

// POST /organizations/:orgId/leagues/:leagueId/interclub-fixtures
router.post("/:leagueId/interclub-fixtures", orgAdminMiddleware, async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const { opponentName, fixtureDate, venue, format, notes } = req.body;
  if (!opponentName) { { res.status(400).json({ error: "opponentName required" }); return; } }
  const [fixture] = await db.insert(interclubFixturesTable).values({
    leagueId, opponentName,
    fixtureDate: fixtureDate ? new Date(fixtureDate) : undefined,
    venue: venue ?? null, format: format ?? null, notes: notes ?? null,
  }).returning();
  res.status(201).json(fixture);
});

// PATCH /organizations/:orgId/leagues/:leagueId/interclub-fixtures/:fixtureId
router.patch("/:leagueId/interclub-fixtures/:fixtureId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const fixtureId = parseInt(String((req.params as Record<string, string>).fixtureId));
  const { opponentName, fixtureDate, venue, format, homeScore, awayScore, status, notes } = req.body;
  const updates: Record<string, unknown> = {};
  if (opponentName !== undefined) updates.opponentName = opponentName;
  if (fixtureDate !== undefined) updates.fixtureDate = fixtureDate ? new Date(fixtureDate) : null;
  if (venue !== undefined) updates.venue = venue;
  if (format !== undefined) updates.format = format;
  if (homeScore !== undefined) updates.homeScore = homeScore;
  if (awayScore !== undefined) updates.awayScore = awayScore;
  if (status !== undefined) updates.status = status;
  if (notes !== undefined) updates.notes = notes;
  const [fixture] = await db.update(interclubFixturesTable).set(updates).where(eq(interclubFixturesTable.id, fixtureId)).returning();
  res.json(fixture);
});

// DELETE /organizations/:orgId/leagues/:leagueId/interclub-fixtures/:fixtureId
router.delete("/:leagueId/interclub-fixtures/:fixtureId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const fixtureId = parseInt(String((req.params as Record<string, string>).fixtureId));
  await db.delete(interclubFixturesTable).where(eq(interclubFixturesTable.id, fixtureId));
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════════════════════════
   SEASON ARCHIVE (T72)
   ══════════════════════════════════════════════════════════════════════ */

// GET /organizations/:orgId/leagues/:leagueId/archive
router.get("/:leagueId/archive", leagueAccessMiddleware, async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  // Return all completed rounds with their results as an archive summary
  const rounds = await db
    .select({
      id: leagueRoundsTable.id,
      roundNumber: leagueRoundsTable.roundNumber,
      name: leagueRoundsTable.name,
      scheduledDate: leagueRoundsTable.scheduledDate,
      status: leagueRoundsTable.status,
    })
    .from(leagueRoundsTable)
    .where(and(eq(leagueRoundsTable.leagueId, leagueId), eq(leagueRoundsTable.status, "completed")))
    .orderBy(asc(leagueRoundsTable.roundNumber));

  const standings = await db
    .select({
      id: leagueStandingsTable.id,
      memberId: leagueStandingsTable.memberId,
      firstName: leagueMembersTable.firstName,
      lastName: leagueMembersTable.lastName,
      position: leagueStandingsTable.position,
      totalPoints: leagueStandingsTable.totalPoints,
      roundsPlayed: leagueStandingsTable.roundsPlayed,
      totalGross: leagueStandingsTable.totalGross,
      totalStableford: leagueStandingsTable.totalStableford,
      bestScore: leagueStandingsTable.bestScore,
    })
    .from(leagueStandingsTable)
    .innerJoin(leagueMembersTable, eq(leagueStandingsTable.memberId, leagueMembersTable.id))
    .where(eq(leagueStandingsTable.leagueId, leagueId))
    .orderBy(asc(leagueStandingsTable.position));

  const winner = standings[0] ?? null;
  const topScorer = [...standings].sort((a, b) => (b.bestScore ?? 999) - (a.bestScore ?? 999))[0] ?? null;

  res.json({ rounds, standings, winner, topScorer });
});

/* ══════════════════════════════════════════════════════════════════════
   BULK CSV IMPORT — LEAGUE MEMBERS (T72)
   ══════════════════════════════════════════════════════════════════════ */

// POST /organizations/:orgId/leagues/:leagueId/members/bulk-csv
// Body: { rows: Array<{ firstName, lastName, email, handicapIndex, teamName?, divisionId? }> }
router.post("/:leagueId/members/bulk-csv", orgAdminMiddleware, async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const rows: Array<{ firstName?: string; lastName?: string; email?: string; handicapIndex?: string; teamName?: string; divisionId?: string }> = req.body.rows ?? [];

  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: "rows array required" }); return;
  }

  const results = { success: 0, skipped: 0, errors: [] as { row: number; reason: string }[] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.firstName || !row.lastName) {
      results.errors.push({ row: i + 1, reason: "firstName and lastName required" });
      continue;
    }
    try {
      await db.insert(leagueMembersTable).values({
        leagueId,
        firstName: row.firstName.trim(),
        lastName: row.lastName.trim(),
        email: row.email?.trim() ?? null,
        handicapIndex: row.handicapIndex ? row.handicapIndex.trim() : null,
        teamName: row.teamName?.trim() ?? null,
        divisionId: row.divisionId ? parseInt(row.divisionId) : null,
      });
      results.success++;
    } catch {
      results.skipped++;
      results.errors.push({ row: i + 1, reason: "Duplicate or DB error — skipped" });
    }
  }

  res.json(results);
});

/* ══════════════════════════════════════════════════════════════════════
   LEAGUE TEAM MANAGEMENT (T71)
   ══════════════════════════════════════════════════════════════════════ */

// GET /organizations/:orgId/leagues/:leagueId/teams
router.get("/:leagueId/teams", leagueAccessMiddleware, async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const teams = await db
    .select({ id: eventTeamsTable.id, name: eventTeamsTable.name, colour: eventTeamsTable.colour })
    .from(eventTeamsTable)
    .where(eq(eventTeamsTable.leagueId, leagueId))
    .orderBy(asc(eventTeamsTable.id));

  const members = await db
    .select({
      teamId: eventTeamMembersTable.teamId,
      leagueMemberId: eventTeamMembersTable.leagueMemberId,
      firstName: leagueMembersTable.firstName,
      lastName: leagueMembersTable.lastName,
      handicapIndex: leagueMembersTable.handicapIndex,
    })
    .from(eventTeamMembersTable)
    .innerJoin(leagueMembersTable, eq(eventTeamMembersTable.leagueMemberId, leagueMembersTable.id))
    .where(inArray(eventTeamMembersTable.teamId, teams.length > 0 ? teams.map(t => t.id) : [-1]));

  const membersByTeam = members.reduce((acc, m) => {
    if (!acc[m.teamId]) acc[m.teamId] = [];
    acc[m.teamId].push(m);
    return acc;
  }, {} as Record<number, typeof members>);

  res.json(teams.map(t => ({
    ...t,
    members: membersByTeam[t.id] ?? [],
    combinedHandicap: (membersByTeam[t.id] ?? []).reduce((s, m) => s + parseFloat(String(m.handicapIndex ?? 0)), 0),
  })));
});

// POST /organizations/:orgId/leagues/:leagueId/teams
router.post("/:leagueId/teams", orgAdminMiddleware, async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const { name, colour } = req.body;
  if (!name) { { res.status(400).json({ error: "name required" }); return; } }
  const [team] = await db.insert(eventTeamsTable).values({ leagueId, name, colour: colour ?? "#22c55e" }).returning();
  res.status(201).json(team);
});

// PATCH /organizations/:orgId/leagues/:leagueId/teams/:teamId
router.patch("/:leagueId/teams/:teamId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const teamId = parseInt(String((req.params as Record<string, string>).teamId));
  const { name, colour } = req.body;
  const updates: Record<string, unknown> = {};
  if (name) updates.name = name;
  if (colour) updates.colour = colour;
  const [team] = await db.update(eventTeamsTable).set(updates).where(eq(eventTeamsTable.id, teamId)).returning();
  res.json(team);
});

// DELETE /organizations/:orgId/leagues/:leagueId/teams/:teamId
router.delete("/:leagueId/teams/:teamId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const teamId = parseInt(String((req.params as Record<string, string>).teamId));
  await db.delete(eventTeamsTable).where(eq(eventTeamsTable.id, teamId));
  res.json({ ok: true });
});

// POST /organizations/:orgId/leagues/:leagueId/teams/:teamId/members
router.post("/:leagueId/teams/:teamId/members", orgAdminMiddleware, async (req: Request, res: Response) => {
  const teamId = parseInt(String((req.params as Record<string, string>).teamId));
  const { leagueMemberId } = req.body;
  if (!leagueMemberId) { { res.status(400).json({ error: "leagueMemberId required" }); return; } }
  const lmId = parseInt(leagueMemberId);
  await db.delete(eventTeamMembersTable).where(eq(eventTeamMembersTable.leagueMemberId, lmId));
  const [member] = await db.insert(eventTeamMembersTable).values({ teamId, leagueMemberId: lmId }).returning();
  const [team] = await db.select({ name: eventTeamsTable.name }).from(eventTeamsTable).where(eq(eventTeamsTable.id, teamId));
  if (team) await db.update(leagueMembersTable).set({ teamName: team.name }).where(eq(leagueMembersTable.id, lmId));
  res.status(201).json(member);
});

// DELETE /organizations/:orgId/leagues/:leagueId/teams/:teamId/members/:memberId
router.delete("/:leagueId/teams/:teamId/members/:memberId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  await db.delete(eventTeamMembersTable).where(and(eq(eventTeamMembersTable.leagueMemberId, memberId), eq(eventTeamMembersTable.teamId, parseInt(String((req.params as Record<string, string>).teamId)))));
  await db.update(leagueMembersTable).set({ teamName: null }).where(eq(leagueMembersTable.id, memberId));
  res.json({ ok: true });
});

// POST /organizations/:orgId/leagues/:leagueId/teams/auto-draw
router.post("/:leagueId/teams/auto-draw", orgAdminMiddleware, async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const teamSize = Math.max(2, Math.min(6, parseInt(req.body.teamSize ?? "2") || 2));
  const teamNamePrefix = req.body.teamNamePrefix ?? "Team";

  const members = await db
    .select({ id: leagueMembersTable.id, handicapIndex: leagueMembersTable.handicapIndex })
    .from(leagueMembersTable)
    .where(eq(leagueMembersTable.leagueId, leagueId))
    .orderBy(asc(leagueMembersTable.handicapIndex));

  const existingTeams = await db.select({ id: eventTeamsTable.id }).from(eventTeamsTable).where(eq(eventTeamsTable.leagueId, leagueId));
  if (existingTeams.length > 0) {
    await db.delete(eventTeamMembersTable).where(inArray(eventTeamMembersTable.teamId, existingTeams.map(t => t.id)));
    await db.delete(eventTeamsTable).where(eq(eventTeamsTable.leagueId, leagueId));
  }

  const TEAM_COLOURS = ["#22c55e","#3b82f6","#ef4444","#f59e0b","#8b5cf6","#06b6d4","#ec4899","#f97316","#84cc16","#14b8a6"];
  const numTeams = Math.ceil(members.length / teamSize);
  const teams: { id: number; name: string }[] = [];

  for (let i = 0; i < numTeams; i++) {
    const [team] = await db.insert(eventTeamsTable).values({
      leagueId, name: `${teamNamePrefix} ${i + 1}`, colour: TEAM_COLOURS[i % TEAM_COLOURS.length],
    }).returning({ id: eventTeamsTable.id, name: eventTeamsTable.name });
    teams.push(team);
  }

  const assignments: { teamId: number; leagueMemberId: number }[] = [];
  for (let i = 0; i < members.length; i++) {
    const round = Math.floor(i / numTeams);
    const posInRound = i % numTeams;
    const teamIdx = round % 2 === 0 ? posInRound : (numTeams - 1 - posInRound);
    assignments.push({ teamId: teams[teamIdx].id, leagueMemberId: members[i].id });
  }
  if (assignments.length > 0) {
    await db.insert(eventTeamMembersTable).values(assignments);
    for (const t of teams) {
      const memberIds = assignments.filter(a => a.teamId === t.id).map(a => a.leagueMemberId);
      if (memberIds.length > 0) {
        await db.update(leagueMembersTable).set({ teamName: t.name }).where(inArray(leagueMembersTable.id, memberIds));
      }
    }
  }

  res.json({ teams, assignments });
});

export default router;
