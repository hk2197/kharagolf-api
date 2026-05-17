/**
 * Levy receipt notification helper (Tasks #207, #223).
 *
 * Sends a transactional receipt to a member when an admin records a payment,
 * partial payment, refund, or waiver against a levy charge. Honours the
 * member's `billing` communication preferences across email, push, and SMS:
 * each channel is attempted independently when the member has opted in
 * (per-channel) and the matching contact info exists. If the member has no
 * billing-pref row, schema defaults apply (email = on, push = on, SMS = off).
 *
 * Each channel is best-effort and isolated:
 *   - A failure on one channel never prevents another from being attempted.
 *   - Any failure surfaces in the per-channel result for caller telemetry but
 *     never throws — the underlying financial action has already succeeded
 *     and is recorded in the audit log.
 */
import {
  db,
  clubMembersTable,
  organizationsTable,
  memberCommPrefsTable,
  memberLevyReceiptAttemptsTable,
  memberMessagesTable,
  appUsersTable,
  orgMembershipsTable,
  type MemberLevyReceiptAttempt,
} from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { sendLevyReceiptEmail, classifyMailerError, type LevyReceiptKind, type EmailBranding } from "./mailer";
import { sendTransactionalPush, sendTransactionalSms, sendTransactionalWhatsapp } from "./comms";
import { classifyPushDelivery } from "./push";
import { logger } from "./logger";

const CURRENCY_SYMBOLS: Record<string, string> = { INR: "₹", USD: "$", GBP: "£", EUR: "€" };

function symbolFor(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? `${currency} `;
}

function fmtAmount(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Per-channel delivery outcome for the receipt notification.
 *   sent       — provider accepted the message
 *   failed     — provider attempt failed (transient or hard error)
 *   no_address — member has no email/phone/registered device for this channel
 *   no_user    — member is not linked to an app user (push only)
 *   opted_out  — member has disabled this channel for the `billing` category
 *   skipped    — channel not attempted (e.g. SMS provider not configured)
 */
export type LevyReceiptChannelStatus =
  | "sent"
  | "failed"
  | "no_address"
  | "no_user"
  | "opted_out"
  | "skipped";

export interface LevyReceiptResult {
  /** Aggregated status preserved for back-compat with the original Task #207 helper. */
  status: "sent" | "skipped" | "failed";
  reason?: string;
  email: { status: LevyReceiptChannelStatus; error?: string };
  push: { status: LevyReceiptChannelStatus; error?: string };
  sms: { status: LevyReceiptChannelStatus; error?: string };
  whatsapp: { status: LevyReceiptChannelStatus; error?: string };
}

interface BillingPrefs {
  email: boolean;
  push: boolean;
  sms: boolean;
  whatsapp: boolean;
}

/**
 * Load the member's `billing` communication preferences. When no row exists
 * we fall back to the schema defaults so existing members keep getting email
 * (and push when they have a registered device) without an explicit opt-in.
 */
async function loadBillingPrefs(clubMemberId: number): Promise<BillingPrefs> {
  const [row] = await db.select({
    emailEnabled: memberCommPrefsTable.emailEnabled,
    smsEnabled: memberCommPrefsTable.smsEnabled,
    pushEnabled: memberCommPrefsTable.pushEnabled,
    whatsappEnabled: memberCommPrefsTable.whatsappEnabled,
  })
    .from(memberCommPrefsTable)
    .where(and(
      eq(memberCommPrefsTable.clubMemberId, clubMemberId),
      eq(memberCommPrefsTable.category, "billing"),
    )).limit(1);
  if (!row) return { email: true, push: true, sms: false, whatsapp: false };
  return {
    email: Boolean(row.emailEnabled),
    push: Boolean(row.pushEnabled),
    sms: Boolean(row.smsEnabled),
    whatsapp: Boolean(row.whatsappEnabled),
  };
}

function buildShortBody(opts: {
  kind: LevyReceiptKind;
  levyName: string;
  currencySymbol: string;
  amount: string;
  newBalance: string;
}): { title: string; body: string } {
  const { kind, levyName, currencySymbol, amount, newBalance } = opts;
  switch (kind) {
    case "payment":
      return {
        title: `Payment received — ${levyName}`,
        body: `We've recorded your ${currencySymbol}${amount} payment for ${levyName}. Balance settled.`,
      };
    case "partial_payment":
      return {
        title: `Partial payment received — ${levyName}`,
        body: `We've recorded your ${currencySymbol}${amount} payment for ${levyName}. Outstanding balance: ${currencySymbol}${newBalance}.`,
      };
    case "refund":
      return {
        title: `Refund issued — ${levyName}`,
        body: `A refund of ${currencySymbol}${amount} has been issued against your ${levyName} charge.`,
      };
    case "waiver":
      return {
        title: `Charge waived — ${levyName}`,
        body: `Your ${levyName} charge of ${currencySymbol}${amount} has been waived. Nothing further is owed.`,
      };
  }
}

export async function sendLevyReceipt(opts: {
  organizationId: number;
  clubMemberId: number;
  levyName: string;
  currency: string;
  kind: LevyReceiptKind;
  /** Amount of this transaction (payment / refund / waiver), as a number. */
  transactionAmount: number;
  /** Outstanding balance owed by the member after the action, as a number. */
  newBalance: number;
  note?: string | null;
  /**
   * The levy charge this receipt belongs to. When provided, an attempts row is
   * inserted so the retry cron can re-attempt failed push/SMS deliveries on a
   * bounded schedule (Task #247). Optional for back-compat: callers that do
   * not (yet) supply it simply skip the retry registration.
   */
  chargeId?: number;
}): Promise<LevyReceiptResult> {
  const { organizationId, clubMemberId, levyName, currency, kind, transactionAmount, newBalance, note } = opts;

  const result: LevyReceiptResult = {
    status: "skipped",
    email: { status: "skipped" },
    push: { status: "skipped" },
    sms: { status: "skipped" },
    whatsapp: { status: "skipped" },
  };

  let member: { firstName: string | null; lastName: string | null; email: string | null; phone: string | null; userId: number | null } | undefined;
  let prefs: BillingPrefs;
  try {
    [member] = await db.select({
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      email: clubMembersTable.email,
      phone: clubMembersTable.phone,
      userId: clubMembersTable.userId,
    }).from(clubMembersTable).where(eq(clubMembersTable.id, clubMemberId)).limit(1);
    prefs = await loadBillingPrefs(clubMemberId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ organizationId, clubMemberId, levyName, kind, errMsg: reason }, "[levy-receipt] Failed to load member or prefs");
    result.status = "failed";
    result.reason = reason;
    return result;
  }

  if (!member) {
    result.status = "skipped";
    result.reason = "member_not_found";
    return result;
  }

  // Branding lookup must never throw — fall back to defaults if the org row
  // can't be loaded so we still attempt every channel the member opted in to.
  let branding: EmailBranding = { orgName: "KHARAGOLF" };
  // Task #1099 — load org `defaultLanguage` alongside branding so the receipt
  // email renders in the club's configured language (EN fallback for unknown
  // codes is handled inside the mailer helper).
  let orgLang: string | null = null;
  try {
    const [org] = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
      defaultLanguage: organizationsTable.defaultLanguage,
    }).from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
    branding = {
      orgName: org?.name ?? "KHARAGOLF",
      logoUrl: org?.logoUrl ?? undefined,
      primaryColor: org?.primaryColor ?? undefined,
    };
    orgLang = org?.defaultLanguage ?? null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ organizationId, clubMemberId, levyName, kind, errMsg: reason }, "[levy-receipt] Failed to load org branding; using defaults");
  }

  const memberName = `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim();
  const amountStr = fmtAmount(transactionAmount);
  const balanceStr = fmtAmount(Math.max(0, newBalance));
  const currencySymbol = symbolFor(currency);
  const short = buildShortBody({ kind, levyName, currencySymbol, amount: amountStr, newBalance: balanceStr });

  // ── Email ────────────────────────────────────────────────────────────────
  // Task #1279 — track whether the SMTP server returned a permanent bounce
  // (`5xx` / `InactiveRecipient` / mailbox-not-found / etc) on the first
  // attempt so the persistence block below can stamp the row exhausted
  // immediately instead of waiting for the cron to burn the full retry
  // budget on a destination we already know is dead.
  let emailHardBounce = false;
  if (!prefs.email) {
    result.email.status = "opted_out";
  } else if (!member.email) {
    result.email.status = "no_address";
  } else {
    try {
      await sendLevyReceiptEmail({
        to: member.email,
        memberName,
        kind,
        levyName,
        currency,
        currencySymbol,
        amount: amountStr,
        newBalance: balanceStr,
        note: note ?? null,
        branding,
        lang: orgLang,
      });
      result.email.status = "sent";
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const errClass = classifyMailerError(err);
      // Provider misconfiguration → terminal `skipped` so the env
      // issue isn't logged as a delivery failure on every receipt.
      if (errClass === "provider_unconfigured") {
        result.email.status = "skipped";
        result.email.error = "provider_not_configured";
      } else {
        result.email.status = "failed";
        result.email.error = reason;
        if (errClass === "hard_bounce") emailHardBounce = true;
        logger.error({ organizationId, clubMemberId, levyName, kind, errMsg: reason, errClass }, "[levy-receipt] Failed to send receipt email");
      }
    }
  }

  // ── Push ─────────────────────────────────────────────────────────────────
  if (!prefs.push) {
    result.push.status = "opted_out";
  } else if (!member.userId) {
    result.push.status = "no_user";
  } else {
    try {
      const push = await sendTransactionalPush(
        [member.userId],
        short.title,
        short.body,
        { type: "levy_receipt", kind, levyName },
      );
      // Task #1070 — share the classifier so members without a linked
      // device stay `no_address` rather than `failed` on the levy
      // receipt telemetry.
      result.push.status = classifyPushDelivery(push);
      if (result.push.status === "failed") {
        result.push.error = "push_delivery_failed";
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.push.status = "failed";
      result.push.error = reason;
      logger.error({ organizationId, clubMemberId, levyName, kind, errMsg: reason }, "[levy-receipt] Failed to send receipt push");
    }
  }

  // ── SMS ──────────────────────────────────────────────────────────────────
  if (!prefs.sms) {
    result.sms.status = "opted_out";
  } else if (!member.phone) {
    result.sms.status = "no_address";
  } else {
    try {
      const smsBody = `${short.title}\n${short.body}`.slice(0, 320);
      await sendTransactionalSms(member.phone, smsBody);
      result.sms.status = "sent";
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // If the SMS provider isn't configured at all, mark as skipped rather
      // than failed so receipts in environments without an SMS provider don't
      // surface as errors.
      if (/SMS_PROVIDER not configured/i.test(reason)) {
        result.sms.status = "skipped";
        result.sms.error = "provider_not_configured";
      } else {
        result.sms.status = "failed";
        result.sms.error = reason;
        logger.error({ organizationId, clubMemberId, levyName, kind, errMsg: reason }, "[levy-receipt] Failed to send receipt SMS");
      }
    }
  }

  // ── WhatsApp ─────────────────────────────────────────────────────────────
  let whatsappMessageId: string | null = null;
  if (!prefs.whatsapp) {
    result.whatsapp.status = "opted_out";
  } else if (!member.phone) {
    result.whatsapp.status = "no_address";
  } else {
    try {
      const waBody = `${short.title}\n${short.body}`.slice(0, 1024);
      whatsappMessageId = await sendTransactionalWhatsapp(member.phone, waBody);
      result.whatsapp.status = "sent";
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Treat un-credentialed environments as terminal `skipped` so the
      // retry cron does not loop on rows it can never deliver.
      if (/WHATSAPP_PROVIDER not configured|WHATSAPP_PROVIDER_API_KEY|WhatsApp.*not configured/i.test(reason)) {
        result.whatsapp.status = "skipped";
        result.whatsapp.error = "provider_not_configured";
      } else {
        result.whatsapp.status = "failed";
        result.whatsapp.error = reason;
        logger.error({ organizationId, clubMemberId, levyName, kind, errMsg: reason }, "[levy-receipt] Failed to send receipt WhatsApp");
      }
    }
  }

  // Aggregate status: sent if any channel delivered; failed if any channel
  // failed (and none delivered); otherwise skipped.
  const statuses = [result.email.status, result.push.status, result.sms.status, result.whatsapp.status];
  if (statuses.includes("sent")) {
    result.status = "sent";
  } else if (statuses.includes("failed")) {
    result.status = "failed";
    result.reason = result.email.error ?? result.push.error ?? result.sms.error ?? result.whatsapp.error;
  } else {
    result.status = "skipped";
  }

  // Record a per-receipt attempts row so the retry cron can re-attempt failed
  // push/SMS deliveries on a bounded schedule (Task #247). We capture the
  // payload used to render the message so retries don't have to reconstruct it
  // from the (potentially mutated) charge/levy state.
  // Best-effort: a failure to persist this row never alters the receipt
  // outcome the caller sees.
  if (opts.chargeId != null) {
    try {
      const pushAttempted = result.push.status === "sent" || result.push.status === "failed";
      const smsAttempted = result.sms.status === "sent" || result.sms.status === "failed";
      const whatsappAttempted = result.whatsapp.status === "sent" || result.whatsapp.status === "failed";
      const emailAttempted = result.email.status === "sent" || result.email.status === "failed";
      const now = new Date();
      // Task #1847 — when the first attempt failed, schedule the retry
      // unless we know it's terminal (hard_bounce / cap of 1 already).
      // A hard bounce stamps the row exhausted immediately so the cron
      // never re-fires it, and the admin alert is dispatched below.
      const emailExhaustedNow = result.email.status === "failed" && emailHardBounce;
      const persistedEmailAttempts = emailExhaustedNow
        ? LEVY_RECEIPT_MAX_EMAIL_ATTEMPTS
        : (emailAttempted ? 1 : 0);
      const nextEmailRetryAt = result.email.status === "failed" && !emailExhaustedNow
        ? computeLevyReceiptNextRetryAt(1, now)
        : null;
      const [insertedRow] = await db.insert(memberLevyReceiptAttemptsTable).values({
        organizationId,
        chargeId: opts.chargeId,
        clubMemberId,
        kind,
        levyName,
        currency,
        transactionAmount: amountStr,
        newBalance: balanceStr,
        note: note ?? null,
        pushStatus: result.push.status,
        pushAttempts: pushAttempted ? 1 : 0,
        lastPushAt: pushAttempted ? now : null,
        lastPushError: result.push.error ?? null,
        smsStatus: result.sms.status,
        smsAttempts: smsAttempted ? 1 : 0,
        lastSmsAt: smsAttempted ? now : null,
        lastSmsError: result.sms.error ?? null,
        whatsappStatus: result.whatsapp.status,
        whatsappAttempts: whatsappAttempted ? 1 : 0,
        lastWhatsappAt: whatsappAttempted ? now : null,
        lastWhatsappError: result.whatsapp.error ?? null,
        // Task #507: persist provider message id so the WhatsApp delivery
        // webhook can map an async status callback back to this receipt.
        lastWhatsappMessageId: result.whatsapp.status === "sent" ? whatsappMessageId : null,
        // Task #1847 — email retry budget bookkeeping.
        emailStatus: result.email.status,
        emailAttempts: persistedEmailAttempts,
        lastEmailAt: emailAttempted ? now : null,
        lastEmailError: result.email.error ?? null,
        nextEmailRetryAt,
        emailRetryExhaustedAt: emailExhaustedNow ? now : null,
      }).returning({ id: memberLevyReceiptAttemptsTable.id });

      // Task #1279 — if the very first send hit a hard SMTP bounce, page
      // org admins straight away. Best-effort: alert dispatch failures
      // never derail the financial action that just settled.
      if (emailExhaustedNow && insertedRow) {
        try {
          const [stamped] = await db.select()
            .from(memberLevyReceiptAttemptsTable)
            .where(eq(memberLevyReceiptAttemptsTable.id, insertedRow.id))
            .limit(1);
          if (stamped) {
            await notifyAdminsOfLevyReceiptRetryExhaustion({
              attempt: stamped,
              channel: "email",
              reason: "hard_bounce",
              logContext: { organizationId, clubMemberId, chargeId: opts.chargeId },
            });
          }
        } catch (err) {
          logger.warn(
            { organizationId, clubMemberId, chargeId: opts.chargeId, errMsg: err instanceof Error ? err.message : String(err) },
            "[levy-receipt] Admin email exhaustion alert (initial hard bounce) failed",
          );
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ organizationId, clubMemberId, chargeId: opts.chargeId, errMsg: reason }, "[levy-receipt] Failed to record retry-attempts row");
    }
  }

  return result;
}

// ─── Retry helpers (Task #247) ────────────────────────────────────────────────
// Bounded retry cap per channel for a single receipt notification (initial
// attempt + retries). Once a channel reaches this cap, the cron stops
// re-attempting it and stamps `*RetryExhaustedAt` on the attempts row.
export const LEVY_RECEIPT_MAX_PUSH_ATTEMPTS = 5;
export const LEVY_RECEIPT_MAX_SMS_ATTEMPTS = 5;
// Task #296: per-surface cap for the WhatsApp channel. The WhatsApp fan-out
// itself (and its retry helper) is added by the levy-receipts surface task
// — this constant is exported here in the foundation task so all surfaces
// can compile against the shared cap pattern without further coordination.
export const LEVY_RECEIPT_MAX_WHATSAPP_ATTEMPTS = 5;
// Task #1847: matching cap for the email channel. Cap = 5 deliveries
// total (initial + 4 retries). Mirrors the wallet-withdrawal /
// side-game receipt convention so admin runbooks read the same way.
export const LEVY_RECEIPT_MAX_EMAIL_ATTEMPTS = 5;

// Task #1847 — exponential backoff schedule for email retries: 5, 10,
// 20, 40, 80 minutes between attempts (i.e. attempt N waits 5*2^(N-1)
// minutes after attempt N-1). Capped at 6h so a freak attempts value
// never produces a runaway delay. Mirrors `walletWithdrawalNotify`'s
// `computeNextRetryAt` exactly so ops have one mental model.
const LEVY_RECEIPT_EMAIL_BACKOFF_BASE_MS = 5 * 60 * 1000;
const LEVY_RECEIPT_EMAIL_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export function computeLevyReceiptNextRetryAt(completedAttempts: number, from: Date = new Date()): Date {
  const exp = Math.max(0, completedAttempts - 1);
  const delay = Math.min(
    LEVY_RECEIPT_EMAIL_BACKOFF_BASE_MS * Math.pow(2, exp),
    LEVY_RECEIPT_EMAIL_BACKOFF_MAX_MS,
  );
  return new Date(from.getTime() + delay);
}

export interface LevyReceiptRetryResult {
  channel: "push" | "sms" | "whatsapp" | "email";
  status: LevyReceiptChannelStatus;
  error?: string;
  attempts: number;
  exhausted: boolean;
}

function buildShortBodyForAttempt(a: MemberLevyReceiptAttempt) {
  return buildShortBody({
    kind: a.kind as LevyReceiptKind,
    levyName: a.levyName,
    currencySymbol: symbolFor(a.currency),
    amount: a.transactionAmount,
    newBalance: a.newBalance,
  });
}

/**
 * Re-attempt a previously failed push delivery for a single levy-receipt
 * notice. Looks up the member, rebuilds the notification body from the
 * persisted payload, fires push, and updates the attempts row with the new
 * status/attempt count. Returns `null` when the row is no longer eligible
 * (status no longer `failed`, cap reached, or the member has been deleted).
 */
export async function retryLevyReceiptPush(opts: {
  attempt: MemberLevyReceiptAttempt;
  logContext?: Record<string, unknown>;
}): Promise<LevyReceiptRetryResult | null> {
  const { attempt, logContext } = opts;
  if (attempt.pushStatus !== "failed") return null;
  const currentAttempts = attempt.pushAttempts ?? 0;
  if (currentAttempts >= LEVY_RECEIPT_MAX_PUSH_ATTEMPTS) return null;

  const [member] = await db.select({ userId: clubMembersTable.userId })
    .from(clubMembersTable).where(eq(clubMembersTable.id, attempt.clubMemberId)).limit(1);

  const short = buildShortBodyForAttempt(attempt);
  const nextAttempts = currentAttempts + 1;
  const now = new Date();
  let status: LevyReceiptChannelStatus;
  let error: string | undefined;

  if (!member?.userId) {
    status = "no_user";
  } else {
    try {
      const push = await sendTransactionalPush(
        [member.userId],
        short.title,
        short.body,
        { type: "levy_receipt", kind: attempt.kind, levyName: attempt.levyName, retry: true },
      );
      // Task #1070 — share the classifier with the rest of the notify
      // helpers; "no Expo tokens registered" must remain `no_address`.
      status = classifyPushDelivery(push);
      if (status === "failed") {
        error = "push_delivery_failed";
      }
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
      logger.error({ ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: error }, "[levy-receipt] Push retry failed");
    }
  }

  const exhausted = status === "failed" && nextAttempts >= LEVY_RECEIPT_MAX_PUSH_ATTEMPTS;
  await db.update(memberLevyReceiptAttemptsTable).set({
    pushStatus: status,
    lastPushAt: now,
    lastPushError: error ?? null,
    pushAttempts: nextAttempts,
    lastPushRetryAt: now,
    pushRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));

  return { channel: "push", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Re-attempt a previously failed SMS delivery for a single levy-receipt
 * notice. Mirrors {@link retryLevyReceiptPush}; returns `null` when the row
 * is no longer eligible for retry.
 */
export async function retryLevyReceiptSms(opts: {
  attempt: MemberLevyReceiptAttempt;
  logContext?: Record<string, unknown>;
}): Promise<LevyReceiptRetryResult | null> {
  const { attempt, logContext } = opts;
  if (attempt.smsStatus !== "failed") return null;
  const currentAttempts = attempt.smsAttempts ?? 0;
  if (currentAttempts >= LEVY_RECEIPT_MAX_SMS_ATTEMPTS) return null;

  const [member] = await db.select({ phone: clubMembersTable.phone })
    .from(clubMembersTable).where(eq(clubMembersTable.id, attempt.clubMemberId)).limit(1);

  const short = buildShortBodyForAttempt(attempt);
  const nextAttempts = currentAttempts + 1;
  const now = new Date();
  let status: LevyReceiptChannelStatus;
  let error: string | undefined;

  if (!member?.phone) {
    status = "no_address";
  } else {
    try {
      const smsBody = `${short.title}\n${short.body}`.slice(0, 320);
      await sendTransactionalSms(member.phone, smsBody);
      status = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/SMS_PROVIDER not configured/i.test(msg)) {
        // Provider unconfigured — flip status to terminal `skipped` so the
        // cron stops re-selecting this row every 15 min.
        const nowSkip = new Date();
        await db.update(memberLevyReceiptAttemptsTable).set({
          smsStatus: "skipped",
          lastSmsAt: nowSkip,
          lastSmsError: "provider_not_configured",
          lastSmsRetryAt: nowSkip,
        }).where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));
        return { channel: "sms", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      logger.error({ ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: msg }, "[levy-receipt] SMS retry failed");
    }
  }

  const exhausted = status === "failed" && nextAttempts >= LEVY_RECEIPT_MAX_SMS_ATTEMPTS;
  await db.update(memberLevyReceiptAttemptsTable).set({
    smsStatus: status,
    lastSmsAt: now,
    lastSmsError: error ?? null,
    smsAttempts: nextAttempts,
    lastSmsRetryAt: now,
    smsRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));

  return { channel: "sms", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Re-attempt a previously failed WhatsApp delivery for a single levy-receipt
 * notice. Mirrors {@link retryLevyReceiptSms}; returns `null` when the row is
 * no longer eligible for retry. Provider-not-configured errors flip the row
 * to terminal `skipped` so the cron stops re-selecting it.
 */
export async function retryLevyReceiptWhatsapp(opts: {
  attempt: MemberLevyReceiptAttempt;
  logContext?: Record<string, unknown>;
}): Promise<LevyReceiptRetryResult | null> {
  const { attempt, logContext } = opts;
  if (attempt.whatsappStatus !== "failed") return null;
  const currentAttempts = attempt.whatsappAttempts ?? 0;
  if (currentAttempts >= LEVY_RECEIPT_MAX_WHATSAPP_ATTEMPTS) return null;

  const [member] = await db.select({ phone: clubMembersTable.phone })
    .from(clubMembersTable).where(eq(clubMembersTable.id, attempt.clubMemberId)).limit(1);

  const short = buildShortBodyForAttempt(attempt);
  const nextAttempts = currentAttempts + 1;
  const now = new Date();
  let status: LevyReceiptChannelStatus;
  let error: string | undefined;
  let messageId: string | null = null;

  if (!member?.phone) {
    status = "no_address";
  } else {
    try {
      const waBody = `${short.title}\n${short.body}`.slice(0, 1024);
      messageId = await sendTransactionalWhatsapp(member.phone, waBody);
      status = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/WHATSAPP_PROVIDER not configured|WHATSAPP_PROVIDER_API_KEY|WhatsApp.*not configured/i.test(msg)) {
        const nowSkip = new Date();
        await db.update(memberLevyReceiptAttemptsTable).set({
          whatsappStatus: "skipped",
          lastWhatsappAt: nowSkip,
          lastWhatsappError: "provider_not_configured",
          lastWhatsappRetryAt: nowSkip,
        }).where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));
        return { channel: "whatsapp", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      logger.error({ ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: msg }, "[levy-receipt] WhatsApp retry failed");
    }
  }

  const exhausted = status === "failed" && nextAttempts >= LEVY_RECEIPT_MAX_WHATSAPP_ATTEMPTS;
  await db.update(memberLevyReceiptAttemptsTable).set({
    whatsappStatus: status,
    lastWhatsappAt: now,
    lastWhatsappError: error ?? null,
    // Task #507: refresh provider message id on every retry so a delivery
    // webhook can map a status callback to the most recent send. Clear it
    // on failed sends so a stale id from a prior attempt isn't applied.
    lastWhatsappMessageId: status === "sent" ? messageId : null,
    whatsappAttempts: nextAttempts,
    lastWhatsappRetryAt: now,
    whatsappRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));

  return { channel: "whatsapp", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Task #1847 — Re-attempt a previously failed email delivery for a single
 * levy-receipt notice. Looks up the member, rebuilds the receipt email
 * payload from the persisted snapshot, fires the mail, and updates the
 * attempts row with the new status / attempt count / next-retry-at.
 *
 * Returns `null` when the row is no longer eligible (status not `failed`,
 * cap reached, or backoff window not yet elapsed). Provider-not-configured
 * errors flip the row to terminal `skipped` so the cron stops re-selecting
 * it. Hard SMTP bounces (Task #1279) jump straight to exhausted.
 *
 * Honours the member's billing-category email opt-out and the user-level
 * `preferEmail` flag at retry time so a member who opted out between
 * attempts is never contacted again.
 */
export async function retryLevyReceiptEmail(opts: {
  attempt: MemberLevyReceiptAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<LevyReceiptRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.emailStatus !== "failed") return null;
  const currentAttempts = attempt.emailAttempts ?? 0;
  if (currentAttempts >= LEVY_RECEIPT_MAX_EMAIL_ATTEMPTS) return null;
  if (attempt.nextEmailRetryAt && attempt.nextEmailRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: LevyReceiptChannelStatus;
  let error: string | undefined;
  let hardBounce = false;

  // Re-load member + billing prefs at retry time. A member who opted
  // out (or was deleted) between the original send and this retry must
  // not be contacted again.
  const [member] = await db.select({
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    email: clubMembersTable.email,
  }).from(clubMembersTable).where(eq(clubMembersTable.id, attempt.clubMemberId)).limit(1);

  let categoryOptedIn = true;
  try {
    const prefs = await loadBillingPrefs(attempt.clubMemberId);
    categoryOptedIn = prefs.email;
  } catch (err) {
    logger.warn(
      { ...logContext, attemptId: attempt.id, errMsg: err instanceof Error ? err.message : String(err) },
      "[levy-receipt] Failed to load billing prefs on email retry; defaulting to ON",
    );
  }

  if (!categoryOptedIn) {
    status = "opted_out";
  } else if (!member?.email) {
    status = "no_address";
  } else {
    // Re-render the receipt against the original snapshot so retries
    // land identical to the first attempt regardless of subsequent
    // charge/levy mutations.
    const memberName = `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim();
    let branding: EmailBranding = { orgName: "KHARAGOLF" };
    let orgLang: string | null = null;
    try {
      const [org] = await db.select({
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
        defaultLanguage: organizationsTable.defaultLanguage,
      }).from(organizationsTable).where(eq(organizationsTable.id, attempt.organizationId)).limit(1);
      branding = {
        orgName: org?.name ?? "KHARAGOLF",
        logoUrl: org?.logoUrl ?? undefined,
        primaryColor: org?.primaryColor ?? undefined,
      };
      orgLang = org?.defaultLanguage ?? null;
    } catch {
      // best-effort
    }

    try {
      await sendLevyReceiptEmail({
        to: member.email,
        memberName,
        kind: attempt.kind as LevyReceiptKind,
        levyName: attempt.levyName,
        currency: attempt.currency,
        currencySymbol: symbolFor(attempt.currency),
        amount: attempt.transactionAmount,
        newBalance: attempt.newBalance,
        note: attempt.note ?? null,
        branding,
        lang: orgLang,
      });
      status = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errClass = classifyMailerError(err);
      if (errClass === "provider_unconfigured") {
        await db.update(memberLevyReceiptAttemptsTable).set({
          emailStatus: "skipped",
          lastEmailAt: now,
          lastEmailError: "provider_not_configured",
          lastEmailRetryAt: now,
          nextEmailRetryAt: null,
        }).where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));
        return { channel: "email", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      if (errClass === "hard_bounce") hardBounce = true;
      logger.error({ ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: msg, errClass }, "[levy-receipt] Email retry failed");
    }
  }

  const exhausted = status === "failed" && (hardBounce || nextAttempts >= LEVY_RECEIPT_MAX_EMAIL_ATTEMPTS);
  // Hard bounce stamps the row at the cap so further cron passes
  // skip it on the `emailAttempts < cap` predicate even if a future
  // change widens the WHERE clause.
  const persistedAttempts = exhausted && hardBounce
    ? LEVY_RECEIPT_MAX_EMAIL_ATTEMPTS
    : nextAttempts;
  await db.update(memberLevyReceiptAttemptsTable).set({
    emailStatus: status,
    lastEmailAt: now,
    lastEmailError: error ?? null,
    emailAttempts: persistedAttempts,
    lastEmailRetryAt: now,
    nextEmailRetryAt: status === "failed" && !exhausted ? computeLevyReceiptNextRetryAt(nextAttempts, now) : null,
    emailRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(memberLevyReceiptAttemptsTable.id, attempt.id));

  if (exhausted) {
    try {
      const [stamped] = await db.select()
        .from(memberLevyReceiptAttemptsTable)
        .where(eq(memberLevyReceiptAttemptsTable.id, attempt.id))
        .limit(1);
      if (stamped) {
        await notifyAdminsOfLevyReceiptRetryExhaustion({
          attempt: stamped,
          channel: "email",
          reason: hardBounce ? "hard_bounce" : "max_attempts",
          logContext,
        });
      }
    } catch (err) {
      logger.warn(
        { ...logContext, attemptId: attempt.id, errMsg: err instanceof Error ? err.message : String(err) },
        "[levy-receipt] Admin email exhaustion alert dispatch failed",
      );
    }
  }

  return { channel: "email", status, error, attempts: persistedAttempts, exhausted };
}

/**
 * Task #269 — Notify org admins when a levy-receipt push or SMS retry gives up.
 *
 * Mirrors the privacy-notice email exhaustion alert (Task #238). Once the
 * bounded retry cap is hit on a channel, finance/admin staff need a proactive
 * signal so they can manually contact the member or fix the underlying
 * contact info — without this they would only notice if they happened to
 * open the Member 360. We surface this via:
 *   1. An in-app message attached to the affected member's record (visible
 *      on the Member 360 timeline) that links back to the levy charge so
 *      admins can jump straight to the failed receipt.
 *   2. A push to all org admins / treasurers / membership-secretaries so
 *      the failure doesn't sit unnoticed.
 *
 * De-duplication: stamps `pushExhaustionNotifiedAt` / `smsExhaustionNotifiedAt`
 * on the attempts row (per channel). If it's already set we no-op so the same
 * exhaustion isn't announced twice across cron passes. The dedup is performed
 * atomically with the in-app insert in a transaction so a partial failure
 * (stamp succeeds, insert throws) cannot suppress the alert forever.
 */
export async function notifyAdminsOfLevyReceiptRetryExhaustion(opts: {
  attempt: MemberLevyReceiptAttempt;
  channel: "push" | "sms" | "email";
  // Task #1847 — when "hard_bounce" the body explains the early
  // termination ("permanent SMTP bounce on the first attempt") instead
  // of the default "after N failed attempts" wording so on-call ops
  // immediately recognise the difference.
  reason?: "hard_bounce" | "max_attempts";
  logContext?: Record<string, unknown>;
}): Promise<{ notified: boolean; recipients: number }> {
  const { attempt, channel, logContext } = opts;
  const reason = opts.reason ?? "max_attempts";

  const [member] = await db.select({
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    email: clubMembersTable.email,
    phone: clubMembersTable.phone,
  }).from(clubMembersTable).where(eq(clubMembersTable.id, attempt.clubMemberId)).limit(1);

  const memberName = member
    ? `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim() || `member #${attempt.clubMemberId}`
    : `member #${attempt.clubMemberId}`;
  const channelLabel = channel === "push"
    ? "push notification"
    : channel === "sms"
      ? "SMS"
      : "email";
  const contactOnFile = channel === "push"
    ? "(no registered devices or push token)"
    : channel === "sms"
      ? (member?.phone ?? "(no phone on file)")
      : (member?.email ?? "(no email on file)");
  const lastError = channel === "push"
    ? attempt.lastPushError
    : channel === "sms"
      ? attempt.lastSmsError
      : attempt.lastEmailError;
  const cap = channel === "push"
    ? LEVY_RECEIPT_MAX_PUSH_ATTEMPTS
    : channel === "sms"
      ? LEVY_RECEIPT_MAX_SMS_ATTEMPTS
      : LEVY_RECEIPT_MAX_EMAIL_ATTEMPTS;
  const symbol = symbolFor(attempt.currency);
  const deepLink = `/member-360/${attempt.clubMemberId}?tab=billing&charge=${attempt.chargeId}`;

  const subject = `Levy receipt ${channelLabel} delivery failed — ${memberName} (${attempt.levyName})`;
  const body = [
    reason === "hard_bounce"
      ? `The system has stopped retrying the ${channelLabel} for ${memberName}'s ${attempt.levyName} receipt (${symbol}${attempt.transactionAmount} · ${attempt.kind.replace(/_/g, " ")}) because the provider returned a permanent bounce on the first attempt.`
      : `The system has stopped retrying the ${channelLabel} for ${memberName}'s ${attempt.levyName} receipt (${symbol}${attempt.transactionAmount} · ${attempt.kind.replace(/_/g, " ")}) after ${cap} failed attempts.`,
    `Last delivery error: ${lastError ?? "unknown"}.`,
    channel === "sms"
      ? `Member phone on file: ${contactOnFile}.`
      : channel === "email"
        ? `Member email on file: ${contactOnFile}.`
        : `${contactOnFile}.`,
    `Please contact the member through another channel or update their contact details. Open the charge in Member 360 → Billing to follow up.`,
  ].join("\n\n");

  // 1) Atomic dedup + in-app message: stamp the per-channel notified-at
  //    column (only if still NULL) and insert the in-app message in the
  //    same transaction. Stamping in the same UPDATE prevents two
  //    concurrent cron passes from both winning; doing it transactionally
  //    with the insert prevents a partial failure (stamp succeeds, insert
  //    throws) from suppressing the alert forever.
  const winner = await db.transaction(async (tx) => {
    const stamped = channel === "push"
      ? await tx.update(memberLevyReceiptAttemptsTable)
          .set({ pushExhaustionNotifiedAt: new Date() })
          .where(and(
            eq(memberLevyReceiptAttemptsTable.id, attempt.id),
            isNull(memberLevyReceiptAttemptsTable.pushExhaustionNotifiedAt),
          ))
          .returning({ id: memberLevyReceiptAttemptsTable.id })
      : channel === "sms"
        ? await tx.update(memberLevyReceiptAttemptsTable)
            .set({ smsExhaustionNotifiedAt: new Date() })
            .where(and(
              eq(memberLevyReceiptAttemptsTable.id, attempt.id),
              isNull(memberLevyReceiptAttemptsTable.smsExhaustionNotifiedAt),
            ))
            .returning({ id: memberLevyReceiptAttemptsTable.id })
        : await tx.update(memberLevyReceiptAttemptsTable)
            .set({ emailExhaustionNotifiedAt: new Date() })
            .where(and(
              eq(memberLevyReceiptAttemptsTable.id, attempt.id),
              isNull(memberLevyReceiptAttemptsTable.emailExhaustionNotifiedAt),
            ))
            .returning({ id: memberLevyReceiptAttemptsTable.id });
    if (stamped.length === 0) return false;
    await tx.insert(memberMessagesTable).values({
      organizationId: attempt.organizationId,
      clubMemberId: attempt.clubMemberId,
      senderUserId: null,
      channel: "in_app",
      subject,
      body,
      status: "sent",
      relatedEntity: channel === "push"
        ? "levy_receipt_push_exhausted"
        : channel === "sms"
          ? "levy_receipt_sms_exhausted"
          : "levy_receipt_email_exhausted",
      relatedEntityId: attempt.id,
    });
    return true;
  });

  if (!winner) {
    return { notified: false, recipients: 0 };
  }

  // 2) Push to org admins (direct app_users.role='org_admin' for this org +
  //    org_memberships admin/treasurer/membership-secretary roles).
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
  const pushChannelLabel = channel === "push"
    ? "Push"
    : channel === "sms"
      ? "SMS"
      : "Email";
  if (recipients.length > 0) {
    try {
      await sendTransactionalPush(
        recipients,
        `⚠️ Levy receipt ${channelLabel} retries exhausted`,
        `${pushChannelLabel} to ${memberName} for ${attempt.levyName} permanently failed. Manual follow-up required.`,
        {
          type: channel === "push"
            ? "levy_receipt_push_exhausted"
            : channel === "sms"
              ? "levy_receipt_sms_exhausted"
              : "levy_receipt_email_exhausted",
          attemptId: attempt.id,
          chargeId: attempt.chargeId,
          clubMemberId: attempt.clubMemberId,
          route: deepLink,
          reason,
        },
      );
    } catch (err) {
      logger.warn(
        { ...logContext, attemptId: attempt.id, channel, errMsg: err instanceof Error ? err.message : String(err) },
        "[levy-receipt] Admin exhaustion push failed",
      );
    }
  }

  logger.info(
    { ...logContext, attemptId: attempt.id, channel, reason, recipients: recipients.length },
    "[levy-receipt] Admins alerted: retry exhausted",
  );

  return { notified: true, recipients: recipients.length };
}
