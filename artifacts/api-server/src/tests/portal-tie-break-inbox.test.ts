/**
 * Task #1212 — read-side coverage for the portal tie-break inbox endpoints
 * added in Task #1050:
 *
 *   - GET  /api/portal/my-tie-break-messages
 *   - POST /api/portal/my-tie-break-messages/:id/read
 *
 * These endpoints surface the in-app inbox rows that
 * `notifyRoundRobinTieBreak` writes (covered by
 * `round-robin-tie-break-notify.test.ts`). The write path is exercised there;
 * here we focus on the read/mark-read contract:
 *
 *   - The list endpoint joins through bracket → match_play_bracket so each
 *     row carries the parent `tournamentId` (used for mobile deep-links).
 *   - `unreadCount` is derived from the rows the caller actually sees and
 *     drops to zero after a mark-read.
 *   - A second user who has no `club_members` row in the same org cannot see
 *     or mark-read the same inbox row (tenant isolation).
 *
 * A schema change to bracket joins or `member_messages` would otherwise
 * silently break the mobile inbox without anyone noticing until production.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";

import {
  db,
  appUsersTable,
  organizationsTable,
  tournamentsTable,
  coursesTable,
  playersTable,
  matchPlayBracketTable,
  bracketRoundsTable,
  bracketMatchesTable,
  clubMembersTable,
  memberMessagesTable,
} from "@workspace/db";

import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgId: number;
let tournamentId: number;
let bracketId: number;
let tieBreakMatchId: number;
let inboxRowId: number;

let linkedUser: TestUser;
let outsiderUser: TestUser;

const userIds: number[] = [];

beforeAll(async () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-tie-break-inbox";
  }

  const tag = uid("t1212");

  const [org] = await db.insert(organizationsTable).values({
    name: `T1212-${tag}`,
    slug: `t1212-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  async function makeUser(label: string): Promise<TestUser> {
    const t = uid(`t1212_${label}`);
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: t,
      username: t,
      email: `${t}@test.local`,
      displayName: `T1212 ${label}`,
      role: "player",
    }).returning({ id: appUsersTable.id });
    userIds.push(u.id);
    return { id: u.id, username: t, displayName: `T1212 ${label}`, role: "player" };
  }

  linkedUser = await makeUser("linked");
  outsiderUser = await makeUser("outsider");

  // Only the linked user has a club_members row in this org — the outsider
  // explicitly does NOT, so their list should come back empty and their
  // mark-read should be a no-op.
  const [linkedMember] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: linkedUser.id,
    firstName: "Tied",
    lastName: "Linked",
  }).returning({ id: clubMembersTable.id });

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T1212 Course",
    slug: `t1212-course-${tag}`.toLowerCase(),
  }).returning({ id: coursesTable.id });

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId: course.id,
    name: "T1212 RR Cup",
    rounds: 1,
    status: "active",
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [p1] = await db.insert(playersTable).values({
    tournamentId, userId: linkedUser.id, firstName: "Tied", lastName: "One",
  }).returning({ id: playersTable.id });
  const [p2] = await db.insert(playersTable).values({
    tournamentId, firstName: "Tied", lastName: "Two",
  }).returning({ id: playersTable.id });

  const [bracket] = await db.insert(matchPlayBracketTable).values({
    tournamentId, format: "round_robin", tieBreakRule: "sudden_death",
  }).returning({ id: matchPlayBracketTable.id });
  bracketId = bracket.id;

  const [round] = await db.insert(bracketRoundsTable).values({
    bracketId, roundNumber: 99, name: "Tie-Break", bracketType: "main",
  }).returning({ id: bracketRoundsTable.id });

  const [match] = await db.insert(bracketMatchesTable).values({
    bracketId, roundId: round.id, matchNumber: 1, bracketType: "main",
    player1Id: p1.id, player2Id: p2.id, result: "pending", holeResults: {},
  }).returning({ id: bracketMatchesTable.id });
  tieBreakMatchId = match.id;

  // Seed exactly the row shape `notifyRoundRobinTieBreak` writes.
  const [msg] = await db.insert(memberMessagesTable).values({
    organizationId: orgId,
    clubMemberId: linkedMember.id,
    channel: "in_app",
    subject: "Tie-break required",
    body: "A tie-break match is required in T1212 RR Cup.",
    status: "sent",
    relatedEntity: "round_robin_tie_break",
    relatedEntityId: tieBreakMatchId,
  }).returning({ id: memberMessagesTable.id });
  inboxRowId = msg.id;
});

afterAll(async () => {
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(bracketMatchesTable).where(eq(bracketMatchesTable.bracketId, bracketId));
  await db.delete(bracketRoundsTable).where(eq(bracketRoundsTable.bracketId, bracketId));
  await db.delete(matchPlayBracketTable).where(eq(matchPlayBracketTable.id, bracketId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, orgId));
  if (userIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("portal tie-break inbox endpoints", () => {
  it("requires authentication on both endpoints", async () => {
    await request(createTestApp())
      .get("/api/portal/my-tie-break-messages")
      .expect(401);
    await request(createTestApp())
      .post(`/api/portal/my-tie-break-messages/${inboxRowId}/read`)
      .expect(401);
  });

  it("lists the seeded row with the correct tournamentId/matchId and unreadCount, then drops to 0 after mark-read", async () => {
    // ── Initial list — row should be present and unread.
    const listRes = await request(createTestApp(linkedUser))
      .get("/api/portal/my-tie-break-messages")
      .expect(200);

    expect(listRes.body.unreadCount).toBe(1);
    expect(Array.isArray(listRes.body.items)).toBe(true);
    expect(listRes.body.items).toHaveLength(1);

    const [item] = listRes.body.items;
    expect(item).toMatchObject({
      id: inboxRowId,
      organizationId: orgId,
      matchId: tieBreakMatchId,
      tournamentId, // resolved through bracket join
      readAt: null,
    });
    expect(typeof item.sentAt).toBe("string");
    expect(item.body).toContain("T1212 RR Cup");

    // ── Mark-read.
    const readRes = await request(createTestApp(linkedUser))
      .post(`/api/portal/my-tie-break-messages/${inboxRowId}/read`)
      .expect(200);
    expect(readRes.body).toEqual({ success: true, updated: 1 });

    // readAt must now be populated in the DB.
    const [row] = await db.select({ readAt: memberMessagesTable.readAt })
      .from(memberMessagesTable)
      .where(eq(memberMessagesTable.id, inboxRowId));
    expect(row.readAt).toBeInstanceOf(Date);

    // ── Re-list — same row, but now read; unreadCount drops to 0.
    const listRes2 = await request(createTestApp(linkedUser))
      .get("/api/portal/my-tie-break-messages")
      .expect(200);
    expect(listRes2.body.unreadCount).toBe(0);
    expect(listRes2.body.items).toHaveLength(1);
    expect(listRes2.body.items[0].id).toBe(inboxRowId);
    expect(typeof listRes2.body.items[0].readAt).toBe("string");

    // A second mark-read is a no-op (already read).
    const readAgain = await request(createTestApp(linkedUser))
      .post(`/api/portal/my-tie-break-messages/${inboxRowId}/read`)
      .expect(200);
    expect(readAgain.body).toEqual({ success: true, updated: 0 });
  });

  it("does not leak the row to a user without a club_members row in the org, and a mark-read from that user is a no-op", async () => {
    // Reset readAt so we can prove the outsider's POST does not flip it.
    await db.update(memberMessagesTable)
      .set({ readAt: null })
      .where(eq(memberMessagesTable.id, inboxRowId));

    const listRes = await request(createTestApp(outsiderUser))
      .get("/api/portal/my-tie-break-messages")
      .expect(200);
    expect(listRes.body).toEqual({ unreadCount: 0, items: [] });

    const readRes = await request(createTestApp(outsiderUser))
      .post(`/api/portal/my-tie-break-messages/${inboxRowId}/read`)
      .expect(200);
    expect(readRes.body).toEqual({ success: true, updated: 0 });

    // The row must remain unread — the outsider's POST is scoped to their
    // own (empty) club_members set and cannot touch the linked user's row.
    const [row] = await db.select({ readAt: memberMessagesTable.readAt })
      .from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.id, inboxRowId),
        eq(memberMessagesTable.organizationId, orgId),
      ));
    expect(row.readAt).toBeNull();
  });
});
