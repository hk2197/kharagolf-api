/**
 * Task #1368 — scorer-station shot delete is scoped to the scorer's group.
 *
 *   DELETE /api/scorer/groups/:groupId/shots/:shotId
 *
 * Task #1179 added a trash icon on every row of the "Shots logged" list and a
 * matching DELETE endpoint so a scorer can remove a row they entered by
 * mistake (double-tap, wrong player, etc.). The endpoint must only let a
 * scorer PIN delete shots that belong to a player in *their* group; reaching
 * across groups (or into another tournament) has to 404. This test pins that
 * contract:
 *   1. Happy path — group A's scorer deletes group A's shot, row disappears
 *      from the DB, response is `{ ok: true, shotId }`.
 *   2. Cross-group — group A's scorer targeting group B's shotId gets a 404
 *      and the row is left intact.
 *   3. Unknown shotId → 404.
 *   4. No scorer session → 401.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  shotsTable,
  teeTimesTable,
  teeTimePlayersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import router from "../routes/index.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let playerAId: number;
let playerBId: number;
let teeTimeAId: number;
let teeTimeBId: number;
let shotAId: number;
let shotBId: number;

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T1368_${stamp}`,
    slug: `t1368-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T1368 Course",
    slug: `t1368-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T1368 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [pA] = await db.insert(playersTable).values({
    tournamentId, firstName: "Alpha", lastName: "Player",
    email: `t1368-a-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerAId = pA.id;

  const [pB] = await db.insert(playersTable).values({
    tournamentId, firstName: "Bravo", lastName: "Player",
    email: `t1368-b-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerBId = pB.id;

  const [ttA] = await db.insert(teeTimesTable).values({
    tournamentId,
    teeTime: new Date(),
  }).returning({ id: teeTimesTable.id });
  teeTimeAId = ttA.id;

  const [ttB] = await db.insert(teeTimesTable).values({
    tournamentId,
    teeTime: new Date(Date.now() + 10 * 60 * 1000),
  }).returning({ id: teeTimesTable.id });
  teeTimeBId = ttB.id;

  await db.insert(teeTimePlayersTable).values({ teeTimeId: teeTimeAId, playerId: playerAId });
  await db.insert(teeTimePlayersTable).values({ teeTimeId: teeTimeBId, playerId: playerBId });

  const [shotA] = await db.insert(shotsTable).values({
    tournamentId,
    playerId: playerAId,
    round: 1,
    holeNumber: 1,
    shotNumber: 1,
    shotType: "tee",
    club: "Driver",
    source: "scorer",
  }).returning({ id: shotsTable.id });
  shotAId = shotA.id;

  const [shotB] = await db.insert(shotsTable).values({
    tournamentId,
    playerId: playerBId,
    round: 1,
    holeNumber: 1,
    shotNumber: 1,
    shotType: "tee",
    club: "Driver",
    source: "scorer",
  }).returning({ id: shotsTable.id });
  shotBId = shotB.id;
});

afterAll(async () => {
  await db.delete(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
  await db.delete(teeTimePlayersTable).where(eq(teeTimePlayersTable.teeTimeId, teeTimeAId));
  await db.delete(teeTimePlayersTable).where(eq(teeTimePlayersTable.teeTimeId, teeTimeBId));
  await db.delete(teeTimesTable).where(eq(teeTimesTable.id, teeTimeAId));
  await db.delete(teeTimesTable).where(eq(teeTimesTable.id, teeTimeBId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function scorerApp(withSession = true) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (withSession) {
      (req as unknown as { scorerSession: { tournamentId: number; orgId: number; pinId: number } }).scorerSession = {
        tournamentId, orgId, pinId: 1,
      };
    }
    req.isAuthenticated = function (this: Request) { return false; } as Request["isAuthenticated"];
    next();
  });
  app.use("/api", router);
  return app;
}

describe("DELETE /scorer/groups/:groupId/shots/:shotId (Task #1368)", () => {
  it("lets group A's scorer delete group A's shot and removes the row from the DB", async () => {
    const res = await request(scorerApp())
      .delete(`/api/scorer/groups/${teeTimeAId}/shots/${shotAId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.shotId).toBe(shotAId);

    const rows = await db.select().from(shotsTable).where(eq(shotsTable.id, shotAId));
    expect(rows.length).toBe(0);
  });

  it("returns 404 when group A's scorer targets group B's shotId and leaves the row intact", async () => {
    const res = await request(scorerApp())
      .delete(`/api/scorer/groups/${teeTimeAId}/shots/${shotBId}`);
    expect(res.status).toBe(404);

    const rows = await db.select().from(shotsTable).where(eq(shotsTable.id, shotBId));
    expect(rows.length).toBe(1);
  });

  it("returns 404 for an unknown shotId", async () => {
    const res = await request(scorerApp())
      .delete(`/api/scorer/groups/${teeTimeAId}/shots/99999999`);
    expect(res.status).toBe(404);
  });

  it("rejects calls without a scorer session (401)", async () => {
    const res = await request(scorerApp(false))
      .delete(`/api/scorer/groups/${teeTimeAId}/shots/${shotBId}`);
    expect(res.status).toBe(401);
  });
});
