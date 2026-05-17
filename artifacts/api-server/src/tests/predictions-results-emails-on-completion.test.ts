/**
 * Integration test: Fan results emails fire when a tournament completes
 * (Task #501, coverage Task #678).
 *
 * Companion to `predictions-auto-score-on-completion.test.ts`. That test
 * proves the *scoring* side of the completion hook; this test proves the
 * *email* side that the scoring test intentionally mocks out, so a
 * regression that silently stops sending the "you scored X, ranked #Y of Z"
 * emails would now fail loudly instead of leaving fans in the dark.
 *
 * What we assert:
 *   1. After PUT /tournaments/:id transitions a tournament to `completed`,
 *      `sendPredictionResultsEmail` is called once per eligible fan with
 *      the right rank/total/score/breakdown payload.
 *   2. `tournament_predictions.results_email_sent_at` is stamped for every
 *      row processed through the completion hook — three from a real send,
 *      and the erased-user row from the documented short-circuit branch
 *      that stamps without sending so the retry sweep doesn't keep
 *      pestering an undeliverable address.
 *   3. Re-completing the tournament does NOT trigger a second email for
 *      any row (idempotency via `results_email_sent_at`).
 *   4. A truly ineligible row — one whose `score` is still `null` when the
 *      email dispatcher runs (the only branch that leaves `resultsEmailSentAt`
 *      `null`) — is neither emailed nor stamped. This is asserted by calling
 *      `sendPredictionResultsEmails` directly against a pre-inserted unscored
 *      row, since the live PUT hook always runs scoring first and so cannot
 *      naturally produce an unscored row to test against.
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
import { eq, inArray } from "drizzle-orm";
import { sendPredictionResultsEmail } from "../lib/mailer.js";
import { sendPredictionResultsEmails } from "../lib/odds.js";
import { createTestApp } from "./helpers.js";

const sendPredictionResultsEmailMock = vi.mocked(sendPredictionResultsEmail);

let testOrgId: number;
let testCourseId: number;
let testTournamentId: number;
const playerIds: number[] = [];
const userIds: number[] = [];
const predictionIds: number[] = [];
let erasedUserId: number;
let erasedPredictionId: number;

/** Poll the DB until every prediction row for the test tournament has a
 *  non-null `results_email_sent_at` (the proxy for "the email-side hook
 *  has finished its work"), or fail loudly. We poll instead of sleeping
 *  to keep the test deterministic on slow CI. */
async function waitForResultsEmailsDispatched(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastRows: Array<{ id: number; resultsEmailSentAt: Date | null }> = [];
  while (Date.now() < deadline) {
    lastRows = await db
      .select({
        id: tournamentPredictionsTable.id,
        resultsEmailSentAt: tournamentPredictionsTable.resultsEmailSentAt,
      })
      .from(tournamentPredictionsTable)
      .where(eq(tournamentPredictionsTable.tournamentId, testTournamentId));
    if (
      lastRows.length === predictionIds.length &&
      lastRows.every(r => r.resultsEmailSentAt != null)
    ) {
      return;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(
    `waitForResultsEmailsDispatched timed out after ${timeoutMs}ms. Last rows: ${JSON.stringify(lastRows)}`,
  );
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_PredEmail_${stamp}`,
    slug: `test-pred-email-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Pred-Email Test Course",
    slug: `pred-email-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  for (let h = 1; h <= 18; h++) {
    await db.insert(holeDetailsTable).values({
      courseId: testCourseId,
      holeNumber: h,
      par: 4,
    });
  }

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Pred-Email Test Tournament ${stamp}`,
    format: "stroke_play",
    status: "upcoming",
    rounds: 1,
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(),
    maxPlayers: 16,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = tournament.id;

  // Same scoring layout as the auto-score test: P1 wins outright at -18,
  // P2 second at par, P3..P5 tied above par, P6 last. That makes the
  // top-5 deterministic and the low single-round score = 54.
  const playerStrokes = [3, 4, 5, 5, 5, 6];
  for (let i = 0; i < playerStrokes.length; i++) {
    const [p] = await db.insert(playersTable).values({
      tournamentId: testTournamentId,
      firstName: `Player${i + 1}`,
      lastName: "PredEmail",
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

  // Four users: three eligible fans + one whose account has been erased
  // (Task #467). The erased user must NOT receive an email but their row
  // gets stamped so the idempotent retry path stops chasing them.
  for (let i = 0; i < 3; i++) {
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `pred-email-${stamp}-${i}`,
      username: `pred_email_${stamp}_${i}`,
      email: `pred_email_${stamp}_${i}@example.com`,
      displayName: `Email Tester ${i}`,
    }).returning({ id: appUsersTable.id });
    userIds.push(u.id);
  }
  const [erased] = await db.insert(appUsersTable).values({
    replitUserId: `pred-email-${stamp}-erased`,
    username: `pred_email_${stamp}_erased`,
    email: `pred_email_${stamp}_erased@example.com`,
    displayName: `Erased User`,
    erasedAt: new Date(),
  }).returning({ id: appUsersTable.id });
  erasedUserId = erased.id;

  const [P1, P2, P3, P4, P5, P6] = playerIds;

  // Pred A — perfect: 25 + 25 + 10 = 60  → rank 1 of 4
  const [predA] = await db.insert(tournamentPredictionsTable).values({
    tournamentId: testTournamentId,
    userId: userIds[0],
    predictedWinnerPlayerId: P1,
    predictedTop5: [P1, P2, P3, P4, P5],
    predictedLowRound: 54,
    displayName: "Perfect Pat",
  }).returning({ id: tournamentPredictionsTable.id });
  predictionIds.push(predA.id);

  // Pred B — partial: 0 + 20 + 8 = 28  → rank 2 of 4
  const [predB] = await db.insert(tournamentPredictionsTable).values({
    tournamentId: testTournamentId,
    userId: userIds[1],
    predictedWinnerPlayerId: P2,
    predictedTop5: [P1, P2, P3, P4, P6],
    predictedLowRound: 56,
    displayName: "Partial Pam",
  }).returning({ id: tournamentPredictionsTable.id });
  predictionIds.push(predB.id);

  // Pred C — winner only: 25 + 0 + 0 = 25  → rank 3 of 4
  const [predC] = await db.insert(tournamentPredictionsTable).values({
    tournamentId: testTournamentId,
    userId: userIds[2],
    predictedWinnerPlayerId: P1,
    predictedTop5: [],
    predictedLowRound: null,
    displayName: "Winner-Only Wendy",
  }).returning({ id: tournamentPredictionsTable.id });
  predictionIds.push(predC.id);

  // Pred D — belongs to the erased user. Will be scored (25) but must NOT
  // receive an email; its `results_email_sent_at` is stamped to short-
  // circuit the retry loop on subsequent sweeps.
  const [predD] = await db.insert(tournamentPredictionsTable).values({
    tournamentId: testTournamentId,
    userId: erasedUserId,
    predictedWinnerPlayerId: P1,
    predictedTop5: [],
    predictedLowRound: null,
    displayName: "Erased Eric",
  }).returning({ id: tournamentPredictionsTable.id });
  predictionIds.push(predD.id);
  erasedPredictionId = predD.id;
});

afterAll(async () => {
  for (const id of predictionIds) {
    await db.delete(tournamentPredictionsTable).where(eq(tournamentPredictionsTable.id, id));
  }
  const allUserIds = [...userIds, erasedUserId].filter((x): x is number => typeof x === "number");
  if (allUserIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, allUserIds));
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

describe("prediction results emails dispatched on tournament completion", () => {
  it("emails every eligible fan their score + rank when the PUT marks the tournament completed", async () => {
    sendPredictionResultsEmailMock.mockClear();

    const app = createTestApp({
      id: 999_002,
      username: "pred_email_admin",
      role: "super_admin",
    });

    const res = await request(app)
      .put(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}`)
      .send({
        name: `Pred-Email Test Tournament UPDATED`,
        format: "stroke_play",
        rounds: 1,
        status: "completed",
      });
    expect(res.status).toBe(200);

    await waitForResultsEmailsDispatched();

    // Three eligible fans → exactly three real send attempts. The erased
    // user's row was stamped without invoking the mailer.
    expect(sendPredictionResultsEmailMock).toHaveBeenCalledTimes(3);

    const callsByEmail = new Map(
      sendPredictionResultsEmailMock.mock.calls.map(([opts]) => [opts.to, opts]),
    );

    // Erased user must NEVER appear as a recipient.
    const [erasedUser] = await db
      .select({ email: appUsersTable.email })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, erasedUserId));
    expect(callsByEmail.has(erasedUser.email!)).toBe(false);

    // Look up the three eligible users by id so we can assert per-fan payloads.
    const eligibleUsers = await db
      .select({ id: appUsersTable.id, email: appUsersTable.email })
      .from(appUsersTable)
      .where(inArray(appUsersTable.id, userIds));
    const emailById = new Map(eligibleUsers.map(u => [u.id, u.email!]));

    const [predAId, predBId, predCId] = predictionIds;

    // Pred A — Perfect Pat → 60 pts, rank 1 of 4
    const aCall = callsByEmail.get(emailById.get(userIds[0])!);
    expect(aCall, "Perfect Pat should receive an email").toBeDefined();
    expect(aCall!.score).toBe(60);
    expect(aCall!.rank).toBe(1);
    expect(aCall!.totalEntries).toBe(4);
    expect(aCall!.breakdown).toEqual({ winner: 25, top5: 25, lowRound: 10 });
    expect(aCall!.name).toBe("Perfect Pat");
    expect(aCall!.tournamentName).toContain("Pred-Email Test Tournament");
    expect(aCall!.leaderboardUrl).toContain(`/leaderboard/${testTournamentId}`);

    // Pred B — Partial Pam → 28 pts, rank 2 of 4
    const bCall = callsByEmail.get(emailById.get(userIds[1])!);
    expect(bCall, "Partial Pam should receive an email").toBeDefined();
    expect(bCall!.score).toBe(28);
    expect(bCall!.rank).toBe(2);
    expect(bCall!.totalEntries).toBe(4);
    expect(bCall!.breakdown).toEqual({ winner: 0, top5: 20, lowRound: 8 });
    expect(bCall!.name).toBe("Partial Pam");

    // Pred C — Winner-Only Wendy → 25 pts. Tied with the erased user's
    // 25 pts so standard "1224" ranking puts them both at rank 3 of 4.
    const cCall = callsByEmail.get(emailById.get(userIds[2])!);
    expect(cCall, "Winner-Only Wendy should receive an email").toBeDefined();
    expect(cCall!.score).toBe(25);
    expect(cCall!.rank).toBe(3);
    expect(cCall!.totalEntries).toBe(4);
    expect(cCall!.breakdown).toEqual({ winner: 25, top5: 0, lowRound: 0 });
    expect(cCall!.name).toBe("Winner-Only Wendy");

    // Every seeded row has `results_email_sent_at` stamped — three from a
    // real send, the erased one from the short-circuit branch that
    // prevents repeated retries against an undeliverable address.
    const rows = await db
      .select({
        id: tournamentPredictionsTable.id,
        resultsEmailSentAt: tournamentPredictionsTable.resultsEmailSentAt,
      })
      .from(tournamentPredictionsTable)
      .where(eq(tournamentPredictionsTable.tournamentId, testTournamentId));
    expect(rows).toHaveLength(predictionIds.length);
    for (const r of rows) {
      expect(r.resultsEmailSentAt, `prediction ${r.id} should be stamped`).toBeInstanceOf(Date);
    }
    const stampedIds = new Set(rows.map(r => r.id));
    for (const pid of [predAId, predBId, predCId, erasedPredictionId]) {
      expect(stampedIds.has(pid)).toBe(true);
    }
  });

  it("does not re-send any email when the tournament is re-completed", async () => {
    sendPredictionResultsEmailMock.mockClear();

    // Snapshot stamps so we can prove the idempotent re-run did not touch them.
    const before = await db
      .select({
        id: tournamentPredictionsTable.id,
        resultsEmailSentAt: tournamentPredictionsTable.resultsEmailSentAt,
      })
      .from(tournamentPredictionsTable)
      .where(eq(tournamentPredictionsTable.tournamentId, testTournamentId));
    const beforeById = new Map(before.map(r => [r.id, r.resultsEmailSentAt]));

    // Drop back to `upcoming` directly (going via PUT to "active" trips an
    // unrelated plan-limit gate). Then re-complete via PUT — the email
    // hook fires again, but every row already has `resultsEmailSentAt`
    // set, so `sendPredictionResultsEmail` must not be called.
    await db
      .update(tournamentsTable)
      .set({ status: "upcoming" })
      .where(eq(tournamentsTable.id, testTournamentId));

    const app = createTestApp({
      id: 999_002,
      username: "pred_email_admin",
      role: "super_admin",
    });
    const again = await request(app)
      .put(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}`)
      .send({
        name: `Pred-Email Test Tournament UPDATED`,
        format: "stroke_play",
        rounds: 1,
        status: "completed",
      });
    expect(again.status).toBe(200);

    // The hook runs in `setImmediate`. An idempotent re-run produces no
    // observable state change, so we can't poll for one — drain the event
    // loop and give the hook a comfortable window to attempt any work.
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setImmediate(r));
    }
    await new Promise(r => setTimeout(r, 500));

    expect(sendPredictionResultsEmailMock).not.toHaveBeenCalled();

    // Stamps on the rows are unchanged — the rows were skipped, not re-written.
    const after = await db
      .select({
        id: tournamentPredictionsTable.id,
        resultsEmailSentAt: tournamentPredictionsTable.resultsEmailSentAt,
      })
      .from(tournamentPredictionsTable)
      .where(eq(tournamentPredictionsTable.tournamentId, testTournamentId));
    expect(after).toHaveLength(before.length);
    for (const row of after) {
      const prior = beforeById.get(row.id);
      expect(row.resultsEmailSentAt?.getTime()).toBe(prior?.getTime());
    }
  });

  it("leaves results_email_sent_at null for an unscored (truly ineligible) row when the dispatcher runs", async () => {
    // Insert a fresh user + prediction with `score` deliberately left null
    // and `results_email_sent_at` left null. This is the only branch in
    // `sendPredictionResultsEmails` that exits without stamping the row
    // (see odds.ts: `if (row.score == null) { skipped += 1; continue; }`).
    //
    // The live PUT hook always runs `scorePredictionsForTournament` before
    // the email dispatcher, so an unscored row can never reach the email
    // step through the hook. We invoke the dispatcher directly to lock in
    // the documented "ineligible rows stay null" semantics from the task.
    sendPredictionResultsEmailMock.mockClear();

    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const [unscoredUser] = await db.insert(appUsersTable).values({
      replitUserId: `pred-email-unscored-${stamp}`,
      username: `pred_email_unscored_${stamp}`,
      email: `pred_email_unscored_${stamp}@example.com`,
      displayName: `Unscored Ursula`,
    }).returning({ id: appUsersTable.id });

    const [unscoredPred] = await db.insert(tournamentPredictionsTable).values({
      tournamentId: testTournamentId,
      userId: unscoredUser.id,
      predictedWinnerPlayerId: playerIds[0],
      predictedTop5: [],
      predictedLowRound: null,
      displayName: "Unscored Ursula",
      // score, scoreBreakdown, scoredAt, resultsEmailSentAt all left null.
    }).returning({ id: tournamentPredictionsTable.id });

    try {
      // Call the dispatcher directly — no scoring runs first, so the new
      // row is observed in its unscored state.
      const result = await sendPredictionResultsEmails(testTournamentId);

      // The unscored row counts as a skip; nothing about it triggers a send.
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      expect(sendPredictionResultsEmailMock).not.toHaveBeenCalled();

      // And critically: the unscored row's stamp is still null.
      const [row] = await db
        .select({
          score: tournamentPredictionsTable.score,
          resultsEmailSentAt: tournamentPredictionsTable.resultsEmailSentAt,
        })
        .from(tournamentPredictionsTable)
        .where(eq(tournamentPredictionsTable.id, unscoredPred.id));
      expect(row.score).toBeNull();
      expect(row.resultsEmailSentAt).toBeNull();
    } finally {
      await db.delete(tournamentPredictionsTable).where(eq(tournamentPredictionsTable.id, unscoredPred.id));
      await db.delete(appUsersTable).where(eq(appUsersTable.id, unscoredUser.id));
    }
  });
});
