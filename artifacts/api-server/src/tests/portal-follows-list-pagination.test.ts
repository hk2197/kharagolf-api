/**
 * Task #1740 — backend pagination contract for the new "My follows" page.
 *
 * The /my-follows page (web + mobile) drives both tabs off
 * `GET /api/portal/follows/list` and `GET /api/portal/followers`. The
 * single manual e2e on a brand-new account only ever exercised the empty
 * state, so the populated-list contract — pagination boundaries, the
 * 200 row hard cap, the `total` count, and the per-row shape — was
 * uncovered.
 *
 * This test seeds 3 followees (the test user follows them) and 3
 * followers (they follow the test user) and pins:
 *
 *   1. With no query params, the route returns every row plus the right
 *      `total`, ordered newest-first by `followedAt` (matching the UI).
 *   2. `limit` greater than the documented max of 200 is clamped to 200.
 *   3. `offset` correctly pages through the result set without dropping
 *      or duplicating rows.
 *   4. Negative / non-numeric `limit` falls back to the default of 50,
 *      and negative / non-numeric `offset` is treated as 0 (so the
 *      pagination clamps in `routes/follows-status.ts` can't silently
 *      regress to `NaN` and serve nothing).
 *   5. The endpoints reject unauthenticated callers with 401.
 *   6. Tombstoned (`erased_at`) follow targets / followers are excluded
 *      so a deleted account never appears in the list.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  userFollowsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let viewer: TestUser;
let viewerApp: ReturnType<typeof createTestApp>;
let unauthApp: ReturnType<typeof createTestApp>;

const createdUserIds: number[] = [];
const followeeIds: number[] = [];
const followerIds: number[] = [];
let erasedFolloweeId: number;
let erasedFollowerId: number;

async function makeUser(label: string): Promise<number> {
  const t = uid(`${label}_${stamp}`);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: t,
    username: t,
    email: `${t}@test.local`,
    displayName: `Follow ${label}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return u.id;
}

beforeAll(async () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-follows-list-pagination";
  }

  const viewerId = await makeUser("viewer");
  const viewerName = `viewer_${stamp}`;
  viewer = { id: viewerId, username: viewerName, displayName: "Follow viewer", role: "player" };

  // Three live followees (the viewer follows them) inserted in order so
  // we can assert ordering by `followedAt DESC`. We space the inserts via
  // explicit `createdAt` overrides because back-to-back inserts can land
  // on the same millisecond on fast machines.
  for (let i = 0; i < 3; i++) {
    const fid = await makeUser(`followee${i}`);
    followeeIds.push(fid);
    await db.insert(userFollowsTable).values({
      followerId: viewerId,
      followeeId: fid,
      createdAt: new Date(Date.now() - (3 - i) * 60_000), // i=0 oldest, i=2 newest
    });
  }

  // Three live followers (they follow the viewer).
  for (let i = 0; i < 3; i++) {
    const fid = await makeUser(`follower${i}`);
    followerIds.push(fid);
    await db.insert(userFollowsTable).values({
      followerId: fid,
      followeeId: viewerId,
      createdAt: new Date(Date.now() - (3 - i) * 60_000),
    });
  }

  // One tombstoned followee + one tombstoned follower. Each must be
  // filtered out by the `erased_at is null` guard in the route. We
  // deliberately give them the *newest* createdAt so a regression that
  // dropped the filter would surface them at the top of the list.
  erasedFolloweeId = await makeUser("erased_followee");
  await db.insert(userFollowsTable).values({
    followerId: viewer.id,
    followeeId: erasedFolloweeId,
    createdAt: new Date(),
  });
  await db.update(appUsersTable)
    .set({ erasedAt: new Date() })
    .where(eq(appUsersTable.id, erasedFolloweeId));

  erasedFollowerId = await makeUser("erased_follower");
  await db.insert(userFollowsTable).values({
    followerId: erasedFollowerId,
    followeeId: viewer.id,
    createdAt: new Date(),
  });
  await db.update(appUsersTable)
    .set({ erasedAt: new Date() })
    .where(eq(appUsersTable.id, erasedFollowerId));

  viewerApp = createTestApp(viewer);
  unauthApp = createTestApp(); // no user injected → isAuthenticated() returns false
});

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(userFollowsTable).where(inArray(userFollowsTable.followerId, createdUserIds));
    await db.delete(userFollowsTable).where(inArray(userFollowsTable.followeeId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
});

describe("Task #1740 — GET /api/portal/follows/list pagination contract", () => {
  it("returns every live followee with the right shape, total, and newest-first ordering", async () => {
    const res = await request(viewerApp).get("/api/portal/follows/list").expect(200);
    // Task #2184 — `total` now matches the filtered `items` projection
    // (tombstoned followees are excluded from both), so the My Follows page
    // header can never claim "5 people" while only 3 rows render.
    expect(res.body.total).toBe(followeeIds.length); // erased row excluded from total
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(followeeIds.length);

    // Erased followee never appears in items, even though its row was
    // inserted with the newest createdAt — the `erased_at is null` join
    // filter must hold.
    const ids = (res.body.items as Array<{ userId: number }>).map(r => r.userId);
    expect(ids).not.toContain(erasedFolloweeId);

    // Newest-first ordering: i=2 was inserted last → must be at index 0.
    expect(ids).toEqual([followeeIds[2], followeeIds[1], followeeIds[0]]);

    // Per-row contract — keys the FollowList component on web/mobile reads.
    for (const item of res.body.items) {
      expect(item).toMatchObject({
        userId: expect.any(Number),
        username: expect.any(String),
      });
      expect(item).toHaveProperty("displayName");
      expect(item).toHaveProperty("profileImage");
      expect(item).toHaveProperty("followedAt");
    }
  });

  it("clamps limit > 200 down to 200", async () => {
    const res = await request(viewerApp)
      .get("/api/portal/follows/list?limit=500")
      .expect(200);
    expect(res.body.limit).toBe(200);
  });

  it("offset returns the next page without dropping or duplicating rows", async () => {
    const page1 = await request(viewerApp)
      .get("/api/portal/follows/list?limit=2&offset=0")
      .expect(200);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.offset).toBe(0);
    expect(page1.body.items).toHaveLength(2);

    const page2 = await request(viewerApp)
      .get("/api/portal/follows/list?limit=2&offset=2")
      .expect(200);
    expect(page2.body.limit).toBe(2);
    expect(page2.body.offset).toBe(2);
    // page2 returns the remaining live followee. The erased row is filtered
    // out of both `items` and `total` (Task #2184), so only the third live
    // followee shows up here.
    expect(page2.body.items.length).toBeGreaterThanOrEqual(1);

    // Cross-page rows are disjoint and together cover every live followee.
    const page1Ids = (page1.body.items as Array<{ userId: number }>).map(r => r.userId);
    const page2Ids = (page2.body.items as Array<{ userId: number }>).map(r => r.userId);
    expect(page1Ids.some(id => page2Ids.includes(id))).toBe(false);
    const seen = new Set([...page1Ids, ...page2Ids]);
    for (const id of followeeIds) expect(seen.has(id)).toBe(true);
    expect(seen.has(erasedFolloweeId)).toBe(false);
  });

  it("falls back to default limit/offset when the params are not numbers", async () => {
    const res = await request(viewerApp)
      .get("/api/portal/follows/list?limit=not-a-number&offset=-9")
      .expect(200);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
  });

  it("requires authentication", async () => {
    await request(unauthApp).get("/api/portal/follows/list").expect(401);
  });
});

describe("Task #1740 — GET /api/portal/followers pagination contract", () => {
  it("returns every live follower with the right shape, total, and newest-first ordering", async () => {
    const res = await request(viewerApp).get("/api/portal/followers").expect(200);
    // Task #2184 — same filtered-`total` contract as /follows/list:
    // erased followers don't contribute to the count.
    expect(res.body.total).toBe(followerIds.length); // erased row excluded from total
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.items).toHaveLength(followerIds.length);

    const ids = (res.body.items as Array<{ userId: number }>).map(r => r.userId);
    expect(ids).not.toContain(erasedFollowerId);
    expect(ids).toEqual([followerIds[2], followerIds[1], followerIds[0]]);
  });

  it("clamps limit > 200 down to 200", async () => {
    const res = await request(viewerApp)
      .get("/api/portal/followers?limit=9999")
      .expect(200);
    expect(res.body.limit).toBe(200);
  });

  it("offset returns the next page without dropping or duplicating rows", async () => {
    const page1 = await request(viewerApp)
      .get("/api/portal/followers?limit=2&offset=0")
      .expect(200);
    const page2 = await request(viewerApp)
      .get("/api/portal/followers?limit=2&offset=2")
      .expect(200);

    expect(page1.body.items).toHaveLength(2);
    expect(page2.body.items).toHaveLength(1);

    const page1Ids = (page1.body.items as Array<{ userId: number }>).map(r => r.userId);
    const page2Ids = (page2.body.items as Array<{ userId: number }>).map(r => r.userId);
    expect(new Set([...page1Ids, ...page2Ids]).size).toBe(3);
    expect(page1Ids.some(id => page2Ids.includes(id))).toBe(false);
  });

  it("requires authentication", async () => {
    await request(unauthApp).get("/api/portal/followers").expect(401);
  });
});
