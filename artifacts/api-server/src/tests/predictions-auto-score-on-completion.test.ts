/**
 * Integration test: Auto-score predictions on tournament completion (Task #452, coverage Task #502)
 *
 * Seeds a tournament with players, hole-by-hole scores, and a few prediction
 * rows, then transitions the tournament to `completed` via the public PUT
 * endpoint and asserts:
 *
 *   1. Every prediction row gains `score`, `scoreBreakdown`, and `scoredAt`.
 *   2. The point totals match the rules in `scorePrediction`
 *      (winner = 25, each top-5 hit = 5 capped at 25, low-round = max(0, 10 - |diff|)).
 *   3. Re-completing the tournament does NOT double-score: the existing
 *      `scoredAt` timestamp is preserved (idempotent) and totals are unchanged.
 *
 * The mailer + push/comms modules are mocked so no real notifications fire,
 * and we wait briefly after each PUT for the `setImmediate` background hook
 * to settle.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/mailer.js", () => ({
  sendTournamentRecapEmail: vi.fn(async () => undefined),
  sendTournamentResultsEmail: vi.fn(async () => undefined),
  sendWaitlistPromotionEmail: vi.fn(async () => undefined),
  sendPredictionResultsEmail: vi.fn(async () => undefined),
}));

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
  sendTransactionalSms: vi.fn(async () => undefined),
  sendTransactionalEmail: vi.fn(async () => undefined),
}));

vi.mock(import("../lib/webhookDispatch.js"), async (orig) => ({
  ...(await orig()),
  dispatchWebhookEvent: vi.fn(async () => undefined),
}));

vi.mock("../lib/cross-club-ladder-feed.js", () => ({
  creditTournamentResultsToLadders: vi.fn(async () => undefined),
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  holeDetailsTable,
  tournamentsTable,
  playersTable,
  scoresTable,
  appUsersTable,
  tournamentPredictionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let testOrgId: number;
let testCourseId: number;
let testTournamentId: number;
const playerIds: number[] = [];
const userIds: number[] = [];
const predictionIds: number[] = [];

/** Poll the DB until every prediction row for the test tournament satisfies
 *  the predicate, or fail loudly after the timeout. We poll instead of using
 *  a fixed sleep so the test stays deterministic under slow CI conditions
 *  where the PUT handler's background `setImmediate` hook may take longer
 *  than a fixed delay to finish. */
async function waitForPredictions(
  predicate: (rows: Array<{ score: number | null; scoredAt: Date | null }>) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastRows: Array<{ score: number | null; scoredAt: Date | null }> = [];
  while (Date.now() < deadline) {
    lastRows = await db
      .select({
        score: tournamentPredictionsTable.score,
        scoredAt: tournamentPredictionsTable.scoredAt,
      })
      .from(tournamentPredictionsTable)
      .where(eq(tournamentPredictionsTable.tournamentId, testTournamentId));
    if (predicate(lastRows)) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(
    `waitForPredictions timed out after ${timeoutMs}ms. Last rows: ${JSON.stringify(lastRows)}`,
  );
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_PredAutoScore_${stamp}`,
    slug: `test-pred-autoscore-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Auto-Score Test Course",
    slug: `auto-score-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  // Hole details (par 4 each) — required so `computeLeaderboard` can compute
  // score-to-par for the ranking sort that drives winnerPlayerId/top5.
  for (let h = 1; h <= 18; h++) {
    await db.insert(holeDetailsTable).values({
      courseId: testCourseId,
      holeNumber: h,
      par: 4,
    });
  }

  // Tournament starts in `upcoming`; we'll PUT it to `completed` to fire the hook.
  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Auto-Score Test Tournament ${stamp}`,
    format: "stroke_play",
    status: "upcoming",
    rounds: 1,
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(),
    maxPlayers: 16,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = tournament.id;

  // Six players. Strokes-per-hole picked so each round total is unique:
  //   P1=3*18=54, P2=4*18=72, P3=5*18=90, P4=5*18=90, P5=5*18=90, P6=6*18=108
  // After ranking by score-to-par the order is P1, then P2, then any of P3/P4/P5,
  // then P6. That makes winnerPlayerId === P1 and the top-5 set === {P1..P5}.
  const playerStrokes = [3, 4, 5, 5, 5, 6];
  for (let i = 0; i < playerStrokes.length; i++) {
    const [p] = await db.insert(playersTable).values({
      tournamentId: testTournamentId,
      firstName: `Player${i + 1}`,
      lastName: "AutoScore",
    }).returning({ id: playersTable.id });
    playerIds.push(p.id);

    for (let h = 1; h <= 18; h++) {
      await db.insert(scoresTable).values({
        tournamentId: testTournamentId,
        playerId: p.id,
        round: 1,
        holeNumber: h,
        strokes: playerStrokes[i],
      });
    }
  }

  // Three users to attach predictions to. Each prediction belongs to a unique
  // user so the (tournamentId, userId) unique index is satisfied.
  for (let i = 0; i < 3; i++) {
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `pred-autoscore-${stamp}-${i}`,
      username: `pred_autoscore_${stamp}_${i}`,
      email: `pred_autoscore_${stamp}_${i}@example.com`,
      displayName: `Pred Tester ${i}`,
    }).returning({ id: appUsersTable.id });
    userIds.push(u.id);
  }

  const [P1, P2, P3, P4, P5, P6] = playerIds;

  // Prediction A — perfect: winner P1, top5 exact, lowRound 54 → 25 + 25 + 10 = 60
  const [predA] = await db.insert(tournamentPredictionsTable).values({
    tournamentId: testTournamentId,
    userId: userIds[0],
    predictedWinnerPlayerId: P1,
    predictedTop5: [P1, P2, P3, P4, P5],
    predictedLowRound: 54,
    displayName: "Perfect Pat",
  }).returning({ id: tournamentPredictionsTable.id });
  predictionIds.push(predA.id);

  // Prediction B — partially right: wrong winner, 4 of 5 top-5 hits,
  // lowRound off by 2 → 0 + 20 + 8 = 28
  const [predB] = await db.insert(tournamentPredictionsTable).values({
    tournamentId: testTournamentId,
    userId: userIds[1],
    predictedWinnerPlayerId: P2,
    predictedTop5: [P1, P2, P3, P4, P6],
    predictedLowRound: 56,
    displayName: "Partial Pam",
  }).returning({ id: tournamentPredictionsTable.id });
  predictionIds.push(predB.id);

  // Prediction C — winner only: correct winner, no top-5 hits, no lowRound
  // → 25 + 0 + 0 = 25
  const [predC] = await db.insert(tournamentPredictionsTable).values({
    tournamentId: testTournamentId,
    userId: userIds[2],
    predictedWinnerPlayerId: P1,
    predictedTop5: [],
    predictedLowRound: null,
    displayName: "Winner-Only Wendy",
  }).returning({ id: tournamentPredictionsTable.id });
  predictionIds.push(predC.id);
});

afterAll(async () => {
  for (const id of predictionIds) {
    await db.delete(tournamentPredictionsTable).where(eq(tournamentPredictionsTable.id, id));
  }
  for (const id of userIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  await db.delete(scoresTable).where(eq(scoresTable.tournamentId, testTournamentId));
  for (const id of playerIds) {
    await db.delete(playersTable).where(eq(playersTable.id, id));
  }
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, testTournamentId));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, testCourseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

describe("auto-score predictions when tournament transitions to completed", () => {
  it("scores every prediction with the correct totals & breakdowns once the PUT marks the tournament completed", async () => {
    const app = createTestApp({
      id: 999_001,
      username: "auto_score_admin",
      role: "super_admin",
    });

    const res = await request(app)
      .put(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}`)
      .send({
        name: `Auto-Score Test Tournament UPDATED`,
        format: "stroke_play",
        rounds: 1,
        status: "completed",
      });
    expect(res.status).toBe(200);

    // Wait until every seeded prediction row has been scored by the
    // background hook before reading the full rows for assertions.
    await waitForPredictions(rows =>
      rows.length === predictionIds.length && rows.every(r => r.score != null && r.scoredAt != null),
    );

    const rows = await db
      .select()
      .from(tournamentPredictionsTable)
      .where(eq(tournamentPredictionsTable.tournamentId, testTournamentId));

    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.score, `prediction ${r.id} should have a score`).not.toBeNull();
      expect(r.scoreBreakdown, `prediction ${r.id} should have a breakdown`).not.toBeNull();
      expect(r.scoredAt, `prediction ${r.id} should have scoredAt set`).toBeInstanceOf(Date);
    }

    const byId = new Map(rows.map(r => [r.id, r]));
    const [predAId, predBId, predCId] = predictionIds;

    const a = byId.get(predAId)!;
    expect(a.score).toBe(60);
    expect(a.scoreBreakdown).toEqual({ winner: 25, top5: 25, lowRound: 10 });

    const b = byId.get(predBId)!;
    expect(b.score).toBe(28);
    expect(b.scoreBreakdown).toEqual({ winner: 0, top5: 20, lowRound: 8 });

    const c = byId.get(predCId)!;
    expect(c.score).toBe(25);
    expect(c.scoreBreakdown).toEqual({ winner: 25, top5: 0, lowRound: 0 });
  });

  it("does not double-score when the tournament is re-completed", async () => {
    const app = createTestApp({
      id: 999_001,
      username: "auto_score_admin",
      role: "super_admin",
    });

    // Snapshot scoredAt timestamps from the first completion.
    const before = await db
      .select({
        id: tournamentPredictionsTable.id,
        score: tournamentPredictionsTable.score,
        scoredAt: tournamentPredictionsTable.scoredAt,
      })
      .from(tournamentPredictionsTable)
      .where(eq(tournamentPredictionsTable.tournamentId, testTournamentId));
    const beforeById = new Map(before.map(r => [r.id, r]));

    // Drop back to `upcoming` directly in the DB (going via PUT to "active"
    // would trip the active-tournament plan-limit gate, which is unrelated to
    // this test). Then re-complete via PUT — the auto-score hook fires on the
    // status transition, and `scorePredictionsForTournament` skips already-
    // scored rows (force=false) so timestamps must not change.
    await db
      .update(tournamentsTable)
      .set({ status: "upcoming" })
      .where(eq(tournamentsTable.id, testTournamentId));

    const again = await request(app)
      .put(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}`)
      .send({
        name: `Auto-Score Test Tournament UPDATED`,
        format: "stroke_play",
        rounds: 1,
        status: "completed",
      });
    expect(again.status).toBe(200);

    // The re-completion's background hook runs in `setImmediate`, so we
    // can't poll for a state change (an idempotent re-run produces none).
    // Drain the event loop a few times and give the hook a comfortable
    // window to attempt — and finish — any DB writes it intends to do.
    // If the hook were buggy and re-scored, those writes would land here.
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setImmediate(r));
    }
    await new Promise(r => setTimeout(r, 500));

    const after = await db
      .select({
        id: tournamentPredictionsTable.id,
        score: tournamentPredictionsTable.score,
        scoredAt: tournamentPredictionsTable.scoredAt,
      })
      .from(tournamentPredictionsTable)
      .where(eq(tournamentPredictionsTable.tournamentId, testTournamentId));

    expect(after).toHaveLength(before.length);
    for (const row of after) {
      const prior = beforeById.get(row.id)!;
      // Score totals are unchanged.
      expect(row.score).toBe(prior.score);
      // And critically: scoredAt is the ORIGINAL timestamp — the row was
      // skipped by the idempotent re-run, not re-written.
      expect(row.scoredAt?.getTime()).toBe(prior.scoredAt?.getTime());
    }
  });
});
