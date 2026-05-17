import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { tournamentsTable, coursesTable, playersTable, holeDetailsTable, flightsTable, playerFlightsTable, scoresTable, organizationsTable, sponsorsTable, waitlistTable, whsPostingsTable, orgGhinCredentialsTable, teeTimesTable, teeTimePlayersTable, sideGamesConfigTable, holeSponsorsTable, tournamentRoundsTable, prizeAwardsTable, prizeCategoriesTable, eventTeamsTable, eventTeamMembersTable, tournamentRulingsTable, eventSurveyFormsTable, tournamentNotificationOverrideAuditTable, appUsersTable } from "@workspace/db";
import { eq, sql, count, and, inArray, asc, desc } from "drizzle-orm";
import { notifyLeaderboardUpdate } from "../lib/realtime";
import { sendTransactionalPush } from "../lib/comms";
import { sendWaitlistPromotionEmail, sendTournamentResultsEmail, sendTournamentRecapEmail } from "../lib/mailer";
import { sendSurveyEmails } from "./event-forms";
import { computePlayingHandicap, stablefordPointsForHole } from "../lib/handicap";
import { getWeather } from "../lib/weather";
import { logger } from "../lib/logger";
import { requireTournamentAccess, requireOrgAdmin, orgAdminMiddleware } from "../lib/permissions";
import { gateTournamentCreate, checkActiveTournamentLimitForTransition } from "../lib/featureGate";
import { calculateAGS, calculateGrossScore } from "../lib/ags";
import { postScoreToGhin, resolveGhinCredentials, type GhinCredentials } from "../lib/ghin";
import { generatePocketScorecardPDF, type PocketScorecardData, type PocketPlayerCard } from "../lib/pdfPocketScorecard";
import { generateTournamentReportPDF } from "../lib/pdfTournamentReport";
import { dispatchWebhookEvent } from "../lib/webhookDispatch";
import { sideGameResultsTable } from "@workspace/db";
import { computeLeaderboard } from "../lib/realtime";
import { scorePredictionsForTournament, sendPredictionResultsEmails } from "../lib/odds";
import { creditTournamentResultsToLadders } from "../lib/cross-club-ladder-feed";
import { isNull, or } from "drizzle-orm";

const router: IRouter = Router({ mergeParams: true });

/* ─── Auto-post WHS on tournament completion ─────────────────────────────── */

async function autoPostWhsForTournament(orgId: number, tournamentId: number, rounds: number) {
  try {
    const [orgCredsRow] = await db
      .select({ ghinApiKey: orgGhinCredentialsTable.ghinApiKey, ghinApiUsername: orgGhinCredentialsTable.ghinApiUsername, ghinApiPassword: orgGhinCredentialsTable.ghinApiPassword })
      .from(orgGhinCredentialsTable)
      .where(eq(orgGhinCredentialsTable.organizationId, orgId));
    const orgCreds: GhinCredentials | null = orgCredsRow
      ? { apiKey: orgCredsRow.ghinApiKey, username: orgCredsRow.ghinApiUsername, password: orgCredsRow.ghinApiPassword }
      : null;
    const creds = resolveGhinCredentials(orgCreds);
    if (!creds) {
      logger.warn({ orgId, tournamentId }, "[whs] Auto-post skipped — no GHIN credentials configured");
      return;
    }

    const [tournament] = await db
      .select({
        id: tournamentsTable.id,
        name: tournamentsTable.name,
        courseId: tournamentsTable.courseId,
        handicapAllowance: tournamentsTable.handicapAllowance,
        startDate: tournamentsTable.startDate,
      })
      .from(tournamentsTable)
      .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));

    if (!tournament) return;

    const courseData = tournament.courseId
      ? await db.select({ name: coursesTable.name, rating: coursesTable.rating, slope: coursesTable.slope, par: coursesTable.par })
          .from(coursesTable).where(eq(coursesTable.id, tournament.courseId)).then(r => r[0] ?? null)
      : null;

    const holeDetails = tournament.courseId
      ? await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournament.courseId)).orderBy(holeDetailsTable.holeNumber)
      : [];

    const handicapAllowance = tournament.handicapAllowance ?? 100;
    const courseRating: number = courseData?.rating ? parseFloat(String(courseData.rating)) : 72;
    const slope = courseData?.slope ?? 113;
    const courseName = courseData?.name ?? tournament.name;
    const playedAt = tournament.startDate ? new Date(tournament.startDate).toISOString().split("T")[0] : new Date().toISOString().split("T")[0];

    const players = await db.select().from(playersTable).where(eq(playersTable.tournamentId, tournamentId));

    for (let round = 1; round <= rounds; round++) {
      for (const player of players) {
        // Audit row for players missing a GHIN number
        if (!player.ghinNumber) {
          await db.insert(whsPostingsTable).values({
            tournamentId,
            playerId: player.id,
            round,
            grossScore: null,
            adjustedGrossScore: null,
            ghinNumber: null,
            courseRating: String(courseRating),
            slope,
            status: "no_ghin",
            errorMessage: "No GHIN number on file",
          }).onConflictDoUpdate({
            target: [whsPostingsTable.tournamentId, whsPostingsTable.playerId, whsPostingsTable.round],
            set: { status: "no_ghin", errorMessage: "No GHIN number on file", updatedAt: new Date() },
          });
          continue;
        }

        const playerScores = await db.select().from(scoresTable)
          .where(sql`${scoresTable.playerId} = ${player.id} AND ${scoresTable.tournamentId} = ${tournamentId} AND ${scoresTable.round} = ${round}`);

        const hiNum = player.handicapOverride != null ? Number(player.handicapOverride) : (player.handicapIndex ? Number(player.handicapIndex) : 0);
        const playingHandicap = computePlayingHandicap(hiNum, courseData?.slope, courseRating, courseData?.par ?? 72, handicapAllowance);

        const holeScores = holeDetails.map(h => {
          const scored = playerScores.find(s => s.holeNumber === h.holeNumber);
          return { holeNumber: h.holeNumber, par: h.par, strokeIndex: h.handicap, strokes: scored?.strokes ?? null };
        });

        const grossScore = calculateGrossScore(holeScores.filter(h => h.strokes !== null));
        const ags = calculateAGS(holeScores, playingHandicap);
        // Normalize to 9 or 18 only — GHIN rejects other values
        const numberOfHoles: 9 | 18 | null = playerScores.length >= 18 ? 18 : playerScores.length >= 9 ? 9 : null;

        // Audit row for players with no scores or incomplete rounds (< 9 holes)
        if (ags === 0 || numberOfHoles === null) {
          const skipReason = numberOfHoles === null ? "Incomplete round (fewer than 9 holes scored)" : "No scores entered";
          await db.insert(whsPostingsTable).values({
            tournamentId,
            playerId: player.id,
            round,
            grossScore: null,
            adjustedGrossScore: null,
            ghinNumber: player.ghinNumber,
            courseRating: String(courseRating),
            slope,
            status: "pending",
            errorMessage: skipReason,
          }).onConflictDoNothing();
          continue;
        }

        const existing = await db.select({ status: whsPostingsTable.status })
          .from(whsPostingsTable)
          .where(and(eq(whsPostingsTable.tournamentId, tournamentId), eq(whsPostingsTable.playerId, player.id), eq(whsPostingsTable.round, round)))
          .then(r => r[0] ?? null);

        if (existing?.status === "posted") continue;

        const result = await postScoreToGhin({
          ghinNumber: player.ghinNumber,
          firstName: player.firstName,
          lastName: player.lastName,
          courseName,
          courseRating,
          slope,
          numberOfHoles,
          playedAt,
          adjustedGrossScore: ags,
        }, orgCreds);

        const code = !result.success ? (result as { code?: string }).code : undefined;
        const status = result.success ? "posted" : (code === "GOLFER_NOT_FOUND" ? "no_ghin" : "failed");

        await db.insert(whsPostingsTable).values({
          tournamentId,
          playerId: player.id,
          round,
          grossScore: grossScore || null,
          adjustedGrossScore: ags,
          ghinNumber: player.ghinNumber,
          courseRating: String(courseRating),
          slope,
          status,
          ghinResponse: result.success ? result.response : (result as { response?: Record<string, unknown> }).response ?? null,
          errorMessage: result.success ? null : result.error,
          postedAt: result.success ? new Date() : null,
        }).onConflictDoUpdate({
          target: [whsPostingsTable.tournamentId, whsPostingsTable.playerId, whsPostingsTable.round],
          set: {
            status,
            ghinResponse: result.success ? result.response : (result as { response?: Record<string, unknown> }).response ?? null,
            errorMessage: result.success ? null : result.error,
            postedAt: result.success ? new Date() : null,
            updatedAt: new Date(),
          },
        });

        logger.info({ playerId: player.id, round, status }, "[whs] Auto-post completed");
        await new Promise<void>(r => setTimeout(r, 1100));
      }
    }
  } catch (err) {
    logger.error({ err, orgId, tournamentId }, "[whs] Auto-post error");
  }
}

// GET /organizations/:orgId/tournaments
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const status = req.query.status as string | undefined;

  let query = db
    .select({
      id: tournamentsTable.id,
      organizationId: tournamentsTable.organizationId,
      courseId: tournamentsTable.courseId,
      name: tournamentsTable.name,
      description: tournamentsTable.description,
      format: tournamentsTable.format,
      status: tournamentsTable.status,
      startDate: tournamentsTable.startDate,
      endDate: tournamentsTable.endDate,
      rounds: tournamentsTable.rounds,
      maxPlayers: tournamentsTable.maxPlayers,
      entryFee: tournamentsTable.entryFee,
      currency: tournamentsTable.currency,
      isPublic: tournamentsTable.isPublic,
      allowSpectators: tournamentsTable.allowSpectators,
      registrationDeadline: tournamentsTable.registrationDeadline,
      createdAt: tournamentsTable.createdAt,
      courseName: coursesTable.name,
    })
    .from(tournamentsTable)
    .leftJoin(coursesTable, eq(coursesTable.id, tournamentsTable.courseId))
    .where(eq(tournamentsTable.organizationId, orgId))
    .$dynamic();

  if (status) {
    query = query.where(sql`${tournamentsTable.organizationId} = ${orgId} AND ${tournamentsTable.status} = ${status}`);
  }

  const tournaments = await query.orderBy(tournamentsTable.createdAt);

  const results = await Promise.all(
    tournaments.map(async (t) => {
      const [pc] = await db.select({ count: count() }).from(playersTable).where(eq(playersTable.tournamentId, t.id));
      return { ...t, playerCount: Number(pc?.count ?? 0) };
    }),
  );

  res.json(results);
});

// POST /organizations/:orgId/tournaments
router.post("/", gateTournamentCreate(), async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { courseId, name, description, format, startDate, endDate, rounds, maxPlayers, entryFee, currency, isPublic, allowSpectators, registrationDeadline, selfPosting, allowSelfScoring, markerValidation, tiebreakerMethod, leaderboardType, eventType } = req.body;

  if (!name || !format) {
    res.status(400).json({ error: "name and format are required" });
    return;
  }

  // Task #1188 — inherit the org-wide manual-entry alert default at
  // creation time so clubs that have muted the alert org-wide don't have
  // to flip the per-tournament toggle on every new event.
  //
  // Fail-closed on the lookup: if the org row can't be loaded we surface
  // the error rather than silently defaulting to `true`, so a club that
  // has muted the alert org-wide never accidentally gets a noisy new
  // tournament because of a transient DB hiccup. `requireOrgAdmin` above
  // already verified the org exists so the missing-row case is genuinely
  // unexpected.
  // Task #1673 — seed every registered org-wide notification default
  // onto the new tournament. Adding a new key to the registry
  // automatically pulls it through here without needing to touch
  // this route.
  const [orgRow] = await db
    .select({
      notifyManualEntryAlerts: organizationsTable.notifyManualEntryAlerts,
      notifyScheduleChanges: organizationsTable.notifyScheduleChanges,
      notifyScoreCorrections: organizationsTable.notifyScoreCorrections,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  if (!orgRow) {
    res.status(404).json({ error: "Organization not found" });
    return;
  }
  const orgNotifyManualEntryDefault = orgRow.notifyManualEntryAlerts;
  const orgNotifyScheduleChangesDefault = orgRow.notifyScheduleChanges;
  const orgNotifyScoreCorrectionsDefault = orgRow.notifyScoreCorrections;

  const [tournament] = await db
    .insert(tournamentsTable)
    .values({
      organizationId: orgId,
      courseId: courseId ?? null,
      name,
      description,
      format,
      status: "draft",
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      rounds: rounds ?? 1,
      maxPlayers: maxPlayers ?? null,
      entryFee: entryFee ? String(entryFee) : null,
      currency: currency ?? "INR",
      isPublic: isPublic ?? false,
      allowSpectators: allowSpectators ?? true,
      registrationDeadline: registrationDeadline ? new Date(registrationDeadline) : null,
      selfPosting: selfPosting ?? false,
      allowSelfScoring: allowSelfScoring ?? false,
      markerValidation: markerValidation ?? false,
      tiebreakerMethod: tiebreakerMethod ?? "countback",
      leaderboardType: leaderboardType ?? "both",
      eventType: eventType ?? "standard",
      notifyManualEntryAlerts: orgNotifyManualEntryDefault,
      notifyScheduleChanges: orgNotifyScheduleChangesDefault,
      notifyScoreCorrections: orgNotifyScoreCorrectionsDefault,
    })
    .returning();

  res.status(201).json({ ...tournament, playerCount: 0, courseName: null });
});

// GET /organizations/:orgId/tournaments/:tournamentId
router.get("/:tournamentId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const [tournament] = await db
    .select({
      id: tournamentsTable.id,
      organizationId: tournamentsTable.organizationId,
      courseId: tournamentsTable.courseId,
      name: tournamentsTable.name,
      description: tournamentsTable.description,
      format: tournamentsTable.format,
      status: tournamentsTable.status,
      startDate: tournamentsTable.startDate,
      endDate: tournamentsTable.endDate,
      rounds: tournamentsTable.rounds,
      maxPlayers: tournamentsTable.maxPlayers,
      entryFee: tournamentsTable.entryFee,
      currency: tournamentsTable.currency,
      isPublic: tournamentsTable.isPublic,
      allowSpectators: tournamentsTable.allowSpectators,
      registrationDeadline: tournamentsTable.registrationDeadline,
      selfPosting: tournamentsTable.selfPosting,
      allowSelfScoring: tournamentsTable.allowSelfScoring,
      markerValidation: tournamentsTable.markerValidation,
      checkInCutoffAt: tournamentsTable.checkInCutoffAt,
      cutLine: tournamentsTable.cutLine,
      cutAfterRound: tournamentsTable.cutAfterRound,
      cutPosition: tournamentsTable.cutPosition,
      maxScoreCap: tournamentsTable.maxScoreCap,
      stablefordPointsConfig: tournamentsTable.stablefordPointsConfig,
      handicapAllowance: tournamentsTable.handicapAllowance,
      reminderDaysBefore: tournamentsTable.reminderDaysBefore,
      autoWelcome: tournamentsTable.autoWelcome,
      autoReminder: tournamentsTable.autoReminder,
      autoResults: tournamentsTable.autoResults,
      autoPostWhs: tournamentsTable.autoPostWhs,
      notifyManualEntryAlerts: tournamentsTable.notifyManualEntryAlerts,
      tiebreakerMethod: tournamentsTable.tiebreakerMethod,
      leaderboardType: tournamentsTable.leaderboardType,
      localRules: tournamentsTable.localRules,
      courseConditions: tournamentsTable.courseConditions,
      eventType: tournamentsTable.eventType,
      oddsWidgetsEnabled: tournamentsTable.oddsWidgetsEnabled,
      predictionsEnabled: tournamentsTable.predictionsEnabled,
      createdAt: tournamentsTable.createdAt,
      courseName: coursesTable.name,
    })
    .from(tournamentsTable)
    .leftJoin(coursesTable, eq(coursesTable.id, tournamentsTable.courseId))
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`);

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const [pc] = await db.select({ count: count() }).from(playersTable).where(eq(playersTable.tournamentId, tournamentId));

  let courseDetail = null;
  if (tournament.courseId) {
    const holes = await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournament.courseId)).orderBy(holeDetailsTable.holeNumber);
    courseDetail = { holeDetails: holes };
  }

  const flights = await db.select().from(flightsTable).where(eq(flightsTable.tournamentId, tournamentId)).orderBy(flightsTable.createdAt);

  res.json({ ...tournament, playerCount: Number(pc?.count ?? 0), course: courseDetail, flights });
});

// PUT /organizations/:orgId/tournaments/:tournamentId
router.put("/:tournamentId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;
  const { courseId, name, description, format, startDate, endDate, rounds, maxPlayers, entryFee, currency, isPublic, allowSpectators, registrationDeadline, selfPosting, allowSelfScoring, markerValidation, checkInCutoffAt, cutLine, cutAfterRound, cutPosition, maxScoreCap, stablefordPointsConfig, handicapAllowance, status, reminderDaysBefore, autoPostWhs, tiebreakerMethod, leaderboardType, localRules, courseConditions, scoringCloseTime, correctionWindowHours, oddsWidgetsEnabled, predictionsEnabled } = req.body;

  // Snapshot current status + automation flags to detect results-published transition
  const [current] = await db.select({ status: tournamentsTable.status, name: tournamentsTable.name, autoResults: tournamentsTable.autoResults, autoPostWhs: tournamentsTable.autoPostWhs, rounds: tournamentsTable.rounds, notifyPairings: tournamentsTable.notifyPairings })
    .from(tournamentsTable)
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`);

  const [tournament] = await db
    .update(tournamentsTable)
    .set({
      courseId: courseId ?? null,
      name,
      description,
      format,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      rounds,
      maxPlayers,
      entryFee: entryFee ? String(entryFee) : null,
      currency: currency ?? "INR",
      isPublic,
      allowSpectators,
      registrationDeadline: registrationDeadline ? new Date(registrationDeadline) : null,
      selfPosting: selfPosting ?? false,
      ...(typeof allowSelfScoring === "boolean" ? { allowSelfScoring } : {}),
      markerValidation: markerValidation ?? false,
      checkInCutoffAt: checkInCutoffAt ? new Date(checkInCutoffAt) : null,
      cutLine: cutLine !== undefined ? (cutLine === null || cutLine === '' ? null : parseInt(cutLine)) : undefined,
      ...(cutAfterRound !== undefined ? { cutAfterRound: cutAfterRound === null || cutAfterRound === '' ? null : parseInt(cutAfterRound) } : {}),
      ...(cutPosition !== undefined ? { cutPosition: cutPosition || null } : {}),
      ...(maxScoreCap !== undefined ? { maxScoreCap: maxScoreCap === null || maxScoreCap === '' ? null : parseInt(maxScoreCap) } : {}),
      ...(stablefordPointsConfig !== undefined ? { stablefordPointsConfig: stablefordPointsConfig || null } : {}),
      handicapAllowance: handicapAllowance !== undefined ? parseInt(handicapAllowance) : undefined,
      reminderDaysBefore: reminderDaysBefore !== undefined ? (reminderDaysBefore === null || reminderDaysBefore === '' ? null : parseInt(reminderDaysBefore)) : undefined,
      ...(status ? { status } : {}),
      ...(typeof autoPostWhs === "boolean" ? { autoPostWhs } : {}),
      ...(tiebreakerMethod ? { tiebreakerMethod } : {}),
      ...(leaderboardType ? { leaderboardType } : {}),
      ...(localRules !== undefined ? { localRules: localRules || null } : {}),
      ...(courseConditions !== undefined ? { courseConditions: courseConditions || null } : {}),
      ...(scoringCloseTime !== undefined ? { scoringCloseTime: scoringCloseTime || null } : {}),
      ...(correctionWindowHours !== undefined ? { correctionWindowHours: Math.max(1, Math.min(168, parseInt(correctionWindowHours) || 24)) } : {}),
      ...(typeof oddsWidgetsEnabled === "boolean" ? { oddsWidgetsEnabled } : {}),
      ...(typeof predictionsEnabled === "boolean" ? { predictionsEnabled } : {}),
      updatedAt: new Date(),
    })
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`)
    .returning();

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  // If the update included a status change into active/upcoming, check plan limits
  if (status && (status === "active" || status === "upcoming") && current?.status !== status) {
    const limitBlock = await checkActiveTournamentLimitForTransition(orgId, status);
    if (limitBlock) {
      res.status(limitBlock.status).json(limitBlock.body);
      return;
    }
  }

  // Results notification — fire when status transitions to "completed"
  if (status === "completed" && current?.status !== "completed") {
    setImmediate(async () => {
      try {
        const players = await db
          .select({ id: playersTable.id, userId: playersTable.userId, email: playersTable.email, firstName: playersTable.firstName, lastName: playersTable.lastName })
          .from(playersTable)
          .where(eq(playersTable.tournamentId, tournamentId));

        const userIds = players.map(p => p.userId).filter((id): id is number => typeof id === "number" && id > 0);

        const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
          .from(organizationsTable).where(eq(organizationsTable.id, orgId));
        const orgName = org?.name ?? "KHARAGOLF";
        const branding = { orgName, logoUrl: org?.logoUrl ?? undefined, primaryColor: org?.primaryColor ?? undefined };

        const leaderboard = await computeLeaderboard(tournamentId);
        const top10 = (leaderboard?.entries ?? []).slice(0, 10).map(e => ({
          position: e.position,
          positionDisplay: e.positionDisplay,
          playerName: e.playerName,
          grossScore: e.grossScore,
          netScore: e.netScore,
          scoreToPar: e.scoreToPar,
          netToPar: e.netToPar,
          stablefordPoints: e.stablefordPoints,
          score: e.scoreToPar !== null
            ? (e.scoreToPar > 0 ? `+${e.scoreToPar}` : e.scoreToPar === 0 ? 'E' : String(e.scoreToPar))
            : String(e.grossScore ?? '-'),
        }));

        const prizeRows = await db
          .select({ categoryName: prizeCategoriesTable.name, playerName: prizeAwardsTable.playerName, awardAmount: prizeAwardsTable.awardAmount, awardCurrency: prizeAwardsTable.awardCurrency })
          .from(prizeAwardsTable)
          .innerJoin(prizeCategoriesTable, eq(prizeAwardsTable.prizeCategoryId, prizeCategoriesTable.id))
          .where(eq(prizeAwardsTable.tournamentId, tournamentId));

        const prizeWinners = prizeRows.map(r => ({
          category: r.categoryName,
          playerName: r.playerName,
          awardAmount: r.awardAmount,
          currency: r.awardCurrency ?? undefined,
        }));

        const leaderboardUrl = `${process.env.PUBLIC_BASE_URL ?? "https://kharagolf.com"}/leaderboard/${tournamentId}`;
        const winnerName = top10[0]?.playerName ?? "Unknown";

        if (userIds.length > 0) {
          // Task #1240 — fire-and-forget (`.catch(() => undefined)`); no
          // delivery telemetry consumed downstream, classifier
          // intentionally not used. The recap email loop below + the
          // public leaderboard URL are the durable signals.
          sendTransactionalPush(
            userIds,
            "🏆 Results Published",
            `${winnerName} wins ${tournament.name}! See the final leaderboard.`,
            { type: "results_published", tournamentId },
          ).catch(() => undefined);
        }

        for (const p of players.filter(x => x.email)) {
          const personalEntry = leaderboard?.entries.find(e => e.playerId === p.id);
          sendTournamentRecapEmail({
            to: p.email!,
            name: `${p.firstName} ${p.lastName}`,
            tournamentName: tournament.name,
            orgName,
            branding,
            top10,
            prizeWinners,
            personalResult: personalEntry
              ? {
                  position: personalEntry.position,
                  positionDisplay: personalEntry.positionDisplay,
                  grossScore: personalEntry.grossScore,
                  netScore: personalEntry.netScore,
                  scoreToPar: personalEntry.scoreToPar,
                  netToPar: personalEntry.netToPar,
                  stablefordPoints: personalEntry.stablefordPoints,
                }
              : null,
            leaderboardUrl,
          }).catch(() => undefined);
        }
      } catch { /* Silently ignore notification errors */ }
    });
  }

  // WHS auto-post: fire when status transitions to "completed" AND autoPostWhs is enabled.
  // Use effective value: body may be enabling autoPostWhs in the same update that marks completed.
  const effectiveAutoPostWhs = typeof req.body.autoPostWhs === "boolean" ? req.body.autoPostWhs : (current?.autoPostWhs ?? false);
  if (status === "completed" && current?.status !== "completed" && effectiveAutoPostWhs) {
    // Use post-update tournament.rounds so changes to round count in the same PUT are respected
    const roundCount = tournament.rounds ?? current?.rounds ?? 1;
    setImmediate(() => {
      autoPostWhsForTournament(orgId, tournamentId, roundCount).catch(() => undefined);
    });
  }

  // Auto-score predictions when tournament transitions to "completed" (Task #452)
  // and immediately email each fan their final score + rank (Task #501).
  // Email dispatch is idempotent via tournament_predictions.results_email_sent_at,
  // so re-completing the tournament will not produce duplicate emails.
  if (status === "completed" && current?.status !== "completed") {
    setImmediate(async () => {
      try {
        await scorePredictionsForTournament(tournamentId);
      } catch (err) {
        logger.error({ err, tournamentId }, "[predictions] Auto-score failed on completion");
        return;
      }
      try {
        await sendPredictionResultsEmails(tournamentId);
      } catch (err) {
        logger.error({ err, tournamentId }, "[predictions] Results email dispatch failed on completion");
      }
    });
  }

  // Auto-feed cross-club ladders when tournament transitions to "completed" (Task #462)
  if (status === "completed" && current?.status !== "completed") {
    setImmediate(() => {
      creditTournamentResultsToLadders(tournamentId).catch((err) => {
        logger.error({ err, tournamentId }, "[ladder-feed] tournament credit failed");
      });
    });
  }

  // Survey auto-send: fire when status transitions to "completed" and an active survey is configured
  if (status === "completed" && current?.status !== "completed") {
    setImmediate(async () => {
      try {
        const [survey] = await db.select()
          .from(eventSurveyFormsTable)
          .where(and(
            eq(eventSurveyFormsTable.eventId, tournamentId),
            eq(eventSurveyFormsTable.eventType, "tournament"),
            eq(eventSurveyFormsTable.isActive, true),
          ));
        if (survey && !survey.sentAt) {
          const [org] = await db.select({ name: organizationsTable.name })
            .from(organizationsTable).where(eq(organizationsTable.id, orgId));
          const orgName = org?.name ?? "KHARAGOLF";
          const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "https://kharagolf.com";
          const delayMs = (survey.sendDelayHours ?? 0) * 60 * 60 * 1000;
          if (delayMs > 0) {
            setTimeout(async () => {
              await sendSurveyEmails(survey.id, tournamentId, "tournament", orgName, publicBaseUrl).catch(() => undefined);
              await db.update(eventSurveyFormsTable)
                .set({ sentAt: new Date(), updatedAt: new Date() })
                .where(eq(eventSurveyFormsTable.id, survey.id));
            }, delayMs);
          } else {
            await sendSurveyEmails(survey.id, tournamentId, "tournament", orgName, publicBaseUrl).catch(() => undefined);
            await db.update(eventSurveyFormsTable)
              .set({ sentAt: new Date(), updatedAt: new Date() })
              .where(eq(eventSurveyFormsTable.id, survey.id));
          }
        }
      } catch { /* Silently ignore survey send errors */ }
    });
    dispatchWebhookEvent(orgId, "tournament.completed", {
      tournamentId,
      name: tournament.name,
      format: tournament.format,
      completedAt: new Date().toISOString(),
    });
  }

  res.json({ ...tournament, playerCount: 0, courseName: null });
});

// PATCH /organizations/:orgId/tournaments/:tournamentId/automation
// Admin-only: configure automated messaging triggers per tournament
router.patch("/:tournamentId/automation", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;
  const { autoWelcome, autoReminder, autoResults, autoPostWhs, notifyPairings, notifyManualEntryAlerts } = req.body;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof autoWelcome === "boolean") updates.autoWelcome = autoWelcome;
  if (typeof autoReminder === "boolean") updates.autoReminder = autoReminder;
  if (typeof autoResults === "boolean") updates.autoResults = autoResults;
  if (typeof autoPostWhs === "boolean") updates.autoPostWhs = autoPostWhs;
  if (typeof notifyPairings === "boolean") updates.notifyPairings = notifyPairings;
  if (typeof notifyManualEntryAlerts === "boolean") updates.notifyManualEntryAlerts = notifyManualEntryAlerts;

  const [updated] = await db
    .update(tournamentsTable)
    .set(updates)
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`)
    .returning({ id: tournamentsTable.id, autoWelcome: tournamentsTable.autoWelcome, autoReminder: tournamentsTable.autoReminder, autoResults: tournamentsTable.autoResults, autoPostWhs: tournamentsTable.autoPostWhs, notifyPairings: tournamentsTable.notifyPairings, notifyManualEntryAlerts: tournamentsTable.notifyManualEntryAlerts });

  if (!updated) { { res.status(404).json({ error: "Tournament not found" }); return; } }
  res.json(updated);
});

// Task #1674 — Latest unacknowledged "club admin overrode this
// tournament's notification setting" notice for the requesting user.
// The tournament-detail page calls this on load and renders a one-line
// banner with a "restore my preference" button when a row is present.
//
// The notice is suppressed for the user who actually performed the
// bulk-apply (they don't need to be warned about their own action).
// Anyone else with tournament access — org_admin, tournament_director,
// or tournament_admin staff — will see it the next time they open
// settings, and anyone of them can press "restore my preference" to
// undo the override. We deliberately don't role-gate restore beyond
// the existing tournament-access check: any of those roles can already
// flip the per-tournament toggle directly via PATCH, so requiring
// director-only here would be inconsistent.
router.get("/:tournamentId/manual-entry-override-notice", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const currentUserId = req.user!.id;
  const [row] = await db
    .select({
      id: tournamentNotificationOverrideAuditTable.id,
      previousValue: tournamentNotificationOverrideAuditTable.previousValue,
      appliedValue: tournamentNotificationOverrideAuditTable.appliedValue,
      appliedAt: tournamentNotificationOverrideAuditTable.createdAt,
      appliedByUserId: tournamentNotificationOverrideAuditTable.appliedByUserId,
      appliedByDisplayName: appUsersTable.displayName,
      appliedByUsername: appUsersTable.username,
    })
    .from(tournamentNotificationOverrideAuditTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, tournamentNotificationOverrideAuditTable.appliedByUserId))
    .where(and(
      eq(tournamentNotificationOverrideAuditTable.tournamentId, tournamentId),
      eq(tournamentNotificationOverrideAuditTable.setting, "notify_manual_entry_alerts"),
      sql`${tournamentNotificationOverrideAuditTable.acknowledgedAt} IS NULL`,
      // Don't warn the admin who pressed the button about their own action.
      sql`(${tournamentNotificationOverrideAuditTable.appliedByUserId} IS NULL OR ${tournamentNotificationOverrideAuditTable.appliedByUserId} <> ${currentUserId})`,
    ))
    .orderBy(desc(tournamentNotificationOverrideAuditTable.createdAt))
    .limit(1);

  if (!row) { { res.json({ notice: null }); return; } }
  res.json({
    notice: {
      id: row.id,
      setting: "notifyManualEntryAlerts",
      previousValue: row.previousValue,
      appliedValue: row.appliedValue,
      appliedAt: row.appliedAt,
      appliedByName: row.appliedByDisplayName ?? row.appliedByUsername ?? null,
    },
  });
});

// Task #1674 — One-click "restore my preference" action for the notice
// above. Flips the tournament's stored value back to whatever it was
// immediately before the bulk-apply, and acknowledges every open
// override row for this tournament + setting so the banner disappears
// (and a second click is a no-op). The actual restored value comes
// from the *earliest* still-open audit row so a chain of two
// back-to-back bulk-applies (A then B) restores to the value the
// director had before A, not the no-op intermediate value B left
// behind.
router.post("/:tournamentId/manual-entry-override-notice/restore", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const result = await db.transaction(async (tx) => {
    const openRows = await tx
      .select({ id: tournamentNotificationOverrideAuditTable.id, previousValue: tournamentNotificationOverrideAuditTable.previousValue })
      .from(tournamentNotificationOverrideAuditTable)
      .where(and(
        eq(tournamentNotificationOverrideAuditTable.tournamentId, tournamentId),
        eq(tournamentNotificationOverrideAuditTable.setting, "notify_manual_entry_alerts"),
        sql`${tournamentNotificationOverrideAuditTable.acknowledgedAt} IS NULL`,
      ))
      .orderBy(asc(tournamentNotificationOverrideAuditTable.createdAt));

    if (openRows.length === 0) return { restored: false, notifyManualEntryAlerts: null as boolean | null };

    const restoreTo = openRows[0].previousValue;
    const now = new Date();

    await tx
      .update(tournamentsTable)
      .set({ notifyManualEntryAlerts: restoreTo, updatedAt: now })
      .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));

    await tx
      .update(tournamentNotificationOverrideAuditTable)
      .set({ acknowledgedAt: now, restoredAt: now })
      .where(inArray(tournamentNotificationOverrideAuditTable.id, openRows.map(r => r.id)));

    return { restored: true, notifyManualEntryAlerts: restoreTo };
  });

  res.json(result);
});

// Task #2089 — One-click "dismiss without restoring" action for the
// override notice. Acknowledges every open audit row for this
// tournament + setting WITHOUT changing the tournament's stored
// value, so a director who actually agrees with the new value can
// silence the banner. `restoredAt` is left null so audit reports can
// still distinguish dismissed-vs-restored rows.
router.post("/:tournamentId/manual-entry-override-notice/dismiss", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const result = await db.transaction(async (tx) => {
    const openRows = await tx
      .select({ id: tournamentNotificationOverrideAuditTable.id })
      .from(tournamentNotificationOverrideAuditTable)
      .where(and(
        eq(tournamentNotificationOverrideAuditTable.tournamentId, tournamentId),
        eq(tournamentNotificationOverrideAuditTable.setting, "notify_manual_entry_alerts"),
        sql`${tournamentNotificationOverrideAuditTable.acknowledgedAt} IS NULL`,
      ));

    if (openRows.length === 0) return { dismissed: false };

    await tx
      .update(tournamentNotificationOverrideAuditTable)
      .set({ acknowledgedAt: new Date() })
      .where(inArray(tournamentNotificationOverrideAuditTable.id, openRows.map(r => r.id)));

    return { dismissed: true };
  });

  res.json(result);
});

// DELETE /organizations/:orgId/tournaments/:tournamentId
router.delete("/:tournamentId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  await db
    .delete(tournamentsTable)
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`);
  res.status(204).send();
});

// POST /organizations/:orgId/tournaments/:tournamentId/publish
router.post("/:tournamentId/publish", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const [tournament] = await db
    .update(tournamentsTable)
    .set({ status: "upcoming", updatedAt: new Date() })
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`)
    .returning();

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }
  const [pc] = await db.select({ count: count() }).from(playersTable).where(eq(playersTable.tournamentId, tournamentId));

  // Push: notify enrolled players that the tournament has been published
  const players = await db
    .select({ userId: playersTable.userId })
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tournamentId));
  const userIds = players.map(p => p.userId).filter((id): id is number => typeof id === "number" && id > 0);
  // Task #1240 — fire-and-forget (`.catch(() => undefined)`); no delivery
  // telemetry consumed downstream, classifier intentionally not used.
  sendTransactionalPush(
    userIds,
    "Tournament Published",
    `${tournament.name} is now live. Check the leaderboard and your tee time.`,
    { type: "tournament_published", tournamentId },
  ).catch(() => undefined);

  dispatchWebhookEvent(orgId, "tournament.published", {
    tournamentId,
    name: tournament.name,
    format: tournament.format,
    startDate: tournament.startDate?.toISOString(),
    playerCount: Number(pc?.count ?? 0),
  });

  res.json({ ...tournament, playerCount: Number(pc?.count ?? 0), courseName: null });
});

// GET /organizations/:orgId/tournaments/:tournamentId/scores?round=N
// Returns per-player hole-by-hole scores for a specific round (or round 1 by default)
router.get("/:tournamentId/scores", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const round = parseInt((req.query.round as string) || "1") || 1;

  const [tournament] = await db
    .select({ id: tournamentsTable.id, rounds: tournamentsTable.rounds })
    .from(tournamentsTable)
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`);
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const players = await db
    .select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName, handicapIndex: playersTable.handicapIndex, handicapOverride: playersTable.handicapOverride })
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tournamentId));

  const roundScores = await db
    .select()
    .from(scoresTable)
    .where(sql`${scoresTable.tournamentId} = ${tournamentId} AND ${scoresTable.round} = ${round}`);

  const scoreMap = new Map<string, number>();
  for (const s of roundScores) scoreMap.set(`${s.playerId}-${s.holeNumber}`, s.strokes);

  const result = players.map(p => ({
    playerId: p.id,
    playerName: `${p.firstName} ${p.lastName}`,
    handicapIndex: Number(p.handicapOverride ?? p.handicapIndex ?? 0),
    holeScores: roundScores
      .filter(s => s.playerId === p.id)
      .map(s => ({ hole: s.holeNumber, strokes: s.strokes, round: s.round })),
  }));

  res.json({ round, totalRounds: tournament.rounds ?? 1, players: result });
});

// GET /organizations/:orgId/tournaments/:tournamentId/export/scores.csv
// Authenticated: download full tournament scores as CSV
router.get("/:tournamentId/export/scores.csv", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const [tournament] = await db
    .select({ name: tournamentsTable.name })
    .from(tournamentsTable)
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`);
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const players = await db.select().from(playersTable).where(eq(playersTable.tournamentId, tournamentId)).orderBy(playersTable.lastName, playersTable.firstName);
  const scores = await db.select().from(scoresTable).where(eq(scoresTable.tournamentId, tournamentId)).orderBy(scoresTable.playerId, scoresTable.round, scoresTable.holeNumber);

  const scoreMap = new Map<string, number>();
  for (const s of scores) scoreMap.set(`${s.playerId}-${s.round}-${s.holeNumber}`, s.strokes);

  const maxRound = scores.length > 0 ? Math.max(...scores.map(s => s.round)) : 1;
  const holes = Array.from({ length: 18 }, (_, i) => i + 1);

  const header = ["Player Name", "Handicap", ...Array.from({ length: maxRound }, (_, r) =>
    holes.map(h => `R${r + 1} H${h}`)
  ).flat(), "Total"];

  const rows = players.map(p => {
    const holeCells = Array.from({ length: maxRound }, (_, r) =>
      holes.map(h => scoreMap.get(`${p.id}-${r + 1}-${h}`) ?? "")
    ).flat();
    const total = scores.filter(s => s.playerId === p.id).reduce((acc, s) => acc + s.strokes, 0);
    return [`${p.firstName} ${p.lastName}`, p.handicapIndex ?? "", ...holeCells, total || ""];
  });

  const csv = [header, ...rows].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const safeName = tournament.name.replace(/[^a-z0-9]/gi, "_");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}_scores.csv"`);
  res.send(csv);
});

// GET /organizations/:orgId/tournaments/:tournamentId/scorecards
// Returns complete per-player, per-hole scorecard data (for printable scorecard page)
router.get("/:tournamentId/scorecards", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const [tournament] = await db
    .select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      format: tournamentsTable.format,
      courseId: tournamentsTable.courseId,
      rounds: tournamentsTable.rounds,
      handicapAllowance: tournamentsTable.handicapAllowance,
      organizationId: tournamentsTable.organizationId,
    })
    .from(tournamentsTable)
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`);

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  // Course info
  let courseName: string | null = null;
  let coursePar = 72;
  let courseSlope: number | null = null;
  let courseRating: number | null = null;
  if (tournament.courseId) {
    const [c] = await db
      .select({ name: coursesTable.name, par: coursesTable.par, slope: coursesTable.slope, rating: coursesTable.rating })
      .from(coursesTable)
      .where(eq(coursesTable.id, tournament.courseId));
    if (c) {
      courseName = c.name;
      coursePar = c.par;
      courseSlope = c.slope ?? null;
      courseRating = c.rating ? Number(c.rating) : null;
    }
  }

  // Hole details (par + stroke index per hole)
  const holeDetails = tournament.courseId
    ? await db
        .select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par, handicap: holeDetailsTable.handicap })
        .from(holeDetailsTable)
        .where(eq(holeDetailsTable.courseId, tournament.courseId!))
        .orderBy(holeDetailsTable.holeNumber)
    : [];

  const holeParMap = new Map<number, number>();
  const holeSIMap = new Map<number, number | null>();
  for (const h of holeDetails) {
    holeParMap.set(h.holeNumber, h.par);
    holeSIMap.set(h.holeNumber, h.handicap ?? null);
  }
  const holeCount = holeDetails.length > 0 ? Math.max(...holeDetails.map(h => h.holeNumber)) : 18;

  // Players
  const players = await db
    .select({
      id: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      flight: playersTable.flight,
      teeBox: playersTable.teeBox,
      handicapIndex: playersTable.handicapIndex,
      handicapOverride: playersTable.handicapOverride,
      checkedIn: playersTable.checkedIn,
    })
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tournamentId))
    .orderBy(playersTable.lastName, playersTable.firstName);

  // All scores for this tournament
  const allScores = await db
    .select()
    .from(scoresTable)
    .where(eq(scoresTable.tournamentId, tournamentId))
    .orderBy(scoresTable.playerId, scoresTable.round, scoresTable.holeNumber);

  const handicapAllowance = tournament.handicapAllowance ?? 100;

  const scorecards = players.map((player) => {
    const rawHI = Number(player.handicapOverride ?? player.handicapIndex ?? 0);
    const playingHandicap = computePlayingHandicap(rawHI, courseSlope, courseRating, coursePar, handicapAllowance);

    const playerScores = allScores.filter(s => s.playerId === player.id);

    // Aggregate multi-round hole scores (take minimum round or last submitted per hole per round, sum across rounds)
    // For a single scorecard, use round 1 gross scores; for multi-round show totals
    const holeScoreMap = new Map<number, { strokes: number; round: number; isVerified: boolean }>();
    for (const s of playerScores) {
      const existing = holeScoreMap.get(s.holeNumber);
      // If same hole appears across rounds, sum strokes (multi-round aggregate)
      if (!existing || s.round > existing.round) {
        holeScoreMap.set(s.holeNumber, { strokes: s.strokes, round: s.round, isVerified: s.isVerified });
      }
    }

    // Build per-hole scorecard
    const holes = Array.from({ length: holeCount }, (_, i) => i + 1);
    const holeScores = holes.map((h) => {
      const par = holeParMap.get(h) ?? 4;
      const si = holeSIMap.get(h) ?? null;
      const scored = holeScoreMap.get(h);
      const strokes = scored?.strokes ?? null;
      const toPar = strokes !== null ? strokes - par : null;
      const stableford = strokes !== null ? stablefordPointsForHole(strokes, par, si, playingHandicap) : null;
      return {
        hole: h,
        par,
        handicap: si,
        strokes,
        toPar,
        stablefordPoints: stableford,
        isVerified: scored?.isVerified ?? false,
      };
    });

    const front9 = holeScores.filter(h => h.hole <= 9);
    const back9 = holeScores.filter(h => h.hole >= 10);

    const outScore = front9.reduce((a, h) => a + (h.strokes ?? 0), 0);
    const inScore = back9.reduce((a, h) => a + (h.strokes ?? 0), 0);
    const outPar = front9.reduce((a, h) => a + h.par, 0);
    const inPar = back9.reduce((a, h) => a + h.par, 0);

    const grossScore = playerScores.length > 0 ? playerScores.reduce((a, s) => a + s.strokes, 0) : null;
    const netScore = grossScore !== null ? grossScore - playingHandicap : null;
    const totalStableford = holeScores.some(h => h.stablefordPoints !== null)
      ? holeScores.reduce((a, h) => a + (h.stablefordPoints ?? 0), 0)
      : null;

    return {
      playerId: player.id,
      playerName: `${player.firstName} ${player.lastName}`,
      flight: player.flight,
      teeBox: player.teeBox,
      handicapIndex: rawHI,
      playingHandicap,
      checkedIn: player.checkedIn,
      grossScore,
      netScore,
      stablefordPoints: totalStableford,
      outScore,
      inScore,
      outPar,
      inPar,
      holeScores,
    };
  });

  const [org] = await db
    .select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, tournament.organizationId));

  // Sponsors visible on scorecards: active org-wide sponsors + tournament-specific sponsors
  const sponsors = await db
    .select({
      id: sponsorsTable.id,
      name: sponsorsTable.name,
      logoUrl: sponsorsTable.logoUrl,
      tier: sponsorsTable.tier,
      websiteUrl: sponsorsTable.websiteUrl,
      displayOrder: sponsorsTable.displayOrder,
    })
    .from(sponsorsTable)
    .where(
      sql`${sponsorsTable.organizationId} = ${tournament.organizationId}
        AND ${sponsorsTable.isActive} = true
        AND (${sponsorsTable.tournamentId} IS NULL OR ${sponsorsTable.tournamentId} = ${tournamentId})`,
    )
    .orderBy(sponsorsTable.displayOrder, sponsorsTable.id);

  res.json({
    tournamentName: tournament.name,
    format: tournament.format,
    courseName,
    coursePar,
    holeCount,
    scorecards,
    organizationName: org?.name ?? null,
    organizationLogoUrl: org?.logoUrl ?? null,
    organizationPrimaryColor: org?.primaryColor ?? null,
    sponsors,
  });
});

// GET /organizations/:orgId/tournaments/:tournamentId/pocket-scorecards/pdf
router.get("/:tournamentId/pocket-scorecards/pdf", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;
  const roundFilter = parseInt(req.query.round as string) || 1;
  const flightFilter = req.query.flight as string | undefined;

  const [tournament] = await db
    .select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      format: tournamentsTable.format,
      courseId: tournamentsTable.courseId,
      rounds: tournamentsTable.rounds,
      handicapAllowance: tournamentsTable.handicapAllowance,
      organizationId: tournamentsTable.organizationId,
      startDate: tournamentsTable.startDate,
      localRules: tournamentsTable.localRules,
      courseConditions: tournamentsTable.courseConditions,
    })
    .from(tournamentsTable)
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`);

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const [org] = await db
    .select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor, website: organizationsTable.website })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, tournament.organizationId));

  // Resolve course for this specific round (multi-course championship support)
  // Check tournament_rounds for a round-specific course assignment; fall back to tournament.courseId
  let resolvedCourseId: number | null = tournament.courseId ?? null;
  const [roundRow] = await db
    .select({ courseId: tournamentRoundsTable.courseId })
    .from(tournamentRoundsTable)
    .where(and(eq(tournamentRoundsTable.tournamentId, tournamentId), eq(tournamentRoundsTable.roundNumber, roundFilter)));
  if (roundRow?.courseId) resolvedCourseId = roundRow.courseId;

  let courseName: string | null = null;
  let coursePar = 72;
  let courseSlope: number | null = null;
  let courseRating: number | null = null;
  if (resolvedCourseId) {
    const [c] = await db
      .select({ name: coursesTable.name, par: coursesTable.par, slope: coursesTable.slope, rating: coursesTable.rating })
      .from(coursesTable)
      .where(eq(coursesTable.id, resolvedCourseId));
    if (c) { courseName = c.name; coursePar = c.par; courseSlope = c.slope ?? null; courseRating = c.rating ? Number(c.rating) : null; }
  }

  const holeDetails = resolvedCourseId
    ? await db.select().from(holeDetailsTable).where(eq(holeDetailsTable.courseId, resolvedCourseId)).orderBy(holeDetailsTable.holeNumber)
    : [];

  const teeTimes = await db.select().from(teeTimesTable)
    .where(sql`${teeTimesTable.tournamentId} = ${tournamentId} AND ${teeTimesTable.round} = ${roundFilter}`)
    .orderBy(teeTimesTable.teeTime);

  if (teeTimes.length === 0) {
    res.status(400).json({ error: "No tee times found for this round. Generate the draw first." });
    return;
  }

  const sponsors = await db
    .select({ id: sponsorsTable.id, name: sponsorsTable.name, tier: sponsorsTable.tier, logoUrl: sponsorsTable.logoUrl, websiteUrl: sponsorsTable.websiteUrl })
    .from(sponsorsTable)
    .where(sql`${sponsorsTable.organizationId} = ${orgId} AND ${sponsorsTable.isActive} = true AND (${sponsorsTable.tournamentId} IS NULL OR ${sponsorsTable.tournamentId} = ${tournamentId})`)
    .orderBy(sponsorsTable.displayOrder, sponsorsTable.id);

  const holeSponsorsRaw = await db
    .select({ holeNumber: holeSponsorsTable.holeNumber, sponsorName: sponsorsTable.name })
    .from(holeSponsorsTable)
    .innerJoin(sponsorsTable, eq(sponsorsTable.id, holeSponsorsTable.sponsorId))
    .where(eq(holeSponsorsTable.tournamentId, tournamentId))
    .orderBy(holeSponsorsTable.holeNumber);

  const [sideGamesConfig] = await db.select().from(sideGamesConfigTable)
    .where(eq(sideGamesConfigTable.tournamentId, tournamentId));

  const handicapAllowance = tournament.handicapAllowance ?? 100;
  const dateStr = tournament.startDate
    ? new Date(tournament.startDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : "";

  const playerCards: PocketPlayerCard[] = [];

  for (const tt of teeTimes) {
    const ttPlayers = await db
      .select({
        playerId: teeTimePlayersTable.playerId,
        firstName: playersTable.firstName,
        lastName: playersTable.lastName,
        flight: playersTable.flight,
        teeBox: playersTable.teeBox,
        handicapIndex: playersTable.handicapIndex,
        handicapOverride: playersTable.handicapOverride,
      })
      .from(teeTimePlayersTable)
      .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
      .where(eq(teeTimePlayersTable.teeTimeId, tt.id));

    if (flightFilter && flightFilter !== "all") {
      const filteredPlayers = ttPlayers.filter(p => p.flight === flightFilter);
      if (filteredPlayers.length === 0) continue;
    }

    const playersInGroup = flightFilter && flightFilter !== "all"
      ? ttPlayers.filter(p => p.flight === flightFilter)
      : ttPlayers;

    const teeTimeStr = tt.teeTime.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

    for (const p of playersInGroup) {
      const rawHI = Number(p.handicapOverride ?? p.handicapIndex ?? 0);
      const playingHcp = computePlayingHandicap(rawHI, courseSlope, courseRating, coursePar, handicapAllowance);
      const teeBox = p.teeBox ?? "white";

      const holes = holeDetails.map(h => ({
        hole: h.holeNumber,
        yards: teeBox === "blue" ? h.yardageBlue : teeBox === "red" ? h.yardageRed : h.yardageWhite,
        par: h.par,
        strokeIndex: h.handicap ?? null,
      }));

      const partners = ttPlayers
        .filter(x => x.playerId !== p.playerId)
        .map(x => ({ name: `${x.firstName} ${x.lastName}`, handicapIndex: Number(x.handicapIndex ?? 0) }));

      playerCards.push({
        playerName: `${p.firstName} ${p.lastName}`,
        handicapIndex: rawHI,
        playingHandicap: playingHcp,
        teeBox,
        teeTime: teeTimeStr,
        startingHole: tt.startingHole,
        partners,
        holes,
      });
    }
  }

  if (playerCards.length === 0) {
    res.status(400).json({ error: "No players found for the selected filters." });
    return;
  }

  // Resolve CTP/LD sponsor names for the scorecard legend
  let ctpSponsorName: string | null = null;
  let ldSponsorName: string | null = null;
  if (sideGamesConfig?.ctpSponsorId) {
    const [s] = await db.select({ name: sponsorsTable.name }).from(sponsorsTable).where(eq(sponsorsTable.id, sideGamesConfig.ctpSponsorId));
    if (s) ctpSponsorName = s.name;
  }
  if (sideGamesConfig?.ldSponsorId) {
    const [s] = await db.select({ name: sponsorsTable.name }).from(sponsorsTable).where(eq(sponsorsTable.id, sideGamesConfig.ldSponsorId));
    if (s) ldSponsorName = s.name;
  }

  const publicBase = process.env.PUBLIC_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "");
  if (!publicBase) {
    req.log.warn({ tournamentId }, "PUBLIC_BASE_URL and REPLIT_DEV_DOMAIN are unset; QR code will have relative URL");
  }
  const qrCodeUrl = publicBase ? `${publicBase}/leaderboard/${tournamentId}` : `/leaderboard/${tournamentId}`;

  const pdfData: PocketScorecardData = {
    organization: {
      name: org?.name ?? "KHARAGOLF",
      logoUrl: org?.logoUrl ?? null,
      primaryColor: org?.primaryColor ?? "#22c55e",
      website: org?.website ?? undefined,
    },
    tournament: {
      name: tournament.name,
      courseName,
      date: dateStr,
      round: roundFilter,
      format: tournament.format,
      localRules: tournament.localRules,
      courseConditions: tournament.courseConditions,
      qrCodeUrl,
    },
    sponsors,
    holeSponsors: holeSponsorsRaw,
    sideGames: {
      ctpHoles: (sideGamesConfig?.ctpHoles as number[]) ?? [],
      ldHoles: (sideGamesConfig?.ldHoles as number[]) ?? [],
      ctpSponsorName,
      ldSponsorName,
    },
    players: playerCards,
  };

  try {
    const pdfBuffer = await generatePocketScorecardPDF(pdfData);
    const safeName = tournament.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="PocketScorecards_${safeName}_R${roundFilter}.pdf"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    logger.error({ err }, "Failed to generate pocket scorecard PDF");
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

// GET /organizations/:orgId/tournaments/:tournamentId/waitlist
router.get("/:tournamentId/waitlist", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const [tournament] = await db
    .select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`);
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const entries = await db
    .select()
    .from(waitlistTable)
    .where(and(eq(waitlistTable.tournamentId, tournamentId), sql`${waitlistTable.promotedAt} IS NULL`))
    .orderBy(waitlistTable.position);

  res.json(entries);
});

// POST /organizations/:orgId/tournaments/:tournamentId/waitlist/:waitlistId/promote
// Admin: manually promote a waitlisted player to registered
router.post("/:tournamentId/waitlist/:waitlistId/promote", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const waitlistId = parseInt(String((req.params as Record<string, string>).waitlistId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const [tournament] = await db
    .select({ id: tournamentsTable.id, name: tournamentsTable.name })
    .from(tournamentsTable)
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`);
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const [entry] = await db.select().from(waitlistTable).where(and(eq(waitlistTable.id, waitlistId), eq(waitlistTable.tournamentId, tournamentId)));
  if (!entry) { { res.status(404).json({ error: "Waitlist entry not found" }); return; } }
  if (entry.promotedAt) { { res.status(400).json({ error: "Already promoted" }); return; } }

  const [player] = await db.insert(playersTable).values({
    tournamentId,
    firstName: entry.firstName,
    lastName: entry.lastName,
    email: entry.email,
    phone: entry.phone ?? null,
    handicapIndex: entry.handicapIndex ?? null,
    flight: entry.flight ?? null,
    teeBox: entry.teeBox ?? "white",
    paymentStatus: "unpaid",
    checkedIn: false,
    currentRound: 1,
    teamName: null,
    userId: null,
  }).returning();

  await db.update(waitlistTable).set({ promotedAt: new Date() }).where(eq(waitlistTable.id, waitlistId));

  // Renumber remaining waitlist positions
  const remaining = await db
    .select()
    .from(waitlistTable)
    .where(and(eq(waitlistTable.tournamentId, tournamentId), sql`${waitlistTable.promotedAt} IS NULL`))
    .orderBy(waitlistTable.position);

  for (let i = 0; i < remaining.length; i++) {
    await db.update(waitlistTable).set({ position: i + 1 }).where(eq(waitlistTable.id, remaining[i].id));
  }

  // Notify promoted player (fire-and-forget)
  if (entry.email) {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    sendWaitlistPromotionEmail(
      entry.email,
      `${entry.firstName} ${entry.lastName}`,
      tournament.name,
      `${baseUrl}/portal`,
    ).catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ email: entry.email, eventName: tournament.name, errMsg }, "[tournaments] Failed to send waitlist promotion email");
    });
  }

  res.status(201).json({ promoted: true, player });
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/waitlist/:waitlistId
// Admin: remove a player from the waitlist
router.delete("/:tournamentId/waitlist/:waitlistId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const waitlistId = parseInt(String((req.params as Record<string, string>).waitlistId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const [tournament] = await db
    .select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`);
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const deleted = await db
    .delete(waitlistTable)
    .where(and(eq(waitlistTable.id, waitlistId), eq(waitlistTable.tournamentId, tournamentId)))
    .returning({ id: waitlistTable.id });

  if (deleted.length === 0) { { res.status(404).json({ error: "Waitlist entry not found" }); return; } }

  // Renumber remaining
  const remaining = await db
    .select()
    .from(waitlistTable)
    .where(and(eq(waitlistTable.tournamentId, tournamentId), sql`${waitlistTable.promotedAt} IS NULL`))
    .orderBy(waitlistTable.position);

  for (let i = 0; i < remaining.length; i++) {
    await db.update(waitlistTable).set({ position: i + 1 }).where(eq(waitlistTable.id, remaining[i].id));
  }

  res.json({ deleted: true });
});

// ── GET /organizations/:orgId/tournaments/:id/weather ────────────────────────
// Returns cached weather for the tournament's course location.
// Accepts optional ?lat=&lng= query params to override (e.g. from device GPS).
// Returns 422 if neither query params nor a geocodable location is available.
router.get("/:id/weather", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).id));
  if (isNaN(orgId) || isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid IDs" }); return; } }

  // Allow caller to provide explicit coords (e.g. from device GPS)
  const qLat = parseFloat(req.query.lat as string);
  const qLng = parseFloat(req.query.lng as string);
  if (!isNaN(qLat) && !isNaN(qLng)) {
    try {
      const weather = await getWeather(qLat, qLng);
      res.json(weather);
      return;
    } catch {
      res.status(502).json({ error: "Weather service unavailable" });
      return;
    }
  }

  // Verify the tournament belongs to the org
  const [tournament] = await db
    .select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  // Courses table has no lat/lng — require caller to pass ?lat=&lng=
  res.status(422).json({ error: "Provide ?lat=&lng= query parameters to fetch weather for this tournament" });
});

// ── GET /organizations/:orgId/tournaments/:id/results/pdf ─────────────────────
// Authenticated org-scoped results PDF (accessible to org admins / members).
// Unlike the public route, this works for any status so staff can preview before publishing.
router.get("/:id/results/pdf", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).id));
  if (isNaN(orgId) || isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid IDs" }); return; } }
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

  const [tournament] = await db
    .select({
      id: tournamentsTable.id,
      organizationId: tournamentsTable.organizationId,
      name: tournamentsTable.name,
      format: tournamentsTable.format,
      rounds: tournamentsTable.rounds,
      startDate: tournamentsTable.startDate,
      courseId: tournamentsTable.courseId,
    })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament || tournament.organizationId !== orgId) {
    res.status(404).json({ error: "Tournament not found" });
    return;
  }

  const [leaderboard, sideGamesManual, orgRow, orgSponsors] = await Promise.all([
    computeLeaderboard(tournamentId),
    db.select({
      gameType: sideGameResultsTable.gameType,
      holeNumber: sideGameResultsTable.holeNumber,
      prize: sideGameResultsTable.prize,
      notes: sideGameResultsTable.notes,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
    })
    .from(sideGameResultsTable)
    .leftJoin(playersTable, eq(playersTable.id, sideGameResultsTable.playerId))
    .where(eq(sideGameResultsTable.tournamentId, tournamentId)),
    db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
      .from(organizationsTable).where(eq(organizationsTable.id, orgId)).then(r => r[0] ?? null),
    db.select({ name: sponsorsTable.name, tier: sponsorsTable.tier, logoUrl: sponsorsTable.logoUrl, websiteUrl: sponsorsTable.websiteUrl })
      .from(sponsorsTable)
      .where(and(
        eq(sponsorsTable.organizationId, orgId),
        eq(sponsorsTable.isActive, true),
        or(eq(sponsorsTable.tournamentId, tournamentId), isNull(sponsorsTable.tournamentId)),
      ))
      .orderBy(asc(sponsorsTable.displayOrder)),
  ]);

  if (!leaderboard) { { res.status(404).json({ error: "No leaderboard data yet" }); return; } }

  const isStableford = (tournament.format ?? "") === "stableford";

  const [courseRow, roundCourseRows] = await Promise.all([
    tournament.courseId
      ? db.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, tournament.courseId)).then(r => r[0] ?? null)
      : Promise.resolve(null),
    db.select({ roundNumber: tournamentRoundsTable.roundNumber, courseName: coursesTable.name })
      .from(tournamentRoundsTable)
      .leftJoin(coursesTable, eq(tournamentRoundsTable.courseId, coursesTable.id))
      .where(eq(tournamentRoundsTable.tournamentId, tournamentId))
      .orderBy(asc(tournamentRoundsTable.roundNumber)),
  ]);

  const tournamentDate = tournament.startDate
    ? new Date(tournament.startDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : null;

  const pdfBuffer = await generateTournamentReportPDF({
    org: {
      name: orgRow?.name ?? "KHARAGOLF",
      logoUrl: orgRow?.logoUrl ?? null,
      primaryColor: orgRow?.primaryColor ?? null,
    },
    tournament: {
      name: tournament.name,
      format: tournament.format ?? "stroke",
      coursePar: leaderboard.coursePar ?? 72,
      rounds: tournament.rounds ?? 1,
      courseName: courseRow?.name ?? null,
      date: tournamentDate,
      roundCourseAssignments: roundCourseRows.map(r => ({ roundNumber: r.roundNumber, courseName: r.courseName ?? null })),
    },
    entries: (leaderboard.entries ?? []).map((e: Record<string, unknown>) => ({
      positionDisplay: String(e.positionDisplay ?? e.position ?? ""),
      playerName: String(e.playerName ?? ""),
      playingHandicap: Number(e.playingHandicap ?? 0),
      grossScore: e.grossScore != null ? Number(e.grossScore) : null,
      netScore: e.netScore != null ? Number(e.netScore) : null,
      scoreToPar: e.scoreToPar != null ? Number(e.scoreToPar) : null,
      stablefordPoints: e.stablefordPoints != null ? Number(e.stablefordPoints) : null,
      holesCompleted: Number(e.holesCompleted ?? 0),
      roundScores: Array.isArray(e.roundScores)
        ? (e.roundScores as Array<Record<string, unknown>>).map(rs => ({
            round: Number(rs.round),
            grossScore: Number(rs.grossScore ?? 0),
            scoreToPar: Number(rs.scoreToPar ?? 0),
            isComplete: Boolean(rs.isComplete),
          }))
        : undefined,
    })),
    netEntries: (leaderboard.netEntries ?? []).map((e: Record<string, unknown>) => ({
      positionDisplay: String(e.positionDisplay ?? e.position ?? ""),
      playerName: String(e.playerName ?? ""),
      playingHandicap: Number(e.playingHandicap ?? 0),
      grossScore: e.grossScore != null ? Number(e.grossScore) : null,
      netScore: e.netScore != null ? Number(e.netScore) : null,
      scoreToPar: e.scoreToPar != null ? Number(e.scoreToPar) : null,
      stablefordPoints: e.stablefordPoints != null ? Number(e.stablefordPoints) : null,
      holesCompleted: Number(e.holesCompleted ?? 0),
    })),
    sideGameWinners: sideGamesManual.map(w => ({
      gameType: w.gameType,
      holeNumber: w.holeNumber ?? null,
      firstName: w.firstName ?? null,
      lastName: w.lastName ?? null,
      prize: w.prize ?? null,
      notes: w.notes ?? null,
    })),
    sponsors: orgSponsors,
    isStableford,
  });

  const safeName = tournament.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}_results.pdf"`);
  res.setHeader("Content-Length", pdfBuffer.length);
  res.end(pdfBuffer);
});

/* ══════════════════════════════════════════════════════════════════════
   TEAM MANAGEMENT (T71)
   All routes under /:tournamentId/teams
   ══════════════════════════════════════════════════════════════════════ */

// GET /organizations/:orgId/tournaments/:tournamentId/teams
router.get("/:tournamentId/teams", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;
  const teams = await db
    .select({ id: eventTeamsTable.id, name: eventTeamsTable.name, colour: eventTeamsTable.colour, createdAt: eventTeamsTable.createdAt })
    .from(eventTeamsTable)
    .where(eq(eventTeamsTable.tournamentId, tournamentId))
    .orderBy(asc(eventTeamsTable.id));

  const members = await db
    .select({
      teamId: eventTeamMembersTable.teamId,
      playerId: eventTeamMembersTable.playerId,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      handicapIndex: playersTable.handicapIndex,
    })
    .from(eventTeamMembersTable)
    .innerJoin(playersTable, eq(eventTeamMembersTable.playerId, playersTable.id))
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

// POST /organizations/:orgId/tournaments/:tournamentId/teams
router.post("/:tournamentId/teams", orgAdminMiddleware, async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { name, colour } = req.body;
  if (!name) { { res.status(400).json({ error: "name required" }); return; } }
  const [team] = await db.insert(eventTeamsTable).values({ tournamentId, name, colour: colour ?? "#22c55e" }).returning();
  res.status(201).json(team);
});

// PATCH /organizations/:orgId/tournaments/:tournamentId/teams/:teamId
router.patch("/:tournamentId/teams/:teamId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const teamId = parseInt(String((req.params as Record<string, string>).teamId));
  const { name, colour } = req.body;
  const updates: Record<string, unknown> = {};
  if (name) updates.name = name;
  if (colour) updates.colour = colour;
  const [team] = await db.update(eventTeamsTable).set(updates).where(eq(eventTeamsTable.id, teamId)).returning();
  res.json(team);
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/teams/:teamId
router.delete("/:tournamentId/teams/:teamId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const teamId = parseInt(String((req.params as Record<string, string>).teamId));
  await db.delete(eventTeamsTable).where(eq(eventTeamsTable.id, teamId));
  res.json({ ok: true });
});

// POST /organizations/:orgId/tournaments/:tournamentId/teams/:teamId/members
router.post("/:tournamentId/teams/:teamId/members", orgAdminMiddleware, async (req: Request, res: Response) => {
  const teamId = parseInt(String((req.params as Record<string, string>).teamId));
  const { playerId } = req.body;
  if (!playerId) { { res.status(400).json({ error: "playerId required" }); return; } }
  // Remove from any existing team first
  await db.delete(eventTeamMembersTable).where(eq(eventTeamMembersTable.playerId, playerId));
  const [member] = await db.insert(eventTeamMembersTable).values({ teamId, playerId }).returning();
  // Sync team_name denormalised cache
  const [team] = await db.select({ name: eventTeamsTable.name }).from(eventTeamsTable).where(eq(eventTeamsTable.id, teamId));
  if (team) await db.update(playersTable).set({ teamName: team.name }).where(eq(playersTable.id, playerId));
  res.status(201).json(member);
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/teams/:teamId/members/:playerId
router.delete("/:tournamentId/teams/:teamId/members/:playerId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  await db.delete(eventTeamMembersTable).where(and(eq(eventTeamMembersTable.playerId, playerId), eq(eventTeamMembersTable.teamId, parseInt(String((req.params as Record<string, string>).teamId)))));
  await db.update(playersTable).set({ teamName: null }).where(eq(playersTable.id, playerId));
  res.json({ ok: true });
});

// POST /organizations/:orgId/tournaments/:tournamentId/teams/auto-draw
router.post("/:tournamentId/teams/auto-draw", orgAdminMiddleware, async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const teamSize = Math.max(2, Math.min(6, parseInt(req.body.teamSize ?? "2") || 2));
  const teamNamePrefix = req.body.teamNamePrefix ?? "Team";

  // Get all registered players sorted by handicap
  const players = await db
    .select({ id: playersTable.id, handicapIndex: playersTable.handicapIndex, firstName: playersTable.firstName, lastName: playersTable.lastName })
    .from(playersTable)
    .where(and(eq(playersTable.tournamentId, tournamentId), eq(playersTable.dns, false)))
    .orderBy(asc(playersTable.handicapIndex));

  // Delete existing teams for this tournament
  const existingTeams = await db.select({ id: eventTeamsTable.id }).from(eventTeamsTable).where(eq(eventTeamsTable.tournamentId, tournamentId));
  if (existingTeams.length > 0) {
    await db.delete(eventTeamMembersTable).where(inArray(eventTeamMembersTable.teamId, existingTeams.map(t => t.id)));
    await db.delete(eventTeamsTable).where(eq(eventTeamsTable.tournamentId, tournamentId));
  }

  const TEAM_COLOURS = ["#22c55e","#3b82f6","#ef4444","#f59e0b","#8b5cf6","#06b6d4","#ec4899","#f97316","#84cc16","#14b8a6"];
  const numTeams = Math.ceil(players.length / teamSize);
  const teams: { id: number; name: string }[] = [];

  for (let i = 0; i < numTeams; i++) {
    const [team] = await db.insert(eventTeamsTable).values({
      tournamentId,
      name: `${teamNamePrefix} ${i + 1}`,
      colour: TEAM_COLOURS[i % TEAM_COLOURS.length],
    }).returning({ id: eventTeamsTable.id, name: eventTeamsTable.name });
    teams.push(team);
  }

  // Distribute players snake-draft style (1,2,3,3,2,1,1,2...) for balanced handicaps
  const assignments: { teamId: number; playerId: number }[] = [];
  for (let i = 0; i < players.length; i++) {
    const round = Math.floor(i / numTeams);
    const posInRound = i % numTeams;
    const teamIdx = round % 2 === 0 ? posInRound : (numTeams - 1 - posInRound);
    assignments.push({ teamId: teams[teamIdx].id, playerId: players[i].id });
  }

  if (assignments.length > 0) {
    await db.insert(eventTeamMembersTable).values(assignments);
    // Sync team_name cache
    for (const t of teams) {
      const memberIds = assignments.filter(a => a.teamId === t.id).map(a => a.playerId);
      if (memberIds.length > 0) {
        await db.update(playersTable).set({ teamName: t.name }).where(inArray(playersTable.id, memberIds));
      }
    }
  }

  res.json({ teams, assignments });
});

/* ══════════════════════════════════════════════════════════════════════
   ROUND SUSPENSION (T72)
   ══════════════════════════════════════════════════════════════════════ */

// POST /organizations/:orgId/tournaments/:tournamentId/suspend
router.post("/:tournamentId/suspend", orgAdminMiddleware, async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { reason } = req.body;
  if (!reason) { { res.status(400).json({ error: "reason required" }); return; } }

  const [tournament] = await db
    .update(tournamentsTable)
    .set({ status: "suspended", suspendReason: reason, suspendedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)))
    .returning({ id: tournamentsTable.id, status: tournamentsTable.status });

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  // Broadcast suspension SSE to all connected leaderboard clients
  notifyLeaderboardUpdate(tournamentId, { type: "suspension", reason, suspendedAt: new Date().toISOString() });

  res.json({ ok: true, status: "suspended", reason });
});

// POST /organizations/:orgId/tournaments/:tournamentId/resume
router.post("/:tournamentId/resume", orgAdminMiddleware, async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const [tournament] = await db
    .update(tournamentsTable)
    .set({ status: "active", suspendReason: null, resumedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)))
    .returning({ id: tournamentsTable.id, status: tournamentsTable.status });

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  notifyLeaderboardUpdate(tournamentId, { type: "resume", resumedAt: new Date().toISOString() });

  res.json({ ok: true, status: "active" });
});

/* ══════════════════════════════════════════════════════════════════════
   LOCAL RULES (T72)
   ══════════════════════════════════════════════════════════════════════ */

// PATCH /organizations/:orgId/tournaments/:tournamentId/local-rules
router.patch("/:tournamentId/local-rules", orgAdminMiddleware, async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const config = req.body;
  const [t] = await db
    .update(tournamentsTable)
    .set({ localRulesConfig: config, updatedAt: new Date() })
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)))
    .returning({ localRulesConfig: tournamentsTable.localRulesConfig });
  res.json(t);
});

/* ══════════════════════════════════════════════════════════════════════
   OFFICIAL RULINGS (T72)
   ══════════════════════════════════════════════════════════════════════ */

// GET /organizations/:orgId/tournaments/:tournamentId/rulings
router.get("/:tournamentId/rulings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;
  const rulings = await db
    .select({
      id: tournamentRulingsTable.id,
      playerId: tournamentRulingsTable.playerId,
      playerName: sql<string>`concat(${playersTable.firstName}, ' ', ${playersTable.lastName})`,
      holeNumber: tournamentRulingsTable.holeNumber,
      round: tournamentRulingsTable.round,
      ruleRef: tournamentRulingsTable.ruleRef,
      decision: tournamentRulingsTable.decision,
      penaltyStrokes: tournamentRulingsTable.penaltyStrokes,
      officialName: tournamentRulingsTable.officialName,
      createdAt: tournamentRulingsTable.createdAt,
    })
    .from(tournamentRulingsTable)
    .leftJoin(playersTable, eq(tournamentRulingsTable.playerId, playersTable.id))
    .where(eq(tournamentRulingsTable.tournamentId, tournamentId))
    .orderBy(desc(tournamentRulingsTable.createdAt));
  res.json(rulings);
});

// POST /organizations/:orgId/tournaments/:tournamentId/rulings
router.post("/:tournamentId/rulings", orgAdminMiddleware, async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const userId = (req as unknown as { user?: { id: number } }).user?.id;
  const { playerId, holeNumber, round, ruleRef, decision, penaltyStrokes, officialName } = req.body;
  if (!decision) { { res.status(400).json({ error: "decision required" }); return; } }

  const [ruling] = await db.insert(tournamentRulingsTable).values({
    tournamentId,
    playerId: playerId ? parseInt(playerId) : undefined,
    holeNumber: holeNumber ? parseInt(holeNumber) : undefined,
    round: round ? parseInt(round) : 1,
    ruleRef: ruleRef ?? null,
    decision,
    penaltyStrokes: penaltyStrokes ? parseInt(penaltyStrokes) : 0,
    officialName: officialName ?? null,
    loggedByUserId: userId ?? null,
  }).returning();

  // Apply penalty strokes to the score if player + hole specified
  if (playerId && holeNumber && penaltyStrokes && parseInt(penaltyStrokes) > 0) {
    const pid = parseInt(playerId);
    const hole = parseInt(holeNumber);
    const rd = round ? parseInt(round) : 1;
    const pen = parseInt(penaltyStrokes);

    const [existing] = await db
      .select({ id: scoresTable.id, strokes: scoresTable.strokes })
      .from(scoresTable)
      .where(and(eq(scoresTable.playerId, pid), eq(scoresTable.round, rd), eq(scoresTable.holeNumber, hole)));

    if (existing) {
      await db.update(scoresTable).set({ strokes: existing.strokes + pen, updatedAt: new Date() }).where(eq(scoresTable.id, existing.id));
    }
  }

  res.status(201).json(ruling);
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/rulings/:rulingId
router.delete("/:tournamentId/rulings/:rulingId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const rulingId = parseInt(String((req.params as Record<string, string>).rulingId));
  await db.delete(tournamentRulingsTable).where(eq(tournamentRulingsTable.id, rulingId));
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════════════════════════════
   PACE OF PLAY (T72)
   ══════════════════════════════════════════════════════════════════════ */

// GET /organizations/:orgId/tournaments/:tournamentId/pace-of-play
router.get("/:tournamentId/pace-of-play", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;
  const round = parseInt(req.query.round as string ?? "1") || 1;

  const teeTimes = await db
    .select({ id: teeTimesTable.id, teeTime: teeTimesTable.teeTime, startingHole: teeTimesTable.startingHole })
    .from(teeTimesTable)
    .where(and(eq(teeTimesTable.tournamentId, tournamentId), eq(teeTimesTable.round, round)))
    .orderBy(asc(teeTimesTable.teeTime));

  if (teeTimes.length === 0) { { res.json([]); return; } }

  const teeTimeIds = teeTimes.map(t => t.id);
  const teeTimePlayers = await db
    .select({ teeTimeId: teeTimePlayersTable.teeTimeId, playerId: teeTimePlayersTable.playerId, firstName: playersTable.firstName, lastName: playersTable.lastName, currentHole: playersTable.currentHole })
    .from(teeTimePlayersTable)
    .innerJoin(playersTable, eq(teeTimePlayersTable.playerId, playersTable.id))
    .where(inArray(teeTimePlayersTable.teeTimeId, teeTimeIds));

  const playersByGroup: Record<number, typeof teeTimePlayers> = {};
  for (const p of teeTimePlayers) {
    if (!playersByGroup[p.teeTimeId]) playersByGroup[p.teeTimeId] = [];
    playersByGroup[p.teeTimeId].push(p);
  }

  const MINS_PER_HOLE = 12;
  const now = new Date();

  const groups = teeTimes.map(tt => {
    const players = playersByGroup[tt.id] ?? [];
    const avgHole = players.length > 0
      ? Math.round(players.reduce((s, p) => s + (p.currentHole ?? tt.startingHole), 0) / players.length)
      : tt.startingHole;
    const expectedHole = Math.min(18, tt.teeTime
      ? tt.startingHole + Math.floor((now.getTime() - new Date(tt.teeTime).getTime()) / (MINS_PER_HOLE * 60000))
      : tt.startingHole);
    const holeDiff = avgHole - expectedHole;
    return {
      teeTimeId: tt.id,
      teeTime: tt.teeTime,
      startingHole: tt.startingHole,
      currentHole: avgHole,
      expectedHole,
      holeDiff,
      pace: holeDiff >= 0 ? "ahead" : holeDiff === -1 ? "on" : "behind",
      players: players.map(p => ({ id: p.playerId, name: `${p.firstName} ${p.lastName}`, currentHole: p.currentHole ?? tt.startingHole })),
    };
  });

  res.json(groups);
});

// POST /organizations/:orgId/tournaments/:tournamentId/groups/:teeTimeId/pace-warning
router.post("/:tournamentId/groups/:teeTimeId/pace-warning", orgAdminMiddleware, async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const teeTimeId = parseInt(String((req.params as Record<string, string>).teeTimeId));

  const players = await db
    .select({ userId: playersTable.userId, firstName: playersTable.firstName })
    .from(teeTimePlayersTable)
    .innerJoin(playersTable, eq(teeTimePlayersTable.playerId, playersTable.id))
    .where(eq(teeTimePlayersTable.teeTimeId, teeTimeId));

  const userIds = players.filter(p => p.userId).map(p => p.userId as number);
  if (userIds.length > 0) {
    // Task #1240 — fire-and-forget; the PushDeliveryResult is discarded
    // (the surrounding endpoint only returns `notified: userIds.length`,
    // which is the count we attempted to fan out to). Classifier
    // intentionally not consulted because nothing branches on `failed`
    // and the on-course pace alert is doubled by an in-app banner.
    await sendTransactionalPush(
      userIds,
      "⏱ Pace of Play Warning",
      "Your group has been flagged for slow play. Please pick up the pace.",
      { type: "pace_warning", tournamentId },
    );
  }

  res.json({ ok: true, notified: userIds.length });
});

// POST /organizations/:orgId/tournaments/:tournamentId/groups/:teeTimeId/pace-penalty
router.post("/:tournamentId/groups/:teeTimeId/pace-penalty", orgAdminMiddleware, async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const teeTimeId = parseInt(String((req.params as Record<string, string>).teeTimeId));
  const penaltyStrokes = parseInt(req.body.penaltyStrokes ?? "1");
  const holeNumber = parseInt(req.body.holeNumber ?? "1");
  const round = parseInt(req.body.round ?? "1");

  const teeTimePlayers2 = await db
    .select({ playerId: teeTimePlayersTable.playerId })
    .from(teeTimePlayersTable)
    .where(eq(teeTimePlayersTable.teeTimeId, teeTimeId));

  const playerIds = teeTimePlayers2.map(p => p.playerId);
  if (playerIds.length === 0) { { res.json({ ok: true, updated: 0 }); return; } }

  const existingScores = await db
    .select({ id: scoresTable.id, playerId: scoresTable.playerId, strokes: scoresTable.strokes })
    .from(scoresTable)
    .where(and(inArray(scoresTable.playerId, playerIds), eq(scoresTable.round, round), eq(scoresTable.holeNumber, holeNumber)));

  for (const score of existingScores) {
    await db.update(scoresTable).set({ strokes: score.strokes + penaltyStrokes, updatedAt: new Date() }).where(eq(scoresTable.id, score.id));
  }

  res.json({ ok: true, updated: existingScores.length });
});

export default router;
