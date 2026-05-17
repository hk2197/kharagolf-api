/**
 * WHS Handicap Index Recalculation — server-side trigger
 *
 * Called after every qualifying score is posted (tournament or general play).
 * Updates whs_player_state and stores the differential in whs_score_records.
 */

import { db } from "@workspace/db";
import {
  whsPlayerStateTable,
  whsScoreRecordsTable,
  whsPccEntriesTable,
  appUsersTable,
  coursesTable,
  tournamentsTable,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import {
  scoreDifferential18,
  scoreDifferential9,
  scoreDifferentialPartialRound,
  applyESR,
  recalcHandicapIndex,
} from "./handicap";
import { logger } from "./logger";

export interface ScorePostingInput {
  userId: number;
  organizationId: number;
  courseId?: number | null;
  sourceType: "tournament" | "general_play";
  sourceTournamentId?: number | null;
  sourceGeneralPlayId?: number | null;
  holesPlayed: number;
  grossScore?: number | null;
  adjustedGrossScore: number;
  courseRating: number;
  slopeRating: number;
  pcc?: number;
  markerName?: string | null;
  markerGhinNumber?: string | null;
  playedAt: Date;
}

/**
 * Post a score, calculate differential with ESR, and recalculate the player's
 * Handicap Index. Updates whs_player_state and inserts into whs_score_records.
 *
 * @returns The updated HandicapRecalcResult or null if the player has no H.I. yet.
 */
export async function postScoreAndRecalculate(input: ScorePostingInput): Promise<{
  differential: number;
  esrAdjustment: number;
  finalDifferential: number;
  newHandicapIndex: number | null;
  phase: 1 | 2 | 3;
  recordId: number;
}> {
  // 1. Load or create player state
  let [state] = await db
    .select()
    .from(whsPlayerStateTable)
    .where(and(eq(whsPlayerStateTable.userId, input.userId), eq(whsPlayerStateTable.organizationId, input.organizationId)));

  if (!state) {
    const [inserted] = await db.insert(whsPlayerStateTable).values({
      userId: input.userId,
      organizationId: input.organizationId,
    }).returning();
    state = inserted;
  }

  const currentHI = state.currentHandicapIndex ? Number(state.currentHandicapIndex) : null;
  const currentLowHI = state.lowHandicapIndex ? Number(state.lowHandicapIndex) : null;
  const pcc = input.pcc ?? 0;

  // 2. Calculate raw differential based on holes played
  let rawDiff: number;
  if (input.holesPlayed >= 18) {
    rawDiff = scoreDifferential18(input.adjustedGrossScore, input.courseRating, input.slopeRating, pcc);
  } else if (input.holesPlayed === 9) {
    rawDiff = scoreDifferential9(input.adjustedGrossScore, input.courseRating / 2, input.slopeRating, currentHI ?? 0, pcc);
  } else {
    rawDiff = scoreDifferentialPartialRound(input.adjustedGrossScore, input.courseRating, input.slopeRating, input.holesPlayed, currentHI ?? 0, pcc);
  }

  // 3. Apply ESR
  const { rawDifferential, esrAdjustment, finalDifferential } = applyESR(rawDiff, currentHI);

  // 4. Load all existing differentials for this player+org
  const existingRecords = await db
    .select({ finalDifferential: whsScoreRecordsTable.finalDifferential })
    .from(whsScoreRecordsTable)
    .where(and(eq(whsScoreRecordsTable.userId, input.userId), eq(whsScoreRecordsTable.organizationId, input.organizationId)))
    .orderBy(desc(whsScoreRecordsTable.playedAt));

  const allDifferentials = [
    ...existingRecords.map(r => Number(r.finalDifferential)).filter(d => !isNaN(d)),
    finalDifferential,
  ];

  // 5. Recalculate H.I.
  const recalc = recalcHandicapIndex(allDifferentials, currentLowHI);

  // 6. Insert score record
  const [record] = await db.insert(whsScoreRecordsTable).values({
    userId: input.userId,
    organizationId: input.organizationId,
    courseId: input.courseId ?? null,
    sourceType: input.sourceType,
    sourceTournamentId: input.sourceTournamentId ?? null,
    sourceGeneralPlayId: input.sourceGeneralPlayId ?? null,
    holesPlayed: input.holesPlayed,
    grossScore: input.grossScore ?? null,
    adjustedGrossScore: input.adjustedGrossScore,
    courseRating: String(input.courseRating),
    slopeRating: input.slopeRating,
    pccAdjustment: String(pcc),
    rawDifferential: String(rawDifferential),
    esrAdjustment: String(esrAdjustment),
    finalDifferential: String(finalDifferential),
    is9Hole: input.holesPlayed === 9,
    markerName: input.markerName ?? null,
    markerGhinNumber: input.markerGhinNumber ?? null,
    handicapIndexAfter: recalc.cappedHandicapIndex != null ? String(recalc.cappedHandicapIndex) : null,
    playedAt: input.playedAt,
  }).returning({ id: whsScoreRecordsTable.id });

  // 7. Update player state
  const totalHolesPosted = state.totalHolesPosted + input.holesPlayed;
  const newPhase = recalc.phase;

  await db.update(whsPlayerStateTable).set({
    totalHolesPosted,
    establishmentPhase: newPhase,
    currentHandicapIndex: recalc.cappedHandicapIndex != null ? String(recalc.cappedHandicapIndex) : null,
    lowHandicapIndex: recalc.lowHandicapIndex != null ? String(recalc.lowHandicapIndex) : null,
    lowHandicapIndexDate: recalc.lowHandicapIndex != null &&
      (currentLowHI === null || recalc.lowHandicapIndex < currentLowHI)
      ? new Date() : state.lowHandicapIndexDate ?? undefined,
    isProvisional: recalc.isProvisional,
    lastRecalcAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(whsPlayerStateTable.id, state.id));

  logger.info({ userId: input.userId, orgId: input.organizationId, finalDifferential, newHI: recalc.cappedHandicapIndex, phase: newPhase }, "[whs-recalc] H.I. updated");

  return {
    differential: rawDifferential,
    esrAdjustment,
    finalDifferential,
    newHandicapIndex: recalc.cappedHandicapIndex,
    phase: recalc.phase,
    recordId: record.id,
  };
}

/**
 * Get a player's current WHS state for an organisation.
 */
export async function getWhsPlayerState(userId: number, organizationId: number) {
  const [state] = await db
    .select()
    .from(whsPlayerStateTable)
    .where(and(eq(whsPlayerStateTable.userId, userId), eq(whsPlayerStateTable.organizationId, organizationId)));
  return state ?? null;
}

/**
 * Get the last 20 score records for a player (most recent first).
 */
export async function getRecentScoreRecords(userId: number, organizationId: number, limit = 20) {
  const rows = await db
    .select({
      id: whsScoreRecordsTable.id,
      userId: whsScoreRecordsTable.userId,
      organizationId: whsScoreRecordsTable.organizationId,
      courseId: whsScoreRecordsTable.courseId,
      sourceType: whsScoreRecordsTable.sourceType,
      sourceTournamentId: whsScoreRecordsTable.sourceTournamentId,
      sourceGeneralPlayId: whsScoreRecordsTable.sourceGeneralPlayId,
      holesPlayed: whsScoreRecordsTable.holesPlayed,
      grossScore: whsScoreRecordsTable.grossScore,
      adjustedGrossScore: whsScoreRecordsTable.adjustedGrossScore,
      courseRating: whsScoreRecordsTable.courseRating,
      slopeRating: whsScoreRecordsTable.slopeRating,
      pccAdjustment: whsScoreRecordsTable.pccAdjustment,
      rawDifferential: whsScoreRecordsTable.rawDifferential,
      esrAdjustment: whsScoreRecordsTable.esrAdjustment,
      finalDifferential: whsScoreRecordsTable.finalDifferential,
      is9Hole: whsScoreRecordsTable.is9Hole,
      markerName: whsScoreRecordsTable.markerName,
      markerGhinNumber: whsScoreRecordsTable.markerGhinNumber,
      handicapIndexAfter: whsScoreRecordsTable.handicapIndexAfter,
      playedAt: whsScoreRecordsTable.playedAt,
      postedAt: whsScoreRecordsTable.postedAt,
      courseName: coursesTable.name,
      tournamentName: tournamentsTable.name,
    })
    .from(whsScoreRecordsTable)
    .leftJoin(coursesTable, eq(whsScoreRecordsTable.courseId, coursesTable.id))
    .leftJoin(tournamentsTable, eq(whsScoreRecordsTable.sourceTournamentId, tournamentsTable.id))
    .where(and(eq(whsScoreRecordsTable.userId, userId), eq(whsScoreRecordsTable.organizationId, organizationId)))
    .orderBy(desc(whsScoreRecordsTable.playedAt))
    .limit(limit);
  return rows;
}

/**
 * Get PCC for a course on a specific date (returns 0 if not found).
 */
export async function getPccForCourseDate(courseId: number, date: Date): Promise<number> {
  const dateStr = date.toISOString().split("T")[0];
  const [entry] = await db
    .select({ pccValue: whsPccEntriesTable.pccValue })
    .from(whsPccEntriesTable)
    .where(and(
      eq(whsPccEntriesTable.courseId, courseId),
    ));
  return entry ? Number(entry.pccValue) : 0;
}
