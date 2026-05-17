/**
 * Social Wall & Club Feed API (Task #94)
 * Mounted at: /organizations/:orgId/feed
 *
 * GET    /                          Paginated feed (member)
 * POST   /posts                     Create post (member/admin)
 * GET    /posts/:postId             Get single post
 * PATCH  /posts/:postId             Edit post (author/admin)
 * DELETE /posts/:postId             Delete post (author/admin)
 * POST   /posts/:postId/pin         Toggle pin (admin)
 * POST   /posts/:postId/hide        Hide/unhide post (admin)
 * POST   /posts/:postId/react       Like/unlike (toggle)
 * GET    /posts/:postId/comments    List comments
 * POST   /posts/:postId/comments    Add comment
 * PATCH  /posts/:postId/comments/:commentId  Edit comment
 * DELETE /posts/:postId/comments/:commentId  Delete comment
 * POST   /posts/:postId/report      Report post
 * GET    /moderation                Moderation queue (admin)
 * POST   /reports/:reportId/resolve Resolve report (admin)
 * POST   /achievements              Auto-post achievement card (admin)
 */

import { Router, type Request, type Response } from "express";
import {
  db,
  feedPostsTable,
  feedPostMediaTable,
  feedReactionsTable,
  feedCommentsTable,
  feedReportsTable,
  appUsersTable,
  orgMembershipsTable,
  highlightReelsTable,
  userNotificationPrefsTable,
  userFollowsTable,
  userFeedAuthorMutesTable,
  clubMembersTable,
  memberMessagesTable,
} from "@workspace/db";
import { eq, and, desc, sql, lt, ne, inArray } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import { sendPushToUsers } from "../lib/push";

const router = Router({ mergeParams: true });

// ── Auth helpers ─────────────────────────────────────────────────────────────

type PortalReq = { portalUser?: { userId?: number } };

function getUserId(req: Request): number | null {
  if (req.isAuthenticated()) {
    const u = req.user as { id?: number };
    return u?.id ?? null;
  }
  return (req as unknown as PortalReq).portalUser?.userId ?? null;
}

async function getOrgMembership(userId: number, orgId: number) {
  const [row] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.userId, userId), eq(orgMembershipsTable.organizationId, orgId)));
  return row ?? null;
}

async function requireOrgMember(req: Request, res: Response, orgId: number): Promise<boolean> {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "Authentication required" }); return false; }
  const m = await getOrgMembership(userId, orgId);
  if (!m) { res.status(403).json({ error: "Not a member of this organisation" }); return false; }
  return true;
}

function isAdminRole(role: string) {
  return ["super_admin", "org_admin", "tournament_director"].includes(role);
}

// ── New-post push fan-out (Task #1697) ───────────────────────────────────────
//
// Fires a `data.type = "feed_post"` push to every other org member when a
// new post is published, so the More-menu badge in the mobile app can
// refresh within ~1s of the post landing instead of waiting up to 5 minutes
// for the next safety-net poll. Mirrors the per-push trigger pattern set up
// by Task #1407 (`BADGE_PUSH_TYPES` whitelist in the mobile provider).
//
// Filtering rules:
//   - Skip the author themselves.
//   - Skip recipients with `userNotificationPrefs.preferPush = false`
//     (default true, so members without a prefs row still receive).
//   - Skip recipients whose `app_users.erased_at` tombstone is set
//     (Task #467) — those accounts are no longer reachable.
//   - For `privacy = "followers_only"` posts, intersect the recipient set
//     with the author's followers (`user_follows.followee_id = author`).
//   - Skip recipients who have muted this author
//     (`user_feed_author_mutes.muter_id = recipient AND
//     muted_user_id = author`). Mutes are deliberately checked *after*
//     the followers-only filter — a follower who has muted the author
//     should still not be pushed.
//
// Best-effort: the push is fired *after* the HTTP response is sent (the
// caller `void`-awaits this) and any errors are logged but never thrown so
// a transient Expo / DB hiccup cannot fail the post-creation request.
async function fanoutFeedPostPush(opts: {
  orgId: number;
  postId: number;
  authorUserId: number;
  body: string;
  privacy: string;
}): Promise<void> {
  const { orgId, postId, authorUserId, body, privacy } = opts;
  try {
    // 1) Org members minus the author. Left-join prefs/users so we can
    //    filter opted-out and erased recipients in the same round-trip.
    const rows = await db
      .select({
        userId: orgMembershipsTable.userId,
        preferPush: userNotificationPrefsTable.preferPush,
        erasedAt: appUsersTable.erasedAt,
      })
      .from(orgMembershipsTable)
      .leftJoin(userNotificationPrefsTable, eq(userNotificationPrefsTable.userId, orgMembershipsTable.userId))
      .leftJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
      .where(and(
        eq(orgMembershipsTable.organizationId, orgId),
        ne(orgMembershipsTable.userId, authorUserId),
      ));

    let userIds = rows
      .filter(r => r.erasedAt == null)
      .filter(r => r.preferPush !== false)
      .map(r => r.userId);

    // 2) `followers_only` posts: only push followers of the author.
    if (privacy === "followers_only" && userIds.length > 0) {
      const followers = await db
        .select({ followerId: userFollowsTable.followerId })
        .from(userFollowsTable)
        .where(eq(userFollowsTable.followeeId, authorUserId));
      const followerSet = new Set(followers.map(f => f.followerId));
      userIds = userIds.filter(id => followerSet.has(id));
    }

    // 3) Suppress recipients who muted this author. Indexed by
    //    `muted_user_id`, so this is a single index probe per author.
    if (userIds.length > 0) {
      const muters = await db
        .select({ muterId: userFeedAuthorMutesTable.muterId })
        .from(userFeedAuthorMutesTable)
        .where(eq(userFeedAuthorMutesTable.mutedUserId, authorUserId));
      if (muters.length > 0) {
        const muterSet = new Set(muters.map(m => m.muterId));
        userIds = userIds.filter(id => !muterSet.has(id));
      }
    }

    if (userIds.length === 0) return;

    // 4) Build a friendly title using the author's display name.
    const [author] = await db
      .select({ displayName: appUsersTable.displayName, username: appUsersTable.username })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, authorUserId));
    const authorName = author?.displayName?.trim() || author?.username?.trim() || "Someone";
    const title = `${authorName} posted to the feed`;
    const preview = body.length > 120 ? `${body.slice(0, 120)}…` : body;

    // Task #2111 — mirror the push fan-out into the in-app notifications
    // inbox so members who silenced their phone or whose OS dropped the
    // push still get a persistent "Pat posted to the feed" row they can
    // scroll back through. Mirrors the pattern used by
    // `notifyRoundRobinTieBreak`: one `member_messages` row per recipient
    // who has a `clubMembers` row in this org (the inbox is keyed off
    // `clubMemberId`). The same per-user push preferences the fan-out
    // already respects (`preferPush`, mute, follow, erased) gate inbox
    // writes too — the inbox row is the durable counterpart of the same
    // alert, not a separate channel that bypasses the user's choice.
    // Best-effort and isolated from the push leg: a DB hiccup here must
    // not stop the push from going out (and vice versa).
    try {
      const members = await db
        .select({ id: clubMembersTable.id, userId: clubMembersTable.userId })
        .from(clubMembersTable)
        .where(and(
          eq(clubMembersTable.organizationId, orgId),
          inArray(clubMembersTable.userId, userIds),
        ));
      if (members.length > 0) {
        await db.insert(memberMessagesTable).values(
          members.map(m => ({
            organizationId: orgId,
            clubMemberId: m.id,
            channel: "in_app",
            subject: title,
            body: preview,
            status: "sent",
            relatedEntity: "feed_post",
            relatedEntityId: postId,
          })),
        );
      }
    } catch (err) {
      console.error("[feed] post inbox fan-out failed:", err);
    }

    await sendPushToUsers(userIds, title, preview, {
      type: "feed_post",
      postId,
      orgId,
    });
  } catch (e) {
    console.error("[feed] post push fan-out failed:", e);
  }
}

// ── Feed (paginated) ─────────────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const userId = getUserId(req)!;

  const cursor = req.query.cursor ? new Date(req.query.cursor as string) : undefined;
  const limit = Math.min(parseInt((req.query.limit as string) || "20"), 50);

  try {
    const base = and(
      eq(feedPostsTable.organizationId, orgId),
      eq(feedPostsTable.isHidden, false),
    );
    const condition = cursor ? and(base, lt(feedPostsTable.createdAt, cursor)) : base;

    const posts = await db
      .select({
        id: feedPostsTable.id,
        type: feedPostsTable.type,
        body: feedPostsTable.body,
        privacy: feedPostsTable.privacy,
        isPinned: feedPostsTable.isPinned,
        taggedCourseId: feedPostsTable.taggedCourseId,
        taggedHoleNumber: feedPostsTable.taggedHoleNumber,
        achievementType: feedPostsTable.achievementType,
        reactionsCount: feedPostsTable.reactionsCount,
        commentsCount: feedPostsTable.commentsCount,
        createdAt: feedPostsTable.createdAt,
        authorUserId: feedPostsTable.authorUserId,
        authorDisplayName: appUsersTable.displayName,
        authorUsername: appUsersTable.username,
        authorProfileImage: appUsersTable.profileImage,
      })
      .from(feedPostsTable)
      .leftJoin(appUsersTable, eq(appUsersTable.id, feedPostsTable.authorUserId))
      .where(condition)
      .orderBy(desc(feedPostsTable.isPinned), desc(feedPostsTable.createdAt))
      .limit(limit + 1);

    const hasMore = posts.length > limit;
    const items = hasMore ? posts.slice(0, limit) : posts;

    const postIds = items.map(p => p.id);
    let mediaByPost: Record<number, { url: string; mimeType: string; sortOrder: number }[]> = {};
    if (postIds.length > 0) {
      const media = await db
        .select({ postId: feedPostMediaTable.postId, url: feedPostMediaTable.url, mimeType: feedPostMediaTable.mimeType, sortOrder: feedPostMediaTable.sortOrder })
        .from(feedPostMediaTable)
        .where(sql`${feedPostMediaTable.postId} = ANY(ARRAY[${sql.join(postIds.map(id => sql`${id}`), sql`, `)}])`)
        .orderBy(feedPostMediaTable.sortOrder);
      for (const m of media) {
        if (!mediaByPost[m.postId]) mediaByPost[m.postId] = [];
        mediaByPost[m.postId].push({ url: m.url, mimeType: m.mimeType, sortOrder: m.sortOrder });
      }
    }

    // Task #708 — surface the source reel id for any post that was created
    // by posting a highlight reel to the feed. Lets the feed UI fire view +
    // re-share engagement pings against the same /highlights/:id/events
    // endpoint the highlights gallery uses.
    const reelByPost = new Map<number, number>();
    if (postIds.length > 0) {
      const reels = await db
        .select({ id: highlightReelsTable.id, feedPostId: highlightReelsTable.feedPostId })
        .from(highlightReelsTable)
        .where(sql`${highlightReelsTable.feedPostId} = ANY(ARRAY[${sql.join(postIds.map(id => sql`${id}`), sql`, `)}]::int[])`);
      for (const r of reels) {
        if (r.feedPostId != null) reelByPost.set(r.feedPostId, r.id);
      }
    }

    let reactedPostIds = new Set<number>();
    if (postIds.length > 0) {
      const reactions = await db
        .select({ postId: feedReactionsTable.postId })
        .from(feedReactionsTable)
        .where(and(
          eq(feedReactionsTable.userId, userId),
          sql`${feedReactionsTable.postId} = ANY(ARRAY[${sql.join(postIds.map(id => sql`${id}`), sql`, `)}])`
        ));
      reactedPostIds = new Set(reactions.map(r => r.postId));
    }

    const nextCursor = hasMore ? items[items.length - 1].createdAt?.toISOString() : null;

    res.json({
      posts: items.map(p => ({
        ...p,
        media: mediaByPost[p.id] ?? [],
        hasReacted: reactedPostIds.has(p.id),
        // Task #708 — present for posts that were generated from a highlight
        // reel. The feed UI uses this to fire view + feed_share engagement
        // pings; null for plain text/photo posts.
        reelId: reelByPost.get(p.id) ?? null,
      })),
      hasMore,
      nextCursor,
    });
  } catch (e) {
    console.error("Feed fetch error:", e);
    res.status(500).json({ error: "Failed to fetch feed" });
  }
});

// ── Create post ──────────────────────────────────────────────────────────────

router.post("/posts", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const userId = getUserId(req)!;
  const m = await getOrgMembership(userId, orgId);
  if (!m) { { res.status(403).json({ error: "Not a member" }); return; } }

  const { body, privacy = "all_members", type, taggedCourseId, taggedHoleNumber, mediaUrls } = req.body;
  if (!body?.trim()) { { res.status(400).json({ error: "Post body is required" }); return; } }

  const postType = isAdminRole(m.role)
    ? (type === "club_announcement" ? "club_announcement" : "member_post")
    : "member_post";

  const isPinned = postType === "club_announcement";

  try {
    const [post] = await db
      .insert(feedPostsTable)
      .values({
        organizationId: orgId,
        authorUserId: userId,
        type: postType,
        body: body.trim(),
        privacy,
        isPinned,
        taggedCourseId: taggedCourseId ?? null,
        taggedHoleNumber: taggedHoleNumber ?? null,
      })
      .returning();

    if (Array.isArray(mediaUrls) && mediaUrls.length > 0) {
      await db.insert(feedPostMediaTable).values(
        mediaUrls.slice(0, 4).map((url: string, i: number) => ({
          postId: post.id,
          url,
          mimeType: "image/jpeg",
          sortOrder: i,
        }))
      );
    }

    res.json(post);

    // Task #1697 — fan out a `feed_post` push to other org members so the
    // mobile More-menu badge refreshes within ~1s of the post landing
    // (instead of waiting for the next 5-minute safety-net poll). Fired
    // *after* the response is sent so a slow Expo round-trip cannot delay
    // the author's UI; the helper swallows its own errors.
    void fanoutFeedPostPush({
      orgId,
      postId: post.id,
      authorUserId: userId,
      body: body.trim(),
      privacy: post.privacy,
    });
  } catch (e) {
    console.error("Create post error:", e);
    res.status(500).json({ error: "Failed to create post" });
  }
});

// ── Get single post ──────────────────────────────────────────────────────────

router.get("/posts/:postId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const postId = parseInt(String((req.params as Record<string, string>).postId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const userId = getUserId(req)!;
  try {
    const [post] = await db
      .select({
        id: feedPostsTable.id,
        type: feedPostsTable.type,
        body: feedPostsTable.body,
        privacy: feedPostsTable.privacy,
        isPinned: feedPostsTable.isPinned,
        isHidden: feedPostsTable.isHidden,
        taggedCourseId: feedPostsTable.taggedCourseId,
        taggedHoleNumber: feedPostsTable.taggedHoleNumber,
        achievementType: feedPostsTable.achievementType,
        reactionsCount: feedPostsTable.reactionsCount,
        commentsCount: feedPostsTable.commentsCount,
        createdAt: feedPostsTable.createdAt,
        authorUserId: feedPostsTable.authorUserId,
        authorDisplayName: appUsersTable.displayName,
        authorUsername: appUsersTable.username,
        authorProfileImage: appUsersTable.profileImage,
      })
      .from(feedPostsTable)
      .leftJoin(appUsersTable, eq(appUsersTable.id, feedPostsTable.authorUserId))
      .where(and(eq(feedPostsTable.id, postId), eq(feedPostsTable.organizationId, orgId)));

    if (!post) { { res.status(404).json({ error: "Post not found" }); return; } }

    const media = await db
      .select()
      .from(feedPostMediaTable)
      .where(eq(feedPostMediaTable.postId, postId))
      .orderBy(feedPostMediaTable.sortOrder);

    const [reaction] = await db
      .select({ id: feedReactionsTable.id })
      .from(feedReactionsTable)
      .where(and(eq(feedReactionsTable.postId, postId), eq(feedReactionsTable.userId, userId)))
      .limit(1);

    res.json({ ...post, media, hasReacted: !!reaction });
  } catch {
    res.status(500).json({ error: "Failed to fetch post" });
  }
});

// ── Edit post ────────────────────────────────────────────────────────────────

router.patch("/posts/:postId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const postId = parseInt(String((req.params as Record<string, string>).postId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const userId = getUserId(req)!;
  const m = await getOrgMembership(userId, orgId);
  if (!m) { { res.status(403).json({ error: "Not a member" }); return; } }

  const [post] = await db
    .select({ authorUserId: feedPostsTable.authorUserId })
    .from(feedPostsTable)
    .where(and(eq(feedPostsTable.id, postId), eq(feedPostsTable.organizationId, orgId)));
  if (!post) { { res.status(404).json({ error: "Post not found" }); return; } }

  if (post.authorUserId !== userId && !isAdminRole(m.role)) {
    res.status(403).json({ error: "Not allowed" }); return;
  }

  const { body, privacy } = req.body;
  const updates: { updatedAt: Date; body?: string; privacy?: "all_members" | "followers_only" } = { updatedAt: new Date() };
  if (body?.trim()) updates.body = body.trim();
  if (privacy) updates.privacy = privacy as "all_members" | "followers_only";

  try {
    const [updated] = await db
      .update(feedPostsTable)
      .set(updates)
      .where(eq(feedPostsTable.id, postId))
      .returning();
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to update post" });
  }
});

// ── Delete post ──────────────────────────────────────────────────────────────

router.delete("/posts/:postId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const postId = parseInt(String((req.params as Record<string, string>).postId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const userId = getUserId(req)!;
  const m = await getOrgMembership(userId, orgId);
  if (!m) { { res.status(403).json({ error: "Not a member" }); return; } }

  const [post] = await db
    .select({ authorUserId: feedPostsTable.authorUserId })
    .from(feedPostsTable)
    .where(and(eq(feedPostsTable.id, postId), eq(feedPostsTable.organizationId, orgId)));
  if (!post) { { res.status(404).json({ error: "Post not found" }); return; } }

  if (post.authorUserId !== userId && !isAdminRole(m.role)) {
    res.status(403).json({ error: "Not allowed" }); return;
  }

  try {
    await db.delete(feedPostsTable).where(eq(feedPostsTable.id, postId));
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to delete post" });
  }
});

// ── Pin / unpin post (admin) ─────────────────────────────────────────────────

router.post("/posts/:postId/pin", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const postId = parseInt(String((req.params as Record<string, string>).postId));
  try {
    const [post] = await db
      .select({ isPinned: feedPostsTable.isPinned })
      .from(feedPostsTable)
      .where(and(eq(feedPostsTable.id, postId), eq(feedPostsTable.organizationId, orgId)));
    if (!post) { { res.status(404).json({ error: "Post not found" }); return; } }
    const [updated] = await db
      .update(feedPostsTable)
      .set({ isPinned: !post.isPinned, updatedAt: new Date() })
      .where(eq(feedPostsTable.id, postId))
      .returning();
    res.json({ isPinned: updated.isPinned });
  } catch {
    res.status(500).json({ error: "Failed to toggle pin" });
  }
});

// ── Hide / unhide post (admin moderation) ────────────────────────────────────

router.post("/posts/:postId/hide", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const postId = parseInt(String((req.params as Record<string, string>).postId));
  try {
    const [post] = await db
      .select({ isHidden: feedPostsTable.isHidden })
      .from(feedPostsTable)
      .where(and(eq(feedPostsTable.id, postId), eq(feedPostsTable.organizationId, orgId)));
    if (!post) { { res.status(404).json({ error: "Post not found" }); return; } }
    const [updated] = await db
      .update(feedPostsTable)
      .set({ isHidden: !post.isHidden, updatedAt: new Date() })
      .where(eq(feedPostsTable.id, postId))
      .returning();
    res.json({ isHidden: updated.isHidden });
  } catch {
    res.status(500).json({ error: "Failed to toggle hide" });
  }
});

// ── React (like toggle) ──────────────────────────────────────────────────────

router.post("/posts/:postId/react", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const userId = getUserId(req)!;
  const postId = parseInt(String((req.params as Record<string, string>).postId));

  try {
    const [existing] = await db
      .select({ id: feedReactionsTable.id })
      .from(feedReactionsTable)
      .where(and(eq(feedReactionsTable.postId, postId), eq(feedReactionsTable.userId, userId)))
      .limit(1);

    if (existing) {
      await db.delete(feedReactionsTable).where(eq(feedReactionsTable.id, existing.id));
      await db
        .update(feedPostsTable)
        .set({ reactionsCount: sql`GREATEST(0, ${feedPostsTable.reactionsCount} - 1)` })
        .where(eq(feedPostsTable.id, postId));
      res.json({ reacted: false });
    } else {
      await db.insert(feedReactionsTable).values({ postId, userId, emoji: "👍" }).onConflictDoNothing();
      await db
        .update(feedPostsTable)
        .set({ reactionsCount: sql`${feedPostsTable.reactionsCount} + 1` })
        .where(eq(feedPostsTable.id, postId));
      res.json({ reacted: true });
    }
  } catch (e) {
    console.error("React error:", e);
    res.status(500).json({ error: "Failed to react" });
  }
});

// ── Comments ─────────────────────────────────────────────────────────────────

router.get("/posts/:postId/comments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const postId = parseInt(String((req.params as Record<string, string>).postId));

  try {
    const comments = await db
      .select({
        id: feedCommentsTable.id,
        body: feedCommentsTable.body,
        isHidden: feedCommentsTable.isHidden,
        createdAt: feedCommentsTable.createdAt,
        authorUserId: feedCommentsTable.authorUserId,
        authorDisplayName: appUsersTable.displayName,
        authorUsername: appUsersTable.username,
        authorProfileImage: appUsersTable.profileImage,
      })
      .from(feedCommentsTable)
      .leftJoin(appUsersTable, eq(appUsersTable.id, feedCommentsTable.authorUserId))
      .where(and(eq(feedCommentsTable.postId, postId), eq(feedCommentsTable.isHidden, false)))
      .orderBy(feedCommentsTable.createdAt);

    res.json(comments);
  } catch {
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

router.post("/posts/:postId/comments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const userId = getUserId(req)!;
  const postId = parseInt(String((req.params as Record<string, string>).postId));
  const { body } = req.body;

  if (!body?.trim()) { { res.status(400).json({ error: "Comment body is required" }); return; } }

  try {
    const [comment] = await db
      .insert(feedCommentsTable)
      .values({ postId, authorUserId: userId, body: body.trim() })
      .returning();

    await db
      .update(feedPostsTable)
      .set({ commentsCount: sql`${feedPostsTable.commentsCount} + 1` })
      .where(eq(feedPostsTable.id, postId));

    res.json(comment);
  } catch {
    res.status(500).json({ error: "Failed to add comment" });
  }
});

router.patch("/posts/:postId/comments/:commentId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const userId = getUserId(req)!;
  const commentId = parseInt(String((req.params as Record<string, string>).commentId));
  const m = await getOrgMembership(userId, orgId);
  if (!m) { { res.status(403).json({ error: "Not a member" }); return; } }

  const [comment] = await db
    .select({ authorUserId: feedCommentsTable.authorUserId })
    .from(feedCommentsTable)
    .where(eq(feedCommentsTable.id, commentId));
  if (!comment) { { res.status(404).json({ error: "Comment not found" }); return; } }

  if (comment.authorUserId !== userId && !isAdminRole(m.role)) {
    res.status(403).json({ error: "Not allowed" }); return;
  }

  const { body } = req.body;
  if (!body?.trim()) { { res.status(400).json({ error: "Body required" }); return; } }

  try {
    const [updated] = await db
      .update(feedCommentsTable)
      .set({ body: body.trim(), updatedAt: new Date() })
      .where(eq(feedCommentsTable.id, commentId))
      .returning();
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed to update comment" });
  }
});

router.delete("/posts/:postId/comments/:commentId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const postId = parseInt(String((req.params as Record<string, string>).postId));
  const commentId = parseInt(String((req.params as Record<string, string>).commentId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const userId = getUserId(req)!;
  const m = await getOrgMembership(userId, orgId);
  if (!m) { { res.status(403).json({ error: "Not a member" }); return; } }

  const [comment] = await db
    .select({ authorUserId: feedCommentsTable.authorUserId })
    .from(feedCommentsTable)
    .where(eq(feedCommentsTable.id, commentId));
  if (!comment) { { res.status(404).json({ error: "Comment not found" }); return; } }

  if (comment.authorUserId !== userId && !isAdminRole(m.role)) {
    res.status(403).json({ error: "Not allowed" }); return;
  }

  try {
    await db.delete(feedCommentsTable).where(eq(feedCommentsTable.id, commentId));
    await db
      .update(feedPostsTable)
      .set({ commentsCount: sql`GREATEST(0, ${feedPostsTable.commentsCount} - 1)` })
      .where(eq(feedPostsTable.id, postId));
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to delete comment" });
  }
});

// ── Report post ──────────────────────────────────────────────────────────────

router.post("/posts/:postId/report", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const userId = getUserId(req)!;
  const postId = parseInt(String((req.params as Record<string, string>).postId));
  const { reason = "inappropriate", notes } = req.body;

  try {
    const [report] = await db
      .insert(feedReportsTable)
      .values({ postId, reporterUserId: userId, reason, notes: notes ?? null })
      .returning();
    res.json(report);
  } catch {
    res.status(500).json({ error: "Failed to submit report" });
  }
});

// ── Moderation queue (admin) ─────────────────────────────────────────────────

router.get("/moderation", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    const reports = await db
      .select({
        id: feedReportsTable.id,
        postId: feedReportsTable.postId,
        commentId: feedReportsTable.commentId,
        reason: feedReportsTable.reason,
        notes: feedReportsTable.notes,
        status: feedReportsTable.status,
        createdAt: feedReportsTable.createdAt,
        reporterDisplayName: appUsersTable.displayName,
        reporterUsername: appUsersTable.username,
      })
      .from(feedReportsTable)
      .leftJoin(appUsersTable, eq(appUsersTable.id, feedReportsTable.reporterUserId))
      .where(eq(feedReportsTable.status, "pending"))
      .orderBy(desc(feedReportsTable.createdAt));

    const postIds = [...new Set(reports.filter(r => r.postId).map(r => r.postId!))];
    let posts: { id: number; body: string; isHidden: boolean }[] = [];
    if (postIds.length > 0) {
      posts = await db
        .select({ id: feedPostsTable.id, body: feedPostsTable.body, isHidden: feedPostsTable.isHidden })
        .from(feedPostsTable)
        .where(sql`${feedPostsTable.id} = ANY(ARRAY[${sql.join(postIds.map(id => sql`${id}`), sql`, `)}])`);
    }
    const postMap: Record<number, { id: number; body: string; isHidden: boolean }> = {};
    posts.forEach(p => { postMap[p.id] = p; });

    res.json(reports.map(r => ({
      ...r,
      post: r.postId ? postMap[r.postId] ?? null : null,
    })));
  } catch (e) {
    console.error("Moderation queue error:", e);
    res.status(500).json({ error: "Failed to fetch moderation queue" });
  }
});

router.post("/reports/:reportId/resolve", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const userId = getUserId(req)!;
  const reportId = parseInt(String((req.params as Record<string, string>).reportId));
  const { action = "dismiss" } = req.body;

  try {
    const [report] = await db
      .update(feedReportsTable)
      .set({ status: "resolved", resolvedByUserId: userId, resolvedAt: new Date() })
      .where(eq(feedReportsTable.id, reportId))
      .returning();
    if (!report) { { res.status(404).json({ error: "Report not found" }); return; } }

    if (action === "hide" && report.postId) {
      await db
        .update(feedPostsTable)
        .set({ isHidden: true, updatedAt: new Date() })
        .where(eq(feedPostsTable.id, report.postId));
    }
    if (action === "hide_comment" && report.commentId) {
      await db
        .update(feedCommentsTable)
        .set({ isHidden: true, updatedAt: new Date() })
        .where(eq(feedCommentsTable.id, report.commentId));
    }

    res.json({ success: true, report });
  } catch {
    res.status(500).json({ error: "Failed to resolve report" });
  }
});

// ── Achievement auto-post (internal scoring engine hook) ─────────────────────

router.post("/achievements", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { authorUserId, achievementType, body, taggedCourseId, taggedHoleNumber, taggedRoundId } = req.body;
  if (!achievementType || !body) { { res.status(400).json({ error: "achievementType and body are required" }); return; } }

  try {
    const [post] = await db
      .insert(feedPostsTable)
      .values({
        organizationId: orgId,
        authorUserId: authorUserId ?? null,
        type: "achievement",
        body,
        privacy: "all_members",
        achievementType,
        taggedCourseId: taggedCourseId ?? null,
        taggedHoleNumber: taggedHoleNumber ?? null,
        taggedRoundId: taggedRoundId ?? null,
      })
      .returning();
    res.json(post);
  } catch {
    res.status(500).json({ error: "Failed to create achievement post" });
  }
});

export default router;
