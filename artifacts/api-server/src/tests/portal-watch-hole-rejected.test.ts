/**
 * Task #801 — automated coverage for the instant scorecard-rejection alert
 * pushed over /ws/watch when the marker rejects or disputes the round.
 *
 * Task #637 added `notifyWatchHoleRejected`, fired from:
 *   POST /api/portal/submissions/:submissionId/reject
 *   POST /api/portal/submissions/:submissionId/dispute
 *
 * These tests stand up a stub /ws/watch session for the player (authenticated
 * via the same `handleMessage` path the real WebSocket uses), then POST to the
 * portal endpoints as the designated marker and assert that a `hole_rejected`
 * frame is delivered to the player's watch with the correct round, reason and
 * — for dispute — the per-hole flagged hole numbers.
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
  roundSubmissionsTable,
  scorecardFlagsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { handleMessage, type WatchSession } from "../routes/ws-watch.js";
import { issueWatchToken } from "../lib/watch-token.js";
import { createTestApp } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let playerUserId: number;
let markerUserId: number;
let playerId: number;
let markerPlayerId: number;
let rejectSubmissionId: number;
let disputeSubmissionId: number;

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T801_${stamp}`,
    slug: `t801-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T801 Course",
    slug: `t801-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T801 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [pUser] = await db.insert(appUsersTable).values({
    replitUserId: `t801-player-${stamp}`,
    username: `t801_player_${stamp}`,
  }).returning({ id: appUsersTable.id });
  playerUserId = pUser.id;

  const [mUser] = await db.insert(appUsersTable).values({
    replitUserId: `t801-marker-${stamp}`,
    username: `t801_marker_${stamp}`,
  }).returning({ id: appUsersTable.id });
  markerUserId = mUser.id;

  const [pPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: playerUserId, firstName: "Pat", lastName: "Player",
    email: `t801-player-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerId = pPlayer.id;

  const [mPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: markerUserId, firstName: "Mark", lastName: "Marker",
    email: `t801-marker-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  markerPlayerId = mPlayer.id;

  // Two separate submissions so the reject test and the dispute test do not
  // collide — both start in the "submitted" state required by the marker
  // routes' WHS two-step ceremony guard.
  const now = new Date();
  const [rejectSub] = await db.insert(roundSubmissionsTable).values({
    tournamentId, playerId, round: 1,
    status: "submitted", markerPlayerId,
    totalStrokes: 0, submittedAt: now,
  }).returning({ id: roundSubmissionsTable.id });
  rejectSubmissionId = rejectSub.id;

  const [disputeSub] = await db.insert(roundSubmissionsTable).values({
    tournamentId, playerId, round: 2,
    status: "submitted", markerPlayerId,
    totalStrokes: 0, submittedAt: now,
  }).returning({ id: roundSubmissionsTable.id });
  disputeSubmissionId = disputeSub.id;
});

afterAll(async () => {
  await db.delete(scorecardFlagsTable).where(eq(scorecardFlagsTable.submissionId, disputeSubmissionId));
  await db.delete(scorecardFlagsTable).where(eq(scorecardFlagsTable.submissionId, rejectSubmissionId));
  await db.delete(roundSubmissionsTable).where(eq(roundSubmissionsTable.tournamentId, tournamentId));
  await db.delete(scoresTable).where(eq(scoresTable.tournamentId, tournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, playerUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, markerUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function markerApp() {
  return createTestApp({
    id: markerUserId, username: "t801_marker", role: "member",
  });
}

/**
 * Build a stub WatchSession that captures every frame written to the socket
 * in `sent[]`, then authenticate it as the player so notifyWatchHoleRejected
 * can find an active session in the registry. Mirrors the helper used by
 * watch-hole-verified.test.ts.
 */
async function openWatchSessionForPlayer(): Promise<{ sent: object[]; session: WatchSession }> {
  const sent: object[] = [];
  const ws = {
    readyState: 1,
    send: (data: string) => { sent.push(JSON.parse(data) as object); },
  } as unknown as WatchSession["ws"];
  const session: WatchSession = {
    ws, userId: null, tournamentId: null,
    round: 1, sessionId: "test-session", pushIntervalId: null, batteryMode: false,
    playerLat: null, playerLng: null,
  };
  const token = issueWatchToken(playerUserId);
  await handleMessage(session, JSON.stringify({ type: "auth", token }));
  // Discard auth_ok so the test only inspects subsequent frames.
  sent.length = 0;
  return { sent, session };
}

describe("/ws/watch hole_rejected push from portal endpoints (Task #801)", () => {
  it("delivers hole_rejected over /ws/watch when the marker hits /portal/submissions/:id/reject", async () => {
    const { sent } = await openWatchSessionForPlayer();

    const res = await request(markerApp())
      .post(`/api/portal/submissions/${rejectSubmissionId}/reject`)
      .send({ reason: "Hole 4 strokes look wrong" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });

    const evt = sent.find((m) => (m as { type?: string }).type === "hole_rejected") as
      | { round: number; holes: number[]; submissionId: number | null; reason: string }
      | undefined;
    expect(evt).toBeDefined();
    expect(evt!.round).toBe(1);
    expect(evt!.submissionId).toBe(rejectSubmissionId);
    expect(evt!.reason).toBe("Hole 4 strokes look wrong");
    // /reject does not flag specific holes — the watch should treat an empty
    // list as "the whole round was rejected".
    expect(evt!.holes).toEqual([]);
  });

  it("delivers hole_rejected with the per-hole flagged hole numbers from /portal/submissions/:id/dispute", async () => {
    const { sent } = await openWatchSessionForPlayer();

    const res = await request(markerApp())
      .post(`/api/portal/submissions/${disputeSubmissionId}/dispute`)
      .send({
        note: "Two holes look wrong",
        holes: [
          { holeNumber: 5, markerNote: "Strokes off by one" },
          { holeNumber: 12, markerNote: "Penalty not recorded" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });

    const evt = sent.find((m) => (m as { type?: string }).type === "hole_rejected") as
      | { round: number; holes: number[]; submissionId: number | null; reason: string }
      | undefined;
    expect(evt).toBeDefined();
    expect(evt!.round).toBe(2);
    expect(evt!.submissionId).toBe(disputeSubmissionId);
    expect(evt!.reason).toBe("Two holes look wrong");
    // Order matters: notifyWatchHoleRejected should pass through the marker's
    // flagged hole list verbatim so the watch can highlight just those rows.
    expect(evt!.holes).toEqual([5, 12]);
  });
});
