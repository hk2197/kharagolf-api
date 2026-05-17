/**
 * Task #1614 — server coverage for the shot edit flow.
 *
 *   PATCH /api/portal/shots/:id
 *
 * The mobile + portal "Edit shot" affordance lets players fix a logged
 * shot's club, lie, miss direction, shotType, etc. The route ownership-
 * checks via the shared `loadOwnedShot` helper, which accepts either a
 * tournament playerId match OR a casual `generalPlayRoundsTable.userId`
 * match (via the shot's own `userId` column).
 *
 * Tasks #1176 and #1354 already pin server coverage for the delete +
 * restore Undo pair on both branches. PATCH had no dedicated tests, so
 * a future refactor of `loadOwnedShot` or the PATCH body parser could
 * silently break the in-app Edit Shot flow without any test failing.
 *
 * Coverage:
 *   1. Tournament case: the player can update shotType / club / lieType /
 *      missDirection on a shot they own and the row reflects the change.
 *   2. Casual case: the same update succeeds against a shot pinned to
 *      the player's own `generalPlayRoundsTable` round.
 *   3. Bad shotType is rejected with 400 and the row is unchanged.
 *   4. A different user PATCHing someone else's shot is rejected (404
 *      from the loadOwnedShot path) and the row is unchanged.
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
  generalPlayRoundsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let playerUserId: number;
let outsiderUserId: number;
let playerId: number;
let generalPlayRoundId: number;

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T1614_${stamp}`,
    slug: `t1614-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T1614 Course",
    slug: `t1614-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T1614 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [pUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1614-player-${stamp}`,
    username: `t1614_player_${stamp}`,
  }).returning({ id: appUsersTable.id });
  playerUserId = pUser.id;

  const [oUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1614-outsider-${stamp}`,
    username: `t1614_outsider_${stamp}`,
  }).returning({ id: appUsersTable.id });
  outsiderUserId = oUser.id;

  const [pPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: playerUserId, firstName: "Pat", lastName: "Player",
    email: `t1614-player-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerId = pPlayer.id;

  const [gpRound] = await db.insert(generalPlayRoundsTable).values({
    userId: playerUserId,
    organizationId: orgId,
    courseId,
    holesPlayed: 18,
    status: "in_progress",
  }).returning({ id: generalPlayRoundsTable.id });
  generalPlayRoundId = gpRound.id;
});

afterAll(async () => {
  await db.delete(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
  await db.delete(shotsTable).where(eq(shotsTable.generalPlayRoundId, generalPlayRoundId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, generalPlayRoundId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, playerUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, outsiderUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function playerApp() {
  return createTestApp({
    id: playerUserId, username: "t1614_player", role: "member",
  });
}

function outsiderApp() {
  return createTestApp({
    id: outsiderUserId, username: "t1614_outsider", role: "member",
  });
}

async function readShot(id: number) {
  const [row] = await db.select().from(shotsTable).where(eq(shotsTable.id, id)).limit(1);
  return row;
}

describe("PATCH /portal/shots/:id (Task #1614)", () => {
  it("tournament case: player can edit shotType / club / lieType / missDirection on a shot they own", async () => {
    const [shot] = await db.insert(shotsTable).values({
      tournamentId,
      playerId,
      round: 1,
      holeNumber: 1,
      shotNumber: 1,
      shotType: "tee",
      club: "DR",
      lieType: "tee",
      missDirection: null,
      source: "manual",
    }).returning();

    const res = await request(playerApp())
      .patch(`/api/portal/shots/${shot.id}`)
      .send({
        shotType: "approach",
        club: "7I",
        lieType: "fairway",
        missDirection: "left",
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(res.body.shot).toBeDefined();
    expect(res.body.shot.id).toBe(shot.id);
    expect(res.body.shot.shotType).toBe("approach");
    expect(res.body.shot.club).toBe("7I");
    expect(res.body.shot.lieType).toBe("fairway");
    expect(res.body.shot.missDirection).toBe("left");
    // Ownership and position fields are untouched.
    expect(res.body.shot.tournamentId).toBe(tournamentId);
    expect(res.body.shot.playerId).toBe(playerId);
    expect(res.body.shot.round).toBe(1);
    expect(res.body.shot.holeNumber).toBe(1);
    expect(res.body.shot.shotNumber).toBe(1);

    // Re-read to confirm the row in the database actually changed (not
    // just the response payload).
    const reloaded = await readShot(shot.id);
    expect(reloaded.shotType).toBe("approach");
    expect(reloaded.club).toBe("7I");
    expect(reloaded.lieType).toBe("fairway");
    expect(reloaded.missDirection).toBe("left");
  });

  it("casual case: player can edit a shot pinned to their own general play round", async () => {
    const [shot] = await db.insert(shotsTable).values({
      userId: playerUserId,
      generalPlayRoundId,
      round: 1,
      holeNumber: 2,
      shotNumber: 1,
      shotType: "tee",
      club: "DR",
      lieType: "tee",
      missDirection: null,
      source: "manual",
    }).returning();

    const res = await request(playerApp())
      .patch(`/api/portal/shots/${shot.id}`)
      .send({
        shotType: "chip",
        club: "PW",
        lieType: "rough",
        missDirection: "right",
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(res.body.shot.id).toBe(shot.id);
    expect(res.body.shot.shotType).toBe("chip");
    expect(res.body.shot.club).toBe("PW");
    expect(res.body.shot.lieType).toBe("rough");
    expect(res.body.shot.missDirection).toBe("right");
    // Casual-round ownership shape preserved (userId + generalPlayRoundId
    // set, tournament-scoped fields still null).
    expect(res.body.shot.userId).toBe(playerUserId);
    expect(res.body.shot.generalPlayRoundId).toBe(generalPlayRoundId);
    expect(res.body.shot.tournamentId).toBeNull();
    expect(res.body.shot.playerId).toBeNull();

    const reloaded = await readShot(shot.id);
    expect(reloaded.shotType).toBe("chip");
    expect(reloaded.club).toBe("PW");
    expect(reloaded.lieType).toBe("rough");
    expect(reloaded.missDirection).toBe("right");
  });

  it("rejects an invalid shotType with 400 and leaves the row unchanged", async () => {
    const [shot] = await db.insert(shotsTable).values({
      tournamentId,
      playerId,
      round: 1,
      holeNumber: 3,
      shotNumber: 1,
      shotType: "approach",
      club: "7I",
      source: "manual",
    }).returning();

    const res = await request(playerApp())
      .patch(`/api/portal/shots/${shot.id}`)
      .send({ shotType: "not-a-real-type", club: "5I" });
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toMatch(/shotType/i);

    // Row is unchanged — nothing in the payload was applied because the
    // route validates shotType BEFORE issuing the update.
    const reloaded = await readShot(shot.id);
    expect(reloaded.shotType).toBe("approach");
    expect(reloaded.club).toBe("7I");
  });

  it("rejects a different user PATCHing someone else's shot with 404 (loadOwnedShot)", async () => {
    // Tournament-branch shot owned by `playerUserId`. Outsider has no
    // playersTable row for this tournament and isn't the casual-round
    // owner either, so loadOwnedShot returns null → 404.
    const [tShot] = await db.insert(shotsTable).values({
      tournamentId,
      playerId,
      round: 1,
      holeNumber: 4,
      shotNumber: 1,
      shotType: "tee",
      club: "DR",
      source: "manual",
    }).returning();

    const r1 = await request(outsiderApp())
      .patch(`/api/portal/shots/${tShot.id}`)
      .send({ shotType: "approach", club: "5I" });
    expect(r1.status).toBe(404);

    const tReloaded = await readShot(tShot.id);
    expect(tReloaded.shotType).toBe("tee");
    expect(tReloaded.club).toBe("DR");

    // Same check for the casual branch: outsider does NOT own the
    // general-play round, so the casual-shot PATCH must also 404 and
    // leave the row untouched.
    const [cShot] = await db.insert(shotsTable).values({
      userId: playerUserId,
      generalPlayRoundId,
      round: 1,
      holeNumber: 5,
      shotNumber: 1,
      shotType: "tee",
      club: "DR",
      source: "manual",
    }).returning();

    const r2 = await request(outsiderApp())
      .patch(`/api/portal/shots/${cShot.id}`)
      .send({ shotType: "putt", club: "PT" });
    expect(r2.status).toBe(404);

    const cReloaded = await readShot(cShot.id);
    expect(cReloaded.shotType).toBe("tee");
    expect(cReloaded.club).toBe("DR");
  });
});
