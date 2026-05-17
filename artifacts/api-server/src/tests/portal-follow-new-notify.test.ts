/**
 * Task #1739 — POST /api/portal/follows/:userId dispatches a
 * `social.follow.new` notification to the followee.
 *
 *   - The first follow inserts the row AND fires the dispatch.
 *   - A duplicate follow (same follower → followee already exists) is a
 *     no-op for the dispatcher: no spammy "started following you" push
 *     every time the user re-taps the button.
 *   - Self-follow / follow-of-missing-user are rejected before any
 *     dispatch happens.
 *   - The dispatched payload carries the follower's display name in the
 *     body and `data.type = "social_follow_new"` plus `data.url =
 *     "/my-follows"` so the mobile deep-link helper can route on tap.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { dispatchNotificationMock } = vi.hoisted(() => ({
  dispatchNotificationMock: vi.fn(
    async (
      _key: Parameters<typeof import("../lib/notifyDispatch.js").dispatchNotification>[0],
      _recipients: Parameters<typeof import("../lib/notifyDispatch.js").dispatchNotification>[1],
      _payload: Parameters<typeof import("../lib/notifyDispatch.js").dispatchNotification>[2],
    ) => ({
      key: "social.follow.new",
      digestable: true,
      recipients: [] as Array<{ id: number; email?: string }>,
    }),
  ),
}));

vi.mock("../lib/notifyDispatch.js", () => ({
  dispatchNotification: dispatchNotificationMock,
}));

import request from "supertest";
import { db, appUsersTable, userFollowsTable, organizationsTable } from "@workspace/db";
import { eq, inArray, or, and } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

let orgId = 0;
let aliceId = 0; // follower
let bobId = 0;   // followee

beforeAll(async () => {
  const suffix = uid("follow_notify");
  const [org] = await db.insert(organizationsTable).values({
    name: `FollowNotifyOrg_${suffix}`,
    slug: `follow-notify-${suffix}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [alice] = await db.insert(appUsersTable).values({
    replitUserId: `${suffix}_alice`,
    username: `alice_${suffix}`,
    email: `alice_${suffix}@example.test`,
    displayName: "Alice Anderson",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  aliceId = alice.id;

  const [bob] = await db.insert(appUsersTable).values({
    replitUserId: `${suffix}_bob`,
    username: `bob_${suffix}`,
    email: `bob_${suffix}@example.test`,
    displayName: "Bob Baker",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  bobId = bob.id;
});

afterAll(async () => {
  if (aliceId && bobId) {
    await db.delete(userFollowsTable).where(or(
      and(eq(userFollowsTable.followerId, aliceId), eq(userFollowsTable.followeeId, bobId)),
      and(eq(userFollowsTable.followerId, bobId), eq(userFollowsTable.followeeId, aliceId)),
    ));
  }
  if (aliceId || bobId) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, [aliceId, bobId].filter(Boolean)));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  dispatchNotificationMock.mockClear();
  await db.delete(userFollowsTable).where(or(
    and(eq(userFollowsTable.followerId, aliceId), eq(userFollowsTable.followeeId, bobId)),
    and(eq(userFollowsTable.followerId, bobId), eq(userFollowsTable.followeeId, aliceId)),
  ));
});

describe("POST /api/portal/follows/:userId — new-follower notification", () => {
  it("dispatches social.follow.new to the followee on a new follow with the follower's display name in the body", async () => {
    const app = createTestApp({ id: aliceId, username: "alice", role: "player" });
    const res = await request(app).post(`/api/portal/follows/${bobId}`);
    expect(res.status).toBe(200);

    // Wait for the fire-and-forget dispatch promise to settle.
    await new Promise<void>(r => setImmediate(r));

    expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
    const [key, recipients, payload] = dispatchNotificationMock.mock.calls[0]!;
    expect(key).toBe("social.follow.new");
    expect(recipients).toEqual([bobId]);
    expect(payload.title).toBe("New follower");
    expect(payload.body).toBe("Alice Anderson started following you");
    expect(payload.data).toMatchObject({
      type: "social_follow_new",
      followerId: aliceId,
      followerName: "Alice Anderson",
      url: "/my-follows",
    });
  });

  it("does NOT re-dispatch on a duplicate follow (idempotent — no push spam)", async () => {
    const app = createTestApp({ id: aliceId, username: "alice", role: "player" });
    const first = await request(app).post(`/api/portal/follows/${bobId}`);
    expect(first.status).toBe(200);
    await new Promise<void>(r => setImmediate(r));
    expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);

    dispatchNotificationMock.mockClear();
    const second = await request(app).post(`/api/portal/follows/${bobId}`);
    expect(second.status).toBe(200);
    await new Promise<void>(r => setImmediate(r));
    expect(dispatchNotificationMock).not.toHaveBeenCalled();
  });

  it("rejects a self-follow without dispatching", async () => {
    const app = createTestApp({ id: aliceId, username: "alice", role: "player" });
    const res = await request(app).post(`/api/portal/follows/${aliceId}`);
    expect(res.status).toBe(400);
    await new Promise<void>(r => setImmediate(r));
    expect(dispatchNotificationMock).not.toHaveBeenCalled();
  });

  it("rejects following a missing user without dispatching", async () => {
    const app = createTestApp({ id: aliceId, username: "alice", role: "player" });
    const res = await request(app).post(`/api/portal/follows/999999999`);
    expect(res.status).toBe(404);
    await new Promise<void>(r => setImmediate(r));
    expect(dispatchNotificationMock).not.toHaveBeenCalled();
  });

  it("falls back to the username when the follower has no display name", async () => {
    await db.update(appUsersTable)
      .set({ displayName: null })
      .where(eq(appUsersTable.id, aliceId));
    try {
      const app = createTestApp({ id: aliceId, username: "alice", role: "player" });
      const res = await request(app).post(`/api/portal/follows/${bobId}`);
      expect(res.status).toBe(200);
      await new Promise<void>(r => setImmediate(r));

      expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
      const [, , payload] = dispatchNotificationMock.mock.calls[0]!;
      const username = String(payload.data?.followerName);
      expect(payload.body).toBe(`${username} started following you`);
    } finally {
      await db.update(appUsersTable)
        .set({ displayName: "Alice Anderson" })
        .where(eq(appUsersTable.id, aliceId));
    }
  });
});
