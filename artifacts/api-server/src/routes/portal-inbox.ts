/**
 * Task #2159 — Generic per-user in-app notification inbox.
 *
 * Routes:
 *   GET  /api/portal/inbox/notifications           — paginated list + unread count
 *   POST /api/portal/inbox/notifications/:id/read  — mark a single row read
 *   POST /api/portal/inbox/notifications/read-all  — mark every unread row read
 *
 * Mirrors the cursor-pagination contract used by the handicap-case
 * notifications endpoint (`/api/portal/handicap/notifications`) so the
 * web inbox page can pull from both feeds with the same shape and
 * merge them client-side.
 *
 * The web header notification bell sums the unread count from this
 * endpoint with the handicap one so a new follower lights up the bell
 * for players who have no committee activity.
 */
import { Router, type Request, type Response } from "express";
import { and, count, desc, eq, lt, sql } from "drizzle-orm";
import { db, userInboxNotificationsTable } from "@workspace/db";

const router: Router = Router();

/**
 * GET /portal/inbox/notifications
 *
 * Query params:
 *   - `limit`  page size (default 25, cap 100)
 *   - `before` id cursor — returns rows with `id < before` (older)
 *   - `unread` "1" | "true" → only return unread rows (used by the
 *              header bell badge query)
 *
 * Response:
 *   {
 *     unreadCount: number,
 *     items: Array<{
 *       id, notificationKey, title, body, payload,
 *       createdAt, readAt, deepLink
 *     }>,
 *     nextCursor: number | null,
 *   }
 */
router.get("/portal/inbox/notifications", async (req: Request, res: Response) => {
  if (!req.user?.id) { res.status(401).json({ error: "Authentication required" }); return; }
  const requestedLimit = parseInt(String(req.query.limit ?? "25"), 10) || 25;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  const onlyUnread = req.query.unread === "1" || req.query.unread === "true";
  const beforeRaw = req.query.before;
  const beforeId = typeof beforeRaw === "string" && /^\d+$/.test(beforeRaw)
    ? parseInt(beforeRaw, 10)
    : null;

  const filters = [eq(userInboxNotificationsTable.userId, req.user.id)];
  if (onlyUnread) {
    filters.push(sql`${userInboxNotificationsTable.readAt} IS NULL`);
  }
  if (beforeId !== null) {
    filters.push(lt(userInboxNotificationsTable.id, beforeId));
  }

  const rows = await db.select()
    .from(userInboxNotificationsTable)
    .where(and(...filters))
    .orderBy(desc(userInboxNotificationsTable.createdAt), desc(userInboxNotificationsTable.id))
    .limit(limit);

  // Unread count is independent of the cursor — the bell badge needs
  // the user-wide total regardless of which page is loaded.
  const [unreadRow] = await db.select({ n: count() })
    .from(userInboxNotificationsTable)
    .where(and(
      eq(userInboxNotificationsTable.userId, req.user.id),
      sql`${userInboxNotificationsTable.readAt} IS NULL`,
    ));

  const items = rows.map(r => ({
    id: r.id,
    notificationKey: r.notificationKey,
    title: r.title,
    body: r.body,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
    readAt: r.readAt?.toISOString() ?? null,
    // Conventional payload field; if absent the UI falls back to a
    // per-key default so a malformed inserter can't break navigation.
    deepLink: (r.payload && typeof (r.payload as { deepLink?: unknown }).deepLink === "string"
      ? (r.payload as { deepLink: string }).deepLink
      : null),
  }));

  const nextCursor = items.length === limit && items.length > 0
    ? items[items.length - 1].id
    : null;

  res.json({
    unreadCount: Number(unreadRow?.n ?? 0),
    items,
    nextCursor,
  });
});

/**
 * POST /portal/inbox/notifications/:id/read — mark a single row read.
 * Idempotent: re-marking an already-read row is a no-op (returns
 * `updated: 0`).
 */
router.post("/portal/inbox/notifications/:id/read", async (req: Request, res: Response) => {
  if (!req.user?.id) { res.status(401).json({ error: "Authentication required" }); return; }
  const id = parseInt(String((req.params as Record<string, string>).id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "id required" }); return; }
  const result = await db.update(userInboxNotificationsTable)
    .set({ readAt: new Date() })
    .where(and(
      eq(userInboxNotificationsTable.id, id),
      eq(userInboxNotificationsTable.userId, req.user.id),
      sql`${userInboxNotificationsTable.readAt} IS NULL`,
    ))
    .returning({ id: userInboxNotificationsTable.id });
  res.json({ success: true, updated: result.length });
});

/** POST /portal/inbox/notifications/read-all — mark every unread row read. */
router.post("/portal/inbox/notifications/read-all", async (req: Request, res: Response) => {
  if (!req.user?.id) { res.status(401).json({ error: "Authentication required" }); return; }
  const result = await db.update(userInboxNotificationsTable)
    .set({ readAt: new Date() })
    .where(and(
      eq(userInboxNotificationsTable.userId, req.user.id),
      sql`${userInboxNotificationsTable.readAt} IS NULL`,
    ))
    .returning({ id: userInboxNotificationsTable.id });
  res.json({ success: true, updated: result.length });
});

export default router;
