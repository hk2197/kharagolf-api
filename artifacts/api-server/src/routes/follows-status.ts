import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, userFollowsTable, appUsersTable } from "@workspace/db";

const router: IRouter = Router();

function uid(req: Request): number {
  return Number((req.user as { id?: number } | undefined)?.id ?? 0);
}

// Existing endpoint — returns just the IDs the viewer follows so the
// FollowButton component can hydrate as "Following" instead of flashing
// "Follow" first (Task #1227). Shape preserved for back-compat with
// useFolloweeIds on web and mobile.
router.get("/portal/follows", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const userId = uid(req);
  const rows = await db
    .select({ followeeId: userFollowsTable.followeeId })
    .from(userFollowsTable)
    .where(eq(userFollowsTable.followerId, userId));
  res.json({ followeeIds: rows.map(r => r.followeeId) });
});

// Task #1421 — paginated list of users the viewer is following, with
// enough profile detail (display name, avatar) to render a "My follows"
// page on web/mobile and let them unfollow without re-fetching each row.
// Ordered newest-follow-first so the most recent additions surface at the
// top, matching how social apps typically present this list.
function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
function clampOffset(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

router.get("/portal/follows/list", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const userId = uid(req);
  const limit = clampLimit(req.query.limit, 50, 200);
  const offset = clampOffset(req.query.offset);

  // Task #2184 — count must match the filtered `items` projection so the
  // "X people" header on the My Follows page never overstates the list.
  // Join through `app_users` and exclude tombstoned (`erased_at`) targets,
  // mirroring the WHERE clause used to build `rows` below.
  const [{ count }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(userFollowsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, userFollowsTable.followeeId))
    .where(and(eq(userFollowsTable.followerId, userId), sql`${appUsersTable.erasedAt} is null`));

  const rows = await db
    .select({
      userId: appUsersTable.id,
      username: appUsersTable.username,
      displayName: appUsersTable.displayName,
      profileImage: appUsersTable.profileImage,
      followedAt: userFollowsTable.createdAt,
    })
    .from(userFollowsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, userFollowsTable.followeeId))
    .where(and(eq(userFollowsTable.followerId, userId), sql`${appUsersTable.erasedAt} is null`))
    .orderBy(desc(userFollowsTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({
    items: rows.map(r => ({
      userId: r.userId,
      username: r.username,
      displayName: r.displayName,
      profileImage: r.profileImage,
      followedAt: r.followedAt,
    })),
    total: Number(count) || 0,
    limit,
    offset,
  });
});

// Task #2153 — aggregate follower / following counts for an arbitrary
// member, used by the in-app authenticated member profile screen
// (`artifacts/kharagolf-mobile/app/member/[userId].tsx`) to render
// "X followers · Y following" alongside the existing Follow button.
//
// The `/p/<handle>` public profile already exposes the same counts via
// `GET /api/public/p/:handle` (see routes/public.ts, Task #1738), but
// in-app navigation to a member who has *not* reserved a public handle
// falls through to the private member screen, which previously showed
// only the Follow button. We add a small auth-gated endpoint here so
// the mobile screen can fetch the counts for any signed-in viewer
// without needing the target to be opted-in publicly.
//
// Auth-gated (rather than public) because the consumer is itself an
// in-app screen guarded by `useAuth`, and keeping it portal-scoped
// avoids leaking aggregate social-graph data to anonymous scrapers
// hitting `/api/public/...`. Tombstoned users (`erased_at` set) return
// a 404 so a deleted account doesn't surface counts.
router.get("/portal/follows/count/:userId", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const targetId = Number(req.params.userId);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    res.status(400).json({ error: "bad_target" }); return;
  }
  const [target] = await db
    .select({ id: appUsersTable.id })
    .from(appUsersTable)
    .where(and(eq(appUsersTable.id, targetId), sql`${appUsersTable.erasedAt} is null`))
    .limit(1);
  if (!target) { res.status(404).json({ error: "user_not_found" }); return; }

  const [followerCountRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(userFollowsTable)
    .where(eq(userFollowsTable.followeeId, targetId));
  const [followingCountRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(userFollowsTable)
    .where(eq(userFollowsTable.followerId, targetId));
  res.json({
    userId: targetId,
    followerCount: Number(followerCountRow?.count) || 0,
    followingCount: Number(followingCountRow?.count) || 0,
  });
});

// Task #1421 — paginated list of users following the viewer. Mirrors the
// /follows/list shape so the same UI component can render either tab.
// Ordered by most-recent follower first so the user notices new
// followers without scrolling.
router.get("/portal/followers", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const userId = uid(req);
  const limit = clampLimit(req.query.limit, 50, 200);
  const offset = clampOffset(req.query.offset);

  // Task #2184 — count must match the filtered `items` projection so the
  // "X people" header on the My Follows page never overstates the list.
  // Join through `app_users` and exclude tombstoned (`erased_at`) followers,
  // mirroring the WHERE clause used to build `rows` below.
  const [{ count }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(userFollowsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, userFollowsTable.followerId))
    .where(and(eq(userFollowsTable.followeeId, userId), sql`${appUsersTable.erasedAt} is null`));

  const rows = await db
    .select({
      userId: appUsersTable.id,
      username: appUsersTable.username,
      displayName: appUsersTable.displayName,
      profileImage: appUsersTable.profileImage,
      followedAt: userFollowsTable.createdAt,
    })
    .from(userFollowsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, userFollowsTable.followerId))
    .where(and(eq(userFollowsTable.followeeId, userId), sql`${appUsersTable.erasedAt} is null`))
    .orderBy(desc(userFollowsTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({
    items: rows.map(r => ({
      userId: r.userId,
      username: r.username,
      displayName: r.displayName,
      profileImage: r.profileImage,
      followedAt: r.followedAt,
    })),
    total: Number(count) || 0,
    limit,
    offset,
  });
});

export default router;
