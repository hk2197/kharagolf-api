import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { chatRoomsTable, chatMessagesTable, playersTable, tournamentsTable, leaguesTable, leagueMembersTable, mediaTable } from "@workspace/db";
import { and, eq, inArray, lt, asc, desc } from "drizzle-orm";
import { broadcastChatMessage, broadcastChatDeletion, broadcastChatCleared } from "../lib/realtime";

const router: IRouter = Router();

function isAdmin(role?: string) {
  return ["super_admin", "org_admin", "tournament_director"].includes(role ?? "");
}

function userFromReq(req: Request) {
  return req.user as { id?: number; role?: string; organizationId?: number; displayName?: string; username?: string } | undefined;
}

function hasOrgAccess(caller: ReturnType<typeof userFromReq>, orgId: number): boolean {
  if (!caller?.id) return false;
  return caller.role === "super_admin" || caller.organizationId === orgId;
}

function hasOrgAdminAccess(caller: ReturnType<typeof userFromReq>, orgId: number): boolean {
  if (!caller?.id) return false;
  if (!isAdmin(caller.role)) return false;
  return caller.role === "super_admin" || caller.organizationId === orgId;
}

async function isLeagueMember(userId: number, leagueId: number): Promise<boolean> {
  const [m] = await db
    .select({ id: leagueMembersTable.id })
    .from(leagueMembersTable)
    .where(and(eq(leagueMembersTable.leagueId, leagueId), eq(leagueMembersTable.userId, userId)))
    .limit(1);
  return !!m;
}

async function canAccessChat(
  caller: ReturnType<typeof userFromReq>,
  orgId: number,
  type: string,
  eId: number,
): Promise<boolean> {
  if (!caller?.id) return false;
  // Only org admins bypass the entity-membership requirement
  if (hasOrgAdminAccess(caller, orgId)) return true;
  if (type === "tournament") {
    const [p] = await db
      .select({ id: playersTable.id })
      .from(playersTable)
      .where(and(eq(playersTable.tournamentId, eId), eq(playersTable.userId, caller.id)))
      .limit(1);
    return !!p;
  }
  if (type === "league") {
    return isLeagueMember(caller.id, eId);
  }
  return false;
}

async function validateEntityOwnership(orgId: number, type: string, entityId: number): Promise<boolean> {
  if (type === "tournament") {
    const [t] = await db
      .select({ id: tournamentsTable.id })
      .from(tournamentsTable)
      .where(and(eq(tournamentsTable.id, entityId), eq(tournamentsTable.organizationId, orgId)))
      .limit(1);
    return !!t;
  }
  if (type === "league") {
    const [l] = await db
      .select({ id: leaguesTable.id })
      .from(leaguesTable)
      .where(and(eq(leaguesTable.id, entityId), eq(leaguesTable.organizationId, orgId)))
      .limit(1);
    return !!l;
  }
  return false;
}

async function getRoom(orgId: number, type: string, entityId: number): Promise<typeof chatRoomsTable.$inferSelect | null> {
  const [room] = await db
    .select()
    .from(chatRoomsTable)
    .where(and(
      eq(chatRoomsTable.organizationId, orgId),
      eq(chatRoomsTable.type, type),
      eq(chatRoomsTable.entityId, entityId),
    ));
  return room ?? null;
}

async function getOrCreateRoom(orgId: number, type: string, entityId: number): Promise<typeof chatRoomsTable.$inferSelect> {
  const existing = await getRoom(orgId, type, entityId);
  if (existing) return existing;

  const [created] = await db.insert(chatRoomsTable).values({
    organizationId: orgId,
    type,
    entityId,
    enabled: false,
  }).returning();
  return created;
}

/** For gallery-share messages, attach mediaThumbnailPath and mediaObjectPath from the media table */
async function enrichGalleryShareMessages<T extends { messageType: string | null; mediaId: number | null }>(
  messages: T[]
): Promise<(T & { mediaThumbnailPath?: string | null; mediaObjectPath?: string | null })[]> {
  const shareIds = messages.filter(m => m.messageType === "gallery-share" && m.mediaId).map(m => m.mediaId!);
  if (shareIds.length === 0) return messages;

  const mediaRows = await db
    .select({ id: mediaTable.id, thumbnailPath: mediaTable.thumbnailPath, objectPath: mediaTable.objectPath })
    .from(mediaTable)
    .where(inArray(mediaTable.id, shareIds));

  const byId = new Map(mediaRows.map(r => [r.id, r]));
  return messages.map(m => {
    if (m.messageType === "gallery-share" && m.mediaId) {
      const media = byId.get(m.mediaId);
      return { ...m, mediaThumbnailPath: media?.thumbnailPath ?? null, mediaObjectPath: media?.objectPath ?? null };
    }
    return m;
  });
}

// GET /api/organizations/:orgId/chat/:type/:entityId
// Returns room info (creating if needed) + recent messages
// Org members OR registered tournament players can access
router.get("/organizations/:orgId/chat/:type/:entityId", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { type, entityId } = (req.params as Record<string, string>);
  const eId = parseInt(entityId);

  if (isNaN(orgId) || isNaN(eId)) { { res.status(400).json({ error: "Invalid params" }); return; } }
  if (!caller?.id) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  if (!await canAccessChat(caller, orgId, type, eId)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const owned = await validateEntityOwnership(orgId, type, eId);
  if (!owned) { { res.status(404).json({ error: "Entity not found in this organization" }); return; } }

  const room = await getOrCreateRoom(orgId, type, eId);

  const allMessages = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.roomId, room.id))
    .orderBy(asc(chatMessagesTable.createdAt))
    .limit(100);

  // Filter muted users' messages (admins see all)
  const mutedIds = Array.isArray(room.mutedUserIds) ? room.mutedUserIds : [];
  const callerIsAdmin = hasOrgAdminAccess(caller, orgId);
  const messages = callerIsAdmin
    ? allMessages
    : allMessages.filter(m => !m.userId || !mutedIds.includes(m.userId));

  // Enrich gallery-share messages with media thumbnail/object paths for rich rendering
  const enriched = await enrichGalleryShareMessages(messages);
  res.json({ room, messages: enriched });
});

// GET /api/organizations/:orgId/chat/:type/:entityId/messages
// Paginated chat history: ?cursor=<last_msg_id>&limit=<1-100>
router.get("/organizations/:orgId/chat/:type/:entityId/messages", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { type, entityId } = (req.params as Record<string, string>);
  const eId = parseInt(entityId);

  if (isNaN(orgId) || isNaN(eId)) { { res.status(400).json({ error: "Invalid params" }); return; } }
  if (!caller?.id) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  if (!await canAccessChat(caller, orgId, type, eId)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const pageLimit = Math.min(Math.max(parseInt(req.query.limit as string ?? "50"), 1), 100);
  const cursor = req.query.cursor ? parseInt(req.query.cursor as string) : null;

  const room = await getRoom(orgId, type, eId);
  if (!room) { { res.json({ messages: [], nextCursor: null }); return; } }

  const conditions = [eq(chatMessagesTable.roomId, room.id), ...(cursor && !isNaN(cursor) ? [lt(chatMessagesTable.id, cursor)] : [])];

  const rows = await db
    .select()
    .from(chatMessagesTable)
    .where(and(...conditions))
    .orderBy(desc(chatMessagesTable.id))
    .limit(pageLimit + 1);

  const hasMore = rows.length > pageLimit;
  const page = rows.slice(0, pageLimit);
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  const mutedIds = Array.isArray(room.mutedUserIds) ? room.mutedUserIds : [];
  const callerIsAdmin = hasOrgAdminAccess(caller, orgId);
  const filtered = callerIsAdmin
    ? page
    : page.filter(m => !m.userId || !mutedIds.includes(m.userId));

  const enriched = await enrichGalleryShareMessages(filtered.reverse());
  res.json({ messages: enriched, nextCursor });
});

// POST /api/organizations/:orgId/chat/:type/:entityId/messages
// Org admins or registered tournament players/league members can post
router.post("/organizations/:orgId/chat/:type/:entityId/messages", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { type, entityId } = (req.params as Record<string, string>);
  const eId = parseInt(entityId);

  if (isNaN(orgId) || isNaN(eId)) { { res.status(400).json({ error: "Invalid params" }); return; } }
  if (!caller?.id) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  if (!await canAccessChat(caller, orgId, type, eId)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const { body, messageType = "text", mediaId } = req.body;
  if (!body || typeof body !== "string" || body.trim().length === 0) {
    res.status(400).json({ error: "Message body required" }); return;
  }
  if (body.length > 1000) { { res.status(400).json({ error: "Message too long" }); return; } }

  const validTypes = ["text", "gallery-share"];
  if (!validTypes.includes(messageType)) { { res.status(400).json({ error: "Invalid messageType" }); return; } }

  const room = await getRoom(orgId, type, eId);
  if (!room) { { res.status(404).json({ error: "Chat room not found or not enabled" }); return; } }
  if (!room.enabled) { { res.status(403).json({ error: "Chat is disabled for this room" }); return; } }

  // Block muted users from posting
  const mutedIds = Array.isArray(room.mutedUserIds) ? room.mutedUserIds : [];
  if (caller.id && mutedIds.includes(caller.id)) {
    res.status(403).json({ error: "You have been muted in this chat room" }); return;
  }

  // Validate mediaId belongs to the same org if this is a gallery-share
  let resolvedMediaId: number | null = null;
  if (messageType === "gallery-share" && mediaId) {
    const mId = parseInt(mediaId);
    if (!isNaN(mId)) {
      const [mItem] = await db
        .select({ id: mediaTable.id })
        .from(mediaTable)
        .where(and(eq(mediaTable.id, mId), eq(mediaTable.organizationId, orgId)))
        .limit(1);
      resolvedMediaId = mItem ? mItem.id : null;
    }
  }

  const displayName = caller.displayName || caller.username || "Anonymous";

  const [msg] = await db.insert(chatMessagesTable).values({
    roomId: room.id,
    userId: caller.id,
    displayName,
    body: body.trim(),
    messageType,
    mediaId: resolvedMediaId,
    isPinned: false,
  }).returning();

  broadcastChatMessage(room.id, msg);

  res.status(201).json(msg);
});

// PATCH /api/organizations/:orgId/chat/messages/:msgId/pin
router.patch("/organizations/:orgId/chat/messages/:msgId/pin", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const msgId = parseInt(String((req.params as Record<string, string>).msgId));
  const { pinned } = req.body;

  const [msg] = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, msgId)).limit(1);
  if (!msg) { { res.status(404).json({ error: "Not found" }); return; } }

  const [room] = await db.select().from(chatRoomsTable).where(eq(chatRoomsTable.id, msg.roomId)).limit(1);
  if (!room || (room.organizationId !== orgId && caller?.role !== "super_admin")) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const [updated] = await db
    .update(chatMessagesTable)
    .set({ isPinned: pinned ?? true })
    .where(eq(chatMessagesTable.id, msgId))
    .returning();

  broadcastChatMessage(room.id, updated!);
  res.json(updated);
});

// DELETE /api/organizations/:orgId/chat/messages/:msgId
router.delete("/organizations/:orgId/chat/messages/:msgId", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const msgId = parseInt(String((req.params as Record<string, string>).msgId));
  const [msg] = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, msgId)).limit(1);
  if (!msg) { { res.status(404).json({ error: "Not found" }); return; } }

  const [room] = await db.select().from(chatRoomsTable).where(eq(chatRoomsTable.id, msg.roomId)).limit(1);
  if (!room || (room.organizationId !== orgId && caller?.role !== "super_admin")) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  await db.delete(chatMessagesTable).where(eq(chatMessagesTable.id, msgId));
  broadcastChatDeletion(room.id, msgId);
  res.json({ ok: true });
});

// POST /api/organizations/:orgId/chat/messages/:msgId/react
// Toggle an emoji reaction on a message (any chat member)
router.post("/organizations/:orgId/chat/messages/:msgId/react", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const msgId = parseInt(String((req.params as Record<string, string>).msgId));

  if (isNaN(orgId) || isNaN(msgId)) { { res.status(400).json({ error: "Invalid params" }); return; } }
  if (!caller?.id) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const { emoji } = req.body;
  if (!emoji || typeof emoji !== "string" || emoji.length > 10) {
    res.status(400).json({ error: "Valid emoji required" }); return;
  }

  const [msg] = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, msgId)).limit(1);
  if (!msg) { { res.status(404).json({ error: "Message not found" }); return; } }

  const [room] = await db.select().from(chatRoomsTable).where(eq(chatRoomsTable.id, msg.roomId)).limit(1);
  if (!room || room.organizationId !== orgId) { { res.status(403).json({ error: "Forbidden" }); return; } }

  // Verify caller is an actual member of this room (org member, tournament player, or league member)
  if (!await canAccessChat(caller, orgId, room.type, room.entityId)) {
    res.status(403).json({ error: "You are not a member of this chat room" }); return;
  }

  // Toggle: add if not present, remove if already reacted
  const reactions: Record<string, number[]> = (msg.reactions as Record<string, number[]>) ?? {};
  const existing = reactions[emoji] ?? [];
  if (existing.includes(caller.id)) {
    reactions[emoji] = existing.filter(uid => uid !== caller.id);
    if (reactions[emoji].length === 0) delete reactions[emoji];
  } else {
    reactions[emoji] = [...existing, caller.id];
  }

  const [updated] = await db
    .update(chatMessagesTable)
    .set({ reactions })
    .where(eq(chatMessagesTable.id, msgId))
    .returning();

  broadcastChatMessage(room.id, updated!);
  res.json(updated);
});

// DELETE /api/organizations/:orgId/chat/:type/:entityId/messages
// Clear all messages in the room (admin only)
router.delete("/organizations/:orgId/chat/:type/:entityId/messages", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { type, entityId } = (req.params as Record<string, string>);
  const eId = parseInt(entityId);

  if (isNaN(orgId) || isNaN(eId)) { { res.status(400).json({ error: "Invalid params" }); return; } }
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const owned = await validateEntityOwnership(orgId, type, eId);
  if (!owned) { { res.status(404).json({ error: "Entity not found in this organization" }); return; } }

  const room = await getRoom(orgId, type, eId);
  if (!room) { { res.status(404).json({ error: "Chat room not found" }); return; } }
  if (room.organizationId !== orgId && caller?.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  await db.delete(chatMessagesTable).where(eq(chatMessagesTable.roomId, room.id));
  broadcastChatCleared(room.id);
  res.json({ ok: true });
});

// POST /api/organizations/:orgId/chat/:type/:entityId/mute/:userId — admin mutes a user
router.post("/organizations/:orgId/chat/:type/:entityId/mute/:userId", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { type, entityId, userId } = (req.params as Record<string, string>);
  const eId = parseInt(entityId);
  const targetId = parseInt(userId);

  if (isNaN(orgId) || isNaN(eId) || isNaN(targetId)) { { res.status(400).json({ error: "Invalid params" }); return; } }
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Admin only" }); return; } }

  const owned = await validateEntityOwnership(orgId, type, eId);
  if (!owned) { { res.status(404).json({ error: "Entity not found" }); return; } }

  const room = await getOrCreateRoom(orgId, type, eId);
  const current = Array.isArray(room.mutedUserIds) ? room.mutedUserIds : [];
  if (current.includes(targetId)) { { res.json({ ok: true, mutedUserIds: current }); return; } }

  const [updated] = await db
    .update(chatRoomsTable)
    .set({ mutedUserIds: [...current, targetId] })
    .where(eq(chatRoomsTable.id, room.id))
    .returning();

  res.json({ ok: true, mutedUserIds: updated.mutedUserIds });
});

// DELETE /api/organizations/:orgId/chat/:type/:entityId/mute/:userId — admin unmutes a user
router.delete("/organizations/:orgId/chat/:type/:entityId/mute/:userId", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { type, entityId, userId } = (req.params as Record<string, string>);
  const eId = parseInt(entityId);
  const targetId = parseInt(userId);

  if (isNaN(orgId) || isNaN(eId) || isNaN(targetId)) { { res.status(400).json({ error: "Invalid params" }); return; } }
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Admin only" }); return; } }

  const owned = await validateEntityOwnership(orgId, type, eId);
  if (!owned) { { res.status(404).json({ error: "Entity not found" }); return; } }

  const room = await getOrCreateRoom(orgId, type, eId);
  const current = Array.isArray(room.mutedUserIds) ? room.mutedUserIds : [];

  const [updated] = await db
    .update(chatRoomsTable)
    .set({ mutedUserIds: current.filter(id => id !== targetId) })
    .where(eq(chatRoomsTable.id, room.id))
    .returning();

  res.json({ ok: true, mutedUserIds: updated.mutedUserIds });
});

// PATCH /api/organizations/:orgId/chat/:type/:entityId/toggle
router.patch("/organizations/:orgId/chat/:type/:entityId/toggle", async (req: Request, res: Response) => {
  const caller = userFromReq(req);
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { type, entityId } = (req.params as Record<string, string>);
  const eId = parseInt(entityId);

  if (isNaN(orgId) || isNaN(eId)) { { res.status(400).json({ error: "Invalid params" }); return; } }
  if (!hasOrgAdminAccess(caller, orgId)) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const owned = await validateEntityOwnership(orgId, type, eId);
  if (!owned) { { res.status(404).json({ error: "Entity not found in this organization" }); return; } }

  const room = await getOrCreateRoom(orgId, type, eId);
  const [updated] = await db
    .update(chatRoomsTable)
    .set({ enabled: req.body.enabled ?? !room.enabled })
    .where(eq(chatRoomsTable.id, room.id))
    .returning();

  res.json(updated);
});

export default router;
