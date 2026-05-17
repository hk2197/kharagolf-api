/**
 * Side-game settlement paid notifications (Tasks #614, #771, #772).
 *
 * Fires when a settlement transitions from `pending` to `paid` (Razorpay
 * verify, Razorpay webhook, wallet pay, or the legacy /pay endpoint) and
 * fans out to BOTH sides:
 *
 *   - Recipient (Task #614): "X paid you ₹Y for {game}"
 *       - in-app inbox row (memberMessagesTable)
 *       - push (sendPushToUsers) — honours
 *         `userNotificationPrefsTable.preferPush` (default true)
 *       - email (sendSideGameSettlementReceiptEmail) — best-effort
 *         transactional receipt to the recipient's registered email so
 *         members who don't use the mobile app still get a paper trail
 *         (Task #771). Honours `userNotificationPrefsTable.preferEmail`
 *         (default true) AND, when the recipient has a club_members row
 *         in the instance's org, `memberCommPrefsTable.emailEnabled` for
 *         the `billing` category (default true).
 *
 *   - Payer (Task #772): "You paid X ₹Y for {game} — receipt #..."
 *       - in-app inbox row (memberMessagesTable)
 *       - push (sendPushToUsers) — honours
 *         `userNotificationPrefsTable.preferPush` (default true)
 *
 * In-app messages are only written when the side has an active
 * club_members row for the instance's organization, since the inbox is
 * keyed off clubMemberId. Sides with no linked appUser are skipped
 * silently — there is no userId to notify and no inbox to write to.
 *
 * The payer fanout exists so that even when the payer's app was
 * backgrounded by the time a Razorpay webhook captures the payment,
 * they still see a confirmation.
 *
 * Fire-and-forget: every channel is best-effort and isolated. Failures
 * are logged but never thrown — the underlying payment has already
 * succeeded.
 */
import { db } from "@workspace/db";
import {
  sideGameSettlementsTable,
  sideGameInstancesTable,
  playersTable,
  clubMembersTable,
  userNotificationPrefsTable,
  memberMessagesTable,
  appUsersTable,
  memberCommPrefsTable,
  organizationsTable,
  sideGameSettlementReceiptAttemptsTable,
  type SideGameSettlementReceiptAttempt,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { sendPushToUsers, classifyPushDelivery } from "./push";
import { sendSideGameSettlementReceiptEmail, classifyMailerError, type EmailBranding } from "./mailer";
import { logger } from "./logger";

const CURRENCY_SYMBOLS: Record<string, string> = { INR: "₹", USD: "$", GBP: "£", EUR: "€" };

function symbolFor(currency: string | null | undefined): string {
  const c = (currency ?? "INR").toUpperCase();
  return CURRENCY_SYMBOLS[c] ?? `${c} `;
}

function fmtAmount(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Task #1105 — discoverability deep link to the portal "Side-game payment
 * receipts" toggle. Resolves the public web origin the same way the rest of
 * the notify libraries do (APP_BASE_URL → PUBLIC_BASE_URL → REPLIT_DEV_DOMAIN
 * → app.kharagolf.com fallback) and points at the `#comm-prefs` anchor on
 * the portal page where `PortalCommPrefs` is rendered.
 */
function buildCommPrefsUrl(): string {
  const raw = process.env.APP_BASE_URL
    ?? process.env.PUBLIC_BASE_URL
    ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "app.kharagolf.com"}`;
  // Strip a trailing slash so a misconfigured `APP_BASE_URL=https://x/`
  // doesn't produce `https://x//portal#comm-prefs`.
  const baseUrl = raw.replace(/\/+$/, "");
  return `${baseUrl}/portal#comm-prefs`;
}

export type NotifyChannelStatus = "sent" | "failed" | "skipped" | "no_user" | "opted_out" | "no_address";

export interface SettlementPaidNotifyResult {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  // Recipient channels (Tasks #614, #771). Field names retained for
  // backward compatibility with existing callers/tests.
  inApp: { status: NotifyChannelStatus; messageId?: number; error?: string };
  push: { status: NotifyChannelStatus; error?: string };
  email: { status: NotifyChannelStatus; error?: string };
  // Payer channels (Task #772).
  payerInApp: { status: NotifyChannelStatus; messageId?: number; error?: string };
  payerPush: { status: NotifyChannelStatus; error?: string };
}

/**
 * Resolve a side's appUser id for the settlement. For tournament/league
 * scopes that's playersTable.userId; for general-play scopes the engine
 * aliases userId into the playerId namespace, so the playerId IS the
 * userId. Used for both the recipient (`toPlayerId`) and the payer
 * (`fromPlayerId`).
 */
async function resolveSideUserId(
  playerId: number | null | undefined,
  instance: typeof sideGameInstancesTable.$inferSelect,
): Promise<number | null> {
  if (playerId == null) return null;
  if (instance.generalPlayRoundId) return playerId;
  const [p] = await db.select({ userId: playersTable.userId })
    .from(playersTable).where(eq(playersTable.id, playerId)).limit(1);
  return p?.userId ?? null;
}

interface SideNotifyInput {
  side: "recipient" | "payer";
  userId: number;
  title: string;
  body: string;
  pushType: string;
}

interface SideNotifyOutput {
  inApp: { status: NotifyChannelStatus; messageId?: number; error?: string };
  push: { status: NotifyChannelStatus; error?: string };
}

/**
 * Send the in-app + push pair for a single side. Each channel is wrapped
 * so a failure on one side never blocks the other. Email delivery is
 * recipient-only and handled inline by the caller.
 */
async function notifySide(
  input: SideNotifyInput,
  settlementId: number,
  instance: typeof sideGameInstancesTable.$inferSelect,
  pushPayload: Record<string, unknown>,
): Promise<SideNotifyOutput> {
  const out: SideNotifyOutput = {
    inApp: { status: "skipped" },
    push: { status: "skipped" },
  };

  // ── In-app message ──────────────────────────────────────────────────
  try {
    const [member] = await db.select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, instance.organizationId),
        eq(clubMembersTable.userId, input.userId),
      ))
      .limit(1);
    if (!member) {
      out.inApp.status = "skipped";
    } else {
      const [msg] = await db.insert(memberMessagesTable).values({
        organizationId: instance.organizationId,
        clubMemberId: member.id,
        channel: "in_app",
        subject: input.title,
        body: input.body,
        status: "sent",
        relatedEntity: "side_game_settlement",
        relatedEntityId: settlementId,
      }).returning({ id: memberMessagesTable.id });
      out.inApp.status = "sent";
      out.inApp.messageId = msg?.id;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    out.inApp.status = "failed";
    out.inApp.error = reason;
    logger.warn({ settlementId, side: input.side, errMsg: reason }, "[side-game-settle-notify] in-app insert failed");
  }

  // ── Push ────────────────────────────────────────────────────────────
  try {
    const [pref] = await db.select({ preferPush: userNotificationPrefsTable.preferPush })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, input.userId))
      .limit(1);
    const preferPush = pref?.preferPush ?? true;
    if (!preferPush) {
      out.push.status = "opted_out";
    } else {
      const push = await sendPushToUsers([input.userId], input.title, input.body, {
        type: input.pushType,
        ...pushPayload,
      });
      // Task #1070 — classifyPushDelivery centralises the
      // sent / failed / no_address mapping so "no Expo tokens registered
      // for this user" stays a benign `no_address` instead of a noisy
      // delivery failure across alerting / dashboards.
      out.push.status = classifyPushDelivery(push);
      if (out.push.status === "failed") {
        out.push.error = "push_delivery_failed";
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    out.push.status = "failed";
    out.push.error = reason;
    logger.warn({ settlementId, side: input.side, errMsg: reason }, "[side-game-settle-notify] push delivery failed");
  }

  return out;
}

/**
 * Notify both the recipient and the payer that a side-game settlement
 * has been paid.
 *
 * IMPORTANT: this helper is NOT idempotent at the message layer — each
 * call inserts fresh `member_messages` rows and fires another push.
 * Callers are responsible for invoking it exactly once per
 * pending->paid transition (every payment path in
 * `routes/side-games-v2.ts` gates its status update on `status='pending'`
 * and only fires the notify when that update returns a row).
 *
 * Returns per-side, per-channel results for telemetry but never throws.
 */
export async function notifySettlementPaid(settlementId: number): Promise<SettlementPaidNotifyResult> {
  const result: SettlementPaidNotifyResult = {
    status: "skipped",
    inApp: { status: "skipped" },
    push: { status: "skipped" },
    email: { status: "skipped" },
    payerInApp: { status: "skipped" },
    payerPush: { status: "skipped" },
  };

  let settlement: typeof sideGameSettlementsTable.$inferSelect | undefined;
  let instance: typeof sideGameInstancesTable.$inferSelect | undefined;
  try {
    const [row] = await db.select({
      settlement: sideGameSettlementsTable,
      instance: sideGameInstancesTable,
    })
      .from(sideGameSettlementsTable)
      .innerJoin(sideGameInstancesTable, eq(sideGameInstancesTable.id, sideGameSettlementsTable.instanceId))
      .where(eq(sideGameSettlementsTable.id, settlementId));
    if (!row) {
      result.reason = "settlement_not_found";
      return result;
    }
    settlement = row.settlement;
    instance = row.instance;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ settlementId, errMsg: reason }, "[side-game-settle-notify] failed to load settlement context");
    result.status = "failed";
    result.reason = reason;
    return result;
  }

  const [recipientUserId, payerUserId] = await Promise.all([
    resolveSideUserId(settlement.toPlayerId, instance).catch((err) => {
      logger.warn({ settlementId, err }, "[side-game-settle-notify] failed to resolve recipient userId");
      return null;
    }),
    resolveSideUserId(settlement.fromPlayerId, instance).catch((err) => {
      logger.warn({ settlementId, err }, "[side-game-settle-notify] failed to resolve payer userId");
      return null;
    }),
  ]);

  const amount = Number(settlement.amount);
  const amountStr = Number.isFinite(amount) ? fmtAmount(amount) : String(settlement.amount);
  const currencySymbol = symbolFor(settlement.currency);
  const fromName = settlement.fromName?.trim() || "A player";
  const toName = settlement.toName?.trim() || "the other player";
  const gameLabel = (instance.name?.trim() || instance.gameType || "side game").trim();
  const currency = (settlement.currency ?? "INR").toUpperCase();
  const receiptRef = settlement.paymentRef?.trim() || `#${settlementId}`;

  const pushPayload = {
    settlementId,
    instanceId: instance.id,
    organizationId: instance.organizationId,
    amount: amountStr,
    currency,
    gameLabel,
  };

  // Captured for the per-receipt attempts row (Task #961) so the retry
  // cron can rebuild the email body deterministically without re-reading
  // the (possibly mutated) settlement / member rows.
  let resolvedRecipientEmail: string | null = null;
  let resolvedRecipientName = "";
  // Task #1279 — track whether the initial-send email blew up with a hard
  // SMTP bounce so the receipt-attempts row insert can short-circuit
  // straight to "exhausted" instead of consuming all 5 retries.
  let emailErrorClass: ReturnType<typeof classifyMailerError> | null = null;

  // ── Recipient (Task #614) ───────────────────────────────────────────
  if (recipientUserId) {
    const out = await notifySide(
      {
        side: "recipient",
        userId: recipientUserId,
        title: `You were paid ${currencySymbol}${amountStr}`,
        body: `${fromName} paid you ${currencySymbol}${amountStr} for ${gameLabel}.`,
        pushType: "side_game_settlement_paid",
      },
      settlementId,
      instance,
      pushPayload,
    );
    result.inApp = out.inApp;
    result.push = out.push;

    // ── Email (Task #771) ─────────────────────────────────────────────
    // Best-effort transactional receipt to the recipient's registered
    // email. Honours the user-level email opt-in (default true) and,
    // when the recipient is a club member of the instance's organization,
    // the member-comm `billing` category opt-in (default true).
    try {
      const [pref] = await db.select({
        preferEmail: userNotificationPrefsTable.preferEmail,
        notifySideGameReceipts: userNotificationPrefsTable.notifySideGameReceipts,
      })
        .from(userNotificationPrefsTable)
        .where(eq(userNotificationPrefsTable.userId, recipientUserId))
        .limit(1);
      const preferEmail = pref?.preferEmail ?? true;
      // Task #962 — dedicated per-event-type opt-out. Defaults to true so
      // existing recipients keep getting receipts.
      const notifySideGameReceipts = pref?.notifySideGameReceipts ?? true;
      if (!preferEmail || !notifySideGameReceipts) {
        result.email.status = "opted_out";
      } else {
        const [member] = await db.select({
          id: clubMembersTable.id,
          email: clubMembersTable.email,
          firstName: clubMembersTable.firstName,
          lastName: clubMembersTable.lastName,
        })
          .from(clubMembersTable)
          .where(and(
            eq(clubMembersTable.organizationId, instance.organizationId),
            eq(clubMembersTable.userId, recipientUserId),
          ))
          .limit(1);

        let categoryOptedIn = true;
        if (member) {
          const [catPref] = await db.select({ emailEnabled: memberCommPrefsTable.emailEnabled })
            .from(memberCommPrefsTable)
            .where(and(
              eq(memberCommPrefsTable.clubMemberId, member.id),
              eq(memberCommPrefsTable.category, "billing"),
            ))
            .limit(1);
          categoryOptedIn = catPref ? Boolean(catPref.emailEnabled) : true;
        }

        if (!categoryOptedIn) {
          result.email.status = "opted_out";
        } else {
          // Resolve email + display name. Prefer the club_members row
          // when present (it's the org-curated address); fall back to
          // the app user. The app user row is also our source of
          // `preferredLanguage` (Task #1271), so we always load it even
          // when the club_members row already filled in email/name.
          let email = member?.email ?? null;
          let recipientName = member ? `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim() : "";
          let recipientLang: string | null = null;
          const [u] = await db.select({
            email: appUsersTable.email,
            displayName: appUsersTable.displayName,
            username: appUsersTable.username,
            preferredLanguage: appUsersTable.preferredLanguage,
          }).from(appUsersTable).where(eq(appUsersTable.id, recipientUserId)).limit(1);
          if (!email) email = u?.email ?? null;
          if (!recipientName) recipientName = (u?.displayName ?? u?.username ?? "").trim();
          recipientLang = u?.preferredLanguage ?? null;

          resolvedRecipientEmail = email;
          resolvedRecipientName = recipientName;
          if (!email) {
            result.email.status = "no_address";
          } else {
            // Branding lookup is best-effort; defaults are fine on
            // failure.
            let branding: EmailBranding = { orgName: "KHARAGOLF" };
            try {
              const [org] = await db.select({
                name: organizationsTable.name,
                logoUrl: organizationsTable.logoUrl,
                primaryColor: organizationsTable.primaryColor,
              }).from(organizationsTable).where(eq(organizationsTable.id, instance.organizationId)).limit(1);
              branding = {
                orgName: org?.name ?? "KHARAGOLF",
                logoUrl: org?.logoUrl ?? undefined,
                primaryColor: org?.primaryColor ?? undefined,
              };
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              logger.warn({ settlementId, errMsg: reason }, "[side-game-settle-notify] failed to load org branding for email");
            }

            await sendSideGameSettlementReceiptEmail({
              to: email,
              recipientName,
              payerName: fromName,
              gameLabel,
              currency,
              currencySymbol,
              amount: amountStr,
              paymentMethod: settlement.paymentMethod ?? null,
              paymentRef: settlement.paymentRef ?? null,
              paidAt: settlement.paidAt ?? null,
              branding,
              commPrefsUrl: buildCommPrefsUrl(),
              lang: recipientLang,
            });
            result.email.status = "sent";
          }
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Classify once: `provider_unconfigured` (Task #1502) is terminal
      // `skipped` so the cron never re-selects this row; everything else
      // marks the row `failed` and surfaces `emailErrorClass` to the
      // persist block so a hard SMTP bounce (Task #1279) can short-circuit
      // straight to exhausted instead of consuming all 5 retries.
      const errClass = classifyMailerError(err);
      if (errClass === "provider_unconfigured") {
        result.email.status = "skipped";
        result.email.error = "provider_not_configured";
      } else {
        result.email.status = "failed";
        result.email.error = reason;
        emailErrorClass = errClass;
        logger.warn({ settlementId, errMsg: reason, errClass }, "[side-game-settle-notify] email delivery failed");
      }
    }
  }

  // ── Payer (Task #772) ───────────────────────────────────────────────
  if (payerUserId) {
    const out = await notifySide(
      {
        side: "payer",
        userId: payerUserId,
        title: `You paid ${currencySymbol}${amountStr}`,
        body: `You paid ${toName} ${currencySymbol}${amountStr} for ${gameLabel} — receipt ${receiptRef}.`,
        pushType: "side_game_settlement_paid_payer",
      },
      settlementId,
      instance,
      { ...pushPayload, receiptRef },
    );
    result.payerInApp = out.inApp;
    result.payerPush = out.push;
  }

  if (!recipientUserId && !payerUserId) {
    result.reason = "no_recipient_user";
    return result;
  }
  if (!recipientUserId) {
    // Preserve the original telemetry signal for callers that only ever
    // looked at the recipient outcome.
    result.reason = result.reason ?? "no_recipient_user";
  }

  const statuses = [
    result.inApp.status,
    result.push.status,
    result.email.status,
    result.payerInApp.status,
    result.payerPush.status,
  ];
  if (statuses.includes("sent")) {
    result.status = "sent";
  } else if (statuses.includes("failed")) {
    result.status = "failed";
    result.reason =
      result.inApp.error
      ?? result.push.error
      ?? result.email.error
      ?? result.payerInApp.error
      ?? result.payerPush.error;
  } else {
    result.status = "skipped";
  }

  // ── Receipt attempts row (Task #961) ───────────────────────────────
  // Persist a per-settlement attempts row so the retry cron can re-attempt
  // failed email/push deliveries on a bounded schedule with exponential
  // backoff. Best-effort: a failure to persist this row never alters the
  // notify outcome the caller sees.
  if (recipientUserId) {
    try {
      const emailAttempted = result.email.status === "sent" || result.email.status === "failed";
      const pushAttempted = result.push.status === "sent" || result.push.status === "failed";
      const now = new Date();
      // Task #1279 — a hard SMTP bounce on the first attempt skips the
      // retry budget entirely: stamp the row as exhausted so the cron
      // never re-fires this address (the bounce will recur every time).
      const emailExhaustedNow = result.email.status === "failed" && emailErrorClass === "hard_bounce";
      const persistedEmailAttempts = emailAttempted
        ? (emailExhaustedNow ? SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS : 1)
        : 0;
      const nextEmail = result.email.status === "failed" && !emailExhaustedNow
        ? computeNextRetryAt(1, now)
        : null;
      const nextPush = result.push.status === "failed" ? computeNextRetryAt(1, now) : null;
      await db.insert(sideGameSettlementReceiptAttemptsTable).values({
        organizationId: instance.organizationId,
        settlementId,
        recipientUserId,
        payerName: fromName,
        recipientName: resolvedRecipientName || null,
        recipientEmail: resolvedRecipientEmail,
        gameLabel,
        currency,
        amount: amountStr,
        paymentMethod: settlement.paymentMethod ?? null,
        paymentRef: settlement.paymentRef ?? null,
        paidAt: settlement.paidAt ?? null,
        emailStatus: result.email.status,
        emailAttempts: persistedEmailAttempts,
        lastEmailAt: emailAttempted ? now : null,
        lastEmailError: result.email.error ?? null,
        nextEmailRetryAt: nextEmail,
        emailRetryExhaustedAt: emailExhaustedNow ? now : null,
        pushStatus: result.push.status,
        pushAttempts: pushAttempted ? 1 : 0,
        lastPushAt: pushAttempted ? now : null,
        lastPushError: result.push.error ?? null,
        nextPushRetryAt: nextPush,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ settlementId, errMsg: reason }, "[side-game-settle-notify] Failed to record retry-attempts row");
    }
  }

  return result;
}

// ─── Retry helpers (Task #961) ──────────────────────────────────────────
// Bounded retry cap per channel for a single side-game receipt notification
// (initial attempt + retries). Once a channel reaches this cap, the cron
// stops re-attempting it and stamps `*RetryExhaustedAt` on the attempts row.
export const SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS = 5;
export const SIDE_GAME_RECEIPT_MAX_PUSH_ATTEMPTS = 5;

// Exponential-backoff schedule: 5, 10, 20, 40, 80 minutes between attempts
// (i.e. attempt N waits 5 * 2^(N-1) minutes after attempt N-1). Capped so a
// freak attempts value never produces a runaway delay.
const SIDE_GAME_RECEIPT_BACKOFF_BASE_MS = 5 * 60 * 1000;
const SIDE_GAME_RECEIPT_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export function computeNextRetryAt(completedAttempts: number, from: Date = new Date()): Date {
  const exp = Math.max(0, completedAttempts - 1);
  const delay = Math.min(
    SIDE_GAME_RECEIPT_BACKOFF_BASE_MS * Math.pow(2, exp),
    SIDE_GAME_RECEIPT_BACKOFF_MAX_MS,
  );
  return new Date(from.getTime() + delay);
}

export interface SideGameReceiptRetryResult {
  channel: "email" | "push";
  status: NotifyChannelStatus;
  error?: string;
  attempts: number;
  exhausted: boolean;
}

/**
 * Re-attempt a previously failed email delivery for a single side-game
 * settlement receipt. Returns `null` when the row is no longer eligible
 * (status not `failed`, cap reached, or backoff window not yet elapsed).
 *
 * Provider-not-configured errors flip the row to terminal `skipped` so the
 * cron stops re-selecting it.
 */
export async function retrySideGameReceiptEmail(opts: {
  attempt: SideGameSettlementReceiptAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<SideGameReceiptRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.emailStatus !== "failed") return null;
  const currentAttempts = attempt.emailAttempts ?? 0;
  if (currentAttempts >= SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS) return null;
  if (attempt.nextEmailRetryAt && attempt.nextEmailRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: NotifyChannelStatus;
  let error: string | undefined;
  // Task #1279 — track whether the latest provider error is a hard SMTP
  // bounce so we can short-circuit straight to exhausted instead of
  // consuming the rest of the budget.
  let hardBounce = false;

  if (!attempt.recipientEmail) {
    status = "no_address";
  } else {
    // Branding lookup is best-effort.
    let branding: EmailBranding = { orgName: "KHARAGOLF" };
    try {
      const [org] = await db.select({
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
      }).from(organizationsTable).where(eq(organizationsTable.id, attempt.organizationId)).limit(1);
      branding = {
        orgName: org?.name ?? "KHARAGOLF",
        logoUrl: org?.logoUrl ?? undefined,
        primaryColor: org?.primaryColor ?? undefined,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ ...logContext, attemptId: attempt.id, errMsg: reason }, "[side-game-settle-notify] Failed to load org branding for retry");
    }

    // Recipient language lookup (Task #1271) — best-effort. Falls back
    // to the English pack when the user row is gone or has no preference.
    let recipientLang: string | null = null;
    try {
      const [u] = await db.select({
        preferredLanguage: appUsersTable.preferredLanguage,
      }).from(appUsersTable).where(eq(appUsersTable.id, attempt.recipientUserId)).limit(1);
      recipientLang = u?.preferredLanguage ?? null;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ ...logContext, attemptId: attempt.id, errMsg: reason }, "[side-game-settle-notify] Failed to load recipient language for retry");
    }

    try {
      await sendSideGameSettlementReceiptEmail({
        to: attempt.recipientEmail,
        recipientName: attempt.recipientName ?? "",
        payerName: attempt.payerName,
        gameLabel: attempt.gameLabel,
        currency: attempt.currency,
        currencySymbol: symbolFor(attempt.currency),
        amount: attempt.amount,
        paymentMethod: attempt.paymentMethod ?? null,
        paymentRef: attempt.paymentRef ?? null,
        paidAt: attempt.paidAt ?? null,
        branding,
        commPrefsUrl: buildCommPrefsUrl(),
        lang: recipientLang,
      });
      status = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errClass = classifyMailerError(err);
      // Provider unconfigured — flip status to terminal `skipped` so the
      // cron stops re-selecting this row. Don't increment attempts: it's
      // an environment issue, not a delivery failure. Reuse the `errClass`
      // computed once above so coverage matches the initial-send branch
      // (no need for the legacy regex fallback).
      if (errClass === "provider_unconfigured") {
        await db.update(sideGameSettlementReceiptAttemptsTable).set({
          emailStatus: "skipped",
          lastEmailAt: now,
          lastEmailError: "provider_not_configured",
          lastEmailRetryAt: now,
          nextEmailRetryAt: null,
        }).where(eq(sideGameSettlementReceiptAttemptsTable.id, attempt.id));
        return { channel: "email", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      // Task #1279 — a hard SMTP bounce on a retry must not consume the
      // rest of the budget: jump straight to exhausted so the cron stops
      // re-firing this row.
      if (errClass === "hard_bounce") {
        hardBounce = true;
      }
      logger.error({ ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: msg, errClass }, "[side-game-settle-notify] Email retry failed");
    }
  }

  const exhausted = status === "failed" && (hardBounce || nextAttempts >= SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS);
  const persistedAttempts = exhausted && hardBounce
    ? SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS
    : nextAttempts;
  await db.update(sideGameSettlementReceiptAttemptsTable).set({
    emailStatus: status,
    lastEmailAt: now,
    lastEmailError: error ?? null,
    emailAttempts: persistedAttempts,
    lastEmailRetryAt: now,
    nextEmailRetryAt: status === "failed" && !exhausted ? computeNextRetryAt(nextAttempts, now) : null,
    emailRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(sideGameSettlementReceiptAttemptsTable.id, attempt.id));

  return { channel: "email", status, error, attempts: persistedAttempts, exhausted };
}

/**
 * Re-attempt a previously failed push delivery for a single side-game
 * settlement receipt. Mirrors {@link retrySideGameReceiptEmail}.
 */
export async function retrySideGameReceiptPush(opts: {
  attempt: SideGameSettlementReceiptAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<SideGameReceiptRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.pushStatus !== "failed") return null;
  const currentAttempts = attempt.pushAttempts ?? 0;
  if (currentAttempts >= SIDE_GAME_RECEIPT_MAX_PUSH_ATTEMPTS) return null;
  if (attempt.nextPushRetryAt && attempt.nextPushRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: NotifyChannelStatus;
  let error: string | undefined;

  const symbol = symbolFor(attempt.currency);
  const title = `You were paid ${symbol}${attempt.amount}`;
  const body = `${attempt.payerName} paid you ${symbol}${attempt.amount} for ${attempt.gameLabel}.`;

  try {
    const push = await sendPushToUsers([attempt.recipientUserId], title, body, {
      type: "side_game_settlement_paid",
      settlementId: attempt.settlementId,
      organizationId: attempt.organizationId,
      amount: attempt.amount,
      currency: attempt.currency,
      gameLabel: attempt.gameLabel,
      retry: true,
    });
    status = classifyPushDelivery(push);
    if (status === "failed") {
      error = "push_delivery_failed";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/EXPO.*not configured|PUSH.*not configured|push provider.*not configured|expo access token.*not (set|configured)/i.test(msg)) {
      await db.update(sideGameSettlementReceiptAttemptsTable).set({
        pushStatus: "skipped",
        lastPushAt: now,
        lastPushError: "provider_not_configured",
        lastPushRetryAt: now,
        nextPushRetryAt: null,
      }).where(eq(sideGameSettlementReceiptAttemptsTable.id, attempt.id));
      return { channel: "push", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
    }
    status = "failed";
    error = msg;
    logger.error({ ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: error }, "[side-game-settle-notify] Push retry failed");
  }

  const exhausted = status === "failed" && nextAttempts >= SIDE_GAME_RECEIPT_MAX_PUSH_ATTEMPTS;
  await db.update(sideGameSettlementReceiptAttemptsTable).set({
    pushStatus: status,
    lastPushAt: now,
    lastPushError: error ?? null,
    pushAttempts: nextAttempts,
    lastPushRetryAt: now,
    nextPushRetryAt: status === "failed" && !exhausted ? computeNextRetryAt(nextAttempts, now) : null,
    pushRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(sideGameSettlementReceiptAttemptsTable.id, attempt.id));

  return { channel: "push", status, error, attempts: nextAttempts, exhausted };
}
