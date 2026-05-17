/**
 * Task #2159 — End-to-end coverage for the in-app inbox surfacing
 * `social.follow.new` rows in the web header bell + /notifications
 * page.
 *
 * Pinned behaviour:
 *   1. POST /api/portal/follows/:userId on a *new* follow inserts a
 *      `user_inbox_notifications` row for the followee, scoped to
 *      notification_key=`social.follow.new`, with the follower's name
 *      in the body and `payload.deepLink` pointing at /my-follows.
 *   2. A repeat follow does NOT insert a second row (mirrors the
 *      Task #1739 push-suppression guard so the inbox can't spam the
 *      user with duplicates).
 *   3. GET /api/portal/inbox/notifications returns the row plus the
 *      correct `unreadCount`, isolated to the signed-in user (a
 *      stranger's followee notification must not leak in).
 *   4. POST /api/portal/inbox/notifications/:id/read flips the row
 *      to read; the next list call reports `unreadCount: 0`.
 *   5. POST /api/portal/inbox/notifications/read-all marks every
 *      remaining unread row read in one shot.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  userFollowsTable,
  userInboxNotificationsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp } from "../../tests/helpers.js";

let followerId: number;
let followeeId: number;
let strangerId: number;
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const [follower] = await db.insert(appUsersTable).values({
    replitUserId: `t2159-follower-${stamp}`,
    username: `t2159_follower_${stamp}`,
    displayName: "Anjali Rao",
    role: "player",
  }).returning({ id: appUsersTable.id });
  followerId = follower.id;

  const [followee] = await db.insert(appUsersTable).values({
    replitUserId: `t2159-followee-${stamp}`,
    username: `t2159_followee_${stamp}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  followeeId = followee.id;

  const [stranger] = await db.insert(appUsersTable).values({
    replitUserId: `t2159-stranger-${stamp}`,
    username: `t2159_stranger_${stamp}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  strangerId = stranger.id;

  // Seed an unrelated inbox row for the stranger so the per-user
  // isolation assertion can fail loudly if the GET endpoint forgets
  // its `WHERE user_id = ?` clause.
  await db.insert(userInboxNotificationsTable).values({
    userId: strangerId,
    notificationKey: "social.follow.new",
    title: "Stranger row",
    body: "Should never appear in the followee's inbox",
    payload: { deepLink: "/my-follows" },
  });
});

afterAll(async () => {
  // Cascades from app_users.id → user_inbox_notifications.user_id +
  // user_follows.follower_id/followee_id mean we only have to delete
  // the three users we created.
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [followerId, followeeId, strangerId]));
});

describe("/api/portal/inbox/notifications + social.follow.new (Task #2159)", () => {
  it("inserts an inbox row when a *new* follow is created", async () => {
    const app = createTestApp({
      id: followerId,
      username: `t2159_follower_${stamp}`,
      role: "player",
    });

    const res = await request(app).post(`/api/portal/follows/${followeeId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Side-effect: row should now exist in the inbox table for the
    // followee with the registry key + deep link the UI relies on.
    // Inserts are dispatched via `.catch(...)` for resilience, so wait
    // a tick for the promise to flush before asserting.
    await new Promise(r => setTimeout(r, 20));
    const rows = await db.select().from(userInboxNotificationsTable)
      .where(and(
        eq(userInboxNotificationsTable.userId, followeeId),
        eq(userInboxNotificationsTable.notificationKey, "social.follow.new"),
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("New follower");
    expect(rows[0].body).toContain("Anjali Rao");
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.deepLink).toBe("/my-follows");
    expect(payload.followerId).toBe(followerId);
    expect(rows[0].readAt).toBeNull();
  });

  it("does NOT insert a second row when an already-followed user is re-followed", async () => {
    const app = createTestApp({
      id: followerId,
      username: `t2159_follower_${stamp}`,
      role: "player",
    });

    // Repeat follow — the wave3 follow handler short-circuits after
    // `onConflictDoNothing()` returns an empty array, so neither the
    // dispatch nor the inbox insert should fire a second time.
    const res = await request(app).post(`/api/portal/follows/${followeeId}`);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 20));
    const rows = await db.select().from(userInboxNotificationsTable)
      .where(and(
        eq(userInboxNotificationsTable.userId, followeeId),
        eq(userInboxNotificationsTable.notificationKey, "social.follow.new"),
      ));
    expect(rows).toHaveLength(1);
  });

  it("GET /portal/inbox/notifications returns the followee's row only (per-user scoped)", async () => {
    const app = createTestApp({
      id: followeeId,
      username: `t2159_followee_${stamp}`,
      role: "player",
    });

    const res = await request(app).get("/api/portal/inbox/notifications");
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.notificationKey).toBe("social.follow.new");
    expect(item.deepLink).toBe("/my-follows");
    expect(item.title).toBe("New follower");
    expect(item.body).toContain("Anjali Rao");
    expect(item.readAt).toBeNull();
    // The stranger's row must NOT be present.
    expect((res.body.items as Array<{ title: string }>).every(i => i.title !== "Stranger row")).toBe(true);
  });

  it("POST /portal/inbox/notifications/:id/read flips the row to read", async () => {
    const app = createTestApp({
      id: followeeId,
      username: `t2159_followee_${stamp}`,
      role: "player",
    });

    const list = await request(app).get("/api/portal/inbox/notifications");
    const targetId = list.body.items[0].id as number;

    const res = await request(app).post(`/api/portal/inbox/notifications/${targetId}/read`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, updated: 1 });

    const after = await request(app).get("/api/portal/inbox/notifications");
    expect(after.body.unreadCount).toBe(0);
    expect(after.body.items[0].readAt).not.toBeNull();

    // Idempotency: re-marking a read row reports `updated: 0`.
    const replay = await request(app).post(`/api/portal/inbox/notifications/${targetId}/read`);
    expect(replay.body.updated).toBe(0);
  });

  it("POST /portal/inbox/notifications/read-all clears every remaining unread row", async () => {
    // Insert two more unread rows so the read-all has something to do.
    await db.insert(userInboxNotificationsTable).values([
      {
        userId: followeeId,
        notificationKey: "social.follow.new",
        title: "Second follower",
        body: "Bea Brown started following you",
        payload: { deepLink: "/my-follows" },
      },
      {
        userId: followeeId,
        notificationKey: "social.follow.new",
        title: "Third follower",
        body: "Carla Cruz started following you",
        payload: { deepLink: "/my-follows" },
      },
    ]);

    const app = createTestApp({
      id: followeeId,
      username: `t2159_followee_${stamp}`,
      role: "player",
    });

    const before = await request(app).get("/api/portal/inbox/notifications");
    expect(before.body.unreadCount).toBe(2);

    const res = await request(app).post("/api/portal/inbox/notifications/read-all");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.updated).toBeGreaterThanOrEqual(2);

    const after = await request(app).get("/api/portal/inbox/notifications");
    expect(after.body.unreadCount).toBe(0);
  });

  it("requires authentication on every endpoint", async () => {
    const app = createTestApp(); // no user → req.user is undefined
    const list = await request(app).get("/api/portal/inbox/notifications");
    expect(list.status).toBe(401);
    const one = await request(app).post("/api/portal/inbox/notifications/1/read");
    expect(one.status).toBe(401);
    const all = await request(app).post("/api/portal/inbox/notifications/read-all");
    expect(all.status).toBe(401);
  });
});

// Reduce noise from the wave3 follow handler test interactions.
void userFollowsTable;
