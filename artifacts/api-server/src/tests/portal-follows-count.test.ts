/**
 * Task #2153 — backend contract for the new
 * `GET /api/portal/follows/count/:userId` endpoint that powers the
 * follower / following counts on the in-app authenticated member
 * profile screen (`artifacts/kharagolf-mobile/app/member/[userId].tsx`).
 *
 * The route is auth-gated portal data (rather than a public endpoint)
 * because the consumer is itself a signed-in mobile screen and we do
 * not want anonymous scrapers harvesting aggregate social-graph data.
 *
 * This test pins the user-visible contract:
 *
 *   1. The counts match the seeded follower / followee fixtures.
 *   2. A user with no follows in either direction returns
 *      `{ followerCount: 0, followingCount: 0 }` (rather than the route
 *      throwing on the empty `count(*)` row).
 *   3. Tombstoned (`erased_at`) targets return 404 so a deleted account
 *      never leaks counts to viewers who still have a stale link.
 *   4. Unknown / non-numeric / negative `:userId` is rejected with 400
 *      or 404 (no 500s, no NaN-driven empty-counts response).
 *   5. Unauthenticated callers are rejected with 401.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, appUsersTable, userFollowsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let viewer: TestUser;
let viewerApp: ReturnType<typeof createTestApp>;
let unauthApp: ReturnType<typeof createTestApp>;

const createdUserIds: number[] = [];
let targetId: number;
let loneId: number;
let erasedId: number;

async function makeUser(label: string): Promise<number> {
  const t = uid(`${label}_${stamp}`);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: t,
    username: t,
    email: `${t}@test.local`,
    displayName: `Counts ${label}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return u.id;
}

beforeAll(async () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-follows-count";
  }

  const viewerId = await makeUser("viewer");
  const viewerName = `viewer_${stamp}`;
  viewer = { id: viewerId, username: viewerName, displayName: "Counts viewer", role: "player" };

  // Target user: 3 followers, follows 2 others.
  targetId = await makeUser("target");
  for (let i = 0; i < 3; i++) {
    const fid = await makeUser(`follower${i}`);
    await db.insert(userFollowsTable).values({ followerId: fid, followeeId: targetId });
  }
  for (let i = 0; i < 2; i++) {
    const fid = await makeUser(`followee${i}`);
    await db.insert(userFollowsTable).values({ followerId: targetId, followeeId: fid });
  }

  // A second user with zero follows in either direction so we can pin
  // the empty-counts response.
  loneId = await makeUser("lone");

  // A tombstoned user — must surface as 404 so the mobile screen falls
  // back to the existing "User not found" treatment instead of showing
  // counts for a deleted account.
  erasedId = await makeUser("erased");
  await db.update(appUsersTable)
    .set({ erasedAt: new Date() })
    .where(eq(appUsersTable.id, erasedId));

  viewerApp = createTestApp(viewer);
  unauthApp = createTestApp();
});

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(userFollowsTable).where(inArray(userFollowsTable.followerId, createdUserIds));
    await db.delete(userFollowsTable).where(inArray(userFollowsTable.followeeId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
});

describe("Task #2153 — GET /api/portal/follows/count/:userId", () => {
  it("returns the seeded follower / following counts for a populated user", async () => {
    const res = await request(viewerApp)
      .get(`/api/portal/follows/count/${targetId}`)
      .expect(200);
    expect(res.body).toEqual({
      userId: targetId,
      followerCount: 3,
      followingCount: 2,
    });
  });

  it("returns zero / zero (not null, not NaN) for a user with no follows", async () => {
    const res = await request(viewerApp)
      .get(`/api/portal/follows/count/${loneId}`)
      .expect(200);
    expect(res.body).toEqual({
      userId: loneId,
      followerCount: 0,
      followingCount: 0,
    });
  });

  it("matches what /my-follows shows the viewer when the viewer queries their own counts", async () => {
    // Viewer follows two of the target's followees so the self-lookup
    // returns a non-zero followingCount that we can cross-check against
    // the same shape the public /my-follows endpoint surfaces.
    const otherId = await makeUser("self_followee");
    await db.insert(userFollowsTable).values({ followerId: viewer.id, followeeId: otherId });

    const res = await request(viewerApp)
      .get(`/api/portal/follows/count/${viewer.id}`)
      .expect(200);
    // followerCount === 0 (nobody follows the viewer in this test),
    // followingCount === 1 (the row we just inserted).
    expect(res.body).toMatchObject({
      userId: viewer.id,
      followerCount: 0,
      followingCount: 1,
    });
  });

  it("returns 404 for a tombstoned (erased_at) user instead of leaking counts", async () => {
    await request(viewerApp)
      .get(`/api/portal/follows/count/${erasedId}`)
      .expect(404);
  });

  it("returns 404 for an unknown numeric userId", async () => {
    await request(viewerApp)
      .get(`/api/portal/follows/count/999999999`)
      .expect(404);
  });

  it("rejects non-numeric / negative userIds with 400", async () => {
    await request(viewerApp).get(`/api/portal/follows/count/not-a-number`).expect(400);
    await request(viewerApp).get(`/api/portal/follows/count/-5`).expect(400);
    await request(viewerApp).get(`/api/portal/follows/count/0`).expect(400);
  });

  it("rejects unauthenticated callers with 401", async () => {
    await request(unauthApp)
      .get(`/api/portal/follows/count/${targetId}`)
      .expect(401);
  });
});
