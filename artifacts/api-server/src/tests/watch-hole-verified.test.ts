/**
 * Task #484 — server pushes a `hole_verified` event over /ws/watch when the
 * marker countersigns the round, so the watch can clear its "Awaiting marker"
 * indicator and play a success haptic without waiting for the next periodic
 * push.
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
import { eq } from "drizzle-orm";
import {
  handleMessage,
  notifyWatchHoleVerified,
  type WatchSession,
} from "../routes/ws-watch.js";
import { issueWatchToken } from "../lib/watch-token.js";

let testOrgId: number;
let testCourseId: number;
let testTournamentId: number;
let testUserId: number;
let testPlayerId: number;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_WatchHoleVerified_${stamp}`,
    slug: `test-watch-hole-verified-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId, name: "Verify Course", slug: `verify-course-${stamp}`, holes: 18, par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId, courseId: testCourseId,
    name: `Verify Tournament ${stamp}`,
    format: "stroke_play", status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = tournament.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `watch-verified-test-${stamp}`,
    username: `watch_verified_test_${stamp}`,
  }).returning({ id: appUsersTable.id });
  testUserId = user.id;

  const [player] = await db.insert(playersTable).values({
    tournamentId: testTournamentId, userId: testUserId,
    firstName: "Verify", lastName: "Tester",
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
    ws, userId: null, tournamentId: null,
    round: 1, sessionId: "test-session", pushIntervalId: null, batteryMode: false,
    playerLat: null, playerLng: null,
  };
  return { session, sent };
}

describe("ws-watch — hole_verified push (Task #484)", () => {
  it("delivers hole_verified to the player's authenticated session", async () => {
    const { session, sent } = makeStubSession();
    const token = issueWatchToken(testUserId);
    await handleMessage(session, JSON.stringify({ type: "auth", token }));
    expect(sent.find((m) => (m as { type?: string }).type === "auth_ok")).toBeDefined();

    sent.length = 0;
    notifyWatchHoleVerified(testUserId, { round: 1, holes: [3, 7], submissionId: 999 });

    const evt = sent.find((m) => (m as { type?: string }).type === "hole_verified") as
      | { round: number; holes: number[]; submissionId: number | null } | undefined;
    expect(evt).toBeDefined();
    expect(evt!.round).toBe(1);
    expect(evt!.holes).toEqual([3, 7]);
    expect(evt!.submissionId).toBe(999);
  });

  it("drops the prior user's registry mapping when the same socket re-auths as a different user", async () => {
    // Seed a second user so we can re-auth the same socket as them.
    const stamp = Date.now();
    const [otherUser] = await db.insert(appUsersTable).values({
      replitUserId: `watch-verified-test-other-${stamp}`,
      username: `watch_verified_test_other_${stamp}`,
    }).returning({ id: appUsersTable.id });

    try {
      const { session, sent } = makeStubSession();
      const tokenA = issueWatchToken(testUserId);
      const tokenB = issueWatchToken(otherUser.id);

      await handleMessage(session, JSON.stringify({ type: "auth", token: tokenA }));
      await handleMessage(session, JSON.stringify({ type: "auth", token: tokenB }));
      sent.length = 0;

      // Notifying user A must NOT reach this socket anymore.
      notifyWatchHoleVerified(testUserId, { round: 1, holes: [], submissionId: 1 });
      expect(sent.find((m) => (m as { type?: string }).type === "hole_verified")).toBeUndefined();

      // Notifying user B (current owner) must reach it.
      notifyWatchHoleVerified(otherUser.id, { round: 1, holes: [], submissionId: 2 });
      const evt = sent.find((m) => (m as { type?: string }).type === "hole_verified") as
        | { submissionId: number | null } | undefined;
      expect(evt).toBeDefined();
      expect(evt!.submissionId).toBe(2);
    } finally {
      await db.delete(appUsersTable).where(eq(appUsersTable.id, otherUser.id));
    }
  });

  it("ignores notifications for users who have no live watch session", () => {
    const { sent } = makeStubSession();
    // Use a userId that was never registered.
    notifyWatchHoleVerified(99_999_999, { round: 1, holes: [], submissionId: 1 });
    expect(sent.find((m) => (m as { type?: string }).type === "hole_verified")).toBeUndefined();
  });
});
