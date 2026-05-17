/**
 * Admin re-subscribe notifications (Tasks #1401, #1692, #1693).
 *
 * Task #1208 lets an org_admin / tournament_director clear another member's
 * tie-break email opt-out via DELETE /api/organizations/:orgId/tie-break-
 * email-opt-outs/:userId. Today this happens silently, so a director who
 * deliberately unsubscribed will start receiving the emails again with no
 * explanation. The bounced-digest schedule-change DELETE handler (Task #512)
 * has the same gap.
 *
 * After a successful admin re-subscribe, drop a low-key in-app inbox row on
 * the affected user telling them who acted, from which org, and giving them
 * a one-click link to opt back out — using the same HMAC-signed unsubscribe
 * token the email helpers already use, so the recipient can re-silence the
 * email without involving any admin.
 *
 * Task #1692 adds an email channel alongside the inbox row so a director who
 * only checks email (and never opens the mobile app) still gets a heads-up
 * with the same one-click unsubscribe link. The email is best-effort —
 * delivery failures are logged but never fail the surrounding DELETE.
 *
 * Mirrors the in-app insert pattern used by other admin-side notifications
 * (e.g. coachPayoutAccountChangeNotify, roundRobinTieBreakNotify):
 *   - The inbox row is keyed off `clubMemberId`, so we only write it when
 *     the affected user has an active club_members row in the org. The
 *     email is independent of that and fires whenever the user has an
 *     address on file.
 *   - Failures are logged but never thrown; the DELETE has already
 *     committed by the time we run, so a delivery glitch must not roll
 *     it back or 500 the API call.
 *
 * Off-club director fallback (Task #1693):
 *   A tournament_director who manages an org but doesn't have a
 *   `club_members` row in it would otherwise get no in-app signal at all
 *   that their opt-out has been cleared. To match the
 *   `notifyRoundRobinTieBreak` helper (which fans out a push to any
 *   director regardless of membership), the no-club-member branch also
 *   sends a push notification via `sendPushToUsers`. The push payload
 *   deep-links to the user's notification preferences screen and reminds
 *   them they can opt back out from there. Push delivery honours
 *   `userNotificationPrefsTable.preferPush` (default true) like every
 *   other notify helper in this directory. The transactional email
 *   from #1692 still fires on this path too — it doesn't depend on
 *   club membership.
 *
 * Real-time heads-up for in-club directors (Task #2115):
 *   Even when the affected user IS a club_member of the org (so the
 *   inbox row from #1401 + the email from #1692 already fire), we now
 *   also send the same push notification so directors who rely on push
 *   or who don't routinely check email get a real-time signal that
 *   their alerts have been re-enabled. Push delivery is best-effort
 *   and gated by:
 *     - `userNotificationPrefsTable.preferPush` (default true), AND
 *     - for the tie-break flow, the per-category
 *       `memberCommPrefs.tournaments.pushEnabled` toggle — mirroring
 *       the email gate that already honours the same row's
 *       `emailEnabled` field. The bounced-digest flow has no per-
 *       category gate (consistent with its email leg).
 *   A push delivery failure never blocks the inbox row, the email,
 *   or the surrounding DELETE 204.
 */
import { db } from "@workspace/db";
import {
  appUsersTable,
  clubMembersTable,
  memberCommPrefsTable,
  memberMessagesTable,
  organizationsTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  signBouncedDigestScheduleOptOutToken,
  signTieBreakEmailOptOutToken,
} from "./bouncedDigestUnsubscribe";
import { logger } from "./logger";
import { classifyPushDelivery, sendPushToUsers, type PushDeliveryStatus } from "./push";
import {
  sendAdminResubscribedAlertEmail,
  classifyMailerError,
  type EmailBranding,
} from "./mailer";

export type AdminResubscribeChannelStatus =
  | "sent"
  | "skipped"
  | "failed"
  | "opted_out"
  | "no_address";

export interface AdminResubscribeNotifyResult {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  messageId?: number;
  /**
   * Set when the recipient had no `club_members` row in the org and we
   * fell back to a push notification instead of writing an inbox row.
   * Mirrors the per-channel breakdown the other notify helpers expose.
   */
  push?: {
    status: PushDeliveryStatus | "opted_out";
    attempted: number;
    sent: number;
  };
  email: { status: AdminResubscribeChannelStatus; error?: string };
}

interface ActorLike {
  id: number;
  displayName?: string | null;
  username?: string | null;
  email?: string | null;
}

function baseUrl(): string {
  return (
    process.env.APP_BASE_URL
    ?? process.env.PUBLIC_BASE_URL
    ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`
  ).replace(/\/$/, "");
}

function actorName(actor: ActorLike): string {
  return (actor.displayName ?? actor.username ?? actor.email ?? "An administrator").trim()
    || "An administrator";
}

interface OrgInfo {
  name: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
}

async function loadOrg(orgId: number): Promise<OrgInfo | null> {
  try {
    const [org] = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId))
      .limit(1);
    return org ?? null;
  } catch (err) {
    logger.warn({ err, orgId }, "[admin-resubscribe-notify] failed to load org");
    return null;
  }
}

interface AffectedUserProfile {
  email: string | null;
  displayName: string | null;
  username: string | null;
  clubMemberId: number | null;
  preferEmail: boolean;
  /** Set only when the caller asks for a per-category memberCommPrefs check. */
  categoryEmailEnabled: boolean;
  /**
   * Task #2114 — Director's preferred email language
   * (`appUsersTable.preferredLanguage`). Forwarded to the localised
   * `sendAdminResubscribedAlertEmail` so the subject/heading/body
   * render in the recipient's language; English is the canonical
   * fallback when null/unsupported.
   */
  preferredLanguage: string | null;
  /**
   * Per-category push toggle from the same `memberCommPrefs` row that
   * gates `categoryEmailEnabled`. Mirrors `pushEnabled` on the
   * tournaments row for the tie-break flow; the bounced-digest flow
   * passes a null `category` so this stays at its default `true` and
   * has no effect.
   */
  categoryPushEnabled: boolean;
}

async function loadAffectedUser(
  orgId: number,
  userId: number,
  category: string | null,
): Promise<AffectedUserProfile> {
  const profile: AffectedUserProfile = {
    email: null,
    displayName: null,
    username: null,
    clubMemberId: null,
    preferEmail: true,
    categoryEmailEnabled: true,
    preferredLanguage: null,
    categoryPushEnabled: true,
  };

  try {
    const [u] = await db.select({
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      // Task #2114 — director's preferred email language; forwarded to
      // sendAdminResubscribedAlertEmail so the email renders in their
      // language. English is the canonical fallback when null.
      preferredLanguage: appUsersTable.preferredLanguage,
    })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, userId))
      .limit(1);
    if (u) {
      profile.email = u.email ?? null;
      profile.displayName = u.displayName ?? null;
      profile.username = u.username ?? null;
      profile.preferredLanguage = u.preferredLanguage ?? null;
    }
  } catch (err) {
    logger.warn({ err, orgId, userId }, "[admin-resubscribe-notify] failed to load affected user");
  }

  try {
    const [m] = await db.select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, orgId),
        eq(clubMembersTable.userId, userId),
      ))
      .limit(1);
    if (m) profile.clubMemberId = m.id;
  } catch (err) {
    logger.warn({ err, orgId, userId }, "[admin-resubscribe-notify] club_members lookup failed");
  }

  try {
    const [p] = await db.select({ preferEmail: userNotificationPrefsTable.preferEmail })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, userId))
      .limit(1);
    if (p && p.preferEmail === false) profile.preferEmail = false;
  } catch (err) {
    logger.warn({ err, orgId, userId }, "[admin-resubscribe-notify] failed to read user notification prefs");
  }

  if (category && profile.clubMemberId != null) {
    try {
      const [c] = await db.select({
        emailEnabled: memberCommPrefsTable.emailEnabled,
        pushEnabled: memberCommPrefsTable.pushEnabled,
      })
        .from(memberCommPrefsTable)
        .where(and(
          eq(memberCommPrefsTable.clubMemberId, profile.clubMemberId),
          eq(memberCommPrefsTable.category, category),
        ))
        .limit(1);
      if (c && c.emailEnabled === false) profile.categoryEmailEnabled = false;
      if (c && c.pushEnabled === false) profile.categoryPushEnabled = false;
    } catch (err) {
      logger.warn({ err, orgId, userId, category }, "[admin-resubscribe-notify] failed to read member comm prefs");
    }
  }

  return profile;
}

async function loadActor(actor: ActorLike): Promise<ActorLike> {
  // The auth user attached to the request only carries the strict AuthUser
  // shape (no email guaranteed). Backfill from app_users so the inbox row
  // can show a friendly display name even when the request user object
  // lacks one.
  if (actor.displayName && actor.displayName.trim() !== "") return actor;
  try {
    const [row] = await db.select({
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      email: appUsersTable.email,
    }).from(appUsersTable).where(eq(appUsersTable.id, actor.id)).limit(1);
    if (row) {
      return {
        id: actor.id,
        displayName: actor.displayName ?? row.displayName,
        username: actor.username ?? row.username,
        email: actor.email ?? row.email,
      };
    }
  } catch (err) {
    logger.warn({ err, actorId: actor.id }, "[admin-resubscribe-notify] failed to load actor profile");
  }
  return actor;
}

/**
 * Read the recipient's `preferPush` flag, defaulting to true when no row
 * exists or the lookup fails — same fail-open behaviour as every other
 * notify helper in this directory.
 */
async function loadPreferPush(userId: number): Promise<boolean> {
  try {
    const [pref] = await db.select({ preferPush: userNotificationPrefsTable.preferPush })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, userId))
      .limit(1);
    return pref?.preferPush ?? true;
  } catch (err) {
    logger.warn({ err, userId }, "[admin-resubscribe-notify] failed to load preferPush; defaulting to ON");
    return true;
  }
}

interface NotifyOptions {
  orgId: number;
  affectedUserId: number;
  actor: ActorLike;
}

interface FlowConfig {
  /** memberCommPrefs category to honour; null when no per-category gate. */
  category: string | null;
  /** Tag for `flowHints` so bounce attribution can split the two flows. */
  flow: "tie_break_admin_resubscribed" | "bounced_digest_schedule_admin_resubscribed";
  /** memberMessages.relatedEntity tag for the inbox row. */
  relatedEntity: string;
  subject: string;
  heading: string;
  /** Sentence inserted after "<actor> (<org>) " in both inbox + email. */
  alertSentence: string;
  /** Builds the signed unsubscribe URL for this flow. */
  buildUrl: (userId: number, orgId: number) => string;
  /** Push fallback metadata for off-club directors (Task #1693). */
  push: {
    kind: "tie_break" | "bounced_digest_schedule";
    type: string;
    categoryLabel: string;
  };
}

function tieBreakConfig(): FlowConfig {
  return {
    category: "tournaments",
    flow: "tie_break_admin_resubscribed",
    relatedEntity: "tie_break_email_admin_resubscribe",
    subject: "Tie-break alert emails turned back on",
    heading: "Tie-break alert emails turned back on",
    alertSentence:
      "turned the round-robin tie-break required email back on for you.",
    buildUrl: (userId, orgId) => {
      const token = signTieBreakEmailOptOutToken(userId, orgId);
      return `${baseUrl()}/api/public/tie-break-email-unsubscribe?token=${encodeURIComponent(token)}`;
    },
    push: {
      kind: "tie_break",
      type: "tie_break_email_admin_resubscribe",
      categoryLabel: "round-robin tie-break required emails",
    },
  };
}

function bouncedDigestConfig(): FlowConfig {
  return {
    category: null,
    flow: "bounced_digest_schedule_admin_resubscribed",
    relatedEntity: "bounced_digest_schedule_admin_resubscribe",
    subject: "Bounced-reminders schedule emails turned back on",
    heading: "Bounced-reminders schedule emails turned back on",
    alertSentence:
      "turned the bounced-reminders digest schedule-change emails back on for you.",
    buildUrl: (userId, orgId) => {
      const token = signBouncedDigestScheduleOptOutToken(userId, orgId);
      return `${baseUrl()}/api/public/bounced-digest-schedule-unsubscribe?token=${encodeURIComponent(token)}`;
    },
    push: {
      kind: "bounced_digest_schedule",
      type: "bounced_digest_schedule_admin_resubscribe",
      categoryLabel: "bounced-reminders digest schedule-change emails",
    },
  };
}

interface PushFanoutInput {
  orgId: number;
  affectedUserId: number;
  actor: ActorLike;
  loadedActor: ActorLike;
  orgName: string;
  cfg: FlowConfig;
  /**
   * Per-category push toggle from `memberCommPrefs` (Task #2115).
   * Defaults to `true` when no row exists or the flow has no
   * per-category gate (bounced-digest). When `false`, push delivery
   * is suppressed exactly the same way the email leg suppresses
   * itself when `categoryEmailEnabled === false`.
   */
  categoryPushEnabled: boolean;
}

/**
 * Send a heads-up push to the affected user telling them an admin
 * turned the relevant email category back on, and deep-link to the
 * notification preferences screen so they can re-opt-out in one tap.
 *
 * History:
 *   - Task #1693 introduced this as an off-club fallback when there
 *     was no `club_members` row to write an inbox notice for.
 *   - Task #2115 promotes it to a parallel channel that fires for
 *     every re-subscribe (in-club or off-club) so directors who rely
 *     on push or who don't routinely check email get a real-time
 *     signal alongside the inbox row + email.
 *
 * Returns a partial result describing only the push channel — the
 * caller folds it into the full result with the inbox + email
 * outcomes. Honours `userNotificationPrefs.preferPush` (defaults
 * true) AND, for the tie-break flow, the per-category
 * `memberCommPrefs.tournaments.pushEnabled` toggle.
 */
async function runPushDispatch(
  args: PushFanoutInput,
): Promise<NonNullable<AdminResubscribeNotifyResult["push"]> & { reason?: string }> {
  const { orgId, affectedUserId, actor, loadedActor, orgName, cfg } = args;

  // Per-category push gate (tie-break only; bounced-digest passes
  // categoryPushEnabled=true unconditionally). Mirrors the email
  // leg's own categoryEmailEnabled gate so a director who silenced
  // the `tournaments` category at the per-category level doesn't
  // get pinged on push either when an admin re-enables them.
  if (cfg.category && !args.categoryPushEnabled) {
    return { status: "opted_out", attempted: 0, sent: 0, reason: "push_category_disabled" };
  }

  const preferPush = await loadPreferPush(affectedUserId);
  if (!preferPush) {
    return { status: "opted_out", attempted: 0, sent: 0, reason: "push_opted_out" };
  }

  const title = cfg.subject;
  const body = `${actorName(loadedActor)} (${orgName}) turned your ${cfg.push.categoryLabel} back on. Tap to opt out again from your notification preferences.`;
  const data: Record<string, unknown> = {
    type: cfg.push.type,
    organizationId: orgId,
    userId: affectedUserId,
    actorUserId: actor.id,
    // Deep-link the recipient straight at the notification preferences
    // screen so they can re-silence the email in one tap.
    deepLink: "/my-360/communications",
  };

  try {
    const result = await sendPushToUsers([affectedUserId], title, body, data);
    const status = classifyPushDelivery(result);
    if (status === "sent") {
      return { status, attempted: result.attempted, sent: result.sent };
    }
    if (status === "failed") {
      return {
        status,
        attempted: result.attempted,
        sent: result.sent,
        reason: "push_delivery_failed",
      };
    }
    // no_address — the recipient has no Expo device token registered.
    return {
      status,
      attempted: result.attempted,
      sent: result.sent,
      reason: "no_push_address",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, orgId, affectedUserId, kind: cfg.push.kind }, "[admin-resubscribe-notify] push delivery failed");
    return { status: "failed", attempted: 1, sent: 0, reason };
  }
}

async function runNotify(
  opts: NotifyOptions,
  cfg: FlowConfig,
): Promise<AdminResubscribeNotifyResult> {
  const { orgId, affectedUserId } = opts;
  const result: AdminResubscribeNotifyResult = {
    status: "skipped",
    email: { status: "skipped" },
  };
  if (!Number.isInteger(orgId) || !Number.isInteger(affectedUserId)) {
    result.reason = "invalid_input";
    return result;
  }
  // Don't notify the admin if they re-subscribed themselves — there's
  // nothing to explain in that case.
  if (opts.actor.id === affectedUserId) {
    result.reason = "self_action";
    return result;
  }
  try {
    const [org, profile, actor] = await Promise.all([
      loadOrg(orgId),
      loadAffectedUser(orgId, affectedUserId, cfg.category),
      loadActor(opts.actor),
    ]);
    const orgName = org?.name ?? "your club";
    const branding: EmailBranding = {
      orgName: org?.name ?? "KHARAGOLF",
      logoUrl: org?.logoUrl ?? undefined,
      primaryColor: org?.primaryColor ?? undefined,
      orgId,
    };

    let url: string | undefined;
    try {
      url = cfg.buildUrl(affectedUserId, orgId);
    } catch (err) {
      logger.warn({ err, orgId, affectedUserId, flow: cfg.flow }, "[admin-resubscribe-notify] could not sign opt-out token");
    }

    const lines = [
      `${actorName(actor)} (${orgName}) ${cfg.alertSentence}`,
      "If you'd rather stay opted out, you can unsubscribe again with one click:",
    ];
    if (url) lines.push(url);

    // ── In-app inbox row (only when the user is a club_member of the org) ──
    // Per-channel failures are tracked via `inboxFailureReason` rather than
    // by clobbering `result.status` directly — every channel is best-effort,
    // so the aggregate roll-up below treats "any leg sent" as a win even
    // if a sibling channel failed (matches the coach-payout notify pattern).
    let inboxFailureReason: string | undefined;
    if (profile.clubMemberId != null) {
      try {
        const [msg] = await db.insert(memberMessagesTable).values({
          organizationId: orgId,
          clubMemberId: profile.clubMemberId,
          senderUserId: opts.actor.id,
          channel: "in_app",
          subject: cfg.subject,
          body: lines.join("\n\n"),
          status: "sent",
          relatedEntity: cfg.relatedEntity,
          relatedEntityId: affectedUserId,
        }).returning({ id: memberMessagesTable.id });
        result.messageId = msg?.id;
      } catch (err) {
        logger.warn({ err, orgId, affectedUserId, flow: cfg.flow }, "[admin-resubscribe-notify] inbox insert failed");
        inboxFailureReason = err instanceof Error ? err.message : String(err);
        // Fall through — still try push + email so a DB hiccup on the
        // inbox doesn't also drop the other channels.
      }
    }

    // ── Push notification ─────────────────────────────────────────────────
    // Task #1693 added this for off-club directors only (no club_members
    // row → no inbox notice → fall back to push). Task #2115 promotes it
    // to a parallel channel that fires for every re-subscribe so
    // directors who rely on push get a real-time heads-up alongside the
    // inbox row + email — best-effort, gated by `preferPush` and the
    // per-category `memberCommPrefs` push toggle.
    const push = await runPushDispatch({
      orgId,
      affectedUserId,
      actor: opts.actor,
      loadedActor: actor,
      orgName,
      cfg,
      categoryPushEnabled: profile.categoryPushEnabled,
    });
    const { reason: pushReason, ...pushChannel } = push;
    result.push = pushChannel;

    // ── Transactional email (Task #1692) ─────────────────────────────────
    // Honours `userNotificationPrefs.preferEmail` (defaults to true) and,
    // for the tie-break flow only, the per-category `tournaments`
    // `memberCommPrefs.emailEnabled` toggle that the existing
    // roundRobinTieBreakNotify also respects. The email itself is
    // best-effort: every failure path is logged and silenced so the
    // surrounding DELETE never gets retried because of a delivery glitch.
    const to = (profile.email ?? "").trim();
    if (!to) {
      result.email.status = "no_address";
    } else if (!profile.preferEmail) {
      result.email.status = "opted_out";
    } else if (cfg.category && !profile.categoryEmailEnabled) {
      result.email.status = "opted_out";
    } else {
      try {
        await sendAdminResubscribedAlertEmail({
          to,
          recipientName: (profile.displayName ?? profile.username ?? "").trim(),
          actorName: actorName(actor),
          orgName,
          alertSentence: cfg.alertSentence,
          heading: cfg.heading,
          subject: cfg.subject,
          unsubscribeUrl: url,
          flow: cfg.flow,
          branding,
          // Task #2114 — render the email in the recipient's language;
          // English is the canonical fallback when the column is null
          // or the lookup failed.
          preferredLanguage: profile.preferredLanguage,
        });
        result.email.status = "sent";
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Provider misconfiguration is an env-wide condition, not a
        // per-recipient bounce — flag it as skipped so dashboards don't
        // surface it as a failure for an issue every send is hitting.
        if (classifyMailerError(err) === "provider_unconfigured") {
          result.email.status = "skipped";
          result.email.error = reason;
          logger.warn({ err, orgId, affectedUserId, flow: cfg.flow }, "[admin-resubscribe-notify] email provider unconfigured");
        } else {
          result.email.status = "failed";
          result.email.error = reason;
          logger.warn({ err, orgId, affectedUserId, flow: cfg.flow }, "[admin-resubscribe-notify] email delivery failed");
        }
      }
    }

    // ── Roll up an aggregate status for the caller ───────────────────────
    // Best-effort across all channels: any leg sent → "sent" wins; else
    // any leg failed → "failed"; else "skipped". This mirrors the
    // coach-payout notify pattern so a single noisy best-effort failure
    // (e.g. a transient Expo outage) doesn't poison the aggregate when
    // the inbox / email leg actually reached the recipient.
    const anyLegSent =
      result.messageId != null
      || result.email.status === "sent"
      || result.push?.status === "sent";
    const anyLegFailed =
      inboxFailureReason != null
      || result.email.status === "failed"
      || result.push?.status === "failed";

    if (anyLegSent) {
      result.status = "sent";
      result.reason = undefined;
    } else if (anyLegFailed) {
      result.status = "failed";
      // Prefer the inbox error (an inbox failure is always actionable),
      // then push, then email — same priority order as the channel
      // dispatch above.
      result.reason =
        inboxFailureReason
        ?? (result.push?.status === "failed" ? (pushReason ?? "push_delivery_failed") : undefined)
        ?? (result.email.status === "failed" ? result.email.error : undefined);
    } else {
      // No leg sent + no leg failed — every channel was intentionally
      // suppressed (opted_out / no_address / skipped). Surface a clearer
      // reason than the default "skipped".
      result.status = "skipped";
      if (!result.reason) {
        result.reason = profile.clubMemberId == null
          ? "no_club_member"
          : (result.email.status as string);
      }
    }

    return result;
  } catch (err) {
    logger.warn({ err, orgId, affectedUserId, flow: cfg.flow }, "[admin-resubscribe-notify] unexpected failure");
    result.status = "failed";
    result.reason = err instanceof Error ? err.message : String(err);
    return result;
  }
}

/**
 * Notify a director that an admin has cleared their tie-break email opt-out.
 * Uses signTieBreakEmailOptOutToken so the inbox + email link points at the
 * existing /api/public/tie-break-email-unsubscribe handler. Fans out across
 * three best-effort channels:
 *   1. inbox row     — only when the recipient has a `club_members` row.
 *   2. push          — fires for every recipient (Task #2115), gated by
 *                      `userNotificationPrefs.preferPush` and the per-
 *                      category `memberCommPrefs.tournaments.pushEnabled`
 *                      toggle (mirrors the email leg's `emailEnabled` gate).
 *   3. email         — gated by `preferEmail` and `tournaments.emailEnabled`.
 */
export async function notifyTieBreakAdminResubscribed(
  opts: NotifyOptions,
): Promise<AdminResubscribeNotifyResult> {
  return runNotify(opts, tieBreakConfig());
}

/**
 * Notify a member that an admin has cleared their bounced-digest schedule-
 * change email opt-out. Uses signBouncedDigestScheduleOptOutToken so the
 * inbox + email link points at the existing
 * /api/public/bounced-digest-schedule-unsubscribe handler. Fans out the
 * same three best-effort channels as the tie-break flow above. Push fires
 * for every recipient (Task #2115); the bounced-digest flow has no
 * per-category `memberCommPrefs` gate (consistent with its email leg),
 * so push is gated only by `userNotificationPrefs.preferPush`.
 */
export async function notifyBouncedDigestScheduleAdminResubscribed(
  opts: NotifyOptions,
): Promise<AdminResubscribeNotifyResult> {
  return runNotify(opts, bouncedDigestConfig());
}
