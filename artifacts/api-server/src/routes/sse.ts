import { Router, type IRouter, type Request, type Response } from "express";
import { addSSEClient, removeSSEClient, computeLeaderboard, addAnnouncementClient, removeAnnouncementClient, getAnnouncements, addChatClient, removeChatClient, getChatBacklog, addBracketClient, removeBracketClient, addRyderCupClient, removeRyderCupClient, addFantasyClient, removeFantasyClient, addPaceClient, removePaceClient, addMarkerLiveClient, removeMarkerLiveClient } from "../lib/realtime";
import { db } from "@workspace/db";
import { tournamentsTable, playersTable, chatRoomsTable, chatMessagesTable, leagueMembersTable, fantasyLeaguesTable, fantasyTeamsTable, roundSubmissionsTable, scoresTable } from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";

const router: IRouter = Router();

// SSE endpoint: GET /api/sse/announcements/:tournamentId
// ABAC: caller must be an org admin/director for the tournament's org OR an enrolled player.
// Web clients authenticate via session cookie; portal clients via Bearer JWT.
router.get("/announcements/:tournamentId", async (req: Request, res: Response) => {
  const caller = req.user as { id?: number; role?: string; organizationId?: number } | undefined;
  if (!caller?.id) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  // Resolve the tournament to get its org
  const [tournament] = await db
    .select({ id: tournamentsTable.id, organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament) {
    res.status(404).json({ error: "Tournament not found" });
    return;
  }

  const orgId = tournament.organizationId;
  const adminRoles = ["super_admin", "org_admin", "tournament_director"];
  const isOrgAdmin = adminRoles.includes(caller.role ?? "") &&
    (caller.role === "super_admin" || caller.organizationId === orgId);

  if (!isOrgAdmin) {
    const [enrollment] = await db
      .select({ id: playersTable.id })
      .from(playersTable)
      .where(and(eq(playersTable.tournamentId, tournamentId), eq(playersTable.userId, caller.id)));
    if (!enrollment) {
      res.status(403).json({ error: "You are not enrolled in this tournament" });
      return;
    }
  }

  const scope = `tournament_${tournamentId}`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send last 20 announcements as backlog
  const backlog = getAnnouncements(scope).slice(-20);
  for (const ann of backlog) {
    res.write(`data: ${JSON.stringify({ type: "announcement", data: ann })}\n\n`);
  }

  addAnnouncementClient(scope, res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeAnnouncementClient(scope, res);
  });
});

// SSE endpoint: GET /api/sse/leaderboard/:tournamentId
router.get("/leaderboard/:tournamentId", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });

  // Send initial leaderboard
  const leaderboard = await computeLeaderboard(tournamentId);
  if (leaderboard) {
    res.write(`data: ${JSON.stringify({ type: "leaderboard_update", data: { entries: leaderboard.entries, netEntries: leaderboard.netEntries, stablefordEntries: leaderboard.stablefordEntries, availableViews: leaderboard.availableViews, leaderboardType: leaderboard.leaderboardType, tiebreakerMethod: leaderboard.tiebreakerMethod } })}\n\n`);
  }

  // Register client
  addSSEClient(tournamentId, res);

  // Heartbeat every 30 seconds
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    removeSSEClient(tournamentId, res);
  });
});

// SSE endpoint: GET /api/sse/chat/:roomId
// Streams real-time chat messages — caller must be org member or registered tournament player
router.get("/chat/:roomId", async (req: Request, res: Response) => {
  const caller = req.user as { id?: number; role?: string; organizationId?: number } | undefined;
  if (!caller?.id) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const roomId = parseInt(String((req.params as Record<string, string>).roomId));
  if (isNaN(roomId)) { { res.status(400).json({ error: "Invalid roomId" }); return; } }

  const [room] = await db
    .select()
    .from(chatRoomsTable)
    .where(eq(chatRoomsTable.id, roomId));

  if (!room) { { res.status(404).json({ error: "Room not found" }); return; } }
  if (!room.enabled) { { res.status(403).json({ error: "Chat disabled" }); return; } }

  // Only org admins bypass membership checks; regular org members must have entity-level access
  const ADMIN_ROLES = ["super_admin", "org_admin", "tournament_director"];
  const isOrgAdmin = ADMIN_ROLES.includes(caller.role ?? "") &&
    (caller.role === "super_admin" || caller.organizationId === room.organizationId);
  let canAccess = isOrgAdmin;

  if (!canAccess && room.type === "tournament") {
    const [player] = await db
      .select({ id: playersTable.id })
      .from(playersTable)
      .where(and(eq(playersTable.tournamentId, room.entityId), eq(playersTable.userId, caller.id)))
      .limit(1);
    canAccess = !!player;
  }

  if (!canAccess && room.type === "league") {
    const [member] = await db
      .select({ id: leagueMembersTable.id })
      .from(leagueMembersTable)
      .where(and(eq(leagueMembersTable.leagueId, room.entityId), eq(leagueMembersTable.userId, caller.id)))
      .limit(1);
    canAccess = !!member;
  }

  if (!canAccess) { { res.status(403).json({ error: "Forbidden" }); return; } }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send backlog (last 50 messages from DB)
  const backlog = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.roomId, roomId))
    .orderBy(asc(chatMessagesTable.createdAt))
    .limit(50);

  for (const msg of backlog) {
    res.write(`data: ${JSON.stringify({ type: "chat_message", data: msg })}\n\n`);
  }

  addChatClient(roomId, res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeChatClient(roomId, res);
  });
});

// SSE endpoint: GET /api/sse/bracket/:tournamentId
// Streams live bracket updates to any connected client (no auth required — results are public)
router.get("/bracket/:tournamentId", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournament ID" }); return; } }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });

  // Send an initial connected event
  res.write(`data: ${JSON.stringify({ type: "connected", tournamentId })}\n\n`);

  addBracketClient(tournamentId, res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeBracketClient(tournamentId, res);
  });
});

// SSE endpoint: GET /api/sse/ryder-cup/:tournamentId
// Streams live Ryder Cup score updates to any connected client (no auth required — results are public)
router.get("/ryder-cup/:tournamentId", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournament ID" }); return; } }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });

  res.write(`data: ${JSON.stringify({ type: "connected", tournamentId })}\n\n`);

  addRyderCupClient(tournamentId, res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeRyderCupClient(tournamentId, res);
  });
});

// ─── Fantasy leaderboard SSE ─────────────────────────────────────────────────
// GET /api/sse/fantasy/:fantasyLeagueId
// Access: must be authenticated AND either an org member or a team member of the league
router.get("/fantasy/:fantasyLeagueId", async (req: Request, res: Response) => {
  const caller = req.user as { id?: number; role?: string; organizationId?: number } | undefined;
  if (!caller?.id) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const fantasyLeagueId = parseInt(String((req.params as Record<string, string>).fantasyLeagueId));

  // Verify the fantasy league exists and caller has access (is a team member or org admin)
  const [fl] = await db
    .select({ id: fantasyLeaguesTable.id, organizationId: fantasyLeaguesTable.organizationId })
    .from(fantasyLeaguesTable)
    .where(eq(fantasyLeaguesTable.id, fantasyLeagueId));

  if (!fl) { { res.status(404).json({ error: "Fantasy league not found" }); return; } }

  const adminRoles = ["super_admin", "org_admin", "tournament_director"];
  const isOrgAdmin = adminRoles.includes(caller.role ?? "") &&
    (caller.role === "super_admin" || caller.organizationId === fl.organizationId);

  if (!isOrgAdmin) {
    // Verify caller has a team in this league
    const [myTeam] = await db
      .select({ id: fantasyTeamsTable.id })
      .from(fantasyTeamsTable)
      .where(and(
        eq(fantasyTeamsTable.fantasyLeagueId, fantasyLeagueId),
        eq(fantasyTeamsTable.userId, caller.id),
      ));
    if (!myTeam) { { res.status(403).json({ error: "You are not a member of this fantasy league" }); return; } }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write(`: connected to fantasy leaderboard ${fantasyLeagueId}\n\n`);

  addFantasyClient(fantasyLeagueId, res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeFantasyClient(fantasyLeagueId, res);
  });
});

// SSE endpoint: GET /api/sse/pace/:tournamentId
// Marshal live board — real-time pace updates
router.get("/pace/:tournamentId", async (req: Request, res: Response) => {
  const caller = req.user as { id?: number; role?: string; organizationId?: number } | undefined;
  if (!caller?.id) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const [tournament] = await db
    .select({ organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament) {
    res.status(404).json({ error: "Tournament not found" });
    return;
  }

  const adminRoles = ["super_admin", "org_admin", "tournament_director", "volunteer"];
  const isAdmin = adminRoles.includes(caller.role ?? "") &&
    (caller.role === "super_admin" || caller.organizationId === tournament.organizationId);

  if (!isAdmin) {
    res.status(403).json({ error: "Marshal access required" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  addPaceClient(tournamentId, res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removePaceClient(tournamentId, res);
  });
});

// NOTE: The marker live SSE stream is served at GET /api/marker-live/:token/stream
// in routes/marker-live.ts (registered before auth middleware for public, token-only access).
// This alias is kept for backwards compatibility.
router.get("/marker-live/:token", async (req: Request, res: Response) => {
  const { token } = (req.params as Record<string, string>);
  if (!token || token.length < 20) { { res.status(400).json({ error: "Invalid token" }); return; } }

  // Validate the token
  const [submission] = await db
    .select({
      id: roundSubmissionsTable.id,
      playerId: roundSubmissionsTable.playerId,
      round: roundSubmissionsTable.round,
      status: roundSubmissionsTable.status,
      markerShareTokenExpiresAt: roundSubmissionsTable.markerShareTokenExpiresAt,
    })
    .from(roundSubmissionsTable)
    .where(eq(roundSubmissionsTable.markerShareToken, token));

  if (!submission) { { res.status(404).json({ error: "Invalid or expired token" }); return; } }
  if (submission.markerShareTokenExpiresAt && submission.markerShareTokenExpiresAt < new Date()) {
    res.status(410).json({ error: "Token expired" }); return;
  }
  if (["countersigned", "disputed"].includes(submission.status)) {
    res.status(410).json({ error: "Round finalised — stream closed" }); return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send current scores as a backlog snapshot
  const scores = await db.select({ holeNumber: scoresTable.holeNumber, strokes: scoresTable.strokes })
    .from(scoresTable)
    .where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round)))
    .orderBy(asc(scoresTable.holeNumber));

  if (scores.length > 0) {
    res.write(`data: ${JSON.stringify({ type: "score_snapshot", data: scores })}\n\n`);
  }

  res.write(`data: ${JSON.stringify({ type: "connected", submissionId: submission.id })}\n\n`);

  addMarkerLiveClient(token, res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeMarkerLiveClient(token, res);
  });
});

export default router;
