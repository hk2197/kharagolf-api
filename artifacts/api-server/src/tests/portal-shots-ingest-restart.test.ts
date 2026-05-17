/**
 * Task #853 — End-to-end durability test for the live GPS chunk buffer
 * (Task #525, persisted in Task #690).
 *
 * Task #690 added a unit-level "simulated restart" test in
 * shot-detection-fusion.test.ts that resets the module graph between a
 * `bufferGPSSamples` write and a `peekGPSSamples` read. That covers the
 * library layer in isolation. This test exercises the full HTTP contract:
 *
 *   1. POST /portal/shots/ingest twice with two distinct hole clusters.
 *   2. Simulate an API server restart by calling `vi.resetModules()` and
 *      re-importing the test app helper so the route module + its
 *      shot-detection lib are loaded fresh (no carry-over module state).
 *   3. POST /portal/shots/detect with `commit: true` against the freshly
 *      loaded app and assert the proposed shot count + the persisted shot
 *      rows match the un-restarted baseline collected in a sibling test.
 *
 * The buffer is backed by Postgres (`gps_chunk_buffer`), not by an
 * in-process Map, so a real restart drops zero state — the test just has
 * to prove that the route module has no hidden in-memory cache that would
 * be lost across `vi.resetModules()`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  appUsersTable,
  coursesTable,
  db,
  generalPlayRoundsTable,
  gpsChunkBufferTable,
  holeDetailsTable,
  organizationsTable,
  playersTable,
  shotsTable,
  tournamentsTable,
} from "@workspace/db";
import { createTestApp } from "./helpers.js";
import { clearGPSSamples, peekGPSSamples } from "../lib/shot-detection.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let userId: number;
let playerId: number;

// Greens spaced ~111m apart along the longitude axis so each hole has a
// distinct nearest-green target. Each "stop" is a 5-sample cluster on the
// green, well inside the medium-sensitivity 8m radius for the required
// 4-second dwell window.
const GREEN_LAT = 0.0;
function greenLng(hole: number) { return 0.001 * hole; }
function chunkForHole(hole: number, baseTs: number) {
  return Array.from({ length: 5 }, (_, i) => ({
    lat: GREEN_LAT,
    lng: greenLng(hole),
    timestamp: baseTs + i * 1000,
  }));
}

beforeAll(async () => {
  // The /portal/shots/detect commit path uses ON CONFLICT against a unique
  // shot tuple. The test DB is synced from the schema which only ships the
  // non-unique helper indexes, so create a matching unique index here.
  await db.execute(sql`
    DROP INDEX IF EXISTS shots_player_tournament_round_hole_shot_unique
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX shots_player_tournament_round_hole_shot_unique
      ON shots (player_id, tournament_id, round, hole_number, shot_number)
  `);

  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T853_${stamp}`,
    slug: `t853-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T853 Course",
    slug: `t853-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  await db.insert(holeDetailsTable).values(
    Array.from({ length: 18 }, (_, i) => ({
      courseId,
      holeNumber: i + 1,
      par: 4,
      greenCentreLat: String(GREEN_LAT),
      greenCentreLng: String(greenLng(i + 1)),
    })),
  );

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T853 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `t853-player-${stamp}`,
    username: `t853_player_${stamp}`,
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  const [p] = await db.insert(playersTable).values({
    tournamentId,
    userId,
    firstName: "Pat",
    lastName: "Player",
    email: `t853-player-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerId = p.id;
});

afterAll(async () => {
  await db.delete(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
  await db.delete(gpsChunkBufferTable).where(eq(gpsChunkBufferTable.userId, userId));
  await db.delete(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.userId, userId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  await db.execute(sql`DROP INDEX IF EXISTS shots_player_tournament_round_hole_shot_unique`);
});

function appAs() {
  return createTestApp({ id: userId, username: "t853_player", role: "member" });
}

interface BaselineSummary {
  proposedCount: number;
  inserted: number;
  holes: number[];
}

async function ingestTwoChunksAndCommit(
  appFactory: () => ReturnType<typeof createTestApp>,
  detectAppFactory: () => ReturnType<typeof createTestApp>,
  round: number,
  t0: number,
): Promise<BaselineSummary> {
  // Chunk 1: hole 1.
  const ingest1 = await request(appFactory())
    .post("/api/portal/shots/ingest")
    .send({ tournamentId, round, gps: chunkForHole(1, t0) });
  expect(ingest1.status).toBe(200);
  expect(ingest1.body.bufferedSamples).toBe(5);

  // Chunk 2: hole 2, well past chunk 1 so the second cluster reads as a
  // distinct GPS stop and the hole-progression logic advances.
  const ingest2 = await request(appFactory())
    .post("/api/portal/shots/ingest")
    .send({ tournamentId, round, gps: chunkForHole(2, t0 + 60_000) });
  expect(ingest2.status).toBe(200);
  expect(ingest2.body.bufferedSamples).toBe(10);

  // The route's commit branch requires a non-empty gps[] in the body; pass
  // a single trailing sample so the request is accepted and rely on the
  // server-buffered samples to drive the actual detection.
  const commit = await request(detectAppFactory())
    .post("/api/portal/shots/detect")
    .send({
      tournamentId,
      round,
      commit: true,
      gps: [{ lat: GREEN_LAT, lng: greenLng(2), timestamp: t0 + 60_000 + 4_000 }],
    });
  expect(commit.status).toBe(200);
  expect(commit.body.ok).toBe(true);

  const rows = await db
    .select({
      holeNumber: shotsTable.holeNumber,
      shotNumber: shotsTable.shotNumber,
    })
    .from(shotsTable)
    .where(and(
      eq(shotsTable.playerId, playerId),
      eq(shotsTable.tournamentId, tournamentId),
      eq(shotsTable.round, round),
    ));

  return {
    proposedCount: Array.isArray(commit.body.proposed) ? commit.body.proposed.length : 0,
    inserted: commit.body.inserted ?? 0,
    holes: rows.map(r => r.holeNumber).sort((a, b) => a - b),
  };
}

describe("GPS chunk buffer survives an API restart end-to-end (Task #853)", () => {
  let baseline: BaselineSummary;

  it("captures an un-restarted baseline: chunks → detect → persisted shots", async () => {
    const round = 11;
    const ctxKey = `t:${tournamentId}:r:${round}`;
    await clearGPSSamples(userId, ctxKey);
    // Belt-and-braces: drop any leftover shot rows for this round.
    await db.delete(shotsTable).where(and(
      eq(shotsTable.playerId, playerId),
      eq(shotsTable.tournamentId, tournamentId),
      eq(shotsTable.round, round),
    ));

    const t0 = Date.now() - 90 * 60 * 1000;
    baseline = await ingestTwoChunksAndCommit(appAs, appAs, round, t0);

    expect(baseline.proposedCount).toBeGreaterThanOrEqual(2);
    expect(baseline.inserted).toBeGreaterThanOrEqual(2);
    expect(baseline.holes).toContain(1);
    expect(baseline.holes).toContain(2);
    // Buffer is one-shot: commit clears it.
    expect((await peekGPSSamples(userId, ctxKey)).length).toBe(0);
  });

  it("survives a simulated restart between /shots/ingest and /shots/detect", async () => {
    expect(baseline).toBeDefined();

    const round = 12;
    const ctxKey = `t:${tournamentId}:r:${round}`;
    await clearGPSSamples(userId, ctxKey);
    await db.delete(shotsTable).where(and(
      eq(shotsTable.playerId, playerId),
      eq(shotsTable.tournamentId, tournamentId),
      eq(shotsTable.round, round),
    ));

    const t0 = Date.now() - 80 * 60 * 1000;

    // Phase 1 — ingest two chunks against the *current* server.
    const ingest1 = await request(appAs())
      .post("/api/portal/shots/ingest")
      .send({ tournamentId, round, gps: chunkForHole(1, t0) });
    expect(ingest1.status).toBe(200);
    expect(ingest1.body.bufferedSamples).toBe(5);

    const ingest2 = await request(appAs())
      .post("/api/portal/shots/ingest")
      .send({ tournamentId, round, gps: chunkForHole(2, t0 + 60_000) });
    expect(ingest2.status).toBe(200);
    expect(ingest2.body.bufferedSamples).toBe(10);

    // The Postgres-backed buffer should still hold both chunks at this point.
    const beforeRestart = await peekGPSSamples(userId, ctxKey);
    expect(beforeRestart.length).toBe(10);

    // Phase 2 — simulate an API restart. Reset the module graph and re-import
    // the test app helper so the routes module + the shot-detection lib are
    // loaded fresh. Any in-process state would be lost here; only the
    // Postgres-backed buffer survives.
    vi.resetModules();
    const { createTestApp: freshCreateTestApp } = await import("./helpers.js");
    const { peekGPSSamples: freshPeek } = await import("../lib/shot-detection.js");
    const freshApp = () => freshCreateTestApp({ id: userId, username: "t853_player", role: "member" });

    // The freshly-loaded module must read the same buffered samples back out
    // of Postgres — that's the whole durability contract.
    const afterRestart = await freshPeek(userId, ctxKey);
    expect(afterRestart.length).toBe(10);
    expect(afterRestart.map(s => s.timestamp).sort((a, b) => a - b))
      .toEqual(beforeRestart.map(s => s.timestamp).sort((a, b) => a - b));

    // Phase 3 — call /shots/detect against the fresh app and commit.
    const commit = await request(freshApp())
      .post("/api/portal/shots/detect")
      .send({
        tournamentId,
        round,
        commit: true,
        gps: [{ lat: GREEN_LAT, lng: greenLng(2), timestamp: t0 + 60_000 + 4_000 }],
      });
    expect(commit.status).toBe(200);
    expect(commit.body.ok).toBe(true);

    const rows = await db
      .select({ holeNumber: shotsTable.holeNumber })
      .from(shotsTable)
      .where(and(
        eq(shotsTable.playerId, playerId),
        eq(shotsTable.tournamentId, tournamentId),
        eq(shotsTable.round, round),
      ));
    const holes = rows.map(r => r.holeNumber).sort((a, b) => a - b);

    // The full sample set posted before the restart must have been preserved
    // and used by the post-restart detect call. We compare against the
    // un-restarted baseline collected in the sibling test.
    const proposedAfter = Array.isArray(commit.body.proposed) ? commit.body.proposed.length : 0;
    expect(proposedAfter).toBe(baseline.proposedCount);
    expect(commit.body.inserted).toBe(baseline.inserted);
    expect(holes).toEqual(baseline.holes);

    // And the buffer is still cleared on commit — restart didn't break that.
    expect((await peekGPSSamples(userId, ctxKey)).length).toBe(0);
  });
});
