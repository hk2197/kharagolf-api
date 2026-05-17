/**
 * Wallet withdrawal lifecycle notifications (Task #964).
 *
 * Closes the loop on the wallet withdrawal flow: today the payout
 * webhook reconciles `processed`/`failed`/`reversed` (and auto-refunds
 * the wallet on failure), but the member only finds out by re-opening
 * the wallet. This helper fires push + email + in-app inbox messages
 * when the withdrawal first transitions to a terminal state, mirroring
 * how wallet top-ups are confirmed today.
 *
 * Exposes:
 *   - `notifyWithdrawalProcessed`: fires on first transition to
 *     `processed` (with UTR + amount + destination).
 *   - `notifyWithdrawalFailed`:    fires on first transition to
 *     `failed`/`reversed` (with refund confirmation).
 *
 * Idempotency:
 *   - The state-machine guards in `markWithdrawalProcessed` /
 *     `markWithdrawalFailed` make those calls a no-op once the row is
 *     already in the same terminal state, and they now return whether
 *     the row actually transitioned. Callers only invoke the notify on
 *     a true transition, so a replayed webhook never double-notifies.
 *
 * Honours the recipient's existing channel preferences:
 *   - push respects `userNotificationPrefsTable.preferPush` (default true)
 *   - email respects `userNotificationPrefsTable.preferEmail` (default true)
 *     AND, when the recipient has a club_members row in the wallet's org,
 *     `memberCommPrefsTable.emailEnabled` for the `billing` category
 *     (default true).
 *   - SMS (Task #1107) respects `userNotificationPrefsTable.preferSms`
 *     (default false) AND `memberCommPrefsTable.smsEnabled` for the
 *     `billing` category (default false). The phone number is read from
 *     `clubMembersTable.phone`; without a club_members row in the org
 *     we have no phone and the channel is `no_address`. Skipped silently
 *     when SMS_PROVIDER is not configured.
 *   - WhatsApp (Task #1487) respects `memberCommPrefsTable.whatsappEnabled`
 *     for the `billing` category (default false). Reuses the same phone
 *     number as SMS and the same translated `translateWithdrawalSms`
 *     copy so members on the `billing` WhatsApp opt-in get a parity
 *     channel with the wallet auto-refund notice. Skipped silently when
 *     WHATSAPP_PROVIDER is not configured.
 *
 * Fire-and-forget: every channel is best-effort and isolated. Failures
 * are logged but never thrown — the underlying payout has already
 * settled at the bank.
 */
import { db } from "@workspace/db";
import {
  appUsersTable,
  clubMembersTable,
  clubWalletWithdrawalsTable,
  memberCommPrefsTable,
  memberMessagesTable,
  organizationsTable,
  orgMembershipsTable,
  userNotificationPrefsTable,
  walletPayoutAccountsTable,
  walletWithdrawalNotifyAttemptsTable,
  type WalletWithdrawalNotifyAttempt,
} from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { sendPushToUsers, classifyPushDelivery } from "./push";
import { sendTransactionalPush, sendTransactionalSms, sendTransactionalWhatsapp } from "./comms";
import {
  classifyMailerError,
  sendWalletWithdrawalFailedEmail,
  sendWalletWithdrawalProcessedEmail,
  type EmailBranding,
} from "./mailer";
import { logger } from "./logger";
import {
  resolveWalletRefundLang,
  type WalletRefundLang,
} from "./walletRefundI18n";
import { translateWithdrawalSms } from "./walletWithdrawalI18n";

const CURRENCY_SYMBOLS: Record<string, string> = { INR: "₹", USD: "$", GBP: "£", EUR: "€" };

function symbolFor(currency: string | null | undefined): string {
  const c = (currency ?? "INR").toUpperCase();
  return CURRENCY_SYMBOLS[c] ?? `${c} `;
}

function fmtAmount(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function maskTail(s: string | null | undefined, keep = 4): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (trimmed.length <= keep) return `••${trimmed}`;
  return `••••${trimmed.slice(-keep)}`;
}

/**
 * Build a member-friendly description of where the payout went, e.g.
 * "UPI alice@upi" or "bank account ••••1234". Falls back to a generic
 * label when we couldn't load the saved payout account row.
 */
function describeDestination(args: {
  method: string | null | undefined;
  upiVpa?: string | null;
  bankAccountNumber?: string | null;
}): string {
  const method = (args.method ?? "").toLowerCase();
  if (method === "upi") {
    return args.upiVpa ? `UPI ${args.upiVpa}` : "your saved UPI handle";
  }
  if (method === "bank_account") {
    const tail = maskTail(args.bankAccountNumber);
    return tail ? `bank account ${tail}` : "your saved bank account";
  }
  return "your saved payout account";
}

export type NotifyChannelStatus = "sent" | "failed" | "skipped" | "opted_out" | "no_address";

export interface WalletWithdrawalNotifyResult {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  inApp: { status: NotifyChannelStatus; messageId?: number; error?: string };
  push: { status: NotifyChannelStatus; error?: string };
  email: { status: NotifyChannelStatus; error?: string };
  sms: { status: NotifyChannelStatus; error?: string };
  whatsapp: { status: NotifyChannelStatus; error?: string };
}

type Outcome = "processed" | "failed" | "reversed";

interface InternalNotifyArgs {
  withdrawalId: number;
  outcome: Outcome;
  /** Razorpay UTR — only populated for `processed`. */
  utr?: string | null;
  /** Failure reason from Razorpay — only populated for failed/reversed. */
  reason?: string | null;
}

async function loadContext(withdrawalId: number) {
  const [w] = await db
    .select()
    .from(clubWalletWithdrawalsTable)
    .where(eq(clubWalletWithdrawalsTable.id, withdrawalId))
    .limit(1);
  if (!w) return null;

  let payoutAcct: typeof walletPayoutAccountsTable.$inferSelect | undefined;
  if (w.payoutAccountId != null) {
    const [a] = await db
      .select()
      .from(walletPayoutAccountsTable)
      .where(eq(walletPayoutAccountsTable.id, w.payoutAccountId))
      .limit(1);
    payoutAcct = a;
  }
  return { w, payoutAcct };
}

async function notifyWithdrawal(args: InternalNotifyArgs): Promise<WalletWithdrawalNotifyResult> {
  const result: WalletWithdrawalNotifyResult = {
    status: "skipped",
    inApp: { status: "skipped" },
    push: { status: "skipped" },
    email: { status: "skipped" },
    sms: { status: "skipped" },
    whatsapp: { status: "skipped" },
  };

  const ctx = await loadContext(args.withdrawalId).catch((err) => {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { withdrawalId: args.withdrawalId, errMsg: reason },
      "[wallet-withdrawal-notify] failed to load withdrawal context",
    );
    return null;
  });
  if (!ctx) {
    result.status = "failed";
    result.reason = "withdrawal_not_found";
    return result;
  }
  const { w, payoutAcct } = ctx;

  const currency = (w.currency ?? "INR").toUpperCase();
  const currencySymbol = symbolFor(currency);
  const amountNum = Number(w.amount);
  const amountStr = Number.isFinite(amountNum) ? fmtAmount(amountNum) : String(w.amount);

  const destination = describeDestination({
    method: w.method ?? payoutAcct?.method ?? null,
    upiVpa: payoutAcct?.upiVpa,
    bankAccountNumber: payoutAcct?.bankAccountNumber,
  });

  // ── Claim the (withdrawal × outcome) slot up front (Task #1279) ─────
  // Insert a "pending" attempts row before we send anything. The unique
  // index (withdrawal_id × outcome) means a concurrent or replayed
  // notify call (e.g. duplicate webhook) loses the race here and
  // returns immediately — guaranteeing the member never sees the same
  // wallet-withdrawal email/push/SMS twice for the same outcome.
  // Subsequent UPDATE-by-id fills in the per-channel results.
  let attemptId: number;
  {
    const claim = await db.insert(walletWithdrawalNotifyAttemptsTable).values({
      withdrawalId: w.id,
      organizationId: w.organizationId,
      userId: w.userId,
      outcome: args.outcome,
      amount: amountStr,
      currency,
      destination,
      utr: args.outcome === "processed" ? args.utr ?? null : null,
      reason: args.outcome !== "processed" ? args.reason ?? null : null,
      emailStatus: null,
      emailAttempts: 0,
      pushStatus: null,
      pushAttempts: 0,
    }).onConflictDoNothing({
      target: [
        walletWithdrawalNotifyAttemptsTable.withdrawalId,
        walletWithdrawalNotifyAttemptsTable.outcome,
      ],
    }).returning({ id: walletWithdrawalNotifyAttemptsTable.id });
    if (claim.length === 0) {
      logger.info(
        { withdrawalId: w.id, outcome: args.outcome },
        "[wallet-withdrawal-notify] Skipping duplicate notify — attempts row already exists",
      );
      result.status = "skipped";
      result.reason = "already_notified";
      return result;
    }
    attemptId = claim[0].id;
  }

  let title: string;
  let body: string;
  let pushType: string;
  let relatedEntity: string;
  if (args.outcome === "processed") {
    title = `Withdrawal paid: ${currencySymbol}${amountStr}`;
    const utrNote = args.utr ? ` UTR ${args.utr}.` : "";
    body =
      `Your withdrawal of ${currencySymbol}${amountStr} ${currency} from your wallet has been paid to ${destination}.${utrNote}`;
    pushType = "wallet_withdrawal_processed";
    relatedEntity = "wallet_withdrawal";
  } else {
    const verb = args.outcome === "reversed" ? "was reversed" : "could not be processed";
    title = `Withdrawal ${args.outcome === "reversed" ? "reversed" : "failed"}: ${currencySymbol}${amountStr} refunded`;
    const reasonNote = args.reason ? ` Reason: ${args.reason}.` : "";
    body =
      `Your ${currencySymbol}${amountStr} ${currency} withdrawal to ${destination} ${verb}.${reasonNote} ` +
      `The full amount has been refunded to your wallet — you can try again or use a different account.`;
    pushType = "wallet_withdrawal_failed";
    relatedEntity = "wallet_withdrawal";
  }

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
        eq(clubMembersTable.organizationId, w.organizationId),
        eq(clubMembersTable.userId, w.userId),
      ))
      .limit(1);
    clubMember = m;
    if (!clubMember) {
      result.inApp.status = "skipped";
    } else {
      const [msg] = await db.insert(memberMessagesTable).values({
        organizationId: w.organizationId,
        clubMemberId: clubMember.id,
        channel: "in_app",
        subject: title,
        body,
        status: "sent",
        relatedEntity,
        relatedEntityId: w.id,
      }).returning({ id: memberMessagesTable.id });
      result.inApp.status = "sent";
      result.inApp.messageId = msg?.id;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    result.inApp.status = "failed";
    result.inApp.error = reason;
    logger.warn(
      { withdrawalId: w.id, errMsg: reason },
      "[wallet-withdrawal-notify] in-app insert failed",
    );
  }

  // ── Email ───────────────────────────────────────────────────────────
  // Track the classified provider error so the persist block (and the
  // org-admin alert) can short-circuit straight to "exhausted" on a
  // hard SMTP bounce, instead of consuming all 5 retries and flooding
  // the inbox with retries that can never succeed (Task #1279).
  let emailErrorClass: ReturnType<typeof classifyMailerError> | null = null;
  try {
    const [pref] = await db
      .select({ preferEmail: userNotificationPrefsTable.preferEmail })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, w.userId))
      .limit(1);
    const preferEmail = pref?.preferEmail ?? true;
    if (!preferEmail) {
      result.email.status = "opted_out";
    } else {
      let categoryOptedIn = true;
      if (clubMember) {
        const [catPref] = await db
          .select({ emailEnabled: memberCommPrefsTable.emailEnabled })
          .from(memberCommPrefsTable)
          .where(and(
            eq(memberCommPrefsTable.clubMemberId, clubMember.id),
            eq(memberCommPrefsTable.category, "billing"),
          ))
          .limit(1);
        categoryOptedIn = catPref ? Boolean(catPref.emailEnabled) : true;
      }

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
            .where(eq(appUsersTable.id, w.userId))
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
              .where(eq(organizationsTable.id, w.organizationId))
              .limit(1);
            branding = {
              orgName: org?.name ?? "KHARAGOLF",
              logoUrl: org?.logoUrl ?? undefined,
              primaryColor: org?.primaryColor ?? undefined,
            };
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.warn(
              { withdrawalId: w.id, errMsg: reason },
              "[wallet-withdrawal-notify] failed to load org branding for email",
            );
          }

          if (args.outcome === "processed") {
            await sendWalletWithdrawalProcessedEmail({
              to: email,
              recipientName,
              currency,
              currencySymbol,
              amount: amountStr,
              utr: args.utr ?? null,
              destination,
              withdrawalId: w.id,
              branding,
            });
          } else {
            await sendWalletWithdrawalFailedEmail({
              to: email,
              recipientName,
              currency,
              currencySymbol,
              amount: amountStr,
              destination,
              withdrawalId: w.id,
              reason: args.reason ?? "The bank rejected the payout.",
              reversed: args.outcome === "reversed",
              branding,
            });
          }
          result.email.status = "sent";
        }
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    emailErrorClass = classifyMailerError(err);
    // Provider-not-configured is treated as `skipped` (terminal) so the
    // cron never re-selects this row; a hard bounce is `failed` but
    // gets short-circuited to exhausted in the persist block below
    // (the underlying address can never accept the message, so retrying
    // would just flood our internal logs with re-bounces).
    if (emailErrorClass === "provider_unconfigured") {
      result.email.status = "skipped";
      result.email.error = "provider_not_configured";
    } else {
      result.email.status = "failed";
      result.email.error = reason;
    }
    logger.warn(
      { withdrawalId: w.id, errMsg: reason, errClass: emailErrorClass },
      "[wallet-withdrawal-notify] email delivery failed",
    );
  }

  // ── Push ────────────────────────────────────────────────────────────
  try {
    const [pref] = await db
      .select({ preferPush: userNotificationPrefsTable.preferPush })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, w.userId))
      .limit(1);
    const preferPush = pref?.preferPush ?? true;
    if (!preferPush) {
      result.push.status = "opted_out";
    } else {
      const push = await sendPushToUsers([w.userId], title, body, {
        type: pushType,
        organizationId: w.organizationId,
        withdrawalId: w.id,
        amount: amountStr,
        currency,
        ...(args.outcome === "processed" ? { utr: args.utr ?? null } : {}),
        ...(args.outcome !== "processed" ? { reason: args.reason ?? null } : {}),
      });
      // Task #1070 — share the classifier with the other notify helpers
      // so the sent / failed / no_address mapping stays consistent.
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
      { withdrawalId: w.id, errMsg: reason },
      "[wallet-withdrawal-notify] push delivery failed",
    );
  }

  // ── SMS (Task #1107) ────────────────────────────────────────────────
  // Short text mirroring the push body, with the UTR appended for the
  // processed case. Gated on user-level preferSms (default false) and
  // the `billing` smsEnabled opt-in (default false). Skipped silently
  // when SMS_PROVIDER is not configured.
  //
  // Task #1269 — body is rendered in the recipient's preferredLanguage
  // (with English fallback) to match the localised push/email copy.
  if (!clubMember || !clubMember.phone) {
    result.sms.status = "no_address";
  } else {
    try {
      const [pref] = await db
        .select({ preferSms: userNotificationPrefsTable.preferSms })
        .from(userNotificationPrefsTable)
        .where(eq(userNotificationPrefsTable.userId, w.userId))
        .limit(1);
      const preferSms = pref?.preferSms ?? false;
      if (!preferSms) {
        result.sms.status = "opted_out";
      } else {
        const [catPref] = await db
          .select({ smsEnabled: memberCommPrefsTable.smsEnabled })
          .from(memberCommPrefsTable)
          .where(and(
            eq(memberCommPrefsTable.clubMemberId, clubMember.id),
            eq(memberCommPrefsTable.category, "billing"),
          ))
          .limit(1);
        const categoryOptedIn = catPref ? Boolean(catPref.smsEnabled) : false;
        if (!categoryOptedIn) {
          result.sms.status = "opted_out";
        } else {
          let lang: WalletRefundLang = "en";
          try {
            const [u] = await db
              .select({ preferredLanguage: appUsersTable.preferredLanguage })
              .from(appUsersTable)
              .where(eq(appUsersTable.id, w.userId))
              .limit(1);
            lang = resolveWalletRefundLang(u?.preferredLanguage);
          } catch (langErr) {
            const reason = langErr instanceof Error ? langErr.message : String(langErr);
            logger.warn(
              { withdrawalId: w.id, errMsg: reason },
              "[wallet-withdrawal-notify] preferred-language lookup failed; defaulting to English",
            );
          }
          const tx = translateWithdrawalSms(lang, args.outcome, {
            amount: `${currencySymbol}${amountStr}`,
            currency,
            destination,
            utr: args.outcome === "processed" ? args.utr ?? null : null,
            reason: args.outcome !== "processed" ? args.reason ?? null : null,
          });
          const smsBody = `${tx.title}\n${tx.body}`;
          await sendTransactionalSms(clubMember.phone, smsBody.slice(0, 320));
          result.sms.status = "sent";
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (/SMS_PROVIDER not configured/i.test(reason)) {
        result.sms.status = "skipped";
        result.sms.error = "provider_not_configured";
      } else {
        result.sms.status = "failed";
        result.sms.error = reason;
        logger.warn(
          { withdrawalId: w.id, errMsg: reason },
          "[wallet-withdrawal-notify] SMS delivery failed",
        );
      }
    }
  }

  // ── WhatsApp (Task #1487) ──────────────────────────────────────────
  // Mirror of the SMS channel for members on the `billing` WhatsApp
  // opt-in. Reuses the same `translateWithdrawalSms` output so the
  // existing 21 SMS translations (Task #1269) are shared verbatim.
  // Gated on `memberCommPrefsTable.whatsappEnabled` for the `billing`
  // category (default false) — there is no separate user-level toggle,
  // matching the wallet auto-refund WhatsApp behaviour. Skipped
  // silently when WHATSAPP_PROVIDER is not configured so deployments
  // without WhatsApp credentials don't surface false failures.
  if (!clubMember || !clubMember.phone) {
    result.whatsapp.status = "no_address";
  } else {
    try {
      const [catPref] = await db
        .select({ whatsappEnabled: memberCommPrefsTable.whatsappEnabled })
        .from(memberCommPrefsTable)
        .where(and(
          eq(memberCommPrefsTable.clubMemberId, clubMember.id),
          eq(memberCommPrefsTable.category, "billing"),
        ))
        .limit(1);
      const categoryOptedIn = catPref ? Boolean(catPref.whatsappEnabled) : false;
      if (!categoryOptedIn) {
        result.whatsapp.status = "opted_out";
      } else {
        let lang: WalletRefundLang = "en";
        try {
          const [u] = await db
            .select({ preferredLanguage: appUsersTable.preferredLanguage })
            .from(appUsersTable)
            .where(eq(appUsersTable.id, w.userId))
            .limit(1);
          lang = resolveWalletRefundLang(u?.preferredLanguage);
        } catch (langErr) {
          const reason = langErr instanceof Error ? langErr.message : String(langErr);
          logger.warn(
            { withdrawalId: w.id, errMsg: reason },
            "[wallet-withdrawal-notify] preferred-language lookup failed for WhatsApp; defaulting to English",
          );
        }
        const tx = translateWithdrawalSms(
          lang,
          args.outcome,
          {
            amount: `${currencySymbol}${amountStr}`,
            currency,
            destination,
            utr: args.outcome === "processed" ? args.utr ?? null : null,
            reason: args.outcome !== "processed" ? args.reason ?? null : null,
          },
          // Task #1826 — opt into the WhatsApp-tuned variants so the
          // failed/reversed body uses paragraph breaks instead of the
          // SMS inline em-dash continuation. The SMS channel above
          // continues to use the default (untouched) SMS strings.
          "whatsapp",
        );
        const waBody = `${tx.title}\n${tx.body}`;
        await sendTransactionalWhatsapp(clubMember.phone, waBody.slice(0, 1024));
        result.whatsapp.status = "sent";
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (/WHATSAPP_PROVIDER not configured|WHATSAPP_PROVIDER_API_KEY|WhatsApp.*not configured/i.test(reason)) {
        result.whatsapp.status = "skipped";
        result.whatsapp.error = "provider_not_configured";
      } else {
        result.whatsapp.status = "failed";
        result.whatsapp.error = reason;
        logger.warn(
          { withdrawalId: w.id, errMsg: reason },
          "[wallet-withdrawal-notify] WhatsApp delivery failed",
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

  // ── Update the claimed attempts row with per-channel results ────────
  // The row was already inserted at the top of this function (the
  // claim-then-update pattern guarantees deliverable #3 — a duplicate
  // notify call cannot double-send the email). Here we just fill in
  // the per-channel state, applying the Task #1279 hard-bounce
  // short-circuit: an SMTP 5xx response on the first attempt sets
  // `emailAttempts = MAX`, clears `nextEmailRetryAt`, and stamps
  // `emailRetryExhaustedAt = now`, so the cron immediately stops
  // retrying and the org admin gets a single internal alert below.
  let emailExhaustedNow = false;
  try {
    const now = new Date();
    const emailAttempted = result.email.status === "sent" || result.email.status === "failed";
    const pushAttempted = result.push.status === "sent" || result.push.status === "failed";
    emailExhaustedNow = result.email.status === "failed" && emailErrorClass === "hard_bounce";
    const emailAttemptsCount = emailAttempted
      ? (emailExhaustedNow ? WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS : 1)
      : 0;
    const nextEmail = result.email.status === "failed" && !emailExhaustedNow ? computeNextRetryAt(1, now) : null;
    const nextPush = result.push.status === "failed" ? computeNextRetryAt(1, now) : null;
    // Task #1825 — also persist the SMS / WhatsApp result so admins
    // debugging "did the member get pinged?" have the same audit
    // trail for those channels as for email/push. We stamp `lastAt`
    // for any attempted send (sent or failed); skipped /
    // opted_out / no_address rows leave `lastAt` null because we
    // never actually contacted the provider.
    const smsAttempted = result.sms.status === "sent" || result.sms.status === "failed";
    const waAttempted = result.whatsapp.status === "sent" || result.whatsapp.status === "failed";
    await db.update(walletWithdrawalNotifyAttemptsTable).set({
      emailStatus: result.email.status,
      emailAttempts: emailAttemptsCount,
      lastEmailAt: emailAttempted ? now : null,
      lastEmailError: result.email.error ?? null,
      nextEmailRetryAt: nextEmail,
      emailRetryExhaustedAt: emailExhaustedNow ? now : null,
      pushStatus: result.push.status,
      pushAttempts: pushAttempted ? 1 : 0,
      lastPushAt: pushAttempted ? now : null,
      lastPushError: result.push.error ?? null,
      nextPushRetryAt: nextPush,
      smsStatus: result.sms.status,
      smsError: result.sms.error ?? null,
      lastSmsAt: smsAttempted ? now : null,
      whatsappStatus: result.whatsapp.status,
      whatsappError: result.whatsapp.error ?? null,
      lastWhatsappAt: waAttempted ? now : null,
    }).where(eq(walletWithdrawalNotifyAttemptsTable.id, attemptId));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { withdrawalId: w.id, outcome: args.outcome, errMsg: reason },
      "[wallet-withdrawal-notify] Failed to update retry-attempts row",
    );
  }

  // ── Admin alert on first-attempt hard-bounce exhaustion ────────────
  // If the SMTP server bounced this address permanently we already
  // know retries will never succeed, so page the org admin once
  // (the helper itself dedups via `adminExhaustionNotifiedAt`).
  if (emailExhaustedNow) {
    try {
      const [stamped] = await db.select()
        .from(walletWithdrawalNotifyAttemptsTable)
        .where(eq(walletWithdrawalNotifyAttemptsTable.id, attemptId))
        .limit(1);
      if (stamped) {
        await notifyAdminsOfWalletWithdrawalRetryExhaustion({
          attempt: stamped,
          channel: "email",
          reason: "hard_bounce",
          logContext: { source: "notifyWithdrawal" },
        });
      }
    } catch (err) {
      logger.warn(
        { withdrawalId: w.id, outcome: args.outcome, errMsg: err instanceof Error ? err.message : String(err) },
        "[wallet-withdrawal-notify] Admin hard-bounce alert dispatch failed",
      );
    }
  }

  return result;
}

/** Notify a member that their withdrawal has been paid out (status `processed`). */
export async function notifyWithdrawalProcessed(args: {
  withdrawalId: number;
  utr?: string | null;
}): Promise<WalletWithdrawalNotifyResult> {
  return notifyWithdrawal({
    withdrawalId: args.withdrawalId,
    outcome: "processed",
    utr: args.utr ?? null,
  });
}

/** Notify a member that their withdrawal failed/reversed and was refunded. */
export async function notifyWithdrawalFailed(args: {
  withdrawalId: number;
  status: "failed" | "reversed";
  reason?: string | null;
}): Promise<WalletWithdrawalNotifyResult> {
  return notifyWithdrawal({
    withdrawalId: args.withdrawalId,
    outcome: args.status,
    reason: args.reason ?? null,
  });
}

// ─── Retry helpers (Task #1108) ────────────────────────────────────────────
// Bounded retry cap per channel for a single withdrawal-paid/failed notice
// (initial attempt + retries). Once a channel reaches this cap the cron
// stops re-attempting it and stamps `*RetryExhaustedAt` on the attempts
// row. Mirrors `SIDE_GAME_RECEIPT_MAX_*_ATTEMPTS` (Task #961).
export const WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS = 5;
export const WALLET_WITHDRAWAL_NOTIFY_MAX_PUSH_ATTEMPTS = 5;

// Exponential-backoff schedule: 5, 10, 20, 40, 80 minutes between attempts
// (i.e. attempt N waits 5 * 2^(N-1) minutes after attempt N-1). Capped so
// a freak attempts value never produces a runaway delay.
const WALLET_WITHDRAWAL_NOTIFY_BACKOFF_BASE_MS = 5 * 60 * 1000;
const WALLET_WITHDRAWAL_NOTIFY_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export function computeNextRetryAt(completedAttempts: number, from: Date = new Date()): Date {
  const exp = Math.max(0, completedAttempts - 1);
  const delay = Math.min(
    WALLET_WITHDRAWAL_NOTIFY_BACKOFF_BASE_MS * Math.pow(2, exp),
    WALLET_WITHDRAWAL_NOTIFY_BACKOFF_MAX_MS,
  );
  return new Date(from.getTime() + delay);
}

export interface WalletWithdrawalNotifyRetryResult {
  channel: "email" | "push";
  status: NotifyChannelStatus;
  error?: string;
  attempts: number;
  exhausted: boolean;
}

/**
 * Build the title/body used by the retry helpers from the persisted
 * snapshot. Mirrors the first-attempt strings produced inside
 * `notifyWithdrawal` so retries land identically in push payloads.
 */
function buildShortBodyForAttempt(a: WalletWithdrawalNotifyAttempt): { title: string; body: string; pushType: string } {
  const currency = (a.currency ?? "INR").toUpperCase();
  const currencySymbol = symbolFor(currency);
  const amountStr = String(a.amount);
  if (a.outcome === "processed") {
    const utrNote = a.utr ? ` UTR ${a.utr}.` : "";
    return {
      title: `Withdrawal paid: ${currencySymbol}${amountStr}`,
      body: `Your withdrawal of ${currencySymbol}${amountStr} ${currency} from your wallet has been paid to ${a.destination}.${utrNote}`,
      pushType: "wallet_withdrawal_processed",
    };
  }
  const verb = a.outcome === "reversed" ? "was reversed" : "could not be processed";
  const reasonNote = a.reason ? ` Reason: ${a.reason}.` : "";
  return {
    title: `Withdrawal ${a.outcome === "reversed" ? "reversed" : "failed"}: ${currencySymbol}${amountStr} refunded`,
    body:
      `Your ${currencySymbol}${amountStr} ${currency} withdrawal to ${a.destination} ${verb}.${reasonNote} ` +
      `The full amount has been refunded to your wallet — you can try again or use a different account.`,
    pushType: "wallet_withdrawal_failed",
  };
}

/**
 * Re-attempt a previously failed email delivery for a single wallet
 * withdrawal notification. Returns `null` when the row is no longer
 * eligible (status not `failed`, cap reached, or backoff window not yet
 * elapsed). Provider-not-configured errors flip the row to terminal
 * `skipped` so the cron stops re-selecting it.
 */
export async function retryWalletWithdrawalEmail(opts: {
  attempt: WalletWithdrawalNotifyAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<WalletWithdrawalNotifyRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.emailStatus !== "failed") return null;
  const currentAttempts = attempt.emailAttempts ?? 0;
  if (currentAttempts >= WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS) return null;
  if (attempt.nextEmailRetryAt && attempt.nextEmailRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: NotifyChannelStatus;
  let error: string | undefined;
  // Task #1279 — when set, the SMTP server returned a permanent bounce
  // (5xx / InactiveRecipient / mailbox-not-found / etc). The persist
  // block below jumps straight to exhausted so the cron stops retrying.
  let hardBounce = false;

  // Re-derive recipient at retry time: prefer the club_members row in the
  // wallet's org (matches first-attempt behaviour), fall back to the app
  // user. Member-comm `billing` opt-out and user-level `preferEmail`
  // opt-out are honoured so a member who opted out between attempts is
  // never contacted again.
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
      "[wallet-withdrawal-notify] Failed to load preferEmail on retry; defaulting to ON",
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
      // Branding lookup is best-effort.
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
      try {
        if (attempt.outcome === "processed") {
          await sendWalletWithdrawalProcessedEmail({
            to: email,
            recipientName,
            currency,
            currencySymbol,
            amount: String(attempt.amount),
            utr: attempt.utr ?? null,
            destination: attempt.destination,
            withdrawalId: attempt.withdrawalId,
            branding,
          });
        } else {
          await sendWalletWithdrawalFailedEmail({
            to: email,
            recipientName,
            currency,
            currencySymbol,
            amount: String(attempt.amount),
            destination: attempt.destination,
            withdrawalId: attempt.withdrawalId,
            reason: attempt.reason ?? "The bank rejected the payout.",
            reversed: attempt.outcome === "reversed",
            branding,
          });
        }
        status = "sent";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errClass = classifyMailerError(err);
        if (errClass === "provider_unconfigured") {
          await db.update(walletWithdrawalNotifyAttemptsTable).set({
            emailStatus: "skipped",
            lastEmailAt: now,
            lastEmailError: "provider_not_configured",
            lastEmailRetryAt: now,
            nextEmailRetryAt: null,
          }).where(eq(walletWithdrawalNotifyAttemptsTable.id, attempt.id));
          return { channel: "email", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
        }
        status = "failed";
        error = msg;
        // Task #1279 — a hard SMTP bounce on a retry must not consume
        // the rest of the budget: jump straight to exhausted so the
        // cron stops re-firing this row and the admin is paged once.
        if (errClass === "hard_bounce") {
          hardBounce = true;
        }
        logger.error({ ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: msg, errClass }, "[wallet-withdrawal-notify] Email retry failed");
      }
    }
  }

  const exhausted = status === "failed" && (hardBounce || nextAttempts >= WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS);
  const persistedAttempts = exhausted && hardBounce
    ? WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS
    : nextAttempts;
  await db.update(walletWithdrawalNotifyAttemptsTable).set({
    emailStatus: status,
    lastEmailAt: now,
    lastEmailError: error ?? null,
    emailAttempts: persistedAttempts,
    lastEmailRetryAt: now,
    nextEmailRetryAt: status === "failed" && !exhausted ? computeNextRetryAt(nextAttempts, now) : null,
    emailRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(walletWithdrawalNotifyAttemptsTable.id, attempt.id));

  if (exhausted) {
    try {
      const [stamped] = await db.select()
        .from(walletWithdrawalNotifyAttemptsTable)
        .where(eq(walletWithdrawalNotifyAttemptsTable.id, attempt.id))
        .limit(1);
      if (stamped) {
        await notifyAdminsOfWalletWithdrawalRetryExhaustion({
          attempt: stamped,
          channel: "email",
          reason: hardBounce ? "hard_bounce" : "max_attempts",
          logContext,
        });
      }
    } catch (err) {
      logger.warn(
        { ...logContext, attemptId: attempt.id, errMsg: err instanceof Error ? err.message : String(err) },
        "[wallet-withdrawal-notify] Admin email exhaustion alert dispatch failed",
      );
    }
  }

  return { channel: "email", status, error, attempts: persistedAttempts, exhausted };
}

/**
 * Re-attempt a previously failed push delivery for a single wallet
 * withdrawal notification. Mirrors {@link retryWalletWithdrawalEmail}.
 */
export async function retryWalletWithdrawalPush(opts: {
  attempt: WalletWithdrawalNotifyAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<WalletWithdrawalNotifyRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.pushStatus !== "failed") return null;
  const currentAttempts = attempt.pushAttempts ?? 0;
  if (currentAttempts >= WALLET_WITHDRAWAL_NOTIFY_MAX_PUSH_ATTEMPTS) return null;
  if (attempt.nextPushRetryAt && attempt.nextPushRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: NotifyChannelStatus;
  let error: string | undefined;

  // Honour preferPush opt-out at retry time so a member who opts out
  // between the original send and this retry isn't pinged again.
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
      "[wallet-withdrawal-notify] Failed to load preferPush on retry; defaulting to ON",
    );
  }

  if (!preferPush) {
    status = "opted_out";
  } else {
    const short = buildShortBodyForAttempt(attempt);
    try {
      const push = await sendPushToUsers([attempt.userId], short.title, short.body, {
        type: short.pushType,
        organizationId: attempt.organizationId,
        withdrawalId: attempt.withdrawalId,
        amount: String(attempt.amount),
        currency: (attempt.currency ?? "INR").toUpperCase(),
        ...(attempt.outcome === "processed" ? { utr: attempt.utr ?? null } : {}),
        ...(attempt.outcome !== "processed" ? { reason: attempt.reason ?? null } : {}),
        retry: true,
      });
      status = classifyPushDelivery(push);
      if (status === "failed") {
        error = "push_delivery_failed";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/EXPO.*not configured|PUSH.*not configured|push provider.*not configured|expo access token.*not (set|configured)/i.test(msg)) {
        await db.update(walletWithdrawalNotifyAttemptsTable).set({
          pushStatus: "skipped",
          lastPushAt: now,
          lastPushError: "provider_not_configured",
          lastPushRetryAt: now,
          nextPushRetryAt: null,
        }).where(eq(walletWithdrawalNotifyAttemptsTable.id, attempt.id));
        return { channel: "push", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      logger.error({ ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: error }, "[wallet-withdrawal-notify] Push retry failed");
    }
  }

  const exhausted = status === "failed" && nextAttempts >= WALLET_WITHDRAWAL_NOTIFY_MAX_PUSH_ATTEMPTS;
  await db.update(walletWithdrawalNotifyAttemptsTable).set({
    pushStatus: status,
    lastPushAt: now,
    lastPushError: error ?? null,
    pushAttempts: nextAttempts,
    lastPushRetryAt: now,
    nextPushRetryAt: status === "failed" && !exhausted ? computeNextRetryAt(nextAttempts, now) : null,
    pushRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(walletWithdrawalNotifyAttemptsTable.id, attempt.id));

  // Task #1279 — page the org admin once when push retries are exhausted.
  // The helper itself dedups on `adminExhaustionNotifiedAt`, so if email
  // already fired the alert this is a no-op (matches "single internal
  // alert when any withdrawal alert exhausts its retries").
  if (exhausted) {
    try {
      const [stamped] = await db.select()
        .from(walletWithdrawalNotifyAttemptsTable)
        .where(eq(walletWithdrawalNotifyAttemptsTable.id, attempt.id))
        .limit(1);
      if (stamped) {
        await notifyAdminsOfWalletWithdrawalRetryExhaustion({
          attempt: stamped,
          channel: "push",
          reason: "max_attempts",
          logContext,
        });
      }
    } catch (err) {
      logger.warn(
        { ...logContext, attemptId: attempt.id, errMsg: err instanceof Error ? err.message : String(err) },
        "[wallet-withdrawal-notify] Admin push exhaustion alert dispatch failed",
      );
    }
  }

  return { channel: "push", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Task #1279 — notify org admins exactly once when a withdrawal-paid /
 * withdrawal-failed alert exhausts its retry budget on any channel.
 *
 * Fired from:
 *   - the initial-send path in `notifyWithdrawal` when the SMTP server
 *     returns a hard bounce (5xx / InactiveRecipient / etc) and the
 *     row is short-circuited straight to exhausted on the first attempt; and
 *   - the cron-driven retry helpers (`retryWalletWithdrawalEmail` /
 *     `retryWalletWithdrawalPush`) when a row reaches the per-channel cap.
 *
 * De-duplication: stamps `adminExhaustionNotifiedAt` on the attempts
 * row inside the same transaction as the in-app message insert. The
 * conditional UPDATE (`WHERE admin_exhaustion_notified_at IS NULL`)
 * guarantees that two concurrent paths (e.g. email + push exhausting in
 * the same cron tick, or hard-bounce racing the cron) cannot both fire
 * the alert. A single row therefore yields at most one admin alert,
 * regardless of which channel triggered the exhaustion.
 *
 * Best-effort: any failure here is logged but never thrown — the
 * underlying payout has already settled at the bank and the row is
 * already marked exhausted, so callers must not be derailed by an
 * alerting error.
 */
export async function notifyAdminsOfWalletWithdrawalRetryExhaustion(opts: {
  attempt: WalletWithdrawalNotifyAttempt;
  channel: "email" | "push";
  reason: "hard_bounce" | "max_attempts";
  logContext?: Record<string, unknown>;
}): Promise<{ notified: boolean; recipients: number }> {
  const { attempt, channel, reason, logContext } = opts;

  // Resolve a friendly recipient label for the alert body. Prefer the
  // org's club_members row (matches the language used in the original
  // notify), fall back to the app_user's display name / username.
  let recipientLabel = `user #${attempt.userId}`;
  let memberContactLine = "";
  let clubMemberId: number | null = null;
  try {
    const [m] = await db.select({
      id: clubMembersTable.id,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      email: clubMembersTable.email,
      phone: clubMembersTable.phone,
    }).from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, attempt.organizationId),
        eq(clubMembersTable.userId, attempt.userId),
      ))
      .limit(1);
    if (m) {
      clubMemberId = m.id;
      const name = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim();
      if (name) recipientLabel = name;
      memberContactLine = channel === "email"
        ? `Email on file: ${m.email ?? "(none)"}.`
        : `(no registered devices or push token).`;
    }
  } catch {
    // best-effort
  }
  if (!memberContactLine && channel === "email") {
    try {
      const [u] = await db.select({
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      }).from(appUsersTable).where(eq(appUsersTable.id, attempt.userId)).limit(1);
      if (u) {
        const name = (u.displayName ?? u.username ?? "").trim();
        if (name && recipientLabel === `user #${attempt.userId}`) recipientLabel = name;
        memberContactLine = `Email on file: ${u.email ?? "(none)"}.`;
      }
    } catch {
      // best-effort
    }
  }

  const symbol = symbolFor(attempt.currency);
  const channelLabel = channel === "email" ? "email" : "push notification";
  const lastError = channel === "email" ? attempt.lastEmailError : attempt.lastPushError;
  const cap = channel === "email"
    ? WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS
    : WALLET_WITHDRAWAL_NOTIFY_MAX_PUSH_ATTEMPTS;

  const subject = `Wallet withdrawal ${channelLabel} delivery failed — ${recipientLabel} (withdrawal #${attempt.withdrawalId})`;
  const body = [
    reason === "hard_bounce"
      ? `The system has stopped retrying the wallet-withdrawal ${channelLabel} for ${recipientLabel}'s ${attempt.outcome} notice (${symbol}${attempt.amount} → ${attempt.destination}) because the provider returned a permanent bounce on the first attempt.`
      : `The system has stopped retrying the wallet-withdrawal ${channelLabel} for ${recipientLabel}'s ${attempt.outcome} notice (${symbol}${attempt.amount} → ${attempt.destination}) after ${cap} failed attempts.`,
    `Last delivery error: ${lastError ?? "unknown"}.`,
    memberContactLine || `(no contact info on file).`,
    `The underlying payout has already been recorded at the bank (UTR ${attempt.utr ?? "n/a"}). Please reach the member through another channel to confirm the outcome.`,
  ].join("\n\n");

  // 1) Atomic dedup + in-app message: stamp `adminExhaustionNotifiedAt`
  //    (only if still NULL) in the same transaction as the in-app
  //    message insert. The conditional UPDATE ensures only one caller
  //    "wins"; doing it transactionally with the insert means a partial
  //    failure (stamp succeeds, insert throws) never silently swallows
  //    the alert forever — it just retries on the next exhaustion path.
  let winner = false;
  try {
    winner = await db.transaction(async (tx) => {
      const stamped = await tx.update(walletWithdrawalNotifyAttemptsTable)
        .set({ adminExhaustionNotifiedAt: new Date() })
        .where(and(
          eq(walletWithdrawalNotifyAttemptsTable.id, attempt.id),
          isNull(walletWithdrawalNotifyAttemptsTable.adminExhaustionNotifiedAt),
        ))
        .returning({ id: walletWithdrawalNotifyAttemptsTable.id });
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
          relatedEntity: channel === "email"
            ? "wallet_withdrawal_email_exhausted"
            : "wallet_withdrawal_push_exhausted",
          relatedEntityId: attempt.id,
        });
      }
      return true;
    });
  } catch (err) {
    logger.warn(
      { ...logContext, attemptId: attempt.id, channel, errMsg: err instanceof Error ? err.message : String(err) },
      "[wallet-withdrawal-notify] Admin exhaustion stamp/insert failed",
    );
    return { notified: false, recipients: 0 };
  }

  if (!winner) {
    return { notified: false, recipients: 0 };
  }

  // 2) Push to org admins: union of direct `app_users.role='org_admin'`
  //    for this org and `org_memberships` admin/treasurer roles. Mirrors
  //    `notifyAdminsOfLevyReceiptRetryExhaustion` so admins see this in
  //    the same notification stream as other exhaustion alerts.
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
        `⚠️ Wallet withdrawal ${channelLabel} retries exhausted`,
        `${channelLabel === "email" ? "Email" : "Push"} to ${recipientLabel} for withdrawal #${attempt.withdrawalId} (${symbol}${attempt.amount}) permanently failed. Manual follow-up required.`,
        {
          type: channel === "email"
            ? "wallet_withdrawal_email_exhausted"
            : "wallet_withdrawal_push_exhausted",
          attemptId: attempt.id,
          withdrawalId: attempt.withdrawalId,
          organizationId: attempt.organizationId,
          userId: attempt.userId,
          reason,
        },
      );
    } catch (err) {
      logger.warn(
        { ...logContext, attemptId: attempt.id, channel, errMsg: err instanceof Error ? err.message : String(err) },
        "[wallet-withdrawal-notify] Admin exhaustion push failed",
      );
    }
  }

  logger.info(
    { ...logContext, attemptId: attempt.id, channel, reason, recipients: recipients.length },
    "[wallet-withdrawal-notify] Admins alerted: retry exhausted",
  );

  return { notified: true, recipients: recipients.length };
}

// ─── Admin-driven retry of an exhausted attempt (Task #1857) ───────────
// The "Failed wallet alert deliveries" worklist surfaces rows whose
// email + push retries gave up. The original action was just "Mark
// followed up" (set `adminFollowupAcknowledgedAt`), which clears the
// row off the list but doesn't actually try to deliver the message
// again. Often the right next step is to re-attempt delivery (e.g.
// after correcting the member's email / push token), so this helper
// lets the API expose a "Retry delivery" action that:
//
//   1. Resets the `<channel>RetryExhaustedAt` stamp, the per-channel
//      attempts counter, the channel status (back to `failed`) and
//      clears `nextRetryAt` for every channel that was previously
//      exhausted — this is the same reset pattern used by
//      `retryExhaustedChannel` for the coach-payout / levy-receipt
//      pipelines (notifyExhaustionOpsAlert.ts), so a wallet admin
//      action behaves consistently.
//   2. Immediately calls the existing per-channel retry helpers
//      (`retryWalletWithdrawalEmail` / `retryWalletWithdrawalPush`)
//      so the row goes through the normal notify pipeline — including
//      every per-channel guard (preferEmail/preferPush, member-comm
//      `billing` opt-out, no-address, provider-not-configured), so
//      retrying never bypasses an opt-out.
//
// Only `email` and `push` are eligible: SMS / WhatsApp on the wallet
// withdrawal pipeline are one-shot best-effort (no retry cron) and
// they don't have `*RetryExhaustedAt` columns to reset.
//
// The helper returns the per-channel retry outcomes plus whether at
// least one channel was actually re-dispatched (used by the route to
// decide whether to also stamp `adminFollowupAcknowledgedAt` so the
// row drops off the worklist).
export interface RetryExhaustedWalletWithdrawalResult {
  /** Re-loaded attempt row after the reset + retries. */
  attempt: WalletWithdrawalNotifyAttempt;
  /** Whether the email channel was eligible (had been exhausted). */
  emailEligible: boolean;
  /** Whether the push channel was eligible (had been exhausted). */
  pushEligible: boolean;
  /** Outcome of the email retry, or null if the channel wasn't eligible
   * or the retry helper declined the row (returned null). */
  emailRetry: WalletWithdrawalNotifyRetryResult | null;
  /** Outcome of the push retry, or null (same semantics as emailRetry). */
  pushRetry: WalletWithdrawalNotifyRetryResult | null;
  /**
   * True when at least one eligible channel was re-dispatched (status
   * `sent`). Mirrors the "row drops off the list" criterion used by
   * the route — a successful retry is the trigger to stamp
   * `adminFollowupAcknowledgedAt`.
   */
  anySent: boolean;
}

export async function retryExhaustedWalletWithdrawalAttempt(opts: {
  attempt: WalletWithdrawalNotifyAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<RetryExhaustedWalletWithdrawalResult> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();

  const emailEligible = !!attempt.emailRetryExhaustedAt;
  const pushEligible = !!attempt.pushRetryExhaustedAt;

  // Reset every previously-exhausted channel back to a state the
  // existing retry helpers will accept: status=failed, attempts=0,
  // exhausted stamp cleared, next-retry-at cleared. We deliberately
  // leave the `lastError` / `lastAt` stamps intact so the audit trail
  // still shows what happened on the previous attempts before this
  // admin-driven retry.
  if (emailEligible || pushEligible) {
    const patch: Record<string, unknown> = {};
    if (emailEligible) {
      patch.emailStatus = "failed";
      patch.emailAttempts = 0;
      patch.emailRetryExhaustedAt = null;
      patch.nextEmailRetryAt = null;
    }
    if (pushEligible) {
      patch.pushStatus = "failed";
      patch.pushAttempts = 0;
      patch.pushRetryExhaustedAt = null;
      patch.nextPushRetryAt = null;
    }
    await db.update(walletWithdrawalNotifyAttemptsTable)
      .set(patch)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, attempt.id));
  }

  // Re-load the attempt row so the retry helpers see the cleared
  // per-channel state (otherwise their precondition checks would
  // reject the in-memory copy still showing attempts=MAX).
  const [reset] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
    .where(eq(walletWithdrawalNotifyAttemptsTable.id, attempt.id))
    .limit(1);
  if (!reset) {
    // Should never happen — the row was loaded by the caller in the
    // same request — but guard so the helper never returns undefined.
    return {
      attempt,
      emailEligible,
      pushEligible,
      emailRetry: null,
      pushRetry: null,
      anySent: false,
    };
  }

  const emailRetry = emailEligible
    ? await retryWalletWithdrawalEmail({ attempt: reset, logContext, now })
    : null;
  const pushRetry = pushEligible
    ? await retryWalletWithdrawalPush({ attempt: reset, logContext, now })
    : null;

  // Re-load again so the caller (the route) gets the post-retry
  // snapshot — the per-channel retry helpers persist their own
  // updates (status + attempts + nextRetryAt + lastError stamps).
  const [after] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
    .where(eq(walletWithdrawalNotifyAttemptsTable.id, attempt.id))
    .limit(1);

  const anySent =
    (emailRetry?.status === "sent") ||
    (pushRetry?.status === "sent");

  return {
    attempt: after ?? reset,
    emailEligible,
    pushEligible,
    emailRetry,
    pushRetry,
    anySent,
  };
}
