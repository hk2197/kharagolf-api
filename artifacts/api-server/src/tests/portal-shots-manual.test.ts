/**
 * Task #649 — server coverage for the manual-shot endpoint added in #519.
 *
 *   POST /api/portal/shots/manual
 *
 * The mobile ShotReviewModal "Add Shot" flow posts here when the player
 * remembers a shot they forgot to log mid-round. The endpoint inserts a
 * single shot row scoped to either a tournament round (with playerId
 * derived from the caller's enrolment) or a general-play round.
 *
 * These tests pin the contract:
 *   1. Happy path — a tournament-enrolled caller can insert a shot, and
 *      the persisted row carries the expected playerId, holeNumber,
 *      shotNumber, shotType, club, lieType, and source="manual".
 *   2. Missing holeNumber → 400.
 *   3. Missing shotNumber → 400.
 *   4. Bad shotType → 400 with the allowed list in the message.
 *   5. Tournament-not-enrolled → 403 (caller is not a player in the
 *      target tournament).
 *   6. Both ids absent → 400 (must specify tournament OR general-play).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  shotsTable,
  appUsersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let otherTournamentId: number;
let playerUserId: number;
let outsiderUserId: number;
let playerId: number;

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T649_${stamp}`,
    slug: `t649-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T649 Course",
    slug: `t649-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T649 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [other] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T649 Other ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  otherTournamentId = other.id;

  const [pUser] = await db.insert(appUsersTable).values({
    replitUserId: `t649-player-${stamp}`,
    username: `t649_player_${stamp}`,
  }).returning({ id: appUsersTable.id });
  playerUserId = pUser.id;

  const [oUser] = await db.insert(appUsersTable).values({
    replitUserId: `t649-outsider-${stamp}`,
    username: `t649_outsider_${stamp}`,
  }).returning({ id: appUsersTable.id });
  outsiderUserId = oUser.id;

  const [pPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: playerUserId, firstName: "Pat", lastName: "Player",
    email: `t649-player-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerId = pPlayer.id;
});

afterAll(async () => {
  await db.delete(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
  await db.delete(shotsTable).where(eq(shotsTable.tournamentId, otherTournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, otherTournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, playerUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, outsiderUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function playerApp() {
  return createTestApp({
    id: playerUserId, username: "t649_player", role: "member",
  });
}

function outsiderApp() {
  // outsiderUserId has NO playersTable row for `tournamentId` — used to
  // drive the not-enrolled (403) path.
  return createTestApp({
    id: outsiderUserId, username: "t649_outsider", role: "member",
  });
}

describe("POST /portal/shots/manual (Task #519 / #649)", () => {
  it("inserts a manual shot for an enrolled tournament player", async () => {
    const res = await request(playerApp())
      .post("/api/portal/shots/manual")
      .send({
        tournamentId,
        round: 1,
        holeNumber: 7,
        shotNumber: 2,
        shotType: "approach",
        club: "7I",
        lieType: "Fairway",
        missDirection: "Left",
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(res.body.shot).toBeDefined();
    expect(res.body.shot.playerId).toBe(playerId);
    expect(res.body.shot.tournamentId).toBe(tournamentId);
    expect(res.body.shot.holeNumber).toBe(7);
    expect(res.body.shot.shotNumber).toBe(2);
    expect(res.body.shot.shotType).toBe("approach");
    expect(res.body.shot.club).toBe("7I");
    expect(res.body.shot.lieType).toBe("Fairway");
    expect(res.body.shot.missDirection).toBe("Left");
    expect(res.body.shot.source).toBe("manual");

    // The row is actually persisted and queryable by the same playerId/round/hole.
    const [row] = await db.select({
      id: shotsTable.id, shotNumber: shotsTable.shotNumber, shotType: shotsTable.shotType,
    }).from(shotsTable).where(and(
      eq(shotsTable.playerId, playerId),
      eq(shotsTable.round, 1),
      eq(shotsTable.holeNumber, 7),
      eq(shotsTable.shotNumber, 2),
    ));
    expect(row).toBeDefined();
    expect(row.shotType).toBe("approach");
  });

  it("rejects when holeNumber is missing", async () => {
    const res = await request(playerApp())
      .post("/api/portal/shots/manual")
      .send({ tournamentId, round: 1, shotNumber: 1, shotType: "tee" });
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toMatch(/holeNumber.*shotNumber/i);
  });

  it("rejects when shotNumber is missing", async () => {
    const res = await request(playerApp())
      .post("/api/portal/shots/manual")
      .send({ tournamentId, round: 1, holeNumber: 3, shotType: "tee" });
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toMatch(/holeNumber.*shotNumber/i);
  });

  it("rejects an unknown shotType with the allowed list in the error", async () => {
    const res = await request(playerApp())
      .post("/api/portal/shots/manual")
      .send({
        tournamentId, round: 1, holeNumber: 4, shotNumber: 1,
        shotType: "moonshot",
      });
    expect(res.status).toBe(400);
    const msg = String(res.body?.error ?? "");
    expect(msg).toMatch(/Invalid shotType/i);
    // The error advertises the canonical list so the client can self-correct.
    expect(msg).toMatch(/tee/);
    expect(msg).toMatch(/putt/);
  });

  it("rejects when the caller is not enrolled in the target tournament", async () => {
    // The outsider user has NO playersTable row for tournamentId — the route
    // must refuse rather than silently insert with a null playerId.
    const res = await request(outsiderApp())
      .post("/api/portal/shots/manual")
      .send({
        tournamentId, round: 1, holeNumber: 1, shotNumber: 1, shotType: "tee",
      });
    expect(res.status).toBe(403);
    expect(String(res.body?.error ?? "")).toMatch(/not enrolled/i);

    // And the other-tournament path is also closed off — the player IS
    // enrolled in `tournamentId` but NOT in `otherTournamentId`.
    const res2 = await request(playerApp())
      .post("/api/portal/shots/manual")
      .send({
        tournamentId: otherTournamentId, round: 1, holeNumber: 1, shotNumber: 1, shotType: "tee",
      });
    expect(res2.status).toBe(403);
    expect(String(res2.body?.error ?? "")).toMatch(/not enrolled/i);
  });

  it("rejects when neither tournamentId nor generalPlayRoundId is provided", async () => {
    const res = await request(playerApp())
      .post("/api/portal/shots/manual")
      .send({ round: 1, holeNumber: 1, shotNumber: 1, shotType: "tee" });
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toMatch(/tournamentId.*generalPlayRoundId/i);
  });
});
