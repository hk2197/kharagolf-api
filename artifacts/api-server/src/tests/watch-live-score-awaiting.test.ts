/**
 * Task #485 — automated coverage for the awaiting-marker indicator
 * across the watch live-score, pending-submissions, and by-code endpoints.
 *
 * Background (Task #419 added the API surface this exercises):
 *   - GET  /portal/watch/live-score        → awaitingMarkerCount + per-hole awaitingMarker
 *   - GET  /portal/pending-submissions     → same shape per submission
 *   - GET  /portal/submissions/by-code/:code
 *   - POST /portal/submissions/:id/countersign
 *       After countersign, every score row for that player+round flips
 *       to isVerified=true.
 *
 * The fixtures intentionally produce a *mixed* verification state — a
 * single watch-only hole is unverified while the rest are already verified
 * — so the test proves awaitingMarkerCount surfaces a partial count, not
 * just an "all-or-nothing" boolean. The unverified hole is created by
 * actually POSTing through /portal/watch/submit-score, which is the same
 * code path the watch app uses; this proves the wiring end-to-end.
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
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let playerUserId: number;
let markerUserId: number;
let playerId: number;
let markerPlayerId: number;
let submissionId: number;
const MARKER_CODE = "A1B2C3";
const UNVERIFIED_HOLE = 1; // The single hole submitted via the watch endpoint.

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T485_${stamp}`,
    slug: `t485-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T485 Course",
    slug: `t485-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T485 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [pUser] = await db.insert(appUsersTable).values({
    replitUserId: `t485-player-${stamp}`,
    username: `t485_player_${stamp}`,
  }).returning({ id: appUsersTable.id });
  playerUserId = pUser.id;

  const [mUser] = await db.insert(appUsersTable).values({
    replitUserId: `t485-marker-${stamp}`,
    username: `t485_marker_${stamp}`,
  }).returning({ id: appUsersTable.id });
  markerUserId = mUser.id;

  // Distinct emails matter: the pending-submissions filter does
  //   `email != '' AND userId IS DISTINCT FROM ...`
  // which evaluates to NULL — and so excludes the row — when player.email
  // is NULL. Set non-null emails so the marker can see the submission.
  const [pPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: playerUserId, firstName: "Pat", lastName: "Player",
    email: `t485-player-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerId = pPlayer.id;

  const [mPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: markerUserId, firstName: "Mark", lastName: "Marker",
    email: `t485-marker-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  markerPlayerId = mPlayer.id;
  void markerPlayerId;

  // STEP 1: Submit hole 1 through the real watch endpoint. This is the
  // "watch-only score (isVerified=false)" the task explicitly calls out
  // and is what produces the awaiting-marker indicator.
  // We do this BEFORE creating the round_submission because the watch
  // submit endpoint enforces a card-lock once the submission status is
  // anything other than 'pending'.
  const playerSession = createTestApp({
    id: playerUserId, username: "t485_player", role: "member",
  });
  const submit = await request(playerSession)
    .post("/api/portal/watch/submit-score")
    .send({ tournamentId, playerId, round: 1, holeNumber: UNVERIFIED_HOLE, strokes: 4 });
  if (submit.status !== 200) {
    throw new Error(`Watch submit-score setup failed: ${submit.status} ${submit.text}`);
  }

  // STEP 2: Seed holes 2..18 directly with isVerified=true so the round
  // is in a *mixed* state — one unverified, seventeen verified — proving
  // awaitingMarkerCount surfaces a partial count.
  const verifiedRows = [];
  for (let h = 2; h <= 18; h++) {
    verifiedRows.push({
      tournamentId, playerId, round: 1, holeNumber: h, strokes: 4,
      isVerified: true,
      submittedAt: new Date(), updatedAt: new Date(),
    });
  }
  await db.insert(scoresTable).values(verifiedRows);

  // STEP 3: Create the round submission in 'submitted' state — the only
  // state that satisfies countersign's two-step ceremony precondition.
  const [sub] = await db.insert(roundSubmissionsTable).values({
    tournamentId, playerId, round: 1,
    status: "submitted",
    markerCode: MARKER_CODE,
    totalStrokes: 72,
    submittedAt: new Date(),
  }).returning({ id: roundSubmissionsTable.id });
  submissionId = sub.id;
});

afterAll(async () => {
  await db.delete(scoresTable).where(eq(scoresTable.tournamentId, tournamentId));
  await db.delete(roundSubmissionsTable).where(eq(roundSubmissionsTable.tournamentId, tournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, playerUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, markerUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function playerApp() {
  return createTestApp({ id: playerUserId, username: "t485_player", role: "member" });
}
function markerApp() {
  return createTestApp({ id: markerUserId, username: "t485_marker", role: "member" });
}

function expectMixedState(scoresOrHoles: Array<{ holeNumber?: number; hole?: number; awaitingMarker: boolean; isVerified: boolean }>) {
  expect(scoresOrHoles).toHaveLength(18);
  for (const s of scoresOrHoles) {
    const num = s.holeNumber ?? s.hole;
    if (num === UNVERIFIED_HOLE) {
      expect(s.awaitingMarker).toBe(true);
      expect(s.isVerified).toBe(false);
    } else {
      expect(s.awaitingMarker).toBe(false);
      expect(s.isVerified).toBe(true);
    }
  }
}

describe("awaiting-marker indicator (Task #485)", () => {
  it("watch live-score: reports awaitingMarkerCount=1 and only the watch-only hole is awaiting", async () => {
    const res = await request(playerApp()).get("/api/portal/watch/live-score");
    expect(res.status).toBe(200);
    expect(res.body.hasActiveRound).toBe(true);
    expect(res.body.awaitingMarkerCount).toBe(1);
    expectMixedState(res.body.holes);
  });

  it("pending-submissions: marker view shows awaitingMarkerCount=1 and only the watch-only hole is awaiting", async () => {
    const res = await request(markerApp()).get("/api/portal/pending-submissions");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const sub = res.body.find((s: { submissionId: number }) => s.submissionId === submissionId);
    expect(sub).toBeTruthy();
    expect(sub.awaitingMarkerCount).toBe(1);
    expectMixedState(sub.scores);
  });

  it("by-code lookup: marker sees awaitingMarkerCount=1 and only the watch-only hole is awaiting", async () => {
    const res = await request(markerApp())
      .get(`/api/portal/submissions/by-code/${MARKER_CODE}`);
    expect(res.status).toBe(200);
    expect(res.body.submissionId).toBe(submissionId);
    expect(res.body.awaitingMarkerCount).toBe(1);
    expectMixedState(res.body.scores);
  });

  it("after countersign: indicator clears across watch live-score, pending-submissions, and by-code", async () => {
    // Countersign flips every hole for that player+round to isVerified=true.
    const cs = await request(markerApp())
      .post(`/api/portal/submissions/${submissionId}/countersign`)
      .send({});
    expect(cs.status).toBe(200);

    // Direct DB sanity-check — every score row is now verified.
    const dbRows = await db.select({ isVerified: scoresTable.isVerified })
      .from(scoresTable)
      .where(and(eq(scoresTable.playerId, playerId), eq(scoresTable.round, 1)));
    expect(dbRows).toHaveLength(18);
    expect(dbRows.every(r => r.isVerified === true)).toBe(true);

    // 1) watch live-score still returns the round (no status filter), and
    //    now reports awaitingMarkerCount=0 with awaitingMarker=false on every hole.
    const live = await request(playerApp()).get("/api/portal/watch/live-score");
    expect(live.status).toBe(200);
    expect(live.body.awaitingMarkerCount).toBe(0);
    expect(live.body.holes).toHaveLength(18);
    for (const h of live.body.holes) {
      expect(h.awaitingMarker).toBe(false);
      expect(h.isVerified).toBe(true);
    }

    // 2) pending-submissions only returns submissions whose status is
    //    'submitted' (i.e. still awaiting a marker). After countersign the
    //    submission moves to 'countersigned' and is filtered out — that
    //    *is* the cleared indicator state for this endpoint, since the
    //    UI no longer surfaces a row to attach an indicator to.
    const pend = await request(markerApp()).get("/api/portal/pending-submissions");
    expect(pend.status).toBe(200);
    const stillThere = (pend.body as Array<{ submissionId: number }>)
      .find(s => s.submissionId === submissionId);
    expect(stillThere).toBeUndefined();

    // 3) by-code looks up by markerCode AND status IN ('pending','submitted').
    //    Countersign nulls markerCode and moves status to 'countersigned',
    //    so the lookup returns 404 — the cleared indicator state for this
    //    endpoint. Combined with the DB sanity check above this proves
    //    every per-hole flag is cleared.
    const code = await request(markerApp())
      .get(`/api/portal/submissions/by-code/${MARKER_CODE}`);
    expect(code.status).toBe(404);
  });
});
