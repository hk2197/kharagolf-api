/**
 * Cross-feature notification helpers (Task #657).
 *
 * Currently exposes `notifyHighlightReady`, fired by the highlight render
 * worker the moment a reel transitions to a terminal state ("ready" or
 * "failed"). Tells the player so they can close the Highlights screen and
 * come back when their reel is done.
 *
 * The notification carries enough metadata for the mobile app to deep-link
 * straight to the reel detail screen:
 *   data.type   = "highlight_render_complete"
 *   data.reelId = number
 *   data.status = "ready" | "failed"
 *
 * Honours the recipient's `userNotificationPrefsTable.preferPush` flag
 * (default true). Fire-and-forget: failures are logged but never thrown
 * — the underlying render has already succeeded or failed.
 */
import { db, highlightReelsTable, userNotificationPrefsTable, appUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendPushToUsers, classifyPushDelivery } from "./push";
import { logger } from "./logger";
import { translateHighlightPush } from "./highlightPushI18n";

const PAYMENT_CURRENCY_SYMBOLS: Record<string, string> = { INR: "₹", USD: "$", GBP: "£", EUR: "€", AUD: "A$", CAD: "C$" };

function formatPaymentAmount(amountMinor: number, currency: string): string {
  const code = (currency || "INR").toUpperCase();
  const sym = PAYMENT_CURRENCY_SYMBOLS[code] ?? `${code} `;
  const value = (Math.round(amountMinor) / 100).toFixed(2);
  return `${sym}${value}`;
}

export type StripePaymentKind = "tournament" | "league" | "shop" | "dues";

export interface PaymentNotifyInput {
  /** Recipient app user id. When null/undefined the helper skips silently. */
  userId: number | null | undefined;
  kind: StripePaymentKind;
  /** Human-readable name of the thing they paid for (tournament/league name, club name for dues, club name for shop). */
  eventName: string;
  /** Amount in the smallest currency unit (paise / cents). */
  amountMinor: number;
  currency: string;
  paymentRef: string;
  organizationId: number;
  /** Tournament id / league id / shop order id / invoice id — for deep-linking. */
  entityId?: number | string;
}

export type PaymentNotifyStatus = "sent" | "skipped" | "failed";

export interface PaymentNotifyResult {
  status: PaymentNotifyStatus;
  reason?: string;
}

/**
 * Fire an in-app push notification to confirm a settled payment for a
 * tournament entry, league entry, shop order, or dues invoice. Originally
 * added for the Stripe webhook (Task #832) and now also invoked from the
 * Razorpay verify endpoints and webhook handlers (Task #978) so members
 * paying with Razorpay (the default for INR clubs) get the same in-app
 * confirmation as Stripe payers.
 *
 * Idempotency is the caller's responsibility: each webhook section gates
 * its row update on the current status (`pending`/`unpaid`) so duplicate
 * webhook deliveries do not re-fire this helper. Synchronous verify
 * endpoints rely on the client only calling them once per successful
 * checkout (matching the existing receipt-email and outbound-webhook
 * behaviour in the same paths).
 *
 * Honours `userNotificationPrefsTable.preferPush` (default true). Best
 * effort: failures are logged and returned, never thrown.
 */
export async function notifyPaymentSettled(
  input: PaymentNotifyInput,
): Promise<PaymentNotifyResult> {
  const { userId, kind, eventName, amountMinor, currency, paymentRef, organizationId, entityId } = input;
  if (!userId || userId <= 0) return { status: "skipped", reason: "no_user" };

  try {
    const [pref] = await db.select({ preferPush: userNotificationPrefsTable.preferPush })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, userId))
      .limit(1);
    if (pref && pref.preferPush === false) {
      return { status: "skipped", reason: "opted_out" };
    }
  } catch (err) {
    // Non-fatal: fall through to send if prefs lookup fails.
    logger.warn({ userId, err }, "[payment-notify] failed to read prefs; sending anyway");
  }

  const amountStr = amountMinor > 0 ? formatPaymentAmount(amountMinor, currency) : "";
  const title = "Payment confirmed";
  let body: string;
  switch (kind) {
    case "tournament":
      body = amountStr
        ? `Your entry to ${eventName} is confirmed (${amountStr}).`
        : `Your entry to ${eventName} is confirmed.`;
      break;
    case "league":
      body = amountStr
        ? `Your spot in ${eventName} is confirmed (${amountStr}).`
        : `Your spot in ${eventName} is confirmed.`;
      break;
    case "shop":
      body = amountStr
        ? `Your order from ${eventName} is confirmed (${amountStr}).`
        : `Your order from ${eventName} is confirmed.`;
      break;
    case "dues":
      body = amountStr
        ? `Your membership dues to ${eventName} are paid (${amountStr}).`
        : `Your membership dues to ${eventName} are paid.`;
      break;
  }

  try {
    const data: Record<string, unknown> = {
      type: "payment_confirmed",
      kind,
      paymentRef,
      organizationId,
      currency: (currency || "INR").toUpperCase(),
      amountMinor,
    };
    if (entityId != null) {
      data.entityId = entityId;
      if (kind === "tournament") data.tournamentId = entityId;
      if (kind === "league") data.leagueId = entityId;
      if (kind === "shop") data.orderId = entityId;
      if (kind === "dues") data.invoiceId = entityId;
    }
    const push = await sendPushToUsers([userId], title, body, data);
    // Task #1070 — share the classifier so a payer with no Expo tokens
    // registered (their push isn't set up yet) hears nothing instead of
    // being told their payment confirmation 'failed'.
    const cls = classifyPushDelivery(push);
    if (cls === "sent") return { status: "sent" };
    if (cls === "no_address") return { status: "skipped", reason: "no_address" };
    return { status: "failed", reason: "push_delivery_failed" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ userId, kind, errMsg: reason }, "[payment-notify] push delivery failed");
    return { status: "failed", reason };
  }
}

export type HighlightNotifyStatus = "sent" | "skipped" | "failed";

export interface HighlightNotifyResult {
  status: HighlightNotifyStatus;
  reason?: string;
  reelStatus?: "queued" | "rendering" | "ready" | "failed";
}

/**
 * Send a "your highlight is ready" (or "failed") push to the reel's owner.
 *
 * Safe to call after both successful renders AND failed-render bookkeeping:
 * if the reel is still queued for retry (status='queued') the notification
 * is skipped silently — only the terminal transitions notify the player.
 */
export async function notifyHighlightReady(reelId: number): Promise<HighlightNotifyResult> {
  let reel: typeof highlightReelsTable.$inferSelect | undefined;
  try {
    const [row] = await db.select().from(highlightReelsTable)
      .where(eq(highlightReelsTable.id, reelId)).limit(1);
    reel = row;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ reelId, errMsg: reason }, "[highlight-notify] failed to load reel");
    return { status: "failed", reason };
  }

  if (!reel) return { status: "skipped", reason: "reel_not_found" };
  if (reel.status !== "ready" && reel.status !== "failed") {
    // Still queued or in-flight — not a terminal transition; nothing to do.
    return { status: "skipped", reason: "non_terminal_status", reelStatus: reel.status };
  }

  // Honour the player's push preference.
  try {
    const [pref] = await db.select({ preferPush: userNotificationPrefsTable.preferPush })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, reel.userId))
      .limit(1);
    if (pref && pref.preferPush === false) {
      return { status: "skipped", reason: "opted_out", reelStatus: reel.status };
    }
  } catch (err) {
    // Non-fatal: fall through to send if we can't read prefs.
    logger.warn({ reelId, err }, "[highlight-notify] failed to read prefs; sending anyway");
  }

  // Look up the recipient's preferred language so the push matches the
  // rest of the player-facing notification copy (e.g. spectator alerts).
  let lang: string | null = null;
  try {
    const [u] = await db.select({ lang: appUsersTable.preferredLanguage })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, reel.userId))
      .limit(1);
    lang = u?.lang ?? null;
  } catch (err) {
    // Non-fatal: fall through to English when language lookup fails.
    logger.warn({ reelId, err }, "[highlight-notify] failed to read preferred language; defaulting to en");
  }

  const { title, body } = translateHighlightPush(lang, reel.status, reel.title);

  try {
    const push = await sendPushToUsers([reel.userId], title, body, {
      type: "highlight_render_complete",
      reelId: reel.id,
      status: reel.status,
      organizationId: reel.organizationId,
    });
    // Task #1070 — share the classifier so a player whose phone has
    // never registered for push isn't booked as a delivery failure when
    // their highlight reel finishes rendering.
    const cls = classifyPushDelivery(push);
    if (cls === "sent") return { status: "sent", reelStatus: reel.status };
    if (cls === "no_address") return { status: "skipped", reason: "no_address", reelStatus: reel.status };
    return { status: "failed", reason: "push_delivery_failed", reelStatus: reel.status };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ reelId, errMsg: reason }, "[highlight-notify] push delivery failed");
    return { status: "failed", reason, reelStatus: reel.status };
  }
}
