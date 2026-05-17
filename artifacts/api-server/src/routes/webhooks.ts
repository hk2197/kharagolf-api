import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";

// timingSafeEqual throws when buffers have different lengths — guard against malformed inputs
function safeTimingEqual(a: Buffer, b: Buffer): boolean {
  try {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
import { and, eq, or, desc } from "drizzle-orm";
import { db, shotsTable, wearableConnectionsTable, playersTable, tournamentsTable, memberSubscriptionsTable, clubMembersTable, shopOrdersTable, organizationsTable, memberDataRequestsTable, memberLevyReceiptAttemptsTable, coachPayoutsTable, leagueMembersTable, leaguesTable, memberInvoicesTable, duesPaymentsTable, clubWalletWithdrawalsTable, stripeWebhookDeliveriesTable, emailSuppressionsTable, campaignRecipientsTable, marketingCampaignsTable, emailTemplatesMarketingTable, appUsersTable, orgMembershipsTable } from "@workspace/db";
import {
  findWithdrawalByPayoutId,
  findWithdrawalByReference,
  markWithdrawalProcessed,
  markWithdrawalFailed,
  markWithdrawalProcessing,
} from "../lib/walletPayouts";
import { notifyWithdrawalProcessed, notifyWithdrawalFailed } from "../lib/walletWithdrawalNotify";
import { verifyWebhookSignature } from "../lib/razorpay";
import { verifyStripeWebhookSignature } from "../lib/stripeProcessor";
import { recordCheckoutSettlement } from "../lib/checkout";
import { inArray, type SQL } from "drizzle-orm";
import { applyLevyChargePayment } from "./member-360";
import { markSettlementPaid } from "./side-games-v2";
import { sendBroadcast } from "../lib/comms";
import { notifyPaymentSettled } from "../lib/notifications";
import { notifySuperAdminsOfPlanMigration } from "../lib/planMigrationDigest";
import { notifyOrgAdminsOfPlanCancellation, notifyOrgAdminsOfPlanPastDue } from "../lib/orgPlanCancelledNotify";
import { isSubscriptionTier, isTierDowngrade, type SubscriptionTier } from "../lib/subscriptionTiers";
import { sendBroadcastEmail } from "../lib/mailer";
import { notifyAdminOfReBounceAfterReenable } from "../lib/rebounceAfterReenableNotify";
import { track } from "../lib/analytics";
import { sendReceiptEmail, sendShopOrderReceiptEmail, sendDuesReceiptEmail, currencySymbol } from "../lib/paymentReceipts";
import { dispatchWebhookEvent } from "../lib/webhookDispatch";
import { shopProductsTable } from "@workspace/db";
import { logger as baseLogger } from "../lib/logger";

const logger = baseLogger.child({ module: "webhooks" });

const router: IRouter = Router();

// Garmin shot-type string → our internal enum value
const GARMIN_SHOT_TYPE_MAP: Record<string, string> = {
  DRIVE: "tee",
  FAIRWAY: "fairway",
  APPROACH: "approach",
  CHIP: "chip",
  PUTT: "putt",
  BUNKER: "chip",
  PENALTY: "tee",
};

// ── POST /api/webhooks/garmin ─────────────────────────────────────────────────
//
// Garmin Health API push notification endpoint.
// Garmin signs each request with HMAC-SHA1 using the consumer secret.
// Signature is in X-Garmin-Signature header (hex digest).
//
// We resolve the Garmin userId → wearable_connections.externalUserId → our
// user → player record in an active tournament, then persist shot data.
//
// Reference: https://developer.garmin.com/gc-developer-program/health-api/

router.post("/garmin", async (req: Request, res: Response) => {
  const consumerSecret = process.env.GARMIN_CONSUMER_SECRET;
  const isDev = process.env.NODE_ENV === "development";

  if (!consumerSecret) {
    if (!isDev) {
      // Fail closed in production — do not accept unsigned pushes
      logger.error("[webhooks/garmin] GARMIN_CONSUMER_SECRET not configured; rejecting webhook");
      res.status(503).json({ error: "Webhook endpoint not configured" });
      return;
    }
    logger.warn("[webhooks/garmin] GARMIN_CONSUMER_SECRET not set — skipping signature check in dev");
  } else {
    const sig = req.headers["x-garmin-signature"] as string | undefined;
    if (!sig) {
      logger.warn("[webhooks/garmin] Missing signature header");
      res.status(401).json({ error: "Missing Garmin signature" });
      return;
    }

    // Use raw request bytes for HMAC — re-serialising req.body would break
    // signature checks for any key ordering, whitespace, or unicode variation.
    const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody || rawBody.length === 0) {
      logger.warn("[webhooks/garmin] Raw body unavailable — cannot verify signature");
      res.status(400).json({ error: "Cannot verify signature: raw body unavailable" });
      return;
    }
    const expected = createHmac("sha1", consumerSecret)
      .update(rawBody)
      .digest("hex");

    if (!safeTimingEqual(Buffer.from(sig), Buffer.from(expected))) {
      logger.warn("[webhooks/garmin] Signature mismatch");
      res.status(401).json({ error: "Invalid Garmin signature" });
      return;
    }
  }

  const body = req.body as {
    activities?: Array<{
      userId?: string;
      activityId?: number;
      startTimeInSeconds?: number;
      durationInSeconds?: number;
      distanceInMeters?: number;
      activityType?: string;
      activityName?: string;
    }>;
    activityDetails?: Array<{
      userId?: string;
      activityId?: number;
      shots?: Array<{
        holeNumber?: number;
        shotNumber?: number;
        shotType?: string;
        latitude?: number;
        longitude?: number;
        distanceToPin?: number;
      }>;
    }>;
  };

  const activityCount = body.activities?.length ?? 0;
  let shotsInserted = 0;

  // Build a lookup cache: garminUserId → { userId, playerId, tournamentId, courseId }
  // so we don't query DB repeatedly for the same Garmin user within one webhook push.
  const connectionCache = new Map<string, {
    internalUserId: number;
    playerId: number;
    tournamentId: number;
    courseId: number | null;
    round: number;
  }>();

  /**
   * Resolve a Garmin user ID to an active player/tournament context.
   * We join: wearable_connections (externalUserId = garminUserId)
   *          → players (userId = wearable_connections.userId, tournament is active/ongoing)
   *          → tournaments (status = "active" | "in_progress")
   * Returns the most recently started active tournament for the user.
   */
  async function resolveGarminUser(garminUserId: string) {
    if (connectionCache.has(garminUserId)) return connectionCache.get(garminUserId);

    // Find wearable connection by externalUserId
    const [conn] = await db
      .select({ userId: wearableConnectionsTable.userId })
      .from(wearableConnectionsTable)
      .where(
        and(
          eq(wearableConnectionsTable.provider, "garmin"),
          eq(wearableConnectionsTable.externalUserId, garminUserId),
        ),
      );

    if (!conn) {
      logger.warn({ garminUserId }, "[webhooks/garmin] No wearable connection found for Garmin userId");
      return undefined;
    }

    // Find the most recent active/in-progress tournament this user is registered for
    const playerRows = await db
      .select({
        playerId: playersTable.id,
        tournamentId: playersTable.tournamentId,
        currentRound: playersTable.currentRound,
        courseId: tournamentsTable.courseId,
        tournamentStatus: tournamentsTable.status,
        startDate: tournamentsTable.startDate,
      })
      .from(playersTable)
      .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
      .where(
        and(
          eq(playersTable.userId, conn.userId),
        ),
      )
      .orderBy(tournamentsTable.startDate);

    // Prefer tournaments that are active or in_progress
    const active = playerRows.find(r =>
      r.tournamentStatus === "active" || (r.tournamentStatus as string) === "in_progress",
    );
    const candidate = active ?? playerRows[playerRows.length - 1];
    if (!candidate) {
      logger.warn({ garminUserId, internalUserId: conn.userId }, "[webhooks/garmin] No player record found for user");
      return undefined;
    }

    const ctx = {
      internalUserId: conn.userId,
      playerId: candidate.playerId,
      tournamentId: candidate.tournamentId,
      courseId: candidate.courseId,
      round: candidate.currentRound,
    };
    connectionCache.set(garminUserId, ctx);
    return ctx;
  }

  // ── Process detailed shot-level data from Garmin ──────────────────────────
  const details = body.activityDetails ?? [];

  for (const detail of details) {
    if (!detail.userId || !detail.shots?.length) continue;

    const ctx = await resolveGarminUser(detail.userId);
    if (!ctx) continue;

    const rows = detail.shots
      .filter(s => s.holeNumber != null && s.shotNumber != null && s.latitude != null && s.longitude != null)
      .map(s => ({
        tournamentId: ctx.tournamentId,
        playerId: ctx.playerId,
        round: ctx.round,
        holeNumber: s.holeNumber!,
        shotNumber: s.shotNumber!,
        shotType: (GARMIN_SHOT_TYPE_MAP[s.shotType ?? ""] ?? "fairway") as never,
        latitude: String(s.latitude!),
        longitude: String(s.longitude!),
        distanceToPin: s.distanceToPin != null ? String(Math.round(s.distanceToPin * 1.09361)) : null,
        source: "watch" as const,
        recordedAt: new Date(),
      }));

    if (rows.length === 0) continue;

    // Insert shots — idempotent: skip duplicates on the unique shot tuple
    try {
      await db
        .insert(shotsTable)
        .values(rows)
        .onConflictDoNothing({
          target: [shotsTable.playerId, shotsTable.tournamentId, shotsTable.round, shotsTable.holeNumber, shotsTable.shotNumber],
        });
      shotsInserted += rows.length;
      logger.info(
        { activityId: detail.activityId, playerId: ctx.playerId, tournamentId: ctx.tournamentId, shots: rows.length },
        "[webhooks/garmin] Shots ingested",
      );
    } catch (err) {
      logger.error({ err, activityId: detail.activityId }, "[webhooks/garmin] Failed to insert shots");
    }
  }

  // ── Update lastSyncAt for all Garmin users referenced in this push ────────
  const garminUserIds = [
    ...new Set([
      ...(body.activities ?? []).map(a => a.userId).filter(Boolean),
      ...(body.activityDetails ?? []).map(d => d.userId).filter(Boolean),
    ]),
  ] as string[];

  for (const garminUserId of garminUserIds) {
    try {
      await db
        .update(wearableConnectionsTable)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(wearableConnectionsTable.provider, "garmin"),
            eq(wearableConnectionsTable.externalUserId, garminUserId),
          ),
        );
    } catch {
      // Non-critical — don't fail the webhook
    }
  }

  logger.info({ activities: activityCount, shotsInserted }, "[webhooks/garmin] Webhook processed");
  res.status(200).json({ received: true, activities: activityCount, shotsInserted });
});

// ── POST /api/webhooks/garmin/deregistration ──────────────────────────────────
// Called by Garmin when a user revokes access — mark connection as disconnected.
// Authenticated with the same HMAC-SHA1 mechanism as the main webhook.
router.post("/garmin/deregistration", async (req: Request, res: Response) => {
  const consumerSecret = process.env.GARMIN_CONSUMER_SECRET;
  const isDev = process.env.NODE_ENV === "development";

  if (!consumerSecret) {
    if (!isDev) {
      logger.error("[webhooks/garmin/deregistration] GARMIN_CONSUMER_SECRET not configured; rejecting");
      res.status(503).json({ error: "Webhook endpoint not configured" });
      return;
    }
    logger.warn("[webhooks/garmin/deregistration] GARMIN_CONSUMER_SECRET not set — skipping signature check in dev");
  } else {
    const sig = req.headers["x-garmin-signature"] as string | undefined;
    if (!sig) {
      logger.warn("[webhooks/garmin/deregistration] Missing signature header");
      res.status(401).json({ error: "Missing Garmin signature" });
      return;
    }
    const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody || rawBody.length === 0) {
      logger.warn("[webhooks/garmin/deregistration] Raw body unavailable — cannot verify signature");
      res.status(400).json({ error: "Cannot verify signature: raw body unavailable" });
      return;
    }
    const expected = createHmac("sha1", consumerSecret).update(rawBody).digest("hex");
    if (!safeTimingEqual(Buffer.from(sig), Buffer.from(expected))) {
      logger.warn("[webhooks/garmin/deregistration] Signature mismatch");
      res.status(401).json({ error: "Invalid Garmin signature" });
      return;
    }
  }

  const body = req.body as { userId?: string };
  logger.info({ body }, "[webhooks/garmin] Deregistration callback");

  if (body.userId) {
    try {
      await db
        .update(wearableConnectionsTable)
        .set({ status: "disconnected", updatedAt: new Date() })
        .where(
          and(
            eq(wearableConnectionsTable.provider, "garmin"),
            eq(wearableConnectionsTable.externalUserId, body.userId),
          ),
        );
    } catch (err) {
      logger.error({ err, userId: body.userId }, "[webhooks/garmin] Failed to deregister connection");
    }
  }

  res.status(200).json({ received: true });
});

// ── POST /api/webhooks/razorpay-subscription ──────────────────────────────────
// Handles Razorpay subscription lifecycle events:
//   subscription.charged  → mark active, update nextBillingDate
//   subscription.halted   → move to grace_period (billing failed)
//   subscription.cancelled → mark cancelled on both sub and member records
//
// Razorpay signs each webhook with HMAC-SHA256 of the raw body using
// RAZORPAY_WEBHOOK_SECRET.  We verify this before trusting the payload.
router.post("/razorpay-subscription", async (req: Request, res: Response) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const sig = req.headers["x-razorpay-signature"] as string | undefined;

  const isDev = process.env.NODE_ENV === "development";

  if (!webhookSecret) {
    if (!isDev) {
      // Fail closed in production: a missing secret is a misconfiguration, not a dev shortcut.
      logger.error("[webhooks/razorpay-subscription] RAZORPAY_WEBHOOK_SECRET not configured — rejecting to prevent forged events");
      res.status(503).json({ error: "Webhook secret not configured" });
      return;
    }
    logger.warn("[webhooks/razorpay-subscription] RAZORPAY_WEBHOOK_SECRET not set — skipping verification (development only)");
  } else {
    if (!sig) {
      logger.warn("[webhooks/razorpay-subscription] Missing X-Razorpay-Signature header");
      res.status(401).json({ error: "Missing signature" });
      return;
    }
    const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody;
    const bodyStr = rawBody ? rawBody.toString("utf8") : JSON.stringify(req.body);
    if (!verifyWebhookSignature(bodyStr, sig, webhookSecret)) {
      logger.warn("[webhooks/razorpay-subscription] Signature mismatch");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  }

  const event = req.body.event as string | undefined;
  const subEntity = (req.body.payload?.subscription?.entity ?? {}) as Record<string, unknown>;
  const paymentEntity = (req.body.payload?.payment?.entity ?? {}) as Record<string, unknown>;

  const razorpaySubscriptionId = subEntity.id as string | undefined;
  if (!razorpaySubscriptionId) {
    res.status(200).json({ received: true, skipped: "no subscription id" });
    return;
  }

  const [sub] = await db.select().from(memberSubscriptionsTable)
    .where(eq(memberSubscriptionsTable.razorpaySubscriptionId, razorpaySubscriptionId));

  if (!sub) {
    logger.warn({ razorpaySubscriptionId, event }, "[webhooks/razorpay-subscription] Subscription not found in DB");
    res.status(200).json({ received: true, skipped: "unknown subscription" });
    return;
  }

  if (event === "subscription.charged") {
    // Billing successful — renew status and advance next billing date
    const chargeAt = subEntity.charge_at as number | undefined;
    const nextBillingDate = chargeAt ? new Date(chargeAt * 1000) : null;
    const razorpayPaymentId = paymentEntity.id as string | undefined;
    // Idempotency for Task #978 push: only fire once per distinct payment id
    // (Razorpay redelivers webhooks; same payment id ⇒ same charge).
    const isNewCharge = !!razorpayPaymentId && razorpayPaymentId !== sub.lastPaymentId;

    await db.update(memberSubscriptionsTable).set({
      status: "active",
      nextBillingDate: nextBillingDate ?? sub.nextBillingDate,
      lastPaymentId: razorpayPaymentId ?? sub.lastPaymentId,
      lastPaymentAt: new Date(),
      failedPaymentCount: 0,
      updatedAt: new Date(),
    }).where(eq(memberSubscriptionsTable.id, sub.id));

    await db.update(clubMembersTable).set({
      subscriptionStatus: "active",
      renewalDate: nextBillingDate ?? undefined,
      updatedAt: new Date(),
    }).where(eq(clubMembersTable.id, sub.clubMemberId));

    logger.info({ subId: sub.id, nextBillingDate }, "[webhooks/razorpay-subscription] Charged — marked active");

    // In-app push to the member for each successful Razorpay subscription
    // charge (Task #978 — dues parity with Stripe). Idempotency keyed off
    // Razorpay payment id so re-deliveries don't re-notify.
    if (isNewCharge) {
      try {
        const [memberRow] = await db.select({
          userId: clubMembersTable.userId,
          organizationId: clubMembersTable.organizationId,
        }).from(clubMembersTable).where(eq(clubMembersTable.id, sub.clubMemberId));
        if (memberRow) {
          const [orgRow] = await db.select({ name: organizationsTable.name })
            .from(organizationsTable).where(eq(organizationsTable.id, memberRow.organizationId));
          const amountMinor = Number(paymentEntity.amount ?? 0) > 0
            ? Number(paymentEntity.amount)
            : 0;
          const currency = String(paymentEntity.currency ?? "INR");
          await notifyPaymentSettled({
            userId: memberRow.userId,
            kind: "dues",
            eventName: orgRow?.name ?? "Your Club",
            amountMinor,
            currency,
            paymentRef: razorpayPaymentId ?? `razorpay_sub:${sub.id}`,
            organizationId: memberRow.organizationId,
            entityId: sub.id,
          });
        }
      } catch (pushErr) {
        logger.warn({ err: pushErr, subId: sub.id }, "[webhooks/razorpay-subscription] dues push failed");
      }
    }

  } else if (event === "subscription.halted") {
    // Billing failed — move to past_due, org admin can cancel or member can update payment
    await db.update(memberSubscriptionsTable).set({
      status: "past_due",
      failedPaymentCount: (sub.failedPaymentCount ?? 0) + 1,
      updatedAt: new Date(),
    }).where(eq(memberSubscriptionsTable.id, sub.id));

    await db.update(clubMembersTable).set({
      subscriptionStatus: "past_due",
      updatedAt: new Date(),
    }).where(eq(clubMembersTable.id, sub.clubMemberId));

    // Notify the member that their payment failed
    try {
      const [member] = await db.select({
        email: clubMembersTable.email,
        firstName: clubMembersTable.firstName,
        organizationId: clubMembersTable.organizationId,
      }).from(clubMembersTable).where(eq(clubMembersTable.id, sub.clubMemberId));

      if (member?.email) {
        const [org] = await db.select({ id: organizationsTable.id, name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
          .from(organizationsTable).where(eq(organizationsTable.id, member.organizationId));
        const orgName = org?.name ?? "KHARAGOLF";
        // Task #1319 — pass `orgId` so the bounce webhook (Task #981) tags
        // any hard bounce back to this club without scanning campaigns /
        // memberships.
        await sendBroadcastEmail(
          member.email,
          member.firstName,
          "Membership payment failed — action required",
          `Your ${orgName} membership payment could not be processed.\n\nYour membership has entered a grace period. Please update your payment method to avoid losing access.\n\nIf you need assistance, please contact the club directly.`,
          orgName,
          { logoUrl: org?.logoUrl ?? undefined, primaryColor: org?.primaryColor ?? undefined, orgId: org?.id ?? member.organizationId },
        );
        logger.info({ subId: sub.id, memberId: sub.clubMemberId }, "[webhooks/razorpay-subscription] Failed payment notification sent");
      }
    } catch (notifyErr) {
      logger.warn({ err: notifyErr, subId: sub.id }, "[webhooks/razorpay-subscription] Failed to send payment failure notification");
    }

    logger.info({ subId: sub.id }, "[webhooks/razorpay-subscription] Halted — grace period");

  } else if (event === "subscription.cancelled") {
    // Subscription cancelled (by member or Razorpay)
    await db.update(memberSubscriptionsTable).set({
      status: "cancelled",
      cancelledAt: sub.cancelledAt ?? new Date(),
      updatedAt: new Date(),
    }).where(eq(memberSubscriptionsTable.id, sub.id));

    await db.update(clubMembersTable).set({
      subscriptionStatus: "cancelled",
      updatedAt: new Date(),
    }).where(eq(clubMembersTable.id, sub.clubMemberId));

    logger.info({ subId: sub.id }, "[webhooks/razorpay-subscription] Cancelled");

  } else {
    logger.info({ event }, "[webhooks/razorpay-subscription] Unhandled event — no-op");
  }

  res.status(200).json({ received: true, event });
});

// ── POST /api/webhooks/razorpay-levy-payment ────────────────────────────────
// Canonical confirmation channel for member-initiated levy payments. Listens
// for `payment.captured` / `order.paid` events tagged with notes.kind ===
// "levy_charge_payment" (set when the order was created in
// /api/portal/levies/charges/:chargeId/order). Idempotent — re-deliveries are
// detected via the audit log marker [rzp:<paymentId>].
router.post("/razorpay-levy-payment", async (req: Request, res: Response) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const sig = req.headers["x-razorpay-signature"] as string | undefined;
  const bodyStr = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});

  if (process.env.NODE_ENV === "production") {
    if (!webhookSecret) {
      logger.error("[webhooks/razorpay-levy-payment] RAZORPAY_WEBHOOK_SECRET not configured — rejecting");
      res.status(503).json({ error: "Webhook secret not configured" }); return;
    }
    if (!sig) {
      res.status(401).json({ error: "Missing signature" }); return;
    }
    if (!verifyWebhookSignature(bodyStr, sig, webhookSecret)) {
      logger.warn("[webhooks/razorpay-levy-payment] Signature mismatch");
      res.status(401).json({ error: "Invalid signature" }); return;
    }
  } else if (webhookSecret && sig) {
    if (!verifyWebhookSignature(bodyStr, sig, webhookSecret)) {
      res.status(401).json({ error: "Invalid signature" }); return;
    }
  } else {
    logger.warn("[webhooks/razorpay-levy-payment] RAZORPAY_WEBHOOK_SECRET not set — skipping verification (development only)");
  }

  const event = req.body?.event as string | undefined;
  const paymentEntity = (req.body?.payload?.payment?.entity ?? {}) as Record<string, unknown>;
  const orderEntity = (req.body?.payload?.order?.entity ?? {}) as Record<string, unknown>;
  // Notes live on the order; payment-only events fall back to payment.notes.
  const notes = ((orderEntity.notes ?? paymentEntity.notes) ?? {}) as Record<string, string>;

  if (notes.kind !== "levy_charge_payment") {
    res.json({ received: true, ignored: true, reason: "not a levy_charge_payment event" });
    return;
  }
  if (event !== "payment.captured" && event !== "order.paid") {
    res.json({ received: true, ignored: true, reason: `unhandled event ${event}` });
    return;
  }

  const orgId = Number(notes.organizationId);
  const levyId = Number(notes.levyId);
  const memberId = Number(notes.clubMemberId);
  const chargeId = Number(notes.levyChargeId);
  if (!orgId || !levyId || !memberId || !chargeId) {
    logger.warn({ notes, event }, "[webhooks/razorpay-levy-payment] missing notes fields");
    res.json({ received: true, ignored: true, reason: "missing notes" });
    return;
  }

  const amountRaw = Number(paymentEntity.amount ?? orderEntity.amount_paid ?? orderEntity.amount);
  if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
    logger.warn({ amountRaw, event }, "[webhooks/razorpay-levy-payment] invalid amount");
    res.json({ received: true, ignored: true, reason: "invalid amount" });
    return;
  }
  const amount = amountRaw / 100;
  const paymentId = String(paymentEntity.id ?? "");
  const orderId = String(orderEntity.id ?? paymentEntity.order_id ?? "");

  const result = await applyLevyChargePayment({
    req: null,
    organizationId: orgId,
    levyId,
    clubMemberId: memberId,
    amount,
    source: "webhook",
    providerPaymentId: paymentId || undefined,
    providerOrderId: orderId || undefined,
  });

  if (!result.ok) {
    if (result.code === "already_applied") {
      logger.info({ chargeId, paymentId, event }, "[webhooks/razorpay-levy-payment] duplicate — already applied");
    } else {
      logger.warn({ err: result.error, code: result.code, chargeId, paymentId, event }, "[webhooks/razorpay-levy-payment] apply failed");
    }
    // Always 200 so Razorpay stops retrying — application-level failures are
    // surfaced via logs and the response body, not via webhook retries.
    res.status(200).json({ received: true, applied: false, code: result.code, error: result.error });
    return;
  }
  logger.info({ chargeId, paymentId, applied: result.appliedAmount, fullySettled: result.fullySettled }, "[webhooks/razorpay-levy-payment] payment applied");
  res.status(200).json({ received: true, applied: true, fullySettled: result.fullySettled, remainingBalance: result.remainingBalance });
});


// ── POST /api/webhooks/razorpay-side-game-settlement ───────────────────────
// Task #455 — canonical confirmation channel for in-app side-game
// settle-up payments. Listens for `payment.captured` / `order.paid` events
// tagged with notes.kind === "side_game_settlement" (set when the order
// was created in /api/side-game-settlements/:id/pay-order). Idempotent —
// markSettlementPaid is a no-op when the settlement is already paid.
router.post("/razorpay-side-game-settlement", async (req: Request, res: Response) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const sig = req.headers["x-razorpay-signature"] as string | undefined;
  const bodyStr = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});

  if (process.env.NODE_ENV === "production") {
    if (!webhookSecret) {
      logger.error("[webhooks/razorpay-side-game-settlement] RAZORPAY_WEBHOOK_SECRET not configured — rejecting");
      res.status(503).json({ error: "Webhook secret not configured" }); return;
    }
    if (!sig) {
      res.status(401).json({ error: "Missing signature" }); return;
    }
    if (!verifyWebhookSignature(bodyStr, sig, webhookSecret)) {
      logger.warn("[webhooks/razorpay-side-game-settlement] Signature mismatch");
      res.status(401).json({ error: "Invalid signature" }); return;
    }
  } else if (webhookSecret && sig) {
    if (!verifyWebhookSignature(bodyStr, sig, webhookSecret)) {
      res.status(401).json({ error: "Invalid signature" }); return;
    }
  } else {
    logger.warn("[webhooks/razorpay-side-game-settlement] RAZORPAY_WEBHOOK_SECRET not set — skipping verification (development only)");
  }

  const event = req.body?.event as string | undefined;
  const paymentEntity = (req.body?.payload?.payment?.entity ?? {}) as Record<string, unknown>;
  const orderEntity = (req.body?.payload?.order?.entity ?? {}) as Record<string, unknown>;
  const notes = ((orderEntity.notes ?? paymentEntity.notes) ?? {}) as Record<string, string>;

  if (notes.kind !== "side_game_settlement") {
    res.json({ received: true, ignored: true, reason: "not a side_game_settlement event" });
    return;
  }
  if (event !== "payment.captured" && event !== "order.paid") {
    res.json({ received: true, ignored: true, reason: `unhandled event ${event}` });
    return;
  }

  const settlementId = Number(notes.settlementId);
  const paymentId = String(paymentEntity.id ?? "");
  if (!settlementId || !paymentId) {
    logger.warn({ notes, event }, "[webhooks/razorpay-side-game-settlement] missing notes/paymentId");
    res.json({ received: true, ignored: true, reason: "missing fields" });
    return;
  }
  try {
    const updated = await markSettlementPaid({
      settlementId,
      paymentMethod: "razorpay",
      paymentRef: paymentId,
      source: "webhook",
    });
    if (!updated) {
      res.status(200).json({ received: true, applied: false, reason: "settlement not found" });
      return;
    }
    logger.info({ settlementId, paymentId, status: updated.status }, "[webhooks/razorpay-side-game-settlement] settlement processed");
    res.status(200).json({ received: true, applied: true, status: updated.status });
  } catch (err) {
    logger.warn({ err, settlementId, paymentId }, "[webhooks/razorpay-side-game-settlement] apply failed");
    res.status(200).json({ received: true, applied: false, error: (err as Error).message });
  }
});


// ── POST /api/webhooks/whatsapp ──────────────────────────────────────────────
//
// Task 347: WhatsApp delivery-receipt webhook.
//
// Both the supported transactional WhatsApp providers (Twilio and MSG91)
// asynchronously POST a delivery status callback once the carrier confirms
// (or rejects) message delivery. We use these to update the
// `member_data_requests` row so:
//
//   1. The dashboard chip always reflects the carrier-confirmed state, not
//      just the provider-accepted state captured at send time.
//   2. Messages that the carrier reports as `failed` or `undelivered` are
//      flipped back to `lastWhatsappStatus = "failed"` so the existing
//      `retryFailedDataRequestPushSms` cron picks them up — bounded by the
//      same DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS cap, which the cron enforces.
//   3. The exhaustion alert path (notifyAdminsOfRetryExhaustion) fires
//      naturally once retries triggered by these callbacks hit the cap.
//
// Single endpoint, two body shapes:
//   • Twilio: x-www-form-urlencoded with `MessageSid`, `MessageStatus`,
//     optional `ErrorCode`/`ErrorMessage`. Signed with HMAC-SHA1 of
//     (full URL + sorted key/value pairs) using TWILIO_AUTH_TOKEN, base64
//     in `X-Twilio-Signature`.
//   • MSG91: application/json with `request_id`, `status`, optional
//     `error`/`description`. Authenticated with the configured
//     `MSG91_WEBHOOK_AUTH_KEY` in either the `authkey` header or query.
//
// Production fails closed when neither provider's secret is configured.
function normaliseWhatsappStatus(raw: string | undefined | null): {
  status: "delivered" | "failed" | "sent" | "read" | null;
  isFailure: boolean;
} {
  const v = (raw ?? "").toLowerCase().trim();
  if (!v) return { status: null, isFailure: false };
  // Twilio: queued, sending, sent, delivered, undelivered, failed, read
  // MSG91:  delivered, read, failed, undelivered, enqueued, sent
  if (v === "delivered") return { status: "delivered", isFailure: false };
  if (v === "read") return { status: "read", isFailure: false };
  if (v === "failed" || v === "undelivered") return { status: "failed", isFailure: true };
  if (v === "sent" || v === "queued" || v === "sending" || v === "enqueued") return { status: "sent", isFailure: false };
  return { status: null, isFailure: false };
}

function verifyTwilioSignature(authToken: string, fullUrl: string, params: Record<string, string>, sigHeader: string): boolean {
  // Twilio signature: HMAC-SHA1(authToken, url + concatenated sorted key+value pairs), base64.
  const sortedKeys = Object.keys(params).sort();
  let data = fullUrl;
  for (const k of sortedKeys) data += k + params[k];
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  return safeTimingEqual(Buffer.from(sigHeader), Buffer.from(expected));
}

router.post("/whatsapp", async (req: Request, res: Response) => {
  const isProd = process.env.NODE_ENV === "production";
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const msg91WebhookKey = process.env.MSG91_WEBHOOK_AUTH_KEY;

  if (isProd && !twilioToken && !msg91WebhookKey) {
    logger.error("[webhooks/whatsapp] No provider webhook secret configured (TWILIO_AUTH_TOKEN or MSG91_WEBHOOK_AUTH_KEY); rejecting");
    res.status(503).json({ error: "Webhook endpoint not configured" });
    return;
  }

  // Detect provider by content-type / payload shape.
  const contentType = (req.headers["content-type"] ?? "").toLowerCase();
  let providerMessageId: string | undefined;
  let rawStatus: string | undefined;
  let providerErr: string | undefined;
  let provider: "twilio" | "msg91" | "unknown" = "unknown";

  if (contentType.includes("application/x-www-form-urlencoded") || (req.body && typeof req.body === "object" && "MessageSid" in req.body)) {
    provider = "twilio";
    const body = req.body as Record<string, string>;

    if (twilioToken) {
      const sig = req.headers["x-twilio-signature"] as string | undefined;
      if (!sig) {
        logger.warn("[webhooks/whatsapp] Twilio: missing X-Twilio-Signature");
        res.status(401).json({ error: "Missing Twilio signature" });
        return;
      }
      // Build the URL Twilio used to sign — prefer X-Forwarded-Proto/Host when present.
      const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
      const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.get("host") ?? "";
      const fullUrl = `${proto}://${host}${req.originalUrl}`;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === "string") params[k] = v;
      }
      if (!verifyTwilioSignature(twilioToken, fullUrl, params, sig)) {
        logger.warn({ fullUrl }, "[webhooks/whatsapp] Twilio: signature mismatch");
        res.status(401).json({ error: "Invalid Twilio signature" });
        return;
      }
    } else if (isProd) {
      logger.error("[webhooks/whatsapp] Twilio payload received but TWILIO_AUTH_TOKEN not configured; rejecting in prod");
      res.status(503).json({ error: "Twilio webhook not configured" });
      return;
    }

    providerMessageId = body.MessageSid;
    rawStatus = body.MessageStatus;
    if (body.ErrorCode || body.ErrorMessage) {
      providerErr = [body.ErrorCode, body.ErrorMessage].filter(Boolean).join(": ").slice(0, 500);
    }
  } else {
    provider = "msg91";
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (msg91WebhookKey) {
      const headerKey = (req.headers["authkey"] as string | undefined) ?? (req.headers["authorization"] as string | undefined);
      const queryKey = typeof req.query.authkey === "string" ? (req.query.authkey as string) : undefined;
      const presented = headerKey ?? queryKey;
      if (!presented || !safeTimingEqual(Buffer.from(presented), Buffer.from(msg91WebhookKey))) {
        logger.warn("[webhooks/whatsapp] MSG91: auth key mismatch");
        res.status(401).json({ error: "Invalid MSG91 webhook auth key" });
        return;
      }
    } else if (isProd) {
      logger.error("[webhooks/whatsapp] MSG91 payload received but MSG91_WEBHOOK_AUTH_KEY not configured; rejecting in prod");
      res.status(503).json({ error: "MSG91 webhook not configured" });
      return;
    }

    // MSG91 nests delivery info under either `data` or top-level. Handle both.
    const data = (typeof body.data === "object" && body.data !== null ? body.data : body) as Record<string, unknown>;
    providerMessageId = (data.request_id as string | undefined) ?? (data.requestId as string | undefined) ?? (body.request_id as string | undefined);
    rawStatus = (data.status as string | undefined) ?? (body.status as string | undefined);
    const err = (data.error as string | undefined) ?? (data.description as string | undefined) ?? (data.reason as string | undefined);
    if (err) providerErr = String(err).slice(0, 500);
  }

  if (!providerMessageId) {
    logger.warn({ provider, body: req.body }, "[webhooks/whatsapp] Missing provider message id; ignoring");
    res.status(200).json({ received: true, ignored: "missing message id" });
    return;
  }

  const { status: normalised, isFailure } = normaliseWhatsappStatus(rawStatus);
  if (!normalised) {
    logger.info({ provider, providerMessageId, rawStatus }, "[webhooks/whatsapp] Unmapped status; ignoring");
    res.status(200).json({ received: true, ignored: "unmapped status" });
    return;
  }

  // Look up the originating notice by provider message id. Privacy-notice
  // sends (Task 347) and levy-receipt sends (Task 507) both stamp the
  // provider message id at send time on their respective tables; check both.
  const [request] = await db.select().from(memberDataRequestsTable)
    .where(eq(memberDataRequestsTable.lastWhatsappMessageId, providerMessageId))
    .limit(1);

  if (request) {
    // Map normalised status onto lastWhatsappStatus. We only ever flip to
    // "failed" — never away from a terminal "sent" if a "delivered" arrives
    // later (delivered is a stronger acceptance and we record it).
    // The retry cron uses lastWhatsappStatus === "failed" with whatsappAttempts
    // < cap as its selection predicate, so flipping to "failed" is sufficient
    // to re-enter the retry pipeline. The cap is enforced by the cron and by
    // retryDataRequestWhatsapp itself, so a webhook flood cannot bypass it.
    await db.update(memberDataRequestsTable).set({
      lastWhatsappStatus: isFailure ? "failed" : normalised,
      lastWhatsappAt: new Date(),
      lastWhatsappError: isFailure ? (providerErr ?? "carrier_reported_failure") : null,
    }).where(eq(memberDataRequestsTable.id, request.id));

    logger.info({
      provider,
      providerMessageId,
      requestId: request.id,
      normalised,
      isFailure,
      whatsappAttempts: request.whatsappAttempts,
    }, "[webhooks/whatsapp] Status callback applied (data request)");

    res.status(200).json({ received: true, matched: true, status: isFailure ? "failed" : normalised });
    return;
  }

  // Task 507: levy-receipt fan-outs stamp the provider message id on
  // member_levy_receipt_attempts so a failure callback re-flips the row to
  // `failed`, letting the existing levy receipt retry cron pick it up.
  const [levyAttempt] = await db.select().from(memberLevyReceiptAttemptsTable)
    .where(eq(memberLevyReceiptAttemptsTable.lastWhatsappMessageId, providerMessageId))
    .limit(1);

  if (levyAttempt) {
    await db.update(memberLevyReceiptAttemptsTable).set({
      whatsappStatus: isFailure ? "failed" : normalised,
      lastWhatsappAt: new Date(),
      lastWhatsappError: isFailure ? (providerErr ?? "carrier_reported_failure") : null,
    }).where(eq(memberLevyReceiptAttemptsTable.id, levyAttempt.id));

    logger.info({
      provider,
      providerMessageId,
      attemptId: levyAttempt.id,
      chargeId: levyAttempt.chargeId,
      normalised,
      isFailure,
      whatsappAttempts: levyAttempt.whatsappAttempts,
    }, "[webhooks/whatsapp] Status callback applied (levy receipt)");

    res.status(200).json({ received: true, matched: true, status: isFailure ? "failed" : normalised });
    return;
  }

  logger.info({ provider, providerMessageId, normalised }, "[webhooks/whatsapp] No matching notice");
  res.status(200).json({ received: true, matched: false });
});

// ── POST /api/webhooks/razorpay-payout ────────────────────────────────────
//
// Handles RazorpayX payout lifecycle events for coach disbursements.
//   payout.processed → payout completed; mark coach payout `paid` + paidAt
//   payout.failed    → mark coach payout `failed` + failureReason
//   payout.reversed  → reversed by the bank; mark `failed` + failureReason
//   payout.updated   → intermediate state (queued/processing); status sync only
//
// Reconciles by Razorpay payout id (stored on `coach_payouts.payoutReference`)
// or, as a fallback, by the `reference_id` (coachpayout_<id>) we set on
// submission. Webhook is signed with HMAC-SHA256 of the raw body using
// `RAZORPAYX_WEBHOOK_SECRET` (falls back to `RAZORPAY_WEBHOOK_SECRET` for
// installations that share a single secret across products).
router.post("/razorpay-payout", async (req: Request, res: Response) => {
  const webhookSecret = process.env.RAZORPAYX_WEBHOOK_SECRET ?? process.env.RAZORPAY_WEBHOOK_SECRET;
  const sig = req.headers["x-razorpay-signature"] as string | undefined;
  const isDev = process.env.NODE_ENV === "development";

  if (!webhookSecret) {
    if (!isDev) {
      logger.error("[webhooks/razorpay-payout] RAZORPAYX_WEBHOOK_SECRET not configured — rejecting");
      res.status(503).json({ error: "Webhook secret not configured" });
      return;
    }
    logger.warn("[webhooks/razorpay-payout] webhook secret not set — skipping verification (development only)");
  } else {
    if (!sig) {
      res.status(401).json({ error: "Missing signature" });
      return;
    }
    const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody;
    const bodyStr = rawBody ? rawBody.toString("utf8") : JSON.stringify(req.body);
    if (!verifyWebhookSignature(bodyStr, sig, webhookSecret)) {
      logger.warn("[webhooks/razorpay-payout] Signature mismatch");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  }

  const event = req.body?.event as string | undefined;
  const payoutEntity = (req.body?.payload?.payout?.entity ?? {}) as Record<string, unknown>;

  const razorpayPayoutId = payoutEntity.id as string | undefined;
  const referenceId = payoutEntity.reference_id as string | undefined;
  const failureReason = (payoutEntity.failure_reason as string | undefined) ?? null;
  const utr = payoutEntity.utr as string | undefined;
  const status = payoutEntity.status as string | undefined;

  if (!razorpayPayoutId && !referenceId) {
    res.status(200).json({ received: true, skipped: "no payout id or reference" });
    return;
  }

  // ── Wallet withdrawals (Task #770) ────────────────────────────────────
  // Member-initiated wallet payouts use a `walletwd_<id>` reference id
  // (and we record the Razorpay payout id on the row as soon as the API
  // returns it). Resolve before the coach-payout branch so they don't
  // collide.
  let walletWithdrawal: typeof clubWalletWithdrawalsTable.$inferSelect | undefined;
  if (razorpayPayoutId) walletWithdrawal = await findWithdrawalByPayoutId(razorpayPayoutId);
  if (!walletWithdrawal && referenceId) walletWithdrawal = await findWithdrawalByReference(referenceId);
  if (walletWithdrawal) {
    if (walletWithdrawal.status === "processed") {
      res.status(200).json({ received: true, walletWithdrawal: true, alreadyProcessed: true });
      return;
    }
    if (event === "payout.processed" || status === "processed") {
      const t = await markWithdrawalProcessed({
        withdrawalId: walletWithdrawal.id,
        razorpayPayoutId,
        utr: utr ?? null,
      });
      logger.info({ withdrawalId: walletWithdrawal.id, razorpayPayoutId, utr }, "[webhooks/razorpay-payout] Wallet withdrawal processed");
      // Member-facing notification — only on the first transition so a
      // replayed webhook does not double-notify (Task #964).
      if (t.transitioned) {
        notifyWithdrawalProcessed({ withdrawalId: walletWithdrawal.id, utr: utr ?? null }).catch((err) => {
          logger.warn({ err, withdrawalId: walletWithdrawal!.id }, "[webhooks/razorpay-payout] notifyWithdrawalProcessed failed");
        });
      }
      res.status(200).json({ received: true, walletWithdrawal: true, applied: "processed" });
      return;
    }
    if (event === "payout.failed" || event === "payout.reversed" ||
        status === "failed" || status === "reversed" || status === "rejected" || status === "cancelled") {
      const newStatus = (event === "payout.reversed" || status === "reversed") ? "reversed" : "failed";
      const reason = failureReason ?? `Razorpay status: ${status ?? event ?? newStatus}`;
      const t = await markWithdrawalFailed({
        withdrawalId: walletWithdrawal.id,
        razorpayPayoutId,
        status: newStatus,
        reason,
      });
      logger.info({ withdrawalId: walletWithdrawal.id, razorpayPayoutId, status, event, failureReason }, "[webhooks/razorpay-payout] Wallet withdrawal failed/reversed (refunded)");
      if (t.transitioned) {
        notifyWithdrawalFailed({ withdrawalId: walletWithdrawal.id, status: newStatus, reason }).catch((err) => {
          logger.warn({ err, withdrawalId: walletWithdrawal!.id }, "[webhooks/razorpay-payout] notifyWithdrawalFailed failed");
        });
      }
      res.status(200).json({ received: true, walletWithdrawal: true, applied: newStatus });
      return;
    }
    if (event === "payout.updated" || status === "processing" || status === "queued" || status === "pending") {
      await markWithdrawalProcessing({ withdrawalId: walletWithdrawal.id, razorpayPayoutId });
      res.status(200).json({ received: true, walletWithdrawal: true, applied: "processing" });
      return;
    }
    res.status(200).json({ received: true, walletWithdrawal: true, ignored: true });
    return;
  }

  // Resolve the local payout row. Prefer payout id (set on submission); fall
  // back to the reference_id (`coachpayout_<id>`) we always include.
  let localPayout: typeof coachPayoutsTable.$inferSelect | undefined;
  if (razorpayPayoutId) {
    [localPayout] = await db.select().from(coachPayoutsTable)
      .where(eq(coachPayoutsTable.payoutReference, razorpayPayoutId));
  }
  if (!localPayout && referenceId && referenceId.startsWith("coachpayout_")) {
    const localId = parseInt(referenceId.slice("coachpayout_".length));
    if (Number.isFinite(localId)) {
      [localPayout] = await db.select().from(coachPayoutsTable)
        .where(eq(coachPayoutsTable.id, localId));
    }
  }
  if (!localPayout) {
    logger.warn({ razorpayPayoutId, referenceId, event }, "[webhooks/razorpay-payout] No matching coach_payouts row");
    res.status(200).json({ received: true, skipped: "unknown payout" });
    return;
  }

  if (localPayout.status === "paid") {
    res.status(200).json({ received: true, alreadyPaid: true });
    return;
  }

  if (event === "payout.processed" || status === "processed") {
    await db.update(coachPayoutsTable).set({
      status: "paid",
      paidAt: new Date(),
      payoutReference: razorpayPayoutId ?? localPayout.payoutReference,
      notes: utr ? `UTR: ${utr}` : localPayout.notes,
      failureReason: null,
    }).where(eq(coachPayoutsTable.id, localPayout.id));
    logger.info({ payoutId: localPayout.id, razorpayPayoutId, utr }, "[webhooks/razorpay-payout] Marked paid");
    res.status(200).json({ received: true, applied: "paid" });
    return;
  }

  if (event === "payout.failed" || event === "payout.reversed" || status === "failed" || status === "reversed" || status === "rejected" || status === "cancelled") {
    await db.update(coachPayoutsTable).set({
      status: "failed",
      payoutReference: razorpayPayoutId ?? localPayout.payoutReference,
      failureReason: failureReason ?? `Razorpay status: ${status ?? event ?? "failed"}`,
    }).where(eq(coachPayoutsTable.id, localPayout.id));
    logger.info({ payoutId: localPayout.id, razorpayPayoutId, status, event, failureReason }, "[webhooks/razorpay-payout] Marked failed");
    res.status(200).json({ received: true, applied: "failed" });
    return;
  }

  if (event === "payout.updated" || status === "processing" || status === "queued" || status === "pending") {
    // Intermediate states — reflect them so the admin tab shows live progress.
    await db.update(coachPayoutsTable).set({
      status: "processing",
      payoutReference: razorpayPayoutId ?? localPayout.payoutReference,
    }).where(eq(coachPayoutsTable.id, localPayout.id));
    res.status(200).json({ received: true, applied: "processing" });
    return;
  }

  logger.info({ event, status, payoutId: localPayout.id }, "[webhooks/razorpay-payout] Unhandled event — no-op");
  res.status(200).json({ received: true, ignored: true });
});

// ── POST /api/webhooks/stripe ─────────────────────────────────────────────
//
// Task #499 — Stripe webhook reconciliation for non-INR Checkout payments.
//
// The checkout creation side (createCheckoutOrder / createCheckoutPaymentLink)
// already routes non-INR clubs through Stripe. This endpoint is the matching
// settlement channel: it listens for `checkout.session.completed` and
// `payment_intent.succeeded` events and flips the originating
// shopOrders / players / leagueMembers / memberInvoices rows to "paid", and
// records an FX-ledger entry (with a settledAt timestamp) for non-base-
// currency settlements.
//
// Design notes:
//   - Idempotent: each row update is gated on the current status being
//     unpaid/pending so duplicate webhook deliveries are safe.
//   - Binding: the Stripe object id (PaymentIntent or Checkout Session) was
//     stored on the originating row at creation time (in the shared
//     `razorpayOrderId` / `razorpayPaymentLinkId` columns), so we can match
//     by id without trusting the event metadata for entity selection.
//   - Metadata is still consulted to resolve the org id when the row lookup
//     hits multiple orgs (it shouldn't, but defence-in-depth) and to fall
//     back when the stored id has been cleared.
//   - Razorpay webhook handlers above are intentionally untouched.
router.post("/stripe", async (req: Request, res: Response) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers["stripe-signature"] as string | undefined;
  const isDev = process.env.NODE_ENV === "development";
  const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody;

  // Task #974 — best-effort attempt to parse the event id/type up front so
  // even rejected requests (signature mismatch, missing header) get an audit
  // row admins can see in the Communications panel.
  let earlyEventId: string | null = null;
  let earlyEventType: string | null = null;
  try {
    const peek = (req.body ?? {}) as { id?: unknown; type?: unknown };
    if (typeof peek.id === "string") earlyEventId = peek.id;
    if (typeof peek.type === "string") earlyEventType = peek.type;
  } catch { /* request body not parseable — leave both null */ }
  const sourceIp = req.ip ?? null;

  // Audit-log helper. Records the delivery attempt regardless of outcome so
  // admins can spot silent failures (e.g. Stripe retrying because the secret
  // was rotated mid-day) without grepping logs.
  async function recordDelivery(opts: {
    eventId: string | null;
    eventType: string | null;
    signatureValid: boolean | null;
    applied: boolean;
    responseStatus: number;
    // Task #1126 — short reason explaining a non-2xx response so the admin
    // panel can show why a delivery failed without requiring a log dive.
    errorReason?: string | null;
  }): Promise<void> {
    try {
      await db.insert(stripeWebhookDeliveriesTable).values({
        eventId: opts.eventId,
        eventType: opts.eventType,
        sourceIp,
        signatureValid: opts.signatureValid,
        applied: opts.applied,
        responseStatus: opts.responseStatus,
        errorReason: opts.errorReason ?? null,
      });
    } catch (err) {
      logger.warn({ err }, "[webhooks/stripe] failed to record delivery audit row");
    }
  }

  let signatureValid: boolean | null = null;
  if (!webhookSecret) {
    if (!isDev) {
      logger.error("[webhooks/stripe] STRIPE_WEBHOOK_SECRET not configured — rejecting");
      await recordDelivery({ eventId: earlyEventId, eventType: earlyEventType, signatureValid: null, applied: false, responseStatus: 503, errorReason: "missing_secret" });
      res.status(503).json({ error: "Webhook secret not configured" }); return;
    }
    logger.warn("[webhooks/stripe] STRIPE_WEBHOOK_SECRET not set — skipping verification (development only)");
    signatureValid = null;
  } else {
    if (!sig) {
      await recordDelivery({ eventId: earlyEventId, eventType: earlyEventType, signatureValid: false, applied: false, responseStatus: 401, errorReason: "missing_header" });
      res.status(401).json({ error: "Missing stripe-signature header" }); return;
    }
    if (!rawBody || rawBody.length === 0) {
      await recordDelivery({ eventId: earlyEventId, eventType: earlyEventType, signatureValid: false, applied: false, responseStatus: 400, errorReason: "missing_body" });
      res.status(400).json({ error: "Cannot verify signature: raw body unavailable" }); return;
    }
    if (!verifyStripeWebhookSignature(rawBody, sig, webhookSecret)) {
      logger.warn("[webhooks/stripe] Signature mismatch");
      await recordDelivery({ eventId: earlyEventId, eventType: earlyEventType, signatureValid: false, applied: false, responseStatus: 401, errorReason: "signature_mismatch" });
      res.status(401).json({ error: "Invalid Stripe signature" }); return;
    }
    signatureValid = true;
  }

  const event = req.body as {
    id?: string;
    type?: string;
    created?: number;
    data?: { object?: Record<string, unknown> };
  };
  const type = event.type;
  const obj = (event.data?.object ?? {}) as Record<string, unknown>;

  // ── Subscription tier sync (Task #1133) ─────────────────────────────────
  // Stripe-billed organizations land their plan changes via
  // `customer.subscription.created` / `customer.subscription.updated`. The
  // tier is encoded on the subscription's metadata as `targetTier` (mirrors
  // the Razorpay `notes.targetTier` convention used in
  // routes/onboarding.ts). When the slug isn't a canonical tier we silently
  // downgrade the org to Free AND fan out a real-time alert to super
  // admins via `notifySuperAdminsOfPlanMigration`, so the Plan Migration
  // Audit panel + email/push land within seconds instead of waiting for
  // the hourly digest cron.
  if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
    const subMeta = (obj["metadata"] as Record<string, unknown> | null | undefined) ?? {};
    const subOrgIdRaw = subMeta["organizationId"];
    const subOrgId = typeof subOrgIdRaw === "string" ? Number.parseInt(subOrgIdRaw, 10)
      : typeof subOrgIdRaw === "number" ? subOrgIdRaw : NaN;
    const targetTierRaw = subMeta["targetTier"];
    const targetTier = typeof targetTierRaw === "string" ? targetTierRaw : null;

    if (!Number.isFinite(subOrgId) || subOrgId <= 0) {
      await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: false, responseStatus: 200 });
      res.json({ received: true, ignored: true, reason: "subscription event missing organizationId metadata" });
      return;
    }

    try {
      const [org] = await db.select({ id: organizationsTable.id, subscriptionTier: organizationsTable.subscriptionTier })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, subOrgId));
      if (!org) {
        await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: false, responseStatus: 200 });
        res.json({ received: true, ignored: true, reason: "organizationId not found" });
        return;
      }

      const fromTier = org.subscriptionTier as string | null;

      if (isSubscriptionTier(targetTier)) {
        // Known tier — apply it and mark active.
        const newTier: SubscriptionTier = targetTier;
        await db.update(organizationsTable)
          .set({
            subscriptionTier: newTier,
            subscriptionStatus: "active",
            pendingSubscriptionTier: null,
            updatedAt: new Date(),
          })
          .where(eq(organizationsTable.id, subOrgId));
        logger.info({ organizationId: subOrgId, fromTier, toTier: newTier, type }, "[webhooks/stripe] subscription tier applied");

        // Task #1905 — Mid-tier downgrades (e.g. enterprise → starter) are
        // a churn signal worth surfacing in real time, just like the
        // Free-cancellation path in the `customer.subscription.deleted`
        // branch below. Upgrades and same-tier renewals stay silent.
        if (isTierDowngrade(fromTier, newTier)) {
          try {
            await notifySuperAdminsOfPlanMigration({
              organizationId: subOrgId,
              fromTier,
              toTier: newTier,
              reason: `Stripe plan downgraded ${fromTier} → ${newTier}`,
              // Task #1906 — paid-plan tier downgrade is paid-plan churn,
              // so reuse the "cancelled" subject + push title rather than
              // the generic "auto-reset to Free" wording.
              triggerReason: "cancelled",
              req,
            });
          } catch (notifyErr) {
            logger.warn(
              { err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr), organizationId: subOrgId },
              "[webhooks/stripe] paid-tier downgrade realtime notify failed",
            );
          }
        }

        await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: true, responseStatus: 200 });
        res.json({ received: true, applied: true, tier: newTier });
        return;
      }

      // Unknown / unmappable tier — silently downgrade to Free and
      // raise the realtime alert so super admins can investigate.
      await db.update(organizationsTable)
        .set({
          subscriptionTier: "free",
          subscriptionStatus: "active",
          pendingSubscriptionTier: null,
          updatedAt: new Date(),
        })
        .where(eq(organizationsTable.id, subOrgId));

      try {
        await notifySuperAdminsOfPlanMigration({
          organizationId: subOrgId,
          fromTier,
          toTier: "free",
          reason: `Stripe ${type} delivered unknown tier slug "${targetTier ?? ""}" — auto-reset to Free`,
          // Task #1906 — categorical trigger so the email subject + push
          // title surface "auto-reset (unknown tier)" instead of being
          // conflated with genuine cancellations on the same code path.
          triggerReason: "unknown_tier",
          req,
        });
      } catch (notifyErr) {
        logger.warn(
          { err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr), organizationId: subOrgId },
          "[webhooks/stripe] plan-migration realtime notify failed",
        );
      }

      logger.warn(
        { organizationId: subOrgId, fromTier, attemptedTier: targetTier, type },
        "[webhooks/stripe] unknown subscription tier — downgraded to free",
      );
      await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: true, responseStatus: 200 });
      res.json({ received: true, applied: true, tier: "free", migrated: true });
      return;
    } catch (err) {
      logger.error({ err, type, organizationId: subOrgId }, "[webhooks/stripe] subscription handling failed — returning 500 for retry");
      await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: false, responseStatus: 500 });
      res.status(500).json({ received: true, applied: false, error: "subscription handling failed" });
      return;
    }
  }

  // ── Subscription cancellation sync (Task #1309) ─────────────────────────
  // Mirrors the Razorpay `subscription.cancelled` branch in
  // routes/onboarding.ts: when Stripe reports the subscription is gone,
  // downgrade the org back to Free and mark the status cancelled. Without
  // this, a club that cancels via Stripe keeps its paid tier in our DB
  // until somebody notices.
  if (type === "customer.subscription.deleted") {
    const subMeta = (obj["metadata"] as Record<string, unknown> | null | undefined) ?? {};
    const subOrgIdRaw = subMeta["organizationId"];
    const subOrgId = typeof subOrgIdRaw === "string" ? Number.parseInt(subOrgIdRaw, 10)
      : typeof subOrgIdRaw === "number" ? subOrgIdRaw : NaN;

    if (!Number.isFinite(subOrgId) || subOrgId <= 0) {
      await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: false, responseStatus: 200 });
      res.json({ received: true, ignored: true, reason: "subscription event missing organizationId metadata" });
      return;
    }

    try {
      const [org] = await db.select({ id: organizationsTable.id, subscriptionTier: organizationsTable.subscriptionTier })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, subOrgId));
      if (!org) {
        await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: false, responseStatus: 200 });
        res.json({ received: true, ignored: true, reason: "organizationId not found" });
        return;
      }

      const fromTier = org.subscriptionTier as string | null;

      await db.update(organizationsTable)
        .set({
          subscriptionTier: "free",
          subscriptionStatus: "cancelled",
          pendingSubscriptionTier: null,
          updatedAt: new Date(),
        })
        .where(eq(organizationsTable.id, subOrgId));

      // Task #1539 — fan out the realtime super-admin alert when a *paid*
      // tier was cancelled. The unknown-tier branch above already fires the
      // same notify; genuine paid-plan churn is at least as important to
      // surface to ops in real time. We deliberately skip the alert when
      // `fromTier` was already `free` (or null) so deletions of stale free
      // subscriptions don't spam super admins.
      const wasPaid = fromTier === "starter" || fromTier === "pro" || fromTier === "enterprise";
      if (wasPaid) {
        try {
          await notifySuperAdminsOfPlanMigration({
            organizationId: subOrgId,
            fromTier,
            toTier: "free",
            reason: "Stripe subscription cancelled — auto-reset to Free",
            // Task #1906 — paid-plan churn: subject + push title now
            // read "Club cancelled paid plan" so super admins triage
            // it as churn rather than a slug-mapping bug.
            triggerReason: "cancelled",
            req,
          });
        } catch (notifyErr) {
          logger.warn(
            { err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr), organizationId: subOrgId },
            "[webhooks/stripe] subscription-cancelled realtime notify failed",
          );
        }
      }

      logger.info(
        { organizationId: subOrgId, fromTier, alerted: wasPaid },
        "[webhooks/stripe] subscription cancelled — downgraded to free",
      );

      // Task #1540 — confirm the cancellation by email so a club admin
      // who cancelled by mistake (or was billed by Stripe directly) has
      // an audit trail in their inbox. Never throws; failures are
      // logged inside the helper.
      await notifyOrgAdminsOfPlanCancellation({
        orgId: subOrgId,
        source: "stripe",
        previousTier: org.subscriptionTier,
      });

      await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: true, responseStatus: 200 });
      res.json({ received: true, applied: true, tier: "free", status: "cancelled" });
      return;
    } catch (err) {
      logger.error({ err, type, organizationId: subOrgId }, "[webhooks/stripe] subscription cancellation handling failed — returning 500 for retry");
      await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: false, responseStatus: 500 });
      res.status(500).json({ received: true, applied: false, error: "subscription cancellation handling failed" });
      return;
    }
  }

  // ── Subscription past-due sync (Task #1907) ─────────────────────────────
  // Mirrors the Razorpay `subscription.halted` / `payment.failed` branch
  // in routes/onboarding.ts: when Stripe reports an invoice payment
  // failed for a subscription, flip the org to `past_due` and email the
  // admin(s) so they can update their payment method before the next
  // retry. Without this, a club whose card simply expired had no
  // warning before being locked out of paid features.
  //
  // Stripe puts `organizationId` on the *subscription* metadata (see the
  // `customer.subscription.created` branch above). On the
  // `invoice.payment_failed` event the invoice carries the subscription
  // id but its own `metadata` is usually empty — newer Stripe API
  // versions instead expose the subscription's metadata via
  // `invoice.subscription_details.metadata`. Try both, in that order.
  if (type === "invoice.payment_failed") {
    const invMeta = (obj["metadata"] as Record<string, unknown> | null | undefined) ?? {};
    const subDetails = (obj["subscription_details"] as Record<string, unknown> | null | undefined) ?? {};
    const subDetailsMeta = (subDetails["metadata"] as Record<string, unknown> | null | undefined) ?? {};
    const invOrgIdRaw = subDetailsMeta["organizationId"] ?? invMeta["organizationId"];
    const invOrgId = typeof invOrgIdRaw === "string" ? Number.parseInt(invOrgIdRaw, 10)
      : typeof invOrgIdRaw === "number" ? invOrgIdRaw : NaN;

    if (!Number.isFinite(invOrgId) || invOrgId <= 0) {
      await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: false, responseStatus: 200 });
      res.json({ received: true, ignored: true, reason: "invoice event missing organizationId metadata" });
      return;
    }

    try {
      const [org] = await db.select({
        id: organizationsTable.id,
        subscriptionTier: organizationsTable.subscriptionTier,
      })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, invOrgId));
      if (!org) {
        await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: false, responseStatus: 200 });
        res.json({ received: true, ignored: true, reason: "organizationId not found" });
        return;
      }

      await db.update(organizationsTable)
        .set({
          subscriptionStatus: "past_due",
          updatedAt: new Date(),
        })
        .where(eq(organizationsTable.id, invOrgId));

      // Stripe surfaces the underlying decline / failure reason in a
      // few places depending on event flavour:
      //   - `last_finalization_error.message` for finalisation failures,
      //   - `last_payment_error.message` for charge-time failures.
      // Read both, prefer the more specific finalisation error.
      const lastFinalizationErr = (obj["last_finalization_error"] as Record<string, unknown> | null | undefined) ?? null;
      const lastPaymentErr = (obj["last_payment_error"] as Record<string, unknown> | null | undefined) ?? null;
      const finalizationMsg = lastFinalizationErr && typeof lastFinalizationErr["message"] === "string"
        ? (lastFinalizationErr["message"] as string)
        : null;
      const paymentMsg = lastPaymentErr && typeof lastPaymentErr["message"] === "string"
        ? (lastPaymentErr["message"] as string)
        : null;
      const failureReason = (finalizationMsg ?? paymentMsg ?? "").trim() || null;

      await notifyOrgAdminsOfPlanPastDue({
        orgId: invOrgId,
        source: "stripe",
        currentTier: org.subscriptionTier,
        failureReason,
      });

      logger.info(
        { organizationId: invOrgId, tier: org.subscriptionTier },
        "[webhooks/stripe] invoice.payment_failed — org marked past_due",
      );
      await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: true, responseStatus: 200 });
      res.json({ received: true, applied: true, status: "past_due" });
      return;
    } catch (err) {
      logger.error({ err, type, organizationId: invOrgId }, "[webhooks/stripe] invoice.payment_failed handling failed — returning 500 for retry");
      await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: false, responseStatus: 500 });
      res.status(500).json({ received: true, applied: false, error: "invoice.payment_failed handling failed" });
      return;
    }
  }

  // Only react to settlement events. Anything else is acknowledged and
  // ignored so Stripe does not retry.
  if (type !== "checkout.session.completed" && type !== "payment_intent.succeeded") {
    await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: false, responseStatus: 200 });
    res.json({ received: true, ignored: true, reason: `unhandled event ${type ?? "?"}` });
    return;
  }

  // Extract the canonical fields from either event shape.
  const isSession = type === "checkout.session.completed";
  const sessionId = isSession ? String(obj["id"] ?? "") : "";
  const paymentIntentId = isSession
    ? (typeof obj["payment_intent"] === "string" ? (obj["payment_intent"] as string) : "")
    : String(obj["id"] ?? "");
  const amountMinor = Number(
    isSession ? (obj["amount_total"] ?? 0)
              : (obj["amount_received"] ?? obj["amount"] ?? 0),
  );
  const currency = String(obj["currency"] ?? "").toUpperCase();
  const rawMeta = (obj["metadata"] as Record<string, unknown> | null | undefined) ?? {};
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawMeta)) metadata[k] = v == null ? "" : String(v);

  // For checkout sessions, treat `payment_status === "paid"` as the gate.
  // Sessions in `unpaid` status (e.g. async bank debits still settling)
  // are acknowledged but not applied — a follow-up payment_intent.succeeded
  // will land them.
  if (isSession && String(obj["payment_status"] ?? "") !== "paid") {
    await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: false, responseStatus: 200 });
    res.json({ received: true, ignored: true, reason: "session not yet paid" });
    return;
  }

  // Candidate ids the originating row may have stored at creation time.
  const candidateRefs = [sessionId, paymentIntentId].filter((s): s is string => Boolean(s));
  if (candidateRefs.length === 0) {
    await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: false, responseStatus: 200 });
    res.json({ received: true, ignored: true, reason: "no id on event object" });
    return;
  }

  // Settled timestamp: prefer the event timestamp when present.
  const settledAt = typeof event.created === "number" ? new Date(event.created * 1000) : new Date();
  const paymentRef = paymentIntentId || sessionId;
  let appliedAny = false;

  // Metadata-id fallbacks. Stripe propagates Checkout Session metadata to
  // the resulting PaymentIntent automatically, and our Stripe order/session
  // creation paths stamp these keys, so payment_intent.succeeded events
  // arriving before / without a session.completed are still resolvable.
  const metaPlayerId = Number.parseInt(metadata["playerId"] ?? "", 10);
  const metaMemberId = Number.parseInt(metadata["memberId"] ?? "", 10);
  const metaInvoiceId = Number.parseInt(metadata["invoiceId"] ?? "", 10);

  try {
  // ── Tournament players ─────────────────────────────────────────────────
  {
    const playerWhere: SQL[] = [
      inArray(playersTable.razorpayOrderId, candidateRefs),
      inArray(playersTable.razorpayPaymentId, candidateRefs),
    ];
    if (Number.isFinite(metaPlayerId) && metaPlayerId > 0) {
      playerWhere.push(eq(playersTable.id, metaPlayerId));
    }
    const players = await db.select({
      id: playersTable.id,
      tournamentId: playersTable.tournamentId,
      paymentStatus: playersTable.paymentStatus,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      email: playersTable.email,
      userId: playersTable.userId,
    })
      .from(playersTable)
      .where(or(...playerWhere));
    for (const p of players) {
      if (p.paymentStatus === "paid") continue;
      await db.update(playersTable)
        .set({ paymentStatus: "paid", razorpayPaymentId: paymentRef, razorpayOrderId: null })
        .where(eq(playersTable.id, p.id));
      const [tour] = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name, entryFee: tournamentsTable.entryFee, organizationId: tournamentsTable.organizationId, currency: tournamentsTable.currency })
        .from(tournamentsTable).where(eq(tournamentsTable.id, p.tournamentId));
      if (tour && currency && amountMinor > 0) {
        await recordCheckoutSettlement({
          organizationId: tour.organizationId,
          processor: "stripe",
          settledCurrency: currency,
          settledAmount: amountMinor / 100,
          paymentRef,
          sourceType: "tournament_entry",
          sourceId: p.id,
          settledAt,
        });
      }
      // Mirror the Razorpay verify path: receipt email + outbound webhook event.
      // Best-effort — failures must not abort settlement reconciliation.
      if (tour) {
        try {
          const [tourOrg] = await db.select({ id: organizationsTable.id, name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
            .from(organizationsTable).where(eq(organizationsTable.id, tour.organizationId));
          if (p.email) {
            const settledMinor = amountMinor > 0 ? amountMinor : Math.round(parseFloat(tour.entryFee ?? "0") * 100);
            const settledCurrencyForEmail = currency || tour.currency;
            // Task #1319 — include `orgId` in branding so the Postmark
            // bounce webhook (Task #981) can attribute hard bounces of
            // tournament receipts back to this club without a fallback scan.
            await sendReceiptEmail({
              email: p.email, name: `${p.firstName} ${p.lastName}`,
              eventName: tour.name, eventType: "tournament",
              amountSubunit: settledMinor,
              currency: settledCurrencyForEmail,
              paymentId: paymentRef,
              entityId: p.id,
              receiptBaseUrl: process.env.API_BASE_URL ?? process.env.RAZORPAY_CALLBACK_URL?.replace(/\/payments\/callback.*/, "") ?? "",
              branding: tourOrg
                ? { orgName: tourOrg.name, logoUrl: tourOrg.logoUrl ?? undefined, primaryColor: tourOrg.primaryColor ?? undefined, orgId: tourOrg.id }
                : { orgId: tour.organizationId },
            });
          }
          dispatchWebhookEvent(tour.organizationId, "payment.received", {
            playerId: p.id,
            tournamentId: tour.id,
            playerName: `${p.firstName} ${p.lastName}`,
            email: p.email,
            eventName: tour.name,
            eventType: "tournament",
            amount: amountMinor > 0 ? amountMinor / 100 : parseFloat(tour.entryFee ?? "0"),
            currency: currency || tour.currency,
            paymentId: paymentRef,
          });
        } catch (notifyErr) {
          logger.warn({ err: notifyErr, playerId: p.id }, "[webhooks/stripe] tournament player notification failed");
        }
        // In-app push to the paying player (Task #832). Kept in its own
        // try/catch so an SMTP/webhook outage above can never suppress it.
        try {
          const pushAmountMinor = amountMinor > 0 ? amountMinor : Math.round(parseFloat(tour.entryFee ?? "0") * 100);
          await notifyPaymentSettled({
            userId: p.userId,
            kind: "tournament",
            eventName: tour.name,
            amountMinor: pushAmountMinor,
            currency: currency || tour.currency,
            paymentRef,
            organizationId: tour.organizationId,
            entityId: tour.id,
          });
        } catch (pushErr) {
          logger.warn({ err: pushErr, playerId: p.id }, "[webhooks/stripe] tournament player push failed");
        }
      }
      appliedAny = true;
      logger.info({ playerId: p.id, paymentRef, type }, "[webhooks/stripe] tournament player marked paid");
    }
  }

  // ── League members ─────────────────────────────────────────────────────
  {
    const memberWhere: SQL[] = [
      inArray(leagueMembersTable.razorpayOrderId, candidateRefs),
      inArray(leagueMembersTable.razorpayPaymentId, candidateRefs),
    ];
    if (Number.isFinite(metaMemberId) && metaMemberId > 0) {
      memberWhere.push(eq(leagueMembersTable.id, metaMemberId));
    }
    const members = await db.select({
      id: leagueMembersTable.id,
      leagueId: leagueMembersTable.leagueId,
      paymentStatus: leagueMembersTable.paymentStatus,
      firstName: leagueMembersTable.firstName,
      lastName: leagueMembersTable.lastName,
      email: leagueMembersTable.email,
      userId: leagueMembersTable.userId,
    })
      .from(leagueMembersTable)
      .where(or(...memberWhere));
    for (const m of members) {
      if (m.paymentStatus === "paid") continue;
      await db.update(leagueMembersTable)
        .set({ paymentStatus: "paid", razorpayPaymentId: paymentRef, razorpayOrderId: null })
        .where(eq(leagueMembersTable.id, m.id));
      const [lg] = await db.select({ id: leaguesTable.id, name: leaguesTable.name, entryFee: leaguesTable.entryFee, organizationId: leaguesTable.organizationId, currency: leaguesTable.currency })
        .from(leaguesTable).where(eq(leaguesTable.id, m.leagueId));
      if (lg && currency && amountMinor > 0) {
        await recordCheckoutSettlement({
          organizationId: lg.organizationId,
          processor: "stripe",
          settledCurrency: currency,
          settledAmount: amountMinor / 100,
          paymentRef,
          sourceType: "league_entry",
          sourceId: m.id,
          settledAt,
        });
      }
      // Mirror the Razorpay verify path: receipt email + outbound webhook event.
      if (lg) {
        try {
          const [leagueOrg] = await db.select({ id: organizationsTable.id, name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
            .from(organizationsTable).where(eq(organizationsTable.id, lg.organizationId));
          if (m.email) {
            const settledMinor = amountMinor > 0 ? amountMinor : Math.round(parseFloat(lg.entryFee ?? "0") * 100);
            const settledCurrencyForEmail = currency || lg.currency;
            // Task #1319 — see tournament-receipt branch above; ensures
            // league receipt bounces are tagged back to the club.
            await sendReceiptEmail({
              email: m.email, name: `${m.firstName} ${m.lastName}`,
              eventName: lg.name, eventType: "league",
              amountSubunit: settledMinor,
              currency: settledCurrencyForEmail,
              paymentId: paymentRef,
              entityId: m.id,
              receiptBaseUrl: process.env.API_BASE_URL ?? process.env.RAZORPAY_CALLBACK_URL?.replace(/\/payments\/callback.*/, "") ?? "",
              branding: leagueOrg
                ? { orgName: leagueOrg.name, logoUrl: leagueOrg.logoUrl ?? undefined, primaryColor: leagueOrg.primaryColor ?? undefined, orgId: leagueOrg.id }
                : { orgId: lg.organizationId },
            });
          }
          dispatchWebhookEvent(lg.organizationId, "payment.received", {
            memberId: m.id,
            leagueId: lg.id,
            playerName: `${m.firstName} ${m.lastName}`,
            email: m.email,
            eventName: lg.name,
            eventType: "league",
            amount: amountMinor > 0 ? amountMinor / 100 : parseFloat(lg.entryFee ?? "0"),
            currency: currency || lg.currency,
            paymentId: paymentRef,
          });
        } catch (notifyErr) {
          logger.warn({ err: notifyErr, memberId: m.id }, "[webhooks/stripe] league member notification failed");
        }
        // In-app push to the paying league member (Task #832). Independent
        // try/catch so the email/webhook path above cannot suppress it.
        try {
          const pushAmountMinor = amountMinor > 0 ? amountMinor : Math.round(parseFloat(lg.entryFee ?? "0") * 100);
          await notifyPaymentSettled({
            userId: m.userId,
            kind: "league",
            eventName: lg.name,
            amountMinor: pushAmountMinor,
            currency: currency || lg.currency,
            paymentRef,
            organizationId: lg.organizationId,
            entityId: lg.id,
          });
        } catch (pushErr) {
          logger.warn({ err: pushErr, memberId: m.id }, "[webhooks/stripe] league member push failed");
        }
      }
      appliedAny = true;
      logger.info({ memberId: m.id, paymentRef, type }, "[webhooks/stripe] league member marked paid");
    }
  }

  // ── Shop orders (cart-level binding via the shared razorpayOrderId field) ─
  {
    const orders = await db.select({
      id: shopOrdersTable.id,
      organizationId: shopOrdersTable.organizationId,
      status: shopOrdersTable.status,
      currency: shopOrdersTable.currency,
      totalAmount: shopOrdersTable.totalAmount,
      productId: shopOrdersTable.productId,
      quantity: shopOrdersTable.quantity,
      size: shopOrdersTable.size,
      customerName: shopOrdersTable.customerName,
      customerEmail: shopOrdersTable.customerEmail,
      userId: shopOrdersTable.userId,
    })
      .from(shopOrdersTable)
      .where(or(
        inArray(shopOrdersTable.razorpayOrderId, candidateRefs),
        inArray(shopOrdersTable.razorpayPaymentId, candidateRefs),
      ));
    let recordedFxForOrgs = new Set<number>();
    const newlyPaid: typeof orders = [];
    for (const o of orders) {
      if (o.status !== "pending") continue;
      await db.update(shopOrdersTable)
        .set({ status: "paid", razorpayPaymentId: paymentRef, paymentMode: "stripe", updatedAt: new Date() })
        .where(eq(shopOrdersTable.id, o.id));
      appliedAny = true;
      newlyPaid.push(o);
      // Record FX once per org per event — multiple shop_orders rows can share
      // a single cart payment, but the settlement is the cart total.
      if (currency && amountMinor > 0 && !recordedFxForOrgs.has(o.organizationId)) {
        await recordCheckoutSettlement({
          organizationId: o.organizationId,
          processor: "stripe",
          settledCurrency: currency,
          settledAmount: amountMinor / 100,
          paymentRef,
          sourceType: "shop_order",
          sourceId: paymentRef,
          settledAt,
        });
        recordedFxForOrgs.add(o.organizationId);
      }
      logger.info({ orderId: o.id, paymentRef, type }, "[webhooks/stripe] shop order marked paid");
    }
    // Order-confirmation email — one per buyer/org grouping, mirroring the
    // Razorpay verify-cart path. Best-effort.
    if (newlyPaid.length > 0) {
      // Group buyers by org + (userId or customerEmail). Bucketing on
      // userId when present keeps the push reaching the shopper even if
      // their cart had no email on file.
      const groups = new Map<string, typeof newlyPaid>();
      for (const o of newlyPaid) {
        const buyerKey = o.userId ? `u:${o.userId}` : `e:${(o.customerEmail ?? "").toLowerCase()}`;
        const key = `${o.organizationId}|${buyerKey}`;
        const arr = groups.get(key) ?? [];
        arr.push(o);
        groups.set(key, arr);
      }
      for (const group of groups.values()) {
        const first = group[0]!;
        const totalForBuyer = group.reduce((s, o) => s + parseFloat(String(o.totalAmount ?? "0")), 0);
        // Branding lookup is shared by both the email and push paths.
        let orgName = "Club Shop";
        // Task #1319 — also remember `id` from the org row so the receipt
        // email below can include `branding.orgId` and bounces tag back to
        // this club via the Postmark webhook (Task #981).
        let orgBranding: { id?: number; logoUrl?: string | null; primaryColor?: string | null } = {};
        try {
          const [org] = await db.select({ id: organizationsTable.id, name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
            .from(organizationsTable).where(eq(organizationsTable.id, first.organizationId));
          orgName = org?.name ?? orgName;
          orgBranding = { id: org?.id, logoUrl: org?.logoUrl, primaryColor: org?.primaryColor };
        } catch (err) {
          logger.warn({ err, paymentRef }, "[webhooks/stripe] shop org branding lookup failed");
        }

        // Order-confirmation email with PDF receipt — only when we have
        // a delivery address. Best-effort.
        if (first.customerEmail) {
          try {
            const lineItems: Array<{ description: string; quantity: number; totalAmountSubunit: number }> = [];
            for (const o of group) {
              const [product] = await db.select({ name: shopProductsTable.name })
                .from(shopProductsTable).where(eq(shopProductsTable.id, o.productId));
              const label = product?.name ?? `Item #${o.id}`;
              const sizeLabel = o.size ? ` (${o.size})` : "";
              lineItems.push({
                description: `${label}${sizeLabel}`,
                quantity: o.quantity,
                totalAmountSubunit: Math.round(parseFloat(String(o.totalAmount ?? "0")) * 100),
              });
            }
            const totalSubunit = lineItems.reduce((s, li) => s + li.totalAmountSubunit, 0);
            await sendShopOrderReceiptEmail({
              email: first.customerEmail,
              buyerName: first.customerName ?? "",
              orderId: first.id,
              lineItems,
              totalSubunit,
              currency: first.currency || "INR",
              paymentId: paymentRef,
              paidAt: settledAt,
              branding: { orgName, logoUrl: orgBranding.logoUrl ?? undefined, primaryColor: orgBranding.primaryColor ?? undefined, orgId: orgBranding.id ?? first.organizationId },
            });
          } catch (notifyErr) {
            logger.warn({ err: notifyErr, paymentRef }, "[webhooks/stripe] shop order confirmation failed");
          }
        }

        // In-app push to the shopper (Task #832). Independent from email
        // delivery so a buyer with a userId but no email still gets it.
        if (first.userId) {
          try {
            const totalMinor = Math.round(totalForBuyer * 100);
            await notifyPaymentSettled({
              userId: first.userId,
              kind: "shop",
              eventName: orgName,
              amountMinor: totalMinor,
              currency: first.currency || currency || "INR",
              paymentRef,
              organizationId: first.organizationId,
              entityId: first.id,
            });
          } catch (pushErr) {
            logger.warn({ err: pushErr, paymentRef }, "[webhooks/stripe] shop order push failed");
          }
        }
      }
    }
  }

  // ── Member dues invoices (Stripe checkout session id stored on
  //    razorpayPaymentLinkId at creation) ────────────────────────────────
  {
    const invoices = await db.select({
      id: memberInvoicesTable.id,
      invoiceNumber: memberInvoicesTable.invoiceNumber,
      organizationId: memberInvoicesTable.organizationId,
      clubMemberId: memberInvoicesTable.clubMemberId,
      status: memberInvoicesTable.status,
      currency: memberInvoicesTable.currency,
      totalAmount: memberInvoicesTable.totalAmount,
    })
      .from(memberInvoicesTable)
      .where(or(
        inArray(memberInvoicesTable.razorpayPaymentLinkId, candidateRefs),
        inArray(memberInvoicesTable.razorpayPaymentId, candidateRefs),
        ...(Number.isFinite(metaInvoiceId) && metaInvoiceId > 0
          ? [eq(memberInvoicesTable.id, metaInvoiceId)]
          : []),
      ));
    for (const inv of invoices) {
      if (inv.status === "paid") continue;
      // Idempotency guard: a duplicate event delivery (or a session.completed
      // arriving after a payment_intent.succeeded for the same payment) must
      // not insert a second dues_payments row for the same paymentRef.
      const existing = await db.select({ id: duesPaymentsTable.id })
        .from(duesPaymentsTable)
        .where(and(
          eq(duesPaymentsTable.invoiceId, inv.id),
          eq(duesPaymentsTable.razorpayPaymentId, paymentRef),
        ))
        .limit(1);
      if (existing.length === 0) {
        await db.insert(duesPaymentsTable).values({
          invoiceId: inv.id,
          organizationId: inv.organizationId,
          amount: inv.totalAmount,
          currency: inv.currency,
          method: "online",
          razorpayPaymentId: paymentRef,
          paidAt: settledAt,
        });
      }
      await db.update(memberInvoicesTable).set({
        status: "paid",
        paidAmount: inv.totalAmount,
        paidAt: settledAt,
        paymentMethod: "online",
        razorpayPaymentId: paymentRef,
        updatedAt: new Date(),
      }).where(eq(memberInvoicesTable.id, inv.id));
      // Reactivate member if they were in past_due
      await db.update(clubMembersTable).set({ subscriptionStatus: "active", updatedAt: new Date() })
        .where(and(eq(clubMembersTable.id, inv.clubMemberId), eq(clubMembersTable.subscriptionStatus, "past_due")));
      if (currency && amountMinor > 0) {
        await recordCheckoutSettlement({
          organizationId: inv.organizationId,
          processor: "stripe",
          settledCurrency: currency,
          settledAmount: amountMinor / 100,
          paymentRef,
          sourceType: "dues_invoice",
          sourceId: inv.id,
          settledAt,
        });
      }
      // Receipt email (with PDF attachment) + push are gated by the status
      // flip above so duplicate webhook deliveries cannot resend. Look up
      // the member + org once for both paths.
      let memberRow: { firstName: string | null; lastName: string | null; email: string | null; userId: number | null } | undefined;
      let orgName = "Your Club";
      // Task #1319 — keep the org id alongside the visual branding so the
      // dues receipt email below carries `branding.orgId` and bounces can
      // be tagged back to the club via the Postmark webhook (Task #981).
      let orgBranding: { id?: number; logoUrl?: string | null; primaryColor?: string | null } = {};
      try {
        const [m] = await db.select({
          firstName: clubMembersTable.firstName,
          lastName: clubMembersTable.lastName,
          email: clubMembersTable.email,
          userId: clubMembersTable.userId,
        }).from(clubMembersTable).where(eq(clubMembersTable.id, inv.clubMemberId));
        memberRow = m;
        const [org] = await db.select({ id: organizationsTable.id, name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
          .from(organizationsTable).where(eq(organizationsTable.id, inv.organizationId));
        orgName = org?.name ?? orgName;
        orgBranding = { id: org?.id, logoUrl: org?.logoUrl, primaryColor: org?.primaryColor };
      } catch (lookupErr) {
        logger.warn({ err: lookupErr, invoiceId: inv.id }, "[webhooks/stripe] dues member/org lookup failed");
      }

      // Dues receipt email + PDF attachment — best-effort, isolated from
      // the push path.
      if (memberRow?.email) {
        try {
          const totalSubunit = Math.round(parseFloat(String(inv.totalAmount ?? "0")) * 100);
          await sendDuesReceiptEmail({
            email: memberRow.email,
            memberName: `${memberRow.firstName ?? ""} ${memberRow.lastName ?? ""}`.trim(),
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            lineItems: [{ description: `Membership dues — ${inv.invoiceNumber}`, quantity: 1, totalAmountSubunit: totalSubunit }],
            totalSubunit,
            currency: inv.currency || "INR",
            paymentId: paymentRef,
            paidAt: settledAt,
            branding: { orgName, logoUrl: orgBranding.logoUrl ?? undefined, primaryColor: orgBranding.primaryColor ?? undefined, orgId: orgBranding.id ?? inv.organizationId },
          });
        } catch (notifyErr) {
          logger.warn({ err: notifyErr, invoiceId: inv.id }, "[webhooks/stripe] dues invoice receipt email failed");
        }
      }

      // In-app push to the dues-paying member (Task #832). Independent
      // try/catch so an SMTP outage above cannot suppress it.
      try {
        const pushAmountMinor = amountMinor > 0
          ? amountMinor
          : Math.round(parseFloat(String(inv.totalAmount ?? "0")) * 100);
        await notifyPaymentSettled({
          userId: memberRow?.userId ?? null,
          kind: "dues",
          eventName: orgName,
          amountMinor: pushAmountMinor,
          currency: currency || inv.currency || "INR",
          paymentRef,
          organizationId: inv.organizationId,
          entityId: inv.id,
        });
      } catch (pushErr) {
        logger.warn({ err: pushErr, invoiceId: inv.id }, "[webhooks/stripe] dues invoice push failed");
      }
      appliedAny = true;
      logger.info({ invoiceId: inv.id, paymentRef, type }, "[webhooks/stripe] dues invoice marked paid");
    }
  }

  if (!appliedAny) {
    logger.info({ type, paymentRef, sessionId, metadata }, "[webhooks/stripe] no matching row — event ignored");
  }

  // Wave 0 / Task #935 — analytics smoke test (5/5: payment_settled).
  // Only fire when we actually applied a settlement (not for ignored events,
  // not for the test events emitted by the admin probe — they don't apply).
  if (appliedAny) {
    void track("payment_settled", {
      processor: "stripe",
      eventType: type,
      paymentRef,
      sessionId,
      amountMinor,
      currency,
      hasMetadataPlayerId: Number.isFinite(metaPlayerId) && metaPlayerId > 0,
      hasMetadataMemberId: Number.isFinite(metaMemberId) && metaMemberId > 0,
      hasMetadataInvoiceId: Number.isFinite(metaInvoiceId) && metaInvoiceId > 0,
    }, {
      surface: "system",
    });
  }

  await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: appliedAny, responseStatus: 200 });
  res.status(200).json({ received: true, applied: appliedAny });
  } catch (err) {
    // Reconciliation failed mid-event. Surface a 5xx so Stripe retries —
    // every step is idempotent (status-gated updates), so a retry is safe.
    logger.error({ err, type, paymentRef, sessionId }, "[webhooks/stripe] reconciliation failed — returning 500 for Stripe retry");
    await recordDelivery({ eventId: event.id ?? earlyEventId, eventType: type ?? earlyEventType, signatureValid, applied: false, responseStatus: 500, errorReason: "reconciliation_failed" });
    res.status(500).json({ received: true, applied: false, error: "reconciliation failed" });
  }
});

// ── POST /api/webhooks/postmark ───────────────────────────────────────────────
//
// Postmark posts bounce, spam-complaint and subscription-change events here.
// Authenticated with HTTP Basic Auth — set `POSTMARK_WEBHOOK_USER` and
// `POSTMARK_WEBHOOK_PASSWORD` in the env, then configure the same credentials
// in the Postmark dashboard's webhook URL (or `Authorization: Basic ...`
// header). In production we fail closed when credentials are missing; in
// development we log a warning and accept the request so local-dev signing
// curls work.
//
// On hard bounces, spam complaints, and unsubscribes, we add the recipient
// to `email_suppressions` so future sends skip them. We attribute the event
// to an org via, in order:
//   1. `Metadata.orgId` from the original send (forwarded by the adapter).
//   2. The most recent `campaign_recipients` row for that email.
//   3. Every org the user is currently a member of.
// This same suppressions list is what powers the admin UI under
// /organizations/:orgId/marketing/suppressions (Task #116).
//
// Task #1310 — also persist the *source* of the bouncing send so the
// Suppressions tab can link straight back to the offending campaign or
// flow. Sources come from Postmark's Metadata/Tag fields:
//   - `Metadata.campaignId` (number) → marketing campaign id (FK link).
//   - `Metadata.flow` (string)        → transactional flow tag, e.g.
//                                       "dues_receipt", "password_reset".
//   - falls back to `Tag` when Metadata.flow is absent (legacy sends).
// Both are stored on the suppression row as `triggered_by_campaign_id`
// and `triggered_by_flow`. When `Metadata.campaignId` resolves to a
// campaign owned by the resolved org, that campaign is recorded; if the
// campaign belongs to a different org we still keep the flow tag but
// drop the FK to avoid cross-org leakage in the admin UI.
//
// Reference: https://postmarkapp.com/developer/webhooks/bounce-webhook

interface PostmarkWebhookPayload {
  RecordType?: string;        // "Bounce" | "SpamComplaint" | "SubscriptionChange"
  Type?: string;              // bounce sub-type for Bounce records
  TypeCode?: number;
  Email?: string;             // bounce / spam complaint
  EmailAddress?: string;      // SubscriptionChange uses this field
  SuppressSending?: boolean;  // SubscriptionChange — true means the user opted out
  Recipient?: string;
  MessageID?: string;
  Tag?: string;
  // Postmark sends a one-line human-readable summary on bounce events.
  Description?: string;
  // Detail string from the receiving server (SMTP error text).
  Details?: string;
  Metadata?: Record<string, string | number>;
}

// Map Postmark Type → friendly fallback description if Postmark didn't send one.
const POSTMARK_TYPE_DESCRIPTIONS: Record<string, string> = {
  hardbounce: "The recipient's mail server permanently rejected the message.",
  badmailbox: "The recipient's mailbox does not exist.",
  blocked: "The receiving server blocked the message (often spam-related).",
  spamnotification: "The receiving server reported this message as spam.",
  spamcomplaint: "The recipient marked this message as spam.",
  manuallydeactivated: "Postmark manually deactivated this address.",
  unsubscribe: "The recipient unsubscribed from this stream.",
  transient: "Temporary delivery failure — the recipient's server may retry.",
  softbounce: "Temporary delivery failure — the recipient's server may retry.",
  dnserror: "DNS lookup failed for the recipient's domain.",
  smtpapifailure: "Postmark could not deliver the message via SMTP.",
};

function buildSuppressionDescription(payload: PostmarkWebhookPayload, reason: string): string | null {
  // Prefer Postmark's own description, then fall back to the SMTP details,
  // then to a canned message keyed off Type, then to the reason category.
  const trim = (s: unknown): string | null => {
    if (typeof s !== "string") return null;
    const t = s.trim();
    if (!t) return null;
    return t.length > 500 ? `${t.slice(0, 497)}…` : t;
  };
  const fromPostmark = trim(payload.Description) ?? trim(payload.Details);
  if (fromPostmark) return fromPostmark;
  const t = (payload.Type ?? "").toLowerCase();
  if (t && POSTMARK_TYPE_DESCRIPTIONS[t]) return POSTMARK_TYPE_DESCRIPTIONS[t];
  if (reason === "spam_complaint") return "The recipient marked this message as spam.";
  if (reason === "unsubscribed") return "The recipient unsubscribed from this stream.";
  if (reason === "bounced") return "The recipient's mail server rejected the message.";
  return null;
}

function parseOrgIdFromMetadata(meta: Record<string, string | number> | undefined): number | null {
  if (!meta) return null;
  const raw = meta.orgId ?? meta.organizationId;
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Task #1310 — pull the originating marketing campaign id from the
 * Postmark Metadata block. Returns a positive integer or null.
 */
function parseCampaignIdFromMetadata(meta: Record<string, string | number> | undefined): number | null {
  if (!meta) return null;
  const raw = meta.campaignId ?? meta.campaign_id;
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Task #1555 — pull the originating template id from the Postmark
 * Metadata block. Mirrors `parseCampaignIdFromMetadata`. The caller
 * MUST verify org-ownership against `email_templates_marketing`
 * before persisting the id (defence in depth — the id arrives via
 * an external HTTP request and could be forged or stale).
 */
function parseTemplateIdFromMetadata(meta: Record<string, string | number> | undefined): number | null {
  if (!meta) return null;
  const raw = meta.templateId ?? meta.template_id;
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Task #1310 — derive the transactional flow tag for a bounce. Prefers
 * `Metadata.flow` (set via mailer.flowHints) and falls back to `Tag`
 * for older sends that only carried a Postmark Tag. Trimmed to a
 * sensible upper bound so a malformed Tag can't blow out the column.
 */
function parseFlowFromPayload(payload: PostmarkWebhookPayload): string | null {
  const candidates = [payload.Metadata?.flow, payload.Tag];
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
  }
  return null;
}

async function resolveOrgIdsForEmail(email: string, payload: PostmarkWebhookPayload): Promise<number[]> {
  const fromMeta = parseOrgIdFromMetadata(payload.Metadata);
  if (fromMeta !== null) return [fromMeta];

  const lower = email.toLowerCase();
  // Every org that has recently sent this address a marketing campaign.
  // We intentionally suppress in *all* of them on a hard bounce / complaint
  // — once an address is bad, it is bad for everyone.
  const recip = await db
    .select({ campaignId: campaignRecipientsTable.campaignId })
    .from(campaignRecipientsTable)
    .where(eq(campaignRecipientsTable.email, lower))
    .orderBy(desc(campaignRecipientsTable.id))
    .limit(50);
  if (recip.length > 0) {
    const campaignIds = Array.from(new Set(recip.map(r => r.campaignId)));
    const camps = await db
      .select({ organizationId: marketingCampaignsTable.organizationId })
      .from(marketingCampaignsTable)
      .where(inArray(marketingCampaignsTable.id, campaignIds));
    const orgIds = Array.from(new Set(camps.map(c => c.organizationId)));
    if (orgIds.length > 0) return orgIds;
  }

  // Fall back to every org this user is a member of.
  const userRows = await db
    .select({ id: appUsersTable.id })
    .from(appUsersTable)
    .where(eq(appUsersTable.email, email));
  if (userRows.length === 0) return [];
  const userIds = userRows.map(u => u.id);
  const memberships = await db
    .select({ organizationId: orgMembershipsTable.organizationId })
    .from(orgMembershipsTable)
    .where(inArray(orgMembershipsTable.userId, userIds));
  return Array.from(new Set(memberships.map(m => m.organizationId)));
}

router.post("/postmark", async (req: Request, res: Response) => {
  const expectedUser = process.env.POSTMARK_WEBHOOK_USER;
  const expectedPass = process.env.POSTMARK_WEBHOOK_PASSWORD;
  const isDev = process.env.NODE_ENV === "development";

  if (!expectedUser || !expectedPass) {
    if (!isDev) {
      logger.error("[webhooks/postmark] POSTMARK_WEBHOOK_USER/PASSWORD not configured; rejecting webhook");
      res.status(503).json({ error: "Webhook endpoint not configured" });
      return;
    }
    logger.warn("[webhooks/postmark] Basic-auth credentials not set — skipping verification (development only)");
  } else {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Basic ")) {
      logger.warn("[webhooks/postmark] Missing Basic auth header");
      res.status(401).json({ error: "Missing credentials" });
      return;
    }
    let decoded = "";
    try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch { /* malformed */ }
    const [user, ...passParts] = decoded.split(":");
    const pass = passParts.join(":");
    const userOk = safeTimingEqual(Buffer.from(user || ""), Buffer.from(expectedUser));
    const passOk = safeTimingEqual(Buffer.from(pass || ""), Buffer.from(expectedPass));
    if (!userOk || !passOk) {
      logger.warn("[webhooks/postmark] Basic auth credential mismatch");
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
  }

  const payload = (req.body ?? {}) as PostmarkWebhookPayload;
  const recordType = payload.RecordType;
  const recipientEmail =
    (typeof payload.Email === "string" && payload.Email)
      || (typeof payload.EmailAddress === "string" && payload.EmailAddress)
      || (typeof payload.Recipient === "string" && payload.Recipient)
      || "";

  if (!recipientEmail) {
    logger.warn({ recordType }, "[webhooks/postmark] No recipient email on payload — acking and skipping");
    res.json({ received: true, applied: false });
    return;
  }

  // Decide whether this event should suppress future sends.
  let reason: string | null = null;
  if (recordType === "SpamComplaint") {
    reason = "spam_complaint";
  } else if (recordType === "SubscriptionChange") {
    if (payload.SuppressSending === true) {
      reason = "unsubscribed";
    } else if (payload.SuppressSending === false) {
      // Explicit re-enable from the SubscriptionChange channel — clear any
      // existing suppression for the resolved org(s).
      try {
        const lower = recipientEmail.toLowerCase();
        const orgIds = await resolveOrgIdsForEmail(recipientEmail, payload);
        if (orgIds.length > 0) {
          await db.delete(emailSuppressionsTable).where(and(
            inArray(emailSuppressionsTable.organizationId, orgIds),
            eq(emailSuppressionsTable.email, lower),
          ));
          logger.info({ email: lower, orgIds }, "[webhooks/postmark] Resubscribe — suppressions cleared");
        }
        res.json({ received: true, applied: true, resubscribed: true });
        return;
      } catch (err) {
        logger.error({ err, email: recipientEmail }, "[webhooks/postmark] Failed to clear suppressions on resubscribe");
        res.status(500).json({ received: true, applied: false, error: "internal error" });
        return;
      }
    }
  } else if (recordType === "Bounce") {
    // Only persistent / hard bounces should suppress. Transient bounces will
    // retry on their own — Postmark uses the `Type` field for these.
    const t = (payload.Type || "").toLowerCase();
    const isHard = t === "hardbounce" || t === "badmailbox" || t === "manuallydeactivated"
      || t === "spamnotification" || t === "spamcomplaint" || t === "blocked"
      || t === "unsubscribe";
    if (isHard) {
      reason = t === "unsubscribe" ? "unsubscribed" : "bounced";
    }
    // `Subscribe` events (the inverse of unsubscribe) explicitly do NOT
    // suppress — clear any existing suppressions instead.
    if (t === "subscribe") {
      try {
        const lower = recipientEmail.toLowerCase();
        const orgIds = await resolveOrgIdsForEmail(recipientEmail, payload);
        if (orgIds.length > 0) {
          await db.delete(emailSuppressionsTable).where(and(
            inArray(emailSuppressionsTable.organizationId, orgIds),
            eq(emailSuppressionsTable.email, lower),
          ));
          logger.info({ email: lower, orgIds }, "[webhooks/postmark] Resubscribe — suppressions cleared");
        }
        res.json({ received: true, applied: true, resubscribed: true });
        return;
      } catch (err) {
        logger.error({ err, email: recipientEmail }, "[webhooks/postmark] Failed to clear suppressions on resubscribe");
        res.status(500).json({ received: true, applied: false, error: "internal error" });
        return;
      }
    }
  }

  if (!reason) {
    logger.info({ recordType, type: payload.Type, email: recipientEmail }, "[webhooks/postmark] Event acked, no suppression");
    res.json({ received: true, applied: false });
    return;
  }

  try {
    const orgIds = await resolveOrgIdsForEmail(recipientEmail, payload);
    if (orgIds.length === 0) {
      logger.info({ email: recipientEmail, reason }, "[webhooks/postmark] No org could be resolved — acking without suppression");
      res.json({ received: true, applied: false });
      return;
    }
    const lower = recipientEmail.toLowerCase();
    const bounceType = typeof payload.Type === "string" && payload.Type ? payload.Type : null;
    const messageId = typeof payload.MessageID === "string" && payload.MessageID ? payload.MessageID : null;
    const description = buildSuppressionDescription(payload, reason);
    // Task #1310 — record the originating send. The campaign id is only
    // attached to suppressions in the org that owns the campaign so we
    // never link to a campaign the admin can't see.
    const triggeredByFlow = parseFlowFromPayload(payload);
    const candidateCampaignId = parseCampaignIdFromMetadata(payload.Metadata);
    let campaignOwnerOrgId: number | null = null;
    if (candidateCampaignId !== null) {
      const ownerRows = await db
        .select({ organizationId: marketingCampaignsTable.organizationId })
        .from(marketingCampaignsTable)
        .where(eq(marketingCampaignsTable.id, candidateCampaignId))
        .limit(1);
      campaignOwnerOrgId = ownerRows[0]?.organizationId ?? null;
    }
    // Task #1555 — same defence-in-depth check for the template id.
    // Allow linking when the template belongs to the resolved org OR
    // is a global template (`is_global=true`, `organization_id` may
    // be null). Any other case (unknown id, owned by a different org)
    // silently drops the link — we still record the suppression, just
    // without the template attribution, so a forged Metadata field
    // can never expose another org's template.
    const candidateTemplateId = parseTemplateIdFromMetadata(payload.Metadata);
    let templateOwnerOrgId: number | null = null;
    let templateIsGlobal = false;
    let templateExists = false;
    if (candidateTemplateId !== null) {
      const tplRows = await db
        .select({
          organizationId: emailTemplatesMarketingTable.organizationId,
          isGlobal: emailTemplatesMarketingTable.isGlobal,
        })
        .from(emailTemplatesMarketingTable)
        .where(eq(emailTemplatesMarketingTable.id, candidateTemplateId))
        .limit(1);
      if (tplRows[0]) {
        templateExists = true;
        templateOwnerOrgId = tplRows[0].organizationId ?? null;
        templateIsGlobal = tplRows[0].isGlobal === true;
      }
    }
    let inserted = 0;
    let persistedCampaignId: number | null = null;
    let persistedTemplateId: number | null = null;
    // Task #1927 — collect (orgId, suppressionId) pairs so we can fan out
    // a one-shot "re-bounced after re-enable" email to the actor admin
    // *after* the upsert loop. We do this outside the upsert so a slow
    // notify path can never delay (or fail) the suppression write that
    // protects future sends.
    const upsertedRows: Array<{ orgId: number; suppressionId: number }> = [];
    for (const orgId of orgIds) {
      const triggeredByCampaignId = candidateCampaignId !== null && campaignOwnerOrgId === orgId
        ? candidateCampaignId
        : null;
      if (triggeredByCampaignId !== null) persistedCampaignId = triggeredByCampaignId;
      const triggeredByTemplateId = candidateTemplateId !== null && templateExists
        && (templateIsGlobal || templateOwnerOrgId === orgId)
        ? candidateTemplateId
        : null;
      if (triggeredByTemplateId !== null) persistedTemplateId = triggeredByTemplateId;
      // On a duplicate (org+email), keep the original row but refresh the
      // bounce metadata so admins always see the *latest* failure detail.
      const result = await db.insert(emailSuppressionsTable).values({
        organizationId: orgId,
        email: lower,
        reason,
        bounceType,
        messageId,
        description,
        triggeredByCampaignId,
        triggeredByFlow,
        triggeredByTemplateId,
      }).onConflictDoUpdate({
        target: [emailSuppressionsTable.organizationId, emailSuppressionsTable.email],
        set: { reason, bounceType, messageId, description, triggeredByCampaignId, triggeredByFlow, triggeredByTemplateId },
      }).returning({ id: emailSuppressionsTable.id });
      if (result.length > 0) {
        inserted += 1;
        const suppressionId = result[0]?.id;
        if (typeof suppressionId === "number") {
          upsertedRows.push({ orgId, suppressionId });
        }
      }
    }
    logger.info({
      email: lower,
      reason,
      orgIds,
      inserted,
      claimedCampaignId: candidateCampaignId,
      triggeredByCampaignId: persistedCampaignId,
      triggeredByFlow,
      claimedTemplateId: candidateTemplateId,
      triggeredByTemplateId: persistedTemplateId,
    }, "[webhooks/postmark] Suppression(s) recorded");

    // Task #1927 — fan out a one-shot email to the actor admin when this
    // bounce is for an address they recently re-enabled. Best-effort:
    // every failure path is caught and logged inside the helper. Runs
    // serially to keep DB load predictable; in practice `orgIds` is
    // almost always 1 for a given recipient.
    if (reason === "bounced") {
      const bouncedAt = new Date();
      for (const row of upsertedRows) {
        try {
          await notifyAdminOfReBounceAfterReenable({
            organizationId: row.orgId,
            email: lower,
            suppressionId: row.suppressionId,
            bounceType,
            description,
            bouncedAt,
          });
        } catch (notifyErr) {
          // Helper already swallows; this catch is belt-and-braces so a
          // future refactor that lets it throw can never break the
          // webhook ack.
          logger.warn(
            { err: notifyErr, orgId: row.orgId, email: lower },
            "[webhooks/postmark] re-bounce admin notify failed",
          );
        }
      }
    }

    res.json({ received: true, applied: true, suppressedFor: orgIds, inserted });
  } catch (err) {
    logger.error({ err, email: recipientEmail, recordType }, "[webhooks/postmark] Failed to record suppression");
    res.status(500).json({ received: true, applied: false, error: "internal error" });
  }
});

export default router;
