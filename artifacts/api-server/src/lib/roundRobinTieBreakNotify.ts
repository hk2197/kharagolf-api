/**
 * Round-robin tie-break required notification (Task #743).
 *
 * Fired the moment `maybeFinalizeRoundRobin` (in routes/match-play.ts)
 * generates a fresh tie-break match because the top of a round-robin
 * standings list is tied. Without this, tournament directors and the
 * tied players only learn there is a playoff to resolve by manually
 * refreshing the bracket page.
 *
 * Recipients:
 *   - Tournament directors / org admins for the tournament's organization
 *     (every appUser with role tournament_director or org_admin in
 *     orgMembershipsTable for that org).
 *   - The two tied players, when they have a linked appUser
 *     (playersTable.userId).
 *
 * Channels (per recipient, best-effort, isolated):
 *   - Push (sendPushToUsers) — fans out to registered Expo tokens. Honours
 *     the recipient's userNotificationPrefsTable.preferPush flag.
 *   - In-app inbox row (memberMessagesTable) — only for recipients who have
 *     an active club_members row in the tournament's organization, since
 *     the inbox is keyed off clubMemberId. Cross-club guests still get the
 *     push.
 *   - Email (sendRoundRobinTieBreakAlertEmail) — only sent to the
 *     director/admin recipients (Task #898), so directors who don't have
 *     the mobile app installed still get a durable notice. Honours
 *     userNotificationPrefsTable.preferEmail and, when the director is also
 *     a club_members row in the tournament's organization, the per-category
 *     memberCommPrefs `tournaments` toggle. Bounces are logged via
 *     logger.warn the same way every other transactional email helper does.
 *
 * Push payload deep-links straight to the tie-break match:
 *   data.type         = "round_robin_tie_break_required"
 *   data.tournamentId = number
 *   data.bracketId    = number
 *   data.matchId      = number  (the new tie-break match)
 *   data.organizationId = number
 *
 * Fire-and-forget: failures are logged but never thrown — the tie-break
 * match itself has already been created.
 */
import { db } from "@workspace/db";
import {
  tournamentsTable,
  playersTable,
  orgMembershipsTable,
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberCommPrefsTable,
  userNotificationPrefsTable,
  memberMessagesTable,
  roundRobinTieBreakEmailOptOutsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { sendPushToUsers } from "./push";
import { sendRoundRobinTieBreakAlertEmail, classifyMailerError, type EmailBranding } from "./mailer";
import { signTieBreakEmailOptOutToken } from "./bouncedDigestUnsubscribe";
import { logger } from "./logger";

export interface TieBreakNotifyResult {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  recipients: number[];
  push: { attempted: number; sent: number };
  inApp: { written: number };
  email: { attempted: number; sent: number; bounced: number };
}

export interface TieBreakNotifyInput {
  bracketId: number;
  tournamentId: number;
  tieBreakMatchId: number;
  player1Id: number | null;
  player2Id: number | null;
}

export async function notifyRoundRobinTieBreak(
  input: TieBreakNotifyInput,
): Promise<TieBreakNotifyResult> {
  const result: TieBreakNotifyResult = {
    status: "skipped",
    recipients: [],
    push: { attempted: 0, sent: 0 },
    inApp: { written: 0 },
    email: { attempted: 0, sent: 0, bounced: 0 },
  };

  let tournament: typeof tournamentsTable.$inferSelect | undefined;
  try {
    const [row] = await db.select().from(tournamentsTable)
      .where(eq(tournamentsTable.id, input.tournamentId)).limit(1);
    tournament = row;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ ...input, errMsg: reason }, "[rr-tiebreak-notify] failed to load tournament");
    result.status = "failed";
    result.reason = reason;
    return result;
  }
  if (!tournament) {
    result.reason = "tournament_not_found";
    return result;
  }
  const orgId = tournament.organizationId;

  // ── Resolve recipient userIds ───────────────────────────────────────
  const recipientIds = new Set<number>();
  const directorIds = new Set<number>();

  try {
    const directors = await db
      .select({ userId: orgMembershipsTable.userId })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, orgId),
        inArray(orgMembershipsTable.role, ["tournament_director", "org_admin"]),
      ));
    for (const d of directors) {
      recipientIds.add(d.userId);
      directorIds.add(d.userId);
    }
  } catch (err) {
    logger.warn({ ...input, err }, "[rr-tiebreak-notify] failed to load directors");
  }

  const playerIds = [input.player1Id, input.player2Id].filter((x): x is number => x != null);
  if (playerIds.length > 0) {
    try {
      const linked = await db
        .select({ userId: playersTable.userId })
        .from(playersTable)
        .where(inArray(playersTable.id, playerIds));
      for (const l of linked) {
        if (l.userId != null) recipientIds.add(l.userId);
      }
    } catch (err) {
      logger.warn({ ...input, err }, "[rr-tiebreak-notify] failed to load tied players");
    }
  }

  if (recipientIds.size === 0) {
    result.reason = "no_recipients";
    return result;
  }
  result.recipients = Array.from(recipientIds);

  const tName = tournament.name?.trim() || "Round-robin tournament";
  const title = "Round-robin tie-break required";
  const body = `Top of the standings is tied in ${tName}. Tap to play the tie-break match.`;
  const data = {
    type: "round_robin_tie_break_required",
    tournamentId: input.tournamentId,
    bracketId: input.bracketId,
    matchId: input.tieBreakMatchId,
    organizationId: orgId,
  };

  // ── In-app inbox rows (per-recipient, only club members of this org) ──
  try {
    const members = await db
      .select({ id: clubMembersTable.id, userId: clubMembersTable.userId })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, orgId),
        inArray(clubMembersTable.userId, result.recipients),
      ));
    for (const m of members) {
      try {
        await db.insert(memberMessagesTable).values({
          organizationId: orgId,
          clubMemberId: m.id,
          channel: "in_app",
          subject: title,
          body,
          status: "sent",
          relatedEntity: "round_robin_tie_break",
          relatedEntityId: input.tieBreakMatchId,
        });
        result.inApp.written += 1;
      } catch (err) {
        logger.warn({ ...input, userId: m.userId, err }, "[rr-tiebreak-notify] in-app insert failed");
      }
    }
  } catch (err) {
    logger.warn({ ...input, err }, "[rr-tiebreak-notify] club_members lookup failed");
  }

  // ── Per-user channel preferences (push + email) ─────────────────────
  const pushOptedOut = new Set<number>();
  const emailOptedOut = new Set<number>();
  try {
    const prefs = await db
      .select({
        userId: userNotificationPrefsTable.userId,
        preferPush: userNotificationPrefsTable.preferPush,
        preferEmail: userNotificationPrefsTable.preferEmail,
      })
      .from(userNotificationPrefsTable)
      .where(inArray(userNotificationPrefsTable.userId, result.recipients));
    for (const p of prefs) {
      if (p.preferPush === false) pushOptedOut.add(p.userId);
      if (p.preferEmail === false) emailOptedOut.add(p.userId);
    }
  } catch (err) {
    logger.warn({ ...input, err }, "[rr-tiebreak-notify] failed to read prefs; sending to all");
  }
  const pushTargets = result.recipients.filter(id => !pushOptedOut.has(id));

  // ── Email to tournament directors / org admins ───────────────────────
  // Uses the same opt-out preferences as the rest of the user_notification_prefs
  // record (preferEmail) and, when the director is also a club_member of the
  // tournament's organization, the per-category memberCommPrefs `tournament`
  // toggle. Bounces are logged via logger.warn the same way every other
  // transactional email helper records delivery failures.
  const directorRecipientIds = result.recipients.filter(id => directorIds.has(id));
  if (directorRecipientIds.length > 0) {
    try {
      // Resolve org branding (best-effort).
      let branding: EmailBranding = { orgName: "KHARAGOLF" };
      try {
        const [org] = await db.select({
          name: organizationsTable.name,
          logoUrl: organizationsTable.logoUrl,
          primaryColor: organizationsTable.primaryColor,
        }).from(organizationsTable).where(eq(organizationsTable.id, orgId)).limit(1);
        if (org) {
          branding = {
            orgName: org.name ?? "KHARAGOLF",
            logoUrl: org.logoUrl ?? undefined,
            primaryColor: org.primaryColor ?? undefined,
          };
        }
      } catch (err) {
        logger.warn({ ...input, err }, "[rr-tiebreak-notify] failed to load org branding for email");
      }

      // Per-category opt-out: if the director has a club_members row in the
      // tournament's org and explicitly disabled the `tournament` email
      // category, skip them.
      const memberCategoryOptedOut = new Set<number>();
      try {
        const memberRows = await db.select({
          memberId: clubMembersTable.id,
          userId: clubMembersTable.userId,
        }).from(clubMembersTable).where(and(
          eq(clubMembersTable.organizationId, orgId),
          inArray(clubMembersTable.userId, directorRecipientIds),
        ));
        const memberIdToUserId = new Map<number, number>();
        const memberIds: number[] = [];
        for (const m of memberRows) {
          if (m.userId == null) continue;
          memberIdToUserId.set(m.memberId, m.userId);
          memberIds.push(m.memberId);
        }
        if (memberIds.length > 0) {
          const catPrefs = await db.select({
            clubMemberId: memberCommPrefsTable.clubMemberId,
            category: memberCommPrefsTable.category,
            emailEnabled: memberCommPrefsTable.emailEnabled,
          }).from(memberCommPrefsTable).where(and(
            inArray(memberCommPrefsTable.clubMemberId, memberIds),
            eq(memberCommPrefsTable.category, "tournaments"),
          ));
          for (const c of catPrefs) {
            if (!c.emailEnabled) {
              const uid = memberIdToUserId.get(c.clubMemberId);
              if (uid != null) memberCategoryOptedOut.add(uid);
            }
          }
        }
      } catch (err) {
        logger.warn({ ...input, err }, "[rr-tiebreak-notify] failed to read member comm prefs; defaulting to opted-in");
      }

      // Task #1045 — per-(org, user) one-click opt-out from the tie-break
      // email specifically. Unlike `preferEmail` (silences ALL transactional
      // mail) or the per-category `tournaments` member-comm pref (only
      // available for club_members), this opt-out is scoped to this single
      // email type and works for any director regardless of membership.
      const tieBreakEmailOptedOut = new Set<number>();
      try {
        const optOutRows = await db.select({
          userId: roundRobinTieBreakEmailOptOutsTable.userId,
        }).from(roundRobinTieBreakEmailOptOutsTable).where(and(
          eq(roundRobinTieBreakEmailOptOutsTable.organizationId, orgId),
          inArray(roundRobinTieBreakEmailOptOutsTable.userId, directorRecipientIds),
        ));
        for (const r of optOutRows) tieBreakEmailOptedOut.add(r.userId);
      } catch (err) {
        logger.warn({ ...input, err }, "[rr-tiebreak-notify] failed to read tie-break email opt-outs; defaulting to opted-in");
      }

      // Resolve email + display name for each director.
      const emailTargets = directorRecipientIds.filter(id =>
        !emailOptedOut.has(id) && !memberCategoryOptedOut.has(id) && !tieBreakEmailOptedOut.has(id));
      let users: Array<{ id: number; email: string | null; displayName: string | null; username: string | null; preferredLanguage: string | null }> = [];
      if (emailTargets.length > 0) {
        try {
          users = await db.select({
            id: appUsersTable.id,
            email: appUsersTable.email,
            displayName: appUsersTable.displayName,
            username: appUsersTable.username,
            // Task #1044 — render the email in each director's preferred language.
            preferredLanguage: appUsersTable.preferredLanguage,
          }).from(appUsersTable).where(inArray(appUsersTable.id, emailTargets));
        } catch (err) {
          logger.warn({ ...input, err }, "[rr-tiebreak-notify] failed to load director emails");
        }
      }
      const baseUrl = process.env.APP_BASE_URL
        ?? process.env.PUBLIC_BASE_URL
        ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "app.kharagolf.com"}`;
      const matchUrl = `${baseUrl}/tournaments/${input.tournamentId}/brackets/${input.bracketId}/matches/${input.tieBreakMatchId}`;
      for (const u of users) {
        if (!u.email) continue;
        result.email.attempted += 1;
        // Per-recipient signed token so a click from this user's inbox can
        // only opt this user (and only this org) out — never any other user.
        const token = signTieBreakEmailOptOutToken(u.id, orgId);
        const unsubscribeUrl = `${baseUrl}/api/public/tie-break-email-unsubscribe?token=${encodeURIComponent(token)}`;
        try {
          await sendRoundRobinTieBreakAlertEmail({
            to: u.email,
            recipientName: (u.displayName ?? u.username ?? "").trim(),
            tournamentName: tName,
            matchUrl,
            branding,
            // Task #1044 — render the email in the director's preferred language.
            lang: u.preferredLanguage,
            unsubscribeUrl,
          });
          result.email.sent += 1;
        } catch (err) {
          // Provider misconfiguration is an env-wide condition, not a
          // per-recipient bounce — every subsequent send in this loop
          // will throw the same way. Skip the rest silently so the
          // tournament-director log dashboard isn't billed N warnings
          // for the same env issue.
          if (classifyMailerError(err) === "provider_unconfigured") {
            result.email.attempted -= 1;
            break;
          }
          result.email.bounced += 1;
          const reason = err instanceof Error ? err.message : String(err);
          logger.warn({
            ...input, userId: u.id, email: u.email, errMsg: reason,
          }, "[rr-tiebreak-notify] email delivery failed");
        }
      }
    } catch (err) {
      logger.warn({ ...input, err }, "[rr-tiebreak-notify] email fan-out failed");
    }
  }

  if (pushTargets.length > 0) {
    try {
      const push = await sendPushToUsers(pushTargets, title, body, data);
      result.push.attempted = push.attempted;
      result.push.sent = push.sent;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ ...input, errMsg: reason }, "[rr-tiebreak-notify] push delivery failed");
      result.status = "failed";
      result.reason = reason;
      return result;
    }
  }

  if (result.push.sent > 0 || result.inApp.written > 0 || result.email.sent > 0) {
    result.status = "sent";
  }
  return result;
}
