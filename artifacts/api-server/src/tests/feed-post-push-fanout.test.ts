/**
 * Task #1697 — fans out a `feed_post` push to other org members when a
 * member publishes a new post via `POST /organizations/:orgId/feed/posts`.
 *
 * The mobile More-menu badge provider (`moreBadges.tsx`) listens for
 * `data.type = "feed_post"` pushes via the `BADGE_PUSH_TYPES` whitelist
 * and refetches `/api/portal/badge-counts` immediately on receipt, so the
 * red dot on the Feed row appears within ~1s instead of waiting up to
 * 5 minutes for the next safety-net poll.
 *
 * This test asserts the *server-side* contract:
 *   1. Other org members receive a push tagged `type: "feed_post"`.
 *   2. The author themselves is excluded.
 *   3. Members with `userNotificationPrefs.preferPush = false` are
 *      skipped.
 *   4. `followers_only` posts only push the author's followers.
 *   5. Tombstoned (`erased_at`) members are excluded.
 *   6. Recipients who muted this author (`user_feed_author_mutes`) are
 *      excluded — even if they are followers (mute beats follow).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

const { sendPushToUsersMock } = vi.hoisted(() => ({
  sendPushToUsersMock: vi.fn(
    async (
      _userIds: number[],
      _title: string,
      _body: string,
      _data?: Record<string, unknown>,
    ) => ({
      attempted: 1, sent: 1, failed: 0, invalid: 0,
    }),
  ),
}));

vi.mock("../lib/push.js", () => ({
  sendPushToUsers: sendPushToUsersMock,
}));

import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  feedPostsTable,
  userNotificationPrefsTable,
  userFollowsTable,
  userFeedAuthorMutesTable,
  clubMembersTable,
  memberMessagesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgId: number;
let author: TestUser;
let otherMember: TestUser;
let optedOut: TestUser;
let erased: TestUser;
let outsider: TestUser; // not a member of orgId
const createdUserIds: number[] = [];
const createdPostIds: number[] = [];
// Task #2111 — track the clubMembers rows we add for inbox-fanout
// assertions so afterAll can clean them up; the inbox insert path
// only fires for users who have a clubMembers row in the org.
const createdClubMemberIds: number[] = [];

beforeAll(async () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-feed-post-push-fanout";
  }

  const tag = uid("feedfan");
  const [org] = await db.insert(organizationsTable).values({
    name: `FeedFan_${tag}`,
    slug: `feedfan-${tag}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  async function makeUser(label: string): Promise<TestUser> {
    const t = uid(label);
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: t,
      username: t,
      email: `${t}@test.local`,
      displayName: `Feed Fan ${label}`,
      role: "player",
    }).returning({ id: appUsersTable.id });
    createdUserIds.push(u.id);
    return { id: u.id, username: t, displayName: `Feed Fan ${label}`, role: "player" };
  }

  author = await makeUser("author");
  otherMember = await makeUser("other");
  optedOut = await makeUser("optout");
  erased = await makeUser("erased");
  outsider = await makeUser("outsider");

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: author.id, role: "player" },
    { organizationId: orgId, userId: otherMember.id, role: "player" },
    { organizationId: orgId, userId: optedOut.id, role: "player" },
    { organizationId: orgId, userId: erased.id, role: "player" },
    // outsider intentionally NOT added to the org
  ]);

  // Task #2111 — give the eligible recipients a clubMembers row in the
  // org so the inbox fan-out (which is keyed by clubMembers, mirroring
  // the tie-break inbox pattern) actually writes a row for them. The
  // author also gets a clubMembers row to prove the author is excluded
  // from the inbox just like they are excluded from the push.
  const clubRows = await db.insert(clubMembersTable).values([
    { organizationId: orgId, userId: author.id, firstName: "Author", lastName: "Test" },
    { organizationId: orgId, userId: otherMember.id, firstName: "Other", lastName: "Member" },
    { organizationId: orgId, userId: optedOut.id, firstName: "OptedOut", lastName: "Member" },
    { organizationId: orgId, userId: erased.id, firstName: "Erased", lastName: "Member" },
  ]).returning({ id: clubMembersTable.id });
  for (const r of clubRows) createdClubMemberIds.push(r.id);

  // Opt one member out of push.
  await db.insert(userNotificationPrefsTable).values({
    userId: optedOut.id,
    preferPush: false,
  }).onConflictDoUpdate({
    target: userNotificationPrefsTable.userId,
    set: { preferPush: false },
  });

  // Tombstone the erased user.
  await db.update(appUsersTable)
    .set({ erasedAt: new Date() })
    .where(eq(appUsersTable.id, erased.id));
});

afterAll(async () => {
  if (createdPostIds.length) {
    await db.delete(feedPostsTable).where(inArray(feedPostsTable.id, createdPostIds));
  }
  if (createdClubMemberIds.length) {
    // memberMessages reference clubMembers via cascade; deleting the
    // clubMembers rows here also drops any inbox rows the fan-out wrote.
    await db.delete(memberMessagesTable)
      .where(inArray(memberMessagesTable.clubMemberId, createdClubMemberIds));
    await db.delete(clubMembersTable)
      .where(inArray(clubMembersTable.id, createdClubMemberIds));
  }
  if (createdUserIds.length) {
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, createdUserIds));
    await db.delete(userFollowsTable).where(inArray(userFollowsTable.followerId, createdUserIds));
    await db.delete(userFollowsTable).where(inArray(userFollowsTable.followeeId, createdUserIds));
    await db.delete(userFeedAuthorMutesTable).where(inArray(userFeedAuthorMutesTable.muterId, createdUserIds));
    await db.delete(userFeedAuthorMutesTable).where(inArray(userFeedAuthorMutesTable.mutedUserId, createdUserIds));
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (orgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  }
});

beforeEach(() => {
  sendPushToUsersMock.mockClear();
});

// Wait for the post-response `void`-awaited fan-out to settle. The handler
// fires the push *after* res.json(), so we have to give the microtask /
// next-tick callbacks a chance to run before asserting.
async function waitForFanout() {
  for (let i = 0; i < 20; i++) {
    if (sendPushToUsersMock.mock.calls.length > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Task #1697 — new feed post fans out a `feed_post` push", () => {
  it("pushes other org members but not the author / opted-out / erased / non-members", async () => {
    const res = await request(createTestApp(author))
      .post(`/api/organizations/${orgId}/feed/posts`)
      .send({ body: "Sunset round was unreal — anyone up tomorrow?" })
      .expect(200);
    createdPostIds.push(res.body.id);

    await waitForFanout();

    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const [userIds, title, body, data] = sendPushToUsersMock.mock.calls[0]!;

    // Only the eligible member (`otherMember`) is included. The author
    // never pushes themselves; opted-out, tombstoned and non-members
    // are excluded.
    expect(new Set(userIds as number[])).toEqual(new Set([otherMember.id]));
    expect(userIds).not.toContain(author.id);
    expect(userIds).not.toContain(optedOut.id);
    expect(userIds).not.toContain(erased.id);
    expect(userIds).not.toContain(outsider.id);

    expect(typeof title).toBe("string");
    expect(title).toContain("Feed Fan author");
    expect(typeof body).toBe("string");
    expect(body).toContain("Sunset round");

    expect(data).toMatchObject({
      type: "feed_post",
      orgId,
      postId: res.body.id,
    });

    // Task #2111 — the same fan-out must also write a `member_messages`
    // inbox row for every push recipient that has a clubMembers row in
    // the org. The author is excluded (no push, no inbox row), and so
    // are opted-out / tombstoned members and non-org outsiders. This
    // is the persistent "inbox" surface the mobile notifications
    // screen renders so a member who silenced their phone (or whose
    // OS dropped the push) can still discover the new post.
    const inboxRows = await db
      .select({
        clubMemberId: memberMessagesTable.clubMemberId,
        channel: memberMessagesTable.channel,
        subject: memberMessagesTable.subject,
        body: memberMessagesTable.body,
        relatedEntity: memberMessagesTable.relatedEntity,
        relatedEntityId: memberMessagesTable.relatedEntityId,
      })
      .from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.organizationId, orgId),
        eq(memberMessagesTable.relatedEntity, "feed_post"),
        eq(memberMessagesTable.relatedEntityId, res.body.id),
      ));

    // Only `otherMember` should have a row — the same set as the push.
    const recipientClubMembers = await db
      .select({ id: clubMembersTable.id, userId: clubMembersTable.userId })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, orgId),
        inArray(clubMembersTable.userId, [otherMember.id]),
      ));
    const expectedClubMemberIds = new Set(recipientClubMembers.map(m => m.id));
    expect(new Set(inboxRows.map(r => r.clubMemberId))).toEqual(expectedClubMemberIds);

    // Excluded users must not have an inbox row for this post.
    const authorClubMember = await db
      .select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, orgId),
        eq(clubMembersTable.userId, author.id),
      ));
    expect(inboxRows.find(r => r.clubMemberId === authorClubMember[0]?.id)).toBeUndefined();

    expect(inboxRows[0]).toMatchObject({
      channel: "in_app",
      relatedEntity: "feed_post",
      relatedEntityId: res.body.id,
    });
    expect(typeof inboxRows[0].subject).toBe("string");
    expect(inboxRows[0].subject).toContain("Feed Fan author");
    expect(inboxRows[0].body).toContain("Sunset round");
  });

  it("excludes recipients who muted the author — even if they follow the author", async () => {
    // Spin up two fresh members for this test so prior follow/mute rows
    // from other tests don't bleed in.
    async function makeMember(label: string) {
      const t = uid(label);
      const [u] = await db.insert(appUsersTable).values({
        replitUserId: t,
        username: t,
        email: `${t}@test.local`,
        displayName: `Mute ${label}`,
        role: "player",
      }).returning({ id: appUsersTable.id });
      createdUserIds.push(u.id);
      await db.insert(orgMembershipsTable).values({
        organizationId: orgId,
        userId: u.id,
        role: "player",
      });
      return u.id;
    }

    const muter = await makeMember("muter");
    const eligible = await makeMember("eligible");

    // The muter follows the author so a `followers_only` policy alone
    // would not exclude them — only the mute row should.
    await db.insert(userFollowsTable).values({
      followerId: muter,
      followeeId: author.id,
    }).onConflictDoNothing();
    await db.insert(userFeedAuthorMutesTable).values({
      muterId: muter,
      mutedUserId: author.id,
    }).onConflictDoNothing();

    const res = await request(createTestApp(author))
      .post(`/api/organizations/${orgId}/feed/posts`)
      .send({ body: "Public post; muter should not get a push." })
      .expect(200);
    createdPostIds.push(res.body.id);

    await waitForFanout();

    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const [userIds] = sendPushToUsersMock.mock.calls[0]!;
    const ids = new Set(userIds as number[]);
    expect(ids.has(muter)).toBe(false);
    expect(ids.has(eligible)).toBe(true);
    // Sanity: still excludes author + previously-set opt-out / erased.
    expect(ids.has(author.id)).toBe(false);
    expect(ids.has(optedOut.id)).toBe(false);
    expect(ids.has(erased.id)).toBe(false);
  });

  it("for a `followers_only` post only pushes the author's followers", async () => {
    // otherMember follows author; nobody else does.
    await db.insert(userFollowsTable).values({
      followerId: otherMember.id,
      followeeId: author.id,
    }).onConflictDoNothing();

    // A second eligible member who does NOT follow the author. They
    // should be excluded from the followers_only fan-out.
    const tag = uid("nonfollower");
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: tag,
      username: tag,
      email: `${tag}@test.local`,
      displayName: "Non Follower",
      role: "player",
    }).returning({ id: appUsersTable.id });
    createdUserIds.push(u.id);
    await db.insert(orgMembershipsTable).values({
      organizationId: orgId,
      userId: u.id,
      role: "player",
    });

    const res = await request(createTestApp(author))
      .post(`/api/organizations/${orgId}/feed/posts`)
      .send({ body: "Followers-only update", privacy: "followers_only" })
      .expect(200);
    createdPostIds.push(res.body.id);

    await waitForFanout();

    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    const [userIds] = sendPushToUsersMock.mock.calls[0]!;
    expect(new Set(userIds as number[])).toEqual(new Set([otherMember.id]));
    expect(userIds).not.toContain(u.id);
  });
});
