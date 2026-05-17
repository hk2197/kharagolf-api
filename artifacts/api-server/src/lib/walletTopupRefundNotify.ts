/**
 * Wallet top-up auto-refund notification (Task #919, extended in Task #1068).
 *
 * Fires when the daily reconciliation cron `refundOrphanedWalletTopups`
 * issues a refund (or records the audit row for a payment Razorpay had
 * already refunded) for a wallet top-up where the bank charged the
 * member but the wallet credit never landed. Closes the loop on
 * confused "you took my money" support tickets by telling the member:
 *   - in-app inbox row (memberMessagesTable) — only when the recipient
 *     has a club_members row in the wallet's organization, since the
 *     inbox is keyed off clubMemberId.
 *   - push (sendPushToUsers) — fans out to the member's registered
 *     Expo device tokens.
 *   - email (sendWalletTopupAutoRefundedEmail) — best-effort
 *     transactional notice with the Razorpay refund id and the amount
 *     headed back to their bank.
 *   - SMS (sendTransactionalSms) — short notice to the phone on file.
 *   - WhatsApp (sendTransactionalWhatsapp) — same body as SMS.
 *
 * Honours the recipient's existing channel preferences:
 *   - push respects `userNotificationPrefsTable.preferPush` (default true)
 *   - email respects `userNotificationPrefsTable.preferEmail` (default true)
 *     AND, when the recipient has a club_members row in the org,
 *     `memberCommPrefsTable.emailEnabled` for the `billing` category
 *     (default true).
 *   - SMS / WhatsApp respect `memberCommPrefsTable.smsEnabled` /
 *     `whatsappEnabled` for the `billing` category. Schema defaults
 *     for these channels are OFF, so a member must have an explicit
 *     opt-in row to receive them. The phone number is read from
 *     `clubMembersTable.phone`; without a club_members row in the
 *     org we have no phone and the channel is `no_address`.
 *
 * Per-user de-dup: this helper is invoked exactly once per refunded
 * payment by the caller (the cron only calls it the first time the
 * `wallet_topup_refund` audit row is inserted for a given paymentId), so
 * a payment that re-appears in a later cron pass cannot notify twice
 * across any channel.
 *
 * Fire-and-forget: every channel is best-effort and isolated. Failures
 * are logged but never thrown — the underlying refund has already
 * succeeded.
 */
import { db } from "@workspace/db";
import {
  appUsersTable,
  clubMembersTable,
  memberCommPrefsTable,
  memberMessagesTable,
  organizationsTable,
  userNotificationPrefsTable,
  walletTopupRefundNotifyAttemptsTable,
  type WalletTopupRefundNotifyAttempt,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { sendPushToUsers, classifyPushDelivery } from "./push";
import { sendTransactionalSms, sendTransactionalWhatsapp } from "./comms";
import { sendWalletTopupAutoRefundedEmail, classifyMailerError, type EmailBranding } from "./mailer";
import { logger } from "./logger";
import {
  formatRefundAmount,
  resolveWalletRefundLang,
  translateWalletRefund,
} from "./walletRefundI18n";

const CURRENCY_SYMBOLS: Record<string, string> = { INR: "₹", USD: "$", GBP: "£", EUR: "€" };

function symbolFor(currency: string | null | undefined): string {
  const c = (currency ?? "INR").toUpperCase();
  return CURRENCY_SYMBOLS[c] ?? `${c} `;
}

export type NotifyChannelStatus = "sent" | "failed" | "skipped" | "opted_out" | "no_address";

export interface WalletTopupRefundNotifyResult {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  inApp: { status: NotifyChannelStatus; messageId?: number; error?: string };
  push: { status: NotifyChannelStatus; error?: string };
  email: { status: NotifyChannelStatus; error?: string };
  sms: { status: NotifyChannelStatus; error?: string };
  whatsapp: { status: NotifyChannelStatus; error?: string };
}

export interface WalletTopupRefundNotifyArgs {
  organizationId: number;
  userId: number;
  paymentId: string;
  /** Razorpay refund id (when we just issued it). May be null for the
   * "already refunded at Razorpay" branch where we only recorded an
   * audit row. */
  refundId: string | null;
  amount: number;
  currency: string;
}

/**
 * Notify a member that their failed wallet top-up has been auto-refunded.
 *
 * Returns a per-channel result for telemetry but never throws.
 */
export async function notifyWalletTopupAutoRefunded(
  args: WalletTopupRefundNotifyArgs,
): Promise<WalletTopupRefundNotifyResult> {
  const result: WalletTopupRefundNotifyResult = {
    status: "skipped",
    inApp: { status: "skipped" },
    push: { status: "skipped" },
    email: { status: "skipped" },
    sms: { status: "skipped" },
    whatsapp: { status: "skipped" },
  };

  const currency = (args.currency ?? "INR").toUpperCase();
  const currencySymbol = symbolFor(currency);

  // Look up the recipient's preferred language so push/email/in-app
  // copy render in their locale (Task #1069). Best-effort: any failure
  // here just falls through to English.
  let lang = resolveWalletRefundLang(null);
  try {
    const [u] = await db
      .select({ preferredLanguage: appUsersTable.preferredLanguage })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, args.userId))
      .limit(1);
    lang = resolveWalletRefundLang(u?.preferredLanguage);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { paymentId: args.paymentId, errMsg: reason },
      "[wallet-topup-refund-notify] preferred-language lookup failed; defaulting to English",
    );
  }

  const amountStr = formatRefundAmount(args.amount, currency, lang, currencySymbol);

  // ── In-app message ──────────────────────────────────────────────────
  let clubMember:
    | {
        id: number;
        email: string | null;
        firstName: string | null;
        lastName: string | null;
        phone: string | null;
      }
    | undefined;
  try {
    const [m] = await db
      .select({
        id: clubMembersTable.id,
        email: clubMembersTable.email,
        firstName: clubMembersTable.firstName,
        lastName: clubMembersTable.lastName,
        phone: clubMembersTable.phone,
      })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, args.organizationId),
        eq(clubMembersTable.userId, args.userId),
      ))
      .limit(1);
    clubMember = m;
    if (!clubMember) {
      result.inApp.status = "skipped";
    } else {
      const recipientNameForInApp = `${clubMember.firstName ?? ""} ${clubMember.lastName ?? ""}`.trim();
      const tx = translateWalletRefund(lang, {
        name: recipientNameForInApp,
        amount: amountStr,
        orgName: "",
        refundId: args.refundId,
      });
      const [msg] = await db.insert(memberMessagesTable).values({
        organizationId: args.organizationId,
        clubMemberId: clubMember.id,
        channel: "in_app",
        subject: tx.inAppSubject,
        body: tx.inAppBody,
        status: "sent",
        relatedEntity: "wallet_topup_refund",
        relatedEntityId: null,
      }).returning({ id: memberMessagesTable.id });
      result.inApp.status = "sent";
      result.inApp.messageId = msg?.id;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    result.inApp.status = "failed";
    result.inApp.error = reason;
    logger.warn(
      { paymentId: args.paymentId, errMsg: reason },
      "[wallet-topup-refund-notify] in-app insert failed",
    );
  }

  // ── Billing-category preferences (shared by email / SMS / WhatsApp) ─
  // When the recipient has a club_members row, look up their `billing`
  // preferences once. Schema defaults: email=on, sms=off, whatsapp=off.
  // Members without a row in the org keep the schema defaults too — for
  // SMS/WhatsApp that means we won't surprise them with messages they
  // never opted in to.
  let billingPrefs: { email: boolean; sms: boolean; whatsapp: boolean } | undefined;
  if (clubMember) {
    try {
      const [catPref] = await db
        .select({
          emailEnabled: memberCommPrefsTable.emailEnabled,
          smsEnabled: memberCommPrefsTable.smsEnabled,
          whatsappEnabled: memberCommPrefsTable.whatsappEnabled,
        })
        .from(memberCommPrefsTable)
        .where(and(
          eq(memberCommPrefsTable.clubMemberId, clubMember.id),
          eq(memberCommPrefsTable.category, "billing"),
        ))
        .limit(1);
      billingPrefs = catPref
        ? {
            email: Boolean(catPref.emailEnabled),
            sms: Boolean(catPref.smsEnabled),
            whatsapp: Boolean(catPref.whatsappEnabled),
          }
        : { email: true, sms: false, whatsapp: false };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        { paymentId: args.paymentId, errMsg: reason },
        "[wallet-topup-refund-notify] failed to load billing comm prefs",
      );
      // Fall back to schema defaults so a prefs lookup error doesn't
      // silently turn email off.
      billingPrefs = { email: true, sms: false, whatsapp: false };
    }
  }

  // ── Email ───────────────────────────────────────────────────────────
  try {
    const [pref] = await db
      .select({ preferEmail: userNotificationPrefsTable.preferEmail })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, args.userId))
      .limit(1);
    const preferEmail = pref?.preferEmail ?? true;
    if (!preferEmail) {
      result.email.status = "opted_out";
    } else {
      // Per-category opt-in only applies when the recipient has a
      // club_members row in the wallet's org.
      const categoryOptedIn = clubMember ? (billingPrefs?.email ?? true) : true;

      if (!categoryOptedIn) {
        result.email.status = "opted_out";
      } else {
        let email = clubMember?.email ?? null;
        let recipientName = clubMember
          ? `${clubMember.firstName ?? ""} ${clubMember.lastName ?? ""}`.trim()
          : "";
        if (!email || !recipientName) {
          const [u] = await db
            .select({
              email: appUsersTable.email,
              displayName: appUsersTable.displayName,
              username: appUsersTable.username,
            })
            .from(appUsersTable)
            .where(eq(appUsersTable.id, args.userId))
            .limit(1);
          if (!email) email = u?.email ?? null;
          if (!recipientName) recipientName = (u?.displayName ?? u?.username ?? "").trim();
        }

        if (!email) {
          result.email.status = "no_address";
        } else {
          let branding: EmailBranding = { orgName: "KHARAGOLF" };
          try {
            const [org] = await db
              .select({
                name: organizationsTable.name,
                logoUrl: organizationsTable.logoUrl,
                primaryColor: organizationsTable.primaryColor,
              })
              .from(organizationsTable)
              .where(eq(organizationsTable.id, args.organizationId))
              .limit(1);
            branding = {
              orgName: org?.name ?? "KHARAGOLF",
              logoUrl: org?.logoUrl ?? undefined,
              primaryColor: org?.primaryColor ?? undefined,
            };
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.warn(
              { paymentId: args.paymentId, errMsg: reason },
              "[wallet-topup-refund-notify] failed to load org branding for email",
            );
          }

          const tx = translateWalletRefund(lang, {
            name: recipientName,
            amount: amountStr,
            orgName: branding.orgName ?? "KHARAGOLF",
            refundId: args.refundId,
          });
          await sendWalletTopupAutoRefundedEmail({
            to: email,
            recipientName,
            currency,
            amount: amountStr,
            refundId: args.refundId,
            paymentId: args.paymentId,
            branding,
            i18n: {
              subject: tx.emailSubject,
              headerLabel: tx.emailHeaderLabel,
              h2: tx.emailH2,
              introHtml: tx.emailIntroHtml,
              labelAmount: tx.emailLabelAmount,
              labelCurrency: tx.emailLabelCurrency,
              labelOriginalPayment: tx.emailLabelOriginalPayment,
              labelRefundReference: tx.emailLabelRefundReference,
              footer: tx.emailFooter,
            },
          });
          result.email.status = "sent";
        }
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Provider misconfiguration → terminal `skipped` so the cron never
    // re-selects this row and the admin's inbox isn't billed.
    if (classifyMailerError(err) === "provider_unconfigured") {
      result.email.status = "skipped";
      result.email.error = "provider_not_configured";
    } else {
      result.email.status = "failed";
      result.email.error = reason;
      logger.warn(
        { paymentId: args.paymentId, errMsg: reason },
        "[wallet-topup-refund-notify] email delivery failed",
      );
    }
  }

  // ── Push ────────────────────────────────────────────────────────────
  try {
    const [pref] = await db
      .select({ preferPush: userNotificationPrefsTable.preferPush })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, args.userId))
      .limit(1);
    const preferPush = pref?.preferPush ?? true;
    if (!preferPush) {
      result.push.status = "opted_out";
    } else {
      const tx = translateWalletRefund(lang, {
        name: "",
        amount: amountStr,
        orgName: "",
        refundId: args.refundId,
      });
      const push = await sendPushToUsers([args.userId], tx.pushTitle, tx.pushBody, {
        type: "wallet_topup_auto_refund",
        organizationId: args.organizationId,
        paymentId: args.paymentId,
        refundId: args.refundId,
        amount: amountStr,
        currency,
        lang,
      });
      // Task #1070 — share the classifier so "no Expo tokens registered"
      // stays `no_address` rather than getting reported as a delivery
      // failure. Previously this branch treated the (attempted=1, sent=0,
      // failed=0, invalid=0) shape — i.e. a member with no devices linked
      // — as `failed`, polluting the wallet-refund telemetry.
      result.push.status = classifyPushDelivery(push);
      if (result.push.status === "failed") {
        result.push.error = "push_delivery_failed";
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    result.push.status = "failed";
    result.push.error = reason;
    logger.warn(
      { paymentId: args.paymentId, errMsg: reason },
      "[wallet-topup-refund-notify] push delivery failed",
    );
  }

  // ── SMS / WhatsApp body ─────────────────────────────────────────────
  // Same human-readable copy as the push notification, in the
  // recipient's preferred language (Task #1069), with the refund
  // reference appended when we just issued one. Trimmed per channel
  // below to fit each provider's payload limits.
  const shortTx = translateWalletRefund(lang, {
    name: "",
    amount: amountStr,
    orgName: "",
    refundId: args.refundId,
  });
  const shortBody = `${shortTx.pushTitle}\n${shortTx.inAppBody}`;

  // ── SMS ─────────────────────────────────────────────────────────────
  if (!clubMember || !clubMember.phone) {
    result.sms.status = "no_address";
  } else if (!(billingPrefs?.sms ?? false)) {
    result.sms.status = "opted_out";
  } else {
    try {
      await sendTransactionalSms(clubMember.phone, shortBody.slice(0, 320));
      result.sms.status = "sent";
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Treat un-credentialed environments as terminal `skipped` so we
      // don't surface "errors" in deployments without an SMS provider.
      if (/SMS_PROVIDER not configured/i.test(reason)) {
        result.sms.status = "skipped";
        result.sms.error = "provider_not_configured";
      } else {
        result.sms.status = "failed";
        result.sms.error = reason;
        logger.warn(
          { paymentId: args.paymentId, errMsg: reason },
          "[wallet-topup-refund-notify] SMS delivery failed",
        );
      }
    }
  }

  // ── WhatsApp ────────────────────────────────────────────────────────
  if (!clubMember || !clubMember.phone) {
    result.whatsapp.status = "no_address";
  } else if (!(billingPrefs?.whatsapp ?? false)) {
    result.whatsapp.status = "opted_out";
  } else {
    try {
      await sendTransactionalWhatsapp(clubMember.phone, shortBody.slice(0, 1024));
      result.whatsapp.status = "sent";
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (/WHATSAPP_PROVIDER not configured|WHATSAPP_PROVIDER_API_KEY|WhatsApp.*not configured/i.test(reason)) {
        result.whatsapp.status = "skipped";
        result.whatsapp.error = "provider_not_configured";
      } else {
        result.whatsapp.status = "failed";
        result.whatsapp.error = reason;
        logger.warn(
          { paymentId: args.paymentId, errMsg: reason },
          "[wallet-topup-refund-notify] WhatsApp delivery failed",
        );
      }
    }
  }

  const statuses = [
    result.inApp.status,
    result.push.status,
    result.email.status,
    result.sms.status,
    result.whatsapp.status,
  ];
  if (statuses.includes("sent")) {
    result.status = "sent";
  } else if (statuses.includes("failed")) {
    result.status = "failed";
    result.reason =
      result.inApp.error ??
      result.push.error ??
      result.email.error ??
      result.sms.error ??
      result.whatsapp.error;
  } else {
    result.status = "skipped";
  }

  // ── Persist attempts row (Task #1280) ──────────────────────────────
  // One row per paymentId — the audit-row dedup in the caller
  // (`refundOrphanedWalletTopups` only invokes this helper the first
  // time the `wallet_topup_refund` audit row is inserted) means we
  // never get a second call for the same paymentId. The unique index
  // also defends against a re-fire if a cron loop somehow re-invokes
  // the notify in the same process. Best-effort: a failure to persist
  // never alters the notify outcome the caller sees.
  try {
    const now = new Date();
    const emailAttempted = result.email.status === "sent" || result.email.status === "failed";
    const pushAttempted = result.push.status === "sent" || result.push.status === "failed";
    const smsAttempted = result.sms.status === "sent" || result.sms.status === "failed";
    const whatsappAttempted = result.whatsapp.status === "sent" || result.whatsapp.status === "failed";
    const nextEmail = result.email.status === "failed" ? computeNextRetryAt(1, now) : null;
    const nextPush = result.push.status === "failed" ? computeNextRetryAt(1, now) : null;
    const nextSms = result.sms.status === "failed" ? computeNextRetryAt(1, now) : null;
    const nextWhatsapp = result.whatsapp.status === "failed" ? computeNextRetryAt(1, now) : null;
    await db.insert(walletTopupRefundNotifyAttemptsTable).values({
      paymentId: args.paymentId,
      organizationId: args.organizationId,
      userId: args.userId,
      refundId: args.refundId ?? null,
      // Persist the raw decimal so the column stays numeric-parseable
      // (`amountStr` is the localized human-readable form, e.g. "₹250.00").
      amount: args.amount.toFixed(2),
      currency,
      emailStatus: result.email.status,
      emailAttempts: emailAttempted ? 1 : 0,
      lastEmailAt: emailAttempted ? now : null,
      lastEmailError: result.email.error ?? null,
      nextEmailRetryAt: nextEmail,
      pushStatus: result.push.status,
      pushAttempts: pushAttempted ? 1 : 0,
      lastPushAt: pushAttempted ? now : null,
      lastPushError: result.push.error ?? null,
      nextPushRetryAt: nextPush,
      // Task #1508 — persist SMS / WhatsApp state too so the cron can
      // sweep transient failures on those channels.
      smsStatus: result.sms.status,
      smsAttempts: smsAttempted ? 1 : 0,
      lastSmsAt: smsAttempted ? now : null,
      lastSmsError: result.sms.error ?? null,
      nextSmsRetryAt: nextSms,
      whatsappStatus: result.whatsapp.status,
      whatsappAttempts: whatsappAttempted ? 1 : 0,
      lastWhatsappAt: whatsappAttempted ? now : null,
      lastWhatsappError: result.whatsapp.error ?? null,
      nextWhatsappRetryAt: nextWhatsapp,
    }).onConflictDoNothing({
      target: walletTopupRefundNotifyAttemptsTable.paymentId,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { paymentId: args.paymentId, errMsg: reason },
      "[wallet-topup-refund-notify] Failed to record retry-attempts row",
    );
  }

  return result;
}

// ─── Retry helpers (Task #1280) ────────────────────────────────────────────
// Bounded retry cap per channel for a single wallet-topup-refund notice
// (initial attempt + retries). Once a channel reaches this cap the cron
// stops re-attempting it and stamps `*RetryExhaustedAt`. Mirrors the
// wallet-withdrawal pattern from Task #1108.
export const WALLET_TOPUP_REFUND_NOTIFY_MAX_EMAIL_ATTEMPTS = 5;
export const WALLET_TOPUP_REFUND_NOTIFY_MAX_PUSH_ATTEMPTS = 5;
// Task #1508 — same cap on the SMS / WhatsApp side. SMS opt-in is OFF
// by default, so a recipient who reaches this cap is necessarily a
// member who explicitly opted in and whose provider has been failing
// for the full backoff window.
export const WALLET_TOPUP_REFUND_NOTIFY_MAX_SMS_ATTEMPTS = 5;
export const WALLET_TOPUP_REFUND_NOTIFY_MAX_WHATSAPP_ATTEMPTS = 5;

// Exponential-backoff schedule: 5, 10, 20, 40, 80 minutes between
// attempts (i.e. attempt N waits 5 * 2^(N-1) minutes after attempt
// N-1). Capped so a freak `attempts` value never produces a runaway
// delay.
const WALLET_TOPUP_REFUND_NOTIFY_BACKOFF_BASE_MS = 5 * 60 * 1000;
const WALLET_TOPUP_REFUND_NOTIFY_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export function computeNextRetryAt(completedAttempts: number, from: Date = new Date()): Date {
  const exp = Math.max(0, completedAttempts - 1);
  const delay = Math.min(
    WALLET_TOPUP_REFUND_NOTIFY_BACKOFF_BASE_MS * Math.pow(2, exp),
    WALLET_TOPUP_REFUND_NOTIFY_BACKOFF_MAX_MS,
  );
  return new Date(from.getTime() + delay);
}

export interface WalletTopupRefundNotifyRetryResult {
  channel: "email" | "push" | "sms" | "whatsapp";
  status: NotifyChannelStatus;
  error?: string;
  attempts: number;
  exhausted: boolean;
}

/**
 * Re-attempt a previously failed email delivery for a single
 * wallet-topup-refund notification. Returns `null` when the row is no
 * longer eligible (status not `failed`, cap reached, or backoff window
 * not yet elapsed). Provider-not-configured errors flip the row to
 * terminal `skipped` so the cron stops re-selecting it.
 */
export async function retryWalletTopupRefundEmail(opts: {
  attempt: WalletTopupRefundNotifyAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<WalletTopupRefundNotifyRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.emailStatus !== "failed") return null;
  const currentAttempts = attempt.emailAttempts ?? 0;
  if (currentAttempts >= WALLET_TOPUP_REFUND_NOTIFY_MAX_EMAIL_ATTEMPTS) return null;
  if (attempt.nextEmailRetryAt && attempt.nextEmailRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: NotifyChannelStatus;
  let error: string | undefined;

  // Re-derive recipient at retry time so a member who opted out between
  // the original send and now isn't contacted again.
  let preferEmail = true;
  try {
    const [pref] = await db
      .select({ preferEmail: userNotificationPrefsTable.preferEmail })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, attempt.userId))
      .limit(1);
    preferEmail = pref?.preferEmail ?? true;
  } catch (err) {
    logger.warn(
      { ...logContext, attemptId: attempt.id, errMsg: err instanceof Error ? err.message : String(err) },
      "[wallet-topup-refund-notify] Failed to load preferEmail on retry; defaulting to ON",
    );
  }

  let clubMember:
    | { id: number; email: string | null; firstName: string | null; lastName: string | null }
    | undefined;
  try {
    const [m] = await db
      .select({
        id: clubMembersTable.id,
        email: clubMembersTable.email,
        firstName: clubMembersTable.firstName,
        lastName: clubMembersTable.lastName,
      })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, attempt.organizationId),
        eq(clubMembersTable.userId, attempt.userId),
      ))
      .limit(1);
    clubMember = m;
  } catch {
    // best-effort
  }

  let categoryOptedIn = true;
  if (clubMember) {
    try {
      const [catPref] = await db
        .select({ emailEnabled: memberCommPrefsTable.emailEnabled })
        .from(memberCommPrefsTable)
        .where(and(
          eq(memberCommPrefsTable.clubMemberId, clubMember.id),
          eq(memberCommPrefsTable.category, "billing"),
        ))
        .limit(1);
      categoryOptedIn = catPref ? Boolean(catPref.emailEnabled) : true;
    } catch {
      // best-effort
    }
  }

  if (!preferEmail || !categoryOptedIn) {
    status = "opted_out";
  } else {
    let email = clubMember?.email ?? null;
    let recipientName = clubMember
      ? `${clubMember.firstName ?? ""} ${clubMember.lastName ?? ""}`.trim()
      : "";
    if (!email || !recipientName) {
      try {
        const [u] = await db
          .select({
            email: appUsersTable.email,
            displayName: appUsersTable.displayName,
            username: appUsersTable.username,
          })
          .from(appUsersTable)
          .where(eq(appUsersTable.id, attempt.userId))
          .limit(1);
        if (!email) email = u?.email ?? null;
        if (!recipientName) recipientName = (u?.displayName ?? u?.username ?? "").trim();
      } catch {
        // best-effort
      }
    }

    if (!email) {
      status = "no_address";
    } else {
      // Re-resolve preferred language at retry time so a switch since
      // the original send is honoured.
      let lang = resolveWalletRefundLang(null);
      try {
        const [u] = await db
          .select({ preferredLanguage: appUsersTable.preferredLanguage })
          .from(appUsersTable)
          .where(eq(appUsersTable.id, attempt.userId))
          .limit(1);
        lang = resolveWalletRefundLang(u?.preferredLanguage);
      } catch {
        // best-effort
      }

      let branding: EmailBranding = { orgName: "KHARAGOLF" };
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
        branding = {
          orgName: org?.name ?? "KHARAGOLF",
          logoUrl: org?.logoUrl ?? undefined,
          primaryColor: org?.primaryColor ?? undefined,
        };
      } catch {
        // best-effort
      }

      const currency = (attempt.currency ?? "INR").toUpperCase();
      const currencySymbol = symbolFor(currency);
      const amountNum = Number(attempt.amount);
      const amountStr = formatRefundAmount(
        Number.isFinite(amountNum) ? amountNum : 0,
        currency,
        lang,
        currencySymbol,
      );
      const tx = translateWalletRefund(lang, {
        name: recipientName,
        amount: amountStr,
        orgName: branding.orgName ?? "KHARAGOLF",
        refundId: attempt.refundId ?? null,
      });

      try {
        await sendWalletTopupAutoRefundedEmail({
          to: email,
          recipientName,
          currency,
          amount: amountStr,
          refundId: attempt.refundId ?? null,
          paymentId: attempt.paymentId,
          branding,
          i18n: {
            subject: tx.emailSubject,
            headerLabel: tx.emailHeaderLabel,
            h2: tx.emailH2,
            introHtml: tx.emailIntroHtml,
            labelAmount: tx.emailLabelAmount,
            labelCurrency: tx.emailLabelCurrency,
            labelOriginalPayment: tx.emailLabelOriginalPayment,
            labelRefundReference: tx.emailLabelRefundReference,
            footer: tx.emailFooter,
          },
        });
        status = "sent";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Use the shared mailer classifier so coverage matches the
        // initial-send branch (and catches GMAIL_USER/RESEND_API_KEY/etc).
        if (classifyMailerError(err) === "provider_unconfigured") {
          await db.update(walletTopupRefundNotifyAttemptsTable).set({
            emailStatus: "skipped",
            lastEmailAt: now,
            lastEmailError: "provider_not_configured",
            lastEmailRetryAt: now,
            nextEmailRetryAt: null,
          }).where(eq(walletTopupRefundNotifyAttemptsTable.id, attempt.id));
          return { channel: "email", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
        }
        status = "failed";
        error = msg;
        logger.error(
          { ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: msg },
          "[wallet-topup-refund-notify] Email retry failed",
        );
      }
    }
  }

  const exhausted = status === "failed" && nextAttempts >= WALLET_TOPUP_REFUND_NOTIFY_MAX_EMAIL_ATTEMPTS;
  await db.update(walletTopupRefundNotifyAttemptsTable).set({
    emailStatus: status,
    lastEmailAt: now,
    lastEmailError: error ?? null,
    emailAttempts: nextAttempts,
    lastEmailRetryAt: now,
    nextEmailRetryAt: status === "failed" && !exhausted ? computeNextRetryAt(nextAttempts, now) : null,
    emailRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(walletTopupRefundNotifyAttemptsTable.id, attempt.id));

  return { channel: "email", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Re-attempt a previously failed push delivery for a single
 * wallet-topup-refund notification. Mirrors {@link
 * retryWalletTopupRefundEmail}.
 */
export async function retryWalletTopupRefundPush(opts: {
  attempt: WalletTopupRefundNotifyAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<WalletTopupRefundNotifyRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.pushStatus !== "failed") return null;
  const currentAttempts = attempt.pushAttempts ?? 0;
  if (currentAttempts >= WALLET_TOPUP_REFUND_NOTIFY_MAX_PUSH_ATTEMPTS) return null;
  if (attempt.nextPushRetryAt && attempt.nextPushRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: NotifyChannelStatus;
  let error: string | undefined;

  let preferPush = true;
  try {
    const [pref] = await db
      .select({ preferPush: userNotificationPrefsTable.preferPush })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, attempt.userId))
      .limit(1);
    preferPush = pref?.preferPush ?? true;
  } catch (err) {
    logger.warn(
      { ...logContext, attemptId: attempt.id, errMsg: err instanceof Error ? err.message : String(err) },
      "[wallet-topup-refund-notify] Failed to load preferPush on retry; defaulting to ON",
    );
  }

  if (!preferPush) {
    status = "opted_out";
  } else {
    let lang = resolveWalletRefundLang(null);
    try {
      const [u] = await db
        .select({ preferredLanguage: appUsersTable.preferredLanguage })
        .from(appUsersTable)
        .where(eq(appUsersTable.id, attempt.userId))
        .limit(1);
      lang = resolveWalletRefundLang(u?.preferredLanguage);
    } catch {
      // best-effort
    }
    const currency = (attempt.currency ?? "INR").toUpperCase();
    const currencySymbol = symbolFor(currency);
    const amountNum = Number(attempt.amount);
    const amountStr = formatRefundAmount(
      Number.isFinite(amountNum) ? amountNum : 0,
      currency,
      lang,
      currencySymbol,
    );
    const tx = translateWalletRefund(lang, {
      name: "",
      amount: amountStr,
      orgName: "",
      refundId: attempt.refundId ?? null,
    });
    try {
      const push = await sendPushToUsers([attempt.userId], tx.pushTitle, tx.pushBody, {
        type: "wallet_topup_auto_refund",
        organizationId: attempt.organizationId,
        paymentId: attempt.paymentId,
        refundId: attempt.refundId ?? null,
        amount: amountStr,
        currency,
        lang,
        retry: true,
      });
      status = classifyPushDelivery(push);
      if (status === "failed") {
        error = "push_delivery_failed";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/EXPO.*not configured|PUSH.*not configured|push provider.*not configured|expo access token.*not (set|configured)/i.test(msg)) {
        await db.update(walletTopupRefundNotifyAttemptsTable).set({
          pushStatus: "skipped",
          lastPushAt: now,
          lastPushError: "provider_not_configured",
          lastPushRetryAt: now,
          nextPushRetryAt: null,
        }).where(eq(walletTopupRefundNotifyAttemptsTable.id, attempt.id));
        return { channel: "push", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      logger.error(
        { ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: error },
        "[wallet-topup-refund-notify] Push retry failed",
      );
    }
  }

  const exhausted = status === "failed" && nextAttempts >= WALLET_TOPUP_REFUND_NOTIFY_MAX_PUSH_ATTEMPTS;
  await db.update(walletTopupRefundNotifyAttemptsTable).set({
    pushStatus: status,
    lastPushAt: now,
    lastPushError: error ?? null,
    pushAttempts: nextAttempts,
    lastPushRetryAt: now,
    nextPushRetryAt: status === "failed" && !exhausted ? computeNextRetryAt(nextAttempts, now) : null,
    pushRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(walletTopupRefundNotifyAttemptsTable.id, attempt.id));

  return { channel: "push", status, error, attempts: nextAttempts, exhausted };
}

// ─── Task #1508 — SMS / WhatsApp retry helpers ─────────────────────────
// Mirror the email/push helpers above. Re-derive the recipient phone and
// the per-channel billing opt-in at retry time so a member who toggled
// the opt-in (or whose phone was scrubbed) between the original send
// and the retry isn't pinged again. Provider-not-configured errors
// flip the row to terminal `skipped` so the cron stops re-selecting it.

async function loadBillingPrefAndPhone(
  organizationId: number,
  userId: number,
): Promise<{
  phone: string | null;
  smsEnabled: boolean;
  whatsappEnabled: boolean;
}> {
  let phone: string | null = null;
  let clubMemberId: number | null = null;
  try {
    const [m] = await db
      .select({ id: clubMembersTable.id, phone: clubMembersTable.phone })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, organizationId),
        eq(clubMembersTable.userId, userId),
      ))
      .limit(1);
    if (m) {
      clubMemberId = m.id;
      phone = m.phone ?? null;
    }
  } catch {
    // best-effort
  }

  // Schema defaults: SMS / WhatsApp opt-in are OFF. Without a
  // club_members row we have no place to store the opt-in either, so
  // treat the channel as opted-out — matching the original notify.
  let smsEnabled = false;
  let whatsappEnabled = false;
  if (clubMemberId) {
    try {
      const [pref] = await db
        .select({
          smsEnabled: memberCommPrefsTable.smsEnabled,
          whatsappEnabled: memberCommPrefsTable.whatsappEnabled,
        })
        .from(memberCommPrefsTable)
        .where(and(
          eq(memberCommPrefsTable.clubMemberId, clubMemberId),
          eq(memberCommPrefsTable.category, "billing"),
        ))
        .limit(1);
      if (pref) {
        smsEnabled = Boolean(pref.smsEnabled);
        whatsappEnabled = Boolean(pref.whatsappEnabled);
      }
    } catch {
      // best-effort — fall through with the schema defaults.
    }
  }

  return { phone, smsEnabled, whatsappEnabled };
}

function buildShortBodyForRetry(attempt: WalletTopupRefundNotifyAttempt, lang: ReturnType<typeof resolveWalletRefundLang>): string {
  const currency = (attempt.currency ?? "INR").toUpperCase();
  const currencySymbol = symbolFor(currency);
  const amountNum = Number(attempt.amount);
  const amountStr = formatRefundAmount(
    Number.isFinite(amountNum) ? amountNum : 0,
    currency,
    lang,
    currencySymbol,
  );
  const tx = translateWalletRefund(lang, {
    name: "",
    amount: amountStr,
    orgName: "",
    refundId: attempt.refundId ?? null,
  });
  return `${tx.pushTitle}\n${tx.inAppBody}`;
}

/**
 * Re-attempt a previously failed SMS delivery for a single
 * wallet-topup-refund notification. Returns `null` when the row is no
 * longer eligible (status not `failed`, cap reached, or backoff window
 * not yet elapsed). Provider-not-configured errors flip the row to
 * terminal `skipped` so the cron stops re-selecting it.
 */
export async function retryWalletTopupRefundSms(opts: {
  attempt: WalletTopupRefundNotifyAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<WalletTopupRefundNotifyRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.smsStatus !== "failed") return null;
  const currentAttempts = attempt.smsAttempts ?? 0;
  if (currentAttempts >= WALLET_TOPUP_REFUND_NOTIFY_MAX_SMS_ATTEMPTS) return null;
  if (attempt.nextSmsRetryAt && attempt.nextSmsRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: NotifyChannelStatus;
  let error: string | undefined;

  const { phone, smsEnabled } = await loadBillingPrefAndPhone(attempt.organizationId, attempt.userId);

  if (!smsEnabled) {
    status = "opted_out";
  } else if (!phone) {
    status = "no_address";
  } else {
    let lang = resolveWalletRefundLang(null);
    try {
      const [u] = await db
        .select({ preferredLanguage: appUsersTable.preferredLanguage })
        .from(appUsersTable)
        .where(eq(appUsersTable.id, attempt.userId))
        .limit(1);
      lang = resolveWalletRefundLang(u?.preferredLanguage);
    } catch {
      // best-effort
    }
    const body = buildShortBodyForRetry(attempt, lang);
    try {
      await sendTransactionalSms(phone, body.slice(0, 320));
      status = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/SMS_PROVIDER not configured/i.test(msg)) {
        await db.update(walletTopupRefundNotifyAttemptsTable).set({
          smsStatus: "skipped",
          lastSmsAt: now,
          lastSmsError: "provider_not_configured",
          lastSmsRetryAt: now,
          nextSmsRetryAt: null,
        }).where(eq(walletTopupRefundNotifyAttemptsTable.id, attempt.id));
        return { channel: "sms", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      logger.error(
        { ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: msg },
        "[wallet-topup-refund-notify] SMS retry failed",
      );
    }
  }

  const exhausted = status === "failed" && nextAttempts >= WALLET_TOPUP_REFUND_NOTIFY_MAX_SMS_ATTEMPTS;
  await db.update(walletTopupRefundNotifyAttemptsTable).set({
    smsStatus: status,
    lastSmsAt: now,
    lastSmsError: error ?? null,
    smsAttempts: nextAttempts,
    lastSmsRetryAt: now,
    nextSmsRetryAt: status === "failed" && !exhausted ? computeNextRetryAt(nextAttempts, now) : null,
    smsRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(walletTopupRefundNotifyAttemptsTable.id, attempt.id));

  return { channel: "sms", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Re-attempt a previously failed WhatsApp delivery for a single
 * wallet-topup-refund notification. Mirrors {@link retryWalletTopupRefundSms}.
 */
export async function retryWalletTopupRefundWhatsapp(opts: {
  attempt: WalletTopupRefundNotifyAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<WalletTopupRefundNotifyRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.whatsappStatus !== "failed") return null;
  const currentAttempts = attempt.whatsappAttempts ?? 0;
  if (currentAttempts >= WALLET_TOPUP_REFUND_NOTIFY_MAX_WHATSAPP_ATTEMPTS) return null;
  if (attempt.nextWhatsappRetryAt && attempt.nextWhatsappRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: NotifyChannelStatus;
  let error: string | undefined;

  const { phone, whatsappEnabled } = await loadBillingPrefAndPhone(attempt.organizationId, attempt.userId);

  if (!whatsappEnabled) {
    status = "opted_out";
  } else if (!phone) {
    status = "no_address";
  } else {
    let lang = resolveWalletRefundLang(null);
    try {
      const [u] = await db
        .select({ preferredLanguage: appUsersTable.preferredLanguage })
        .from(appUsersTable)
        .where(eq(appUsersTable.id, attempt.userId))
        .limit(1);
      lang = resolveWalletRefundLang(u?.preferredLanguage);
    } catch {
      // best-effort
    }
    const body = buildShortBodyForRetry(attempt, lang);
    try {
      await sendTransactionalWhatsapp(phone, body.slice(0, 1024));
      status = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/WHATSAPP_PROVIDER not configured|WHATSAPP_PROVIDER_API_KEY|WhatsApp.*not configured/i.test(msg)) {
        await db.update(walletTopupRefundNotifyAttemptsTable).set({
          whatsappStatus: "skipped",
          lastWhatsappAt: now,
          lastWhatsappError: "provider_not_configured",
          lastWhatsappRetryAt: now,
          nextWhatsappRetryAt: null,
        }).where(eq(walletTopupRefundNotifyAttemptsTable.id, attempt.id));
        return { channel: "whatsapp", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      logger.error(
        { ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: msg },
        "[wallet-topup-refund-notify] WhatsApp retry failed",
      );
    }
  }

  const exhausted = status === "failed" && nextAttempts >= WALLET_TOPUP_REFUND_NOTIFY_MAX_WHATSAPP_ATTEMPTS;
  await db.update(walletTopupRefundNotifyAttemptsTable).set({
    whatsappStatus: status,
    lastWhatsappAt: now,
    lastWhatsappError: error ?? null,
    whatsappAttempts: nextAttempts,
    lastWhatsappRetryAt: now,
    nextWhatsappRetryAt: status === "failed" && !exhausted ? computeNextRetryAt(nextAttempts, now) : null,
    whatsappRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(walletTopupRefundNotifyAttemptsTable.id, attempt.id));

  return { channel: "whatsapp", status, error, attempts: nextAttempts, exhausted };
}
