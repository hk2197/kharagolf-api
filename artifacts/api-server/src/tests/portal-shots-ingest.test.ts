/**
 * Task #691 — HTTP coverage for the live GPS chunk ingest endpoint added in #525.
 *
 *   POST /api/portal/shots/ingest   — buffer mid-round GPS chunks
 *   POST /api/portal/shots/detect   — drain the buffer + commit detected shots
 *
 * The buffer + dedupe primitives are unit-tested in
 * `shot-detection-fusion.test.ts` against a mocked db. This file pins the
 * HTTP layer end-to-end against the real database:
 *
 *   1. A tournament round chunked across two ingest calls and committed
 *      via /shots/detect persists shots derived from the buffered samples,
 *      and the buffer is cleared on commit.
 *   2. A general-play round can do the same, scoped by generalPlayRoundId.
 *   3. Replayed chunks (same timestamps) do not produce duplicate shots.
 *   4. Chunks larger than the 2000-sample cap are rejected with 413.
 *   5. Unauthenticated callers get 401 from both /ingest and /detect.
 *   6. Calling /ingest without enrolment in the target tournament is 403.
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
  shotsTable,
  appUsersTable,
  generalPlayRoundsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
import { peekGPSSamples, clearGPSSamples } from "../lib/shot-detection.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let playerUserId: number;
let outsiderUserId: number;
let playerId: number;
let generalPlayRoundId: number;

// Greens are spaced ~111m apart along the longitude axis (1 deg ≈ 111 km).
// Each "stop" in our synthetic GPS stream is a 5-sample cluster placed
// directly on a green centre — well inside the medium-sensitivity 8m radius
// over the required 4-second dwell window.
const GREEN_LAT = 0.0;
function greenLng(hole: number) { return 0.001 * hole; }

function chunkForHole(hole: number, baseTs: number) {
  // 5 samples spaced 1s apart: 4s elapsed satisfies medium sensitivity
  // (gpsStationarySeconds=4) and 0m drift satisfies the 8m radius.
  return Array.from({ length: 5 }, (_, i) => ({
    lat: GREEN_LAT,
    lng: greenLng(hole),
    timestamp: baseTs + i * 1000,
  }));
}

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T691_${stamp}`,
    slug: `t691-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T691 Course",
    slug: `t691-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  // Real green coordinates so detectShotsFromSignals' loadGreens() sees a
  // mapped course. We map all 18 holes with greens spaced ~111m apart along
  // the longitude axis, so each hole has a distinct nearest-green target.
  await db.insert(holeDetailsTable).values(
    Array.from({ length: 18 }, (_, i) => ({
      courseId,
      holeNumber: i + 1,
      par: 4,
      greenCentreLat: String(GREEN_LAT),
      greenCentreLng: String(greenLng(i + 1)),
    })),
  );

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T691 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [pUser] = await db.insert(appUsersTable).values({
    replitUserId: `t691-player-${stamp}`,
    username: `t691_player_${stamp}`,
  }).returning({ id: appUsersTable.id });
  playerUserId = pUser.id;

  const [oUser] = await db.insert(appUsersTable).values({
    replitUserId: `t691-outsider-${stamp}`,
    username: `t691_outsider_${stamp}`,
  }).returning({ id: appUsersTable.id });
  outsiderUserId = oUser.id;

  const [pPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: playerUserId, firstName: "Pat", lastName: "Player",
    email: `t691-player-${stamp}@example.test`,
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
  await db.delete(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, generalPlayRoundId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, playerUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, outsiderUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function playerApp() {
  return createTestApp({
    id: playerUserId, username: "t691_player", role: "member",
  });
}

function outsiderApp() {
  return createTestApp({
    id: outsiderUserId, username: "t691_outsider", role: "member",
  });
}

function anonApp() {
  return createTestApp(); // no user injected
}

describe("POST /portal/shots/ingest (Task #525 / #691)", () => {
  it("buffers two tournament chunks and commits them via /shots/detect", async () => {
    // Each test picks its own time origin so re-running the suite, or running
    // alongside other tests, never re-uses GPS sample timestamps in the
    // in-memory buffer (timestamp is the dedupe key).
    const t0 = Date.now() - 60 * 60 * 1000;
    const round = 1;
    const ctxKey = `t:${tournamentId}:r:${round}`;
    // Make sure no buffered samples leaked in from a previous test run.
    clearGPSSamples(playerUserId, ctxKey);

    // Chunk 1: hole 1.
    const ingest1 = await request(playerApp())
      .post("/api/portal/shots/ingest")
      .send({ tournamentId, round, gps: chunkForHole(1, t0) });
    expect(ingest1.status).toBe(200);
    expect(ingest1.body.ok).toBe(true);
    expect(ingest1.body.bufferedSamples).toBe(5);

    // Chunk 2: hole 2, well past chunk 1 so the second cluster reads as a
    // distinct GPS stop and the hole-progression logic advances.
    const ingest2 = await request(playerApp())
      .post("/api/portal/shots/ingest")
      .send({ tournamentId, round, gps: chunkForHole(2, t0 + 60_000) });
    expect(ingest2.status).toBe(200);
    expect(ingest2.body.bufferedSamples).toBe(10);

    // Commit at round-end. The detect handler MUST merge the buffered
    // samples with the (empty) request-body gps and persist real shots.
    // We pass a single trailing sample so the gps[] array isn't empty,
    // which would short-circuit detect with a 400.
    const commit = await request(playerApp())
      .post("/api/portal/shots/detect")
      .send({
        tournamentId,
        round,
        commit: true,
        gps: [{ lat: GREEN_LAT, lng: greenLng(2), timestamp: t0 + 60_000 + 4_000 }],
      });
    expect(commit.status).toBe(200);
    expect(commit.body.ok).toBe(true);
    expect(commit.body.inserted).toBeGreaterThanOrEqual(2);

    const rows = await db.select({
      holeNumber: shotsTable.holeNumber,
      shotNumber: shotsTable.shotNumber,
      source: shotsTable.source,
    }).from(shotsTable).where(and(
      eq(shotsTable.playerId, playerId),
      eq(shotsTable.tournamentId, tournamentId),
      eq(shotsTable.round, round),
    ));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const holes = new Set(rows.map(r => r.holeNumber));
    expect(holes.has(1)).toBe(true);
    expect(holes.has(2)).toBe(true);
    // Pure-GPS-derived shots are reported as the "phone" source per #547.
    expect(rows.every(r => r.source === "phone")).toBe(true);

    // Buffer is cleared on commit so a stale re-detect can't replay samples.
    expect((await peekGPSSamples(playerUserId, ctxKey)).length).toBe(0);
  });

  it("buffers two general-play chunks and commits them via /shots/detect", async () => {
    // Mirror the tournament multi-chunk test for the general-play path so
    // both code branches in /portal/shots/ingest (tournament enrolment vs.
    // general-play ownership check) get the same chunked-buffer coverage.
    const t0 = Date.now() - 50 * 60 * 1000;
    const round = 1;
    const ctxKey = `g:${generalPlayRoundId}:r:${round}`;
    clearGPSSamples(playerUserId, ctxKey);

    // Detection always starts hole-progression from hole 1, so chunk at
    // hole 1 first, then hole 2 — this exercises the multi-chunk merge plus
    // the natural hole-advance signature inside detectShotsFromSignals.
    const ingest1 = await request(playerApp())
      .post("/api/portal/shots/ingest")
      .send({ generalPlayRoundId, round, gps: chunkForHole(1, t0) });
    expect(ingest1.status).toBe(200);
    expect(ingest1.body.bufferedSamples).toBe(5);

    const ingest2 = await request(playerApp())
      .post("/api/portal/shots/ingest")
      .send({ generalPlayRoundId, round, gps: chunkForHole(2, t0 + 60_000) });
    expect(ingest2.status).toBe(200);
    expect(ingest2.body.bufferedSamples).toBe(10);

    const commit = await request(playerApp())
      .post("/api/portal/shots/detect")
      .send({
        generalPlayRoundId,
        round,
        commit: true,
        gps: [{ lat: GREEN_LAT, lng: greenLng(2), timestamp: t0 + 60_000 + 4_500 }],
      });
    expect(commit.status).toBe(200);
    expect(commit.body.inserted).toBeGreaterThanOrEqual(2);

    const rows = await db.select({
      holeNumber: shotsTable.holeNumber,
      userId: shotsTable.userId,
      tournamentId: shotsTable.tournamentId,
      generalPlayRoundId: shotsTable.generalPlayRoundId,
    }).from(shotsTable).where(and(
      eq(shotsTable.userId, playerUserId),
      eq(shotsTable.generalPlayRoundId, generalPlayRoundId),
      eq(shotsTable.round, round),
    ));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Tournament-scoped fields stay null on a general-play insert path.
    expect(rows.every(r => r.tournamentId === null)).toBe(true);
    expect(rows.every(r => r.generalPlayRoundId === generalPlayRoundId)).toBe(true);
    const holes = new Set(rows.map(r => r.holeNumber));
    expect(holes.has(1)).toBe(true);
    expect(holes.has(2)).toBe(true);

    expect((await peekGPSSamples(playerUserId, ctxKey)).length).toBe(0);
  });

  it("does not produce duplicate shots when the same chunk is replayed", async () => {
    // A network blip in production causes the phone to retry the previous
    // chunk. Because the buffer dedupes by sample timestamp, a replay must
    // contribute zero new samples and the committed shot count must equal
    // the single-send case.
    const t0 = Date.now() - 40 * 60 * 1000;
    const round = 2; // distinct round so we don't collide with the first test
    const ctxKey = `t:${tournamentId}:r:${round}`;
    clearGPSSamples(playerUserId, ctxKey);

    const chunk = chunkForHole(5, t0);

    const first = await request(playerApp())
      .post("/api/portal/shots/ingest")
      .send({ tournamentId, round, gps: chunk });
    expect(first.status).toBe(200);
    expect(first.body.bufferedSamples).toBe(5);

    // Replay — identical timestamps. Server must dedupe.
    const replay = await request(playerApp())
      .post("/api/portal/shots/ingest")
      .send({ tournamentId, round, gps: chunk });
    expect(replay.status).toBe(200);
    expect(replay.body.bufferedSamples).toBe(5);

    const commit = await request(playerApp())
      .post("/api/portal/shots/detect")
      .send({
        tournamentId,
        round,
        commit: true,
        // Resend the same chunk again at commit time — still no duplicates.
        gps: chunk,
      });
    expect(commit.status).toBe(200);

    const rows = await db.select({ id: shotsTable.id })
      .from(shotsTable)
      .where(and(
        eq(shotsTable.playerId, playerId),
        eq(shotsTable.tournamentId, tournamentId),
        eq(shotsTable.round, round),
      ));
    // A single GPS-stop cluster yields exactly one detected shot.
    expect(rows.length).toBe(1);
  });

  it("rejects a chunk larger than the 2000-sample cap with 413", async () => {
    const t0 = Date.now() - 30 * 60 * 1000;
    const oversized = Array.from({ length: 2001 }, (_, i) => ({
      lat: GREEN_LAT, lng: greenLng(1), timestamp: t0 + i,
    }));
    const res = await request(playerApp())
      .post("/api/portal/shots/ingest")
      .send({ tournamentId, round: 3, gps: oversized });
    expect(res.status).toBe(413);
    expect(String(res.body?.error ?? "")).toMatch(/2000 samples/i);

    // And a 2000-sample chunk is accepted right at the cap.
    const atCap = Array.from({ length: 2000 }, (_, i) => ({
      lat: GREEN_LAT, lng: greenLng(1), timestamp: t0 + 5_000_000 + i,
    }));
    const ok = await request(playerApp())
      .post("/api/portal/shots/ingest")
      .send({ tournamentId, round: 3, gps: atCap });
    expect(ok.status).toBe(200);
    // Cleanup so this test's samples do not leak into later cases.
    clearGPSSamples(playerUserId, `t:${tournamentId}:r:3`);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const ingest = await request(anonApp())
      .post("/api/portal/shots/ingest")
      .send({ tournamentId, round: 1, gps: [] });
    expect(ingest.status).toBe(401);

    const detect = await request(anonApp())
      .post("/api/portal/shots/detect")
      .send({ tournamentId, round: 1, gps: [] });
    expect(detect.status).toBe(401);
  });

  it("rejects callers who are not enrolled in the target tournament with 403", async () => {
    const t0 = Date.now() - 20 * 60 * 1000;
    const res = await request(outsiderApp())
      .post("/api/portal/shots/ingest")
      .send({ tournamentId, round: 1, gps: chunkForHole(1, t0) });
    expect(res.status).toBe(403);
    expect(String(res.body?.error ?? "")).toMatch(/not enrolled/i);
  });

  it("rejects /ingest without tournamentId or generalPlayRoundId with 400", async () => {
    const res = await request(playerApp())
      .post("/api/portal/shots/ingest")
      .send({ round: 1, gps: [] });
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toMatch(/tournamentId.*generalPlayRoundId/i);
  });
});
