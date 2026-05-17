/**
 * Task #689 — server coverage for the `acceptedShots` commit branch added to
 *
 *   POST /api/portal/shots/detect      (artifacts/api-server/src/routes/portal.ts)
 *
 * The mobile auto-detect review modal lets the player tick / untick proposed
 * shots and inline-edit each row's shotType + club, then commits with
 * `commit: true` and an explicit `acceptedShots` array. The route MUST then
 * persist exactly that subset (with the player's overrides) and ignore
 * anything else the engine would otherwise have detected from the same gps
 * + wearable signals.
 *
 * These tests pin that contract end-to-end against a real Postgres:
 *   1. With three wearable swings the engine would propose three shots
 *      (echoed in `proposed`), but `acceptedShots` containing only one
 *      row — with an overridden shotType + club — results in exactly one
 *      shotsTable row, carrying the player's overrides.
 *   2. With `commit: true` and `acceptedShots: []` no shots are persisted
 *      (player unticked everything in the modal).
 *   3. Without `acceptedShots` (legacy clients pre-#526) the route falls
 *      back to persisting everything the engine detected.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  holeDetailsTable,
  tournamentsTable,
  playersTable,
  shotsTable,
  appUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let playerUserId: number;
let playerId: number;

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T689_${stamp}`,
    slug: `t689-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T689 Course",
    slug: `t689-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  // Greens at lng 0.001 * holeNumber so the detection engine has a
  // coordinate frame to assign shots to holes (mirrors the deterministic
  // setup in shot-detection-fusion.test.ts).
  await db.insert(holeDetailsTable).values(
    Array.from({ length: 18 }, (_, i) => ({
      courseId, holeNumber: i + 1,
      par: 4,
      greenCentreLat: "0.0",
      greenCentreLng: String(0.001 * (i + 1)),
    })),
  );

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T689 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [pUser] = await db.insert(appUsersTable).values({
    replitUserId: `t689-player-${stamp}`,
    username: `t689_player_${stamp}`,
  }).returning({ id: appUsersTable.id });
  playerUserId = pUser.id;

  const [pPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: playerUserId, firstName: "Pat", lastName: "Player",
    email: `t689-player-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerId = pPlayer.id;
});

afterAll(async () => {
  await db.delete(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, playerUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  // Each test commits into shotsTable for this player; clear so tests are
  // independent and assert on absolute row counts.
  await db.delete(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
});

function playerApp() {
  return createTestApp({
    id: playerUserId, username: "t689_player", role: "member",
  });
}

const T0 = Date.parse("2026-04-19T10:00:00Z");

// Three swings the engine will treat as wearable shots — each maps to a
// different hole via its lng (greens at 0.001*hole). The route still
// requires a non-empty `gps` array even when wearable signals carry the
// real classifications, so we send a small filler buffer alongside.
const WEARABLE_SHOTS = [
  { lat: 0.0, lng: 0.001, timestamp: T0,           shotType: "tee",      club: "driver" },
  { lat: 0.0, lng: 0.002, timestamp: T0 + 600_000, shotType: "approach", club: "9i"     },
  { lat: 0.0, lng: 0.003, timestamp: T0 + 1_200_000, shotType: "putt",   club: "putter" },
];

const FILLER_GPS = Array.from({ length: 5 }, (_, i) => ({
  lat: 0.0, lng: 0.0005, timestamp: T0 - 60_000 + i * 1000,
}));

describe("POST /portal/shots/detect — acceptedShots commit branch (Task #689)", () => {
  it("persists exactly the supplied acceptedShots subset with the player's shotType/club overrides", async () => {
    // Player kept only the second of three engine proposals AND edited it:
    // the engine said "approach with 9i", the player corrected it to
    // "chip with PW". The other two proposals must be dropped.
    const accepted = [{
      holeNumber: 2, shotNumber: 1,
      shotType: "chip", club: "PW",
      latitude: 0.0, longitude: 0.002,
      distanceToPinYards: 12.3,
      recordedAt: new Date(T0 + 600_000).toISOString(),
      source: "wearable",
      confidence: 0.9,
    }];

    const res = await request(playerApp())
      .post("/api/portal/shots/detect")
      .send({
        tournamentId,
        round: 1,
        courseId,
        gps: FILLER_GPS,
        wearableShots: WEARABLE_SHOTS,
        sensitivity: "medium",
        commit: true,
        acceptedShots: accepted,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Engine still ran and reported its proposals — the contract is that
    // `proposed` echoes detection while `inserted` reflects only the
    // accepted subset. With three wearable swings the engine should have
    // proposed at least the two we did NOT accept (proves we are actually
    // overriding, not just persisting what detection happened to produce).
    expect(Array.isArray(res.body.proposed)).toBe(true);
    expect(res.body.proposed.length).toBeGreaterThanOrEqual(2);
    expect(res.body.inserted).toBe(1);

    const rows = await db.select().from(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // Player's overrides won — NOT the engine's "approach / 9i".
    expect(row.shotType).toBe("chip");
    expect(row.club).toBe("PW");
    // Hole/shot numbers + position came from the accepted row, not the
    // engine's hole-assignment logic for this swing.
    expect(row.holeNumber).toBe(2);
    expect(row.shotNumber).toBe(1);
    expect(row.playerId).toBe(playerId);
    expect(row.tournamentId).toBe(tournamentId);
    // Distance round-tripped from the accepted payload.
    expect(parseFloat(String(row.distanceToPin))).toBeCloseTo(12.3, 5);
  });

  it("persists nothing when commit:true but acceptedShots is empty (player unticked everything)", async () => {
    const res = await request(playerApp())
      .post("/api/portal/shots/detect")
      .send({
        tournamentId,
        round: 1,
        courseId,
        gps: FILLER_GPS,
        wearableShots: WEARABLE_SHOTS,
        sensitivity: "medium",
        commit: true,
        acceptedShots: [],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.inserted).toBe(0);

    const rows = await db.select().from(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
    expect(rows).toHaveLength(0);
  });

  it("falls back to persisting all engine-detected shots when acceptedShots is omitted (legacy client)", async () => {
    // Pre-#526 clients commit without an acceptedShots field — the route
    // must still persist what the engine detected so older builds keep
    // working. Three wearable shots → at least three rows.
    const res = await request(playerApp())
      .post("/api/portal/shots/detect")
      .send({
        tournamentId,
        round: 1,
        courseId,
        gps: FILLER_GPS,
        wearableShots: WEARABLE_SHOTS,
        sensitivity: "medium",
        commit: true,
        // no acceptedShots
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.inserted).toBeGreaterThanOrEqual(3);

    const rows = await db.select().from(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // The engine preserves wearable-provided shotType + club end-to-end,
    // so at least the "tee/driver" and "putt/putter" overrides should
    // appear unchanged in the persisted rows.
    const shotTypes = new Set(rows.map(r => r.shotType));
    expect(shotTypes.has("tee")).toBe(true);
    expect(shotTypes.has("putt")).toBe(true);
  });
});
