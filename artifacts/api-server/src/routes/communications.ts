import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import { gateFeatureFromSession } from "../lib/featureGate";
import {
  invitationsTable,
  messageLogsTable,
  tournamentAnnouncementsTable,
  announcementReadReceiptsTable,
  messageTemplatesTable,
  deviceTokensTable,
  tournamentsTable,
  leaguesTable,
  organizationsTable,
  playersTable,
  playerFlightsTable,
  leagueMembersTable,
  appUsersTable,
  flightsTable,
  userNotificationPrefsTable,
  automationRulesTable,
  automationRuleLogsTable,
  orgMembershipsTable,
  analyticsEventsTable,
} from "@workspace/db";
import { eq, and, desc, inArray, count as sqlCount, sql, gte } from "drizzle-orm";
import { broadcastAnnouncement } from "../lib/realtime";
import { sendBroadcast, sendInvite, sendTransactionalPush, registerDeviceToken, unregisterDeviceToken } from "../lib/comms";
import { track } from "../lib/analytics";
// Task #1240 — automation_retry / automation_test paths consume the push
// PushDeliveryResult for delivered/failed accounting; route through the
// shared classifier so a recipient with no Expo token (Task #1070) is not
// booked as `delivered` (the inline "did it throw?" check would do exactly
// that, since `sendTransactionalPush` returns {attempted:0,...} silently
// when nothing was sent).
import { classifyPushDelivery } from "../lib/push";
import { sendBroadcastEmail } from "../lib/mailer";

const router = Router({ mergeParams: true });

// Routes within the kharagolf-web SPA that handle public invitation flows.
// Using a single helper keeps every generated URL consistent across the codebase.
const WEB_APP_PATH = process.env.WEB_APP_PATH ?? "/kharagolf-web";

function buildInviteUrl(token: string, orgId: number, opts: { tournamentId?: string | number | null; leagueId?: string | number | null }): string {
  const base = process.env.APP_BASE_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN}`;
  if (opts.tournamentId) {
    return `${base}${WEB_APP_PATH}/register/${orgId}/${opts.tournamentId}?invite=${token}`;
  }
  return `${base}${WEB_APP_PATH}/leagues/join?orgId=${orgId}&invite=${token}`;
}

/* ─── Helper: get authenticated user ──────────────────────────── */
function getUser(req: Request) {
  return req.user as { id: number; username: string; organizationId?: number; displayName?: string; role?: string } | undefined;
}

function requireAdmin(req: Request, res: Response): boolean {
  const u = getUser(req);
  if (!u) { res.status(401).json({ error: "Unauthorized" }); return false; }
  const adminRoles = ["super_admin", "org_admin", "tournament_director"];
  if (!adminRoles.includes(u.role ?? "")) { res.status(403).json({ error: "Forbidden" }); return false; }
  // Enforce org ownership: non-super-admins can only operate on their own org
  if (u.role !== "super_admin" && (req.params as Record<string, string>).orgId) {
    if (u.organizationId !== parseInt(String((req.params as Record<string, string>).orgId))) {
      res.status(403).json({ error: "Forbidden: org mismatch" });
      return false;
    }
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════════
   INVITATIONS
   ═══════════════════════════════════════════════════════════════ */

// POST /organizations/:orgId/invitations — create + optionally send invitation
router.post("/", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const {
    tournamentId,
    leagueId,
    recipientEmail,
    recipientPhone,
    recipientName,
    channels = [],
    sendNow = false,
  } = req.body;

  // Require at least one contact method (email or phone)
  if (!recipientEmail && !recipientPhone) {
    res.status(400).json({ error: "recipientEmail or recipientPhone is required" }); return;
  }

  // Reject orphan invitations that belong to no event
  if (!tournamentId && !leagueId) {
    res.status(400).json({ error: "Either tournamentId or leagueId is required" }); return;
  }

  // Verify tournament/league belongs to this org
  if (tournamentId) {
    const [t] = await db.select({ id: tournamentsTable.id }).from(tournamentsTable)
      .where(and(eq(tournamentsTable.id, parseInt(tournamentId)), eq(tournamentsTable.organizationId, orgId)));
    if (!t) { res.status(404).json({ error: "Tournament not found in this organization" }); return; }
  }
  if (leagueId) {
    const [l] = await db.select({ id: leaguesTable.id }).from(leaguesTable)
      .where(and(eq(leaguesTable.id, parseInt(leagueId)), eq(leaguesTable.organizationId, orgId)));
    if (!l) { res.status(404).json({ error: "League not found in this organization" }); return; }
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const [invite] = await db.insert(invitationsTable).values({
    organizationId: orgId,
    tournamentId: tournamentId ? parseInt(tournamentId) : null,
    leagueId: leagueId ? parseInt(leagueId) : null,
    token,
    recipientEmail: recipientEmail || null,
    recipientPhone: recipientPhone || null,
    recipientName: recipientName || null,
    channels,
    status: "pending",
    expiresAt,
  }).returning();

  // Send via selected channels if requested
  const hasContactMethod = recipientEmail || recipientPhone;
  const hasChannel = Array.isArray(channels) && channels.length > 0;
  if (sendNow && hasContactMethod && hasChannel) {
    try {
      const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));

      let eventName = "Event";
      let eventType: "tournament" | "league" = "tournament";

      if (tournamentId) {
        const [t] = await db.select({ name: tournamentsTable.name }).from(tournamentsTable).where(eq(tournamentsTable.id, parseInt(tournamentId)));
        if (t) eventName = t.name;
      } else if (leagueId) {
        const [l] = await db.select({ name: leaguesTable.name }).from(leaguesTable).where(eq(leaguesTable.id, parseInt(leagueId)));
        if (l) { eventName = l.name; eventType = "league"; }
      }

      const inviteUrl = buildInviteUrl(token, orgId, { tournamentId, leagueId });

      await sendInvite({
        recipientEmail: recipientEmail || null,
        recipientPhone: recipientPhone || null,
        recipientName: recipientName ?? "",
        eventName,
        eventType,
        inviteUrl,
        orgName: org?.name ?? "KHARAGOLF",
        channels,
        // Task #1319 — tag invitation email with orgId so the Postmark
        // bounce webhook (Task #981) can attribute hard bounces directly
        // instead of falling back to the slow campaign / membership scan.
        organizationId: orgId,
      });

      await db.update(invitationsTable)
        .set({ sentAt: new Date() })
        .where(eq(invitationsTable.id, invite.id));

      invite.sentAt = new Date();

      // Push: notify recipient if they already have a platform account
      if (recipientEmail) {
        const [existingUser] = await db
          .select({ id: appUsersTable.id })
          .from(appUsersTable)
          .where(eq(appUsersTable.email, recipientEmail));
        if (existingUser) {
          // Task #1240 — fire-and-forget (`.catch(() => undefined)`); no
          // delivery telemetry consumed downstream, classifier
          // intentionally not used. The invite email above is the durable
          // channel for invitees without an Expo token.
          sendTransactionalPush(
            [existingUser.id],
            `You've been invited to ${eventName}`,
            `${org?.name ?? "KHARAGOLF"} has invited you. Tap to view and register.`,
            { type: "invitation_received", token, tournamentId: tournamentId ?? null, leagueId: leagueId ?? null },
          ).catch(() => undefined);
        }
      }
    } catch (err) {
      console.warn("[invitations] Send failed:", err);
    }
  }

  res.status(201).json(invite);
});

// GET /organizations/:orgId/invitations — list all invitations for org
// Computes effective status server-side: pending invitations past expiresAt are returned as "expired"
router.get("/", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { tournamentId, leagueId } = req.query;

  const conditions = [eq(invitationsTable.organizationId, orgId)];
  if (tournamentId) conditions.push(eq(invitationsTable.tournamentId, parseInt(tournamentId as string)));
  if (leagueId) conditions.push(eq(invitationsTable.leagueId, parseInt(leagueId as string)));

  const invites = await db
    .select()
    .from(invitationsTable)
    .where(and(...conditions))
    .orderBy(desc(invitationsTable.createdAt));

  const now = new Date();
  // Compute effective status: pending invitations past expiresAt → expired
  const withEffectiveStatus = invites.map((inv) => ({
    ...inv,
    effectiveStatus: inv.status === "pending" && new Date(inv.expiresAt) < now ? "expired" : inv.status,
  }));

  res.json(withEffectiveStatus);
});

// DELETE /organizations/:orgId/invitations/:id — revoke
router.delete("/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  const result = await db.update(invitationsTable)
    .set({ status: "revoked" })
    .where(and(eq(invitationsTable.id, id), eq(invitationsTable.organizationId, orgId)))
    .returning({ id: invitationsTable.id });
  if (result.length === 0) { res.status(404).json({ error: "Invitation not found" }); return; }
  res.json({ ok: true });
});

// POST /organizations/:orgId/invitations/:id/resend — resend invitation email
router.post("/:id/resend", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));

  const [invite] = await db.select().from(invitationsTable)
    .where(and(eq(invitationsTable.id, id), eq(invitationsTable.organizationId, orgId)));
  if (!invite) { res.status(404).json({ error: "Invitation not found" }); return; }

  if (invite.status === "revoked" || invite.status === "accepted") {
    res.status(400).json({ error: `Cannot resend a ${invite.status} invitation` }); return;
  }

  const hasContactMethod = invite.recipientEmail || invite.recipientPhone;
  if (hasContactMethod) {
    try {
      const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
      let eventName = "Event";
      let eventType: "tournament" | "league" = "tournament";

      if (invite.tournamentId) {
        const [t] = await db.select({ name: tournamentsTable.name }).from(tournamentsTable).where(eq(tournamentsTable.id, invite.tournamentId));
        if (t) eventName = t.name;
      } else if (invite.leagueId) {
        const [l] = await db.select({ name: leaguesTable.name }).from(leaguesTable).where(eq(leaguesTable.id, invite.leagueId));
        if (l) { eventName = l.name; eventType = "league"; }
      }

      const inviteUrl = buildInviteUrl(invite.token, orgId, { tournamentId: invite.tournamentId, leagueId: invite.leagueId });

      await sendInvite({
        recipientEmail: invite.recipientEmail,
        recipientPhone: invite.recipientPhone,
        recipientName: invite.recipientName ?? "",
        eventName,
        eventType,
        inviteUrl,
        orgName: org?.name ?? "KHARAGOLF",
        channels: (invite.channels as import("../lib/comms").Channel[] | null) ?? ["email"],
        // Task #1319 — orgId on invitation email metadata for bounce
        // attribution (Task #981).
        organizationId: orgId,
      });

      await db.update(invitationsTable)
        .set({ sentAt: new Date(), status: "pending" })
        .where(and(eq(invitationsTable.id, id), eq(invitationsTable.organizationId, orgId)));
    } catch (err) {
      console.warn("[invitations] Resend failed:", err);
      res.status(500).json({ error: "Failed to send invitation" }); return;
    }
  }

  res.json({ ok: true });
});

export default router;

/* ═══════════════════════════════════════════════════════════════
   BROADCAST MESSAGES
   ═══════════════════════════════════════════════════════════════ */

export const broadcastRouter = Router({ mergeParams: true });

// POST /organizations/:orgId/messages/broadcast — send message to players in tournament or league
// Supports optional recipient targeting by:
//   flightId   — only players in that flight (tournament context only)
//   playerIds  — explicit comma-separated subset of player IDs (tournament context only)
broadcastRouter.post("/broadcast", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getUser(req)!;

  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { tournamentId, leagueId, subject, body, channels = ["email"], flightId, playerIds } = req.body;

  if (!body?.trim()) { res.status(400).json({ error: "Body is required" }); return; }

  let recipients: Array<{ email?: string | null; phone?: string | null; firstName: string; lastName: string; userId?: number | null; preferredChannels?: import("../lib/comms").Channel[] | null }> = [];
  let eventName = "KHARAGOLF";
  let eventType: "tournament" | "league" = "tournament";

  if (tournamentId) {
    const tid = parseInt(tournamentId);
    // Verify tournament belongs to this org
    const [t] = await db.select({ name: tournamentsTable.name, orgId: tournamentsTable.organizationId })
      .from(tournamentsTable).where(and(eq(tournamentsTable.id, tid), eq(tournamentsTable.organizationId, orgId)));
    if (!t) { res.status(404).json({ error: "Tournament not found in this organization" }); return; }
    eventName = t.name;

    // Start with all players in this tournament
    let tournamentPlayerIds: number[] | null = null;

    // Flight-based targeting: restrict to players assigned to a specific flight
    if (flightId) {
      const fid = parseInt(flightId);
      // Verify flight belongs to this tournament
      const [f] = await db.select({ id: flightsTable.id }).from(flightsTable)
        .where(and(eq(flightsTable.id, fid), eq(flightsTable.tournamentId, tid)));
      if (!f) { res.status(404).json({ error: "Flight not found in this tournament" }); return; }
      // Use player_flights junction table for proper flight membership lookup
      const flightPlayers = await db
        .select({ playerId: playerFlightsTable.playerId })
        .from(playerFlightsTable)
        .where(eq(playerFlightsTable.flightId, f.id));
      tournamentPlayerIds = flightPlayers.map(r => r.playerId);
      if (tournamentPlayerIds.length === 0) {
        res.status(200).json({ queued: true, recipientCount: 0, message: "No players in that flight" }); return;
      }
    }

    // Explicit player IDs subset targeting
    if (Array.isArray(playerIds) && playerIds.length > 0) {
      const pids = playerIds.map((id: unknown) => parseInt(String(id))).filter((id: number) => !isNaN(id));
      tournamentPlayerIds = tournamentPlayerIds
        ? tournamentPlayerIds.filter(id => pids.includes(id))
        : pids;
    }

    // Fetch recipients with the appropriate filter
    const baseCondition = eq(playersTable.tournamentId, tid);
    const idFilter = tournamentPlayerIds !== null && tournamentPlayerIds.length > 0
      ? inArray(playersTable.id, tournamentPlayerIds)
      : null;

    recipients = await db
      .select({ email: playersTable.email, phone: playersTable.phone, firstName: playersTable.firstName, lastName: playersTable.lastName, userId: playersTable.userId })
      .from(playersTable)
      .where(idFilter ? and(baseCondition, idFilter) : baseCondition);
  } else if (leagueId) {
    const lid = parseInt(leagueId);
    // Verify league belongs to this org
    const [l] = await db.select({ name: leaguesTable.name, orgId: leaguesTable.organizationId })
      .from(leaguesTable).where(and(eq(leaguesTable.id, lid), eq(leaguesTable.organizationId, orgId)));
    if (!l) { res.status(404).json({ error: "League not found in this organization" }); return; }
    eventName = l.name;
    eventType = "league";

    // leagueMembersTable has email and userId but no phone column
    recipients = await db
      .select({ email: leagueMembersTable.email, firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName, userId: leagueMembersTable.userId })
      .from(leagueMembersTable)
      .where(eq(leagueMembersTable.leagueId, lid))
      .then(rows => rows.map(r => ({ ...r, phone: null as string | null })));
  } else {
    // Org-wide: all players across all tournaments in this org
    eventName = "KHARAGOLF";
    const orgTournaments = await db
      .select({ id: tournamentsTable.id })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.organizationId, orgId));
    if (orgTournaments.length > 0) {
      const tIds = orgTournaments.map(t => t.id);
      recipients = await db
        .select({ email: playersTable.email, phone: playersTable.phone, firstName: playersTable.firstName, lastName: playersTable.lastName, userId: playersTable.userId })
        .from(playersTable)
        .where(inArray(playersTable.tournamentId, tIds));
      // Deduplicate by email+phone (keep phone-only recipients without email)
      const seen = new Set<string>();
      recipients = recipients.filter(r => {
        const key = r.email ?? (r.phone ? `phone:${r.phone}` : null);
        if (!key) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }

  // Enrich recipients with their per-channel notification preferences
  const recipientUserIds = recipients
    .map(r => r.userId)
    .filter((id): id is number => typeof id === "number" && id > 0);
  if (recipientUserIds.length > 0) {
    const notifPrefs = await db
      .select()
      .from(userNotificationPrefsTable)
      .where(inArray(userNotificationPrefsTable.userId, recipientUserIds));
    const prefsById = new Map(notifPrefs.map(p => [p.userId, p]));
    recipients = recipients.map(r => {
      if (!r.userId) return r;
      const p = prefsById.get(r.userId);
      if (!p) return r;
      const preferredChannels: import("../lib/comms").Channel[] = [];
      if (p.preferEmail) preferredChannels.push("email");
      if (p.preferPush) preferredChannels.push("push");
      if (p.preferSms) preferredChannels.push("sms");
      if (p.preferWhatsapp) preferredChannels.push("whatsapp");
      return { ...r, preferredChannels };
    });
  }

  // Log to DB
  const [msgLog] = await db.insert(messageLogsTable).values({
    organizationId: orgId,
    tournamentId: tournamentId ? parseInt(tournamentId) : null,
    leagueId: leagueId ? parseInt(leagueId) : null,
    subject: subject || null,
    body,
    channels,
    recipientCount: recipients.length,
    sentByUserId: user.id,
  }).returning();

  // Dispatch via unified comms abstraction and write back delivery stats
  const msgLogId = msgLog.id;
  const [orgBranding] = await db.select({ logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId)).catch(() => [null]);

  sendBroadcast(recipients, {
    subject,
    body,
    channels,
    eventName,
    tournamentId: tournamentId ? parseInt(tournamentId) : null,
    leagueId: leagueId ? parseInt(leagueId) : null,
    logoUrl: orgBranding?.logoUrl ?? null,
    primaryColor: orgBranding?.primaryColor ?? null,
    // Task #1319 — tag broadcast emails with orgId so the Postmark
    // bounce webhook (Task #981) can attribute hard bounces directly.
    organizationId: orgId,
  }).then(async (deliveryStats) => {
    const finalStatus = Object.values(deliveryStats).every(s => s.failed === 0) ? "sent" : "partial";
    await db.update(messageLogsTable)
      .set({ deliveryStats, status: finalStatus })
      .where(eq(messageLogsTable.id, msgLogId))
      .catch(err => console.warn("[broadcast] failed to update delivery stats", err));
  }).catch(err => console.warn("[broadcast] sendBroadcast error:", err));

  res.json({ ok: true, messageId: msgLog.id, recipientCount: recipients.length });
});

// GET /organizations/:orgId/messages — message history (admin only)
broadcastRouter.get("/", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getUser(req)!;

  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { tournamentId, leagueId } = req.query;

  const conditions = [eq(messageLogsTable.organizationId, orgId)];
  if (tournamentId) conditions.push(eq(messageLogsTable.tournamentId, parseInt(tournamentId as string)));
  if (leagueId) conditions.push(eq(messageLogsTable.leagueId, parseInt(leagueId as string)));

  const messages = await db
    .select({
      id: messageLogsTable.id,
      subject: messageLogsTable.subject,
      body: messageLogsTable.body,
      channels: messageLogsTable.channels,
      recipientCount: messageLogsTable.recipientCount,
      sentAt: messageLogsTable.sentAt,
      status: messageLogsTable.status,
      deliveryStats: messageLogsTable.deliveryStats,
      sentByUserId: messageLogsTable.sentByUserId,
      tournamentId: messageLogsTable.tournamentId,
      leagueId: messageLogsTable.leagueId,
    })
    .from(messageLogsTable)
    .where(and(...conditions))
    .orderBy(desc(messageLogsTable.sentAt))
    .limit(100);

  res.json(messages);
});

/* ═══════════════════════════════════════════════════════════════
   TOURNAMENT ANNOUNCEMENTS (persist to DB + broadcast SSE)
   ═══════════════════════════════════════════════════════════════ */

export const announcementsRouter = Router({ mergeParams: true });

// POST /organizations/:orgId/tournaments/:tournamentId/announcements
announcementsRouter.post("/", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getUser(req)!;

  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { body, type = "general" } = req.body;

  if (!body?.trim()) { res.status(400).json({ error: "body is required" }); return; }

  // Verify tournament belongs to this org
  const [ownedTournament] = await db
    .select({ id: tournamentsTable.id, name: tournamentsTable.name })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!ownedTournament) { res.status(404).json({ error: "Tournament not found in this organization" }); return; }

  const authorName = user.displayName ?? user.username;

  // Persist to DB
  const [ann] = await db.insert(tournamentAnnouncementsTable).values({
    tournamentId,
    body: body.trim(),
    type,
    authorName,
    sentByUserId: user.id,
  }).returning();

  // Broadcast via SSE (keeps in-memory for live clients)
  const scope = `tournament_${tournamentId}`;
  broadcastAnnouncement(scope, body.trim(), authorName);

  // Always push to enrolled players with registered device tokens
  const players = await db
    .select({ userId: playersTable.userId, firstName: playersTable.firstName, lastName: playersTable.lastName })
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tournamentId));

  if (players.length > 0) {
    sendBroadcast(players, {
      body: body.trim(),
      channels: ["push"],
      eventName: ownedTournament.name,
      tournamentId,
      // Task #1319 — orgId for consistency. (Push-only here, but keeping
      // the field set means future channel additions inherit attribution
      // without another sweep.)
      organizationId: orgId,
    }).catch(err => console.warn("[announcements] push failed:", err));
  }

  res.status(201).json(ann);
});

// GET /organizations/:orgId/tournaments/:tournamentId/announcements
// Access: org admin/director for the org, OR a player enrolled in the tournament
announcementsRouter.get("/", async (req, res) => {
  const caller = req.user as { id?: number; role?: string; organizationId?: number } | undefined;
  if (!caller?.id) { res.status(401).json({ error: "Unauthorized" }); return; }

  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const limit = Math.min(parseInt(req.query.limit as string || "50"), 200);

  // Verify tournament belongs to this org
  const [ownedTournament] = await db
    .select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!ownedTournament) { res.status(404).json({ error: "Tournament not found in this organization" }); return; }

  // Org admins/directors for this org can read
  const adminRoles = ["super_admin", "org_admin", "tournament_director"];
  const isOrgAdmin = adminRoles.includes(caller.role ?? "") &&
    (caller.role === "super_admin" || caller.organizationId === orgId);

  if (!isOrgAdmin) {
    // Otherwise the caller must be a player enrolled in this tournament
    // Authorize by userId OR by email (many players are linked by email without a userId)
    const callerEmail = (req.user as { email?: string } | undefined)?.email ?? null;
    const enrollmentCondition = callerEmail
      ? sql`(${playersTable.userId} = ${caller.id} OR lower(${playersTable.email}) = lower(${callerEmail}))`
      : eq(playersTable.userId, caller.id);
    const [enrollment] = await db
      .select({ id: playersTable.id })
      .from(playersTable)
      .where(and(eq(playersTable.tournamentId, tournamentId), enrollmentCondition));
    if (!enrollment) { res.status(403).json({ error: "You are not enrolled in this tournament" }); return; }
  }

  const rows = await db
    .select()
    .from(tournamentAnnouncementsTable)
    .where(eq(tournamentAnnouncementsTable.tournamentId, tournamentId))
    .orderBy(desc(tournamentAnnouncementsTable.sentAt))
    .limit(limit);

  res.json(rows.reverse());
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/announcements/:id
announcementsRouter.delete("/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const id = parseInt(String((req.params as Record<string, string>).id));

  // Verify tournament belongs to this org
  const [ownedTournament] = await db
    .select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!ownedTournament) { res.status(404).json({ error: "Tournament not found in this organization" }); return; }

  const result = await db.delete(tournamentAnnouncementsTable)
    .where(and(
      eq(tournamentAnnouncementsTable.id, id),
      eq(tournamentAnnouncementsTable.tournamentId, tournamentId),
    ))
    .returning({ id: tournamentAnnouncementsTable.id });
  if (result.length === 0) { res.status(404).json({ error: "Announcement not found" }); return; }
  res.json({ ok: true });
});

// POST /organizations/:orgId/tournaments/:tournamentId/announcements/:id/read
// Authenticated player marks an announcement as read (upsert — safe to call multiple times)
// Security: caller must be an admin of the org OR a registered player in the tournament
announcementsRouter.post("/:id/read", async (req, res) => {
  const caller = req.user as { id?: number; role?: string; organizationId?: number; email?: string } | undefined;
  if (!caller?.id) { res.status(401).json({ error: "Unauthorized" }); return; }

  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const announcementId = parseInt(String((req.params as Record<string, string>).id));

  // Verify announcement belongs to this tournament and org
  const [ann] = await db
    .select({ id: tournamentAnnouncementsTable.id })
    .from(tournamentAnnouncementsTable)
    .innerJoin(tournamentsTable, and(
      eq(tournamentsTable.id, tournamentAnnouncementsTable.tournamentId),
      eq(tournamentsTable.organizationId, orgId),
    ))
    .where(and(
      eq(tournamentAnnouncementsTable.id, announcementId),
      eq(tournamentAnnouncementsTable.tournamentId, tournamentId),
    ));
  if (!ann) { res.status(404).json({ error: "Announcement not found" }); return; }

  // Authorization: org admin or enrolled player in the tournament
  const adminRoles = ["super_admin", "org_admin", "tournament_director"];
  const isAdmin = adminRoles.includes(caller.role ?? "") && (caller.role === "super_admin" || caller.organizationId === orgId);
  if (!isAdmin) {
    const [enrollment] = await db
      .select({ id: playersTable.id })
      .from(playersTable)
      .where(and(
        eq(playersTable.tournamentId, tournamentId),
        sql`(${playersTable.userId} = ${caller.id} OR lower(${playersTable.email}) = lower(${caller.email ?? ''}))`,
      ));
    if (!enrollment) { res.status(403).json({ error: "You must be registered in this tournament to mark announcements as read" }); return; }
  }

  await db.insert(announcementReadReceiptsTable)
    .values({ announcementId, userId: caller.id })
    .onConflictDoNothing();

  res.json({ ok: true, announcementId, readAt: new Date().toISOString() });
});

// GET /organizations/:orgId/tournaments/:tournamentId/announcements/:id/read-receipts
// Admin only: see who has read a specific announcement (with count + user list)
// Security: verifies announcement.tournamentId === :tournamentId AND tournament.organizationId === :orgId
announcementsRouter.get("/:id/read-receipts", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const announcementId = parseInt(String((req.params as Record<string, string>).id));

  // Verify the announcement actually belongs to this tournament within this org
  // (prevents IDOR: guessing an announcement ID from another tournament/org)
  const [ann] = await db
    .select({ id: tournamentAnnouncementsTable.id })
    .from(tournamentAnnouncementsTable)
    .innerJoin(
      tournamentsTable,
      and(
        eq(tournamentsTable.id, tournamentAnnouncementsTable.tournamentId),
        eq(tournamentsTable.organizationId, orgId),
      ),
    )
    .where(
      and(
        eq(tournamentAnnouncementsTable.id, announcementId),
        eq(tournamentAnnouncementsTable.tournamentId, tournamentId),
      ),
    );
  if (!ann) { res.status(404).json({ error: "Announcement not found in this tournament" }); return; }

  const receipts = await db
    .select({
      userId: announcementReadReceiptsTable.userId,
      readAt: announcementReadReceiptsTable.readAt,
      username: appUsersTable.username,
      displayName: appUsersTable.displayName,
    })
    .from(announcementReadReceiptsTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, announcementReadReceiptsTable.userId))
    .where(eq(announcementReadReceiptsTable.announcementId, announcementId))
    .orderBy(desc(announcementReadReceiptsTable.readAt));

  res.json({ announcementId, readCount: receipts.length, receipts });
});

/* ═══════════════════════════════════════════════════════════════
   DEVICE TOKEN REGISTRATION (portal auth — Bearer JWT)
   ═══════════════════════════════════════════════════════════════ */

export const deviceTokenRouter = Router();

// Gate all device-token routes behind the mobileApp feature (resolves org from session, fail-closed)
deviceTokenRouter.use(gateFeatureFromSession("mobileApp"));

deviceTokenRouter.post("/push/register", async (req, res) => {
  const user = req.user as { id?: number } | undefined;
  if (!user?.id) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { token, platform = "expo" } = req.body;
  if (!token) { res.status(400).json({ error: "token required" }); return; }

  try {
    await registerDeviceToken(user.id, token, platform);
    res.json({ ok: true });
  } catch (err) {
    console.warn("[push/register] Error:", err);
    res.status(500).json({ error: "Failed to register token" });
  }
});

deviceTokenRouter.delete("/push/unregister", async (req, res) => {
  const user = req.user as { id?: number } | undefined;
  if (!user?.id) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { token } = req.body;
  if (!token) { res.status(400).json({ error: "token required" }); return; }

  try {
    await unregisterDeviceToken(user.id, token);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to unregister token" });
  }
});

/**
 * POST /portal/notifications/push-opened — Task #1317
 *
 * The mobile app calls this whenever a player taps a delivered native push
 * notification (cold-start `getLastNotificationResponseAsync`, warm-start
 * `addNotificationResponseReceivedListener`). Until now `notification_opened`
 * only fired for in-app handicap notifications opened on the web/portal, so
 * the analytics dashboard had no visibility into the vast majority of opens
 * that come through native push. We pipe each tap into the same
 * `notification_opened` event so reach-vs-engagement can be measured.
 *
 * Body (all optional, all forwarded into the analytics payload):
 *   messageId   — Expo notification request identifier (best-effort dedupe key)
 *   type        — push `data.type` discriminator (e.g. "handicap_case_update")
 *   url         — deep link the push carries, when present
 *   organizationId — the org the push originated from. Validated against the
 *                    caller's memberships before being attached to the event;
 *                    untrusted org ids are silently dropped.
 *   tournamentId / leagueId / payoutId / reelId / token — extra context fields
 *   forwarded verbatim into the analytics payload for funnel analysis.
 *
 * Always returns 200 unless unauthenticated — analytics MUST NOT break the
 * tap handler. The response body just echoes whether the event was recorded.
 */
deviceTokenRouter.post("/notifications/push-opened", async (req, res) => {
  const user = req.user as { id?: number; organizationId?: number | null } | undefined;
  if (!user?.id) { res.status(401).json({ error: "Unauthorized" }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const messageId = typeof body.messageId === "string" ? body.messageId : null;
  const type = typeof body.type === "string" ? body.type : null;
  const url = typeof body.url === "string" ? body.url : null;

  // organizationId is supplied by the push payload — verify the caller is
  // actually a member of that org before stamping it on the analytics event.
  // (Falls back to the caller's session org if no override is supplied.)
  let organizationId: number | null = user.organizationId ?? null;
  const rawOrg = body.organizationId;
  const candidateOrg = typeof rawOrg === "number" && Number.isFinite(rawOrg)
    ? rawOrg
    : (typeof rawOrg === "string" && /^\d+$/.test(rawOrg) ? Number(rawOrg) : null);
  if (candidateOrg != null) {
    const membership = await db.select({ id: orgMembershipsTable.organizationId })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.userId, user.id),
        eq(orgMembershipsTable.organizationId, candidateOrg),
      ))
      .limit(1);
    organizationId = membership.length > 0 ? candidateOrg : organizationId;
  }

  // Forward useful context fields verbatim. These mirror the push `data`
  // shape that `handleNotificationData` already understands.
  const contextKeys = [
    "tournamentId", "leagueId", "payoutId", "reelId", "matchId",
    "caseId", "noticeId", "token", "deepLink",
  ] as const;
  const extras: Record<string, unknown> = {};
  for (const k of contextKeys) {
    if (body[k] != null) extras[k] = body[k];
  }

  // Task #1564 — dedupe cold-start vs warm-start double-fires. Expo's
  // `getLastNotificationResponseAsync` (cold-start) and
  // `addNotificationResponseReceivedListener` (warm-start) can both fire
  // for the *same* tap on some Expo / OS combinations, which would
  // double-count `notification_opened`. The wire payload already carries
  // the Expo notification request identifier as `messageId`, so use it as
  // a best-effort dedupe key: if we already wrote a row for this
  // (userId, messageId) within the recent past, silently no-op. We still
  // return 200 so the mobile tap handler treats both calls as success.
  const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
  if (messageId) {
    try {
      const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
      const existing = await db
        .select({ id: analyticsEventsTable.id })
        .from(analyticsEventsTable)
        .where(and(
          eq(analyticsEventsTable.eventName, "notification_opened"),
          eq(analyticsEventsTable.userId, user.id),
          gte(analyticsEventsTable.occurredAt, since),
          sql`${analyticsEventsTable.payload}->>'messageId' = ${messageId}`,
        ))
        .limit(1);
      if (existing.length > 0) {
        res.json({ ok: true, deduped: true }); return;
      }
    } catch (err) {
      // Dedupe is best-effort; never break the tap handler if the
      // lookup itself fails.
      console.warn("[push-opened] dedupe lookup failed (proceeding):", err);
    }
  }

  await track("notification_opened", {
    ...extras,
    messageId,
    pushType: type,
    url,
    channel: "push",
  }, {
    surface: "mobile",
    userId: user.id,
    organizationId,
  });

  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════════
   PUBLIC — validate invite token
   ═══════════════════════════════════════════════════════════════ */

export const publicInviteRouter = Router();

publicInviteRouter.get("/invite/:token", async (req, res) => {
  const { token } = (req.params as Record<string, string>);

  const [invite] = await db
    .select()
    .from(invitationsTable)
    .where(eq(invitationsTable.token, token));

  if (!invite) { res.status(404).json({ error: "Invitation not found" }); return; }
  if (invite.status === "revoked") { res.status(410).json({ error: "Invitation has been revoked" }); return; }
  if (invite.status === "accepted") { res.status(200).json({ ...invite, alreadyAccepted: true }); return; }
  if (invite.expiresAt < new Date()) {
    await db.update(invitationsTable).set({ status: "expired" }).where(eq(invitationsTable.id, invite.id));
    res.status(410).json({ error: "Invitation has expired" }); return;
  }

  // Get event details
  let eventName: string | null = null;
  let eventType: string = "tournament";

  if (invite.tournamentId) {
    const [t] = await db.select({ name: tournamentsTable.name }).from(tournamentsTable).where(eq(tournamentsTable.id, invite.tournamentId));
    eventName = t?.name ?? null;
  } else if (invite.leagueId) {
    const [l] = await db.select({ name: leaguesTable.name }).from(leaguesTable).where(eq(leaguesTable.id, invite.leagueId));
    eventName = l?.name ?? null;
    eventType = "league";
  }

  const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable)
    .where(eq(organizationsTable.id, invite.organizationId));

  res.json({
    ...invite,
    eventName,
    eventType,
    orgName: org?.name ?? null,
  });
});

// NOTE: Invite acceptance is performed atomically as part of player/league registration.
// No standalone accept endpoint is exposed to prevent unauthenticated token burning.

/* ═══════════════════════════════════════════════════════════════
   MESSAGE TEMPLATES — reusable admin-composed message templates
   ═══════════════════════════════════════════════════════════════ */

export const templatesRouter = Router({ mergeParams: true });

// GET /organizations/:orgId/templates — list all templates for this org
templatesRouter.get("/", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const templates = await db
    .select()
    .from(messageTemplatesTable)
    .where(eq(messageTemplatesTable.organizationId, orgId))
    .orderBy(desc(messageTemplatesTable.createdAt));

  res.json(templates);
});

// POST /organizations/:orgId/templates — create a new template
templatesRouter.post("/", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = getUser(req)!;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { name, subject, body, type = "general", channels = ["email"] } = req.body;

  if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
  if (!body?.trim()) { res.status(400).json({ error: "body is required" }); return; }

  const [tmpl] = await db.insert(messageTemplatesTable).values({
    organizationId: orgId,
    name: name.trim(),
    subject: subject?.trim() || null,
    body: body.trim(),
    type,
    channels,
    createdByUserId: user.id,
  }).returning();

  res.status(201).json(tmpl);
});

// PUT /organizations/:orgId/templates/:id — update an existing template
templatesRouter.put("/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  const { name, subject, body, type, channels } = req.body;

  if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
  if (!body?.trim()) { res.status(400).json({ error: "body is required" }); return; }

  const [tmpl] = await db.update(messageTemplatesTable)
    .set({
      name: name.trim(),
      subject: subject?.trim() || null,
      body: body.trim(),
      ...(type ? { type } : {}),
      ...(channels ? { channels } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(messageTemplatesTable.id, id), eq(messageTemplatesTable.organizationId, orgId)))
    .returning();

  if (!tmpl) { res.status(404).json({ error: "Template not found" }); return; }
  res.json(tmpl);
});

// DELETE /organizations/:orgId/templates/:id — delete a template
templatesRouter.delete("/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));

  const result = await db.delete(messageTemplatesTable)
    .where(and(eq(messageTemplatesTable.id, id), eq(messageTemplatesTable.organizationId, orgId)))
    .returning({ id: messageTemplatesTable.id });

  if (result.length === 0) { res.status(404).json({ error: "Template not found" }); return; }
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════════
   AUTOMATION RULES
   ═══════════════════════════════════════════════════════════════ */

export const automationRulesRouter = Router({ mergeParams: true });

function substituteMergeTags(
  text: string,
  vars: { playerName?: string; tournamentName?: string; leagueName?: string; teeTime?: string; drawLink?: string; resultsLink?: string; orgName?: string },
): string {
  return text
    .replace(/\{\{player_name\}\}/gi, vars.playerName ?? "Golfer")
    .replace(/\{\{tournament_name\}\}/gi, vars.tournamentName ?? "")
    .replace(/\{\{league_name\}\}/gi, vars.leagueName ?? "")
    .replace(/\{\{tee_time\}\}/gi, vars.teeTime ?? "")
    .replace(/\{\{draw_link\}\}/gi, vars.drawLink ?? "#")
    .replace(/\{\{results_link\}\}/gi, vars.resultsLink ?? "#")
    .replace(/\{\{org_name\}\}/gi, vars.orgName ?? "KHARAGOLF");
}

const PRE_BUILT_TEMPLATES = [
  {
    id: "draw_published",
    name: "Draw Published Notification",
    triggerType: "draw_published",
    triggerParams: {},
    channel: "email",
    audienceFilter: { type: "all_registrants" },
    subject: "Tee Times are Published — {{tournament_name}}",
    body: "Hi {{player_name}},\n\nThe draw for {{tournament_name}} has been published! Check your tee time and playing partners here: {{draw_link}}\n\nSee you on the course!",
  },
  {
    id: "payment_reminder",
    name: "Payment Reminder",
    triggerType: "registration_deadline",
    triggerParams: { value: 3, unit: "days" },
    channel: "email",
    audienceFilter: { type: "unpaid_registrants" },
    subject: "Action Required: Complete Your Payment — {{tournament_name}}",
    body: "Hi {{player_name}},\n\nYour registration for {{tournament_name}} is not yet complete. Please complete your payment to secure your spot — the deadline is approaching in 3 days.\n\nContact your club if you have any questions.",
  },
  {
    id: "results_summary",
    name: "Results Summary",
    triggerType: "event_closed",
    triggerParams: {},
    channel: "email",
    audienceFilter: { type: "all_registrants" },
    subject: "Final Results — {{tournament_name}}",
    body: "Hi {{player_name}},\n\n{{tournament_name}} has concluded. Thank you for participating!\n\nView the final results and leaderboard here: {{results_link}}\n\nWe hope to see you at our next event.",
  },
  {
    id: "event_reminder_24h",
    name: "Event Start Reminder (24h)",
    triggerType: "event_starts",
    triggerParams: { value: 24, unit: "hours" },
    channel: "email",
    audienceFilter: { type: "all_registrants" },
    subject: "Reminder: {{tournament_name}} starts tomorrow",
    body: "Hi {{player_name}},\n\n{{tournament_name}} starts in 24 hours. Your tee time is {{tee_time}}.\n\nPlease arrive at least 30 minutes before your tee time. Good luck!",
  },
  {
    id: "registration_deadline_reminder",
    name: "Registration Deadline Reminder",
    triggerType: "registration_deadline",
    triggerParams: { value: 7, unit: "days" },
    channel: "email",
    audienceFilter: { type: "all_members" },
    subject: "Registration closes soon — {{tournament_name}}",
    body: "Hi {{player_name}},\n\nDon't miss out! Registration for {{tournament_name}} closes in 7 days. Reserve your spot now.\n\nContact your club admin or visit the player portal to register.",
  },
];

// GET /organizations/:orgId/automation-rules
automationRulesRouter.get("/", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = req.query.tournamentId ? parseInt(req.query.tournamentId as string) : null;
  const leagueId = req.query.leagueId ? parseInt(req.query.leagueId as string) : null;

  const conditions = [eq(automationRulesTable.orgId, orgId)];
  if (tournamentId) conditions.push(eq(automationRulesTable.tournamentId, tournamentId));
  if (leagueId) conditions.push(eq(automationRulesTable.leagueId, leagueId));

  const rules = await db.select().from(automationRulesTable).where(and(...conditions)).orderBy(desc(automationRulesTable.createdAt));
  res.json(rules);
});

// GET /organizations/:orgId/automation-rules/templates — list pre-built templates
automationRulesRouter.get("/templates", async (_req, res) => {
  res.json(PRE_BUILT_TEMPLATES);
});

// POST /organizations/:orgId/automation-rules
automationRulesRouter.post("/", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { name, triggerType, triggerParams, channel, audienceFilter, subject, body, tournamentId, leagueId, isActive } = req.body;

  if (!name || !triggerType || !channel || !body) {
    res.status(400).json({ error: "name, triggerType, channel, and body are required" }); return;
  }

  if (!tournamentId && !leagueId) {
    res.status(400).json({ error: "Either tournamentId or leagueId must be provided" }); return;
  }

  if (tournamentId) {
    const [t] = await db.select({ id: tournamentsTable.id }).from(tournamentsTable)
      .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
    if (!t) { res.status(403).json({ error: "Tournament does not belong to this organization" }); return; }
  }

  if (leagueId) {
    const [l] = await db.select({ id: leaguesTable.id }).from(leaguesTable)
      .where(and(eq(leaguesTable.id, leagueId), eq(leaguesTable.organizationId, orgId)));
    if (!l) { res.status(403).json({ error: "League does not belong to this organization" }); return; }
  }

  const [rule] = await db.insert(automationRulesTable).values({
    orgId,
    tournamentId: tournamentId ?? null,
    leagueId: leagueId ?? null,
    name,
    triggerType,
    triggerParams: triggerParams ?? null,
    channel,
    audienceFilter: audienceFilter ?? { type: "all_registrants" },
    subject: subject ?? null,
    body,
    isActive: isActive ?? true,
  }).returning();

  res.status(201).json(rule);
});

// PUT /organizations/:orgId/automation-rules/:ruleId
automationRulesRouter.put("/:ruleId", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const ruleId = parseInt(String((req.params as Record<string, string>).ruleId));
  const { name, triggerType, triggerParams, channel, audienceFilter, subject, body, isActive } = req.body;

  const [rule] = await db.update(automationRulesTable)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(triggerType !== undefined ? { triggerType } : {}),
      ...(triggerParams !== undefined ? { triggerParams } : {}),
      ...(channel !== undefined ? { channel } : {}),
      ...(audienceFilter !== undefined ? { audienceFilter } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(automationRulesTable.id, ruleId), eq(automationRulesTable.orgId, orgId)))
    .returning();

  if (!rule) { res.status(404).json({ error: "Rule not found" }); return; }
  res.json(rule);
});

// DELETE /organizations/:orgId/automation-rules/:ruleId
automationRulesRouter.delete("/:ruleId", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const ruleId = parseInt(String((req.params as Record<string, string>).ruleId));

  const result = await db.delete(automationRulesTable)
    .where(and(eq(automationRulesTable.id, ruleId), eq(automationRulesTable.orgId, orgId)))
    .returning({ id: automationRulesTable.id });

  if (result.length === 0) { res.status(404).json({ error: "Rule not found" }); return; }
  res.json({ ok: true });
});

// GET /organizations/:orgId/automation-rules/:ruleId/logs
automationRulesRouter.get("/:ruleId/logs", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const ruleId = parseInt(String((req.params as Record<string, string>).ruleId));

  const [rule] = await db.select({ id: automationRulesTable.id })
    .from(automationRulesTable)
    .where(and(eq(automationRulesTable.id, ruleId), eq(automationRulesTable.orgId, orgId)));
  if (!rule) { res.status(404).json({ error: "Rule not found" }); return; }

  const logs = await db.select().from(automationRuleLogsTable)
    .where(eq(automationRuleLogsTable.ruleId, ruleId))
    .orderBy(desc(automationRuleLogsTable.triggeredAt))
    .limit(100);
  res.json(logs);
});

// POST /organizations/:orgId/automation-rules/:ruleId/retry — immediate re-delivery to full audience
automationRulesRouter.post("/:ruleId/retry", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const ruleId = parseInt(String((req.params as Record<string, string>).ruleId));

  const [rule] = await db.select().from(automationRulesTable)
    .where(and(eq(automationRulesTable.id, ruleId), eq(automationRulesTable.orgId, orgId)));
  if (!rule) { res.status(404).json({ error: "Rule not found" }); return; }

  const [org] = await db.select({ name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));

  let tournamentName = "";
  let leagueName = "";
  let startDate: Date | null = null;

  if (rule.tournamentId) {
    const [t] = await db.select({ name: tournamentsTable.name, startDate: tournamentsTable.startDate })
      .from(tournamentsTable).where(eq(tournamentsTable.id, rule.tournamentId));
    tournamentName = t?.name ?? "";
    startDate = t?.startDate ?? null;
  } else if (rule.leagueId) {
    const [l] = await db.select({ name: leaguesTable.name, seasonStart: leaguesTable.seasonStart })
      .from(leaguesTable).where(eq(leaguesTable.id, rule.leagueId));
    leagueName = l?.name ?? "";
    startDate = l?.seasonStart ?? null;
  }

  const audience = (rule.audienceFilter as { type: string; flightId?: number } | null) ?? { type: "all_registrants" };
  let recipients: { name: string; email: string | null; userId: number | null }[] = [];

  if (rule.tournamentId) {
    const allPlayers = await db
      .select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName, email: playersTable.email, userId: playersTable.userId, paymentStatus: playersTable.paymentStatus })
      .from(playersTable).where(eq(playersTable.tournamentId, rule.tournamentId));

    let filtered = allPlayers;
    if (audience.type === "unpaid_registrants") {
      filtered = allPlayers.filter(p => p.paymentStatus === "unpaid" || p.paymentStatus === "pending");
    } else if (audience.type === "specific_flight" && audience.flightId) {
      const flightPlayerIds = await db.select({ playerId: playerFlightsTable.playerId })
        .from(playerFlightsTable).where(eq(playerFlightsTable.flightId, audience.flightId));
      const idSet = new Set(flightPlayerIds.map(fp => fp.playerId));
      filtered = allPlayers.filter(p => idSet.has(p.id));
    } else if (audience.type === "all_members") {
      const orgMembers = await db.select({ email: appUsersTable.email, id: appUsersTable.id, displayName: appUsersTable.displayName })
        .from(orgMembershipsTable)
        .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
        .where(eq(orgMembershipsTable.organizationId, orgId));
      recipients = orgMembers.filter(m => m.email).map(m => ({ name: m.displayName ?? m.email!, email: m.email!, userId: m.id }));
    }
    if (audience.type !== "all_members") {
      recipients = filtered.map(p => ({ name: `${p.firstName} ${p.lastName}`, email: p.email ?? null, userId: p.userId ?? null }));
    }
  } else if (rule.leagueId) {
    const allMembers = await db
      .select({ firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName, email: leagueMembersTable.email, userId: leagueMembersTable.userId, paymentStatus: leagueMembersTable.paymentStatus })
      .from(leagueMembersTable).where(eq(leagueMembersTable.leagueId, rule.leagueId));
    let filtered = allMembers;
    if (audience.type === "unpaid_registrants") {
      filtered = allMembers.filter(m => m.paymentStatus === "unpaid" || m.paymentStatus === "pending");
    }
    recipients = filtered.map(m => ({ name: `${m.firstName} ${m.lastName}`, email: m.email ?? null, userId: m.userId ?? null }));
  }

  if (recipients.length === 0) {
    res.status(400).json({ error: "No recipients found for this rule's audience filter" }); return;
  }

  const baseUrl = process.env.PUBLIC_BASE_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`;
  let deliveredCount = 0;
  let failedCount = 0;

  for (const recipient of recipients) {
    const vars = {
      playerName: recipient.name,
      tournamentName,
      leagueName,
      teeTime: startDate ? new Date(startDate).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }) : "",
      drawLink: rule.tournamentId ? `${baseUrl}/leaderboard/${rule.tournamentId}` : "#",
      resultsLink: rule.tournamentId ? `${baseUrl}/leaderboard/${rule.tournamentId}` : (rule.leagueId ? `${baseUrl}/leagues/${rule.leagueId}` : "#"),
      orgName: org?.name ?? "KHARAGOLF",
    };
    const subject = rule.subject ? substituteMergeTags(rule.subject, vars) : `[RETRY] ${rule.name}`;
    const body = substituteMergeTags(rule.body, vars);
    try {
      if (rule.channel === "email" && recipient.email) {
        await sendBroadcastEmail(recipient.email, vars.playerName, subject, body, vars.orgName, {
          // Task #1566 — tag automation-retry emails with the originating
          // club so the Postmark bounce webhook (Task #981) can attribute
          // hard bounces back to this org instantly.
          orgId,
        });
        deliveredCount++;
      } else if (rule.channel === "push" && recipient.userId) {
        // Task #1240 — route through `classifyPushDelivery` so a recipient
        // with no registered Expo token does not silently inflate
        // `deliveredCount`. Only `"sent"` counts as delivered; both
        // `"failed"` and `"no_address"` count as failed for accounting.
        const cls = classifyPushDelivery(
          await sendTransactionalPush([recipient.userId], subject, body.slice(0, 150), { type: "automation_retry", ruleId }),
        );
        if (cls === "sent") deliveredCount++;
        else failedCount++;
      } else {
        failedCount++;
      }
    } catch {
      failedCount++;
    }
  }

  await db.insert(automationRuleLogsTable).values({
    ruleId,
    triggeredAt: new Date(),
    audienceSize: recipients.length,
    deliveredCount,
    failedCount,
    status: failedCount === recipients.length ? "failed" : failedCount > 0 ? "partial" : "completed",
  });

  res.json({ ok: true, audienceSize: recipients.length, deliveredCount, failedCount });
});

// POST /organizations/:orgId/automation-rules/:ruleId/test — test-send to the requester
automationRulesRouter.post("/:ruleId/test", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const ruleId = parseInt(String((req.params as Record<string, string>).ruleId));
  const user = getUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const [rule] = await db.select().from(automationRulesTable)
    .where(and(eq(automationRulesTable.id, ruleId), eq(automationRulesTable.orgId, orgId)));
  if (!rule) { res.status(404).json({ error: "Rule not found" }); return; }

  const [org] = await db.select({ name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));

  const [adminUser] = await db.select({ email: appUsersTable.email, displayName: appUsersTable.displayName })
    .from(appUsersTable).where(eq(appUsersTable.id, user.id));

  if (!adminUser?.email) {
    res.status(400).json({ error: "No email address on your account. Cannot send test." }); return;
  }

  const vars = {
    playerName: adminUser.displayName ?? user.username,
    orgName: org?.name ?? "KHARAGOLF",
    tournamentName: "[Tournament Name]",
    leagueName: "[League Name]",
    teeTime: "9:00 AM",
    drawLink: "#",
    resultsLink: "#",
  };

  const subject = rule.subject ? substituteMergeTags(rule.subject, vars) : `[TEST] ${rule.name}`;
  const body = substituteMergeTags(rule.body, vars);

  try {
    if (rule.channel === "email") {
      await sendBroadcastEmail(adminUser.email, vars.playerName, `[TEST] ${subject}`, body, org?.name ?? "KHARAGOLF", {
        // Task #1566 — tag automation-rule test sends with the originating
        // club so the Postmark bounce webhook (Task #981) can attribute
        // hard bounces back to this org instantly. Test sends go to the
        // admin's own inbox but still need the tag so any bounce surfaces
        // under the right club in the Suppressions tab.
        orgId,
      });
      res.json({ ok: true, sentTo: adminUser.email });
    } else if (rule.channel === "push") {
      // Task #1240 — surface delivery classification to the admin so a
      // "test push" with no registered Expo token does not falsely look
      // delivered. The earlier `await ...; res.json({ok:true})` reported
      // success even when nothing was actually sent (Task #1070 surface).
      const cls = classifyPushDelivery(
        await sendTransactionalPush([user.id], `[TEST] ${subject}`, body.slice(0, 150), { type: "automation_test", ruleId }),
      );
      if (cls === "sent") {
        res.json({ ok: true, sentTo: "push notification", classification: cls });
      } else {
        res.status(422).json({
          error: cls === "no_address"
            ? "No registered device. Open the mobile app at least once to register a push token, then try again."
            : "Push provider rejected the test message. Check device logs and try again.",
          classification: cls,
        });
      }
    } else if (rule.channel === "sms" || rule.channel === "whatsapp") {
      res.status(422).json({ error: `${rule.channel.toUpperCase()} channel is not yet integrated. Please use email or push notifications.` });
    } else {
      res.status(422).json({ error: `Unsupported channel: ${rule.channel}` });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Failed to send test: ${msg}` });
  }
});
