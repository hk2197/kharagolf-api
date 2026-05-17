import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { scoresTable, playersTable, holeDetailsTable, tournamentsTable, coursesTable, tournamentRoundsTable, roundSubmissionsTable } from "@workspace/db";
import { eq, sql, and, count, inArray } from "drizzle-orm";
import { computeLeaderboard, notifyLeaderboardUpdate, notifyScoringEvent, notifyMarkerLiveScore, addAnnouncementClient, removeAnnouncementClient, broadcastAnnouncement, getAnnouncements, type ScoringEvent } from "../lib/realtime";
import { deliverSpectatorPush } from "../lib/spectatorNotify";
import { runPaceEngine } from "./pace-of-play";
import { computePlayingHandicap, strokesOnHole, stablefordPointsForHole, effectiveHandicapIndex } from "../lib/handicap";
import { evaluateAchievementsForPlayer } from "../lib/achievementEngine";
import { sendTransactionalPush } from "../lib/comms";
import {
  notifyScoringEventEagle,
  notifyScoringEventHoleInOne,
  notifyLeaderboardPositionChange,
} from "../lib/brandedNotifications";
import { logger } from "../lib/logger";
import { requireScorerAccess } from "../lib/permissions";
import { dispatchWebhookEvent } from "../lib/webhookDispatch";
import { recalcFantasyPoints } from "./fantasy";
import { fantasyLeaguesTable } from "@workspace/db";
import { track } from "../lib/analytics";

/**
 * Fire-and-forget achievement evaluation after a round appears complete.
 * Checks how many holes have been scored for the player in this round; if ≥ 9
 * (or a configurable threshold) we run the full achievement engine asynchronously
 * so it never blocks the score submission response.
 */
async function maybeEvaluateAchievements(playerId: number, tournamentId: number, round: number): Promise<void> {
  try {
    const [holesScored] = await db
      .select({ n: count() })
      .from(scoresTable)
      .where(and(
        eq(scoresTable.playerId, playerId),
        eq(scoresTable.tournamentId, tournamentId),
        eq(scoresTable.round, round),
      ));

    if ((holesScored?.n ?? 0) >= 9) {
      // Look up the player's linked portal user account
      const [player] = await db
        .select({ userId: playersTable.userId })
        .from(playersTable)
        .where(eq(playersTable.id, playerId));

      if (player?.userId) {
        await evaluateAchievementsForPlayer(player.userId, playerId, tournamentId);
      }
    }
  } catch (err: unknown) {
    logger.warn({ err, playerId, tournamentId }, "[scores] achievement evaluation failed (non-fatal)");
  }
}

async function detectAndDispatchScoringEvents(
  tournamentId: number,
  playerId: number,
  holeNumber: number,
  strokes: number,
  round: number,
  preSavePosition: number | null,
  postSaveLeaderboard: Awaited<ReturnType<typeof computeLeaderboard>>,
): Promise<void> {
  try {
    const [tournament] = await db
      .select({ courseId: tournamentsTable.courseId, handicapAllowance: tournamentsTable.handicapAllowance })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, tournamentId));

    if (!tournament?.courseId) return;

    // Resolve per-round course (multi-course tournament support)
    const [roundRow] = await db
      .select({ courseId: tournamentRoundsTable.courseId })
      .from(tournamentRoundsTable)
      .where(and(
        eq(tournamentRoundsTable.tournamentId, tournamentId),
        eq(tournamentRoundsTable.roundNumber, round),
      ));
    const effectiveCourseId = roundRow?.courseId ?? tournament.courseId;

    const [[holeDetail], [course], [player]] = await Promise.all([
      db.select({ par: holeDetailsTable.par, strokeIndex: holeDetailsTable.handicap })
        .from(holeDetailsTable)
        .where(and(
          eq(holeDetailsTable.courseId, effectiveCourseId),
          eq(holeDetailsTable.holeNumber, holeNumber),
        )),
      db.select({ slope: coursesTable.slope, rating: coursesTable.rating, par: coursesTable.par })
        .from(coursesTable)
        .where(eq(coursesTable.id, effectiveCourseId)),
      db.select({ firstName: playersTable.firstName, lastName: playersTable.lastName, userId: playersTable.userId, handicapIndex: playersTable.handicapIndex, handicapOverride: playersTable.handicapOverride })
        .from(playersTable)
        .where(eq(playersTable.id, playerId)),
    ]);

    if (!holeDetail || !player) return;

    const par = holeDetail.par;
    const grossToPar = strokes - par;

    const hi = effectiveHandicapIndex(player.handicapIndex, player.handicapOverride);
    const allowance = tournament.handicapAllowance ?? 100;
    const playingHandicap = computePlayingHandicap(hi, course?.slope, course?.rating != null ? parseFloat(course.rating) : undefined, course?.par ?? 72, allowance);
    const handicapStrokes = strokesOnHole(holeDetail.strokeIndex, playingHandicap);
    const netToPar = grossToPar - handicapStrokes;

    const isHIO = strokes === 1 && par === 3;
    const isEagle = netToPar <= -2;
    const isBirdie = !isHIO && !isEagle && grossToPar === -1;

    const playerName = `${player.firstName} ${player.lastName}`;

    if (isHIO || isEagle || isBirdie) {
      const eventType: ScoringEvent["eventType"] = isHIO ? "hole_in_one" : isEagle ? "eagle" : "birdie";
      const evt: ScoringEvent = {
        tournamentId,
        playerId,
        playerName,
        holeNumber,
        strokes,
        par,
        toPar: isBirdie ? grossToPar : netToPar,
        eventType,
        round,
        occurredAt: new Date().toISOString(),
      };
      notifyScoringEvent(tournamentId, evt);
      // Granular spectator push for followers (per-event opt-in).
      deliverSpectatorPush(evt).catch(() => {});
    }

    if (isHIO || isEagle) {

      const tournamentPlayers = await db
        .select({ userId: playersTable.userId })
        .from(playersTable)
        .where(eq(playersTable.tournamentId, tournamentId));

      const userIds = tournamentPlayers
        .map(p => p.userId)
        .filter((id): id is number => typeof id === "number" && id > 0);

      if (userIds.length > 0) {
        const title = isHIO ? "⛳ Hole-in-One!" : "🦅 Eagle!";
        const body = isHIO
          ? `${playerName} just made a hole-in-one on hole ${holeNumber}!`
          : `${playerName} scored eagle on hole ${holeNumber}!`;
        // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
        // telemetry consumed downstream, classifier intentionally not used.
        sendTransactionalPush(userIds, title, body, { type: isHIO ? "hole_in_one" : "eagle", tournamentId, holeNumber, playerName }).catch(() => {});

        // Task #2008 — branded `scoring.event.eagle` / `scoring.event.hole_in_one`
        // dispatch to the scoring player so the spectator-style email + digest
        // path runs alongside the bespoke spectator push above. The event row
        // contains the canonical scoring metadata; we deliberately re-use it.
        if (player.userId) {
          if (isHIO) {
            void notifyScoringEventHoleInOne({
              userIds: [player.userId],
              roundId: tournamentId,
              holeNumber,
            });
          } else {
            void notifyScoringEventEagle({
              userIds: [player.userId],
              roundId: tournamentId,
              holeNumber,
            });
          }
        }
      }
    }

    if (preSavePosition !== null && postSaveLeaderboard && player.userId) {
      const postSaveEntry = postSaveLeaderboard.entries.find(e => e.playerId === playerId);
      const postSavePosition = postSaveEntry?.position ?? null;
      if (postSavePosition !== null) {
        const moved = postSavePosition - preSavePosition;
        if (Math.abs(moved) >= 3) {
          const up = moved < 0;
          const title = up ? "📈 Moving up!" : "📉 Leaderboard update";
          const body = up
            ? `You've moved up to position ${postSavePosition} on the leaderboard!`
            : `You've moved to position ${postSavePosition} on the leaderboard.`;
          // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
          // telemetry consumed downstream, classifier intentionally not used.
          sendTransactionalPush([player.userId], title, body, { type: "position_change", tournamentId, position: postSavePosition }).catch(() => {});

          // Task #2008 — branded `leaderboard.position.change` dispatch (email
          // + digest fan-out) on top of the bespoke push above. Same ≥3-place
          // movement threshold so we don't flood members with every micro-shift.
          void notifyLeaderboardPositionChange({
            userIds: [player.userId],
            tournamentId,
            newPosition: postSavePosition,
            previousPosition: preSavePosition,
          });
        }
      }
    }
  } catch (err) {
    logger.warn({ err, tournamentId, playerId }, "[scores] detectAndDispatchScoringEvents failed (non-fatal)");
  }
}

const router: IRouter = Router({ mergeParams: true });

// GET /organizations/:orgId/tournaments/:tournamentId/scores
router.get("/", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = req.query.playerId ? parseInt(req.query.playerId as string) : undefined;

  let scores;
  if (playerId) {
    scores = await db.select().from(scoresTable).where(sql`${scoresTable.tournamentId} = ${tournamentId} AND ${scoresTable.playerId} = ${playerId}`);
  } else {
    scores = await db.select().from(scoresTable).where(eq(scoresTable.tournamentId, tournamentId));
  }

  res.json(scores);
});

// POST /organizations/:orgId/tournaments/:tournamentId/scores
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await requireScorerAccess(req, res, orgId, tournamentId))) return;

  const { playerId, round, holeNumber, strokes, putts, fairwayHit, girHit, clientKnownAt } = req.body as {
    playerId: number; round?: number; holeNumber: number;
    strokes: number; putts?: number | null; fairwayHit?: boolean | null;
    girHit?: boolean | null; clientKnownAt?: string | null;
  };

  if (!playerId || !holeNumber || strokes === undefined) {
    res.status(400).json({ error: "playerId, holeNumber, and strokes are required" });
    return;
  }

  // Wave 1 W1-B — sync-conflict detector. If the client tells us when
  // it last saw the row (`clientKnownAt`) and the server has a newer
  // version, return 409 with both payloads so the UI can surface a
  // "two devices both edited this hole" dialog. Last-write-wins is
  // still the eventual behaviour — this just exposes the conflict.
  if (clientKnownAt) {
    const clientKnownDate = new Date(clientKnownAt);
    if (!Number.isNaN(clientKnownDate.getTime())) {
      const [serverRow] = await db
        .select()
        .from(scoresTable)
        .where(and(
          eq(scoresTable.tournamentId, tournamentId),
          eq(scoresTable.playerId, playerId),
          eq(scoresTable.round, round ?? 1),
          eq(scoresTable.holeNumber, holeNumber),
        ))
        .limit(1);
      if (serverRow && serverRow.updatedAt && serverRow.updatedAt > clientKnownDate) {
        res.status(409).json({
          error: "Score was modified by another device since you last loaded it.",
          conflict: true,
          server: serverRow,
          client: { strokes, putts: putts ?? null, fairwayHit: fairwayHit ?? null, girHit: girHit ?? null, clientKnownAt },
        });
        return;
      }
    }
  }

  // Capture pre-save leaderboard position for position-change alert
  const preSavePosition = await computeLeaderboard(tournamentId)
    .then(lb => lb?.entries.find(e => e.playerId === playerId)?.position ?? null)
    .catch(() => null);

  // Detect insert vs update before the upsert for correct webhook event type
  const [existingScore] = await db
    .select({ id: scoresTable.id })
    .from(scoresTable)
    .where(and(
      eq(scoresTable.playerId, playerId),
      eq(scoresTable.round, round ?? 1),
      eq(scoresTable.holeNumber, holeNumber),
    ))
    .limit(1);
  const isUpdate = !!existingScore;

  // Upsert score (insert or update)
  const [score] = await db
    .insert(scoresTable)
    .values({
      tournamentId,
      playerId,
      round: round ?? 1,
      holeNumber,
      strokes,
      putts: putts ?? null,
      fairwayHit: fairwayHit ?? null,
      girHit: girHit ?? null,
      isVerified: false,
    })
    .onConflictDoUpdate({
      target: [scoresTable.playerId, scoresTable.round, scoresTable.holeNumber],
      set: {
        strokes,
        putts: putts ?? null,
        fairwayHit: fairwayHit ?? null,
        girHit: girHit ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  // Update player's current hole
  await db
    .update(playersTable)
    .set({ currentHole: holeNumber, currentRound: round ?? 1 })
    .where(eq(playersTable.id, playerId));

  // Trigger real-time leaderboard update
  const leaderboard = await computeLeaderboard(tournamentId);
  if (leaderboard) {
    notifyLeaderboardUpdate(tournamentId, { entries: leaderboard.entries, netEntries: leaderboard.netEntries, stablefordEntries: leaderboard.stablefordEntries, availableViews: leaderboard.availableViews, leaderboardType: leaderboard.leaderboardType, tiebreakerMethod: leaderboard.tiebreakerMethod, teamEntries: leaderboard.teamEntries, isTeamFormat: leaderboard.isTeamFormat });
  }

  // Fire-and-forget: scoring event detection (eagle/HIO SSE + push) and position change alerts
  detectAndDispatchScoringEvents(tournamentId, playerId, holeNumber, strokes, round ?? 1, preSavePosition, leaderboard).catch(() => {});

  // Fire-and-forget achievement evaluation (does not block response)
  maybeEvaluateAchievements(playerId, tournamentId, round ?? 1).catch(() => {});

  // Fire-and-forget: update fantasy points for any fantasy leagues linked to this tournament
  db.select({ id: fantasyLeaguesTable.id })
    .from(fantasyLeaguesTable)
    .where(eq(fantasyLeaguesTable.tournamentId, tournamentId))
    .then(fls => {
      for (const fl of fls) {
        recalcFantasyPoints(fl.id).catch(() => {});
      }
    })
    .catch(() => {});

  // Fire-and-forget: update pace of play records and broadcast to marshals
  runPaceEngine(tournamentId, round ?? 1).catch(() => {});

  // Fire-and-forget: notify marker live SSE clients (scorer/admin entry path)
  Promise.resolve().then(async () => {
    try {
      const [[playerRow], [activeSubmission]] = await Promise.all([
        db.select({ firstName: playersTable.firstName, lastName: playersTable.lastName })
          .from(playersTable).where(eq(playersTable.id, playerId)),
        db.select({ markerShareToken: roundSubmissionsTable.markerShareToken, markerShareTokenExpiresAt: roundSubmissionsTable.markerShareTokenExpiresAt })
          .from(roundSubmissionsTable)
          .where(and(eq(roundSubmissionsTable.playerId, playerId), eq(roundSubmissionsTable.round, round ?? 1))),
      ]);
      if (activeSubmission?.markerShareToken && activeSubmission.markerShareTokenExpiresAt && activeSubmission.markerShareTokenExpiresAt > new Date()) {
        notifyMarkerLiveScore(activeSubmission.markerShareToken, {
          tournamentId, playerId, round: round ?? 1, holeNumber, strokes,
          playerName: playerRow ? `${playerRow.firstName} ${playerRow.lastName}` : `Player ${playerId}`,
          occurredAt: new Date().toISOString(),
        });
      }
    } catch { /* non-fatal */ }
  }).catch(() => {});

  dispatchWebhookEvent(orgId, isUpdate ? "score.updated" : "score.submitted", {
    scoreId: score.id,
    tournamentId,
    playerId,
    round: round ?? 1,
    holeNumber,
    strokes,
  });

  // Wave 0 / Task #935 — analytics smoke test (4/5: scorecard_submitted)
  void track("scorecard_submitted", {
    scoreId: score.id,
    tournamentId,
    playerId,
    round: round ?? 1,
    holeNumber,
    strokes,
    isUpdate,
    putts: putts ?? null,
    fairwayHit: fairwayHit ?? null,
    girHit: girHit ?? null,
  }, {
    organizationId: orgId,
    surface: "api",
  });

  res.json(score);
});

// POST /organizations/:orgId/tournaments/:tournamentId/scores/bulk
router.post("/bulk", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await requireScorerAccess(req, res, orgId, tournamentId))) return;

  const { scores } = req.body;

  if (!Array.isArray(scores) || scores.length === 0) {
    res.status(400).json({ error: "scores array is required" });
    return;
  }

  const results = [];
  for (const s of scores) {
    const [score] = await db
      .insert(scoresTable)
      .values({
        tournamentId,
        playerId: s.playerId,
        round: s.round ?? 1,
        holeNumber: s.holeNumber,
        strokes: s.strokes,
        putts: s.putts ?? null,
        fairwayHit: s.fairwayHit ?? null,
        girHit: s.girHit ?? null,
        isVerified: false,
      })
      .onConflictDoUpdate({
        target: [scoresTable.playerId, scoresTable.round, scoresTable.holeNumber],
        set: { strokes: s.strokes, putts: s.putts ?? null, updatedAt: new Date() },
      })
      .returning();
    results.push(score);
  }

  const leaderboard = await computeLeaderboard(tournamentId);
  if (leaderboard) {
    notifyLeaderboardUpdate(tournamentId, { entries: leaderboard.entries, netEntries: leaderboard.netEntries, stablefordEntries: leaderboard.stablefordEntries, availableViews: leaderboard.availableViews, leaderboardType: leaderboard.leaderboardType, tiebreakerMethod: leaderboard.tiebreakerMethod, teamEntries: leaderboard.teamEntries, isTeamFormat: leaderboard.isTeamFormat });
  }

  // Fire achievement evaluation for each unique player in the bulk submission
  const uniquePlayerRounds = new Map<string, { playerId: number; round: number }>();
  for (const s of scores) {
    const k = `${s.playerId}-${s.round ?? 1}`;
    if (!uniquePlayerRounds.has(k)) uniquePlayerRounds.set(k, { playerId: s.playerId, round: s.round ?? 1 });
  }
  for (const { playerId, round } of uniquePlayerRounds.values()) {
    maybeEvaluateAchievements(playerId, tournamentId, round).catch(() => {});
  }

  // Fire-and-forget: update pace of play records
  const bulkRound = scores[0]?.round ?? 1;
  runPaceEngine(tournamentId, bulkRound).catch(() => {});

  res.json(results);
});

// POST /organizations/:orgId/tournaments/:tournamentId/scores/batch-verify
// Mark all scores for a group of players in a round as verified + push notification
router.post("/batch-verify", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await requireScorerAccess(req, res, orgId, tournamentId))) return;

  const { playerIds, round = 1 } = req.body as { playerIds: number[]; round?: number };
  if (!Array.isArray(playerIds) || playerIds.length === 0) {
    res.status(400).json({ error: "playerIds array is required" }); return;
  }

  await db.update(scoresTable)
    .set({ isVerified: true, updatedAt: new Date() })
    .where(and(
      eq(scoresTable.tournamentId, tournamentId),
      eq(scoresTable.round, round),
      inArray(scoresTable.playerId, playerIds),
    ));

  // Push notifications to players (fire-and-forget)
  const playerRows = await db.select({ userId: playersTable.userId })
    .from(playersTable)
    .where(inArray(playersTable.id, playerIds));
  const userIds = playerRows.map(r => r.userId).filter((id): id is number => id != null);
  if (userIds.length > 0) {
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendTransactionalPush(userIds, 'Scorecard Verified', 'Your round scorecard has been confirmed by the scorer.', { tournamentId }).catch(() => {});
  }

  const leaderboard = await computeLeaderboard(tournamentId);
  if (leaderboard) notifyLeaderboardUpdate(tournamentId, { entries: leaderboard.entries, netEntries: leaderboard.netEntries, stablefordEntries: leaderboard.stablefordEntries, availableViews: leaderboard.availableViews, leaderboardType: leaderboard.leaderboardType, tiebreakerMethod: leaderboard.tiebreakerMethod, teamEntries: leaderboard.teamEntries, isTeamFormat: leaderboard.isTeamFormat });

  res.json({ verified: playerIds.length });
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/scores/:playerId/:holeNumber
router.delete("/:playerId/:holeNumber", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!(await requireScorerAccess(req, res, orgId, tournamentId))) return;

  const playerId     = parseInt(String((req.params as Record<string, string>).playerId));
  const holeNumber   = parseInt(String((req.params as Record<string, string>).holeNumber));
  const round        = req.query.round ? parseInt(req.query.round as string) : 1;

  await db.delete(scoresTable).where(
    and(
      eq(scoresTable.tournamentId, tournamentId),
      eq(scoresTable.playerId, playerId),
      eq(scoresTable.holeNumber, holeNumber),
      eq(scoresTable.round, round),
    ),
  );

  const leaderboard = await computeLeaderboard(tournamentId);
  if (leaderboard) notifyLeaderboardUpdate(tournamentId, { entries: leaderboard.entries, netEntries: leaderboard.netEntries, stablefordEntries: leaderboard.stablefordEntries, availableViews: leaderboard.availableViews, leaderboardType: leaderboard.leaderboardType, tiebreakerMethod: leaderboard.tiebreakerMethod, teamEntries: leaderboard.teamEntries, isTeamFormat: leaderboard.isTeamFormat });

  res.json({ deleted: true });
});

// GET /organizations/:orgId/tournaments/:tournamentId/leaderboard
router.get("/leaderboard", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const leaderboard = await computeLeaderboard(tournamentId);
  if (!leaderboard) { { res.status(404).json({ error: "Tournament not found" }); return; } }
  res.json(leaderboard);
});

// GET /organizations/:orgId/tournaments/:tournamentId/leaderboard/teams
router.get("/leaderboard/teams", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const leaderboard = await computeLeaderboard(tournamentId);
  if (!leaderboard) { { res.status(404).json({ error: "Tournament not found" }); return; } }
  res.json({
    tournamentId: leaderboard.tournamentId,
    isTeamFormat: leaderboard.isTeamFormat,
    teamEntries: leaderboard.teamEntries,
    lastUpdated: leaderboard.lastUpdated,
  });
});

// GET /organizations/:orgId/tournaments/:tournamentId/scorecard/:playerId
router.get("/scorecard/:playerId", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));

  const [player] = await db.select().from(playersTable).where(eq(playersTable.id, playerId));
  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }

  const [tournament] = await db
    .select({ id: tournamentsTable.id, name: tournamentsTable.name, format: tournamentsTable.format, courseId: tournamentsTable.courseId, handicapAllowance: tournamentsTable.handicapAllowance, status: tournamentsTable.status, rounds: tournamentsTable.rounds })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const scores = await db.select().from(scoresTable)
    .where(sql`${scoresTable.playerId} = ${playerId} AND ${scoresTable.tournamentId} = ${tournamentId}`)
    .orderBy(scoresTable.round, scoresTable.holeNumber);

  type HoleEntry = { holeNumber: number; par: number; handicap: number | null; strokes: number | null; putts: number | null; fairwayHit: boolean | null; girHit: boolean | null; toPar: number | null };

  let holeTemplate: { holeNumber: number; par: number; handicap: number | null }[] = [];
  let coursePar = 72;
  let courseSlope: number | null = null;
  let courseRating: number | null = null;
  let courseName: string | null = null;

  if (tournament.courseId) {
    const [course] = await db
      .select({ name: coursesTable.name, par: coursesTable.par, slope: coursesTable.slope, rating: coursesTable.rating })
      .from(coursesTable)
      .where(eq(coursesTable.id, tournament.courseId));
    courseName = course?.name ?? null;
    coursePar = course?.par ?? 72;
    courseSlope = course?.slope ?? null;
    courseRating = course?.rating ? Number(course.rating) : null;

    const courseHoles = await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournament.courseId)).orderBy(holeDetailsTable.holeNumber);
    holeTemplate = courseHoles.map((h) => ({ holeNumber: h.holeNumber, par: h.par, handicap: h.handicap ?? null }));
  } else {
    holeTemplate = Array.from({ length: 18 }, (_, i) => ({ holeNumber: i + 1, par: 4, handicap: null }));
    coursePar = 72;
  }

  // Requested round — defaults to latest round with scores, or 1
  const requestedRound = req.query.round ? parseInt(req.query.round as string) : null;
  const roundsWithScores = [...new Set(scores.map(s => s.round))].sort((a, b) => a - b);
  const activeRound = requestedRound ?? (roundsWithScores.at(-1) ?? 1);

  const roundScores = scores.filter(sc => sc.round === activeRound);
  const holes: HoleEntry[] = holeTemplate.map((h) => {
    const s = roundScores.find((sc) => sc.holeNumber === h.holeNumber);
    return {
      holeNumber: h.holeNumber,
      par: h.par,
      handicap: h.handicap,
      strokes: s?.strokes ?? null,
      putts: s?.putts ?? null,
      fairwayHit: s?.fairwayHit ?? null,
      girHit: s?.girHit ?? null,
      toPar: s ? s.strokes - h.par : null,
    };
  });

  const totalStrokes = roundScores.reduce((acc, s) => acc + s.strokes, 0);
  const handicapAllowance = tournament.handicapAllowance ?? 100;
  const hiEffective = effectiveHandicapIndex(player.handicapIndex, player.handicapOverride);
  const playingHandicap = computePlayingHandicap(hiEffective, courseSlope, courseRating, coursePar, handicapAllowance);

  res.json({
    player: { ...player, handicapIndex: player.handicapIndex ? Number(player.handicapIndex) : null },
    tournament: { ...tournament, courseName },
    round: activeRound,
    availableRounds: roundsWithScores,
    holes,
    totalStrokes: roundScores.length > 0 ? totalStrokes : null,
    totalPutts: null,
    playingHandicap,
    totalNetScore: roundScores.length > 0 ? totalStrokes - playingHandicap : null,
    scoreToPar: roundScores.length > 0 ? totalStrokes - coursePar : null,
  });
});

// Helper: verify tournament belongs to org
async function verifyTournamentOrg(orgId: number, tournamentId: number): Promise<boolean> {
  const [t] = await db.select({ organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  return !!t && t.organizationId === orgId;
}

// GET /organizations/:orgId/tournaments/:tournamentId/announcements/stream — SSE
router.get("/announcements/stream", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  const tournamentId = parseInt((req.params as Record<string, string>).tournamentId as string);
  if (!(await verifyTournamentOrg(orgId, tournamentId))) {
    res.status(404).json({ error: "Tournament not found" }); return;
  }
  const scope = `tournament_${tournamentId}`;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  // Send current announcements on connect
  const existing = getAnnouncements(scope);
  for (const a of existing) {
    res.write(`data: ${JSON.stringify({ type: "announcement", data: a })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  addAnnouncementClient(scope, res);
  req.on("close", () => removeAnnouncementClient(scope, res));
});

// NOTE: GET /announcements and POST /announcements are handled by the
// announcementsRouter in communications.ts (mounted later) which provides
// DB persistence, proper authorization, and read receipts.
// These routes were migrated to avoid duplication.

// GET /organizations/:orgId/tournaments/:tournamentId/scorecards
// Returns all player scorecards for printing
router.get("/scorecards", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  const tournamentId = parseInt((req.params as Record<string, string>).tournamentId as string);

  if (!(await verifyTournamentOrg(orgId, tournamentId))) {
    res.status(404).json({ error: "Tournament not found" }); return;
  }

  const [tournament] = await db
    .select({ name: tournamentsTable.name, format: tournamentsTable.format, courseId: tournamentsTable.courseId, handicapAllowance: tournamentsTable.handicapAllowance })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  let holeParMap: Map<number, number> = new Map();
  let holeHandicapMap: Map<number, number | null> = new Map();
  let holeCount = 18;
  let coursePar = 72;
  let courseName: string | null = null;
  let courseSlope: number | null = null;
  let courseRating: number | null = null;

  if (tournament.courseId) {
    const [course] = await db.select({ name: coursesTable.name, par: coursesTable.par, slope: coursesTable.slope, rating: coursesTable.rating }).from(coursesTable).where(eq(coursesTable.id, tournament.courseId));
    courseName = course?.name ?? null;
    coursePar = course?.par ?? 72;
    courseSlope = course?.slope ?? null;
    courseRating = course?.rating ? Number(course.rating) : null;

    const holes = await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournament.courseId)).orderBy(holeDetailsTable.holeNumber);
    holeCount = holes.length || 18;
    for (const h of holes) {
      holeParMap.set(h.holeNumber, h.par);
      holeHandicapMap.set(h.holeNumber, h.handicap ?? null);
    }
  }

  const handicapAllowance = tournament.handicapAllowance ?? 100;
  // Optional ?round= filter: defaults to round 1 for printing
  const requestedRound = req.query.round ? parseInt(req.query.round as string) : 1;

  const players = await db.select().from(playersTable).where(eq(playersTable.tournamentId, tournamentId)).orderBy(playersTable.lastName);

  const scorecards = await Promise.all(players.map(async (player) => {
    const allScores = await db.select().from(scoresTable)
      .where(and(eq(scoresTable.tournamentId, tournamentId), eq(scoresTable.playerId, player.id)))
      .orderBy(scoresTable.round, scoresTable.holeNumber);
    // Only use scores for the requested round — prevents cross-round hole collisions
    const scores = allScores.filter(s => s.round === requestedRound);

    const handicapIndex = effectiveHandicapIndex(player.handicapIndex, player.handicapOverride);
    const playingHandicap = computePlayingHandicap(handicapIndex, courseSlope, courseRating, coursePar, handicapAllowance);

    const holeScores = Array.from({ length: holeCount }, (_, i) => {
      const h = i + 1;
      const s = scores.find(s => s.holeNumber === h);
      const par = holeParMap.get(h) ?? 4;
      const si = holeHandicapMap.get(h) ?? null;
      return {
        hole: h,
        par,
        handicap: si,
        strokes: s?.strokes ?? null,
        toPar: s ? s.strokes - par : null,
        stablefordPoints: s ? stablefordPointsForHole(s.strokes, par, si, playingHandicap) : null,
        isVerified: s?.isVerified ?? false,
      };
    });

    const grossScore = scores.length > 0 ? scores.reduce((a, s) => a + s.strokes, 0) : null;
    const netScore = grossScore !== null ? grossScore - playingHandicap : null;
    const totalStableford = scores.length > 0 ? holeScores.reduce((a, h) => a + (h.stablefordPoints ?? 0), 0) : null;

    return {
      playerId: player.id,
      playerName: `${player.firstName} ${player.lastName}`,
      flight: player.flight,
      teeBox: player.teeBox,
      handicapIndex,
      playingHandicap,
      checkedIn: player.checkedIn,
      grossScore,
      netScore,
      stablefordPoints: totalStableford,
      holeScores,
      outScore: holeScores.filter(h => h.hole <= 9).reduce((a, h) => a + (h.strokes ?? 0), 0),
      inScore: holeScores.filter(h => h.hole >= 10).reduce((a, h) => a + (h.strokes ?? 0), 0),
      outPar: holeScores.filter(h => h.hole <= 9).reduce((a, h) => a + h.par, 0),
      inPar: holeScores.filter(h => h.hole >= 10).reduce((a, h) => a + h.par, 0),
    };
  }));

  res.json({
    tournamentName: tournament.name,
    format: tournament.format,
    courseName,
    coursePar,
    holeCount,
    scorecards,
  });
});

export default router;
