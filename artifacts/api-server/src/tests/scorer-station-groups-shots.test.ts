/**
 * Task #1370 — confirm GET /api/scorer/groups/:groupId?round=N actually
 * returns the `shots` array (added in Task #1015) so a server-side regression
 * doesn't silently break the mobile scorer screen even though the mobile
 * test (which mocks the API) still passes.
 *
 * The mobile-side test in Task #1180 mocks the API response to assert the
 * scorer screen renders previously-logged shots. Without a server test, a
 * column rename / accidental `delete payload.shots` / wrong filter would
 * ship undetected. This test pins the contract end-to-end against a real
 * database:
 *
 *   - Seed a tournament with one tee-time group containing two players,
 *     plus a third "outsider" player not in the group.
 *   - Seed shots across two rounds and several holes (some for in-group
 *     players, one for the outsider).
 *   - GET /api/scorer/groups/:groupId?round=1 must return a `shots` array
 *     filtered to (a) only the group's players and (b) only round 1.
 *   - Each row must include the fields the mobile screen depends on:
 *     id, playerId, holeNumber, shotNumber, shotType, club, lieType,
 *     latitude, longitude, source.
 *   - Switching `?round=2` must return only round-2 shots for the same
 *     group.
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
  shotsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import router from "../routes/index.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let inGroupPlayerAId: number;
let inGroupPlayerBId: number;
let outsidePlayerId: number;
let teeTimeId: number;

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T1370_${stamp}`,
    slug: `t1370-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T1370 Course",
    slug: `t1370-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T1370 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [pA] = await db.insert(playersTable).values({
    tournamentId, firstName: "Alice", lastName: "InGroup",
    email: `t1370-a-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  inGroupPlayerAId = pA.id;

  const [pB] = await db.insert(playersTable).values({
    tournamentId, firstName: "Bob", lastName: "InGroup",
    email: `t1370-b-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  inGroupPlayerBId = pB.id;

  const [pOut] = await db.insert(playersTable).values({
    tournamentId, firstName: "Olivia", lastName: "Outsider",
    email: `t1370-out-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  outsidePlayerId = pOut.id;

  const [tt] = await db.insert(teeTimesTable).values({
    tournamentId,
    teeTime: new Date(),
    startingHole: 1,
    round: 1,
  }).returning({ id: teeTimesTable.id });
  teeTimeId = tt.id;

  await db.insert(teeTimePlayersTable).values([
    { teeTimeId, playerId: inGroupPlayerAId },
    { teeTimeId, playerId: inGroupPlayerBId },
  ]);
  // outsidePlayerId intentionally NOT in this group.

  // Seed shots:
  //   - Alice round 1 hole 1 shot 1 (tee, Driver, tee lie, w/ GPS, source=watch)
  //   - Alice round 1 hole 1 shot 2 (approach, 7-iron, fairway, source=phone)
  //   - Bob   round 1 hole 3 shot 1 (tee, Driver, source=manual)
  //   - Alice round 2 hole 1 shot 1 (tee, Driver, source=scorer)  — different round
  //   - Outsider round 1 hole 1 shot 1 (tee)                       — different group
  await db.insert(shotsTable).values([
    {
      tournamentId, playerId: inGroupPlayerAId,
      round: 1, holeNumber: 1, shotNumber: 1,
      shotType: "tee", club: "Driver", lieType: "tee",
      latitude: "28.6139000", longitude: "77.2090000",
      source: "watch",
    },
    {
      tournamentId, playerId: inGroupPlayerAId,
      round: 1, holeNumber: 1, shotNumber: 2,
      shotType: "approach", club: "7-iron", lieType: "fairway",
      latitude: "28.6140000", longitude: "77.2091000",
      source: "phone",
    },
    {
      tournamentId, playerId: inGroupPlayerBId,
      round: 1, holeNumber: 3, shotNumber: 1,
      shotType: "tee", club: "Driver", lieType: "tee",
      source: "manual",
    },
    {
      tournamentId, playerId: inGroupPlayerAId,
      round: 2, holeNumber: 1, shotNumber: 1,
      shotType: "tee", club: "Driver", lieType: "tee",
      source: "scorer",
    },
    {
      tournamentId, playerId: outsidePlayerId,
      round: 1, holeNumber: 1, shotNumber: 1,
      shotType: "tee", club: "Driver", lieType: "tee",
      source: "manual",
    },
  ]);
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

type ShotPayload = {
  id: number;
  playerId: number;
  round: number;
  holeNumber: number;
  shotNumber: number;
  shotType: string;
  club: string | null;
  lieType: string | null;
  latitude: string | null;
  longitude: string | null;
  source: string;
};

describe("GET /scorer/groups/:groupId?round=N — shots payload (Task #1370)", () => {
  it("returns shots filtered to the group's players and the requested round", async () => {
    const res = await request(scorerApp()).get(`/api/scorer/groups/${teeTimeId}?round=1`);
    expect(res.status).toBe(200);
    expect(res.body.round).toBe(1);
    expect(Array.isArray(res.body.shots)).toBe(true);

    const shots = res.body.shots as ShotPayload[];

    // Exactly the three round-1 shots for the two in-group players.
    expect(shots.length).toBe(3);

    // Outsider's shot is excluded.
    expect(shots.every((s) => s.playerId !== outsidePlayerId)).toBe(true);

    // No round-2 shots leak into a round=1 request.
    expect(shots.every((s) => s.round === 1)).toBe(true);

    // Both in-group players show up.
    const playerIds = new Set(shots.map((s) => s.playerId));
    expect(playerIds.has(inGroupPlayerAId)).toBe(true);
    expect(playerIds.has(inGroupPlayerBId)).toBe(true);

    // Each row has the fields the mobile scorer screen depends on.
    for (const s of shots) {
      expect(s).toHaveProperty("id");
      expect(typeof s.id).toBe("number");
      expect(s).toHaveProperty("playerId");
      expect(s).toHaveProperty("holeNumber");
      expect(s).toHaveProperty("shotNumber");
      expect(s).toHaveProperty("shotType");
      expect(s).toHaveProperty("club");
      expect(s).toHaveProperty("lieType");
      expect(s).toHaveProperty("latitude");
      expect(s).toHaveProperty("longitude");
      expect(s).toHaveProperty("source");
    }

    // Spot-check Alice's tee shot (the one with GPS coordinates).
    const aliceTee = shots.find(
      (s) => s.playerId === inGroupPlayerAId && s.holeNumber === 1 && s.shotNumber === 1,
    );
    expect(aliceTee).toBeDefined();
    expect(aliceTee!.shotType).toBe("tee");
    expect(aliceTee!.club).toBe("Driver");
    expect(aliceTee!.lieType).toBe("tee");
    expect(aliceTee!.source).toBe("watch");
    // numeric() columns serialize as strings via drizzle.
    expect(aliceTee!.latitude).not.toBeNull();
    expect(aliceTee!.longitude).not.toBeNull();
    expect(Number(aliceTee!.latitude)).toBeCloseTo(28.6139, 4);
    expect(Number(aliceTee!.longitude)).toBeCloseTo(77.2090, 4);

    // Spot-check Bob's hole-3 shot.
    const bobTee = shots.find(
      (s) => s.playerId === inGroupPlayerBId && s.holeNumber === 3 && s.shotNumber === 1,
    );
    expect(bobTee).toBeDefined();
    expect(bobTee!.source).toBe("manual");
  });

  it("returns only round-2 shots when ?round=2 is requested", async () => {
    const res = await request(scorerApp()).get(`/api/scorer/groups/${teeTimeId}?round=2`);
    expect(res.status).toBe(200);
    expect(res.body.round).toBe(2);

    const shots = res.body.shots as ShotPayload[];
    expect(Array.isArray(shots)).toBe(true);
    expect(shots.length).toBe(1);
    expect(shots[0].playerId).toBe(inGroupPlayerAId);
    expect(shots[0].round).toBe(2);
    expect(shots[0].holeNumber).toBe(1);
    expect(shots[0].source).toBe("scorer");
    // Outsider's round-1 shot is not present.
    expect(shots.every((s) => s.playerId !== outsidePlayerId)).toBe(true);
  });
});
