/**
 * Task #867 — scorer-station group/list/detail/course-holes endpoints select
 * real schema columns (not stale `scheduledTime`/`teeName`/`holeStart`).
 *
 *   GET /api/scorer/groups
 *   GET /api/scorer/groups/:groupId
 *   GET /api/scorer/course-holes
 *
 * Each endpoint is exercised end-to-end against a real database so a future
 * column-name drift fails the test rather than silently 500-ing in production.
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
  teeTimesTable,
  teeTimePlayersTable,
  holeDetailsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import router from "../routes/index.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let playerId: number;
let teeTimeId: number;
const teeTimeAt = new Date("2026-05-01T08:30:00Z");

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T867_${stamp}`,
    slug: `t867-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T867 Course",
    slug: `t867-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  await db.insert(holeDetailsTable).values(
    Array.from({ length: 18 }, (_, i) => ({
      courseId,
      holeNumber: i + 1,
      par: 4,
    })),
  );

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T867 Tournament ${stamp}`,
    status: "active",
    localRules: "No gimmes inside the leather.",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [player] = await db.insert(playersTable).values({
    tournamentId, firstName: "Test", lastName: "Player",
    email: `t867-player-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerId = player.id;

  const [tt] = await db.insert(teeTimesTable).values({
    tournamentId,
    teeTime: teeTimeAt,
    startingHole: 10,
    round: 1,
  }).returning({ id: teeTimesTable.id });
  teeTimeId = tt.id;

  await db.insert(teeTimePlayersTable).values({ teeTimeId, playerId });
});

afterAll(async () => {
  await db.delete(teeTimePlayersTable).where(eq(teeTimePlayersTable.teeTimeId, teeTimeId));
  await db.delete(teeTimesTable).where(eq(teeTimesTable.id, teeTimeId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
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

describe("scorer-station group endpoints (Task #867)", () => {
  it("GET /scorer/groups returns the group with real teeTime/startingHole columns", async () => {
    const res = await request(scorerApp()).get("/api/scorer/groups");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const group = res.body.find((g: { teeTimeId: number }) => g.teeTimeId === teeTimeId);
    expect(group).toBeDefined();
    expect(new Date(group.teeTime).toISOString()).toBe(teeTimeAt.toISOString());
    expect(group.startingHole).toBe(10);
    expect(group.round).toBe(1);
    expect(group).not.toHaveProperty("scheduledTime");
    expect(group).not.toHaveProperty("teeName");
    expect(group).not.toHaveProperty("holeStart");

    expect(Array.isArray(group.players)).toBe(true);
    expect(group.players.some((p: { playerId: number }) => p.playerId === playerId)).toBe(true);
  });

  it("GET /scorer/groups/:groupId returns the group detail with players, holes, scores", async () => {
    const res = await request(scorerApp()).get(`/api/scorer/groups/${teeTimeId}?round=1`);
    expect(res.status).toBe(200);
    expect(res.body.teeTime?.id).toBe(teeTimeId);
    expect(res.body.teeTime?.startingHole).toBe(10);
    expect(Array.isArray(res.body.players)).toBe(true);
    expect(res.body.players.some((p: { playerId: number }) => p.playerId === playerId)).toBe(true);
    expect(Array.isArray(res.body.courseHoles)).toBe(true);
    expect(res.body.courseHoles.length).toBe(18);
    expect(Array.isArray(res.body.scores)).toBe(true);
    expect(res.body.round).toBe(1);
  });

  it("GET /scorer/groups/:groupId returns 404 for an unknown group", async () => {
    const res = await request(scorerApp()).get("/api/scorer/groups/99999999");
    expect(res.status).toBe(404);
  });

  it("GET /scorer/course-holes returns the course holes plus tournament local-rules fields", async () => {
    const res = await request(scorerApp()).get("/api/scorer/course-holes");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.holes)).toBe(true);
    expect(res.body.holes.length).toBe(18);
    expect(res.body.holes[0].holeNumber).toBe(1);
    expect(res.body.localRules).toBe("No gimmes inside the leather.");
    expect(res.body).toHaveProperty("localRulesConfig");
  });

  it("rejects calls without a scorer session (401)", async () => {
    const app = scorerApp(false);
    const r1 = await request(app).get("/api/scorer/groups");
    const r2 = await request(app).get(`/api/scorer/groups/${teeTimeId}`);
    const r3 = await request(app).get("/api/scorer/course-holes");
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r3.status).toBe(401);
  });
});
