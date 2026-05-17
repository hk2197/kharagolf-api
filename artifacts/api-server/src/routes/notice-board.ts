/**
 * Club Notice Board & Content Management API
 *
 * GET    /organizations/:orgId/notice-board/categories          List categories
 * POST   /organizations/:orgId/notice-board/categories          Create category
 * PATCH  /organizations/:orgId/notice-board/categories/:id      Update category
 * DELETE /organizations/:orgId/notice-board/categories/:id      Delete category
 *
 * GET    /organizations/:orgId/notice-board/articles            List articles (admin)
 * POST   /organizations/:orgId/notice-board/articles            Create article
 * GET    /organizations/:orgId/notice-board/articles/:id        Get article detail
 * PATCH  /organizations/:orgId/notice-board/articles/:id        Update article
 * DELETE /organizations/:orgId/notice-board/articles/:id        Archive article
 * POST   /organizations/:orgId/notice-board/articles/:id/pin    Pin/unpin
 * POST   /organizations/:orgId/notice-board/articles/:id/publish  Publish + push
 * POST   /organizations/:orgId/notice-board/articles/:id/read   Mark as read (member)
 * POST   /organizations/:orgId/notice-board/articles/:id/click  Track sponsor click
 *
 * GET    /organizations/:orgId/notice-board/feed                Member feed (filtered by publish status + unread)
 * GET    /organizations/:orgId/notice-board/unread-count        Unread count for member
 *
 * Public:
 * GET    /public/notice-board/:orgId                            Public feed (published only)
 */

import { Router, type Request, type Response } from "express";
import { db, noticeBoardCategoriesTable, noticeBoardArticlesTable, noticeBoardReadsTable, appUsersTable, orgMembershipsTable, deviceTokensTable } from "@workspace/db";
import { eq, and, desc, inArray, sql, or, lte, isNull, ne } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import { sendTransactionalPush } from "../lib/comms";
import { ObjectStorageService } from "../lib/objectStorage";

const router = Router();

// ── Helpers: typed user resolution (session + portal token) ─────────────────
type PortalReq = { portalUser?: { userId?: number } };

function getUserId(req: Request): number | null {
  if (req.isAuthenticated()) {
    const user = req.user as unknown as { id?: number };
    return user?.id ?? null;
  }
  return (req as unknown as PortalReq).portalUser?.userId ?? null;
}

function requireAuth(req: Request, res: Response): boolean {
  if (!getUserId(req)) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }
  return true;
}

type CategoryUpdate = { name?: string; color?: string; icon?: string; sortOrder?: number };
type ArticleUpdate = {
  title?: string; body?: string; imageUrl?: string | null;
  categoryId?: number | null; isPinned?: boolean; isImportant?: boolean;
  isSponsored?: boolean; sponsorUrl?: string | null;
  publishAt?: Date | null; status?: string;
  publishedAt?: Date; archivedAt?: Date; updatedAt: Date;
};

/** Check that userId is a member of orgId (any role). Returns membership row or null. */
async function getOrgMembership(userId: number, orgId: number) {
  const [row] = await db.select({ role: orgMembershipsTable.role })
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

// ── CATEGORIES ──────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/notice-board/categories", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  try {
    const cats = await db.select().from(noticeBoardCategoriesTable)
      .where(eq(noticeBoardCategoriesTable.organizationId, orgId))
      .orderBy(noticeBoardCategoriesTable.sortOrder, noticeBoardCategoriesTable.name);
    res.json(cats);
  } catch { res.status(500).json({ error: "Failed to fetch categories" }); }
});

router.post("/organizations/:orgId/notice-board/categories", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { name, color = "#C9A84C", icon = "newspaper", sortOrder = 0 } = req.body;
  if (!name) { { res.status(400).json({ error: "Name is required" }); return; } }
  try {
    const [cat] = await db.insert(noticeBoardCategoriesTable)
      .values({ organizationId: orgId, name, color, icon, sortOrder })
      .returning();
    res.json(cat);
  } catch { res.status(500).json({ error: "Failed to create category" }); }
});

router.patch("/organizations/:orgId/notice-board/categories/:catId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const catId = parseInt(String((req.params as Record<string, string>).catId));
  const { name, color, icon, sortOrder } = req.body;
  const updates: CategoryUpdate = {};
  if (name !== undefined) updates.name = name;
  if (color !== undefined) updates.color = color;
  if (icon !== undefined) updates.icon = icon;
  if (sortOrder !== undefined) updates.sortOrder = sortOrder;
  try {
    const [cat] = await db.update(noticeBoardCategoriesTable)
      .set(updates)
      .where(and(eq(noticeBoardCategoriesTable.id, catId), eq(noticeBoardCategoriesTable.organizationId, orgId)))
      .returning();
    if (!cat) { { res.status(404).json({ error: "Category not found" }); return; } }
    res.json(cat);
  } catch { res.status(500).json({ error: "Failed to update category" }); }
});

router.delete("/organizations/:orgId/notice-board/categories/:catId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const catId = parseInt(String((req.params as Record<string, string>).catId));
  try {
    await db.delete(noticeBoardCategoriesTable)
      .where(and(eq(noticeBoardCategoriesTable.id, catId), eq(noticeBoardCategoriesTable.organizationId, orgId)));
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to delete category" }); }
});

// ── ARTICLES (Admin) ────────────────────────────────────────────────────────

router.get("/organizations/:orgId/notice-board/articles", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { status, categoryId } = req.query;
  try {
    let query = db.select({
      id: noticeBoardArticlesTable.id,
      title: noticeBoardArticlesTable.title,
      body: noticeBoardArticlesTable.body,
      imageUrl: noticeBoardArticlesTable.imageUrl,
      isPinned: noticeBoardArticlesTable.isPinned,
      isImportant: noticeBoardArticlesTable.isImportant,
      isSponsored: noticeBoardArticlesTable.isSponsored,
      sponsorUrl: noticeBoardArticlesTable.sponsorUrl,
      status: noticeBoardArticlesTable.status,
      publishAt: noticeBoardArticlesTable.publishAt,
      publishedAt: noticeBoardArticlesTable.publishedAt,
      authorName: noticeBoardArticlesTable.authorName,
      viewCount: noticeBoardArticlesTable.viewCount,
      clickCount: noticeBoardArticlesTable.clickCount,
      categoryId: noticeBoardArticlesTable.categoryId,
      categoryName: noticeBoardCategoriesTable.name,
      categoryColor: noticeBoardCategoriesTable.color,
      createdAt: noticeBoardArticlesTable.createdAt,
      updatedAt: noticeBoardArticlesTable.updatedAt,
    })
    .from(noticeBoardArticlesTable)
    .leftJoin(noticeBoardCategoriesTable, eq(noticeBoardCategoriesTable.id, noticeBoardArticlesTable.categoryId))
    .where(eq(noticeBoardArticlesTable.organizationId, orgId))
    .orderBy(desc(noticeBoardArticlesTable.isPinned), desc(noticeBoardArticlesTable.updatedAt));

    const articles = await query;

    // Filter by status/category in JS to avoid dynamic query complexity
    let filtered = articles;
    if (status) filtered = filtered.filter(a => a.status === status);
    if (categoryId) filtered = filtered.filter(a => a.categoryId === parseInt(categoryId as string));

    res.json(filtered);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch articles" }); }
});

router.post("/organizations/:orgId/notice-board/articles", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const userId = getUserId(req);
  const { title, body, imageUrl, categoryId, isPinned = false, isImportant = false, isSponsored = false, sponsorUrl, publishAt, status = "draft", authorName } = req.body;
  if (!title || !body) { { res.status(400).json({ error: "Title and body are required" }); return; } }
  try {
    const user = userId ? await db.select({ displayName: appUsersTable.displayName }).from(appUsersTable).where(eq(appUsersTable.id, userId)).then(r => r[0]) : null;
    const authorDisplayName = authorName || (user?.displayName ?? "Club");
    const [article] = await db.insert(noticeBoardArticlesTable).values({
      organizationId: orgId,
      categoryId: categoryId ?? null,
      title,
      body,
      imageUrl: imageUrl ?? null,
      isPinned,
      isImportant,
      isSponsored,
      sponsorUrl: sponsorUrl ?? null,
      publishAt: publishAt ? new Date(publishAt) : null,
      status,
      publishedAt: status === "published" ? new Date() : null,
      authorUserId: userId,
      authorName: authorDisplayName,
    }).returning();
    res.json(article);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to create article" }); }
});

router.get("/organizations/:orgId/notice-board/articles/:articleId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const articleId = parseInt(String((req.params as Record<string, string>).articleId));
  if (!requireAuth(req, res)) return;
  const userId = getUserId(req)!;
  const now = new Date();
  try {
    const [article] = await db.select().from(noticeBoardArticlesTable)
      .where(and(eq(noticeBoardArticlesTable.id, articleId), eq(noticeBoardArticlesTable.organizationId, orgId)));
    if (!article) { { res.status(404).json({ error: "Article not found" }); return; } }

    // Enforce org membership — non-members cannot read any article
    const membership = await getOrgMembership(userId, orgId);
    if (!membership) { { res.status(403).json({ error: "Not a member of this organisation" }); return; } }
    const isAdmin = membership.role === "org_admin" || membership.role === "tournament_director";

    // Non-admins can only view published articles or scheduled articles past their publishAt
    if (!isAdmin) {
      const isVisible =
        article.status === "published" ||
        (article.status === "scheduled" && article.publishAt != null && new Date(article.publishAt) <= now);
      if (!isVisible) { { res.status(404).json({ error: "Article not found" }); return; } }
    }

    // Increment view count
    await db.update(noticeBoardArticlesTable)
      .set({ viewCount: sql`${noticeBoardArticlesTable.viewCount} + 1` })
      .where(eq(noticeBoardArticlesTable.id, articleId));

    // Mark as read
    await db.insert(noticeBoardReadsTable)
      .values({ articleId, userId })
      .onConflictDoNothing({ target: [noticeBoardReadsTable.articleId, noticeBoardReadsTable.userId] });

    const [category] = article.categoryId
      ? await db.select().from(noticeBoardCategoriesTable).where(eq(noticeBoardCategoriesTable.id, article.categoryId))
      : [null];

    res.json({ ...article, viewCount: (article.viewCount ?? 0) + 1, category });
  } catch { res.status(500).json({ error: "Failed to fetch article" }); }
});

router.patch("/organizations/:orgId/notice-board/articles/:articleId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const articleId = parseInt(String((req.params as Record<string, string>).articleId));
  const { title, body, imageUrl, categoryId, isPinned, isImportant, isSponsored, sponsorUrl, publishAt, status } = req.body;
  const updates: ArticleUpdate = { updatedAt: new Date() };
  if (title !== undefined) updates.title = title;
  if (body !== undefined) updates.body = body;
  if (imageUrl !== undefined) updates.imageUrl = imageUrl ?? null;
  if (categoryId !== undefined) updates.categoryId = categoryId ?? null;
  if (isPinned !== undefined) updates.isPinned = isPinned;
  if (isImportant !== undefined) updates.isImportant = isImportant;
  if (isSponsored !== undefined) updates.isSponsored = isSponsored;
  if (sponsorUrl !== undefined) updates.sponsorUrl = sponsorUrl ?? null;
  if (publishAt !== undefined) updates.publishAt = publishAt ? new Date(publishAt) : null;
  if (status !== undefined) {
    updates.status = status;
    if (status === "published") updates.publishedAt = new Date();
    if (status === "archived") updates.archivedAt = new Date();
  }
  try {
    const [article] = await db.update(noticeBoardArticlesTable)
      .set(updates as unknown as Record<string, never>)
      .where(and(eq(noticeBoardArticlesTable.id, articleId), eq(noticeBoardArticlesTable.organizationId, orgId)))
      .returning();
    if (!article) { { res.status(404).json({ error: "Article not found" }); return; } }
    res.json(article);
  } catch { res.status(500).json({ error: "Failed to update article" }); }
});

router.delete("/organizations/:orgId/notice-board/articles/:articleId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const articleId = parseInt(String((req.params as Record<string, string>).articleId));
  try {
    await db.update(noticeBoardArticlesTable)
      .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(noticeBoardArticlesTable.id, articleId), eq(noticeBoardArticlesTable.organizationId, orgId)));
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to archive article" }); }
});

// PIN / UNPIN
router.post("/organizations/:orgId/notice-board/articles/:articleId/pin", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const articleId = parseInt(String((req.params as Record<string, string>).articleId));
  try {
    const [article] = await db.select({ isPinned: noticeBoardArticlesTable.isPinned })
      .from(noticeBoardArticlesTable)
      .where(and(eq(noticeBoardArticlesTable.id, articleId), eq(noticeBoardArticlesTable.organizationId, orgId)));
    if (!article) { { res.status(404).json({ error: "Article not found" }); return; } }
    const [updated] = await db.update(noticeBoardArticlesTable)
      .set({ isPinned: !article.isPinned, updatedAt: new Date() })
      .where(eq(noticeBoardArticlesTable.id, articleId))
      .returning();
    res.json({ isPinned: updated.isPinned });
  } catch { res.status(500).json({ error: "Failed to toggle pin" }); }
});

// PUBLISH (admin-triggered, with push notification)
router.post("/organizations/:orgId/notice-board/articles/:articleId/publish", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const articleId = parseInt(String((req.params as Record<string, string>).articleId));
  const { sendPush = false } = req.body;
  try {
    const [article] = await db.update(noticeBoardArticlesTable)
      .set({ status: "published", publishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(noticeBoardArticlesTable.id, articleId), eq(noticeBoardArticlesTable.organizationId, orgId)))
      .returning();
    if (!article) { { res.status(404).json({ error: "Article not found" }); return; } }

    // Send push notification if requested and not already sent
    if (sendPush && !article.notificationSent) {
      try {
        // Get all org members' user IDs
        const members = await db.select({ userId: orgMembershipsTable.userId })
          .from(orgMembershipsTable)
          .where(eq(orgMembershipsTable.organizationId, orgId));
        const userIds = members.map(m => m.userId);
        if (userIds.length > 0) {
          // Task #1240 — fire-and-forget broadcast: PushDeliveryResult is
          // discarded (only throws are caught), so no `classifyPushDelivery`
          // mapping is needed. Members without an Expo token quietly miss
          // the push; the article itself remains in the in-app notice board.
          await sendTransactionalPush(
            userIds,
            article.isImportant ? `📌 ${article.title}` : article.title,
            article.body.slice(0, 120) + (article.body.length > 120 ? "…" : ""),
            { type: "notice_board", articleId, orgId }
          );
          await db.update(noticeBoardArticlesTable)
            .set({ notificationSent: true })
            .where(eq(noticeBoardArticlesTable.id, articleId));
        }
      } catch (e) { console.error("Push failed:", e); }
    }

    res.json({ success: true, article });
  } catch { res.status(500).json({ error: "Failed to publish article" }); }
});

// ATTACHMENTS — add/remove file references on an article (admin only)
router.post("/organizations/:orgId/notice-board/articles/:articleId/attachments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const articleId = parseInt(String((req.params as Record<string, string>).articleId));
  const { name, url, type = "file" } = req.body;
  if (!name || !url) { { res.status(400).json({ error: "name and url are required" }); return; } }
  try {
    const [article] = await db.select({ attachments: noticeBoardArticlesTable.attachments })
      .from(noticeBoardArticlesTable)
      .where(and(eq(noticeBoardArticlesTable.id, articleId), eq(noticeBoardArticlesTable.organizationId, orgId)));
    if (!article) { { res.status(404).json({ error: "Article not found" }); return; } }
    const existing = (article.attachments ?? []) as { name: string; url: string; type: string }[];
    const updated = [...existing, { name: String(name), url: String(url), type: String(type) }];
    await db.update(noticeBoardArticlesTable)
      .set({ attachments: updated, updatedAt: new Date() })
      .where(eq(noticeBoardArticlesTable.id, articleId));
    res.json({ success: true, attachments: updated });
  } catch { res.status(500).json({ error: "Failed to add attachment" }); }
});

router.delete("/organizations/:orgId/notice-board/articles/:articleId/attachments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const articleId = parseInt(String((req.params as Record<string, string>).articleId));
  const { url } = req.body;
  if (!url) { { res.status(400).json({ error: "url is required" }); return; } }
  try {
    const [article] = await db.select({ attachments: noticeBoardArticlesTable.attachments })
      .from(noticeBoardArticlesTable)
      .where(and(eq(noticeBoardArticlesTable.id, articleId), eq(noticeBoardArticlesTable.organizationId, orgId)));
    if (!article) { { res.status(404).json({ error: "Article not found" }); return; } }
    const existing = (article.attachments ?? []) as { name: string; url: string; type: string }[];
    const updated = existing.filter(a => a.url !== url);
    await db.update(noticeBoardArticlesTable)
      .set({ attachments: updated, updatedAt: new Date() })
      .where(eq(noticeBoardArticlesTable.id, articleId));
    res.json({ success: true, attachments: updated });
  } catch { res.status(500).json({ error: "Failed to remove attachment" }); }
});

// MARK AS READ (member)
router.post("/organizations/:orgId/notice-board/articles/:articleId/read", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const userId = getUserId(req)!;
  const articleId = parseInt(String((req.params as Record<string, string>).articleId));
  try {
    const [article] = await db.select({ id: noticeBoardArticlesTable.id })
      .from(noticeBoardArticlesTable)
      .where(and(eq(noticeBoardArticlesTable.id, articleId), eq(noticeBoardArticlesTable.organizationId, orgId)))
      .limit(1);
    if (!article) { { res.status(404).json({ error: "Article not found" }); return; } }
    await db.insert(noticeBoardReadsTable)
      .values({ articleId, userId })
      .onConflictDoNothing({ target: [noticeBoardReadsTable.articleId, noticeBoardReadsTable.userId] });
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to mark as read" }); }
});

// TRACK SPONSOR CLICK
router.post("/organizations/:orgId/notice-board/articles/:articleId/click", async (req: Request, res: Response) => {
  const articleId = parseInt(String((req.params as Record<string, string>).articleId));
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  try {
    const [article] = await db.select({ sponsorUrl: noticeBoardArticlesTable.sponsorUrl }).from(noticeBoardArticlesTable)
      .where(and(eq(noticeBoardArticlesTable.id, articleId), eq(noticeBoardArticlesTable.organizationId, orgId)));
    if (!article) { { res.status(404).json({ error: "Article not found" }); return; } }
    await db.update(noticeBoardArticlesTable)
      .set({ clickCount: sql`${noticeBoardArticlesTable.clickCount} + 1` })
      .where(and(eq(noticeBoardArticlesTable.id, articleId), eq(noticeBoardArticlesTable.organizationId, orgId)));
    res.json({ success: true, redirectUrl: article.sponsorUrl ?? null });
  } catch { res.status(500).json({ error: "Failed to track click" }); }
});

// ── MEMBER FEED ─────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/notice-board/feed", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const userId = getUserId(req)!;
  const { search } = req.query;
  const now = new Date();
  try {
    const articles = await db.select({
      id: noticeBoardArticlesTable.id,
      title: noticeBoardArticlesTable.title,
      body: noticeBoardArticlesTable.body,
      imageUrl: noticeBoardArticlesTable.imageUrl,
      isPinned: noticeBoardArticlesTable.isPinned,
      isImportant: noticeBoardArticlesTable.isImportant,
      isSponsored: noticeBoardArticlesTable.isSponsored,
      sponsorUrl: noticeBoardArticlesTable.sponsorUrl,
      publishedAt: noticeBoardArticlesTable.publishedAt,
      authorName: noticeBoardArticlesTable.authorName,
      attachments: noticeBoardArticlesTable.attachments,
      viewCount: noticeBoardArticlesTable.viewCount,
      categoryId: noticeBoardArticlesTable.categoryId,
      categoryName: noticeBoardCategoriesTable.name,
      categoryColor: noticeBoardCategoriesTable.color,
      categoryIcon: noticeBoardCategoriesTable.icon,
    })
    .from(noticeBoardArticlesTable)
    .leftJoin(noticeBoardCategoriesTable, eq(noticeBoardCategoriesTable.id, noticeBoardArticlesTable.categoryId))
    .where(and(
      eq(noticeBoardArticlesTable.organizationId, orgId),
      or(
        eq(noticeBoardArticlesTable.status, "published"),
        and(
          eq(noticeBoardArticlesTable.status, "scheduled"),
          lte(noticeBoardArticlesTable.publishAt, now),
        ),
      ),
    ))
    .orderBy(desc(noticeBoardArticlesTable.isPinned), desc(noticeBoardArticlesTable.publishedAt));

    // Apply search filter
    let filtered = articles;
    if (search) {
      const q = (search as string).toLowerCase();
      filtered = filtered.filter(a => a.title.toLowerCase().includes(q) || a.body.toLowerCase().includes(q));
    }

    // Fetch read status for the user
    let readArticleIds = new Set<number>();
    if (userId) {
      const reads = await db.select({ articleId: noticeBoardReadsTable.articleId })
        .from(noticeBoardReadsTable)
        .where(eq(noticeBoardReadsTable.userId, userId));
      readArticleIds = new Set(reads.map(r => r.articleId));
    }

    const result = filtered.map(a => ({ ...a, isRead: readArticleIds.has(a.id) }));
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: "Failed to fetch feed" }); }
});

// UNREAD COUNT
router.get("/organizations/:orgId/notice-board/unread-count", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const userId = getUserId(req)!;
  const now = new Date();
  try {
    const [{ count }] = await db.select({ count: sql<number>`count(*)` })
      .from(noticeBoardArticlesTable)
      .where(and(
        eq(noticeBoardArticlesTable.organizationId, orgId),
        or(
          eq(noticeBoardArticlesTable.status, "published"),
          and(
            eq(noticeBoardArticlesTable.status, "scheduled"),
            lte(noticeBoardArticlesTable.publishAt, now),
          ),
        ),
        sql`${noticeBoardArticlesTable.id} NOT IN (
          SELECT article_id FROM notice_board_reads WHERE user_id = ${userId}
        )`
      ));
    res.json({ count: Number(count) });
  } catch { res.json({ count: 0 }); }
});

// ── Upload URL for notice-board images / attachments ────────────────────────
// POST /organizations/:orgId/notice-board/upload-url
// Returns { uploadUrl, objectUrl } — client PUTs file to uploadUrl, then uses objectUrl
router.post("/organizations/:orgId/notice-board/upload-url", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { contentType = "application/octet-stream" } = req.body as { contentType?: string };
  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
  if (!allowed.includes(contentType)) {
    res.status(400).json({ error: "Unsupported content type" });
    return;
  }

  try {
    const storageService = new ObjectStorageService();
    const signedUrl = await storageService.getObjectEntityUploadURL();
    // normalizeObjectEntityPath converts GCS signed URL → canonical /objects/uploads/<uuid>
    const objectPath = storageService.normalizeObjectEntityPath(signedUrl);
    // Derive the suffix after /objects/ for the org-scoped serving route
    const suffix = objectPath.startsWith("/objects/") ? objectPath.slice("/objects/".length) : objectPath;
    const objectUrl = `/api/organizations/${orgId}/notice-board/objects/${suffix}`;
    res.json({ uploadUrl: signedUrl, objectUrl });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Storage error: ${msg}` });
  }
});

// GET /organizations/:orgId/notice-board/objects/{*objectPath}
// Serve notice-board uploaded files without requiring media-table registration
router.get("/organizations/:orgId/notice-board/objects/{*objectPath}", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  if (!await requireOrgMember(req, res, orgId)) return;
  const rawPath = (req.params as Record<string, string>).objectPath ?? "";
  const canonicalPath = `/objects/${rawPath}`;
  try {
    const storageService = new ObjectStorageService();
    const file = await storageService.getObjectEntityFile(canonicalPath);
    const response = await storageService.downloadObject(file, 3600);
    const ct = response.headers.get("content-type") ?? "application/octet-stream";
    const cc = response.headers.get("cache-control") ?? "private, max-age=3600";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", cc);
    const cl = response.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);
    const body = response.body;
    if (body) {
      const reader = body.getReader();
      const pump = async () => {
        const { done, value } = await reader.read();
        if (done) { { res.end(); return; } }
        res.write(Buffer.from(value));
        await pump();
      };
      await pump();
    } else {
      res.end();
    }
  } catch {
    res.status(404).json({ error: "Object not found" });
  }
});

// ── Member feed (org-scoped, authenticated) ───────────────────────────────────
// GET /organizations/:orgId/notice-board/public — Published articles for org members
router.get("/organizations/:orgId/notice-board/public", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid org" }); return; } }
  if (!await requireOrgMember(req, res, orgId)) return;
  try {
    const now = new Date();
    const articles = await db
      .select({
        id: noticeBoardArticlesTable.id,
        title: noticeBoardArticlesTable.title,
        body: noticeBoardArticlesTable.body,
        imageUrl: noticeBoardArticlesTable.imageUrl,
        isPinned: noticeBoardArticlesTable.isPinned,
        isImportant: noticeBoardArticlesTable.isImportant,
        isSponsored: noticeBoardArticlesTable.isSponsored,
        sponsorUrl: noticeBoardArticlesTable.sponsorUrl,
        publishAt: noticeBoardArticlesTable.publishAt,
        publishedAt: noticeBoardArticlesTable.publishedAt,
        viewCount: noticeBoardArticlesTable.viewCount,
        attachments: noticeBoardArticlesTable.attachments,
      })
      .from(noticeBoardArticlesTable)
      .where(and(
        eq(noticeBoardArticlesTable.organizationId, orgId),
        or(
          eq(noticeBoardArticlesTable.status, "published"),
          and(
            eq(noticeBoardArticlesTable.status, "scheduled"),
            lte(noticeBoardArticlesTable.publishAt, now),
          ),
        ),
      ))
      .orderBy(desc(noticeBoardArticlesTable.isPinned), desc(noticeBoardArticlesTable.publishedAt))
      .limit(50);
    res.json(articles);
  } catch (err: unknown) {
    res.status(500).json({ error: "Failed to load notice feed" });
  }
});

export default router;
