/**
 * Task #1729 — permanent regression coverage for the Follow button on
 * tournament leaderboards (web + mobile), pinning the two server contracts
 * the UI relies on:
 *
 *   (b) GET /api/public/tournaments/:id/leaderboard exposes `userId` on
 *       every leaderboard entry whose tournament player is linked to a
 *       portal account. Without this field the client cannot match a row
 *       against the viewer's own user id, the FollowButton never renders,
 *       and the self-row guard at PlayerRow degrades to "show a Follow
 *       button on the viewer's own row" (Task #1420 regression).
 *
 *   (c) GET /api/portal/follows hydrates the viewer's followee list so
 *       <FollowButton initialFollowing={...}> renders as "Following" on
 *       first paint instead of flashing "Follow" → "Following" once the
 *       toggle endpoint round-trips. We also assert the toggle endpoint
 *       (POST /api/portal/follows/:userId) actually persists into the
 *       same hydration source — a regression where the POST silently
 *       no-ops would still give the user a stale "Follow" on reload.
 *
 * The web/mobile rendering layer is covered separately by:
 *   - artifacts/kharagolf-web/src/pages/__tests__/
 *       public-leaderboard-follow-button.test.tsx
 *   - artifacts/kharagolf-mobile/__tests__/feed-follow-button.test.tsx
 *     and the leaderboard-row reuse tracked alongside Task #1420.
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
  userFollowsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let viewerUserId: number;
let otherUserId: number;
let unlinkedRefUserId: number;
let viewerPlayerId: number;
let otherPlayerId: number;
let unlinkedPlayerId: number;
let viewerUser: TestUser;
const tag = uid("t1729");

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `T1729 Org ${tag}`,
    slug: `t1729-org-${tag}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: `T1729 Course ${tag}`,
    slug: `t1729-course-${tag}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  // Hole pars are required so computeLeaderboard can sort entries by
  // score-to-par. Without them the entries collapse to position 0 and the
  // userId-per-entry assertion below would still pass — but the sort
  // assertion (viewer vs other) wouldn't, so we keep the fixture realistic.
  for (let h = 1; h <= 18; h++) {
    await db.insert(holeDetailsTable).values({
      courseId,
      holeNumber: h,
      par: 4,
    });
  }

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T1729 Tournament ${tag}`,
    format: "stroke_play",
    status: "active",
    rounds: 1,
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    maxPlayers: 16,
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  const [vUser] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-viewer`,
    username: `${tag}_viewer`,
    email: `${tag}_viewer@example.test`,
    displayName: "Viewer Vee",
  }).returning({ id: appUsersTable.id });
  viewerUserId = vUser.id;

  const [oUser] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-other`,
    username: `${tag}_other`,
    email: `${tag}_other@example.test`,
    displayName: "Other Olive",
  }).returning({ id: appUsersTable.id });
  otherUserId = oUser.id;

  // A third portal user we never link to a player. Used to prove that
  // /api/portal/follows reflects every persisted follow regardless of
  // whether the followee is in the current leaderboard — the hydration
  // hook is shared with non-leaderboard surfaces (members directory,
  // member-360, etc.).
  const [uUser] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-uref`,
    username: `${tag}_uref`,
    email: `${tag}_uref@example.test`,
    displayName: "Unlinked Uli",
  }).returning({ id: appUsersTable.id });
  unlinkedRefUserId = uUser.id;

  viewerUser = {
    id: viewerUserId,
    username: `${tag}_viewer`,
    role: "player",
  };

  // Three players: viewer (linked), other (linked), unlinked (no userId).
  // Strokes pick a unique total so the leaderboard sort is deterministic:
  //   viewer  = 3 * 18 = 54  → position 1
  //   other   = 4 * 18 = 72  → position 2
  //   unlinked= 5 * 18 = 90  → position 3
  const [vPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: viewerUserId,
    firstName: "Viewer", lastName: "Vee",
    email: `${tag}_viewer@example.test`,
  }).returning({ id: playersTable.id });
  viewerPlayerId = vPlayer.id;

  const [oPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: otherUserId,
    firstName: "Other", lastName: "Olive",
    email: `${tag}_other@example.test`,
  }).returning({ id: playersTable.id });
  otherPlayerId = oPlayer.id;

  const [uPlayer] = await db.insert(playersTable).values({
    tournamentId, /* no userId — unlinked tournament-only entry */
    firstName: "Walk", lastName: "Onlee",
    email: `${tag}_walkon@example.test`,
  }).returning({ id: playersTable.id });
  unlinkedPlayerId = uPlayer.id;

  const playerStrokes: Array<[number, number]> = [
    [viewerPlayerId, 3],
    [otherPlayerId, 4],
    [unlinkedPlayerId, 5],
  ];
  for (const [pid, strokes] of playerStrokes) {
    for (let h = 1; h <= 18; h++) {
      await db.insert(scoresTable).values({
        tournamentId, playerId: pid, round: 1, holeNumber: h, strokes,
      });
    }
  }
});

afterAll(async () => {
  if (tournamentId) {
    await db.delete(scoresTable).where(eq(scoresTable.tournamentId, tournamentId));
    await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
    await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  }
  if (courseId) {
    await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
    await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  }
  const userIds = [viewerUserId, otherUserId, unlinkedRefUserId].filter(Boolean);
  if (userIds.length) {
    await db.delete(userFollowsTable).where(inArray(userFollowsTable.followerId, userIds));
    await db.delete(userFollowsTable).where(inArray(userFollowsTable.followeeId, userIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (orgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  }
});

describe("Task #1729 — leaderboard exposes userId per entry", () => {
  it("returns userId on every linked entry and null on unlinked entries", async () => {
    const app = createTestApp();
    const res = await request(app).get(
      `/api/public/tournaments/${tournamentId}/leaderboard`,
    );
    expect(res.status).toBe(200);

    const entries = res.body.entries as Array<{
      playerId: number;
      userId: number | null;
      playerName: string;
      position: number;
    }>;
    expect(Array.isArray(entries)).toBe(true);

    // Locate our three seeded players by playerId so a peer-test inserting
    // extra rows on the same tournament wouldn't collide with these
    // assertions (none today, but the leaderboard payload is otherwise
    // unfiltered).
    const viewerEntry = entries.find(e => e.playerId === viewerPlayerId);
    const otherEntry = entries.find(e => e.playerId === otherPlayerId);
    const unlinkedEntry = entries.find(e => e.playerId === unlinkedPlayerId);

    expect(viewerEntry, "viewer player must appear on the leaderboard").toBeTruthy();
    expect(otherEntry, "other player must appear on the leaderboard").toBeTruthy();
    expect(unlinkedEntry, "unlinked player must appear on the leaderboard").toBeTruthy();

    // (b) The contract: every linked tournament player surfaces its
    //     portal user id so the FollowButton + self-row guard can act.
    expect(viewerEntry!.userId).toBe(viewerUserId);
    expect(otherEntry!.userId).toBe(otherUserId);

    // Unlinked tournament-only rows must serialize as `userId: null` so
    // the UI's `entry.userId != null` guard hides the FollowButton.
    expect(unlinkedEntry!.userId).toBeNull();
  });

  it("net and stableford entry views also expose userId", async () => {
    // Multiple display modes share the same Entry shape on the wire;
    // the FollowButton is wired off all three on web (Net / Gross /
    // Stableford). A regression that drops userId on any of them would
    // strand the button on that view.
    const app = createTestApp();
    const res = await request(app).get(
      `/api/public/tournaments/${tournamentId}/leaderboard`,
    );
    expect(res.status).toBe(200);

    const lb = res.body as {
      entries: Array<{ playerId: number; userId: number | null }>;
      netEntries: Array<{ playerId: number; userId: number | null }>;
      stablefordEntries: Array<{ playerId: number; userId: number | null }>;
    };

    for (const view of ["entries", "netEntries", "stablefordEntries"] as const) {
      const arr = lb[view];
      const v = arr.find(e => e.playerId === viewerPlayerId);
      const o = arr.find(e => e.playerId === otherPlayerId);
      const u = arr.find(e => e.playerId === unlinkedPlayerId);
      expect(v?.userId, `${view}: viewer userId`).toBe(viewerUserId);
      expect(o?.userId, `${view}: other userId`).toBe(otherUserId);
      expect(u?.userId, `${view}: unlinked userId is null`).toBeNull();
    }
  });
});

describe("Task #1729 — GET /api/portal/follows hydrates initial state", () => {
  it("returns an empty followeeIds list before the viewer follows anyone", async () => {
    // Defensive — make sure the previous test in the file (which doesn't
    // toggle follows) hasn't seeded any rows for our viewer.
    await db.delete(userFollowsTable)
      .where(eq(userFollowsTable.followerId, viewerUserId));

    const app = createTestApp(viewerUser);
    const res = await request(app).get("/api/portal/follows");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ followeeIds: [] });
  });

  it("includes a followee that was just persisted via POST /api/portal/follows/:userId", async () => {
    // Step 1: POST the toggle endpoint the FollowButton uses.
    const app = createTestApp(viewerUser);
    const post = await request(app).post(`/api/portal/follows/${otherUserId}`);
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ ok: true });

    // Step 2: a fresh GET — simulating a page reload — must surface the
    // same followee id that hydrates <FollowButton initialFollowing>.
    const get = await request(app).get("/api/portal/follows");
    expect(get.status).toBe(200);
    expect(get.body.followeeIds).toContain(otherUserId);

    // The DB row exists — proves the POST persisted (a regression
    // where the toggle returns 200 but no-ops would otherwise pass the
    // GET assertion above against any pre-existing row).
    const dbRows = await db.select({ followeeId: userFollowsTable.followeeId })
      .from(userFollowsTable)
      .where(and(
        eq(userFollowsTable.followerId, viewerUserId),
        eq(userFollowsTable.followeeId, otherUserId),
      ));
    expect(dbRows).toHaveLength(1);
  });

  it("rejects an unauthenticated GET so the hook can short-circuit to []", async () => {
    // useFolloweeIds() falls back to `{ followeeIds: [] }` on a non-OK
    // response, which is what keeps the public leaderboard usable for
    // signed-out spectators. Lock in the 401 contract that branch relies on.
    const app = createTestApp();
    const res = await request(app).get("/api/portal/follows");
    expect(res.status).toBe(401);
  });

  it("surfaces every followee, not just leaderboard players, so the hook stays accurate across reloads", async () => {
    // Follow the third (unlinked-to-this-tournament) user to prove the
    // hydration source isn't accidentally scoped to the current
    // leaderboard. Same hook is reused on club-members, member-360, etc.
    const app = createTestApp(viewerUser);
    await request(app).post(`/api/portal/follows/${unlinkedRefUserId}`);

    const get = await request(app).get("/api/portal/follows");
    expect(get.status).toBe(200);
    expect(get.body.followeeIds).toEqual(
      expect.arrayContaining([otherUserId, unlinkedRefUserId]),
    );
  });
});
