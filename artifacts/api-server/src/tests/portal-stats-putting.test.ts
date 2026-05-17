/**
 * Task #720 — automated coverage for the `putting` block on
 * GET /api/portal/stats.
 *
 * The route aggregates 1-putt and 3+-putt counts from BOTH tournament
 * `scores.putts` and confirmed-general-play `general_play_hole_scores.putts`
 * (around lines 2563–2602 of `src/routes/portal.ts`). It then exposes:
 *
 *   putting: {
 *     holesTracked,                  // = totalPuttOps (denominator)
 *     onePutts, threePlusPutts,
 *     onePuttPct, threePlusPuttPct,  // rounded percentages, or null when 0 ops
 *   }
 *
 * Without coverage, a future change to either putt schema (e.g. dropping
 * `null`-handling, switching to a different status enum, or moving the
 * GP hole-score table) could silently zero out the player stats screen.
 *
 * These tests pin the contract:
 *
 *   1. Mixed tournament + general play data — counts and percentages
 *      combine BOTH sources, and unconfirmed GP rounds are excluded.
 *   2. Holes with `putts = null` are excluded from the denominator
 *      (and from the 1-putt / 3+-putt numerators).
 *   3. When no putts have been recorded at all, percentages are `null`
 *      (not `0`, not `NaN`) and `holesTracked` is 0.
 *   4. Percentage rounding uses standard Math.round (e.g. 4/12 → 33,
 *      2/12 → 17, demonstrating both round-down and round-up).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  scoresTable,
  appUsersTable,
  generalPlayRoundsTable,
  generalPlayHoleScoresTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let mixOrgId: number;
let mixCourseId: number;
let mixTournamentId: number;
let mixUserId: number;
let mixPlayerId: number;
let mixGpRoundId: number;
let mixGpDraftRoundId: number;

let emptyOrgId: number;
let emptyCourseId: number;
let emptyTournamentId: number;
let emptyUserId: number;
let emptyPlayerId: number;

beforeAll(async () => {
  const stamp = Date.now();

  // ── Fixture A: mixed tournament + general play data ─────────────────
  const [orgA] = await db.insert(organizationsTable).values({
    name: `T720_mix_${stamp}`,
    slug: `t720-mix-${stamp}`,
  }).returning({ id: organizationsTable.id });
  mixOrgId = orgA.id;

  const [courseA] = await db.insert(coursesTable).values({
    organizationId: mixOrgId,
    name: "T720 Mix Course",
    slug: `t720-mix-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  mixCourseId = courseA.id;

  const [tournamentA] = await db.insert(tournamentsTable).values({
    organizationId: mixOrgId,
    courseId: mixCourseId,
    name: `T720 Mix Tournament ${stamp}`,
    status: "completed",
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  mixTournamentId = tournamentA.id;

  const [userA] = await db.insert(appUsersTable).values({
    replitUserId: `t720-mix-${stamp}`,
    username: `t720_mix_${stamp}`,
    email: `t720-mix-${stamp}@example.test`,
  }).returning({ id: appUsersTable.id });
  mixUserId = userA.id;

  const [playerA] = await db.insert(playersTable).values({
    tournamentId: mixTournamentId,
    userId: mixUserId,
    firstName: "Pat",
    lastName: "Putter",
    email: `t720-mix-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  mixPlayerId = playerA.id;

  // Tournament scores: 9 holes (≥9 needed to count as a "completed round"
  // for the putt-ops denominator). Putts pattern designed to exercise the
  // 1-putt counter, the 3+-putt counter, and the null-exclusion path.
  //   putts: [1, 1, 1, 2, 2, 2, 2, 3, null]
  //   → puttOps = 8, onePutts = 3, threePlusPutts = 1
  const tournamentPutts: Array<number | null> = [1, 1, 1, 2, 2, 2, 2, 3, null];
  const now = new Date();
  await db.insert(scoresTable).values(
    tournamentPutts.map((p, i) => ({
      tournamentId: mixTournamentId,
      playerId: mixPlayerId,
      round: 1,
      holeNumber: i + 1,
      strokes: 4,
      putts: p,
      submittedAt: now,
      updatedAt: now,
    })),
  );

  // Confirmed general-play round — its hole scores must be folded into
  // the same putting block.
  //   putts: [1, 2, 3, null, 2]
  //   → puttOps = 4, onePutts = 1, threePlusPutts = 1
  const [gpRound] = await db.insert(generalPlayRoundsTable).values({
    userId: mixUserId,
    organizationId: mixOrgId,
    courseId: mixCourseId,
    holesPlayed: 18,
    status: "confirmed",
  }).returning({ id: generalPlayRoundsTable.id });
  mixGpRoundId = gpRound.id;

  const gpPutts: Array<number | null> = [1, 2, 3, null, 2];
  await db.insert(generalPlayHoleScoresTable).values(
    gpPutts.map((p, i) => ({
      roundId: mixGpRoundId,
      holeNumber: i + 1,
      strokes: 4,
      putts: p,
    })),
  );

  // Draft / unconfirmed GP round — its putts must NOT be included.
  // If the route ever drops the status='confirmed' filter, this row will
  // skew onePutts upward and the test will fail.
  const [gpDraft] = await db.insert(generalPlayRoundsTable).values({
    userId: mixUserId,
    organizationId: mixOrgId,
    courseId: mixCourseId,
    holesPlayed: 18,
    status: "draft",
  }).returning({ id: generalPlayRoundsTable.id });
  mixGpDraftRoundId = gpDraft.id;

  await db.insert(generalPlayHoleScoresTable).values(
    [1, 1, 1, 1].map((p, i) => ({
      roundId: mixGpDraftRoundId,
      holeNumber: i + 1,
      strokes: 4,
      putts: p,
    })),
  );

  // ── Fixture B: a player with no putts recorded anywhere ─────────────
  const [orgB] = await db.insert(organizationsTable).values({
    name: `T720_empty_${stamp}`,
    slug: `t720-empty-${stamp}`,
  }).returning({ id: organizationsTable.id });
  emptyOrgId = orgB.id;

  const [courseB] = await db.insert(coursesTable).values({
    organizationId: emptyOrgId,
    name: "T720 Empty Course",
    slug: `t720-empty-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  emptyCourseId = courseB.id;

  const [tournamentB] = await db.insert(tournamentsTable).values({
    organizationId: emptyOrgId,
    courseId: emptyCourseId,
    name: `T720 Empty Tournament ${stamp}`,
    status: "completed",
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  emptyTournamentId = tournamentB.id;

  const [userB] = await db.insert(appUsersTable).values({
    replitUserId: `t720-empty-${stamp}`,
    username: `t720_empty_${stamp}`,
    email: `t720-empty-${stamp}@example.test`,
  }).returning({ id: appUsersTable.id });
  emptyUserId = userB.id;

  const [playerB] = await db.insert(playersTable).values({
    tournamentId: emptyTournamentId,
    userId: emptyUserId,
    firstName: "Nora",
    lastName: "NoPutts",
    email: `t720-empty-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  emptyPlayerId = playerB.id;

  // 9 holes, every putts column null → no putt operations recorded.
  await db.insert(scoresTable).values(
    Array.from({ length: 9 }, (_, i) => ({
      tournamentId: emptyTournamentId,
      playerId: emptyPlayerId,
      round: 1,
      holeNumber: i + 1,
      strokes: 4,
      putts: null,
      submittedAt: now,
      updatedAt: now,
    })),
  );
});

afterAll(async () => {
  // Mixed fixture
  await db.delete(generalPlayHoleScoresTable).where(eq(generalPlayHoleScoresTable.roundId, mixGpRoundId));
  await db.delete(generalPlayHoleScoresTable).where(eq(generalPlayHoleScoresTable.roundId, mixGpDraftRoundId));
  await db.delete(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, mixGpRoundId));
  await db.delete(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, mixGpDraftRoundId));
  await db.delete(scoresTable).where(eq(scoresTable.tournamentId, mixTournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, mixTournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, mixTournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, mixCourseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, mixUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, mixOrgId));

  // Empty fixture
  await db.delete(scoresTable).where(eq(scoresTable.tournamentId, emptyTournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, emptyTournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, emptyTournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, emptyCourseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, emptyUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, emptyOrgId));
});

function appAs(userId: number, username: string) {
  // No `organizationId` on the test user → the mobileApp feature gate is
  // bypassed (super-admin / no-org-context branch in gateFeatureFromSession).
  return createTestApp({ id: userId, username, role: "member" });
}

describe("GET /portal/stats — putting block (Task #720)", () => {
  it("aggregates 1-putt + 3+-putt counts from tournament AND confirmed general-play data, ignoring unconfirmed GP rounds", async () => {
    const res = await request(appAs(mixUserId, "t720_mix"))
      .get("/api/portal/stats");

    expect(res.status).toBe(200);
    expect(res.body.putting).toBeDefined();

    // Tournament: putts [1,1,1,2,2,2,2,3,null]  → ops 8, 1-putts 3, 3+-putts 1
    // GP confirmed: putts [1,2,3,null,2]        → ops 4, 1-putts 1, 3+-putts 1
    // GP draft (status≠'confirmed') is excluded entirely.
    // Combined: ops 12, 1-putts 4, 3+-putts 2.
    expect(res.body.putting).toMatchObject({
      holesTracked: 12,
      onePutts: 4,
      threePlusPutts: 2,
    });
  });

  it("rounds the percentages with Math.round (4/12 → 33, 2/12 → 17)", async () => {
    const res = await request(appAs(mixUserId, "t720_mix"))
      .get("/api/portal/stats");

    expect(res.status).toBe(200);
    // 4/12 = 33.333… → 33 (rounds DOWN)
    // 2/12 = 16.666… → 17 (rounds UP)
    // This pins both the rounding direction and the choice of denominator.
    expect(res.body.putting.onePuttPct).toBe(33);
    expect(res.body.putting.threePlusPuttPct).toBe(17);
  });

  it("excludes holes with no putts recorded from the denominator", async () => {
    const res = await request(appAs(mixUserId, "t720_mix"))
      .get("/api/portal/stats");

    // The mixed fixture has 9 tournament holes + 5 GP holes = 14 hole rows
    // total, but two of those rows have putts=null. holesTracked must
    // therefore be 12, not 14 — null-putts must NOT inflate the denominator.
    expect(res.body.putting.holesTracked).toBe(12);
    // And the null rows must not bleed into either putt-count bucket
    // (putts=null is neither a 1-putt nor a 3+-putt).
    expect(res.body.putting.onePutts + res.body.putting.threePlusPutts).toBeLessThanOrEqual(12);
  });

  it("returns null percentages (not 0, not NaN) when no putts have been recorded", async () => {
    const res = await request(appAs(emptyUserId, "t720_empty"))
      .get("/api/portal/stats");

    expect(res.status).toBe(200);
    expect(res.body.putting).toEqual({
      holesTracked: 0,
      onePutts: 0,
      threePlusPutts: 0,
      onePuttPct: null,
      threePlusPuttPct: null,
    });
  });
});
