/**
 * Task #696 — watch_motion_buffer (Task #527) survives an API restart.
 *
 * Restart is simulated with `vi.resetModules()` + a fresh re-import of the
 * test app so the next /portal/shots/detect call must read motion peaks
 * back out of Postgres rather than any in-memory cache.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  appUsersTable,
  coursesTable,
  db,
  holeDetailsTable,
  organizationsTable,
  playersTable,
  shotsTable,
  tournamentsTable,
  watchMotionBufferTable,
} from "@workspace/db";
import { createTestApp } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let userId: number;
let playerId: number;

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T696_${stamp}`,
    slug: `t696-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T696 Course",
    slug: `t696-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  // One green is enough for loadGreens() to return a non-empty list.
  await db.insert(holeDetailsTable).values({
    courseId,
    holeNumber: 1,
    par: 4,
    greenCentreLat: "0.0",
    greenCentreLng: "0.001",
  });

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T696 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `t696-player-${stamp}`,
    username: `t696_player_${stamp}`,
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  const [p] = await db.insert(playersTable).values({
    tournamentId,
    userId,
    firstName: "Pat",
    lastName: "Player",
    email: `t696-player-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerId = p.id;
});

afterAll(async () => {
  await db.delete(watchMotionBufferTable).where(eq(watchMotionBufferTable.userId, userId));
  await db.delete(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
  await db.delete(playersTable).where(eq(playersTable.id, playerId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  // Each scenario starts from an empty buffer for the test user.
  await db.delete(watchMotionBufferTable).where(eq(watchMotionBufferTable.userId, userId));
});

function appAs() {
  return createTestApp({ id: userId, username: "t696_player", role: "member" });
}

async function bufferRowCount(): Promise<number> {
  const rows = await db
    .select({ id: watchMotionBufferTable.id })
    .from(watchMotionBufferTable)
    .where(eq(watchMotionBufferTable.userId, userId));
  return rows.length;
}

describe("watch motion buffer survives API restart (Task #696)", () => {
  it("drains motion events posted before a simulated restart", async () => {
    const t0 = Date.now() - 60_000;
    // Upload motion peaks via /watch/motion.
    const post = await request(appAs())
      .post("/api/portal/watch/motion")
      .send({
        events: [
          { timestamp: t0,         peakG: 1.1 },
          { timestamp: t0 + 2_000, peakG: 1.4 },
          { timestamp: t0 + 4_000, peakG: 0.9 },
        ],
      });
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ ok: true, accepted: 3 });
    expect(await bufferRowCount()).toBe(3);

    // Simulate a restart: reset module graph and re-import the test app.
    vi.resetModules();
    const { createTestApp: freshCreateTestApp } = await import("./helpers.js");
    const freshApp = freshCreateTestApp({ id: userId, username: "t696_player", role: "member" });

    // The single GPS sample is >30s from every motion peak so the engine
    // can't synthesise a candidate shot (avoids the insert path), but its
    // timestamp still falls inside the ±5min drain window.
    const detect = await request(freshApp)
      .post("/api/portal/shots/detect")
      .send({
        tournamentId,
        round: 1,
        courseId,
        commit: true,
        sensitivity: "medium",
        gps: [
          { lat: 0.0, lng: 0.0005, timestamp: t0 + 60_000 },
        ],
      });
    expect(detect.status).toBe(200);
    expect(detect.body.ok).toBe(true);
    expect(await bufferRowCount()).toBe(0);
  });

  it("prunes events older than the 6h TTL and never returns them", async () => {
    const now = Date.now();
    const fresh = now - 60_000;            // 1 min old — must survive
    const stale = now - 7 * 60 * 60 * 1000; // 7 h old  — must be pruned

    // bufferMotionEvents filters stale events before insert, so seed via SQL.
    await db.insert(watchMotionBufferTable).values([
      { userId, eventTimestampMs: String(stale), peakG: "1.20" },
      { userId, eventTimestampMs: String(fresh), peakG: "1.10" },
    ]);
    expect(await bufferRowCount()).toBe(2);

    // /watch/motion runs _pruneExpired() before insert; an empty batch is enough.
    const post = await request(appAs())
      .post("/api/portal/watch/motion")
      .send({ events: [] });
    expect(post.status).toBe(200);

    const rows = await db
      .select({
        eventTimestampMs: watchMotionBufferTable.eventTimestampMs,
      })
      .from(watchMotionBufferTable)
      .where(eq(watchMotionBufferTable.userId, userId));
    expect(rows.length).toBe(1);
    expect(Number(rows[0].eventTimestampMs)).toBe(fresh);

    // After a simulated restart the stale row must still be invisible.
    vi.resetModules();
    const { createTestApp: freshCreateTestApp } = await import("./helpers.js");
    const freshApp = freshCreateTestApp({ id: userId, username: "t696_player", role: "member" });

    const detect = await request(freshApp)
      .post("/api/portal/shots/detect")
      .send({
        tournamentId,
        round: 1,
        courseId,
        commit: true,
        gps: [
          { lat: 0.0, lng: 0.0005, timestamp: fresh + 60_000 },
        ],
      });
    expect(detect.status).toBe(200);
    expect(await bufferRowCount()).toBe(0);
  });

  it("commit:false peeks (rows preserved); commit:true drains (rows removed)", async () => {
    const t0 = Date.now() - 60_000;
    const seed = await request(appAs())
      .post("/api/portal/watch/motion")
      .send({
        events: [
          { timestamp: t0,         peakG: 1.1 },
          { timestamp: t0 + 2_000, peakG: 1.4 },
        ],
      });
    expect(seed.status).toBe(200);
    expect(await bufferRowCount()).toBe(2);

    // commit:false → peekMotionEvents → rows must remain on disk.
    const peek = await request(appAs())
      .post("/api/portal/shots/detect")
      .send({
        tournamentId,
        round: 1,
        courseId,
        commit: false,
        gps: [
          { lat: 0.0, lng: 0.0005, timestamp: t0 + 60_000 },
        ],
      });
    expect(peek.status).toBe(200);
    expect(peek.body.ok).toBe(true);
    expect(await bufferRowCount()).toBe(2);

    // commit:true → drainMotionEvents → rows deleted.
    const commit = await request(appAs())
      .post("/api/portal/shots/detect")
      .send({
        tournamentId,
        round: 1,
        courseId,
        commit: true,
        gps: [
          { lat: 0.0, lng: 0.0005, timestamp: t0 + 60_000 },
        ],
      });
    expect(commit.status).toBe(200);
    expect(commit.body.ok).toBe(true);
    expect(await bufferRowCount()).toBe(0);
  });
});
