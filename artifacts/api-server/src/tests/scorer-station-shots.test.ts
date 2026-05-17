/**
 * Task #710 — scorer-station shot capture tags rows with source: "scorer".
 *
 *   POST /api/scorer/groups/:groupId/shots
 *
 * The shotSourceEnum reserves a "scorer" value so the round map (HoleMapPanel)
 * can colour-code and filter shots entered by an on-course scorer at a
 * tournament station. This endpoint is the ingest path for that flow, and the
 * test pins the contract:
 *   1. Happy path — a shot posted via the scorer-station endpoint is
 *      persisted with source="scorer" and is scoped to the player/tournament.
 *   2. Re-posting the same (player, round, hole, shotNumber) updates in place
 *      and keeps source="scorer".
 *   3. Players outside the scorer's group are rejected (404).
 *   4. Missing required fields → 400.
 *   5. Unknown shotType → 400 with the allowed list in the error.
 *   6. Unauthenticated (no scorer session) → 401.
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
import { and, eq } from "drizzle-orm";
import router from "../routes/index.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let playerId: number;
let outsidePlayerId: number;
let teeTimeId: number;

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T710_${stamp}`,
    slug: `t710-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T710 Course",
    slug: `t710-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T710 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [pPlayer] = await db.insert(playersTable).values({
    tournamentId, firstName: "Pat", lastName: "Player",
    email: `t710-player-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerId = pPlayer.id;

  const [oPlayer] = await db.insert(playersTable).values({
    tournamentId, firstName: "Out", lastName: "Sider",
    email: `t710-outsider-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  outsidePlayerId = oPlayer.id;

  const [tt] = await db.insert(teeTimesTable).values({
    tournamentId,
    teeTime: new Date(),
  }).returning({ id: teeTimesTable.id });
  teeTimeId = tt.id;

  await db.insert(teeTimePlayersTable).values({ teeTimeId, playerId });
  // Note: outsidePlayerId is intentionally NOT added to this group.
});

afterAll(async () => {
  await db.delete(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
  await db.delete(teeTimePlayersTable).where(eq(teeTimePlayersTable.teeTimeId, teeTimeId));
  await db.delete(teeTimesTable).where(eq(teeTimesTable.id, teeTimeId));
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

describe("POST /scorer/groups/:groupId/shots (Task #710)", () => {
  it("inserts a shot with source='scorer' for a player in the scorer's group", async () => {
    const res = await request(scorerApp())
      .post(`/api/scorer/groups/${teeTimeId}/shots`)
      .send({
        playerId, round: 1, holeNumber: 5, shotNumber: 1,
        shotType: "tee", club: "Driver",
        latitude: 28.6139, longitude: 77.2090,
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.shot.source).toBe("scorer");
    expect(res.body.shot.playerId).toBe(playerId);
    expect(res.body.shot.tournamentId).toBe(tournamentId);

    const [row] = await db.select().from(shotsTable).where(and(
      eq(shotsTable.playerId, playerId),
      eq(shotsTable.round, 1),
      eq(shotsTable.holeNumber, 5),
      eq(shotsTable.shotNumber, 1),
    ));
    expect(row).toBeDefined();
    expect(row.source).toBe("scorer");
    expect(row.club).toBe("Driver");
  });

  it("upserts the same (player, round, hole, shotNumber) and keeps source='scorer'", async () => {
    const res = await request(scorerApp())
      .post(`/api/scorer/groups/${teeTimeId}/shots`)
      .send({
        playerId, round: 1, holeNumber: 5, shotNumber: 1,
        shotType: "tee", club: "3W",
      });
    expect(res.status).toBe(200);
    expect(res.body.shot.source).toBe("scorer");
    expect(res.body.shot.club).toBe("3W");

    const rows = await db.select().from(shotsTable).where(and(
      eq(shotsTable.playerId, playerId),
      eq(shotsTable.round, 1),
      eq(shotsTable.holeNumber, 5),
      eq(shotsTable.shotNumber, 1),
    ));
    expect(rows.length).toBe(1);
    expect(rows[0].club).toBe("3W");
    expect(rows[0].source).toBe("scorer");
  });

  it("rejects players who aren't in this scorer's group", async () => {
    const res = await request(scorerApp())
      .post(`/api/scorer/groups/${teeTimeId}/shots`)
      .send({
        playerId: outsidePlayerId, round: 1, holeNumber: 1, shotNumber: 1,
        shotType: "tee",
      });
    expect(res.status).toBe(404);
  });

  it("rejects missing required fields with 400", async () => {
    const res = await request(scorerApp())
      .post(`/api/scorer/groups/${teeTimeId}/shots`)
      .send({ playerId, round: 1, holeNumber: 3 });
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toMatch(/playerId.*holeNumber.*shotNumber/i);
  });

  it("rejects unknown shotType with the allowed list in the error", async () => {
    const res = await request(scorerApp())
      .post(`/api/scorer/groups/${teeTimeId}/shots`)
      .send({
        playerId, round: 1, holeNumber: 4, shotNumber: 1,
        shotType: "moonshot",
      });
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toMatch(/Invalid shotType/i);
  });

  it("rejects calls without a scorer session (401)", async () => {
    const res = await request(scorerApp(false))
      .post(`/api/scorer/groups/${teeTimeId}/shots`)
      .send({
        playerId, round: 1, holeNumber: 6, shotNumber: 1, shotType: "tee",
      });
    expect(res.status).toBe(401);
  });
});
