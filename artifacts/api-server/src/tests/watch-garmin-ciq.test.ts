/**
 * Integration tests: Garmin Connect IQ pairing & live scoring
 *
 * Covers Task #425:
 *   1. POST /api/public/watch/pair with platform="garmin_ciq" pairs the watch
 *      using the code-only path and writes a `garmin_ciq` row to
 *      `wearable_connections`.
 *   2. GET  /api/portal/watch/active-context returns `{ active: false }` when
 *      the user is not enrolled in any active tournament, and the correct
 *      hole + toPar payload when they are (with real per-hole pars).
 *   3. GET  /api/portal/watch/status surfaces the new `garminCiq` field once a
 *      Garmin Connect IQ pairing exists.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  holeDetailsTable,
  tournamentsTable,
  playersTable,
  scoresTable,
  appUsersTable,
  wearableConnectionsTable,
  watchPairingChallengesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let testOrgId: number;
let testCourseId: number;
let testTournamentId: number;
let testUserId: number;
let testPlayerId: number;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_GarminCiq_${stamp}`,
    slug: `test-garmin-ciq-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Garmin CIQ Course",
    slug: `garmin-ciq-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  // Seed real per-hole pars so toPar math is non-trivial:
  // hole 1 par 5, hole 2 par 3, hole 3 par 4, holes 4-18 par 4.
  const holes = Array.from({ length: 18 }, (_, i) => ({
    courseId: testCourseId,
    holeNumber: i + 1,
    par: i === 0 ? 5 : i === 1 ? 3 : 4,
    yardageWhite: 400,
    greenCentreLat: "12.9716000",
    greenCentreLng: "77.5946000",
  }));
  await db.insert(holeDetailsTable).values(holes);

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Garmin CIQ Tournament ${stamp}`,
    format: "stroke_play",
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = tournament.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `garmin-ciq-test-${stamp}`,
    username: `garmin_ciq_test_${stamp}`,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;
});

afterAll(async () => {
  await db.delete(wearableConnectionsTable).where(eq(wearableConnectionsTable.userId, testUserId));
  await db.delete(watchPairingChallengesTable).where(eq(watchPairingChallengesTable.userId, testUserId));
  await db.delete(scoresTable).where(eq(scoresTable.tournamentId, testTournamentId));
  if (testPlayerId) {
    await db.delete(playersTable).where(eq(playersTable.id, testPlayerId));
  }
  await db.delete(playersTable).where(eq(playersTable.tournamentId, testTournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, testTournamentId));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, testCourseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

// ──────────────────────────────────────────────────────────────────────────
// 1. POST /api/public/watch/pair — platform="garmin_ciq" code-only path
// ──────────────────────────────────────────────────────────────────────────
describe("POST /api/public/watch/pair — garmin_ciq", () => {
  it("pairs via the code-only path and writes a garmin_ciq wearable_connections row", async () => {
    // Clean any prior pairing so onConflictDoUpdate vs insert is unambiguous.
    await db.delete(wearableConnectionsTable).where(and(
      eq(wearableConnectionsTable.userId, testUserId),
      eq(wearableConnectionsTable.provider, "garmin_ciq"),
    ));
    await db.delete(watchPairingChallengesTable).where(eq(watchPairingChallengesTable.userId, testUserId));

    const code = "123456";
    await db.insert(watchPairingChallengesTable).values({
      userId: testUserId,
      code,
      platform: "any",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    // No session — public route.
    const app = createTestApp();
    const res = await request(app)
      .post("/api/public/watch/pair")
      .send({ code, platform: "garmin_ciq" }); // no challengeId — code-only

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.watchToken).toBe("string");
    expect(res.body.watchToken.length).toBeGreaterThan(0);

    const [conn] = await db.select()
      .from(wearableConnectionsTable)
      .where(and(
        eq(wearableConnectionsTable.userId, testUserId),
        eq(wearableConnectionsTable.provider, "garmin_ciq"),
      ));
    expect(conn).toBeTruthy();
    expect(conn.provider).toBe("garmin_ciq");
    expect(conn.status).toBe("connected");
  });

  it("rejects code-only pairing when platform is not garmin_ciq (challengeId required)", async () => {
    await db.delete(watchPairingChallengesTable).where(eq(watchPairingChallengesTable.userId, testUserId));
    const code = "654321";
    await db.insert(watchPairingChallengesTable).values({
      userId: testUserId,
      code,
      platform: "any",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const app = createTestApp();
    const res = await request(app)
      .post("/api/public/watch/pair")
      .send({ code }); // no platform, no challengeId

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/challengeId/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2. GET /api/portal/watch/active-context
// ──────────────────────────────────────────────────────────────────────────
describe("GET /api/portal/watch/active-context", () => {
  it("returns { active: false } when the user is not enrolled in any active tournament", async () => {
    // Ensure no enrollment exists.
    await db.delete(playersTable).where(eq(playersTable.userId, testUserId));

    const app = createTestApp({ id: testUserId, username: "garmin_ciq_test", role: "member" });
    const res = await request(app).get("/api/portal/watch/active-context");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it("returns the next unscored hole and correct toPar when the user is enrolled", async () => {
    // Ensure a clean enrollment + scores.
    await db.delete(scoresTable).where(eq(scoresTable.tournamentId, testTournamentId));
    await db.delete(playersTable).where(eq(playersTable.userId, testUserId));

    const [player] = await db.insert(playersTable).values({
      tournamentId: testTournamentId,
      userId: testUserId,
      firstName: "Garmin",
      lastName: "Tester",
      currentRound: 1,
    }).returning({ id: playersTable.id });
    testPlayerId = player.id;

    // Pre-score hole 1 (par 5) with 6 strokes (+1) and hole 2 (par 3) with 2 strokes (-1).
    // Net toPar should be 0; next unscored hole is 3.
    await db.insert(scoresTable).values([
      { tournamentId: testTournamentId, playerId: testPlayerId, round: 1, holeNumber: 1, strokes: 6 },
      { tournamentId: testTournamentId, playerId: testPlayerId, round: 1, holeNumber: 2, strokes: 2 },
    ]);

    const app = createTestApp({ id: testUserId, username: "garmin_ciq_test", role: "member" });
    const res = await request(app).get("/api/portal/watch/active-context");
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.tournamentId).toBe(testTournamentId);
    expect(res.body.playerId).toBe(testPlayerId);
    expect(res.body.round).toBe(1);
    expect(res.body.holeNumber).toBe(3);
    expect(res.body.par).toBe(4);                // hole 3 par
    expect(res.body.toPar).toBe(0);              // (6-5) + (2-3) = 0
    expect(res.body.holesPlayed).toBe(2);
    expect(res.body.holeStrokes).toBe(0);        // hole 3 not yet scored
    expect(res.body.greenLat).toBeCloseTo(12.9716, 3);
    expect(res.body.greenLon).toBeCloseTo(77.5946, 3);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3. GET /api/portal/watch/status — surfaces garminCiq field
// ──────────────────────────────────────────────────────────────────────────
describe("GET /api/portal/watch/status — garminCiq field", () => {
  it("returns garminCiq=null before any Garmin Connect IQ pairing exists", async () => {
    await db.delete(wearableConnectionsTable).where(eq(wearableConnectionsTable.userId, testUserId));

    const app = createTestApp({ id: testUserId, username: "garmin_ciq_test", role: "member" });
    const res = await request(app).get("/api/portal/watch/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("garminCiq", null);
  });

  it("reports connected=true after a garmin_ciq row has been inserted", async () => {
    await db.delete(wearableConnectionsTable).where(eq(wearableConnectionsTable.userId, testUserId));
    await db.insert(wearableConnectionsTable).values({
      userId: testUserId,
      provider: "garmin_ciq",
      status: "connected",
      connectedAt: new Date(),
      updatedAt: new Date(),
    });

    const app = createTestApp({ id: testUserId, username: "garmin_ciq_test", role: "member" });
    const res = await request(app).get("/api/portal/watch/status");
    expect(res.status).toBe(200);
    expect(res.body.garminCiq).toBeTruthy();
    expect(res.body.garminCiq.connected).toBe(true);
    expect(res.body.garminCiq.lastSync).toBeTruthy();
  });
});
