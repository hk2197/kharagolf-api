/**
 * Task #636 — server coverage for the per-hole verify endpoint added in #483.
 *
 *   POST /api/portal/submissions/:submissionId/scores/:holeNumber/verify
 *
 * The endpoint lets the marker tap a single unverified hole row in the
 * review modal and flip just that score's `is_verified=true`, without
 * countersigning the whole round. These tests pin the contract:
 *
 *   1. Success: only the targeted score row flips to is_verified=true,
 *      and the response surfaces { ok, verified: true } (not alreadyVerified).
 *   2. Self-approval is blocked (403) — the player whose card it is can
 *      never verify their own holes.
 *   3. Designated-marker enforcement (403) — when markerPlayerId is set,
 *      only that player may verify holes.
 *   4. Locked status rejection (400) — once the submission is countersigned
 *      or disputed, per-hole verify is no longer allowed.
 *   5. Missing-score 404 — verify before any score row exists for that hole.
 *   6. Idempotent re-verify — calling again on an already verified hole
 *      returns { ok, alreadyVerified: true } and does not 500.
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
let otherUserId: number;
let playerId: number;
let markerPlayerId: number;
let otherPlayerId: number;
let submissionId: number;

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T636_${stamp}`,
    slug: `t636-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T636 Course",
    slug: `t636-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T636 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [pUser] = await db.insert(appUsersTable).values({
    replitUserId: `t636-player-${stamp}`,
    username: `t636_player_${stamp}`,
  }).returning({ id: appUsersTable.id });
  playerUserId = pUser.id;

  const [mUser] = await db.insert(appUsersTable).values({
    replitUserId: `t636-marker-${stamp}`,
    username: `t636_marker_${stamp}`,
  }).returning({ id: appUsersTable.id });
  markerUserId = mUser.id;

  const [oUser] = await db.insert(appUsersTable).values({
    replitUserId: `t636-other-${stamp}`,
    username: `t636_other_${stamp}`,
  }).returning({ id: appUsersTable.id });
  otherUserId = oUser.id;

  // Distinct emails matter — verifyMarkerEligibility checks both userId AND
  // email when deciding self-approval / designated-marker eligibility.
  const [pPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: playerUserId, firstName: "Pat", lastName: "Player",
    email: `t636-player-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerId = pPlayer.id;

  const [mPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: markerUserId, firstName: "Mark", lastName: "Marker",
    email: `t636-marker-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  markerPlayerId = mPlayer.id;

  const [oPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: otherUserId, firstName: "Otto", lastName: "Other",
    email: `t636-other-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  otherPlayerId = oPlayer.id;

  // Seed scores 1..3 — all unverified — and the round submission, with the
  // marker designated. Status 'submitted' so per-hole verify is still allowed
  // (the route only rejects locked statuses like countersigned/disputed).
  const now = new Date();
  await db.insert(scoresTable).values([
    { tournamentId, playerId, round: 1, holeNumber: 1, strokes: 4, isVerified: false, submittedAt: now, updatedAt: now },
    { tournamentId, playerId, round: 1, holeNumber: 2, strokes: 5, isVerified: false, submittedAt: now, updatedAt: now },
    { tournamentId, playerId, round: 1, holeNumber: 3, strokes: 3, isVerified: false, submittedAt: now, updatedAt: now },
  ]);

  const [sub] = await db.insert(roundSubmissionsTable).values({
    tournamentId, playerId, round: 1,
    status: "submitted",
    markerPlayerId,
    totalStrokes: 12,
    submittedAt: now,
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
  await db.delete(appUsersTable).where(eq(appUsersTable.id, otherUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function markerApp() {
  // The route's verifyMarkerEligibility resolves the marker via the
  // SQL `email = '' OR userId = req.user!.id` — userId match alone
  // is sufficient to identify the marker player here.
  return createTestApp({
    id: markerUserId, username: "t636_marker", role: "member",
  });
}

function playerApp() {
  return createTestApp({
    id: playerUserId, username: "t636_player", role: "member",
  });
}

function otherApp() {
  return createTestApp({
    id: otherUserId, username: "t636_other", role: "member",
  });
}

async function isHoleVerified(holeNumber: number): Promise<boolean> {
  const [row] = await db.select({ isVerified: scoresTable.isVerified })
    .from(scoresTable)
    .where(and(
      eq(scoresTable.playerId, playerId),
      eq(scoresTable.round, 1),
      eq(scoresTable.holeNumber, holeNumber),
    ));
  return row?.isVerified === true;
}

describe("POST /portal/submissions/:id/scores/:hole/verify (Task #483 / #636)", () => {
  it("blocks the player from verifying their own scorecard (self-approval)", async () => {
    // Even though the route only enforces designated-marker for non-self
    // callers, the self-approval check fires first when the caller's email/id
    // matches the submitting player.
    const res = await request(playerApp())
      .post(`/api/portal/submissions/${submissionId}/scores/1/verify`)
      .send({});
    expect(res.status).toBe(403);
    expect(String(res.body?.error ?? "")).toMatch(/own round/i);
    // No score should have flipped.
    expect(await isHoleVerified(1)).toBe(false);
  });

  it("blocks a non-designated marker when markerPlayerId is set", async () => {
    const res = await request(otherApp())
      .post(`/api/portal/submissions/${submissionId}/scores/1/verify`)
      .send({});
    expect(res.status).toBe(403);
    expect(String(res.body?.error ?? "")).toMatch(/designated marker/i);
    expect(await isHoleVerified(1)).toBe(false);
  });

  it("returns 404 when no score row exists for the targeted hole", async () => {
    // Hole 5 was never seeded.
    const res = await request(markerApp())
      .post(`/api/portal/submissions/${submissionId}/scores/5/verify`)
      .send({});
    expect(res.status).toBe(404);
    expect(String(res.body?.error ?? "")).toMatch(/no score recorded/i);
  });

  it("flips only the targeted hole's is_verified=true on success", async () => {
    // Pre-condition: holes 1, 2, 3 all unverified.
    expect(await isHoleVerified(1)).toBe(false);
    expect(await isHoleVerified(2)).toBe(false);
    expect(await isHoleVerified(3)).toBe(false);

    const res = await request(markerApp())
      .post(`/api/portal/submissions/${submissionId}/scores/2/verify`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, holeNumber: 2, verified: true });
    expect(res.body.alreadyVerified).toBeUndefined();

    // ONLY hole 2 should have flipped — neighbour holes still unverified.
    expect(await isHoleVerified(1)).toBe(false);
    expect(await isHoleVerified(2)).toBe(true);
    expect(await isHoleVerified(3)).toBe(false);
  });

  it("is idempotent: re-verifying an already verified hole returns alreadyVerified=true", async () => {
    // Hole 2 was just verified by the previous test.
    const res = await request(markerApp())
      .post(`/api/portal/submissions/${submissionId}/scores/2/verify`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, holeNumber: 2, alreadyVerified: true });
    expect(res.body.verified).toBeUndefined();
    // Still verified, no regression.
    expect(await isHoleVerified(2)).toBe(true);
  });

  it("rejects per-hole verify once the submission is locked (countersigned)", async () => {
    // Lock the submission. Any non-pending/submitted status should be rejected.
    await db.update(roundSubmissionsTable)
      .set({ status: "countersigned", reviewedAt: new Date() })
      .where(eq(roundSubmissionsTable.id, submissionId));

    const res = await request(markerApp())
      .post(`/api/portal/submissions/${submissionId}/scores/3/verify`)
      .send({});
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toMatch(/countersigned/i);
    // Hole 3 must NOT have flipped — locked statuses are read-only here.
    expect(await isHoleVerified(3)).toBe(false);

    // Same lockout for 'disputed'.
    await db.update(roundSubmissionsTable)
      .set({ status: "disputed" })
      .where(eq(roundSubmissionsTable.id, submissionId));
    const res2 = await request(markerApp())
      .post(`/api/portal/submissions/${submissionId}/scores/3/verify`)
      .send({});
    expect(res2.status).toBe(400);
    expect(String(res2.body?.error ?? "")).toMatch(/disputed/i);
    expect(await isHoleVerified(3)).toBe(false);
  });
});
