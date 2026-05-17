/**
 * Task #2152 — backend pagination + privacy contract for the public
 * follower / following list endpoints used by the website + mobile
 * public profile.
 *
 * The clickable counts on /p/<handle> hit:
 *   GET /api/public/p/:handle/followers
 *   GET /api/public/p/:handle/following
 *
 * Both are unauthenticated, so this test pins:
 *
 *   1. The owner's `publicProfileEnabled = true` gate (404 otherwise).
 *   2. The same items + total + limit + offset shape as
 *      /portal/follows/list, with rows ordered newest-first by
 *      `followedAt`.
 *   3. Default limit = 50 and clamp at 200; non-numeric `limit` /
 *      `offset` fall back to defaults (so a regression to NaN can't
 *      silently serve nothing).
 *   4. Tombstoned (`erased_at`) follower/followee rows are filtered
 *      from items even though they were inserted with the newest
 *      `followedAt`.
 *   5. Private follower/followee rows (the *other* user has
 *      `publicProfileEnabled = false`) are returned in the items list
 *      but redacted: `isPrivate: true` and no displayName / avatar /
 *      handle. Public rows are NOT redacted.
 *   6. Pagination boundaries — offset returns disjoint pages whose
 *      union covers the live rows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  userFollowsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const ownerHandle = `pf_owner_${stamp}`;
const privateHandle = `pf_priv_${stamp}`;

let ownerId: number;
let privateOwnerId: number; // has publicProfileEnabled = false
const createdUserIds: number[] = [];
const publicFollowerIds: number[] = []; // they follow ownerId, opted-in
let privateFollowerId: number;          // follows ownerId, opted-out
let erasedFollowerId: number;
const publicFolloweeIds: number[] = []; // ownerId follows them, opted-in
let privateFolloweeId: number;          // ownerId follows them, opted-out
let erasedFolloweeId: number;

let app: ReturnType<typeof createTestApp>;

async function makeUser(label: string, publicProfileEnabled = true, publicHandle: string | null = null): Promise<number> {
  const t = uid(`${label}_${stamp}`);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: t,
    username: t,
    email: `${t}@test.local`,
    displayName: `Pub ${label}`,
    role: "player",
    publicProfileEnabled,
    publicHandle,
    profileImage: publicProfileEnabled ? `https://img.example.com/${t}.png` : null,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return u.id;
}

beforeAll(async () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-public-follows-list";
  }

  ownerId = await makeUser("owner", true, ownerHandle);
  privateOwnerId = await makeUser("private_owner", false, privateHandle);

  // Three opted-in followers of `owner`, inserted oldest → newest so we
  // can pin newest-first ordering on the response.
  for (let i = 0; i < 3; i++) {
    const fid = await makeUser(`follower${i}`, true, `pf_f${i}_${stamp}`);
    publicFollowerIds.push(fid);
    await db.insert(userFollowsTable).values({
      followerId: fid,
      followeeId: ownerId,
      createdAt: new Date(Date.now() - (5 - i) * 60_000),
    });
  }

  // One opted-out follower — must show up as a redacted row.
  privateFollowerId = await makeUser("private_follower", false, null);
  await db.insert(userFollowsTable).values({
    followerId: privateFollowerId,
    followeeId: ownerId,
    createdAt: new Date(Date.now() - 10_000),
  });

  // One tombstoned follower — must be filtered out entirely. Inserted
  // with the newest createdAt so a regression that dropped the
  // erased_at filter would surface it at the top.
  erasedFollowerId = await makeUser("erased_follower", true, `pf_ef_${stamp}`);
  await db.insert(userFollowsTable).values({
    followerId: erasedFollowerId,
    followeeId: ownerId,
    createdAt: new Date(),
  });
  await db.update(appUsersTable)
    .set({ erasedAt: new Date() })
    .where(eq(appUsersTable.id, erasedFollowerId));

  // Symmetrical setup for following list (owner follows them).
  for (let i = 0; i < 3; i++) {
    const fid = await makeUser(`followee${i}`, true, `pf_fe${i}_${stamp}`);
    publicFolloweeIds.push(fid);
    await db.insert(userFollowsTable).values({
      followerId: ownerId,
      followeeId: fid,
      createdAt: new Date(Date.now() - (5 - i) * 60_000),
    });
  }
  privateFolloweeId = await makeUser("private_followee", false, null);
  await db.insert(userFollowsTable).values({
    followerId: ownerId,
    followeeId: privateFolloweeId,
    createdAt: new Date(Date.now() - 10_000),
  });
  erasedFolloweeId = await makeUser("erased_followee", true, `pf_efe_${stamp}`);
  await db.insert(userFollowsTable).values({
    followerId: ownerId,
    followeeId: erasedFolloweeId,
    createdAt: new Date(),
  });
  await db.update(appUsersTable)
    .set({ erasedAt: new Date() })
    .where(eq(appUsersTable.id, erasedFolloweeId));

  app = createTestApp();
});

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(userFollowsTable).where(inArray(userFollowsTable.followerId, createdUserIds));
    await db.delete(userFollowsTable).where(inArray(userFollowsTable.followeeId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
});

describe("Task #2152 — GET /api/public/p/:handle/followers", () => {
  it("404s when the profile owner has not opted into a public profile", async () => {
    await request(app)
      .get(`/api/public/p/${privateHandle}/followers`)
      .expect(404);
  });

  it("404s for an unknown handle", async () => {
    await request(app)
      .get(`/api/public/p/no-such-handle-${stamp}/followers`)
      .expect(404);
  });

  it("returns rows in newest-first order with default limit/offset and the right total", async () => {
    const res = await request(app)
      .get(`/api/public/p/${ownerHandle}/followers`)
      .expect(200);

    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    // `total` MUST count only the rows that can appear in items —
    // i.e. exclude tombstoned (erased) users — so a paginated client's
    // "offset < total" guard terminates instead of looping on empty
    // pages. Private rows still count because they are returned (just
    // redacted), only erased rows are excluded.
    const liveCount = publicFollowerIds.length + 1; // public + private
    expect(res.body.total).toBe(liveCount);

    const items = res.body.items as Array<{
      userId: number; displayName: string | null; profileImage: string | null;
      publicHandle: string | null; isPrivate: boolean; followedAt: string;
    }>;
    // Erased row is dropped from items even though it has the newest createdAt.
    expect(items.find(i => i.userId === erasedFollowerId)).toBeUndefined();
    expect(items).toHaveLength(liveCount);

    // The private follower must appear redacted, not omitted.
    const priv = items.find(i => i.userId === privateFollowerId);
    expect(priv).toBeTruthy();
    expect(priv!.isPrivate).toBe(true);
    expect(priv!.displayName).toBeNull();
    expect(priv!.profileImage).toBeNull();
    expect(priv!.publicHandle).toBeNull();

    // Public rows must NOT be redacted and must hydrate display fields.
    const pub = items.find(i => i.userId === publicFollowerIds[2]);
    expect(pub).toBeTruthy();
    expect(pub!.isPrivate).toBe(false);
    expect(typeof pub!.displayName).toBe("string");
    expect(pub!.profileImage).toMatch(/^https?:/);
    expect(typeof pub!.publicHandle).toBe("string");
    expect(typeof pub!.followedAt).toBe("string");

    // Newest-first ordering across the public rows: index 2 was inserted last.
    const publicIdsOrdered = items
      .filter(i => !i.isPrivate)
      .map(i => i.userId);
    expect(publicIdsOrdered.slice(0, 3)).toEqual([
      publicFollowerIds[2], publicFollowerIds[1], publicFollowerIds[0],
    ]);
  });

  it("clamps limit > 200 down to 200 and ignores non-numeric limit/offset", async () => {
    const r1 = await request(app)
      .get(`/api/public/p/${ownerHandle}/followers?limit=9999`)
      .expect(200);
    expect(r1.body.limit).toBe(200);

    const r2 = await request(app)
      .get(`/api/public/p/${ownerHandle}/followers?limit=foo&offset=-9`)
      .expect(200);
    expect(r2.body.limit).toBe(50);
    expect(r2.body.offset).toBe(0);
  });

  it("paginates without dropping or duplicating rows", async () => {
    const page1 = await request(app)
      .get(`/api/public/p/${ownerHandle}/followers?limit=2&offset=0`)
      .expect(200);
    const page2 = await request(app)
      .get(`/api/public/p/${ownerHandle}/followers?limit=2&offset=2`)
      .expect(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page2.body.items.length).toBeGreaterThanOrEqual(1);
    const ids1 = (page1.body.items as Array<{ userId: number }>).map(r => r.userId);
    const ids2 = (page2.body.items as Array<{ userId: number }>).map(r => r.userId);
    expect(ids1.some(id => ids2.includes(id))).toBe(false);
  });
});

describe("Task #2152 — GET /api/public/p/:handle/following", () => {
  it("returns rows in newest-first order with the right total + redacted private rows", async () => {
    const res = await request(app)
      .get(`/api/public/p/${ownerHandle}/following`)
      .expect(200);

    expect(res.body.limit).toBe(50);
    // total = live rows only (excludes erased), see followers-test comment.
    expect(res.body.total).toBe(publicFolloweeIds.length + 1);

    const items = res.body.items as Array<{ userId: number; isPrivate: boolean; publicHandle: string | null }>;
    expect(items.find(i => i.userId === erasedFolloweeId)).toBeUndefined();

    const priv = items.find(i => i.userId === privateFolloweeId);
    expect(priv).toBeTruthy();
    expect(priv!.isPrivate).toBe(true);
    expect(priv!.publicHandle).toBeNull();

    const publicIdsOrdered = items
      .filter(i => !i.isPrivate)
      .map(i => i.userId);
    expect(publicIdsOrdered.slice(0, 3)).toEqual([
      publicFolloweeIds[2], publicFolloweeIds[1], publicFolloweeIds[0],
    ]);
  });

  it("404s when the profile owner has not opted in", async () => {
    await request(app)
      .get(`/api/public/p/${privateHandle}/following`)
      .expect(404);
  });
});
