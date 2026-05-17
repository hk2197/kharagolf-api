/**
 * Integration tests: persisting watch "putts" voice events on the scorecard.
 *
 * Covers Task #428 — the watch sends `{ type: "putts", holeNumber, count }`
 * after a voice score like "two putts". The handler now upserts the count
 * onto the existing scoresTable row so it surfaces in round summaries and
 * season stats. If no score row exists yet, the message is acked but no row
 * is inserted (strokes are required).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import { handleMessage, type WatchSession } from "../routes/ws-watch.js";

let testOrgId: number;
let testCourseId: number;
let testTournamentId: number;
let testUserId: number;
let testPlayerId: number;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_WatchPutts_${stamp}`,
    slug: `test-watch-putts-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId, name: "Watch Putts Course", slug: `watch-putts-course-${stamp}`, holes: 18, par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId, courseId: testCourseId,
    name: `Watch Putts Tournament ${stamp}`,
    format: "stroke_play", status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = tournament.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `watch-putts-test-${stamp}`,
    username: `watch_putts_test_${stamp}`,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;

  const [player] = await db.insert(playersTable).values({
    tournamentId: testTournamentId, userId: testUserId,
    firstName: "Putt", lastName: "Tester",
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

function makeStubSession(): { session: WatchSession; sent: object[] } {
  const sent: object[] = [];
  const ws = {
    readyState: 1,
    send: (data: string) => { sent.push(JSON.parse(data) as object); },
  } as unknown as WatchSession["ws"];
  const session: WatchSession = {
    ws, userId: testUserId, tournamentId: testTournamentId,
    round: 1, sessionId: "test-session", pushIntervalId: null, batteryMode: false,
    playerLat: null, playerLng: null,
  };
  return { session, sent };
}

async function loadScore(holeNumber: number) {
  const [row] = await db.select().from(scoresTable).where(and(
    eq(scoresTable.playerId, testPlayerId),
    eq(scoresTable.holeNumber, holeNumber),
  ));
  return row;
}

describe("ws-watch handleMessage — putts persistence", () => {
  it("persists putts onto the existing score row for the same (player, round, hole)", async () => {
    await db.delete(scoresTable).where(eq(scoresTable.playerId, testPlayerId));
    // Seed a score row first (as if the player already said "log par on 1").
    await db.insert(scoresTable).values({
      tournamentId: testTournamentId, playerId: testPlayerId,
      round: 1, holeNumber: 1, strokes: 4, isVerified: false,
    });

    const { session, sent } = makeStubSession();
    await handleMessage(session, JSON.stringify({ type: "putts", holeNumber: 1, count: 2 }));

    const ack = sent.find((m) => (m as { type?: string }).type === "putts_saved") as
      | { type: string; holeNumber: number; count: number; persisted: boolean }
      | undefined;
    expect(ack).toBeDefined();
    expect(ack!.holeNumber).toBe(1);
    expect(ack!.count).toBe(2);
    expect(ack!.persisted).toBe(true);

    const row = await loadScore(1);
    expect(row.putts).toBe(2);
    expect(row.strokes).toBe(4); // strokes preserved
  });

  it("acks with persisted=false when no score row exists yet (does not insert)", async () => {
    await db.delete(scoresTable).where(eq(scoresTable.playerId, testPlayerId));

    const { session, sent } = makeStubSession();
    await handleMessage(session, JSON.stringify({ type: "putts", holeNumber: 9, count: 3 }));

    const ack = sent.find((m) => (m as { type?: string }).type === "putts_saved") as
      | { persisted: boolean } | undefined;
    expect(ack).toBeDefined();
    expect(ack!.persisted).toBe(false);

    const row = await loadScore(9);
    expect(row).toBeUndefined();
  });

  it("rejects out-of-range putt counts with an error", async () => {
    const { session, sent } = makeStubSession();
    await handleMessage(session, JSON.stringify({ type: "putts", holeNumber: 1, count: 99 }));
    const err = sent.find((m) => (m as { type?: string }).type === "error") as
      | { message: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/putts/);
  });

  it("overwrites a previously recorded putt count with the latest voice value", async () => {
    await db.delete(scoresTable).where(eq(scoresTable.playerId, testPlayerId));
    await db.insert(scoresTable).values({
      tournamentId: testTournamentId, playerId: testPlayerId,
      round: 1, holeNumber: 2, strokes: 5, putts: 3, isVerified: false,
    });

    const { session } = makeStubSession();
    await handleMessage(session, JSON.stringify({ type: "putts", holeNumber: 2, count: 1 }));

    const row = await loadScore(2);
    expect(row.putts).toBe(1);
  });
});
