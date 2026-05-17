/**
 * WHS / GHIN Score Posting API
 *
 * POST   /organizations/:orgId/tournaments/:tournamentId/rounds/:round/post-whs
 *        Trigger score posting for all players in a round (admin only).
 *
 * GET    /organizations/:orgId/tournaments/:tournamentId/rounds/:round/post-whs
 *        Return current posting status per player for a round.
 *
 * POST   /organizations/:orgId/tournaments/:tournamentId/rounds/:round/players/:playerId/retry-whs
 *        Retry posting for a single failed player.
 *
 * PATCH  /organizations/:orgId/tournaments/:tournamentId/rounds/:round/players/:playerId/ghin
 *        Update GHIN number for a player (inline edit from the WHS panel).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import PDFDocument from "pdfkit";
import { db } from "@workspace/db";
import {
  whsPostingsTable,
  playersTable,
  scoresTable,
  holeDetailsTable,
  tournamentsTable,
  coursesTable,
  orgGhinCredentialsTable,
  exceptionalScoreFlagsTable,
  whsPlayerStateTable,
  whsScoreRecordsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { requireTournamentAccess, requireOrgAdmin } from "../lib/permissions";
import { calculateAGS, calculateGrossScore } from "../lib/ags";
import { postScoreToGhin, resolveGhinCredentials, type GhinCredentials } from "../lib/ghin";
import { getWhsPlayerState, postScoreAndRecalculate } from "../lib/whs-recalc";
import { computePlayingHandicap } from "../lib/handicap";
import { logger } from "../lib/logger";
import { gateFeature } from "../lib/featureGate";

const router: IRouter = Router({ mergeParams: true });
// Scope the entitlement gate to actual WHS scoring routes only. Mounting it
// router-wide previously meant unrelated tournament-scoped routes (e.g. the
// broadcast-overlay endpoints, which share the same `/organizations/:orgId/
// tournaments/:tournamentId` mount) returned 402 for clubs on Free/Starter
// plans.  Listing the WHS-specific subpaths here keeps the gate where it
// belongs without affecting siblings mounted on the same parent.
router.use(
  [
    "/rounds/:round/post-whs",
    "/rounds/:round/players/:playerId/retry-whs",
    "/players/:playerId/ghin",
    "/organizations/:orgId/whs",
  ],
  gateFeature("whsScoring"),
);

/* ─── ESR Auto-Detection ─────────────────────────────────────────
 * WHS Rule 5.8: when a score differential would reduce a player's
 * Handicap Index by 3 or more strokes it must be reviewed by the
 * Handicap Committee. We insert a flag; the committee then applies
 * or dismisses it via the /handicap endpoints.
 */
async function maybeCreateESRFlag(opts: {
  orgId: number;
  playerId: number;
  tournamentId: number;
  round: number;
  ags: number;
  courseRating: number;
  slope: number;
  currentHI: number | null;
  postingId: number | null;
}): Promise<void> {
  const { orgId, playerId, tournamentId, round, ags, courseRating, slope, currentHI, postingId } = opts;
  if (currentHI === null) return;

  // WHS score differential formula
  const differential = Math.round(((113 / slope) * (ags - courseRating)) * 10) / 10;

  // Only flag if the differential is ≥3 strokes below the current HI
  if (currentHI - differential < 3) return;

  // Project new HI (simplified: treat as if this differential replaces the best from 20 rounds)
  const projectedHI = Math.round((currentHI - (currentHI - differential) * 0.5) * 10) / 10;

  try {
    if (postingId) {
      // Conflict on posting uniqueness — one flag per posting record
      await db.insert(exceptionalScoreFlagsTable).values({
        organizationId: orgId,
        playerId,
        tournamentId,
        round,
        scoreDifferential: String(differential),
        previousHandicapIndex: String(currentHI),
        projectedHandicapIndex: String(projectedHI),
        postingId,
      }).onConflictDoUpdate({
        target: exceptionalScoreFlagsTable.postingId,
        set: { scoreDifferential: String(differential), projectedHandicapIndex: String(projectedHI) },
      });
    } else {
      // Fallback: conflict on org/player/tournament/round
      await db.insert(exceptionalScoreFlagsTable).values({
        organizationId: orgId,
        playerId,
        tournamentId,
        round,
        scoreDifferential: String(differential),
        previousHandicapIndex: String(currentHI),
        projectedHandicapIndex: String(projectedHI),
      }).onConflictDoUpdate({
        target: [exceptionalScoreFlagsTable.organizationId, exceptionalScoreFlagsTable.playerId, exceptionalScoreFlagsTable.tournamentId, exceptionalScoreFlagsTable.round],
        set: { scoreDifferential: String(differential), projectedHandicapIndex: String(projectedHI) },
      });
    }
  } catch (e) {
    logger.warn({ e, playerId, tournamentId }, "[whs] Failed to create ESR flag (non-fatal)");
  }
}

/* ─── Helpers ──────────────────────────────────────────────────── */

/** Load org-scoped GHIN credentials from DB; null if not configured. */
async function getOrgGhinCredentials(orgId: number): Promise<GhinCredentials | null> {
  const [row] = await db
    .select({ ghinApiKey: orgGhinCredentialsTable.ghinApiKey, ghinApiUsername: orgGhinCredentialsTable.ghinApiUsername, ghinApiPassword: orgGhinCredentialsTable.ghinApiPassword })
    .from(orgGhinCredentialsTable)
    .where(eq(orgGhinCredentialsTable.organizationId, orgId));
  if (!row) return null;
  return { apiKey: row.ghinApiKey, username: row.ghinApiUsername, password: row.ghinApiPassword };
}

async function getTournamentCourse(orgId: number, tournamentId: number) {
  const [tournament] = await db
    .select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      organizationId: tournamentsTable.organizationId,
      courseId: tournamentsTable.courseId,
      handicapAllowance: tournamentsTable.handicapAllowance,
      startDate: tournamentsTable.startDate,
    })
    .from(tournamentsTable)
    .where(sql`${tournamentsTable.id} = ${tournamentId} AND ${tournamentsTable.organizationId} = ${orgId}`);

  if (!tournament) return null;

  let courseData: { name: string; rating: number | null; slope: number | null; par: number } | null = null;
  if (tournament.courseId) {
    const [course] = await db
      .select({ name: coursesTable.name, rating: coursesTable.rating, slope: coursesTable.slope, par: coursesTable.par })
      .from(coursesTable)
      .where(eq(coursesTable.id, tournament.courseId));
    if (course) {
      courseData = {
        name: course.name,
        rating: course.rating ? Number(course.rating) : null,
        slope: course.slope ?? null,
        par: course.par,
      };
    }
  }

  return { tournament, courseData };
}

async function getHoleDetails(courseId: number | null) {
  if (!courseId) return [];
  return db
    .select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par, handicap: holeDetailsTable.handicap })
    .from(holeDetailsTable)
    .where(eq(holeDetailsTable.courseId, courseId))
    .orderBy(holeDetailsTable.holeNumber);
}

interface PlayerPostingData {
  player: typeof playersTable.$inferSelect;
  grossScore: number;
  ags: number;
  numberOfHoles: 9 | 18 | null; // null means fewer than 9 holes scored — skip posting
  existing: typeof whsPostingsTable.$inferSelect | null;
}

async function buildPlayerPostingData(
  tournamentId: number,
  round: number,
  holeDetails: Array<{ holeNumber: number; par: number; handicap: number | null }>,
  courseData: { name: string; rating: number | null; slope: number | null; par: number } | null,
  handicapAllowance: number,
): Promise<PlayerPostingData[]> {
  const players = await db
    .select()
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tournamentId));

  const roundScores = await db
    .select()
    .from(scoresTable)
    .where(sql`${scoresTable.tournamentId} = ${tournamentId} AND ${scoresTable.round} = ${round}`);

  const existingPostings = await db
    .select()
    .from(whsPostingsTable)
    .where(sql`${whsPostingsTable.tournamentId} = ${tournamentId} AND ${whsPostingsTable.round} = ${round}`);

  const postingMap = new Map<number, typeof whsPostingsTable.$inferSelect>();
  for (const p of existingPostings) postingMap.set(p.playerId, p);

  return players.map(player => {
    const playerScores = roundScores.filter(s => s.playerId === player.id);
    const hiNum = player.handicapOverride != null ? Number(player.handicapOverride) : (player.handicapIndex ? Number(player.handicapIndex) : 0);
    const playingHandicap = computePlayingHandicap(hiNum, courseData?.slope, courseData?.rating, courseData?.par ?? 72, handicapAllowance);

    const holeScoresForAGS = holeDetails.map(h => {
      const scored = playerScores.find(s => s.holeNumber === h.holeNumber);
      return { holeNumber: h.holeNumber, par: h.par, strokeIndex: h.handicap, strokes: scored?.strokes ?? null };
    });

    const grossScore = calculateGrossScore(holeScoresForAGS.filter(h => h.strokes !== null));
    const ags = calculateAGS(holeScoresForAGS, playingHandicap);
    // Use actual number of holes with scores entered (9 or 18) rather than hardcoding 18
    // GHIN only accepts 9 or 18 holes; skip players with fewer than 9 scored holes
    const numberOfHoles: 9 | 18 | null = playerScores.length >= 18 ? 18 : playerScores.length >= 9 ? 9 : null;

    return { player, grossScore, ags, numberOfHoles, existing: postingMap.get(player.id) ?? null };
  });
}

/* ─── GET — posting status for a round ─────────────────────────── */

router.get(
  "/rounds/:round/post-whs",
  async (req: Request, res: Response) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
    const round = parseInt(String((req.params as Record<string, string>).round)) || 1;
    if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

    const tc = await getTournamentCourse(orgId, tournamentId);
    if (!tc) { { res.status(404).json({ error: "Tournament not found" }); return; } }

    const holeDetails = await getHoleDetails(tc.tournament.courseId);
    const handicapAllowance = tc.tournament.handicapAllowance ?? 100;

    const data = await buildPlayerPostingData(tournamentId, round, holeDetails, tc.courseData, handicapAllowance);

    const orgCreds = await getOrgGhinCredentials(orgId);
    const ghinConfigured = !!resolveGhinCredentials(orgCreds);

    res.json({
      round,
      courseName: tc.courseData?.name ?? null,
      courseRating: tc.courseData?.rating ?? null,
      slope: tc.courseData?.slope ?? null,
      ghinConfigured,
      players: data.map(d => ({
        playerId: d.player.id,
        firstName: d.player.firstName,
        lastName: d.player.lastName,
        ghinNumber: d.player.ghinNumber ?? null,
        grossScore: d.grossScore || null,
        adjustedGrossScore: d.ags || null,
        status: d.existing?.status ?? (d.player.ghinNumber ? "pending" : "no_ghin"),
        errorMessage: d.existing?.errorMessage ?? null,
        postedAt: d.existing?.postedAt ?? null,
        postingId: d.existing?.id ?? null,
      })),
    });
  },
);

/* ─── POST — post all scores in a round ────────────────────────── */

router.post(
  "/rounds/:round/post-whs",
  async (req: Request, res: Response) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
    const round = parseInt(String((req.params as Record<string, string>).round)) || 1;
    if (!await requireOrgAdmin(req, res, orgId)) return;

    const tc = await getTournamentCourse(orgId, tournamentId);
    if (!tc) { { res.status(404).json({ error: "Tournament not found" }); return; } }

    const holeDetails = await getHoleDetails(tc.tournament.courseId);
    const handicapAllowance = tc.tournament.handicapAllowance ?? 100;
    // Allow caller to override course rating / slope (for manual correction without editing the course record)
    const courseRating = typeof req.body?.courseRating === "number" ? req.body.courseRating : (tc.courseData?.rating ?? 72);
    const slope = typeof req.body?.slope === "number" ? req.body.slope : (tc.courseData?.slope ?? 113);
    const courseName = tc.courseData?.name ?? tc.tournament.name;
    const playedAt = tc.tournament.startDate ? new Date(tc.tournament.startDate).toISOString().split("T")[0] : new Date().toISOString().split("T")[0];

    const orgCreds = await getOrgGhinCredentials(orgId);
    const data = await buildPlayerPostingData(tournamentId, round, holeDetails, tc.courseData, handicapAllowance);

    // Load already-posted players for this round to avoid duplicate submissions.
    // Pass force=true in the body to override and re-post even already-posted scores.
    const force = req.body?.force === true;
    const existingPostings = await db
      .select({ playerId: whsPostingsTable.playerId, status: whsPostingsTable.status })
      .from(whsPostingsTable)
      .where(and(
        eq(whsPostingsTable.tournamentId, tournamentId),
        eq(whsPostingsTable.round, round),
      ));
    const alreadyPosted = new Set(
      existingPostings.filter(p => p.status === "posted").map(p => p.playerId)
    );

    const results: Array<{ playerId: number; status: string; error?: string }> = [];

    for (const d of data) {
      const player = d.player;

      // Skip players whose score was already successfully submitted unless force flag is set
      if (!force && alreadyPosted.has(player.id)) {
        results.push({ playerId: player.id, status: "already_posted" });
        continue;
      }

      if (!player.ghinNumber) {
        await db
          .insert(whsPostingsTable)
          .values({
            tournamentId,
            playerId: player.id,
            round,
            grossScore: d.grossScore || null,
            adjustedGrossScore: d.ags || null,
            ghinNumber: null,
            courseRating: String(courseRating),
            slope,
            status: "no_ghin",
            errorMessage: "No GHIN number on file",
          })
          .onConflictDoUpdate({
            target: [whsPostingsTable.tournamentId, whsPostingsTable.playerId, whsPostingsTable.round],
            set: { status: "no_ghin", errorMessage: "No GHIN number on file", updatedAt: new Date() },
          });
        results.push({ playerId: player.id, status: "no_ghin" });
        continue;
      }

      if (d.ags === 0 || d.numberOfHoles === null) {
        // Persist an audit row for no-score or incomplete-round players
        const skipReason = d.numberOfHoles === null ? "Incomplete round (fewer than 9 holes scored)" : "No scores entered";
        await db
          .insert(whsPostingsTable)
          .values({
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
          })
          .onConflictDoNothing();
        results.push({ playerId: player.id, status: "skipped", error: skipReason });
        continue;
      }

      const result = await postScoreToGhin({
        ghinNumber: player.ghinNumber,
        firstName: player.firstName,
        lastName: player.lastName,
        courseName,
        courseRating,
        slope,
        numberOfHoles: d.numberOfHoles,
        playedAt,
        adjustedGrossScore: d.ags,
      }, orgCreds);

      if (result.success) {
        const [insertedPosting] = await db
          .insert(whsPostingsTable)
          .values({
            tournamentId,
            playerId: player.id,
            round,
            grossScore: d.grossScore || null,
            adjustedGrossScore: d.ags,
            ghinNumber: player.ghinNumber,
            courseRating: String(courseRating),
            slope,
            status: "posted",
            ghinResponse: result.response,
            postedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [whsPostingsTable.tournamentId, whsPostingsTable.playerId, whsPostingsTable.round],
            set: { status: "posted", ghinResponse: result.response, postedAt: new Date(), errorMessage: null, updatedAt: new Date() },
          })
          .returning({ id: whsPostingsTable.id });
        // ESR auto-detection: flag if score differential drops HI by ≥3 strokes
        const currentHI = player.handicapOverride != null ? Number(player.handicapOverride) : (player.handicapIndex ? Number(player.handicapIndex) : null);
        await maybeCreateESRFlag({ orgId, playerId: player.id, tournamentId, round, ags: d.ags, courseRating, slope, currentHI, postingId: insertedPosting?.id ?? null });
        results.push({ playerId: player.id, status: "posted" });
      } else {
        const code = (result as { code?: string }).code;
        const status = code === "GOLFER_NOT_FOUND" ? "no_ghin" : "failed";
        await db
          .insert(whsPostingsTable)
          .values({
            tournamentId,
            playerId: player.id,
            round,
            grossScore: d.grossScore || null,
            adjustedGrossScore: d.ags,
            ghinNumber: player.ghinNumber,
            courseRating: String(courseRating),
            slope,
            status,
            errorMessage: result.error,
            ghinResponse: (result as { response?: Record<string, unknown> }).response ?? null,
          })
          .onConflictDoUpdate({
            target: [whsPostingsTable.tournamentId, whsPostingsTable.playerId, whsPostingsTable.round],
            set: { status, errorMessage: result.error, ghinResponse: (result as { response?: Record<string, unknown> }).response ?? null, updatedAt: new Date() },
          });
        results.push({ playerId: player.id, status, error: result.error });
      }

      await new Promise(r => setTimeout(r, 1100));
    }

    logger.info({ tournamentId, round, results }, "[whs] Score posting complete");
    res.json({ posted: results.filter(r => r.status === "posted").length, failed: results.filter(r => r.status === "failed").length, noGhin: results.filter(r => r.status === "no_ghin").length, results });
  },
);

/* ─── POST — retry single player ──────────────────────────────── */

router.post(
  "/rounds/:round/players/:playerId/retry-whs",
  async (req: Request, res: Response) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
    const round = parseInt(String((req.params as Record<string, string>).round)) || 1;
    const playerId = parseInt(String((req.params as Record<string, string>).playerId));
    // requireTournamentAccess verifies org-admin role AND that tournament belongs to this org
    if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

    const tc = await getTournamentCourse(orgId, tournamentId);
    if (!tc) { { res.status(404).json({ error: "Tournament not found" }); return; } }

    const [player] = await db.select().from(playersTable).where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)));
    if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }
    if (!player.ghinNumber) { { res.status(400).json({ error: "Player has no GHIN number" }); return; } }

    const holeDetails = await getHoleDetails(tc.tournament.courseId);
    const handicapAllowance = tc.tournament.handicapAllowance ?? 100;
    const courseRating = tc.courseData?.rating ?? 72;
    const slope = tc.courseData?.slope ?? 113;
    const courseName = tc.courseData?.name ?? tc.tournament.name;
    const playedAt = tc.tournament.startDate ? new Date(tc.tournament.startDate).toISOString().split("T")[0] : new Date().toISOString().split("T")[0];

    const playerScores = await db
      .select()
      .from(scoresTable)
      .where(sql`${scoresTable.playerId} = ${playerId} AND ${scoresTable.tournamentId} = ${tournamentId} AND ${scoresTable.round} = ${round}`);

    const hiNum = player.handicapOverride != null ? Number(player.handicapOverride) : (player.handicapIndex ? Number(player.handicapIndex) : 0);
    const playingHandicap = computePlayingHandicap(hiNum, tc.courseData?.slope, tc.courseData?.rating, tc.courseData?.par ?? 72, handicapAllowance);

    const holeScores = holeDetails.map(h => {
      const scored = playerScores.find(s => s.holeNumber === h.holeNumber);
      return { holeNumber: h.holeNumber, par: h.par, strokeIndex: h.handicap, strokes: scored?.strokes ?? null };
    });

    const grossScore = calculateGrossScore(holeScores.filter(h => h.strokes !== null));
    const ags = calculateAGS(holeScores, playingHandicap);
    // Normalize to 9 or 18 only; GHIN rejects other values
    const numberOfHoles: 9 | 18 | null = playerScores.length >= 18 ? 18 : playerScores.length >= 9 ? 9 : null;

    if (ags === 0) { { res.status(400).json({ error: "No scores entered for this player in this round" }); return; } }
    if (numberOfHoles === null) { { res.status(400).json({ error: "Incomplete round: fewer than 9 holes scored. Cannot post to GHIN." }); return; } }

    const orgCreds = await getOrgGhinCredentials(orgId);
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
    const status: "posted" | "failed" | "no_ghin" = result.success ? "posted" : (code === "GOLFER_NOT_FOUND" ? "no_ghin" : "failed");

    await db
      .insert(whsPostingsTable)
      .values({
        tournamentId,
        playerId,
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
      })
      .onConflictDoUpdate({
        target: [whsPostingsTable.tournamentId, whsPostingsTable.playerId, whsPostingsTable.round],
        set: {
          status,
          ghinResponse: result.success ? result.response : (result as { response?: Record<string, unknown> }).response ?? null,
          errorMessage: result.success ? null : result.error,
          postedAt: result.success ? new Date() : null,
          updatedAt: new Date(),
        },
      });

    res.json({ status, error: result.success ? undefined : result.error });
  },
);

/* ─── PATCH — update GHIN number inline ────────────────────────── */

router.patch(
  "/players/:playerId/ghin",
  async (req: Request, res: Response) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
    const playerId = parseInt(String((req.params as Record<string, string>).playerId));
    // requireTournamentAccess verifies both org-admin role AND that
    // the tournament belongs to this org, preventing cross-org IDOR.
    if (!await requireTournamentAccess(req, res, orgId, tournamentId)) return;

    const { ghinNumber } = req.body;

    const [player] = await db
      .update(playersTable)
      .set({ ghinNumber: ghinNumber ? String(ghinNumber).trim() : null })
      .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)))
      .returning({ id: playersTable.id, ghinNumber: playersTable.ghinNumber });

    if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }
    res.json({ playerId: player.id, ghinNumber: player.ghinNumber });
  },
);

/* ─── Org-wide WHS endpoints ─────────────────────────────────────── */

/** GET /organizations/:orgId/whs/states — list all members' WHS state */
router.get(
  "/organizations/:orgId/whs/states",
  async (req: Request, res: Response) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    if (!orgId) { { res.status(400).json({ error: "Invalid org" }); return; } }
    if (!await requireOrgAdmin(req, res, orgId)) return;

    try {
      const rows = await db.execute(sql`
        SELECT
          u.id                           AS "userId",
          u.name                         AS "playerName",
          u.email,
          s.current_handicap_index       AS "handicapIndex",
          s.low_handicap_index           AS "lowHandicapIndex",
          s.establishment_phase          AS "phase",
          s.is_provisional               AS "isProvisional",
          s.last_recalc_at               AS "lastCalculatedAt",
          s.low_handicap_index_date      AS "establishedAt",
          s.total_holes_posted           AS "totalHolesPosted",
          (SELECT COUNT(*)::int
             FROM whs_score_records r
            WHERE r.user_id = s.user_id
              AND r.organization_id = s.organization_id) AS "scoringRecordCount"
        FROM whs_player_state s
        JOIN users u ON u.id = s.user_id
        WHERE s.organization_id = ${orgId}
        ORDER BY s.current_handicap_index ASC NULLS LAST
      `);

      res.json(
        (rows.rows as any[]).map(r => {
          const hiNum = r.handicapIndex != null ? parseFloat(r.handicapIndex) : null;
          const lowNum = r.lowHandicapIndex != null ? parseFloat(r.lowHandicapIndex) : null;
          const drift = hiNum != null && lowNum != null ? hiNum - lowNum : 0;
          return {
            playerId: r.userId,
            playerName: r.playerName ?? "Unknown",
            email: r.email,
            ghinNumber: null,
            handicapIndex: r.handicapIndex,
            lowHandicapIndex: r.lowHandicapIndex,
            scoringRecordCount: r.scoringRecordCount ?? 0,
            phase: r.phase ?? 0,
            softCapApplied: drift > 3,
            hardCapApplied: drift > 5,
            lastCalculatedAt: r.lastCalculatedAt,
            establishedAt: r.establishedAt,
            eligible: !r.isProvisional || (r.scoringRecordCount ?? 0) >= 1,
          };
        })
      );
    } catch (e) {
      logger.error({ e }, "[whs] Failed to list org WHS states");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** POST /organizations/:orgId/whs/recalc-all — trigger H.I. recalc for all members */
router.post(
  "/organizations/:orgId/whs/recalc-all",
  async (req: Request, res: Response) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    if (!orgId) { { res.status(400).json({ error: "Invalid org" }); return; } }
    if (!await requireOrgAdmin(req, res, orgId)) return;

    try {
      const userRows = await db.execute(sql`
        SELECT DISTINCT "userId" FROM whs_player_state WHERE "organizationId" = ${orgId}
      `);
      const userIds = (userRows.rows as any[]).map(r => r.userId);
      let processed = 0;
      let errors = 0;

      // Process sequentially to avoid DB overload
      for (const userId of userIds) {
        try {
          const { calculateHandicapIndex } = await import("../lib/handicap");
          const scoreRows = await db.execute(sql`
            SELECT final_differential FROM whs_score_records
            WHERE user_id = ${userId} AND organization_id = ${orgId}
            ORDER BY played_at DESC
            LIMIT 20
          `);
          const diffs = (scoreRows.rows as any[]).map(r => parseFloat(r.final_differential));
          const handicapIndex = calculateHandicapIndex(diffs);
          const phase = diffs.length >= 20 ? 3 : diffs.length >= 3 ? 2 : 1;

          await db.execute(sql`
            UPDATE whs_player_state
            SET
              current_handicap_index = ${handicapIndex},
              low_handicap_index     = LEAST(COALESCE(low_handicap_index, ${handicapIndex ?? 999}), ${handicapIndex ?? 999}),
              total_holes_posted     = ${diffs.length},
              establishment_phase    = ${phase},
              last_recalc_at         = NOW()
            WHERE user_id = ${userId} AND organization_id = ${orgId}
          `);
          processed++;
        } catch { errors++; }
      }

      res.json({ processed, errors });
    } catch (e) {
      logger.error({ e }, "[whs] recalc-all failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** POST /organizations/:orgId/whs/annual-review — reset Low H.I. for new season + stamp org */
router.post(
  "/organizations/:orgId/whs/annual-review",
  async (req: Request, res: Response) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    if (!orgId) { { res.status(400).json({ error: "Invalid org" }); return; } }
    if (!await requireOrgAdmin(req, res, orgId)) return;

    try {
      const result = await db.execute(sql`
        UPDATE whs_player_state
        SET
          low_handicap_index      = current_handicap_index,
          low_handicap_index_date = NOW(),
          last_recalc_at          = NOW()
        WHERE organization_id = ${orgId}
          AND current_handicap_index IS NOT NULL
        RETURNING user_id
      `);
      const updated = result.rowCount ?? result.rows.length;

      // Stamp the organization record with review completion
      const reviewedAt = new Date();
      const reviewedByUserId = req.user?.id ?? null;
      await db.execute(sql`
        UPDATE organizations
        SET
          handicap_review_completed_at = ${reviewedAt},
          handicap_review_completed_by_user_id = ${reviewedByUserId}
        WHERE id = ${orgId}
      `);

      logger.info({ orgId, updated }, "[whs] Annual review completed and stamped");
      res.json({ updated, year: new Date().getFullYear(), reviewedAt: reviewedAt.toISOString() });
    } catch (e) {
      logger.error({ e }, "[whs] Annual review failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** GET /organizations/:orgId/whs/review-status — check if annual review has been completed */
router.get(
  "/organizations/:orgId/whs/review-status",
  async (req: Request, res: Response) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    if (!orgId) { { res.status(400).json({ error: "Invalid org" }); return; } }
    if (!await requireOrgAdmin(req, res, orgId)) return;

    try {
      const result = await db.execute(sql`
        SELECT handicap_review_completed_at, handicap_review_completed_by_user_id
        FROM organizations
        WHERE id = ${orgId}
      `);
      const row = result.rows?.[0] as { handicap_review_completed_at: string | null; handicap_review_completed_by_user_id: number | null } | undefined;
      res.json({
        reviewCompletedAt: row?.handicap_review_completed_at ?? null,
        reviewCompletedByUserId: row?.handicap_review_completed_by_user_id ?? null,
      });
    } catch (e) {
      logger.error({ e }, "[whs] review-status failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** GET /organizations/:orgId/whs/annual-review/pdf — export Handicap Review as PDF */
router.get(
  "/organizations/:orgId/whs/annual-review/pdf",
  async (req: Request, res: Response) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    if (!orgId) { { res.status(400).json({ error: "Invalid org" }); return; } }
    if (!await requireOrgAdmin(req, res, orgId)) return;

    try {
      const [orgRow] = await db
        .select({ name: organizationsTable.name, handicapReviewCompletedAt: organizationsTable.handicapReviewCompletedAt })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, orgId));

      const rows = await db.execute(sql`
        SELECT
          u.username                     AS "playerName",
          u.email,
          s.current_handicap_index       AS "handicapIndex",
          s.low_handicap_index           AS "lowHandicapIndex",
          s.establishment_phase          AS "phase",
          s.is_provisional               AS "isProvisional",
          s.total_holes_posted           AS "totalHolesPosted",
          (SELECT COUNT(*)::int
             FROM whs_score_records r
            WHERE r.user_id = s.user_id
              AND r.organization_id = s.organization_id) AS "scoringRecordCount"
        FROM whs_player_state s
        JOIN app_users u ON u.id = s.user_id
        WHERE s.organization_id = ${orgId}
        ORDER BY s.current_handicap_index ASC NULLS LAST
      `);

      const players = rows.rows as Array<{
        playerName: string;
        email: string | null;
        handicapIndex: string | null;
        lowHandicapIndex: string | null;
        phase: number;
        isProvisional: boolean;
        totalHolesPosted: number;
        scoringRecordCount: number;
      }>;

      const orgName = orgRow?.name ?? "Club";
      const year = new Date().getFullYear();
      const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
      const safeOrgName = orgName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="handicap-review-${year}-${safeOrgName}.pdf"`);

      const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
      doc.pipe(res);

      const GREEN = "#1e4d2b";
      const GOLD = "#C9A84C";
      const LIGHT_GRAY = "#f5f5f5";

      // Header bar
      doc.rect(0, 0, doc.page.width, 60).fill(GREEN);
      doc.fillColor("white").fontSize(18).font("Helvetica-Bold")
        .text(`${orgName}`, 40, 14, { width: doc.page.width - 80 });
      doc.fontSize(10).font("Helvetica")
        .text(`${year} Annual Handicap Review  ·  WHS 2024/2026 Compliance Report`, 40, 36, { width: doc.page.width - 80 });

      // Meta line
      doc.fillColor("#444").fontSize(9).font("Helvetica")
        .text(`Generated: ${today}   |   Total members: ${players.length}   |   WHS Rules of Handicapping §5.3 §5.8`, 40, 68);

      if (orgRow?.handicapReviewCompletedAt) {
        const stamp = new Date(orgRow.handicapReviewCompletedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" } as Intl.DateTimeFormatOptions);
        doc.fillColor(GREEN).fontSize(9).font("Helvetica-Bold")
          .text(`✓ Annual Review Completed: ${stamp}`, 40, 80);
      }

      // Table header
      const tableTop = 100;
      const cols = [
        { label: "Player",     x: 40,  w: 160 },
        { label: "Email",      x: 205, w: 155 },
        { label: "H.I.",       x: 365, w: 50  },
        { label: "Low H.I.",   x: 420, w: 60  },
        { label: "Drift",      x: 485, w: 45  },
        { label: "Scores",     x: 535, w: 45  },
        { label: "Phase",      x: 585, w: 100 },
        { label: "Cap Status", x: 690, w: 70  },
      ];

      doc.rect(40, tableTop, doc.page.width - 80, 18).fill(GREEN);
      doc.fillColor("white").fontSize(8).font("Helvetica-Bold");
      for (const col of cols) {
        doc.text(col.label, col.x + 4, tableTop + 5, { width: col.w - 4, align: "left" });
      }

      let y = tableTop + 18;
      doc.font("Helvetica").fontSize(8);

      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        const rowHeight = 16;
        if (i % 2 === 0) {
          doc.rect(40, y, doc.page.width - 80, rowHeight).fill(LIGHT_GRAY);
        }

        const hi = p.handicapIndex ? parseFloat(p.handicapIndex) : null;
        const lowHi = p.lowHandicapIndex ? parseFloat(p.lowHandicapIndex) : null;
        const drift = hi != null && lowHi != null ? hi - lowHi : null;
        const softCap = drift != null && drift > 3 && drift <= 5;
        const hardCap = drift != null && drift > 5;
        const phaseLabel = ["", "Phase 1 (Init)", "Phase 2 (Estab.)", "Phase 3 (Full)"][p.phase] ?? "—";
        const capLabel = hardCap ? "HARD CAP" : softCap ? "Soft Cap" : "None";

        const rowColor = hardCap ? "#7f1d1d" : softCap ? "#78350f" : "#222222";
        doc.fillColor(rowColor);

        const vals = [
          p.playerName.slice(0, 25),
          (p.email ?? "—").slice(0, 28),
          hi != null ? hi.toFixed(1) : "N/A",
          lowHi != null ? lowHi.toFixed(1) : "—",
          drift != null ? (drift >= 0 ? "+" : "") + drift.toFixed(1) : "—",
          String(p.scoringRecordCount),
          phaseLabel,
          capLabel,
        ];

        for (let ci = 0; ci < cols.length; ci++) {
          doc.text(vals[ci], cols[ci].x + 4, y + 4, { width: cols[ci].w - 4, align: "left" });
        }

        y += rowHeight;

        if (y > doc.page.height - 60) {
          doc.addPage({ size: "A4", layout: "landscape" });
          y = 40;
          doc.rect(40, y, doc.page.width - 80, 18).fill(GREEN);
          doc.fillColor("white").fontSize(8).font("Helvetica-Bold");
          for (const col of cols) {
            doc.text(col.label, col.x + 4, y + 5, { width: col.w - 4, align: "left" });
          }
          y += 18;
          doc.font("Helvetica").fontSize(8);
        }
      }

      // Footer
      const footerY = doc.page.height - 40;
      doc.rect(0, footerY - 4, doc.page.width, 44).fill(GREEN);
      doc.fillColor(GOLD).fontSize(7.5).font("Helvetica")
        .text(
          "WHS 2024/2026 · H.I. = best 8 of last 20 differentials × 0.96 (§5.3) · Soft Cap = 50% above Low H.I.+3.0 (§5.8) · Hard Cap = Low H.I.+5.0 (§5.8)",
          40, footerY + 2, { width: doc.page.width - 80, align: "center" }
        );
      doc.fillColor("white").fontSize(7)
        .text("KharaGolf · Handicap Committee Report · Confidential", 40, footerY + 14, { width: doc.page.width - 80, align: "center" });

      doc.end();
    } catch (e) {
      logger.error({ e }, "[whs] PDF export failed");
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
