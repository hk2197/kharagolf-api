/**
 * Integration tests: offline score reconciliation & 12-hour backdate guard
 *
 * Covers Task #421:
 *   1. Backdated scores are accepted within the 12-h window and stored using
 *      the client-supplied `submittedAt` (not "now").
 *   2. Backdates beyond 12 h are clamped to (now - 12h) — both via the
 *      REST endpoint and the WebSocket score handler.
 *   3. `submittedOffline=true` always writes `isVerified=false`, even when
 *      a previously verified score exists for the same hole, so the marker
 *      validation flow re-runs.
 *   4. Marker re-validation flow on reconnect: a verified row gets reset
 *      back to unverified when the offline late-arriving entry replays.
 *
 * Both the HTTP route in routes/portal.ts and the WebSocket handler in
 * routes/ws-watch.ts share the same 12-h cap, so both paths are tested
 * in parallel here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  scoresTable,
  appUsersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
import { issueWatchToken } from "../lib/watch-token.js";
import {
  handleMessage,
  clampClientTimestamp,
  MAX_OFFLINE_BACKDATE_MS,
  type WatchSession,
} from "../routes/ws-watch.js";

// ── Fixtures ────────────────────────────────────────────────────────────────
let testOrgId: number;
let testCourseId: number;
let testTournamentId: number;
let testUserId: number;
let testPlayerId: number;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_WatchOffline_${stamp}`,
    slug: `test-watch-offline-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Watch Offline Course",
    slug: `watch-offline-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Watch Offline Tournament ${stamp}`,
    format: "stroke_play",
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = tournament.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `watch-offline-test-${stamp}`,
    username: `watch_offline_test_${stamp}`,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;

  const [player] = await db.insert(playersTable).values({
    tournamentId: testTournamentId,
    userId: testUserId,
    firstName: "Offline",
    lastName: "Watcher",
  }).returning({ id: playersTable.id });
  testPlayerId = player.id;
});

afterAll(async () => {
  await db.delete(scoresTable).where(eq(scoresTable.tournamentId, testTournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, testTournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, testTournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

async function clearScores(holeNumber?: number) {
  if (holeNumber == null) {
    await db.delete(scoresTable).where(eq(scoresTable.playerId, testPlayerId));
  } else {
    await db.delete(scoresTable).where(and(
      eq(scoresTable.playerId, testPlayerId),
      eq(scoresTable.holeNumber, holeNumber),
    ));
  }
}

async function loadScore(holeNumber: number) {
  const [row] = await db.select().from(scoresTable).where(and(
    eq(scoresTable.playerId, testPlayerId),
    eq(scoresTable.holeNumber, holeNumber),
  ));
  return row;
}

// A stub WebSocket good enough for handleMessage. We only need `readyState`
// (so `send()` actually pushes) and a `send()` capture so we can assert ack.
function makeStubSession(): { session: WatchSession; sent: object[] } {
  const sent: object[] = [];
  const ws = {
    readyState: 1, // WebSocket.OPEN
    send: (data: string) => { sent.push(JSON.parse(data) as object); },
  } as unknown as WatchSession["ws"];
  const session: WatchSession = {
    ws,
    userId: testUserId,
    tournamentId: testTournamentId,
    round: 1,
    sessionId: "test-session",
    pushIntervalId: null,
    batteryMode: false,
    playerLat: null,
    playerLng: null,
  };
  return { session, sent };
}

// ──────────────────────────────────────────────────────────────────────────
// 1. clampClientTimestamp — pure-function unit tests
// ──────────────────────────────────────────────────────────────────────────
describe("clampClientTimestamp (ws-watch helper)", () => {
  it("returns the client time unchanged when within the 12-h backdate window", () => {
    const now = Date.now();
    const sixHoursAgo = now - 6 * 60 * 60 * 1000;
    const out = clampClientTimestamp(sixHoursAgo);
    // Within 1 s of the client value (no clamp applied)
    expect(Math.abs(out.getTime() - sixHoursAgo)).toBeLessThan(1000);
  });

  it("clamps a backdate older than 12 h to (now - 12h)", () => {
    const now = Date.now();
    const wayTooOld = now - 48 * 60 * 60 * 1000; // 2 days ago
    const out = clampClientTimestamp(wayTooOld);
    const floor = now - MAX_OFFLINE_BACKDATE_MS;
    // Allow ~2s slack for clock drift between Date.now() calls
    expect(out.getTime()).toBeGreaterThanOrEqual(floor - 2000);
    expect(out.getTime()).toBeLessThanOrEqual(floor + 2000);
  });

  it("clamps a future client timestamp down to 'now'", () => {
    const now = Date.now();
    const future = now + 60 * 60 * 1000;
    const out = clampClientTimestamp(future);
    expect(out.getTime()).toBeLessThanOrEqual(now + 1000);
  });

  it("falls back to 'now' when the value is missing or invalid", () => {
    const before = Date.now();
    const a = clampClientTimestamp(undefined);
    const b = clampClientTimestamp("not-a-number");
    const c = clampClientTimestamp(Number.NaN);
    const after = Date.now();
    for (const v of [a, b, c]) {
      expect(v.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(v.getTime()).toBeLessThanOrEqual(after + 1000);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2. POST /api/portal/watch/submit-score (REST path)
// ──────────────────────────────────────────────────────────────────────────
describe("POST /api/portal/watch/submit-score — offline backdate", () => {
  it("accepts a backdated score within 12 h and persists the client submittedAt", async () => {
    await clearScores(1);
    const app = createTestApp({ id: testUserId, username: "offline_test", role: "member" });

    const clientSubmittedAt = Date.now() - 4 * 60 * 60 * 1000; // 4 h ago
    const res = await request(app)
      .post("/api/portal/watch/submit-score")
      .send({
        tournamentId: testTournamentId,
        playerId: testPlayerId,
        round: 1,
        holeNumber: 1,
        strokes: 4,
        submittedOffline: true,
        clientSubmittedAt,
      });
    expect(res.status).toBe(200);

    const row = await loadScore(1);
    expect(row).toBeTruthy();
    expect(row.strokes).toBe(4);
    expect(row.isVerified).toBe(false);
    // Within 1 s of the client value (no clamp)
    expect(Math.abs(row.submittedAt.getTime() - clientSubmittedAt)).toBeLessThan(1000);
  });

  it("clamps a backdated score older than 12 h to (now - 12h)", async () => {
    await clearScores(2);
    const app = createTestApp({ id: testUserId, username: "offline_test", role: "member" });

    const wayBack = Date.now() - 24 * 60 * 60 * 1000; // 24 h ago
    const before = Date.now();
    const res = await request(app)
      .post("/api/portal/watch/submit-score")
      .send({
        tournamentId: testTournamentId,
        playerId: testPlayerId,
        round: 1,
        holeNumber: 2,
        strokes: 5,
        submittedOffline: true,
        clientSubmittedAt: wayBack,
      });
    const after = Date.now();
    expect(res.status).toBe(200);

    const row = await loadScore(2);
    expect(row).toBeTruthy();
    const ts = row.submittedAt.getTime();
    // Should be clamped to roughly (now - 12h), not 24 h ago
    expect(ts).toBeGreaterThanOrEqual(before - MAX_OFFLINE_BACKDATE_MS - 2000);
    expect(ts).toBeLessThanOrEqual(after - MAX_OFFLINE_BACKDATE_MS + 2000);
    // Crucially, much newer than the original 24-h-old client value
    expect(ts).toBeGreaterThan(wayBack + 60 * 60 * 1000);
    expect(row.isVerified).toBe(false);
  });

  it("ignores submittedOffline=false / missing flag and stamps 'now'", async () => {
    await clearScores(3);
    const app = createTestApp({ id: testUserId, username: "offline_test", role: "member" });

    const wayBack = Date.now() - 6 * 60 * 60 * 1000;
    const before = Date.now();
    const res = await request(app)
      .post("/api/portal/watch/submit-score")
      .send({
        tournamentId: testTournamentId,
        playerId: testPlayerId,
        round: 1,
        holeNumber: 3,
        strokes: 3,
        // submittedOffline NOT set; clientSubmittedAt should be ignored
        clientSubmittedAt: wayBack,
      });
    const after = Date.now();
    expect(res.status).toBe(200);

    const row = await loadScore(3);
    expect(row.submittedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.submittedAt.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it("marker re-validation: a previously verified score is reset to unverified when the offline entry replays", async () => {
    await clearScores(4);
    // Seed a verified score (as if marker had already validated it earlier).
    await db.insert(scoresTable).values({
      tournamentId: testTournamentId,
      playerId: testPlayerId,
      round: 1,
      holeNumber: 4,
      strokes: 4,
      isVerified: true,
      submittedAt: new Date(Date.now() - 30 * 60 * 1000),
      updatedAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    const seeded = await loadScore(4);
    expect(seeded.isVerified).toBe(true);

    const app = createTestApp({ id: testUserId, username: "offline_test", role: "member" });
    const clientSubmittedAt = Date.now() - 2 * 60 * 60 * 1000;
    const res = await request(app)
      .post("/api/portal/watch/submit-score")
      .send({
        tournamentId: testTournamentId,
        playerId: testPlayerId,
        round: 1,
        holeNumber: 4,
        strokes: 5, // corrected stroke count from the watch
        submittedOffline: true,
        clientSubmittedAt,
      });
    expect(res.status).toBe(200);

    const row = await loadScore(4);
    expect(row.strokes).toBe(5);
    // The conflict-update path MUST flip isVerified back to false so marker
    // validation re-runs on reconnect.
    expect(row.isVerified).toBe(false);
    expect(Math.abs(row.submittedAt.getTime() - clientSubmittedAt)).toBeLessThan(1000);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3. WebSocket handler — score message offline path
// ──────────────────────────────────────────────────────────────────────────
describe("ws-watch handleMessage — offline score", () => {
  it("accepts a backdated score within 12 h, persists the client time, and acks with submittedOffline=true", async () => {
    await clearScores(5);
    const { session, sent } = makeStubSession();

    const clientSubmittedAt = Date.now() - 3 * 60 * 60 * 1000;
    await handleMessage(session, JSON.stringify({
      type: "score",
      holeNumber: 5,
      strokes: 4,
      submittedOffline: true,
      clientSubmittedAt,
    }));

    const ack = sent.find((m) => (m as { type?: string }).type === "score_saved") as
      | { type: string; holeNumber: number; submittedOffline: boolean }
      | undefined;
    expect(ack).toBeDefined();
    expect(ack!.holeNumber).toBe(5);
    expect(ack!.submittedOffline).toBe(true);

    const row = await loadScore(5);
    expect(row.strokes).toBe(4);
    expect(row.isVerified).toBe(false);
    expect(Math.abs(row.submittedAt.getTime() - clientSubmittedAt)).toBeLessThan(1000);
  });

  it("clamps a backdated WS score older than 12 h to (now - 12h)", async () => {
    await clearScores(6);
    const { session } = makeStubSession();

    const wayBack = Date.now() - 36 * 60 * 60 * 1000; // 1.5 days ago
    const before = Date.now();
    await handleMessage(session, JSON.stringify({
      type: "score",
      holeNumber: 6,
      strokes: 6,
      submittedOffline: true,
      clientSubmittedAt: wayBack,
    }));
    const after = Date.now();

    const row = await loadScore(6);
    const ts = row.submittedAt.getTime();
    expect(ts).toBeGreaterThanOrEqual(before - MAX_OFFLINE_BACKDATE_MS - 2000);
    expect(ts).toBeLessThanOrEqual(after - MAX_OFFLINE_BACKDATE_MS + 2000);
    expect(row.isVerified).toBe(false);
  });

  it("marker re-validation: WS offline replay resets a previously verified score to unverified", async () => {
    await clearScores(7);
    await db.insert(scoresTable).values({
      tournamentId: testTournamentId,
      playerId: testPlayerId,
      round: 1,
      holeNumber: 7,
      strokes: 3,
      isVerified: true,
      submittedAt: new Date(Date.now() - 90 * 60 * 1000),
      updatedAt: new Date(Date.now() - 90 * 60 * 1000),
    });
    expect((await loadScore(7)).isVerified).toBe(true);

    const { session } = makeStubSession();
    const clientSubmittedAt = Date.now() - 60 * 60 * 1000;
    await handleMessage(session, JSON.stringify({
      type: "score",
      holeNumber: 7,
      strokes: 4,
      submittedOffline: true,
      clientSubmittedAt,
    }));

    const row = await loadScore(7);
    expect(row.strokes).toBe(4);
    expect(row.isVerified).toBe(false);
    expect(Math.abs(row.submittedAt.getTime() - clientSubmittedAt)).toBeLessThan(1000);
  });

  it("when submittedOffline is omitted the WS handler stamps 'now' (clientSubmittedAt is ignored)", async () => {
    await clearScores(8);
    const { session } = makeStubSession();
    const wayBack = Date.now() - 5 * 60 * 60 * 1000;
    const before = Date.now();
    await handleMessage(session, JSON.stringify({
      type: "score",
      holeNumber: 8,
      strokes: 4,
      clientSubmittedAt: wayBack,
    }));
    const after = Date.now();
    const row = await loadScore(8);
    expect(row.submittedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.submittedAt.getTime()).toBeLessThanOrEqual(after + 1000);
  });
});

// Silence unused-import warnings if vi/issueWatchToken aren't used elsewhere
void vi;
void issueWatchToken;
