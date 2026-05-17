/**
 * Integration tests: Garmin Connect IQ round-sync endpoints.
 *
 * Covers Task #553:
 *   1. POST /api/portal/watch/sync with platform="garmin_ciq"
 *      - refreshes the existing garmin_ciq wearable_connections row
 *        (status=connected, updatedAt advanced) instead of inserting a duplicate
 *      - returns a fresh watchToken
 *   2. POST /api/portal/watch/sync-round
 *      - given a player with pre-recorded GPS waypoints in `shots`,
 *        the inference pipeline assigns holeNumber + shotType to each
 *        waypoint and the rows are updated in place.
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
  appUsersTable,
  wearableConnectionsTable,
  shotsTable,
} from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let testOrgId: number;
let testCourseId: number;
let testTournamentId: number;
let testUserId: number;
let testPlayerId: number;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_GarminSync_${stamp}`,
    slug: `test-garmin-sync-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Garmin Sync Course",
    slug: `garmin-sync-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  // Distinct green coords per hole so the nearest-green inference is
  // deterministic. Hole N green sits at (10 + N*0.01, 20.0); ~1.1 km apart.
  const holes = Array.from({ length: 18 }, (_, i) => ({
    courseId: testCourseId,
    holeNumber: i + 1,
    par: 4,
    yardageWhite: 400,
    greenCentreLat: (10 + (i + 1) * 0.01).toFixed(7),
    greenCentreLng: "20.0000000",
  }));
  await db.insert(holeDetailsTable).values(holes);

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Garmin Sync Tournament ${stamp}`,
    format: "stroke_play",
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = tournament.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `garmin-sync-test-${stamp}`,
    username: `garmin_sync_test_${stamp}`,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;

  const [player] = await db.insert(playersTable).values({
    tournamentId: testTournamentId,
    userId: testUserId,
    firstName: "Garmin",
    lastName: "SyncTester",
    currentRound: 1,
  }).returning({ id: playersTable.id });
  testPlayerId = player.id;
});

afterAll(async () => {
  await db.delete(shotsTable).where(eq(shotsTable.playerId, testPlayerId));
  await db.delete(wearableConnectionsTable).where(eq(wearableConnectionsTable.userId, testUserId));
  await db.delete(playersTable).where(eq(playersTable.id, testPlayerId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, testTournamentId));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, testCourseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

// ──────────────────────────────────────────────────────────────────────────
// 1. POST /api/portal/watch/sync — garmin_ciq refreshes existing connection
// ──────────────────────────────────────────────────────────────────────────
describe("POST /api/portal/watch/sync — garmin_ciq", () => {
  it("refreshes the existing garmin_ciq connection and issues a fresh watchToken", async () => {
    // Seed an existing garmin_ciq connection with a stale updatedAt.
    await db.delete(wearableConnectionsTable).where(eq(wearableConnectionsTable.userId, testUserId));
    const stale = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
    await db.insert(wearableConnectionsTable).values({
      userId: testUserId,
      provider: "garmin_ciq",
      status: "disconnected",
      connectedAt: stale,
      updatedAt: stale,
    });

    const app = createTestApp({ id: testUserId, username: "garmin_sync_test", role: "member" });
    const before = Date.now();
    const res = await request(app)
      .post("/api/portal/watch/sync")
      .send({ platform: "garmin_ciq" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.watchToken).toBe("string");
    expect(res.body.watchToken.length).toBeGreaterThan(0);

    // The same row must have been updated in place — no duplicate inserted.
    const conns = await db.select()
      .from(wearableConnectionsTable)
      .where(and(
        eq(wearableConnectionsTable.userId, testUserId),
        eq(wearableConnectionsTable.provider, "garmin_ciq"),
      ));
    expect(conns).toHaveLength(1);
    const conn = conns[0]!;
    expect(conn.status).toBe("connected");
    expect(conn.updatedAt).toBeTruthy();
    expect(conn.updatedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // updatedAt should have moved well past the stale 7-day-old timestamp.
    expect(conn.updatedAt!.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("inserts a new garmin_ciq connection when none exists yet", async () => {
    await db.delete(wearableConnectionsTable).where(eq(wearableConnectionsTable.userId, testUserId));

    const app = createTestApp({ id: testUserId, username: "garmin_sync_test", role: "member" });
    const res = await request(app)
      .post("/api/portal/watch/sync")
      .send({ platform: "garmin_ciq" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.watchToken).toBe("string");

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
});

// ──────────────────────────────────────────────────────────────────────────
// 2. POST /api/portal/watch/sync-round — GPS-to-shot inference
// ──────────────────────────────────────────────────────────────────────────
describe("POST /api/portal/watch/sync-round — garmin_ciq", () => {
  it("infers holeNumber + shotType for stored GPS waypoints and updates the rows", async () => {
    // Wipe any prior shots for this player.
    await db.delete(shotsTable).where(eq(shotsTable.playerId, testPlayerId));

    // Hole 1 green is at (10.01, 20.0); hole 2 at (10.02, 20.0).
    // Waypoints walk the player from far away into hole 1's green, then into
    // hole 2's green, mimicking what the watch records during a round.
    const baseTime = Date.now() - 60 * 60 * 1000; // started an hour ago
    const waypoints: Array<{ lat: number; lon: number; offsetSec: number }> = [
      { lat: 10.005, lon: 20.0, offsetSec: 0 },    // ~555m from hole 1 green → tee
      { lat: 10.009, lon: 20.0, offsetSec: 60 },   // ~111m from hole 1 green → approach
      { lat: 10.01,  lon: 20.0, offsetSec: 120 },  // on hole 1 green → putt; advance
      { lat: 10.015, lon: 20.0, offsetSec: 240 },  // ~555m from hole 2 green → tee
      { lat: 10.02,  lon: 20.0, offsetSec: 300 },  // on hole 2 green → putt; advance
    ];

    // Seed `shots` rows the way the watch streaming pipeline does — each row
    // carries lat/lon + recordedAt but no shotType/holeNumber inference yet.
    // (holeNumber is NOT NULL in the schema; use a placeholder of 0 that the
    // sync-round endpoint will overwrite.)
    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i]!;
      await db.insert(shotsTable).values({
        tournamentId: testTournamentId,
        playerId: testPlayerId,
        userId: testUserId,
        round: 1,
        holeNumber: 0,
        // (playerId, tournamentId, round, holeNumber, shotNumber) is unique;
        // use sequential shotNumbers to avoid placeholder collisions before
        // the sync-round endpoint overwrites holeNumber/shotNumber.
        shotNumber: i + 1,
        latitude: String(wp.lat),
        longitude: String(wp.lon),
        recordedAt: new Date(baseTime + wp.offsetSec * 1000),
      });
    }

    const app = createTestApp({ id: testUserId, username: "garmin_sync_test", role: "member" });
    const res = await request(app)
      .post("/api/portal/watch/sync-round")
      .send({ tournamentId: testTournamentId, round: 1 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.shotsInferred).toBe(waypoints.length);

    // Re-read the rows in recordedAt order and verify inference ran.
    const stored = await db.select()
      .from(shotsTable)
      .where(and(
        eq(shotsTable.playerId, testPlayerId),
        eq(shotsTable.tournamentId, testTournamentId),
        eq(shotsTable.round, 1),
      ))
      .orderBy(asc(shotsTable.recordedAt));

    expect(stored).toHaveLength(waypoints.length);

    // Hole 1: three waypoints (tee → approach → putt), then advance.
    expect(stored[0]!.holeNumber).toBe(1);
    expect(stored[0]!.shotNumber).toBe(1);
    expect(stored[0]!.shotType).toBe("tee");

    expect(stored[1]!.holeNumber).toBe(1);
    expect(stored[1]!.shotNumber).toBe(2);
    expect(stored[1]!.shotType).toBe("approach");

    expect(stored[2]!.holeNumber).toBe(1);
    expect(stored[2]!.shotNumber).toBe(3);
    expect(stored[2]!.shotType).toBe("putt");

    // Hole 2: tee then putt onto green.
    expect(stored[3]!.holeNumber).toBe(2);
    expect(stored[3]!.shotNumber).toBe(1);
    expect(stored[3]!.shotType).toBe("tee");

    expect(stored[4]!.holeNumber).toBe(2);
    expect(stored[4]!.shotNumber).toBe(2);
    expect(stored[4]!.shotType).toBe("putt");

    // distanceToPin should have been populated for every row.
    for (const s of stored) {
      expect(s.distanceToPin).not.toBeNull();
      expect(parseFloat(s.distanceToPin as unknown as string)).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns shotsInferred=0 with a friendly message when no GPS waypoints exist", async () => {
    await db.delete(shotsTable).where(eq(shotsTable.playerId, testPlayerId));

    const app = createTestApp({ id: testUserId, username: "garmin_sync_test", role: "member" });
    const res = await request(app)
      .post("/api/portal/watch/sync-round")
      .send({ tournamentId: testTournamentId, round: 1 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.shotsInferred).toBe(0);
    expect(String(res.body.message)).toMatch(/no gps waypoints/i);
  });

  it("rejects sync-round when the user is not enrolled in the tournament", async () => {
    // Create a brand-new user with no player row in our tournament.
    const stamp = Date.now();
    const [stranger] = await db.insert(appUsersTable).values({
      replitUserId: `garmin-sync-stranger-${stamp}`,
      username: `garmin_sync_stranger_${stamp}`,
    }).returning({ id: appUsersTable.id });

    try {
      const app = createTestApp({ id: stranger.id, username: "garmin_sync_stranger", role: "member" });
      const res = await request(app)
        .post("/api/portal/watch/sync-round")
        .send({ tournamentId: testTournamentId, round: 1 });

      expect(res.status).toBe(403);
      expect(String(res.body.error)).toMatch(/not enrolled/i);
    } finally {
      await db.delete(appUsersTable).where(eq(appUsersTable.id, stranger.id));
    }
  });
});
