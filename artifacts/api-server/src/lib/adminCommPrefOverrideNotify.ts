/**
 * Task #1504 — Notify a member when an admin changes one of their
 * notification preferences on their behalf.
 *
 * Task #1272 wired the admin endpoint
 *   PUT /api/organizations/:orgId/members/:userId/notification-prefs
 * which lets an org_admin / tournament_director flip a member's
 * `notifySideGameReceipts` flag and stamps a `member_audit_log` row with
 * the actor + reason. Until now the affected member was never told.
 *
 * This helper is invoked AFTER the audit row is recorded. It writes:
 *   - one in-app `member_messages` row (always; the inbox is the canonical
 *     consent-trail surface and is unaffected by per-channel preferences)
 *   - one transactional email to the member's address (only when
 *     `userNotificationPrefsTable.preferEmail` is true)
 *
 * Best-effort: every failure is caught and logged so the underlying
 * preference-toggle save (which has already committed) is never retried
 * or rolled back because of a delivery glitch.
 *
 * Self-service flips MUST NOT trigger this. The call site short-circuits
 * when actor === target; this helper makes no opinion on that itself.
 */
import { db } from "@workspace/db";
import {
  appUsersTable,
  organizationsTable,
  clubMembersTable,
  memberMessagesTable,
  userNotificationPrefsTable,
  adminCommPrefOverrideNotifyAttemptsTable,
  type AdminCommPrefOverrideNotifyAttempt,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  sendNotificationPrefAdminOverrideEmail,
  classifyMailerError,
  type EmailBranding,
} from "./mailer";
import { logger as baseLogger } from "./logger";

const logger = baseLogger.child({ module: "admin-comm-pref-override-notify" });

export type AdminPrefOverrideChannelStatus =
  | "sent"
  | "skipped"
  | "failed"
  | "opted_out"
  | "no_address";

export interface AdminPrefOverrideNotifyResult {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  email: { status: AdminPrefOverrideChannelStatus; error?: string };
  inApp: { status: AdminPrefOverrideChannelStatus; messageId?: number; error?: string };
}

export interface AdminPrefOverrideNotifyOpts {
  organizationId: number;
  /** The member whose preference was changed. */
  targetUserId: number;
  /** The admin who flipped the flag. */
  adminUserId: number;
  /** Machine key of the preference (e.g. "notifySideGameReceipts"). */
  prefKey: string;
  /** Human label rendered into the email + inbox row. */
  prefLabel: string;
  previousValue: boolean;
  newValue: boolean;
  /** Free-form reason text the admin supplied; null when none. */
  reason: string | null;
  /** Optional pre-resolved clubMember id (the route already looked it
   *  up to anchor the audit row). When omitted we re-derive it. */
  clubMemberId?: number | null;
  /** Stamp used for the email + audit display. Defaults to now(). */
  changedAt?: Date;
}

function portalPrefsUrl(): string {
  const base = process.env.PUBLIC_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "https://kharagolf.com");
  return `${base.replace(/\/$/, "")}/portal#comm-prefs`;
}

export async function notifyMemberOfAdminCommPrefOverride(
  opts: AdminPrefOverrideNotifyOpts,
): Promise<AdminPrefOverrideNotifyResult> {
  const result: AdminPrefOverrideNotifyResult = {
    status: "skipped",
    email: { status: "skipped" },
    inApp: { status: "skipped" },
  };
  try {
    const changedAt = opts.changedAt ?? new Date();
    const changeWord = opts.newValue ? "turned ON" : "turned OFF";

    // ── Resolve the target member's profile + preference row in parallel ──
    const [targetUser, prefRow, adminUser, org, derivedMember] = await Promise.all([
      db.select({
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      })
        .from(appUsersTable)
        .where(eq(appUsersTable.id, opts.targetUserId))
        .limit(1)
        .then(rows => rows[0]),
      db.select({ preferEmail: userNotificationPrefsTable.preferEmail })
        .from(userNotificationPrefsTable)
        .where(eq(userNotificationPrefsTable.userId, opts.targetUserId))
        .limit(1)
        .then(rows => rows[0]),
      db.select({
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      })
        .from(appUsersTable)
        .where(eq(appUsersTable.id, opts.adminUserId))
        .limit(1)
        .then(rows => rows[0]),
      db.select({
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
      })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, opts.organizationId))
        .limit(1)
        .then(rows => rows[0]),
      // Skip the lookup when the route already resolved a clubMember id.
      opts.clubMemberId !== undefined
        ? Promise.resolve(opts.clubMemberId === null ? null : { id: opts.clubMemberId })
        : db.select({ id: clubMembersTable.id })
            .from(clubMembersTable)
            .where(and(
              eq(clubMembersTable.organizationId, opts.organizationId),
              eq(clubMembersTable.userId, opts.targetUserId),
            ))
            .limit(1)
            .then(rows => rows[0] ?? null),
    ]);

    if (!targetUser) {
      result.reason = "target_user_not_found";
      return result;
    }

    const memberName = (targetUser.displayName || targetUser.username || "").trim();
    const adminName = (adminUser?.displayName || adminUser?.username || "An administrator").trim();
    const orgName = org?.name ?? "KHARAGOLF";

    const branding: EmailBranding = {
      orgName,
      logoUrl: org?.logoUrl ?? undefined,
      primaryColor: org?.primaryColor ?? undefined,
      orgId: opts.organizationId,
    };

    // ── In-app inbox row ───────────────────────────────────────────────
    // Always written when the member has a club_members row in this org.
    // The inbox is the canonical consent trail and isn't gated by
    // per-channel prefs. We tag the row with `relatedEntity =
    // 'comm_prefs_admin_override'` and `relatedEntityId = targetUserId`
    // so member-360 timelines can group multiple overrides per member.
    const inAppSubject = `An admin updated your notification preferences`;
    const reasonSentence = opts.reason && opts.reason.trim().length > 0
      ? ` Reason given: "${opts.reason.trim()}"`
      : "";
    const inAppBody =
      `${adminName} ${changeWord} your "${opts.prefLabel}" preference on ${orgName}.${reasonSentence}` +
      ` You can review or revert this from your portal preferences.`;

    if (derivedMember && derivedMember.id != null) {
      try {
        const [msg] = await db.insert(memberMessagesTable).values({
          organizationId: opts.organizationId,
          clubMemberId: derivedMember.id,
          senderUserId: opts.adminUserId,
          channel: "in_app",
          subject: inAppSubject,
          body: inAppBody,
          status: "sent",
          relatedEntity: "comm_prefs_admin_override",
          relatedEntityId: opts.targetUserId,
        }).returning({ id: memberMessagesTable.id });
        result.inApp.status = "sent";
        result.inApp.messageId = msg?.id;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        result.inApp.status = "failed";
        result.inApp.error = reason;
        logger.warn(
          { err, targetUserId: opts.targetUserId, organizationId: opts.organizationId },
          "[admin-comm-pref-override-notify] in-app insert failed",
        );
      }
    } else {
      // No club_members row in this org — the member was added at the
      // org-membership level only (e.g. tournament-only player). Nothing
      // to anchor the inbox row to; the email path still fires below.
      result.inApp.status = "skipped";
    }

    // ── Email ──────────────────────────────────────────────────────────
    // Honours `userNotificationPrefsTable.preferEmail` (defaults to true
    // when the member has never customised). Members with no email on
    // file get `no_address` instead of a delivery attempt.
    //
    // Task #1846 — When the override IS the email channel itself being
    // turned OFF, never email the override notice (the member just opted
    // out of email — sending one anyway would be exactly the "don't
    // WhatsApp them about a WhatsApp opt-out" footgun the channel-pref
    // override was meant to avoid). The post-save `prefRow.preferEmail`
    // lookup above already catches this implicitly (the route saves the
    // pref before invoking us), but we make it explicit here so the
    // protection survives any future refactor that re-orders the save
    // and notify, or that decides to "force" the override notice past
    // the standard preferEmail gate.
    const overrideTurnsOffEmailChannel =
      opts.prefKey === "preferEmail" && opts.newValue === false;
    const preferEmail = prefRow?.preferEmail ?? true;
    const to = (targetUser.email ?? "").trim();
    if (overrideTurnsOffEmailChannel || !preferEmail) {
      result.email.status = "opted_out";
    } else if (!to) {
      result.email.status = "no_address";
    } else {
      try {
        await sendNotificationPrefAdminOverrideEmail({
          to,
          memberName,
          prefLabel: opts.prefLabel,
          newValue: opts.newValue,
          previousValue: opts.previousValue,
          adminName,
          reason: opts.reason,
          changedAt,
          prefsUrl: portalPrefsUrl(),
          branding,
        });
        result.email.status = "sent";
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Provider misconfiguration → terminal `skipped`. The retry
        // helper checks `emailStatus === "failed"`, so a `skipped` row
        // here naturally won't be re-selected by the cron and avoids
        // billing the admin's inbox for an env issue.
        if (classifyMailerError(err) === "provider_unconfigured") {
          result.email.status = "skipped";
          result.email.error = "provider_not_configured";
        } else {
          result.email.status = "failed";
          result.email.error = reason;
          logger.warn(
            { err, targetUserId: opts.targetUserId, organizationId: opts.organizationId },
            "[admin-comm-pref-override-notify] email delivery failed",
          );
        }
      }
    }

    const statuses = [result.email.status, result.inApp.status];
    if (statuses.includes("sent")) {
      result.status = "sent";
    } else if (statuses.includes("failed")) {
      result.status = "failed";
      result.reason = result.email.error ?? result.inApp.error;
    } else {
      result.status = "skipped";
    }

    // ── Persist attempts row (Task #1845) ──────────────────────────────
    // One row per notify event — the call site invokes this helper
    // exactly once per actually-changed field per request, so we don't
    // bother with a uniqueness key. The row snapshots everything the
    // retry helper needs to re-fire the email without consulting the
    // upstream `userNotificationPrefs` row (which may have been
    // re-toggled in the meantime). Best-effort: a failure to persist
    // this row never alters the notify outcome the caller sees.
    try {
      const emailAttempted = result.email.status === "sent" || result.email.status === "failed";
      const nextEmail = result.email.status === "failed" ? computeNextRetryAt(1, changedAt) : null;
      await db.insert(adminCommPrefOverrideNotifyAttemptsTable).values({
        organizationId: opts.organizationId,
        targetUserId: opts.targetUserId,
        adminUserId: opts.adminUserId,
        prefKey: opts.prefKey,
        prefLabel: opts.prefLabel,
        previousValue: opts.previousValue,
        newValue: opts.newValue,
        reason: opts.reason,
        changedAt,
        emailStatus: result.email.status,
        emailAttempts: emailAttempted ? 1 : 0,
        lastEmailAt: emailAttempted ? changedAt : null,
        lastEmailError: result.email.error ?? null,
        nextEmailRetryAt: nextEmail,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        { errMsg: reason, targetUserId: opts.targetUserId, organizationId: opts.organizationId, prefKey: opts.prefKey },
        "[admin-comm-pref-override-notify] Failed to record retry-attempts row",
      );
    }

    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, targetUserId: opts.targetUserId, organizationId: opts.organizationId },
      "[admin-comm-pref-override-notify] unexpected failure",
    );
    result.status = "failed";
    result.reason = reason;
    return result;
  }
}

/**
 * Display labels for every preference key admins can override on a
 * member's behalf via PUT /api/organizations/:orgId/members/:userId/
 * notification-prefs. Each entry must:
 *
 *   1. correspond to a column in `userNotificationPrefsTable`,
 *   2. be wired into the route's `TOGGLEABLE_FIELDS` whitelist
 *      (otherwise the endpoint will silently reject the field), and
 *   3. be exercised by the admin-comm-pref-override-notify integration
 *      tests so a future regression in the per-pref notify wiring is
 *      caught immediately.
 *
 * Task #1272 / #962 shipped `notifySideGameReceipts`. Task #1506 added
 * the four channel toggles (`preferEmail`, `preferPush`, `preferSms`,
 * `preferWhatsapp`). Task #1846 enforces that every newly-shipped
 * admin-overridable preference (e.g. `notifyMemberDocuments`,
 * `digestMode`, future per-event opt-outs) MUST also be added here in
 * the same PR — otherwise the route falls back to using the raw
 * machine key as the human label and the silent-override gap from
 * Task #1504 reappears for that pref.
 */
export const ADMIN_OVERRIDABLE_PREF_LABELS: Readonly<Record<string, string>> = {
  notifySideGameReceipts: "Side-game settlement receipts (email)",
  preferEmail: "Email notifications",
  preferPush: "Push notifications",
  preferSms: "SMS notifications",
  preferWhatsapp: "WhatsApp notifications",
};

// ─── Retry helpers (Task #1845) ────────────────────────────────────────
// Same per-attempt persistence + exponential backoff pattern used by
// `coachPayoutAccountChangeNotify` (Task #1280). A transient SMTP /
// Postmark blip on the original send used to silently swallow the only
// timely consent notice the affected member would receive; the cron
// pass picks up due rows and re-fires until either delivery succeeds
// or the cap is reached.
export const ADMIN_COMM_PREF_OVERRIDE_NOTIFY_MAX_EMAIL_ATTEMPTS = 5;

const ADMIN_COMM_PREF_OVERRIDE_NOTIFY_BACKOFF_BASE_MS = 5 * 60 * 1000;
const ADMIN_COMM_PREF_OVERRIDE_NOTIFY_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * 5/10/20/40/80-minute backoff schedule, capped at 6h. Identical to
 * the coach-payout pipeline's `computeNextRetryAt` so the cap is
 * predictable across the whole retry surface.
 */
export function computeNextRetryAt(completedAttempts: number, from: Date = new Date()): Date {
  const exp = Math.max(0, completedAttempts - 1);
  const delay = Math.min(
    ADMIN_COMM_PREF_OVERRIDE_NOTIFY_BACKOFF_BASE_MS * Math.pow(2, exp),
    ADMIN_COMM_PREF_OVERRIDE_NOTIFY_BACKOFF_MAX_MS,
  );
  return new Date(from.getTime() + delay);
}

export interface AdminCommPrefOverrideNotifyRetryResult {
  channel: "email";
  status: AdminPrefOverrideChannelStatus;
  error?: string;
  attempts: number;
  exhausted: boolean;
}

/**
 * Re-attempt a previously failed email delivery for a single
 * admin-comm-pref-override notification. The snapshotted columns on
 * the attempts row carry the original prefLabel / prev / new / reason
 * so a subsequent re-toggle by the member or admin doesn't poison the
 * email body. Returns `null` if the row is no longer eligible (status
 * not failed, cap reached, or backoff window pending). Provider-not-
 * configured errors flip the row to terminal `skipped` so the cron
 * stops re-selecting it.
 */
export async function retryAdminCommPrefOverrideEmail(opts: {
  attempt: AdminCommPrefOverrideNotifyAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<AdminCommPrefOverrideNotifyRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.emailStatus !== "failed") return null;
  const currentAttempts = attempt.emailAttempts ?? 0;
  if (currentAttempts >= ADMIN_COMM_PREF_OVERRIDE_NOTIFY_MAX_EMAIL_ATTEMPTS) return null;
  if (attempt.nextEmailRetryAt && attempt.nextEmailRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: AdminPrefOverrideChannelStatus;
  let error: string | undefined;

  // Honour `preferEmail` at retry time so a member who turned off
  // email between the original send and now isn't contacted again.
  let preferEmail = true;
  try {
    const [pref] = await db
      .select({ preferEmail: userNotificationPrefsTable.preferEmail })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, attempt.targetUserId))
      .limit(1);
    preferEmail = pref?.preferEmail ?? true;
  } catch (err) {
    logger.warn(
      { ...logContext, attemptId: attempt.id, errMsg: err instanceof Error ? err.message : String(err) },
      "[admin-comm-pref-override-notify] Failed to load preferEmail on retry; defaulting to ON",
    );
  }

  if (!preferEmail) {
    status = "opted_out";
  } else {
    const [targetUser] = await db
      .select({
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, attempt.targetUserId))
      .limit(1);
    const to = (targetUser?.email ?? "").trim();
    const memberName = (targetUser?.displayName || targetUser?.username || "").trim();

    if (!to) {
      status = "no_address";
    } else {
      let adminName = "An administrator";
      try {
        const [admin] = await db
          .select({
            displayName: appUsersTable.displayName,
            username: appUsersTable.username,
          })
          .from(appUsersTable)
          .where(eq(appUsersTable.id, attempt.adminUserId))
          .limit(1);
        const resolved = (admin?.displayName || admin?.username || "").trim();
        if (resolved) adminName = resolved;
      } catch {
        // best-effort
      }

      let branding: EmailBranding = { orgName: "KHARAGOLF", orgId: attempt.organizationId };
      try {
        const [org] = await db
          .select({
            name: organizationsTable.name,
            logoUrl: organizationsTable.logoUrl,
            primaryColor: organizationsTable.primaryColor,
          })
          .from(organizationsTable)
          .where(eq(organizationsTable.id, attempt.organizationId))
          .limit(1);
        if (org) {
          branding = {
            orgName: org.name ?? "KHARAGOLF",
            logoUrl: org.logoUrl ?? undefined,
            primaryColor: org.primaryColor ?? undefined,
            orgId: attempt.organizationId,
          };
        }
      } catch {
        // best-effort
      }

      try {
        await sendNotificationPrefAdminOverrideEmail({
          to,
          memberName,
          prefLabel: attempt.prefLabel,
          newValue: attempt.newValue,
          previousValue: attempt.previousValue,
          adminName,
          reason: attempt.reason,
          changedAt: attempt.changedAt,
          prefsUrl: portalPrefsUrl(),
          branding,
        });
        status = "sent";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (classifyMailerError(err) === "provider_unconfigured") {
          await db.update(adminCommPrefOverrideNotifyAttemptsTable).set({
            emailStatus: "skipped",
            lastEmailAt: now,
            lastEmailError: "provider_not_configured",
            lastEmailRetryAt: now,
            nextEmailRetryAt: null,
          }).where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attempt.id));
          return {
            channel: "email",
            status: "skipped",
            error: "provider_not_configured",
            attempts: currentAttempts,
            exhausted: false,
          };
        }
        status = "failed";
        error = msg;
        logger.error(
          { ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: msg },
          "[admin-comm-pref-override-notify] Email retry failed",
        );
      }
    }
  }

  const exhausted = status === "failed" && nextAttempts >= ADMIN_COMM_PREF_OVERRIDE_NOTIFY_MAX_EMAIL_ATTEMPTS;
  await db.update(adminCommPrefOverrideNotifyAttemptsTable).set({
    emailStatus: status,
    lastEmailAt: now,
    lastEmailError: error ?? null,
    emailAttempts: nextAttempts,
    lastEmailRetryAt: now,
    nextEmailRetryAt: status === "failed" && !exhausted ? computeNextRetryAt(nextAttempts, now) : null,
    emailRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attempt.id));

  return { channel: "email", status, error, attempts: nextAttempts, exhausted };
}
