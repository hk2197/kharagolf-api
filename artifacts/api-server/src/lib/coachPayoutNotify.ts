/**
 * Coach payout-paid notification retry helpers (Task #967).
 *
 * Task #774 fans the payout-paid notice out over push and SMS. This module
 * mirrors the levy-receipt retry pattern (Task #247) so that a transient
 * provider failure on either channel is retried on a bounded schedule
 * instead of being silently dropped after the first attempt.
 *
 * Each helper:
 *   - Short-circuits and returns `null` when the row is no longer eligible
 *     (status is not `failed`, the cap has been reached, etc.).
 *   - Re-derives the live recipient (coach app-user id / phone) at retry
 *     time so a coach who later links an app user / adds a phone gets the
 *     pending notification on the next pass.
 *   - Treats SMS_PROVIDER-not-configured errors as terminal `skipped` so
 *     the cron stops re-selecting the row in environments without an SMS
 *     provider.
 */
import {
  db,
  clubMembersTable,
  memberCommPrefsTable,
  teachingProsTable,
  deviceTokensTable,
  coachPayoutNotificationAttemptsTable,
  coachPayoutsTable,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  memberMessagesTable,
  type CoachPayoutNotificationAttempt,
} from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { sendCoachPayoutPaidEmail, classifyMailerError, type EmailBranding } from "./mailer";
import { sendTransactionalPush, sendTransactionalSms } from "./comms";
import { classifyPushDelivery } from "./push";
import { logger } from "./logger";
import { maskPhoneForCoach, buildPushDeviceLabel } from "./coachPayoutNotifyTargets";

// Per-channel cap for a single payout-paid notification (initial attempt
// + retries). Once a channel reaches this cap the cron stops retrying it
// and `*RetryExhaustedAt` is stamped on the attempts row. Mirrors
// `LEVY_RECEIPT_MAX_PUSH_ATTEMPTS` / `LEVY_RECEIPT_MAX_SMS_ATTEMPTS`.
//
// Hoisted to `@workspace/coach-payout-labels` (Task #1545) so the web
// admin badges, the coach earnings tabs (web + mobile), and this cron
// share a single source of truth for the cap. Re-exported here so the
// existing `./coachPayoutNotify` import sites in cron + tests keep
// working without churn.
export {
  COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
  COACH_PAYOUT_MAX_SMS_ATTEMPTS,
} from "@workspace/coach-payout-labels";
import {
  COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
  COACH_PAYOUT_MAX_SMS_ATTEMPTS,
} from "@workspace/coach-payout-labels";

// Task #1847 — email retry budget for the coach payout-paid fan-out.
// Cap = 5 deliveries (initial + 4 retries) so transient SMTP blips
// don't drop a payout receipt and a hard SMTP bounce (Task #1279)
// jumps straight to exhausted. Local to this module — coach-payout
// labels already centralise the push/SMS caps, but the email cap is
// only consumed inside the API server.
export const COACH_PAYOUT_MAX_EMAIL_ATTEMPTS = 5;

// Task #1847 — exponential backoff schedule for email retries: 5,
// 10, 20, 40, 80 minutes between attempts (i.e. attempt N waits
// `5*2^(N-1)` minutes after attempt N-1). Capped at 6h so a freak
// attempts value never produces a runaway delay. Mirrors the
// wallet-withdrawal / levy-receipt schedule exactly so ops have one
// mental model across the bounded-retry surfaces.
const COACH_PAYOUT_EMAIL_BACKOFF_BASE_MS = 5 * 60 * 1000;
const COACH_PAYOUT_EMAIL_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export function computeCoachPayoutNextEmailRetryAt(completedAttempts: number, from: Date = new Date()): Date {
  const exp = Math.max(0, completedAttempts - 1);
  const delay = Math.min(
    COACH_PAYOUT_EMAIL_BACKOFF_BASE_MS * Math.pow(2, exp),
    COACH_PAYOUT_EMAIL_BACKOFF_MAX_MS,
  );
  return new Date(from.getTime() + delay);
}

export type CoachPayoutChannelStatus =
  | "sent"
  | "failed"
  | "no_address"
  | "no_user"
  | "opted_out"
  | "skipped";

export interface CoachPayoutRetryResult {
  channel: "push" | "sms" | "email";
  status: CoachPayoutChannelStatus;
  error?: string;
  attempts: number;
  exhausted: boolean;
}

function buildShortBody(a: CoachPayoutNotificationAttempt): { title: string; body: string } {
  const amountStr = `₹${(a.amountPaise / 100).toLocaleString("en-IN")}`;
  const orgName = a.orgName ?? "Your club";
  return {
    title: `Payout sent — ${amountStr}`,
    body: `${orgName} marked your swing-review payout paid. Reference: ${a.reference}.`,
  };
}

/**
 * Look up the coach's `billing` SMS pref so opt-outs are honoured on retry.
 * When no club_members or comm-prefs row exists we default SMS to ON,
 * matching the first-attempt behaviour in `notifyCoachPayoutPaid`.
 */
async function loadCoachSmsPref(organizationId: number, coachUserId: number | null): Promise<boolean> {
  if (!coachUserId) return true;
  try {
    const [member] = await db.select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, organizationId),
        eq(clubMembersTable.userId, coachUserId),
      )).limit(1);
    if (!member) return true;
    const [row] = await db.select({ smsEnabled: memberCommPrefsTable.smsEnabled })
      .from(memberCommPrefsTable)
      .where(and(
        eq(memberCommPrefsTable.clubMemberId, member.id),
        eq(memberCommPrefsTable.category, "billing"),
      )).limit(1);
    if (!row) return true;
    return Boolean(row.smsEnabled);
  } catch (err) {
    logger.warn({ err, organizationId, coachUserId }, "[coach-payout-notify] Failed to load SMS pref; defaulting to ON");
    return true;
  }
}

async function loadCoachPushPref(organizationId: number, coachUserId: number | null): Promise<boolean> {
  if (!coachUserId) return true;
  try {
    const [member] = await db.select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, organizationId),
        eq(clubMembersTable.userId, coachUserId),
      )).limit(1);
    if (!member) return true;
    const [row] = await db.select({ pushEnabled: memberCommPrefsTable.pushEnabled })
      .from(memberCommPrefsTable)
      .where(and(
        eq(memberCommPrefsTable.clubMemberId, member.id),
        eq(memberCommPrefsTable.category, "billing"),
      )).limit(1);
    if (!row) return true;
    return Boolean(row.pushEnabled);
  } catch (err) {
    logger.warn({ err, organizationId, coachUserId }, "[coach-payout-notify] Failed to load push pref; defaulting to ON");
    return true;
  }
}

/**
 * Re-attempt a previously failed push delivery for a single coach
 * payout-paid notice. Returns `null` when the row is no longer eligible
 * (status is not `failed`, cap reached).
 */
export async function retryCoachPayoutPush(opts: {
  attempt: CoachPayoutNotificationAttempt;
  logContext?: Record<string, unknown>;
}): Promise<CoachPayoutRetryResult | null> {
  const { attempt, logContext } = opts;
  if (attempt.pushStatus !== "failed") return null;
  const currentAttempts = attempt.pushAttempts ?? 0;
  if (currentAttempts >= COACH_PAYOUT_MAX_PUSH_ATTEMPTS) return null;

  // Re-derive live coach user id (coach may have linked an app user since
  // the original attempt). Fall back to the snapshot on the row.
  const [pro] = await db.select({ userId: teachingProsTable.userId })
    .from(teachingProsTable).where(eq(teachingProsTable.id, attempt.proId)).limit(1);
  const coachUserId = pro?.userId ?? attempt.coachUserId ?? null;

  const short = buildShortBody(attempt);
  const nextAttempts = currentAttempts + 1;
  const now = new Date();
  let status: CoachPayoutChannelStatus;
  let error: string | undefined;
  // Task #1544 — re-derive the device label live so a coach who has
  // since registered (or unregistered) a device sees the latest count
  // on the next cron pass. Default to the previously-stored label so
  // we never blank out useful info on a transient lookup failure.
  let pushTargetLabel: string | null = attempt.pushTargetLabel ?? null;

  if (!coachUserId) {
    status = "no_user";
    // No app user linked → no devices to count. Clear the snapshot so
    // the cell stops claiming we tried any device.
    pushTargetLabel = null;
  } else if (!(await loadCoachPushPref(attempt.organizationId, coachUserId))) {
    status = "opted_out";
    pushTargetLabel = null;
  } else {
    try {
      const devices = await db.select({ platform: deviceTokensTable.platform })
        .from(deviceTokensTable)
        .where(eq(deviceTokensTable.userId, coachUserId));
      pushTargetLabel = buildPushDeviceLabel(devices);
    } catch (err) {
      logger.warn({ ...logContext, attemptId: attempt.id, errMsg: err instanceof Error ? err.message : String(err) }, "[coach-payout-notify] Failed to derive push device label on retry; keeping previous snapshot");
    }
    try {
      const push = await sendTransactionalPush(
        [coachUserId],
        short.title,
        short.body,
        {
          type: "coach_payout_paid",
          payoutId: attempt.payoutId,
          organizationId: attempt.organizationId,
          amountPaise: attempt.amountPaise,
          reference: attempt.reference,
          deepLink: "/coach/earnings",
          retry: true,
        },
      );
      // Task #1070 — share the classifier so a coach with no Expo
      // tokens registered stays `no_address` instead of being booked as
      // a push delivery failure on the retry attempts row.
      status = classifyPushDelivery(push);
      if (status === "failed") {
        error = "push_delivery_failed";
      }
      if (status === "no_address") {
        // Cron pass after the coach unregistered every device — clear
        // the snapshot so the UI doesn't keep showing a stale device
        // count next to a "No phone-equivalent" badge.
        pushTargetLabel = null;
      }
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
      logger.error({ ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: error }, "[coach-payout-notify] Push retry failed");
    }
  }

  const exhausted = status === "failed" && nextAttempts >= COACH_PAYOUT_MAX_PUSH_ATTEMPTS;
  await db.update(coachPayoutNotificationAttemptsTable).set({
    pushStatus: status,
    lastPushAt: now,
    lastPushError: error ?? null,
    pushAttempts: nextAttempts,
    lastPushRetryAt: now,
    pushRetryExhaustedAt: exhausted ? now : null,
    pushTargetLabel,
  }).where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));

  return { channel: "push", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Re-attempt a previously failed SMS delivery for a single coach
 * payout-paid notice. Mirrors {@link retryCoachPayoutPush}; returns `null`
 * when the row is no longer eligible. Provider-not-configured errors flip
 * the row to terminal `skipped` so the cron stops re-selecting it.
 */
export async function retryCoachPayoutSms(opts: {
  attempt: CoachPayoutNotificationAttempt;
  logContext?: Record<string, unknown>;
}): Promise<CoachPayoutRetryResult | null> {
  const { attempt, logContext } = opts;
  if (attempt.smsStatus !== "failed") return null;
  const currentAttempts = attempt.smsAttempts ?? 0;
  if (currentAttempts >= COACH_PAYOUT_MAX_SMS_ATTEMPTS) return null;

  // Prefer the teaching-pro phone (where the original send looks first),
  // falling back to the coach's club_members phone.
  const [pro] = await db.select({ userId: teachingProsTable.userId, phone: teachingProsTable.phone })
    .from(teachingProsTable).where(eq(teachingProsTable.id, attempt.proId)).limit(1);
  const coachUserId = pro?.userId ?? attempt.coachUserId ?? null;
  let phone: string | null = pro?.phone ?? null;
  if (!phone && coachUserId) {
    const [member] = await db.select({ phone: clubMembersTable.phone })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, attempt.organizationId),
        eq(clubMembersTable.userId, coachUserId),
      )).limit(1);
    phone = member?.phone ?? null;
  }

  const short = buildShortBody(attempt);
  const nextAttempts = currentAttempts + 1;
  const now = new Date();
  let status: CoachPayoutChannelStatus;
  let error: string | undefined;
  // Task #1544 — re-mask the live phone so a coach who has updated
  // their number sees the new last-4 on the next cron pass. When there
  // is no phone we clear the snapshot to match the `no_address` badge.
  const smsTargetMasked: string | null = phone ? maskPhoneForCoach(phone) : null;

  if (!(await loadCoachSmsPref(attempt.organizationId, coachUserId))) {
    status = "opted_out";
  } else if (!phone) {
    status = "no_address";
  } else {
    try {
      const smsBody = `${short.title}\n${short.body}`.slice(0, 320);
      await sendTransactionalSms(phone, smsBody);
      status = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/SMS_PROVIDER not configured/i.test(msg)) {
        const nowSkip = new Date();
        await db.update(coachPayoutNotificationAttemptsTable).set({
          smsStatus: "skipped",
          lastSmsAt: nowSkip,
          lastSmsError: "provider_not_configured",
          lastSmsRetryAt: nowSkip,
          smsTargetMasked,
        }).where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
        return { channel: "sms", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      logger.error({ ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: msg }, "[coach-payout-notify] SMS retry failed");
    }
  }

  const exhausted = status === "failed" && nextAttempts >= COACH_PAYOUT_MAX_SMS_ATTEMPTS;
  await db.update(coachPayoutNotificationAttemptsTable).set({
    smsStatus: status,
    lastSmsAt: now,
    lastSmsError: error ?? null,
    smsAttempts: nextAttempts,
    lastSmsRetryAt: now,
    smsRetryExhaustedAt: exhausted ? now : null,
    smsTargetMasked,
  }).where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));

  return { channel: "sms", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Honour the coach's `billing` email pref so opt-outs are honoured on
 * retry. When no club_members or comm-prefs row exists we default email
 * to ON, matching the first-attempt behaviour in `notifyCoachPayoutPaid`.
 */
async function loadCoachEmailPref(organizationId: number, coachUserId: number | null): Promise<boolean> {
  if (!coachUserId) return true;
  try {
    const [member] = await db.select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, organizationId),
        eq(clubMembersTable.userId, coachUserId),
      )).limit(1);
    if (!member) return true;
    const [row] = await db.select({ emailEnabled: memberCommPrefsTable.emailEnabled })
      .from(memberCommPrefsTable)
      .where(and(
        eq(memberCommPrefsTable.clubMemberId, member.id),
        eq(memberCommPrefsTable.category, "billing"),
      )).limit(1);
    if (!row) return true;
    return Boolean(row.emailEnabled);
  } catch (err) {
    logger.warn({ err, organizationId, coachUserId }, "[coach-payout-notify] Failed to load email pref; defaulting to ON");
    return true;
  }
}

/**
 * Task #1847 — Re-attempt a previously failed email delivery for a single
 * coach payout-paid notice. Looks up the live coach contact, rebuilds the
 * payout-paid email payload from the persisted snapshot, fires the mail,
 * and updates the attempts row with the new status / attempt count /
 * next-retry-at.
 *
 * Returns `null` when the row is no longer eligible (status not `failed`,
 * cap reached, or backoff window not yet elapsed). Provider-not-configured
 * errors flip the row to terminal `skipped` so the cron stops re-selecting
 * it. Hard SMTP bounces (Task #1279) jump straight to exhausted and page
 * org admins via `notifyAdminsOfCoachPayoutRetryExhaustion`.
 *
 * Re-derives the live recipient (snapshot first, then teaching-pro email,
 * then app-user email) so a coach who fixes their on-file address between
 * attempts gets the pending payout receipt on the next pass.
 */
export async function retryCoachPayoutEmail(opts: {
  attempt: CoachPayoutNotificationAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<CoachPayoutRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.emailStatus !== "failed") return null;
  const currentAttempts = attempt.emailAttempts ?? 0;
  if (currentAttempts >= COACH_PAYOUT_MAX_EMAIL_ATTEMPTS) return null;
  if (attempt.nextEmailRetryAt && attempt.nextEmailRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: CoachPayoutChannelStatus;
  let error: string | undefined;
  let hardBounce = false;

  // Re-derive live coach context: prefer the snapshot (matches what we
  // tried first) but refresh against the teaching-pro / app-user rows so
  // a coach who fixed their email between attempts gets through.
  const [pro] = await db.select({
    userId: teachingProsTable.userId,
    proEmail: teachingProsTable.email,
    displayName: teachingProsTable.displayName,
  }).from(teachingProsTable).where(eq(teachingProsTable.id, attempt.proId)).limit(1);
  const coachUserId = pro?.userId ?? attempt.coachUserId ?? null;

  let userEmail: string | null = null;
  let userDisplayName: string | null = null;
  if (coachUserId) {
    try {
      const [u] = await db.select({
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
      }).from(appUsersTable).where(eq(appUsersTable.id, coachUserId)).limit(1);
      userEmail = u?.email ?? null;
      userDisplayName = u?.displayName ?? null;
    } catch {
      // best-effort
    }
  }
  const recipientEmail = userEmail ?? pro?.proEmail ?? attempt.emailRecipient ?? null;
  const recipientName = userDisplayName ?? pro?.displayName ?? "Coach";

  const optedIn = await loadCoachEmailPref(attempt.organizationId, coachUserId);
  if (!optedIn) {
    status = "opted_out";
  } else if (!recipientEmail) {
    status = "no_address";
  } else {
    let branding: EmailBranding = { orgName: attempt.orgName ?? "KHARAGOLF" };
    let orgLang: string | null = null;
    try {
      const [org] = await db.select({
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
        defaultLanguage: organizationsTable.defaultLanguage,
      }).from(organizationsTable).where(eq(organizationsTable.id, attempt.organizationId)).limit(1);
      branding = {
        orgName: org?.name ?? attempt.orgName ?? "KHARAGOLF",
        logoUrl: org?.logoUrl ?? undefined,
        primaryColor: org?.primaryColor ?? undefined,
        // Task #1319 — propagate `orgId` so the Postmark bounce webhook
        // (Task #981) attributes any hard bounce back to this club.
        orgId: attempt.organizationId,
      };
      orgLang = org?.defaultLanguage ?? null;
    } catch {
      // best-effort
    }

    try {
      await sendCoachPayoutPaidEmail({
        to: recipientEmail,
        coachName: recipientName,
        amountPaise: attempt.amountPaise,
        reference: attempt.reference,
        notes: attempt.notes ?? null,
        branding,
        lang: orgLang,
      });
      status = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errClass = classifyMailerError(err);
      if (errClass === "provider_unconfigured") {
        await db.update(coachPayoutNotificationAttemptsTable).set({
          emailStatus: "skipped",
          lastEmailAt: now,
          lastEmailError: "provider_not_configured",
          lastEmailRetryAt: now,
          nextEmailRetryAt: null,
        }).where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
        return { channel: "email", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      if (errClass === "hard_bounce") hardBounce = true;
      logger.error({ ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: msg, errClass }, "[coach-payout-notify] Email retry failed");
    }
  }

  const exhausted = status === "failed" && (hardBounce || nextAttempts >= COACH_PAYOUT_MAX_EMAIL_ATTEMPTS);
  const persistedAttempts = exhausted && hardBounce
    ? COACH_PAYOUT_MAX_EMAIL_ATTEMPTS
    : nextAttempts;
  await db.update(coachPayoutNotificationAttemptsTable).set({
    emailStatus: status,
    lastEmailAt: now,
    lastEmailError: error ?? null,
    emailAttempts: persistedAttempts,
    lastEmailRetryAt: now,
    nextEmailRetryAt: status === "failed" && !exhausted ? computeCoachPayoutNextEmailRetryAt(nextAttempts, now) : null,
    emailRetryExhaustedAt: exhausted ? now : null,
    // Refresh the snapshot so the admin alert (and the next retry) sees
    // the latest address we tried — useful when a coach updates their
    // email between attempts and the retry suddenly starts hard-bouncing
    // against the new destination.
    emailRecipient: recipientEmail ?? attempt.emailRecipient ?? null,
  }).where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));

  if (exhausted) {
    try {
      const [stamped] = await db.select()
        .from(coachPayoutNotificationAttemptsTable)
        .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id))
        .limit(1);
      if (stamped) {
        await notifyAdminsOfCoachPayoutRetryExhaustion({
          attempt: stamped,
          channel: "email",
          reason: hardBounce ? "hard_bounce" : "max_attempts",
          logContext,
        });
      }
    } catch (err) {
      logger.warn(
        { ...logContext, attemptId: attempt.id, errMsg: err instanceof Error ? err.message : String(err) },
        "[coach-payout-notify] Admin email exhaustion alert dispatch failed",
      );
    }
  }

  return { channel: "email", status, error, attempts: persistedAttempts, exhausted };
}

/**
 * Task #1847 — Notify org admins when a coach payout-paid email retry
 * gives up. Mirrors `notifyAdminsOfLevyReceiptRetryExhaustion`:
 *   1. Atomic dedup via `emailExhaustionNotifiedAt` so the same exhaustion
 *      can never be announced twice across cron passes, transactionally
 *      paired with an in-app message attached to the affected coach's
 *      `club_members` row (when one exists).
 *   2. Org-admin push fan-out so the failure surfaces immediately rather
 *      than waiting for someone to open the coach earnings tab.
 *
 * Best-effort: any failure here is logged but never thrown — the
 * underlying payout has already settled and the row is already marked
 * exhausted, so callers must not be derailed by an alerting error.
 */
export async function notifyAdminsOfCoachPayoutRetryExhaustion(opts: {
  attempt: CoachPayoutNotificationAttempt;
  channel: "email";
  reason?: "hard_bounce" | "max_attempts";
  logContext?: Record<string, unknown>;
}): Promise<{ notified: boolean; recipients: number }> {
  const { attempt, channel, logContext } = opts;
  const reason = opts.reason ?? "max_attempts";

  // Resolve a friendly recipient label for the alert body. Prefer the
  // coach's `club_members` row in this org (matches the language used
  // in the coach earnings tab), fall back to the teaching-pro display
  // name, then to `coach #${proId}`.
  let recipientLabel = `coach #${attempt.proId}`;
  let clubMemberId: number | null = null;
  let memberContactEmail: string | null = attempt.emailRecipient ?? null;
  try {
    const [pro] = await db.select({
      displayName: teachingProsTable.displayName,
      proEmail: teachingProsTable.email,
      userId: teachingProsTable.userId,
    }).from(teachingProsTable).where(eq(teachingProsTable.id, attempt.proId)).limit(1);
    if (pro?.displayName) recipientLabel = pro.displayName;
    if (!memberContactEmail) memberContactEmail = pro?.proEmail ?? null;

    const coachUserId = pro?.userId ?? attempt.coachUserId ?? null;
    if (coachUserId) {
      const [m] = await db.select({
        id: clubMembersTable.id,
        firstName: clubMembersTable.firstName,
        lastName: clubMembersTable.lastName,
        email: clubMembersTable.email,
      }).from(clubMembersTable)
        .where(and(
          eq(clubMembersTable.organizationId, attempt.organizationId),
          eq(clubMembersTable.userId, coachUserId),
        )).limit(1);
      if (m) {
        clubMemberId = m.id;
        const memberName = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim();
        if (memberName) recipientLabel = memberName;
        if (!memberContactEmail) memberContactEmail = m.email ?? null;
      }
      if (!memberContactEmail) {
        const [u] = await db.select({ email: appUsersTable.email })
          .from(appUsersTable)
          .where(eq(appUsersTable.id, coachUserId))
          .limit(1);
        if (u?.email) memberContactEmail = u.email;
      }
    }
  } catch {
    // best-effort
  }

  const amountStr = `₹${(attempt.amountPaise / 100).toLocaleString("en-IN")}`;
  const channelLabel = channel === "email" ? "email" : channel;
  const lastError = attempt.lastEmailError;
  const cap = COACH_PAYOUT_MAX_EMAIL_ATTEMPTS;

  const subject = `Coach payout ${channelLabel} delivery failed — ${recipientLabel} (payout #${attempt.payoutId})`;
  const body = [
    reason === "hard_bounce"
      ? `The system has stopped retrying the coach payout-paid ${channelLabel} for ${recipientLabel}'s ${amountStr} payout (ref ${attempt.reference}) because the provider returned a permanent bounce on the first attempt.`
      : `The system has stopped retrying the coach payout-paid ${channelLabel} for ${recipientLabel}'s ${amountStr} payout (ref ${attempt.reference}) after ${cap} failed attempts.`,
    `Last delivery error: ${lastError ?? "unknown"}.`,
    `Coach email on file: ${memberContactEmail ?? "(none)"}.`,
    `The payout has already been recorded against the coach's ledger; please reach them through another channel to share the receipt.`,
  ].join("\n\n");

  // 1) Atomic dedup + in-app message: stamp `emailExhaustionNotifiedAt`
  //    (only if still NULL) and insert the in-app message in the same
  //    transaction. The conditional UPDATE ensures only one caller "wins";
  //    doing it transactionally with the insert means a partial failure
  //    (stamp succeeds, insert throws) never silently swallows the alert
  //    forever — it just retries on the next exhaustion path.
  let winner = false;
  try {
    winner = await db.transaction(async (tx) => {
      const stamped = await tx.update(coachPayoutNotificationAttemptsTable)
        .set({ emailExhaustionNotifiedAt: new Date() })
        .where(and(
          eq(coachPayoutNotificationAttemptsTable.id, attempt.id),
          isNull(coachPayoutNotificationAttemptsTable.emailExhaustionNotifiedAt),
        ))
        .returning({ id: coachPayoutNotificationAttemptsTable.id });
      if (stamped.length === 0) return false;
      // Only insert the in-app trail when we have an associated club
      // member — `memberMessagesTable.clubMemberId` is NOT NULL.
      if (clubMemberId != null) {
        await tx.insert(memberMessagesTable).values({
          organizationId: attempt.organizationId,
          clubMemberId,
          senderUserId: null,
          channel: "in_app",
          subject,
          body,
          status: "sent",
          relatedEntity: "coach_payout_email_exhausted",
          relatedEntityId: attempt.id,
        });
      }
      return true;
    });
  } catch (err) {
    logger.warn(
      { ...logContext, attemptId: attempt.id, channel, errMsg: err instanceof Error ? err.message : String(err) },
      "[coach-payout-notify] Admin exhaustion stamp/insert failed",
    );
    return { notified: false, recipients: 0 };
  }

  if (!winner) {
    return { notified: false, recipients: 0 };
  }

  // 2) Push to org admins: union of direct `app_users.role='org_admin'`
  //    for this org and `org_memberships` admin/treasurer/etc roles.
  //    Mirrors `notifyAdminsOfLevyReceiptRetryExhaustion` so admins see
  //    this in the same notification stream as other exhaustion alerts.
  const directAdmins = await db
    .select({ userId: appUsersTable.id })
    .from(appUsersTable)
    .where(and(eq(appUsersTable.organizationId, attempt.organizationId), eq(appUsersTable.role, "org_admin")));
  const memberAdmins = await db
    .select({ userId: appUsersTable.id })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
    .where(and(
      eq(orgMembershipsTable.organizationId, attempt.organizationId),
      inArray(orgMembershipsTable.role, ["org_admin", "treasurer", "membership_secretary", "committee_member", "competition_secretary"]),
    ));
  const userIds = new Set<number>();
  for (const a of directAdmins) userIds.add(a.userId);
  for (const a of memberAdmins) userIds.add(a.userId);

  const recipients = [...userIds];
  if (recipients.length > 0) {
    try {
      await sendTransactionalPush(
        recipients,
        `⚠️ Coach payout ${channelLabel} retries exhausted`,
        `Email to ${recipientLabel} for payout #${attempt.payoutId} (${amountStr}) permanently failed. Manual follow-up required.`,
        {
          type: "coach_payout_email_exhausted",
          attemptId: attempt.id,
          payoutId: attempt.payoutId,
          organizationId: attempt.organizationId,
          proId: attempt.proId,
          reason,
        },
      );
    } catch (err) {
      logger.warn(
        { ...logContext, attemptId: attempt.id, channel, errMsg: err instanceof Error ? err.message : String(err) },
        "[coach-payout-notify] Admin exhaustion push failed",
      );
    }
  }

  // Suppress unused-import warnings: `coachPayoutsTable` is reserved for
  // future cross-references between the attempts row and its parent
  // payout (e.g. linking the in-app alert to the payout detail page).
  void coachPayoutsTable;

  logger.info(
    { ...logContext, attemptId: attempt.id, channel, reason, recipients: recipients.length },
    "[coach-payout-notify] Admins alerted: retry exhausted",
  );

  return { notified: true, recipients: recipients.length };
}

/**
 * Task #1914 — Notify org admins when a coach has hit the self-serve
 * "Try again" button on the same stuck payout enough times to suggest
 * the underlying contact problem (bad phone on file, expired push token,
 * SMS provider misconfig, etc.) isn't being fixed by anyone with the
 * access to fix it.
 *
 * Mirrors `notifyAdminsOfCoachPayoutRetryExhaustion`:
 *   1. Atomic dedup via `coachRetryAdminNotifiedAt` so the same stuck
 *      payout can never page admins twice across rapid coach presses,
 *      transactionally paired with an in-app message attached to the
 *      affected coach's `club_members` row (when one exists).
 *   2. Org-admin push fan-out so the failure surfaces immediately
 *      rather than waiting for someone to open the coach earnings tab.
 *
 * Best-effort: any failure here is logged but never thrown — the
 * coach's retry has already been accepted and the cron will continue
 * working the row, so callers must not be derailed by an alerting
 * error. The dedup marker is cleared by the admin Resend path so a
 * fresh stuck pattern after the admin's fix can re-fire the alert.
 */
export async function notifyAdminsOfRepeatedCoachPayoutRetries(opts: {
  attempt: CoachPayoutNotificationAttempt;
  coachUserId?: number | null;
  logContext?: Record<string, unknown>;
}): Promise<{ notified: boolean; recipients: number }> {
  const { attempt, logContext } = opts;

  // Resolve a friendly recipient label and a `club_members` row for the
  // in-app message trail. Same shape as the exhaustion alert so admins
  // see "Coach Jane Doe" rather than "coach #42" wherever possible.
  let recipientLabel = `coach #${attempt.proId}`;
  let clubMemberId: number | null = null;
  try {
    const [pro] = await db.select({
      displayName: teachingProsTable.displayName,
      userId: teachingProsTable.userId,
    }).from(teachingProsTable).where(eq(teachingProsTable.id, attempt.proId)).limit(1);
    if (pro?.displayName) recipientLabel = pro.displayName;

    const coachUserId = pro?.userId ?? attempt.coachUserId ?? opts.coachUserId ?? null;
    if (coachUserId) {
      const [m] = await db.select({
        id: clubMembersTable.id,
        firstName: clubMembersTable.firstName,
        lastName: clubMembersTable.lastName,
      }).from(clubMembersTable)
        .where(and(
          eq(clubMembersTable.organizationId, attempt.organizationId),
          eq(clubMembersTable.userId, coachUserId),
        )).limit(1);
      if (m) {
        clubMemberId = m.id;
        const memberName = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim();
        if (memberName) recipientLabel = memberName;
      }
    }
  } catch {
    // best-effort
  }

  const amountStr = `₹${(attempt.amountPaise / 100).toLocaleString("en-IN")}`;
  const retries = attempt.coachRetryCount ?? 0;
  // Snapshot the contact details we last tried so the admin doesn't
  // have to dig through the coach's profile to see what's wrong. Both
  // labels are nullable on legacy rows / channels with no recipient.
  const pushTried = attempt.pushTargetLabel ?? "(no push target)";
  const smsTried = attempt.smsTargetMasked ?? "(no SMS target)";

  const subject = `Coach is stuck retrying payout #${attempt.payoutId} — ${recipientLabel}`;
  const body = [
    `${recipientLabel} has pressed "Try again" ${retries} times on their ${amountStr} payout (ref ${attempt.reference}) without delivery success on push or SMS.`,
    `Last push target: ${pushTried}.`,
    `Last SMS target: ${smsTried}.`,
    `This usually means we have stale contact details on file (bad phone, expired push token, SMS provider blocked them, etc.). Please check the coach's profile and use the admin "Resend" button after fixing the underlying problem — that will also reset this alert.`,
  ].join("\n\n");

  // 1) Atomic dedup + in-app message: stamp `coachRetryAdminNotifiedAt`
  //    (only if still NULL) and insert the in-app message in the same
  //    transaction. The conditional UPDATE ensures only one caller "wins"
  //    when two presses race; doing it transactionally with the insert
  //    means a partial failure (stamp succeeds, insert throws) never
  //    silently swallows the alert forever — it just retries on the
  //    next coach press once the stamp would be reverted on rollback.
  let winner = false;
  try {
    winner = await db.transaction(async (tx) => {
      const stamped = await tx.update(coachPayoutNotificationAttemptsTable)
        .set({ coachRetryAdminNotifiedAt: new Date() })
        .where(and(
          eq(coachPayoutNotificationAttemptsTable.id, attempt.id),
          isNull(coachPayoutNotificationAttemptsTable.coachRetryAdminNotifiedAt),
        ))
        .returning({ id: coachPayoutNotificationAttemptsTable.id });
      if (stamped.length === 0) return false;
      // Only insert the in-app trail when we have an associated club
      // member — `memberMessagesTable.clubMemberId` is NOT NULL.
      if (clubMemberId != null) {
        await tx.insert(memberMessagesTable).values({
          organizationId: attempt.organizationId,
          clubMemberId,
          senderUserId: null,
          channel: "in_app",
          subject,
          body,
          status: "sent",
          relatedEntity: "coach_payout_repeat_retry",
          relatedEntityId: attempt.id,
        });
      }
      return true;
    });
  } catch (err) {
    logger.warn(
      { ...logContext, attemptId: attempt.id, errMsg: err instanceof Error ? err.message : String(err) },
      "[coach-payout-notify] Repeated coach-retry stamp/insert failed",
    );
    return { notified: false, recipients: 0 };
  }

  if (!winner) {
    return { notified: false, recipients: 0 };
  }

  // 2) Push to org admins: same union as the exhaustion alert so admins
  //    see this in the same notification stream as other payout failures.
  const directAdmins = await db
    .select({ userId: appUsersTable.id })
    .from(appUsersTable)
    .where(and(eq(appUsersTable.organizationId, attempt.organizationId), eq(appUsersTable.role, "org_admin")));
  const memberAdmins = await db
    .select({ userId: appUsersTable.id })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
    .where(and(
      eq(orgMembershipsTable.organizationId, attempt.organizationId),
      inArray(orgMembershipsTable.role, ["org_admin", "treasurer", "membership_secretary", "committee_member", "competition_secretary"]),
    ));
  const userIds = new Set<number>();
  for (const a of directAdmins) userIds.add(a.userId);
  for (const a of memberAdmins) userIds.add(a.userId);

  const recipients = [...userIds];
  if (recipients.length > 0) {
    try {
      await sendTransactionalPush(
        recipients,
        `⚠️ Coach stuck on payout #${attempt.payoutId}`,
        `${recipientLabel} has retried ${amountStr} payout notification ${retries} times. Check their contact details.`,
        {
          type: "coach_payout_repeat_retry",
          attemptId: attempt.id,
          payoutId: attempt.payoutId,
          organizationId: attempt.organizationId,
          proId: attempt.proId,
          coachRetryCount: retries,
        },
      );
    } catch (err) {
      logger.warn(
        { ...logContext, attemptId: attempt.id, errMsg: err instanceof Error ? err.message : String(err) },
        "[coach-payout-notify] Repeated coach-retry admin push failed",
      );
    }
  }

  logger.info(
    { ...logContext, attemptId: attempt.id, retries, recipients: recipients.length },
    "[coach-payout-notify] Admins alerted: coach is stuck retrying payout",
  );

  return { notified: true, recipients: recipients.length };
}
