import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { playersTable, tournamentsTable, leagueMembersTable, leaguesTable, orgMembershipsTable, organizationsTable, shopOrdersTable, shopProductsTable, memberInvoicesTable, invoiceLineItemsTable, clubMembersTable, appUsersTable } from "@workspace/db";
import { eq, desc, and, inArray, asc, ne } from "drizzle-orm";
import { getRazorpayClient, getRazorpayKeyId, verifyPaymentSignature, verifyWebhookSignature, type RazorpayPaymentLinkCreateOpts } from "../lib/razorpay";
import { sendBroadcast, type Recipient } from "../lib/comms";
import { sendReceiptEmail, currencySymbol } from "../lib/paymentReceipts";
import { generateItemisedReceiptPDF, storeReceiptPDF, type ReceiptLineItem } from "../lib/pdfReceipt";
import { objectStorageClient } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import { createGstInvoice, getOrgGstSettings, resolveIndianStateCode, parseGstinStateCode } from "../lib/gstInvoice";
import { dispatchWebhookEvent } from "../lib/webhookDispatch";
import { createCheckoutOrder, createCheckoutPaymentLink, resolveOrgTaxes, recordCheckoutSettlement, verifyCheckoutPayment } from "../lib/checkout";
import { creditWalletTopupFromPayment } from "./side-games-v2";
import { notifyPaymentSettled } from "../lib/notifications";

const router: IRouter = Router({ mergeParams: true });

// ─── Auth helpers ───────────────────────────────────────────────────────────

/** Typed accessor for the Passport session user (avoids repeated inline casts). */
interface SessionUser { id: number; role?: string; organizationId?: number }
function getSessionUser(req: Request): SessionUser | undefined {
  return req.user as SessionUser | undefined;
}

/** Returns true if the current session user is an admin of the given org. */
async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }
  const caller = getSessionUser(req);
  if (!caller) { res.status(401).json({ error: "Authentication required" }); return false; }
  if (caller.role === "super_admin") return true;
  if ((caller.role === "org_admin" || caller.role === "tournament_director") && Number(caller.organizationId) === orgId) return true;
  const userId = caller.id;
  const [membership] = await db
    .select({ id: orgMembershipsTable.id })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, userId),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
    ));
  if (!membership) {
    res.status(403).json({ error: "Organization admin access required" });
    return false;
  }
  return true;
}

/** Resolves the orgId for a tournament-player entry. Returns null if not found. */
async function getOrgIdForPlayer(playerId: number): Promise<number | null> {
  const [player] = await db
    .select({ tournamentId: playersTable.tournamentId })
    .from(playersTable)
    .where(eq(playersTable.id, playerId));
  if (!player) return null;
  const [tour] = await db
    .select({ organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, player.tournamentId));
  return tour?.organizationId ?? null;
}

/** Resolves the orgId for a league-member entry. Returns null if not found. */
async function getOrgIdForLeagueMember(memberId: number): Promise<number | null> {
  const [member] = await db
    .select({ leagueId: leagueMembersTable.leagueId })
    .from(leagueMembersTable)
    .where(eq(leagueMembersTable.id, memberId));
  if (!member) return null;
  const [league] = await db
    .select({ organizationId: leaguesTable.organizationId })
    .from(leaguesTable)
    .where(eq(leaguesTable.id, member.leagueId));
  return league?.organizationId ?? null;
}

/** Extracts a human-readable error message from a Razorpay SDK error (unknown type). */
function razorpayErrMsg(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e["error"] === "object" && e["error"] !== null) {
      const inner = e["error"] as Record<string, unknown>;
      if (typeof inner["description"] === "string") return inner["description"];
    }
    if (typeof e["message"] === "string") return e["message"];
  }
  return String(err);
}

// Razorpay only supports certain currencies; for others we use INR fallback
const RAZORPAY_SUPPORTED = new Set(["INR", "USD", "GBP", "AED", "EUR", "SGD", "AUD"]);

function toRazorpayCurrency(currency: string): string {
  return RAZORPAY_SUPPORTED.has(currency) ? currency : "INR";
}

// ─── GET /api/payments/key ──────────────────────────────────────────────────
router.get("/key", (_req: Request, res: Response) => {
  try {
    const keyId = getRazorpayKeyId();
    res.json({ keyId });
  } catch {
    res.status(503).json({ error: "Payment gateway not configured" });
  }
});

// ─── GET /api/payments/dashboard ───────────────────────────────────────────
// Financial dashboard: revenue summary + transaction log for an org
router.get("/dashboard", async (req: Request, res: Response) => {
  const orgId = parseInt(req.query.orgId as string);
  if (!orgId || isNaN(orgId)) { { res.status(400).json({ error: "orgId required" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Tournament payments
  const tournamentPayments = await db
    .select({
      id: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      email: playersTable.email,
      paymentStatus: playersTable.paymentStatus,
      razorpayPaymentId: playersTable.razorpayPaymentId,
      paymentLinkUrl: playersTable.paymentLinkUrl,
      registeredAt: playersTable.registeredAt,
      tournamentId: tournamentsTable.id,
      tournamentName: tournamentsTable.name,
      entryFee: tournamentsTable.entryFee,
      currency: tournamentsTable.currency,
    })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(eq(tournamentsTable.organizationId, orgId))
    .orderBy(desc(playersTable.registeredAt));

  // League payments
  const leaguePayments = await db
    .select({
      id: leagueMembersTable.id,
      firstName: leagueMembersTable.firstName,
      lastName: leagueMembersTable.lastName,
      email: leagueMembersTable.email,
      paymentStatus: leagueMembersTable.paymentStatus,
      razorpayPaymentId: leagueMembersTable.razorpayPaymentId,
      paymentLinkUrl: leagueMembersTable.paymentLinkUrl,
      joinedAt: leagueMembersTable.joinedAt,
      leagueId: leaguesTable.id,
      leagueName: leaguesTable.name,
      entryFee: leaguesTable.entryFee,
      currency: leaguesTable.currency,
    })
    .from(leagueMembersTable)
    .innerJoin(leaguesTable, eq(leagueMembersTable.leagueId, leaguesTable.id))
    .where(eq(leaguesTable.organizationId, orgId))
    .orderBy(desc(leagueMembersTable.joinedAt));

  // Build unified transaction list
  type TxRow = {
    id: string; kind: "tournament" | "league"; name: string; eventId: number;
    eventName: string; paymentStatus: string; amount: number | null; currency: string;
    paymentId: string | null; paymentLinkUrl: string | null; date: Date;
  };

  const transactions: TxRow[] = [
    ...tournamentPayments.map(p => ({
      id: `t-${p.id}`,
      kind: "tournament" as const,
      name: `${p.firstName} ${p.lastName}`,
      eventId: p.tournamentId,
      eventName: p.tournamentName,
      paymentStatus: p.paymentStatus,
      amount: p.entryFee ? parseFloat(p.entryFee) : null,
      currency: p.currency,
      paymentId: p.razorpayPaymentId,
      paymentLinkUrl: p.paymentLinkUrl,
      date: p.registeredAt,
    })),
    ...leaguePayments.map(m => ({
      id: `l-${m.id}`,
      kind: "league" as const,
      name: `${m.firstName} ${m.lastName}`,
      eventId: m.leagueId,
      eventName: m.leagueName,
      paymentStatus: m.paymentStatus,
      amount: m.entryFee ? parseFloat(m.entryFee) : null,
      currency: m.currency,
      paymentId: m.razorpayPaymentId,
      paymentLinkUrl: m.paymentLinkUrl,
      date: m.joinedAt,
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Revenue summary per currency
  const revenueByCurrency: Record<string, { collected: number; outstanding: number; refunded: number }> = {};
  for (const tx of transactions) {
    if (!tx.amount) continue;
    const cur = tx.currency || "INR";
    if (!revenueByCurrency[cur]) revenueByCurrency[cur] = { collected: 0, outstanding: 0, refunded: 0 };
    if (tx.paymentStatus === "paid") revenueByCurrency[cur].collected += tx.amount;
    else if (tx.paymentStatus === "unpaid" || tx.paymentStatus === "pending") revenueByCurrency[cur].outstanding += tx.amount;
    else if (tx.paymentStatus === "refunded") revenueByCurrency[cur].refunded += tx.amount;
  }

  const totalPaid = transactions.filter(t => t.paymentStatus === "paid").length;
  const totalUnpaid = transactions.filter(t => t.paymentStatus === "unpaid").length;
  const totalRefunded = transactions.filter(t => t.paymentStatus === "refunded").length;

  // Monthly revenue — aggregate paid transactions by year-month (last 12 months)
  const monthlyRevenue: Record<string, { month: string; collected: number; currency: string }> = {};
  for (const tx of transactions) {
    if (tx.paymentStatus !== "paid" || !tx.amount) continue;
    const d = new Date(tx.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const cur = tx.currency || "INR";
    const mKey = `${key}:${cur}`;
    if (!monthlyRevenue[mKey]) monthlyRevenue[mKey] = { month: key, collected: 0, currency: cur };
    monthlyRevenue[mKey].collected += tx.amount;
  }
  const monthlyRevenueList = Object.values(monthlyRevenue)
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-12);

  // ── Per-event summary cards ───────────────────────────────────────────────
  type EventSummary = {
    eventId: number; eventName: string; kind: "tournament" | "league"; currency: string;
    totalPlayers: number; paid: number; unpaid: number; refunded: number;
    collected: number; outstanding: number;
  };
  const eventSummaryMap: Record<string, EventSummary> = {};
  for (const tx of transactions) {
    const key = `${tx.kind}-${tx.eventId}`;
    if (!eventSummaryMap[key]) {
      eventSummaryMap[key] = {
        eventId: tx.eventId, eventName: tx.eventName, kind: tx.kind, currency: tx.currency,
        totalPlayers: 0, paid: 0, unpaid: 0, refunded: 0, collected: 0, outstanding: 0,
      };
    }
    const s = eventSummaryMap[key];
    s.totalPlayers++;
    if (tx.paymentStatus === "paid") { s.paid++; if (tx.amount) s.collected += tx.amount; }
    else if (tx.paymentStatus === "unpaid" || tx.paymentStatus === "pending") { s.unpaid++; if (tx.amount) s.outstanding += tx.amount; }
    else if (tx.paymentStatus === "refunded") s.refunded++;
  }
  const eventSummaries = Object.values(eventSummaryMap)
    .sort((a, b) => b.collected - a.collected || b.totalPlayers - a.totalPlayers);

  res.json({ transactions, revenueByCurrency, totalPaid, totalUnpaid, totalRefunded, monthlyRevenue: monthlyRevenueList, eventSummaries });
});

// ─── POST /api/payments/tournament-player/:playerId/order ──────────────────
router.post("/tournament-player/:playerId/order", async (req: Request, res: Response) => {
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));

  const [player] = await db
    .select({ id: playersTable.id, tournamentId: playersTable.tournamentId, paymentStatus: playersTable.paymentStatus, firstName: playersTable.firstName, lastName: playersTable.lastName, email: playersTable.email, razorpayOrderId: playersTable.razorpayOrderId })
    .from(playersTable)
    .where(eq(playersTable.id, playerId));

  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }
  if (player.paymentStatus === "paid") { { res.status(400).json({ error: "Already paid" }); return; } }
  // Prevent overwrite: if an active order already exists, re-use it
  if (player.razorpayOrderId) {
    try {
      const razorpay = getRazorpayClient();
      const existingOrder = await razorpay.orders.fetch(player.razorpayOrderId);
      if (existingOrder.status === "created") {
        const [tournament] = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name, entryFee: tournamentsTable.entryFee, currency: tournamentsTable.currency }).from(tournamentsTable).where(eq(tournamentsTable.id, player.tournamentId));
        res.json({ orderId: existingOrder.id, amount: existingOrder.amount, currency: existingOrder.currency, keyId: getRazorpayKeyId(), playerName: `${player.firstName} ${player.lastName}`, email: player.email ?? "", description: `Entry fee — ${tournament?.name ?? "tournament"}` });
        return;
      }
    } catch { /* existing order invalid — fall through to create a new one */ }
  }

  const [tournament] = await db
    .select({ id: tournamentsTable.id, name: tournamentsTable.name, entryFee: tournamentsTable.entryFee, currency: tournamentsTable.currency, organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, player.tournamentId));

  if (!tournament?.entryFee) { { res.status(400).json({ error: "This tournament has no entry fee" }); return; } }

  // Pre-compute taxes via the multi-jurisdiction tax engine so non-INR clubs
  // get the correct breakdown. For INR/GST profiles this defers to the
  // canonical resolveGstTax routing inside the engine — invoice generation
  // (createGstInvoice) is unchanged.
  const entryAmount = parseFloat(tournament.entryFee);
  await resolveOrgTaxes({
    organizationId: tournament.organizationId,
    taxableAmount: entryAmount,
    currency: tournament.currency,
    productClass: "tournament_entry",
  }).catch((err) => logger.warn({ err }, "[payments] tax resolution skipped — tournament player order"));

  // Route through the new payment-processor abstraction so non-INR clubs
  // automatically use Stripe while INR continues through Razorpay.
  const checkout = await createCheckoutOrder({
    organizationId: tournament.organizationId,
    amount: entryAmount,
    currency: tournament.currency,
    receipt: `player_${playerId}`,
    description: `Entry fee — ${tournament.name}`,
    customerEmail: player.email ?? undefined,
    metadata: { playerId: String(playerId), tournamentId: String(tournament.id), tournamentName: tournament.name, playerName: `${player.firstName} ${player.lastName}` },
    sourceType: "tournament_entry",
    sourceId: playerId,
  });

  // Store the orderId so we can validate it during payment verification
  await db.update(playersTable).set({ razorpayOrderId: checkout.orderId }).where(eq(playersTable.id, playerId));

  res.json({
    processor: checkout.processor,
    orderId: checkout.orderId,
    amount: checkout.amountMinor, currency: checkout.currency,
    keyId: checkout.razorpayKeyId,
    stripePublishableKey: checkout.stripePublishableKey,
    clientSecret: checkout.clientSecret,
    playerName: `${player.firstName} ${player.lastName}`,
    email: player.email ?? "",
    description: `Entry fee — ${tournament.name}`,
  });
});

// ─── POST /api/payments/tournament-player/:playerId/verify ─────────────────
router.post("/tournament-player/:playerId/verify", async (req: Request, res: Response) => {
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const {
    razorpay_order_id, razorpay_payment_id, razorpay_signature,
    stripe_payment_intent_id, stripe_checkout_session_id,
  } = req.body;

  // Security: verify the pending order id belongs to this player
  const [playerCheck] = await db
    .select({ id: playersTable.id, razorpayOrderId: playersTable.razorpayOrderId, paymentStatus: playersTable.paymentStatus, userId: playersTable.userId })
    .from(playersTable)
    .where(eq(playersTable.id, playerId));
  if (!playerCheck) { { res.status(404).json({ error: "Player not found" }); return; } }
  const tournamentPlayerWasUnpaid = playerCheck.paymentStatus !== "paid";

  // ── Stripe path (non-INR clubs) ────────────────────────────────────────
  let settledPaymentRef: string;
  let settledCurrency: string;
  let settledAmountMinor: number;
  let processorUsed: "razorpay" | "stripe";

  if (stripe_payment_intent_id || stripe_checkout_session_id) {
    if (!playerCheck.razorpayOrderId
      || (stripe_payment_intent_id && playerCheck.razorpayOrderId !== stripe_payment_intent_id)
      || (stripe_checkout_session_id && playerCheck.razorpayOrderId !== stripe_checkout_session_id)) {
      res.status(400).json({ error: "Order ID does not match this player's pending payment" }); return;
    }
    const result = await verifyCheckoutPayment({
      processor: "stripe",
      stripePaymentIntentId: stripe_payment_intent_id,
      stripeCheckoutSessionId: stripe_checkout_session_id,
    });
    if (!result.paid) { { res.status(400).json({ error: "Stripe payment not yet settled" }); return; } }
    settledPaymentRef = result.paymentRef;
    settledCurrency = result.currency;
    settledAmountMinor = result.amountMinor;
    processorUsed = "stripe";
  } else {
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      res.status(400).json({ error: "razorpay_order_id, razorpay_payment_id, razorpay_signature are required (or stripe_payment_intent_id/stripe_checkout_session_id)" }); return;
    }
    if (!playerCheck.razorpayOrderId || playerCheck.razorpayOrderId !== razorpay_order_id) {
      res.status(400).json({ error: "Order ID does not match this player's pending payment" }); return;
    }
    const valid = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!valid) { { res.status(400).json({ error: "Invalid payment signature" }); return; } }
    settledPaymentRef = razorpay_payment_id;
    processorUsed = "razorpay";
    // Razorpay does not return currency/amount inline; we'll look them up from the tournament below.
    settledCurrency = "";
    settledAmountMinor = 0;
  }

  await db.update(playersTable)
    .set({ paymentStatus: "paid", razorpayPaymentId: settledPaymentRef, razorpayOrderId: null })
    .where(eq(playersTable.id, playerId));

  // Fetch player and tournament details for receipt + GST invoice
  const [row] = await db.select({
    firstName: playersTable.firstName, lastName: playersTable.lastName, email: playersTable.email,
    tournamentId: playersTable.tournamentId,
  }).from(playersTable).where(eq(playersTable.id, playerId));

  if (row) {
    const [tour] = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name, entryFee: tournamentsTable.entryFee, currency: tournamentsTable.currency, organizationId: tournamentsTable.organizationId })
      .from(tournamentsTable).where(eq(tournamentsTable.id, row.tournamentId));
    if (tour) {
      const [tourOrg] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
        .from(organizationsTable).where(eq(organizationsTable.id, tour.organizationId));

      // Send receipt email only if email is available
      if (row.email) {
        await sendReceiptEmail({
          email: row.email, name: `${row.firstName} ${row.lastName}`,
          eventName: tour.name, eventType: "tournament",
          amountSubunit: Math.round(parseFloat(tour.entryFee ?? "0") * 100),
          currency: tour.currency, paymentId: settledPaymentRef,
          entityId: playerId,
          receiptBaseUrl: process.env.API_BASE_URL ?? process.env.RAZORPAY_CALLBACK_URL?.replace(/\/payments\/callback.*/, "") ?? "",
          branding: tourOrg ? { orgName: tourOrg.name, logoUrl: tourOrg.logoUrl ?? undefined, primaryColor: tourOrg.primaryColor ?? undefined } : undefined,
        });
      }

      // Generate GST invoice unconditionally — email is delivery only, not a creation precondition
      const gstSettings = await getOrgGstSettings(tour.organizationId).catch(() => null);
      if (gstSettings) {
        const entryFeeAmt = parseFloat(tour.entryFee ?? "0");
        // Canonical precedence: GSTIN prefix > explicit buyerState > seller state (intra-state CGST+SGST default).
        // When buyerState is explicit (no GSTIN), pass buyerStateCode=undefined so createGstInvoice
        // derives the code internally via resolveIndianStateCode(buyerState), preserving correct routing.
        const buyerGstinVal: string | undefined = typeof req.body.buyerGstin === "string" ? req.body.buyerGstin : undefined;
        const buyerStateVal: string | undefined = typeof req.body.buyerState === "string" ? req.body.buyerState : undefined;
        const buyerCountryVal: string | undefined = typeof req.body.buyerCountry === "string" ? req.body.buyerCountry : undefined;
        const resolvedBuyerState = buyerStateVal ?? gstSettings.sellerState ?? undefined;
        const resolvedBuyerStateCode: string | undefined = buyerGstinVal
          ? parseGstinStateCode(buyerGstinVal)
          : buyerStateVal
            ? undefined                               // createGstInvoice calls resolveIndianStateCode(buyerState)
            : gstSettings.sellerStateCode ?? undefined;
        await createGstInvoice({
          organizationId: tour.organizationId,
          channel: "tournament",
          tournamentPlayerId: playerId,
          buyerName: `${row.firstName} ${row.lastName}`,
          buyerEmail: row.email ?? undefined,
          buyerGstin: buyerGstinVal,
          buyerState: resolvedBuyerState,
          buyerStateCode: resolvedBuyerStateCode,
          buyerCountry: buyerCountryVal,
          sellerGstin: gstSettings.gstin ?? undefined,
          sellerName: gstSettings.sellerName ?? undefined,
          sellerAddress: gstSettings.sellerAddress ?? undefined,
          sellerState: gstSettings.sellerState ?? undefined,
          sellerStateCode: gstSettings.sellerStateCode ?? undefined,
          lineItems: [{
            description: `${tour.name} — Tournament Entry Fee`,
            hsnSacCode: gstSettings.defaultSacCode ?? "999691",
            quantity: 1,
            unitPrice: entryFeeAmt,
            gstRate: 18,
          }],
        }).catch((e) => logger.warn({ err: e }, "[payments] GST invoice generation failed — tournament player"));
      }

      dispatchWebhookEvent(tour.organizationId, "payment.received", {
        playerId,
        tournamentId: row.tournamentId,
        playerName: `${row.firstName} ${row.lastName}`,
        email: row.email,
        eventName: tour.name,
        eventType: "tournament",
        amount: parseFloat(tour.entryFee ?? "0"),
        currency: tour.currency,
        paymentId: settledPaymentRef,
      });

      // FX ledger entry on settlement (no-op when booked === settled currency).
      const settlementCurrency = settledCurrency || tour.currency;
      const settlementAmount = settledAmountMinor > 0
        ? settledAmountMinor / 100
        : parseFloat(tour.entryFee ?? "0");
      await recordCheckoutSettlement({
        organizationId: tour.organizationId,
        processor: processorUsed,
        settledCurrency: settlementCurrency,
        settledAmount: settlementAmount,
        paymentRef: settledPaymentRef,
        sourceType: "tournament_entry",
        sourceId: playerId,
      });

      // In-app push to the paying player (Task #978 — Razorpay parity with
      // the Stripe webhook path in Task #832). Only fires on the Razorpay
      // verify branch, status-flip guarded so re-verifies don't re-fire.
      // The Stripe verify branch is intentionally skipped — the Stripe
      // webhook in routes/webhooks.ts owns that push.
      if (processorUsed === "razorpay" && tournamentPlayerWasUnpaid) {
        try {
          const pushAmountMinor = settledAmountMinor > 0
            ? settledAmountMinor
            : Math.round(parseFloat(tour.entryFee ?? "0") * 100);
          await notifyPaymentSettled({
            userId: playerCheck.userId,
            kind: "tournament",
            eventName: tour.name,
            amountMinor: pushAmountMinor,
            currency: settlementCurrency,
            paymentRef: settledPaymentRef,
            organizationId: tour.organizationId,
            entityId: tour.id,
          });
        } catch (pushErr) {
          logger.warn({ err: pushErr, playerId }, "[payments/verify] tournament player push failed");
        }
      }
    }
  }

  res.json({ success: true, message: "Payment verified. Player marked as paid.", processor: processorUsed });
});

// ─── POST /api/payments/tournament-player/:playerId/mark-paid ──────────────
// Manual mark-paid by admin (no Razorpay needed)
router.post("/tournament-player/:playerId/mark-paid", async (req: Request, res: Response) => {
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const orgId = await getOrgIdForPlayer(playerId);
  if (orgId === null) { { res.status(404).json({ error: "Player not found" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { note } = req.body as { note?: string };
  await db.update(playersTable)
    .set({ paymentStatus: "paid", razorpayPaymentId: note ?? "manual" })
    .where(eq(playersTable.id, playerId));
  res.json({ success: true });
});

// ─── POST /api/payments/tournament-player/:playerId/refund ─────────────────
router.post("/tournament-player/:playerId/refund", async (req: Request, res: Response) => {
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const orgId = await getOrgIdForPlayer(playerId);
  if (orgId === null) { { res.status(404).json({ error: "Player not found" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [player] = await db.select({
    id: playersTable.id, paymentStatus: playersTable.paymentStatus,
    razorpayPaymentId: playersTable.razorpayPaymentId, tournamentId: playersTable.tournamentId,
  }).from(playersTable).where(eq(playersTable.id, playerId));

  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }
  if (player.paymentStatus !== "paid") { { res.status(400).json({ error: "Player has not paid" }); return; } }
  if (!player.razorpayPaymentId || player.razorpayPaymentId === "manual") {
    // Manual refund — just mark as refunded
    await db.update(playersTable).set({ paymentStatus: "refunded", razorpayRefundId: "manual" }).where(eq(playersTable.id, playerId));
    res.json({ success: true, refundId: "manual" }); return;
  }

  const [tournament] = await db.select({ entryFee: tournamentsTable.entryFee })
    .from(tournamentsTable).where(eq(tournamentsTable.id, player.tournamentId));

  // Allow caller to specify a partial refund amount (in major currency units); falls back to full entry fee
  const { amount: refundAmountInput } = req.body as { amount?: string | number };
  let amountPaise: number | undefined;
  if (refundAmountInput) {
    amountPaise = Math.round(parseFloat(String(refundAmountInput)) * 100);
  } else if (tournament?.entryFee) {
    amountPaise = Math.round(parseFloat(tournament.entryFee) * 100);
  }

  const razorpay = getRazorpayClient();
  try {
    const refund = await razorpay.payments.refund(player.razorpayPaymentId, {
      amount: amountPaise,
      notes: { reason: "Admin initiated refund" },
    });
    await db.update(playersTable)
      .set({ paymentStatus: "refunded", razorpayRefundId: refund.id })
      .where(eq(playersTable.id, playerId));
    res.json({ success: true, refundId: refund.id });
  } catch (err: unknown) {
    res.status(500).json({ error: razorpayErrMsg(err) });
  }
});

// ─── POST /api/payments/tournament-player/:playerId/payment-link ───────────
router.post("/tournament-player/:playerId/payment-link", async (req: Request, res: Response) => {
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const orgId = await getOrgIdForPlayer(playerId);
  if (orgId === null) { { res.status(404).json({ error: "Player not found" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [player] = await db.select({
    id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName,
    email: playersTable.email, phone: playersTable.phone,
    paymentStatus: playersTable.paymentStatus, paymentLinkId: playersTable.paymentLinkId,
    paymentLinkUrl: playersTable.paymentLinkUrl, tournamentId: playersTable.tournamentId,
  }).from(playersTable).where(eq(playersTable.id, playerId));

  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }

  // Return existing link if still valid
  if (player.paymentLinkUrl && player.paymentStatus !== "paid") {
    res.json({ url: player.paymentLinkUrl, existing: true }); return;
  }

  const [tournament] = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name, entryFee: tournamentsTable.entryFee, currency: tournamentsTable.currency })
    .from(tournamentsTable).where(eq(tournamentsTable.id, player.tournamentId));

  if (!tournament?.entryFee) { { res.status(400).json({ error: "No entry fee set" }); return; } }

  try {
    const link = await createCheckoutPaymentLink({
      organizationId: orgId,
      amount: parseFloat(tournament.entryFee),
      currency: tournament.currency,
      description: `Entry fee — ${tournament.name}`,
      customerName: `${player.firstName} ${player.lastName}`,
      customerEmail: player.email ?? undefined,
      customerPhone: player.phone ?? undefined,
      notify: { email: true, sms: true },
      notes: { playerId: String(playerId), tournamentId: String(tournament.id) },
      sourceType: "tournament_entry_link",
      sourceId: playerId,
    });
    await db.update(playersTable).set({ paymentLinkId: link.id, paymentLinkUrl: link.url }).where(eq(playersTable.id, playerId));
    res.json({ url: link.url, linkId: link.id, processor: link.processor });
  } catch (err: unknown) {
    res.status(500).json({ error: razorpayErrMsg(err) });
  }
});

// ─── POST /api/payments/league-member/:memberId/order ─────────────────────
router.post("/league-member/:memberId/order", async (req: Request, res: Response) => {
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));

  const [member] = await db.select({
    id: leagueMembersTable.id, leagueId: leagueMembersTable.leagueId,
    firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName,
    email: leagueMembersTable.email, paymentStatus: leagueMembersTable.paymentStatus,
    razorpayOrderId: leagueMembersTable.razorpayOrderId,
  }).from(leagueMembersTable).where(eq(leagueMembersTable.id, memberId));

  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }
  if (member.paymentStatus === "paid") { { res.status(400).json({ error: "Already paid" }); return; } }
  // Prevent overwrite: if an active order already exists, re-use it
  if (member.razorpayOrderId) {
    try {
      const razorpay = getRazorpayClient();
      const existingOrder = await razorpay.orders.fetch(member.razorpayOrderId);
      if (existingOrder.status === "created") {
        const [league] = await db.select({ id: leaguesTable.id, name: leaguesTable.name, entryFee: leaguesTable.entryFee, currency: leaguesTable.currency }).from(leaguesTable).where(eq(leaguesTable.id, member.leagueId));
        res.json({ orderId: existingOrder.id, amount: existingOrder.amount, currency: existingOrder.currency, keyId: getRazorpayKeyId(), memberName: `${member.firstName} ${member.lastName}`, email: member.email ?? "", description: `Entry fee — ${league?.name ?? "league"}` });
        return;
      }
    } catch { /* existing order invalid — fall through to create a new one */ }
  }

  const [league] = await db.select({ id: leaguesTable.id, name: leaguesTable.name, entryFee: leaguesTable.entryFee, currency: leaguesTable.currency, organizationId: leaguesTable.organizationId })
    .from(leaguesTable).where(eq(leaguesTable.id, member.leagueId));

  if (!league?.entryFee) { { res.status(400).json({ error: "This league has no entry fee" }); return; } }

  const entryAmount = parseFloat(league.entryFee);
  await resolveOrgTaxes({
    organizationId: league.organizationId,
    taxableAmount: entryAmount,
    currency: league.currency,
    productClass: "league_entry",
  }).catch((err) => logger.warn({ err }, "[payments] tax resolution skipped — league member order"));

  const checkout = await createCheckoutOrder({
    organizationId: league.organizationId,
    amount: entryAmount,
    currency: league.currency,
    receipt: `member_${memberId}`,
    description: `Entry fee — ${league.name}`,
    customerEmail: member.email ?? undefined,
    metadata: { memberId: String(memberId), leagueId: String(league.id), leagueName: league.name, memberName: `${member.firstName} ${member.lastName}` },
    sourceType: "league_entry",
    sourceId: memberId,
  });

  // Store the orderId so we can validate it during payment verification
  await db.update(leagueMembersTable).set({ razorpayOrderId: checkout.orderId }).where(eq(leagueMembersTable.id, memberId));

  res.json({
    processor: checkout.processor,
    orderId: checkout.orderId,
    amount: checkout.amountMinor, currency: checkout.currency,
    keyId: checkout.razorpayKeyId,
    stripePublishableKey: checkout.stripePublishableKey,
    clientSecret: checkout.clientSecret,
    memberName: `${member.firstName} ${member.lastName}`,
    email: member.email ?? "",
    description: `Entry fee — ${league.name}`,
  });
});

// ─── POST /api/payments/league-member/:memberId/verify ────────────────────
router.post("/league-member/:memberId/verify", async (req: Request, res: Response) => {
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  const {
    razorpay_order_id, razorpay_payment_id, razorpay_signature,
    stripe_payment_intent_id, stripe_checkout_session_id,
  } = req.body;

  // Security: verify the pending order id belongs to this member
  const [memberCheck] = await db
    .select({ id: leagueMembersTable.id, razorpayOrderId: leagueMembersTable.razorpayOrderId, paymentStatus: leagueMembersTable.paymentStatus, userId: leagueMembersTable.userId })
    .from(leagueMembersTable)
    .where(eq(leagueMembersTable.id, memberId));
  if (!memberCheck) { { res.status(404).json({ error: "Member not found" }); return; } }
  const leagueMemberWasUnpaid = memberCheck.paymentStatus !== "paid";

  let settledPaymentRef: string;
  let settledCurrency: string;
  let settledAmountMinor: number;
  let processorUsed: "razorpay" | "stripe";

  if (stripe_payment_intent_id || stripe_checkout_session_id) {
    if (!memberCheck.razorpayOrderId
      || (stripe_payment_intent_id && memberCheck.razorpayOrderId !== stripe_payment_intent_id)
      || (stripe_checkout_session_id && memberCheck.razorpayOrderId !== stripe_checkout_session_id)) {
      res.status(400).json({ error: "Order ID does not match this member's pending payment" }); return;
    }
    const result = await verifyCheckoutPayment({
      processor: "stripe",
      stripePaymentIntentId: stripe_payment_intent_id,
      stripeCheckoutSessionId: stripe_checkout_session_id,
    });
    if (!result.paid) { { res.status(400).json({ error: "Stripe payment not yet settled" }); return; } }
    settledPaymentRef = result.paymentRef;
    settledCurrency = result.currency;
    settledAmountMinor = result.amountMinor;
    processorUsed = "stripe";
  } else {
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      res.status(400).json({ error: "razorpay_order_id, razorpay_payment_id, razorpay_signature are required (or stripe_payment_intent_id/stripe_checkout_session_id)" }); return;
    }
    if (!memberCheck.razorpayOrderId || memberCheck.razorpayOrderId !== razorpay_order_id) {
      res.status(400).json({ error: "Order ID does not match this member's pending payment" }); return;
    }
    const valid = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!valid) { { res.status(400).json({ error: "Invalid payment signature" }); return; } }
    settledPaymentRef = razorpay_payment_id;
    processorUsed = "razorpay";
    settledCurrency = "";
    settledAmountMinor = 0;
  }

  await db.update(leagueMembersTable)
    .set({ paymentStatus: "paid", razorpayPaymentId: settledPaymentRef, razorpayOrderId: null })
    .where(eq(leagueMembersTable.id, memberId));

  // Fetch member and league details for receipt + GST invoice
  const [row] = await db.select({
    firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName,
    email: leagueMembersTable.email, leagueId: leagueMembersTable.leagueId,
  }).from(leagueMembersTable).where(eq(leagueMembersTable.id, memberId));

  if (row) {
    const [league] = await db.select({ id: leaguesTable.id, name: leaguesTable.name, entryFee: leaguesTable.entryFee, currency: leaguesTable.currency, organizationId: leaguesTable.organizationId })
      .from(leaguesTable).where(eq(leaguesTable.id, row.leagueId));
    if (league) {
      const [leagueOrg] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
        .from(organizationsTable).where(eq(organizationsTable.id, league.organizationId));

      // Send receipt email only if email is available
      if (row.email) {
        await sendReceiptEmail({
          email: row.email, name: `${row.firstName} ${row.lastName}`,
          eventName: league.name, eventType: "league",
          amountSubunit: Math.round(parseFloat(league.entryFee ?? "0") * 100),
          currency: league.currency, paymentId: settledPaymentRef,
          entityId: memberId,
          receiptBaseUrl: process.env.API_BASE_URL ?? process.env.RAZORPAY_CALLBACK_URL?.replace(/\/payments\/callback.*/, "") ?? "",
          branding: leagueOrg ? { orgName: leagueOrg.name, logoUrl: leagueOrg.logoUrl ?? undefined, primaryColor: leagueOrg.primaryColor ?? undefined } : undefined,
        });
      }

      // Generate GST invoice unconditionally — email is delivery only, not a creation precondition
      const gstSettings = await getOrgGstSettings(league.organizationId).catch(() => null);
      if (gstSettings) {
        const entryFeeAmt = parseFloat(league.entryFee ?? "0");
        // Canonical precedence: GSTIN prefix > explicit buyerState > seller state (intra-state CGST+SGST default).
        // When buyerState is explicit (no GSTIN), pass buyerStateCode=undefined so createGstInvoice
        // derives the code internally via resolveIndianStateCode(buyerState), preserving correct routing.
        const buyerGstinVal: string | undefined = typeof req.body.buyerGstin === "string" ? req.body.buyerGstin : undefined;
        const buyerStateVal: string | undefined = typeof req.body.buyerState === "string" ? req.body.buyerState : undefined;
        const buyerCountryVal: string | undefined = typeof req.body.buyerCountry === "string" ? req.body.buyerCountry : undefined;
        const resolvedBuyerState = buyerStateVal ?? gstSettings.sellerState ?? undefined;
        const resolvedBuyerStateCode: string | undefined = buyerGstinVal
          ? parseGstinStateCode(buyerGstinVal)
          : buyerStateVal
            ? undefined                               // createGstInvoice calls resolveIndianStateCode(buyerState)
            : gstSettings.sellerStateCode ?? undefined;
        await createGstInvoice({
          organizationId: league.organizationId,
          channel: "league",
          leagueMemberId: memberId,
          buyerName: `${row.firstName} ${row.lastName}`,
          buyerEmail: row.email ?? undefined,
          buyerGstin: buyerGstinVal,
          buyerState: resolvedBuyerState,
          buyerStateCode: resolvedBuyerStateCode,
          buyerCountry: buyerCountryVal,
          sellerGstin: gstSettings.gstin ?? undefined,
          sellerName: gstSettings.sellerName ?? undefined,
          sellerAddress: gstSettings.sellerAddress ?? undefined,
          sellerState: gstSettings.sellerState ?? undefined,
          sellerStateCode: gstSettings.sellerStateCode ?? undefined,
          lineItems: [{
            description: `${league.name} — League Entry Fee`,
            hsnSacCode: gstSettings.defaultSacCode ?? "999691",
            quantity: 1,
            unitPrice: entryFeeAmt,
            gstRate: 18,
          }],
        }).catch((e) => logger.warn({ err: e }, "[payments] GST invoice generation failed — league member"));
      }

      // FX ledger entry on settlement.
      const settlementCurrency = settledCurrency || league.currency;
      const settlementAmount = settledAmountMinor > 0
        ? settledAmountMinor / 100
        : parseFloat(league.entryFee ?? "0");
      await recordCheckoutSettlement({
        organizationId: league.organizationId,
        processor: processorUsed,
        settledCurrency: settlementCurrency,
        settledAmount: settlementAmount,
        paymentRef: settledPaymentRef,
        sourceType: "league_entry",
        sourceId: memberId,
      });

      // In-app push to the paying league member (Task #978 — Razorpay
      // parity with the Stripe webhook path in Task #832). Razorpay
      // branch only; the Stripe branch is owned by the Stripe webhook.
      if (processorUsed === "razorpay" && leagueMemberWasUnpaid) {
        try {
          const pushAmountMinor = settledAmountMinor > 0
            ? settledAmountMinor
            : Math.round(parseFloat(league.entryFee ?? "0") * 100);
          await notifyPaymentSettled({
            userId: memberCheck.userId,
            kind: "league",
            eventName: league.name,
            amountMinor: pushAmountMinor,
            currency: settlementCurrency,
            paymentRef: settledPaymentRef,
            organizationId: league.organizationId,
            entityId: league.id,
          });
        } catch (pushErr) {
          logger.warn({ err: pushErr, memberId }, "[payments/verify] league member push failed");
        }
      }
    }
  }

  res.json({ success: true, message: "Payment verified for league member.", processor: processorUsed });
});

// ─── POST /api/payments/league-member/:memberId/payment-link ──────────────
router.post("/league-member/:memberId/payment-link", async (req: Request, res: Response) => {
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  const orgId = await getOrgIdForLeagueMember(memberId);
  if (orgId === null) { { res.status(404).json({ error: "Member not found" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [member] = await db.select({
    id: leagueMembersTable.id, firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName,
    email: leagueMembersTable.email, paymentStatus: leagueMembersTable.paymentStatus,
    paymentLinkUrl: leagueMembersTable.paymentLinkUrl, leagueId: leagueMembersTable.leagueId,
  }).from(leagueMembersTable).where(eq(leagueMembersTable.id, memberId));

  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }
  if (member.paymentLinkUrl && member.paymentStatus !== "paid") {
    res.json({ url: member.paymentLinkUrl, existing: true }); return;
  }

  const [league] = await db.select({ id: leaguesTable.id, name: leaguesTable.name, entryFee: leaguesTable.entryFee, currency: leaguesTable.currency })
    .from(leaguesTable).where(eq(leaguesTable.id, member.leagueId));

  if (!league?.entryFee) { { res.status(400).json({ error: "No entry fee set" }); return; } }

  try {
    const link = await createCheckoutPaymentLink({
      organizationId: orgId,
      amount: parseFloat(league.entryFee),
      currency: league.currency,
      description: `Entry fee — ${league.name}`,
      customerName: `${member.firstName} ${member.lastName}`,
      customerEmail: member.email ?? undefined,
      notify: { email: true },
      notes: { memberId: String(memberId), leagueId: String(league.id) },
      sourceType: "league_entry_link",
      sourceId: memberId,
    });
    await db.update(leagueMembersTable).set({ paymentLinkId: link.id, paymentLinkUrl: link.url }).where(eq(leagueMembersTable.id, memberId));
    res.json({ url: link.url, linkId: link.id, processor: link.processor });
  } catch (err: unknown) {
    res.status(500).json({ error: razorpayErrMsg(err) });
  }
});

// ─── POST /api/payments/league-member/:memberId/refund ────────────────────
router.post("/league-member/:memberId/refund", async (req: Request, res: Response) => {
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  const orgId = await getOrgIdForLeagueMember(memberId);
  if (orgId === null) { { res.status(404).json({ error: "Member not found" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [member] = await db.select({
    id: leagueMembersTable.id, paymentStatus: leagueMembersTable.paymentStatus,
    razorpayPaymentId: leagueMembersTable.razorpayPaymentId, leagueId: leagueMembersTable.leagueId,
  }).from(leagueMembersTable).where(eq(leagueMembersTable.id, memberId));

  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }
  if (member.paymentStatus !== "paid") { { res.status(400).json({ error: "Member has not paid" }); return; } }
  if (!member.razorpayPaymentId || member.razorpayPaymentId === "manual") {
    await db.update(leagueMembersTable).set({ paymentStatus: "refunded", razorpayRefundId: "manual" }).where(eq(leagueMembersTable.id, memberId));
    res.json({ success: true, refundId: "manual" }); return;
  }

  const [league] = await db.select({ entryFee: leaguesTable.entryFee })
    .from(leaguesTable).where(eq(leaguesTable.id, member.leagueId));

  const { amount: refundAmountInput } = req.body as { amount?: string | number };
  let amountPaise: number | undefined;
  if (refundAmountInput) {
    amountPaise = Math.round(parseFloat(String(refundAmountInput)) * 100);
  } else if (league?.entryFee) {
    amountPaise = Math.round(parseFloat(league.entryFee) * 100);
  }

  const razorpay = getRazorpayClient();
  try {
    const refund = await razorpay.payments.refund(member.razorpayPaymentId, {
      amount: amountPaise,
      notes: { reason: "Admin initiated refund" },
    });
    await db.update(leagueMembersTable)
      .set({ paymentStatus: "refunded", razorpayRefundId: refund.id })
      .where(eq(leagueMembersTable.id, memberId));
    res.json({ success: true, refundId: refund.id });
  } catch (err: unknown) {
    res.status(500).json({ error: razorpayErrMsg(err) });
  }
});

// ─── POST /api/payments/league-member/:memberId/mark-paid ─────────────────
router.post("/league-member/:memberId/mark-paid", async (req: Request, res: Response) => {
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  const orgId = await getOrgIdForLeagueMember(memberId);
  if (orgId === null) { { res.status(404).json({ error: "Member not found" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.update(leagueMembersTable).set({ paymentStatus: "paid", razorpayPaymentId: "manual" }).where(eq(leagueMembersTable.id, memberId));
  res.json({ success: true });
});

// ─── POST /api/payments/bulk-payment-links ────────────────────────────────
// Generate payment links for all unpaid players/members in a tournament or league
router.post("/bulk-payment-links", async (req: Request, res: Response) => {
  const { orgId, entityType, entityId } = req.body as { orgId?: number; entityType?: "tournament" | "league"; entityId?: number };
  if (!orgId || !entityType || !entityId) {
    res.status(400).json({ error: "orgId, entityType, and entityId are required" }); return;
  }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const razorpay = getRazorpayClient();
  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  if (entityType === "tournament") {
    const [tournament] = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name, entryFee: tournamentsTable.entryFee, currency: tournamentsTable.currency, organizationId: tournamentsTable.organizationId })
      .from(tournamentsTable).where(and(eq(tournamentsTable.id, entityId), eq(tournamentsTable.organizationId, orgId)));
    if (!tournament?.entryFee) { { res.status(400).json({ error: "No entry fee set" }); return; } }

    const unpaid = await db.select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName, email: playersTable.email, phone: playersTable.phone, paymentLinkUrl: playersTable.paymentLinkUrl, paymentStatus: playersTable.paymentStatus })
      .from(playersTable).where(and(eq(playersTable.tournamentId, entityId), eq(playersTable.paymentStatus, "unpaid")));

    const currency = toRazorpayCurrency(tournament.currency);
    const amountSubunit = Math.round(parseFloat(tournament.entryFee) * 100);

    for (const p of unpaid) {
      if (p.paymentLinkUrl) { skipped++; continue; }
      try {
        const opts: RazorpayPaymentLinkCreateOpts = {
          amount: amountSubunit, currency,
          description: `Entry fee — ${tournament.name}`,
          customer: { name: `${p.firstName} ${p.lastName}`, email: p.email ?? undefined, contact: p.phone ?? undefined },
          notify: { email: !!(p.email), sms: !!(p.phone) },
          reminder_enable: true,
          notes: { playerId: String(p.id), tournamentId: String(entityId) },
        };
        const link = await razorpay.paymentLink.create(opts);
        await db.update(playersTable).set({ paymentLinkId: link.id, paymentLinkUrl: link.short_url }).where(eq(playersTable.id, p.id));
        created++;
      } catch { errors.push(`player:${p.id}`); }
    }
  } else {
    const [league] = await db.select({ id: leaguesTable.id, name: leaguesTable.name, entryFee: leaguesTable.entryFee, currency: leaguesTable.currency, organizationId: leaguesTable.organizationId })
      .from(leaguesTable).where(and(eq(leaguesTable.id, entityId), eq(leaguesTable.organizationId, orgId)));
    if (!league?.entryFee) { { res.status(400).json({ error: "No entry fee set" }); return; } }

    const unpaid = await db.select({ id: leagueMembersTable.id, firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName, email: leagueMembersTable.email, paymentLinkUrl: leagueMembersTable.paymentLinkUrl, paymentStatus: leagueMembersTable.paymentStatus })
      .from(leagueMembersTable).where(and(eq(leagueMembersTable.leagueId, entityId), eq(leagueMembersTable.paymentStatus, "unpaid")));

    const currency = toRazorpayCurrency(league.currency);
    const amountSubunit = Math.round(parseFloat(league.entryFee) * 100);

    for (const m of unpaid) {
      if (m.paymentLinkUrl) { skipped++; continue; }
      try {
        const opts: RazorpayPaymentLinkCreateOpts = {
          amount: amountSubunit, currency,
          description: `Entry fee — ${league.name}`,
          customer: { name: `${m.firstName} ${m.lastName}`, email: m.email ?? undefined },
          notify: { email: !!(m.email) },
          reminder_enable: true,
          notes: { memberId: String(m.id), leagueId: String(entityId) },
        };
        const link = await razorpay.paymentLink.create(opts);
        await db.update(leagueMembersTable).set({ paymentLinkId: link.id, paymentLinkUrl: link.short_url }).where(eq(leagueMembersTable.id, m.id));
        created++;
      } catch { errors.push(`member:${m.id}`); }
    }
  }

  res.json({ created, skipped, errors });
});

// ─── POST /api/payments/remind-unpaid ─────────────────────────────────────
// Send payment reminders via all available channels (email/SMS/WhatsApp/push)
// to all unpaid players/members for an org.  Missing payment links are
// auto-created before sending so every reminder carries a personal pay URL.
router.post("/remind-unpaid", async (req: Request, res: Response) => {
  const { orgId, tournamentId: filterTournamentId, leagueId: filterLeagueId } = req.body as {
    orgId?: number; tournamentId?: number; leagueId?: number;
  };
  if (!orgId) { { res.status(400).json({ error: "orgId required" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const razorpay = getRazorpayClient();

  // ── Unpaid tournament players ────────────────────────────────────────────
  const playerWhere = filterTournamentId
    ? and(eq(tournamentsTable.organizationId, orgId), eq(playersTable.paymentStatus, "unpaid"), eq(playersTable.tournamentId, filterTournamentId))
    : and(eq(tournamentsTable.organizationId, orgId), eq(playersTable.paymentStatus, "unpaid"));
  const unpaidPlayers = await db
    .select({
      id: playersTable.id, userId: playersTable.userId,
      firstName: playersTable.firstName, lastName: playersTable.lastName,
      email: playersTable.email, paymentLinkUrl: playersTable.paymentLinkUrl,
      tournamentId: tournamentsTable.id, tournamentName: tournamentsTable.name,
      entryFee: tournamentsTable.entryFee, currency: tournamentsTable.currency,
    })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(playerWhere);

  // ── Unpaid league members ───────────────────────────────────────────────
  const unpaidMembers = await db
    .select({
      id: leagueMembersTable.id, userId: leagueMembersTable.userId,
      firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName,
      email: leagueMembersTable.email, paymentLinkUrl: leagueMembersTable.paymentLinkUrl,
      leagueId: leaguesTable.id, leagueName: leaguesTable.name,
      entryFee: leaguesTable.entryFee, currency: leaguesTable.currency,
    })
    .from(leagueMembersTable)
    .innerJoin(leaguesTable, eq(leagueMembersTable.leagueId, leaguesTable.id))
    .where(filterLeagueId
      ? and(eq(leaguesTable.organizationId, orgId), eq(leagueMembersTable.paymentStatus, "unpaid"), eq(leagueMembersTable.leagueId, filterLeagueId))
      : and(eq(leaguesTable.organizationId, orgId), eq(leagueMembersTable.paymentStatus, "unpaid")));

  let sent = 0;
  const errors: string[] = [];

  // Helper: ensure a personal payment link exists before reminding
  async function ensurePlayerLink(p: typeof unpaidPlayers[number]): Promise<string | undefined> {
    if (p.paymentLinkUrl) return p.paymentLinkUrl;
    if (!p.entryFee) return undefined;
    try {
      const cur = (p.currency as string | null) ?? "INR";
      const opts: RazorpayPaymentLinkCreateOpts = {
        amount: Math.round(Number(p.entryFee) * 100), currency: cur,
        description: `Entry fee — ${p.tournamentName}`,
        customer: { name: `${p.firstName} ${p.lastName}`, email: p.email ?? undefined },
        notify: { email: Boolean(p.email) }, upi_link: cur === "INR",
        expire_by: Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60,
        reference_id: `tp_${p.id}`,
        notes: { playerId: String(p.id), tournamentId: String(p.tournamentId) },
      };
      const link = await razorpay.paymentLink.create(opts);
      await db.update(playersTable).set({ paymentLinkUrl: link.short_url }).where(eq(playersTable.id, p.id));
      return link.short_url;
    } catch { return undefined; }
  }

  async function ensureMemberLink(m: typeof unpaidMembers[number]): Promise<string | undefined> {
    if (m.paymentLinkUrl) return m.paymentLinkUrl;
    if (!m.entryFee) return undefined;
    try {
      const cur = (m.currency as string | null) ?? "INR";
      const opts: RazorpayPaymentLinkCreateOpts = {
        amount: Math.round(Number(m.entryFee) * 100), currency: cur,
        description: `Entry fee — ${m.leagueName}`,
        customer: { name: `${m.firstName} ${m.lastName}`, email: m.email ?? undefined },
        notify: { email: Boolean(m.email) }, upi_link: cur === "INR",
        expire_by: Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60,
        reference_id: `lm_${m.id}`,
        notes: { memberId: String(m.id), leagueId: String(m.leagueId) },
      };
      const link = await razorpay.paymentLink.create(opts);
      await db.update(leagueMembersTable).set({ paymentLinkUrl: link.short_url }).where(eq(leagueMembersTable.id, m.id));
      return link.short_url;
    } catch { return undefined; }
  }

  // Send reminders for unpaid tournament players via the comms hub
  for (const p of unpaidPlayers) {
    try {
      const paymentUrl = await ensurePlayerLink(p);
      const cur = (p.currency as string | null) ?? "INR";
      const sym = currencySymbol(cur);
      const amount = p.entryFee ? Number(p.entryFee).toFixed(2) : "—";
      const body = `Hi ${p.firstName}, your entry fee of ${sym}${amount} for ${p.tournamentName} is still outstanding.` +
        (paymentUrl ? ` Pay now: ${paymentUrl}` : " Please contact us to complete your payment.");
      const recipient: Recipient = {
        firstName: p.firstName, lastName: p.lastName, email: p.email, userId: p.userId,
      };
      await sendBroadcast([recipient], {
        subject: `Payment Reminder — ${p.tournamentName}`,
        body,
        channels: ["email", "sms", "whatsapp", "push"],
        eventName: p.tournamentName,
        tournamentId: p.tournamentId,
        // Task #1566 — tag tournament payment-reminder emails with the
        // originating club so the Postmark bounce webhook (Task #981) can
        // attribute hard bounces back to this org instantly.
        organizationId: orgId,
      });
      sent++;
    } catch { errors.push(`player:${p.id}`); }
  }

  // Send reminders for unpaid league members via the comms hub
  for (const m of unpaidMembers) {
    try {
      const paymentUrl = await ensureMemberLink(m);
      const cur = (m.currency as string | null) ?? "INR";
      const sym = currencySymbol(cur);
      const amount = m.entryFee ? Number(m.entryFee).toFixed(2) : "—";
      const body = `Hi ${m.firstName}, your entry fee of ${sym}${amount} for ${m.leagueName} is still outstanding.` +
        (paymentUrl ? ` Pay now: ${paymentUrl}` : " Please contact us to complete your payment.");
      const recipient: Recipient = {
        firstName: m.firstName, lastName: m.lastName, email: m.email, userId: m.userId,
      };
      await sendBroadcast([recipient], {
        subject: `Payment Reminder — ${m.leagueName}`,
        body,
        channels: ["email", "sms", "whatsapp", "push"],
        eventName: m.leagueName,
        leagueId: m.leagueId,
        // Task #1566 — tag league payment-reminder emails with the
        // originating club so the Postmark bounce webhook (Task #981) can
        // attribute hard bounces back to this org instantly.
        organizationId: orgId,
      });
      sent++;
    } catch { errors.push(`member:${m.id}`); }
  }

  res.json({ sent, total: unpaidPlayers.length + unpaidMembers.length, errors });
});

// ─── POST /api/payments/webhook ────────────────────────────────────────────
router.post("/webhook", async (req: Request, res: Response) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (webhookSecret) {
    const signature = req.headers["x-razorpay-signature"] as string;
    const rawBody = JSON.stringify(req.body);
    if (!signature || !verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      res.status(400).json({ error: "Invalid webhook signature" }); return;
    }
  }

  const event = req.body;

  if (event.event === "payment.captured") {
    const payment = event.payload?.payment?.entity ?? {};
    const notes = payment.notes ?? {};
    if (notes.playerId) {
      const playerIdNum = parseInt(notes.playerId);
      // Status-flip guard: only fire push on the first pending → paid
      // transition so duplicate webhook deliveries don't re-notify.
      const flipped = await db.update(playersTable)
        .set({ paymentStatus: "paid", razorpayPaymentId: payment.id })
        .where(and(eq(playersTable.id, playerIdNum), ne(playersTable.paymentStatus, "paid")))
        .returning({ userId: playersTable.userId, tournamentId: playersTable.tournamentId });
      if (flipped.length > 0) {
        const flippedRow = flipped[0]!;
        try {
          const [tour] = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name, entryFee: tournamentsTable.entryFee, currency: tournamentsTable.currency, organizationId: tournamentsTable.organizationId })
            .from(tournamentsTable).where(eq(tournamentsTable.id, flippedRow.tournamentId));
          if (tour) {
            const amtMinor = Number(payment.amount) > 0 ? Number(payment.amount) : Math.round(parseFloat(tour.entryFee ?? "0") * 100);
            await notifyPaymentSettled({
              userId: flippedRow.userId,
              kind: "tournament",
              eventName: tour.name,
              amountMinor: amtMinor,
              currency: String(payment.currency ?? tour.currency ?? "INR"),
              paymentRef: String(payment.id ?? ""),
              organizationId: tour.organizationId,
              entityId: tour.id,
            });
          }
        } catch (pushErr) {
          logger.warn({ err: pushErr, playerId: playerIdNum }, "[payments/webhook] tournament player push failed");
        }
      }
    }
    if (notes.memberId) {
      const memberIdNum = parseInt(notes.memberId);
      const flipped = await db.update(leagueMembersTable)
        .set({ paymentStatus: "paid", razorpayPaymentId: payment.id })
        .where(and(eq(leagueMembersTable.id, memberIdNum), ne(leagueMembersTable.paymentStatus, "paid")))
        .returning({ userId: leagueMembersTable.userId, leagueId: leagueMembersTable.leagueId });
      if (flipped.length > 0) {
        const flippedRow = flipped[0]!;
        try {
          const [lg] = await db.select({ id: leaguesTable.id, name: leaguesTable.name, entryFee: leaguesTable.entryFee, currency: leaguesTable.currency, organizationId: leaguesTable.organizationId })
            .from(leaguesTable).where(eq(leaguesTable.id, flippedRow.leagueId));
          if (lg) {
            const amtMinor = Number(payment.amount) > 0 ? Number(payment.amount) : Math.round(parseFloat(lg.entryFee ?? "0") * 100);
            await notifyPaymentSettled({
              userId: flippedRow.userId,
              kind: "league",
              eventName: lg.name,
              amountMinor: amtMinor,
              currency: String(payment.currency ?? lg.currency ?? "INR"),
              paymentRef: String(payment.id ?? ""),
              organizationId: lg.organizationId,
              entityId: lg.id,
            });
          }
        } catch (pushErr) {
          logger.warn({ err: pushErr, memberId: memberIdNum }, "[payments/webhook] league member push failed");
        }
      }
    }
    // Wallet top-up reconciliation (Task #769): if /wallet/topup-verify never
    // landed (network drop, app close, signature mismatch), the webhook
    // becomes the back-up path that credits the wallet. Idempotent — the
    // helper checks for an existing ledger row keyed on paymentRef.
    if (notes.kind === "wallet_topup" && payment.id) {
      try {
        await creditWalletTopupFromPayment({
          paymentId: String(payment.id),
          orderId: payment.order_id ? String(payment.order_id) : null,
          amountMinor: Number(payment.amount) || 0,
          currency: String(payment.currency ?? "INR"),
          notes,
          note: "Wallet top-up (reconciled via webhook)",
        });
      } catch (err) {
        logger.warn({ err, paymentId: payment.id }, "[payments/webhook] wallet top-up reconciliation failed");
      }
    }
  }

  if (event.event === "payment_link.paid") {
    const notes = event.payload?.payment_link?.entity?.notes ?? {};
    const paymentId = (event.payload?.payment?.entity?.id ?? null) as string | null;
    const receiptBase = process.env.API_BASE_URL ?? process.env.RAZORPAY_CALLBACK_URL?.replace(/\/payments\/callback.*/, "") ?? "";
    if (notes.playerId) {
      const playerId = parseInt(notes.playerId);
      // Status-flip guard so duplicate payment_link.paid deliveries do not
      // re-fire the in-app push (Task #978).
      const flipped = await db.update(playersTable)
        .set({ paymentStatus: "paid", razorpayPaymentId: paymentId })
        .where(and(eq(playersTable.id, playerId), ne(playersTable.paymentStatus, "paid")))
        .returning({ id: playersTable.id });
      // Generate PDF receipt + send confirmation email for payment-link payments
      const [plRow] = await db.select({
        firstName: playersTable.firstName, lastName: playersTable.lastName,
        email: playersTable.email, tournamentId: playersTable.tournamentId,
        userId: playersTable.userId,
      }).from(playersTable).where(eq(playersTable.id, playerId));
      if (plRow) {
        const [plTour] = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name, entryFee: tournamentsTable.entryFee, currency: tournamentsTable.currency, organizationId: tournamentsTable.organizationId })
          .from(tournamentsTable).where(eq(tournamentsTable.id, plRow.tournamentId));
        if (plTour && plRow.email) {
          await sendReceiptEmail({
            email: plRow.email, name: `${plRow.firstName} ${plRow.lastName}`,
            eventName: plTour.name, eventType: "tournament",
            amountSubunit: Math.round(parseFloat(plTour.entryFee ?? "0") * 100),
            currency: plTour.currency, paymentId: paymentId ?? "payment_link",
            entityId: playerId, receiptBaseUrl: receiptBase,
          });
        }
        if (plTour && flipped.length > 0) {
          try {
            await notifyPaymentSettled({
              userId: plRow.userId,
              kind: "tournament",
              eventName: plTour.name,
              amountMinor: Math.round(parseFloat(plTour.entryFee ?? "0") * 100),
              currency: plTour.currency,
              paymentRef: paymentId ?? "payment_link",
              organizationId: plTour.organizationId,
              entityId: plTour.id,
            });
          } catch (pushErr) {
            logger.warn({ err: pushErr, playerId }, "[payments/webhook] tournament player payment-link push failed");
          }
        }
      }
    }
    if (notes.memberId) {
      const memberId = parseInt(notes.memberId);
      const flipped = await db.update(leagueMembersTable)
        .set({ paymentStatus: "paid", razorpayPaymentId: paymentId })
        .where(and(eq(leagueMembersTable.id, memberId), ne(leagueMembersTable.paymentStatus, "paid")))
        .returning({ id: leagueMembersTable.id });
      // Generate PDF receipt + send confirmation email for payment-link payments
      const [mbRow] = await db.select({
        firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName,
        email: leagueMembersTable.email, leagueId: leagueMembersTable.leagueId,
        userId: leagueMembersTable.userId,
      }).from(leagueMembersTable).where(eq(leagueMembersTable.id, memberId));
      if (mbRow) {
        const [mbLeague] = await db.select({ id: leaguesTable.id, name: leaguesTable.name, entryFee: leaguesTable.entryFee, currency: leaguesTable.currency, organizationId: leaguesTable.organizationId })
          .from(leaguesTable).where(eq(leaguesTable.id, mbRow.leagueId));
        if (mbLeague && mbRow.email) {
          await sendReceiptEmail({
            email: mbRow.email, name: `${mbRow.firstName} ${mbRow.lastName}`,
            eventName: mbLeague.name, eventType: "league",
            amountSubunit: Math.round(parseFloat(mbLeague.entryFee ?? "0") * 100),
            currency: mbLeague.currency, paymentId: paymentId ?? "payment_link",
            entityId: memberId, receiptBaseUrl: receiptBase,
          });
        }
        if (mbLeague && flipped.length > 0) {
          try {
            await notifyPaymentSettled({
              userId: mbRow.userId,
              kind: "league",
              eventName: mbLeague.name,
              amountMinor: Math.round(parseFloat(mbLeague.entryFee ?? "0") * 100),
              currency: mbLeague.currency,
              paymentRef: paymentId ?? "payment_link",
              organizationId: mbLeague.organizationId,
              entityId: mbLeague.id,
            });
          } catch (pushErr) {
            logger.warn({ err: pushErr, memberId }, "[payments/webhook] league member payment-link push failed");
          }
        }
      }
    }
  }

  if (event.event === "refund.processed") {
    const notes = event.payload?.refund?.entity?.notes ?? {};
    if (notes.playerId) {
      await db.update(playersTable)
        .set({ paymentStatus: "refunded", razorpayRefundId: event.payload?.refund?.entity?.id })
        .where(eq(playersTable.id, parseInt(notes.playerId)));
    }
  }

  res.json({ received: true });
});

// ─── GET /api/payments/tournament-player/:playerId/receipt ──────────────────
// Streams the stored PDF receipt for a paid tournament player entry.
// Accessible by: the player themselves (userId match) OR an org-admin.
router.get("/tournament-player/:playerId/receipt", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Unauthenticated" }); return; } }
  const caller = getSessionUser(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  if (isNaN(playerId)) { { res.status(400).json({ error: "Invalid player ID" }); return; } }

  const [player] = await db
    .select({ id: playersTable.id, tournamentId: playersTable.tournamentId, paymentStatus: playersTable.paymentStatus, userId: playersTable.userId })
    .from(playersTable).where(eq(playersTable.id, playerId));
  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }
  if (player.paymentStatus !== "paid") { { res.status(400).json({ error: "No receipt — player has not paid" }); return; } }

  const [tournament] = await db
    .select({ organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable).where(eq(tournamentsTable.id, player.tournamentId));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  // Allow the player themselves OR an org-admin
  const isOwnEntry = player.userId !== null && player.userId === caller.id;
  if (!isOwnEntry && !await requireOrgAdmin(req, res, tournament.organizationId)) return;

  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) { { res.status(503).json({ error: "Object storage not configured" }); return; } }

  const prefix = `player_${playerId}_`;
  const withoutScheme = privateDir.replace(/^gs:\/\//, "");
  const slashIdx = withoutScheme.indexOf("/");
  const bucketName = slashIdx === -1 ? withoutScheme : withoutScheme.slice(0, slashIdx);
  const dirPrefix = slashIdx === -1 ? "" : withoutScheme.slice(slashIdx + 1) + "/";
  const bucket = objectStorageClient.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix: `${dirPrefix}receipts/${prefix}` });
  if (!files.length) { { res.status(404).json({ error: "Receipt PDF not yet generated" }); return; } }
  const latest = files.sort((a, b) => a.name.localeCompare(b.name)).at(-1)!;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="receipt_player_${playerId}.pdf"`);
  latest.createReadStream().pipe(res);
});

// ─── GET /api/payments/league-member/:memberId/receipt ─────────────────────
// Accessible by: the member themselves (userId match) OR an org-admin.
router.get("/league-member/:memberId/receipt", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Unauthenticated" }); return; } }
  const caller = getSessionUser(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (isNaN(memberId)) { { res.status(400).json({ error: "Invalid member ID" }); return; } }

  const [member] = await db
    .select({ id: leagueMembersTable.id, leagueId: leagueMembersTable.leagueId, paymentStatus: leagueMembersTable.paymentStatus, userId: leagueMembersTable.userId })
    .from(leagueMembersTable).where(eq(leagueMembersTable.id, memberId));
  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }
  if (member.paymentStatus !== "paid") { { res.status(400).json({ error: "No receipt — member has not paid" }); return; } }

  const [league] = await db
    .select({ organizationId: leaguesTable.organizationId })
    .from(leaguesTable).where(eq(leaguesTable.id, member.leagueId));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }

  // Allow the member themselves OR an org-admin
  const isOwnEntry = member.userId !== null && member.userId === caller.id;
  if (!isOwnEntry && !await requireOrgAdmin(req, res, league.organizationId)) return;

  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) { { res.status(503).json({ error: "Object storage not configured" }); return; } }

  const prefix = `league_member_${memberId}_`;
  const withoutScheme = privateDir.replace(/^gs:\/\//, "");
  const slashIdx = withoutScheme.indexOf("/");
  const bucketName = slashIdx === -1 ? withoutScheme : withoutScheme.slice(0, slashIdx);
  const dirPrefix = slashIdx === -1 ? "" : withoutScheme.slice(slashIdx + 1) + "/";
  const bucket = objectStorageClient.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix: `${dirPrefix}receipts/${prefix}` });
  if (!files.length) { { res.status(404).json({ error: "Receipt PDF not yet generated" }); return; } }
  const latest = files.sort((a, b) => a.name.localeCompare(b.name)).at(-1)!;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="receipt_member_${memberId}.pdf"`);
  latest.createReadStream().pipe(res);
});

// ─── Helpers for shop & dues receipt streaming ─────────────────────────────

function parsePrivateBucket(): { bucketName: string; dirPrefix: string } | null {
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) return null;
  const withoutScheme = privateDir.replace(/^gs:\/\//, "");
  const slashIdx = withoutScheme.indexOf("/");
  const bucketName = slashIdx === -1 ? withoutScheme : withoutScheme.slice(0, slashIdx);
  const dirPrefix = slashIdx === -1 ? "" : withoutScheme.slice(slashIdx + 1) + "/";
  return { bucketName, dirPrefix };
}

async function findLatestStoredReceipt(prefix: string): Promise<Buffer | null> {
  const parsed = parsePrivateBucket();
  if (!parsed) return null;
  const bucket = objectStorageClient.bucket(parsed.bucketName);
  const [files] = await bucket.getFiles({ prefix: `${parsed.dirPrefix}receipts/${prefix}` });
  if (!files.length) return null;
  const latest = files.sort((a, b) => a.name.localeCompare(b.name)).at(-1)!;
  const [buf] = await latest.download();
  return buf;
}

// ─── GET /api/payments/shop-order/:orderId/receipt ─────────────────────────
// Streams the stored PDF receipt for a paid shop order. Falls back to
// regenerating the PDF on the fly if the stored copy is missing (e.g. the
// original generation failed silently). Accessible by: the buyer (userId or
// email match) OR an org-admin.
router.get("/shop-order/:orderId/receipt", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Unauthenticated" }); return; } }
  const caller = getSessionUser(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const orderId = parseInt(String((req.params as Record<string, string>).orderId));
  if (isNaN(orderId)) { { res.status(400).json({ error: "Invalid order ID" }); return; } }

  const [order] = await db.select({
    id: shopOrdersTable.id,
    organizationId: shopOrdersTable.organizationId,
    productId: shopOrdersTable.productId,
    userId: shopOrdersTable.userId,
    customerEmail: shopOrdersTable.customerEmail,
    customerName: shopOrdersTable.customerName,
    quantity: shopOrdersTable.quantity,
    size: shopOrdersTable.size,
    totalAmount: shopOrdersTable.totalAmount,
    currency: shopOrdersTable.currency,
    status: shopOrdersTable.status,
    razorpayPaymentId: shopOrdersTable.razorpayPaymentId,
    createdAt: shopOrdersTable.createdAt,
  }).from(shopOrdersTable).where(eq(shopOrdersTable.id, orderId));
  if (!order) { { res.status(404).json({ error: "Order not found" }); return; } }

  // Any status that indicates the buyer was charged at some point — including
  // "refunded" (the receipt is still useful as proof of the original charge).
  // Keep in sync with portal/index.tsx orders tab eligibility.
  const PAID_STATUSES = new Set(["paid", "processing", "shipped", "delivered", "returned", "exchanged", "refunded"]);
  if (!PAID_STATUSES.has(order.status)) { { res.status(400).json({ error: "No receipt — order has not been paid" }); return; } }

  // Ownership: order.userId match, customerEmail match against caller's app_users email, or org-admin
  let isOwn = order.userId !== null && order.userId === caller.id;
  if (!isOwn && order.customerEmail) {
    const [u] = await db.select({ email: appUsersTable.email }).from(appUsersTable).where(eq(appUsersTable.id, caller.id));
    if (u?.email && u.email.toLowerCase() === order.customerEmail.toLowerCase()) isOwn = true;
  }
  if (!isOwn && !await requireOrgAdmin(req, res, order.organizationId)) return;

  // Try stored copy first
  let pdfBuffer: Buffer | null = null;
  try {
    pdfBuffer = await findLatestStoredReceipt(`shop_order_${orderId}_`);
  } catch (err) {
    logger.warn({ err, orderId }, "[payments] shop receipt lookup failed");
  }

  // Fallback: regenerate on the fly
  if (!pdfBuffer) {
    const [product] = await db.select({ name: shopProductsTable.name }).from(shopProductsTable).where(eq(shopProductsTable.id, order.productId));
    const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl }).from(organizationsTable).where(eq(organizationsTable.id, order.organizationId));
    const totalSubunit = Math.round(parseFloat(String(order.totalAmount ?? "0")) * 100);
    const sizeLabel = order.size ? ` (${order.size})` : "";
    const lineItems: ReceiptLineItem[] = [{
      description: `${product?.name ?? `Item #${order.id}`}${sizeLabel}`,
      quantity: order.quantity,
      totalAmountSubunit: totalSubunit,
    }];
    try {
      pdfBuffer = await generateItemisedReceiptPDF({
        title: "Order Receipt",
        documentRef: `Order #${order.id}`,
        buyerName: order.customerName,
        email: order.customerEmail,
        lineItems,
        totalSubunit,
        currency: order.currency || "INR",
        currencySymbol: currencySymbol(order.currency || "INR"),
        paymentId: order.razorpayPaymentId ?? `shop:${order.id}`,
        paidAt: order.createdAt,
        productLine: "Pro Shop",
        footerNote: "Keep this receipt for warranty, returns, and expense reporting.",
        orgName: org?.name ?? null,
        orgLogoUrl: org?.logoUrl ?? null,
      });
      // Best-effort store so subsequent downloads are fast
      storeReceiptPDF(pdfBuffer, "shop_order", order.id).catch((err) =>
        logger.warn({ err, orderId }, "[payments] shop receipt re-store failed (non-fatal)"),
      );
    } catch (err) {
      logger.error({ err, orderId }, "[payments] shop receipt regeneration failed");
      res.status(500).json({ error: "Failed to generate receipt" }); return;
    }
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="receipt_order_${orderId}.pdf"`);
  res.send(pdfBuffer);
});

// ─── GET /api/payments/dues-invoice/:invoiceId/receipt ─────────────────────
// Streams the stored PDF receipt for a paid dues invoice. Falls back to
// regenerating the PDF on the fly if missing. Accessible by: the member
// themselves (linked userId or email match) OR an org-admin.
router.get("/dues-invoice/:invoiceId/receipt", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Unauthenticated" }); return; } }
  const caller = getSessionUser(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const invoiceId = parseInt(String((req.params as Record<string, string>).invoiceId));
  if (isNaN(invoiceId)) { { res.status(400).json({ error: "Invalid invoice ID" }); return; } }

  const [invoice] = await db.select({
    id: memberInvoicesTable.id,
    organizationId: memberInvoicesTable.organizationId,
    clubMemberId: memberInvoicesTable.clubMemberId,
    invoiceNumber: memberInvoicesTable.invoiceNumber,
    status: memberInvoicesTable.status,
    totalAmount: memberInvoicesTable.totalAmount,
    currency: memberInvoicesTable.currency,
    paidAt: memberInvoicesTable.paidAt,
    razorpayPaymentId: memberInvoicesTable.razorpayPaymentId,
  }).from(memberInvoicesTable).where(eq(memberInvoicesTable.id, invoiceId));
  if (!invoice) { { res.status(404).json({ error: "Invoice not found" }); return; } }
  if (invoice.status !== "paid") { { res.status(400).json({ error: "No receipt — invoice has not been paid" }); return; } }

  const [member] = await db.select({
    userId: clubMembersTable.userId,
    email: clubMembersTable.email,
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
  }).from(clubMembersTable).where(eq(clubMembersTable.id, invoice.clubMemberId));

  // Ownership: linked userId match, email match against caller's app_users email, or org-admin
  let isOwn = !!member && member.userId !== null && member.userId === caller.id;
  if (!isOwn && member?.email) {
    const [u] = await db.select({ email: appUsersTable.email }).from(appUsersTable).where(eq(appUsersTable.id, caller.id));
    if (u?.email && u.email.toLowerCase() === member.email.toLowerCase()) isOwn = true;
  }
  if (!isOwn && !await requireOrgAdmin(req, res, invoice.organizationId)) return;

  let pdfBuffer: Buffer | null = null;
  try {
    pdfBuffer = await findLatestStoredReceipt(`dues_invoice_${invoiceId}_`);
  } catch (err) {
    logger.warn({ err, invoiceId }, "[payments] dues receipt lookup failed");
  }

  if (!pdfBuffer) {
    const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl }).from(organizationsTable).where(eq(organizationsTable.id, invoice.organizationId));
    const totalSubunit = Math.round(parseFloat(String(invoice.totalAmount ?? "0")) * 100);
    const lineItemRows = await db.select({
      description: invoiceLineItemsTable.description,
      quantity: invoiceLineItemsTable.quantity,
      totalAmount: invoiceLineItemsTable.totalAmount,
    }).from(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, invoiceId)).orderBy(asc(invoiceLineItemsTable.id));

    const lineItems: ReceiptLineItem[] = lineItemRows.length > 0
      ? lineItemRows.map((li) => ({
          description: li.description,
          quantity: Math.max(1, Math.round(parseFloat(String(li.quantity ?? "1")))),
          totalAmountSubunit: Math.round(parseFloat(String(li.totalAmount ?? "0")) * 100),
        }))
      : [{ description: `Membership dues — ${invoice.invoiceNumber}`, quantity: 1, totalAmountSubunit: totalSubunit }];

    const memberName = member ? `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim() : "Member";
    try {
      pdfBuffer = await generateItemisedReceiptPDF({
        title: "Dues Receipt",
        documentRef: `Invoice ${invoice.invoiceNumber}`,
        buyerName: memberName || "Member",
        email: member?.email ?? "",
        lineItems,
        totalSubunit,
        currency: invoice.currency || "INR",
        currencySymbol: currencySymbol(invoice.currency || "INR"),
        paymentId: invoice.razorpayPaymentId ?? `dues:${invoice.id}`,
        paidAt: invoice.paidAt ?? new Date(),
        productLine: "Membership Dues",
        footerNote: "Retain this receipt for your records and expense reports.",
        orgName: org?.name ?? null,
        orgLogoUrl: org?.logoUrl ?? null,
      });
      storeReceiptPDF(pdfBuffer, "dues_invoice", invoice.id).catch((err) =>
        logger.warn({ err, invoiceId }, "[payments] dues receipt re-store failed (non-fatal)"),
      );
    } catch (err) {
      logger.error({ err, invoiceId }, "[payments] dues receipt regeneration failed");
      res.status(500).json({ error: "Failed to generate receipt" }); return;
    }
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="receipt_invoice_${invoice.invoiceNumber}.pdf"`);
  res.send(pdfBuffer);
});

export default router;
