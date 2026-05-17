import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  posTransactionsTable, posTransactionItemsTable, memberAccountChargesTable,
  shopProductsTable, shopProductVariantsTable, shopOrdersTable, clubMembersTable, orgMembershipsTable,
  vendorFacilityAssignmentsTable, vendorOperatorsTable,
  shopReturnsTable, shopReturnItemsTable, shopOrderEventsTable,
  shopLocationsTable, shopVariantStockTable, shopStockAdjustmentsTable,
  promotionsTable, promotionRedemptionsTable, affiliateCodesTable, affiliateRedemptionsTable,
  giftCardsTable, giftCardRedemptionsTable,
  shopBundlesTable, shopBundleComponentsTable,
} from "@workspace/db";
import { eq, and, desc, gte, lte, lt, sum, count, sql, inArray, or, ilike } from "drizzle-orm";
import nodemailer from "nodemailer";
import { awardPoints } from "./loyalty";
import { attributePosCommission } from "./commissions";
import { createGstInvoice, getOrgGstSettings } from "../lib/gstInvoice";
import { logger } from "../lib/logger";
import { evaluateCartDiscounts } from "./promotions";
import { resolveOrgTaxes, getOrgCurrencyContext } from "../lib/checkout";
import { selectProcessor } from "../lib/paymentProcessor";

const router: IRouter = Router({ mergeParams: true });

async function requireOrgAdminOrProShop(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  const user = req.user as { id: number; role?: string; organizationId?: number };
  if (user.role === "super_admin") return true;
  if (
    (user.role === "org_admin" || user.role === "tournament_director" || user.role === "pro_shop") &&
    Number(user.organizationId) === orgId
  ) return true;

  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
    ));

  if (!membership || !["org_admin", "tournament_director", "pro_shop"].includes(membership.role)) {
    res.status(403).json({ error: "Pro shop or admin access required." });
    return false;
  }
  return true;
}

/**
 * Returns the vendorOperatorId scoped to a pro_shop user's membership,
 * or null if the user is an admin (all-access) or has no vendor scope.
 */
async function getVendorScopeForUser(userId: number, orgId: number): Promise<number | null> {
  const user = await db
    .select({ vendorOperatorId: orgMembershipsTable.vendorOperatorId, role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.userId, userId), eq(orgMembershipsTable.organizationId, orgId)))
    .limit(1);
  if (!user[0]) return null;
  // Admins have no vendor scope restriction
  if (["org_admin", "tournament_director"].includes(user[0].role)) return null;
  return user[0].vendorOperatorId ?? null;
}

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  const user = req.user as { id: number; role?: string; organizationId?: number };
  if (user.role === "super_admin") return true;
  if ((user.role === "org_admin" || user.role === "tournament_director") && Number(user.organizationId) === orgId) return true;

  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
    ));

  if (!membership || !["org_admin", "tournament_director"].includes(membership.role)) {
    res.status(403).json({ error: "Admin access required." });
    return false;
  }
  return true;
}

function generateReceiptNumber(orgId: number): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `POS-${orgId}-${dateStr}-${rand}`;
}

// ─── PRODUCTS (POS-optimised listing) ─────────────────────────────────────────

// GET /organizations/:orgId/pos/products
// Returns both individual products AND active bundles (marked with isBundle:true).
// Bundles appear at the end of the list and can be added to cart like any product —
// the checkout endpoint handles stock decrement of all bundle components.
router.get("/products", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const { category, q } = req.query;

  const conditions = [
    eq(shopProductsTable.organizationId, orgId),
    eq(shopProductsTable.isActive, true),
  ];
  if (category && typeof category === "string" && category !== "bundles") {
    conditions.push(eq(shopProductsTable.category, category));
  }
  if (q && typeof q === "string" && q.trim()) {
    conditions.push(ilike(shopProductsTable.name, `%${q.trim()}%`));
  }

  // Only return regular products when a non-bundle category is filtered
  const regularProducts = category === "bundles" ? [] : await db
    .select({
      id: shopProductsTable.id,
      organizationId: shopProductsTable.organizationId,
      name: shopProductsTable.name,
      description: shopProductsTable.description,
      imageUrl: shopProductsTable.imageUrl,
      category: shopProductsTable.category,
      basePrice: shopProductsTable.basePrice,
      markupPrice: shopProductsTable.markupPrice,
      currency: shopProductsTable.currency,
      sizes: shopProductsTable.sizes,
      isActive: shopProductsTable.isActive,
      stockCount: shopProductsTable.stockCount,
      createdAt: shopProductsTable.createdAt,
    })
    .from(shopProductsTable)
    .where(and(...conditions))
    .orderBy(shopProductsTable.category, shopProductsTable.name);

  // Bundles: fetch active bundles for this org (optionally filtered by name search)
  const bundleConditions = [
    eq(shopBundlesTable.organizationId, orgId),
    eq(shopBundlesTable.isActive, true),
  ];
  if (q && typeof q === "string" && q.trim()) {
    bundleConditions.push(ilike(shopBundlesTable.name, `%${q.trim()}%`));
  }

  const bundles = await db.select().from(shopBundlesTable).where(and(...bundleConditions));

  // Shape bundles into the same structure as products so the POS UI can render them uniformly.
  // isBundle:true and bundleId are set so the checkout handler knows to decrement components.
  const bundleProducts = bundles.map(b => ({
    id: -(b.id),           // negative id to avoid collision with product ids in the UI
    bundleId: b.id,        // the real bundle id for checkout
    organizationId: orgId,
    name: b.name,
    description: b.description ?? null,
    imageUrl: b.imageUrl ?? null,
    category: "bundle" as const,
    basePrice: b.price,
    markupPrice: b.price,
    currency: b.currency,
    sizes: [],
    isActive: b.isActive,
    stockCount: null,
    createdAt: b.createdAt,
    variants: [],
    isBundle: true,
  }));

  res.json([
    ...regularProducts.map(p => ({ ...p, variants: [], isBundle: false })),
    ...bundleProducts,
  ]);
});

// ─── MEMBER LOOKUP ─────────────────────────────────────────────────────────────

// GET /organizations/:orgId/pos/members/search?q=
router.get("/members/search", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const { q } = req.query;
  if (!q || typeof q !== "string" || !q.trim()) {
    res.json([]);
    return;
  }

  const term = q.trim();
  const members = await db
    .select({
      id: clubMembersTable.id,
      memberNumber: clubMembersTable.memberNumber,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      email: clubMembersTable.email,
      phone: clubMembersTable.phone,
      subscriptionStatus: clubMembersTable.subscriptionStatus,
    })
    .from(clubMembersTable)
    .where(and(
      eq(clubMembersTable.organizationId, orgId),
      or(
        ilike(clubMembersTable.firstName, `%${term}%`),
        ilike(clubMembersTable.lastName, `%${term}%`),
        ilike(clubMembersTable.email, `%${term}%`),
        ilike(clubMembersTable.memberNumber, `%${term}%`),
      ),
    ))
    .limit(20);

  res.json(members);
});

// GET /organizations/:orgId/pos/members/:memberId/balance
router.get("/members/:memberId/balance", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const [member] = await db
    .select({
      id: clubMembersTable.id,
      memberNumber: clubMembersTable.memberNumber,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
    })
    .from(clubMembersTable)
    .where(and(eq(clubMembersTable.id, memberId), eq(clubMembersTable.organizationId, orgId)));

  if (!member) {
    res.status(404).json({ error: "Member not found." });
    return;
  }

  const [balRow] = await db
    .select({ outstanding: sum(memberAccountChargesTable.amount) })
    .from(memberAccountChargesTable)
    .where(and(
      eq(memberAccountChargesTable.clubMemberId, memberId),
      eq(memberAccountChargesTable.organizationId, orgId),
      eq(memberAccountChargesTable.isSettled, false),
    ));

  res.json({
    member,
    outstandingBalance: parseFloat(balRow?.outstanding ?? "0") || 0,
  });
});

// ─── TRANSACTIONS ─────────────────────────────────────────────────────────────

// POST /organizations/:orgId/pos/transactions
router.post("/transactions", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const user = req.user as { id: number };
  const {
    items, // Array<{ productId?, variantId?, productName, category, sku, quantity, unitPrice, discountPct }>
    paymentMethod, // "cash" | "razorpay_pos" | "member_account" | "gift_card" | "split_gift_card_cash"
    clubMemberId,
    memberName,
    customerName,
    customerEmail,
    buyerGstin,       // optional GSTIN for B2B POS transactions (passed to GST invoice only)
    memberDiscountPct = 0,
    notes,
    razorpayPaymentId,
    facilityType = "pro_shop", // optional: context hint for multi-facility orgs
    locationId: requestedLocationId, // explicit fulfillment location from POS terminal
    promoCode,
    affiliateCode,
    // Gift card fields
    giftCardCode,     // the card code to redeem (required for gift_card / split_gift_card_cash)
    giftCardAmountApplied: giftCardAmountAppliedRaw, // INR amount to charge against the gift card (required for split)
  } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "Cart is empty." });
    return;
  }
  if (!["cash", "razorpay_pos", "member_account", "gift_card", "split_gift_card_cash"].includes(paymentMethod)) {
    res.status(400).json({ error: "Invalid payment method." });
    return;
  }
  if (paymentMethod === "member_account" && !clubMemberId) {
    res.status(400).json({ error: "Member ID required for account charges." });
    return;
  }
  if ((paymentMethod === "gift_card" || paymentMethod === "split_gift_card_cash") && !giftCardCode) {
    res.status(400).json({ error: "Gift card code required." });
    return;
  }

  // Verify that any supplied clubMemberId actually belongs to this org
  if (clubMemberId) {
    const [memberCheck] = await db
      .select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(and(eq(clubMembersTable.id, clubMemberId), eq(clubMembersTable.organizationId, orgId)));
    if (!memberCheck) {
      res.status(403).json({ error: "Member does not belong to this organisation." });
      return;
    }
  }

  let subtotal = 0;
  const lineItems = items.map((item: {
    productId?: number;
    variantId?: number;
    bundleId?: number;
    productName: string;
    category?: string;
    sku?: string;
    quantity: number;
    unitPrice: number;
    discountPct?: number;
  }) => {
    const discPct = typeof item.discountPct === "number" ? item.discountPct : memberDiscountPct;
    const qty = Math.max(1, parseInt(String(item.quantity)));
    const unitPrice = parseFloat(String(item.unitPrice));
    const lineTotal = +(unitPrice * qty * (1 - discPct / 100)).toFixed(2);
    subtotal += lineTotal;
    return {
      productId: item.productId ?? null,
      variantId: item.variantId ?? null,
      bundleId: item.bundleId ?? null,
      productName: item.productName,
      category: item.category ?? null,
      sku: item.sku ?? null,
      quantity: qty,
      unitPrice: String(unitPrice),
      discountPct: String(discPct),
      lineTotal: String(lineTotal),
    };
  });

  // POS payment-method routing: terminal flows (cash / member_account /
  // gift_card) are settled outside any online processor and do NOT require
  // gateway selection. The digital "razorpay_pos" flow, however, captures
  // funds via an online PSP terminal — for non-INR clubs that means Stripe,
  // not Razorpay. We invoke selectProcessor() to validate and stamp the
  // actual processor used so the transaction record (and downstream reporting)
  // reflects the correct gateway. FX-ledger entries are not recorded here:
  // amount and currency are already in the org's base currency by the time
  // a POS terminal captures them.
  let posResolvedProcessor: "razorpay" | "stripe" | "manual" | null = null;
  if (paymentMethod === "razorpay_pos") {
    try {
      const orgCtxForRouting = await getOrgCurrencyContext(orgId);
      const proc = await selectProcessor(orgId, orgCtxForRouting.baseCurrency);
      posResolvedProcessor = proc.name;
      logger.info(
        { orgId, currency: orgCtxForRouting.baseCurrency, processor: proc.name },
        "[pos] digital terminal payment routed via processor abstraction",
      );
    } catch (err) {
      // Routing lookup failed — do not block the sale. We still record the
      // sale; the persisted transaction will lack a [processor:*] tag.
      logger.warn({ err, orgId }, "[pos] processor routing lookup failed");
    }
  }

  // Resolve tax via the multi-jurisdiction tax engine. POS prices are
  // tax-inclusive, so we use the engine to discover the effective rate
  // (sum of component rates) for the org's default tax profile and then
  // back-derive the inclusive tax. INR/GST profiles continue to route
  // through resolveGstTax internally; non-GST orgs (future) get the
  // correct VAT/sales-tax rate. Fallback: 18% (legacy behaviour).
  let gstRate = 18;
  try {
    const orgCtx = await getOrgCurrencyContext(orgId);
    const taxResult = await resolveOrgTaxes({
      organizationId: orgId,
      taxableAmount: subtotal,
      currency: orgCtx.baseCurrency,
      productClass: "pos",
    });
    const effectiveRate = taxResult.components.reduce((sum, c) => sum + (c.ratePct ?? 0), 0);
    if (effectiveRate > 0) gstRate = effectiveRate;
    else if (taxResult.jurisdictionKind === "none" || taxResult.routing === "exempt" || taxResult.routing === "zero_rated") gstRate = 0;
  } catch (err) {
    logger.warn({ err }, "[pos] tax engine resolution failed — using 18% default");
  }
  const taxAmount = +(subtotal * gstRate / (100 + gstRate)).toFixed(2);

  // Resolve customer's userId from clubMemberId (not staff user.id) for member-tier pricing
  let customerUserId: number | undefined;
  if (clubMemberId) {
    try {
      const [member] = await db.select({ userId: clubMembersTable.userId })
        .from(clubMembersTable)
        .where(and(eq(clubMembersTable.id, clubMemberId), eq(clubMembersTable.organizationId, orgId)));
      customerUserId = member?.userId ?? undefined;
    } catch (err) {
      console.warn("[pos] could not resolve customer userId from club member:", err instanceof Error ? err.message : err);
    }
  }

  // Always run promotions engine to auto-apply flash/bundle/promo/affiliate + member discount for customer
  // NOTE: Pass effective post-manual-discount unit prices to avoid double-discounting.
  //       If the POS operator already applied a discountPct (e.g. manual member rate), the engine
  //       sees the already-reduced price, so it will only add incremental discounts (promos, flash, etc.).
  let promoDiscountAmount = 0;
  let promoDiscountBreakdown: Array<{ label: string; amount: number }> = [];
  let evalStackingPolicy = "none";
  let appliedPromoId: number | undefined;
  let appliedAffiliateCodeId: number | undefined;
  let appliedAffiliateCommission = 0;
  try {
    const evalItems = lineItems.map(li => ({
      productId: li.productId ?? 0,
      variantId: li.variantId ?? undefined,
      qty: li.quantity,
      // Use effective price (post-manual-discount) so engine doesn't double-apply member discounts
      unitPrice: +(parseFloat(String(li.lineTotal)) / li.quantity).toFixed(4),
      category: li.category ?? "general",
    }));
    const evalResult = await evaluateCartDiscounts({
      orgId,
      userId: customerUserId, // Customer's userId, not staff user.id
      items: evalItems,
      cartTotal: subtotal,
      promoCode: promoCode || undefined,
      affiliateCode: affiliateCode || undefined,
    });
    promoDiscountAmount = evalResult.discountTotal;
    promoDiscountBreakdown = evalResult.discounts.map(d => ({ label: d.label, amount: d.amount }));
    evalStackingPolicy = evalResult.stackingPolicy;
    appliedPromoId = evalResult.promoId;
    appliedAffiliateCodeId = evalResult.affiliateCodeId;
    appliedAffiliateCommission = evalResult.affiliateCommission ?? 0;
  } catch (err) {
    console.warn("[pos] discount engine error — proceeding without automatic discounts:", err instanceof Error ? err.message : err);
  }

  const discountAmount = promoDiscountAmount;
  const totalAmount = +(Math.max(0, subtotal - discountAmount)).toFixed(2);

  // ── GIFT CARD PRE-VALIDATION ──────────────────────────────────────────────
  // Look up and validate the gift card before inserting the transaction.
  // This prevents partial-state if the card is invalid/exhausted.
  let resolvedGiftCard: typeof giftCardsTable.$inferSelect | null = null;
  let giftCardAmountAppliedPaise = 0; // always in paise internally

  if (paymentMethod === "gift_card" || paymentMethod === "split_gift_card_cash") {
    const [card] = await db
      .select()
      .from(giftCardsTable)
      .where(and(
        eq(giftCardsTable.organizationId, orgId),
        eq(giftCardsTable.code, String(giftCardCode).trim().toUpperCase()),
      ));

    if (!card) {
      res.status(404).json({ error: "Gift card not found." });
      return;
    }
    if (card.status !== "active") {
      res.status(400).json({ error: `Gift card is ${card.status}.` });
      return;
    }
    if (card.expiresAt && card.expiresAt < new Date()) {
      res.status(400).json({ error: "Gift card has expired." });
      return;
    }

    // Determine how many paise to redeem against this card:
    // - For pure gift_card: redeem the full totalAmount (the card must cover it all)
    // - For split: caller provides giftCardAmountApplied (INR), we charge that much from the card
    const desiredAmountPaise = paymentMethod === "gift_card"
      ? Math.round(totalAmount * 100)
      : Math.round((parseFloat(String(giftCardAmountAppliedRaw ?? 0))) * 100);

    if (desiredAmountPaise <= 0) {
      res.status(400).json({ error: "Gift card redemption amount must be positive." });
      return;
    }
    // Guard: gift card amount applied may never exceed the transaction total
    const totalAmountPaise = Math.round(totalAmount * 100);
    if (desiredAmountPaise > totalAmountPaise) {
      res.status(400).json({
        error: `Gift card amount applied (₹${(desiredAmountPaise / 100).toFixed(2)}) exceeds transaction total (₹${(totalAmountPaise / 100).toFixed(2)}).`,
      });
      return;
    }
    if (card.currentBalancePaise < desiredAmountPaise) {
      res.status(400).json({
        error: `Insufficient gift card balance. Available: ₹${(card.currentBalancePaise / 100).toFixed(2)}, required: ₹${(desiredAmountPaise / 100).toFixed(2)}.`,
      });
      return;
    }

    resolvedGiftCard = card;
    giftCardAmountAppliedPaise = desiredAmountPaise;
  }

  const receiptNumber = generateReceiptNumber(orgId);

  const [transaction] = await db.insert(posTransactionsTable).values({
    organizationId: orgId,
    receiptNumber,
    staffUserId: user.id,
    clubMemberId: clubMemberId ?? null,
    memberName: memberName ?? null,
    customerName: customerName ?? null,
    customerEmail: customerEmail ?? null,
    paymentMethod,
    subtotal: String(subtotal.toFixed(2)),
    discountAmount: String(discountAmount.toFixed(2)),
    taxAmount: String(taxAmount),
    totalAmount: String(totalAmount),
    status: "completed",
    razorpayPaymentId: razorpayPaymentId ?? null,
    // Persist the resolved gateway alongside the operator-supplied notes so
    // downstream reporting can distinguish Razorpay POS from Stripe Terminal
    // captures even though the constrained payment_method enum still reads
    // "razorpay_pos" for both.
    notes: posResolvedProcessor
      ? `${notes ? notes + " " : ""}[processor:${posResolvedProcessor}]`
      : (notes ?? null),
    giftCardId: resolvedGiftCard?.id ?? null,
    giftCardAmountApplied: giftCardAmountAppliedPaise > 0 ? String((giftCardAmountAppliedPaise / 100).toFixed(2)) : null,
  }).returning();

  await db.insert(posTransactionItemsTable).values(
    lineItems.map(({ bundleId: _bundleId, ...li }) => ({ ...li, transactionId: transaction.id }))
  );

  // ── GIFT CARD REDEMPTION ──────────────────────────────────────────────────
  if (resolvedGiftCard && giftCardAmountAppliedPaise > 0) {
    const [updatedCard] = await db.update(giftCardsTable)
      .set({
        currentBalancePaise: sql`${giftCardsTable.currentBalancePaise} - ${giftCardAmountAppliedPaise}`,
        status: sql`CASE WHEN ${giftCardsTable.currentBalancePaise} - ${giftCardAmountAppliedPaise} <= 0 THEN 'redeemed' ELSE 'active' END`,
        redeemedAt: sql`CASE WHEN ${giftCardsTable.currentBalancePaise} - ${giftCardAmountAppliedPaise} <= 0 THEN NOW() ELSE ${giftCardsTable.redeemedAt} END`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(giftCardsTable.id, resolvedGiftCard.id),
        gte(giftCardsTable.currentBalancePaise, giftCardAmountAppliedPaise), // atomic guard
      ))
      .returning({ id: giftCardsTable.id, currentBalancePaise: giftCardsTable.currentBalancePaise });

    if (!updatedCard) {
      // Concurrent depletion detected — void this transaction.
      await db.update(posTransactionsTable)
        .set({ status: "voided", notes: sql`COALESCE(${posTransactionsTable.notes} || ' | ', '') || 'VOIDED: gift card concurrent depletion'` })
        .where(eq(posTransactionsTable.id, transaction.id));
      res.status(409).json({
        error: "Gift card balance was depleted by a concurrent transaction. Please scan the card again or choose a different payment method.",
      });
      return;
    }

    const balanceBefore = resolvedGiftCard.currentBalancePaise;
    const balanceAfter = updatedCard.currentBalancePaise;

    await db.insert(giftCardRedemptionsTable).values({
      giftCardId: resolvedGiftCard.id,
      organizationId: orgId,
      amountPaise: giftCardAmountAppliedPaise,
      balanceBeforePaise: balanceBefore,
      balanceAfterPaise: balanceAfter,
      redeemedByUserId: user.id,
      posTransactionId: transaction.id,
      notes: `POS sale — receipt ${transaction.receiptNumber}`,
    });
  }

  // Resolve the fulfillment location — use the POS-selected location if provided and org-owned,
  // otherwise fall back to the org's default location.
  let fulfillmentLocationId: number | null = null;
  if (requestedLocationId) {
    const [reqLoc] = await db.select({ id: shopLocationsTable.id })
      .from(shopLocationsTable)
      .where(and(eq(shopLocationsTable.organizationId, orgId), eq(shopLocationsTable.id, Number(requestedLocationId))));
    fulfillmentLocationId = reqLoc?.id ?? null;
  }
  if (!fulfillmentLocationId) {
    const [defaultLoc] = await db.select({ id: shopLocationsTable.id })
      .from(shopLocationsTable)
      .where(and(eq(shopLocationsTable.organizationId, orgId), eq(shopLocationsTable.isDefault, true)));
    fulfillmentLocationId = defaultLoc?.id ?? null;
  }

  for (const item of lineItems) {
    if (item.productId) {
      await db
        .update(shopProductsTable)
        .set({ stockCount: sql`CASE WHEN ${shopProductsTable.stockCount} IS NOT NULL THEN GREATEST(0, ${shopProductsTable.stockCount} - ${item.quantity}) ELSE NULL END` })
        .where(and(
          eq(shopProductsTable.id, item.productId),
          eq(shopProductsTable.organizationId, orgId),
        ));
    }
    // Decrement per-location variant stock and write audit record.
    // Upsert to ensure a stock row always exists before decrementing —
    // prevents silent no-op when no row exists for this variant+location pair.
    if (item.variantId && fulfillmentLocationId) {
      // Guard: verify the variant belongs to this org before any stock mutation
      const [variantOwnerCheck] = await db.select({ id: shopProductVariantsTable.id })
        .from(shopProductVariantsTable)
        .innerJoin(shopProductsTable, eq(shopProductVariantsTable.productId, shopProductsTable.id))
        .where(and(
          eq(shopProductVariantsTable.id, item.variantId),
          eq(shopProductsTable.organizationId, orgId),
        )).limit(1);
      if (!variantOwnerCheck) {
        // Skip this item's per-location deduction — variant doesn't belong to this org
        continue;
      }
      const existingStockRow = await db.select({ qty: shopVariantStockTable.quantity })
        .from(shopVariantStockTable)
        .where(and(
          eq(shopVariantStockTable.variantId, item.variantId),
          eq(shopVariantStockTable.locationId, fulfillmentLocationId),
        ));
      if (existingStockRow.length === 0) {
        await db.insert(shopVariantStockTable).values({
          variantId: item.variantId,
          locationId: fulfillmentLocationId,
          quantity: 0,
        });
      }
      // Deduct full sold quantity — allow negative to keep per-location ledger consistent.
      // Negative location stock is a visible signal of oversell rather than a silent cap.
      await db.update(shopVariantStockTable)
        .set({ quantity: sql`${shopVariantStockTable.quantity} - ${item.quantity}`, updatedAt: new Date() })
        .where(and(
          eq(shopVariantStockTable.variantId, item.variantId),
          eq(shopVariantStockTable.locationId, fulfillmentLocationId),
        ));
      await db.insert(shopStockAdjustmentsTable).values({
        organizationId: orgId,
        variantId: item.variantId,
        locationId: fulfillmentLocationId,
        qtyDelta: -item.quantity,
        type: "sale",
        reason: `POS sale — receipt ${receiptNumber}`,
        referenceId: String(transaction.id),
        createdByUserId: user.id,
      });
    }

    if (item.bundleId) {
      const components = await db
        .select({
          variantId: shopBundleComponentsTable.variantId,
          productId: shopBundleComponentsTable.productId,
          quantity: shopBundleComponentsTable.quantity,
        })
        .from(shopBundleComponentsTable)
        .innerJoin(shopBundlesTable, eq(shopBundleComponentsTable.bundleId, shopBundlesTable.id))
        .where(and(
          eq(shopBundleComponentsTable.bundleId, item.bundleId),
          eq(shopBundlesTable.organizationId, orgId),
        ));

      for (const comp of components) {
        const decrementQty = comp.quantity * item.quantity;
        // Decrement variant-level stockQty
        if (comp.variantId) {
          await db.update(shopProductVariantsTable)
            .set({ stockQty: sql`GREATEST(0, ${shopProductVariantsTable.stockQty} - ${decrementQty})` })
            .where(eq(shopProductVariantsTable.id, comp.variantId));
          // Also decrement per-location stock if we have a location
          if (fulfillmentLocationId) {
            await db.update(shopVariantStockTable)
              .set({ quantity: sql`${shopVariantStockTable.quantity} - ${decrementQty}`, updatedAt: new Date() })
              .where(and(
                eq(shopVariantStockTable.variantId, comp.variantId),
                eq(shopVariantStockTable.locationId, fulfillmentLocationId),
              ));
            await db.insert(shopStockAdjustmentsTable).values({
              organizationId: orgId,
              variantId: comp.variantId,
              locationId: fulfillmentLocationId,
              qtyDelta: -decrementQty,
              type: "sale",
              reason: `Bundle sale (bundle#${item.bundleId}) — receipt ${receiptNumber}`,
              referenceId: String(transaction.id),
              createdByUserId: user.id,
            }).catch(() => {}); // Non-critical audit trail
          }
        }
        // Decrement product-level stockCount for non-variant components
        if (comp.productId && !comp.variantId) {
          await db.update(shopProductsTable)
            .set({ stockCount: sql`CASE WHEN ${shopProductsTable.stockCount} IS NOT NULL THEN GREATEST(0, ${shopProductsTable.stockCount} - ${decrementQty}) ELSE NULL END` })
            .where(and(eq(shopProductsTable.id, comp.productId), eq(shopProductsTable.organizationId, orgId)));
        }
      }
    }
  }

  // Record promo/affiliate redemptions for POS transactions — only when the engine actually applied the code
  // orderId is null for POS transactions since promotion_redemptions.order_id references shopOrdersTable
  if (appliedPromoId) {
    try {
      const promoEntry = promoDiscountBreakdown.find(d => d.label.toLowerCase().includes("promo") || d.label.toLowerCase().includes("coupon"));
      const promoSaving = promoEntry?.amount ?? 0;
      await db.update(promotionsTable)
        .set({ usedCount: sql`${promotionsTable.usedCount} + 1` })
        .where(eq(promotionsTable.id, appliedPromoId));
      await db.insert(promotionRedemptionsTable)
        .values({
          promotionId: appliedPromoId,
          organizationId: orgId,
          userId: customerUserId ?? null,
          orderId: null,
          discountAmount: String(promoSaving.toFixed(2)),
        })
        .onConflictDoNothing();
    } catch (err) {
      console.warn("[pos] promo redemption tracking failed:", err instanceof Error ? err.message : err);
    }
  }
  if (appliedAffiliateCodeId) {
    try {
      const affEntry = promoDiscountBreakdown.find(d => d.label.toLowerCase().includes("referral") || d.label.toLowerCase().includes("affiliate"));
      const affDiscount = affEntry?.amount ?? 0;
      await db.update(affiliateCodesTable)
        .set({
          totalOrders: sql`${affiliateCodesTable.totalOrders} + 1`,
          totalDiscountGiven: sql`${affiliateCodesTable.totalDiscountGiven} + ${String(affDiscount.toFixed(2))}`,
          totalCommissionEarned: sql`${affiliateCodesTable.totalCommissionEarned} + ${String(appliedAffiliateCommission.toFixed(2))}`,
        })
        .where(eq(affiliateCodesTable.id, appliedAffiliateCodeId));
      await db.insert(affiliateRedemptionsTable).values({
        affiliateCodeId: appliedAffiliateCodeId,
        organizationId: orgId,
        orderId: null,
        userId: customerUserId ?? null,
        orderAmount: String(totalAmount),
        commissionAmount: String(appliedAffiliateCommission.toFixed(2)),
        discountAmount: String(affDiscount.toFixed(2)),
      }).onConflictDoNothing();
    } catch (err) {
      console.warn("[pos] affiliate redemption tracking failed:", err instanceof Error ? err.message : err);
    }
  }

  // If member account charge, record it (vendorOperatorId added below after lookup)
  let memberChargeId: number | null = null;
  if (paymentMethod === "member_account" && clubMemberId) {
    const [mc] = await db.insert(memberAccountChargesTable).values({
      organizationId: orgId,
      clubMemberId,
      posTransactionId: transaction.id,
      amount: String(totalAmount),
      description: `POS Transaction ${receiptNumber}`,
    }).returning({ id: memberAccountChargesTable.id });
    memberChargeId = mc?.id ?? null;
  }

  // Email receipt if email is provided
  if (customerEmail) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST ?? "smtp.gmail.com",
        port: parseInt(process.env.SMTP_PORT ?? "587"),
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      const itemsHtml = lineItems.map(li =>
        `<tr><td>${li.productName}</td><td>${li.quantity}</td><td>₹${li.unitPrice}</td><td>₹${li.lineTotal}</td></tr>`
      ).join("");

      await transporter.sendMail({
        from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
        to: customerEmail,
        subject: `Pro Shop Receipt – ${receiptNumber}`,
        html: `
          <h2>Pro Shop Receipt</h2>
          <p>Receipt #: <strong>${receiptNumber}</strong></p>
          <table border="1" cellpadding="6" style="border-collapse:collapse;width:100%">
            <thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
            <tbody>${itemsHtml}</tbody>
          </table>
          <p style="margin-top:16px"><strong>Total: ₹${totalAmount}</strong></p>
          <p>Payment: ${paymentMethod.replace("_", " ")}</p>
          <p>Thank you for your purchase!</p>
        `,
      });

      await db.update(posTransactionsTable)
        .set({ receiptEmailed: true })
        .where(eq(posTransactionsTable.id, transaction.id));
    } catch {
      // Email failure is non-fatal — transaction is already saved
    }
  }

  const txnItems = await db
    .select()
    .from(posTransactionItemsTable)
    .where(eq(posTransactionItemsTable.transactionId, transaction.id));

  // Generate GST invoice (fire-and-forget, does not block response)
  (async () => {
    const gstSettings = await getOrgGstSettings(orgId).catch(() => null);
    if (gstSettings) {
      // Fetch product-level HSN code and GST rate for each transaction item
      const productIds = txnItems.map(t => t.productId).filter((id): id is number => id != null);
      const products = productIds.length > 0
        ? await db.select({ id: shopProductsTable.id, hsnCode: shopProductsTable.hsnCode, gstRate: shopProductsTable.gstRate })
            .from(shopProductsTable).where(inArray(shopProductsTable.id, productIds))
        : [];
      const productMap = new Map(products.map(p => [p.id, p]));
      const gstLineItems = txnItems.map(ti => {
        const prod = ti.productId ? productMap.get(ti.productId) : undefined;
        return {
          description: ti.productName,
          hsnSacCode: prod?.hsnCode ?? undefined,
          quantity: ti.quantity,
          unitPrice: parseFloat(String(ti.unitPrice)),
          gstRate: Number(prod?.gstRate ?? 18),
        };
      });
      // GST routing precedence (applied inside createGstInvoice):
      //   1. buyerGstin first-2-digit state code (B2B – may trigger IGST for inter-state buyers)
      //   2. explicit buyerStateCode (not supplied here)
      //   3. buyerState name → code lookup
      //   4. For B2C walk-ins (no GSTIN), default to seller state → intra-state CGST+SGST
      const sellerStateCode = gstSettings.sellerStateCode ?? undefined;
      await createGstInvoice({
        organizationId: orgId,
        channel: "pos",
        posTransactionId: transaction.id,
        buyerName: customerName ?? memberName ?? "Walk-in Customer",
        buyerEmail: customerEmail ?? undefined,
        buyerGstin: buyerGstin ?? undefined,
        // For B2B with GSTIN: do NOT override; createGstInvoice derives state from GSTIN prefix.
        // For B2C walk-ins (no GSTIN): default buyer state = seller state → CGST+SGST.
        ...(buyerGstin ? {} : {
          buyerState: gstSettings.sellerState ?? undefined,
          buyerStateCode: sellerStateCode,
        }),
        sellerGstin: gstSettings.gstin ?? undefined,
        sellerName: gstSettings.sellerName ?? undefined,
        sellerAddress: gstSettings.sellerAddress ?? undefined,
        sellerState: gstSettings.sellerState ?? undefined,
        sellerStateCode: sellerStateCode,
        lineItems: gstLineItems,
      }).catch((e) => logger.warn({ err: e, txId: transaction.id }, "[pos] GST invoice generation failed"));
    }
  })().catch((e) => logger.warn({ err: e }, "[pos] post-transaction async block failed"));

  // Award loyalty points for the member if they are a linked app user
  if (clubMemberId) {
    const [member] = await db
      .select({ userId: clubMembersTable.userId })
      .from(clubMembersTable)
      .where(and(eq(clubMembersTable.id, clubMemberId), eq(clubMembersTable.organizationId, orgId)));
    if (member?.userId) {
      awardPoints({
        organizationId: orgId,
        userId: member.userId,
        amountSpent: totalAmount,
        category: "pos",
        referenceId: `pos:${transaction.id}`,
        description: `Pro shop purchase – receipt ${receiptNumber}`,
      }).catch(() => {});
    }
  }

  // Attribute commission to the staff member who processed the sale (non-fatal)
  const primaryCategory = lineItems[0]?.category ?? null;
  attributePosCommission(orgId, user.id, transaction.id, totalAmount, primaryCategory).catch(() => {});

  // Auto-tag vendorOperatorId:
  // 1. If the staff user has a vendor-scoped membership, use that directly.
  // 2. Otherwise, look up the active facility assignment matching facilityType.
  try {
    let resolvedVendorId: number | null = null;

    // Check if the current user has a vendor-scoped membership
    const userVendorScope = await getVendorScopeForUser(user.id, orgId).catch(() => null);
    if (userVendorScope) {
      resolvedVendorId = userVendorScope;
    } else {
      // Fall back to facility assignment lookup (for admin users processing on behalf of vendor)
      const [activeAssignment] = await db
        .select({ vendorOperatorId: vendorFacilityAssignmentsTable.vendorOperatorId })
        .from(vendorFacilityAssignmentsTable)
        .where(and(
          eq(vendorFacilityAssignmentsTable.organizationId, orgId),
          eq(vendorFacilityAssignmentsTable.isActive, true),
          eq(vendorFacilityAssignmentsTable.facilityType, String(facilityType || "pro_shop") as never),
        ))
        .limit(1);
      if (activeAssignment) {
        resolvedVendorId = activeAssignment.vendorOperatorId;
      }
    }

    if (resolvedVendorId) {
      await db.update(posTransactionsTable)
        .set({ vendorOperatorId: resolvedVendorId })
        .where(eq(posTransactionsTable.id, transaction.id));
      transaction.vendorOperatorId = resolvedVendorId;

      // Also tag the member account charge if one was created
      if (memberChargeId) {
        await db.update(memberAccountChargesTable)
          .set({ vendorOperatorId: resolvedVendorId })
          .where(eq(memberAccountChargesTable.id, memberChargeId));
      }
    }
  } catch (tagErr) {
    // Non-fatal: log warning but never block a sale on vendor-tagging failure
    console.warn("[pos] vendor tagging failed for txn", transaction.id, tagErr instanceof Error ? tagErr.message : tagErr);
  }

  res.json({
    ...transaction,
    items: txnItems,
    ...(promoDiscountBreakdown.length > 0 && {
      discountBreakdown: promoDiscountBreakdown,
      stackingPolicy: evalStackingPolicy,
    }),
  });
});

// GET /organizations/:orgId/pos/transactions
router.get("/transactions", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const user = req.user as { id: number; role?: string; organizationId?: number };

  const { from, to, limit: lim = "50" } = req.query;
  const conditions = [eq(posTransactionsTable.organizationId, orgId)];
  if (from) conditions.push(gte(posTransactionsTable.transactedAt, new Date(String(from))));
  if (to) conditions.push(lte(posTransactionsTable.transactedAt, new Date(String(to))));

  // Vendor-scoped staff (pro_shop with vendorOperatorId) can only see their own vendor's transactions
  const vendorScope = await getVendorScopeForUser(user.id, orgId).catch(() => null);
  if (vendorScope) {
    conditions.push(eq(posTransactionsTable.vendorOperatorId, vendorScope));
  }

  const transactions = await db
    .select()
    .from(posTransactionsTable)
    .where(and(...conditions))
    .orderBy(desc(posTransactionsTable.transactedAt))
    .limit(parseInt(String(lim)));

  res.json(transactions);
});

// GET /organizations/:orgId/pos/transactions/:txnId
router.get("/transactions/:txnId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const txnId = parseInt(String((req.params as Record<string, string>).txnId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const user = req.user as { id: number; role?: string; organizationId?: number };
  const vendorScope = await getVendorScopeForUser(user.id, orgId).catch(() => null);

  const [txn] = await db
    .select()
    .from(posTransactionsTable)
    .where(and(
      eq(posTransactionsTable.id, txnId),
      eq(posTransactionsTable.organizationId, orgId),
      ...(vendorScope ? [eq(posTransactionsTable.vendorOperatorId, vendorScope)] : []),
    ));

  if (!txn) {
    res.status(404).json({ error: "Transaction not found." });
    return;
  }

  const txnItems = await db
    .select()
    .from(posTransactionItemsTable)
    .where(eq(posTransactionItemsTable.transactionId, txnId));

  res.json({ ...txn, items: txnItems });
});

// POST /organizations/:orgId/pos/transactions/:txnId/void
router.post("/transactions/:txnId/void", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const txnId = parseInt(String((req.params as Record<string, string>).txnId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [txn] = await db
    .select()
    .from(posTransactionsTable)
    .where(and(eq(posTransactionsTable.id, txnId), eq(posTransactionsTable.organizationId, orgId)));

  if (!txn) {
    res.status(404).json({ error: "Transaction not found." });
    return;
  }
  if (txn.status !== "completed") {
    res.status(400).json({ error: "Only completed transactions can be voided." });
    return;
  }

  await db.update(posTransactionsTable)
    .set({ status: "voided", updatedAt: new Date() })
    .where(eq(posTransactionsTable.id, txnId));

  // Mark associated member charge as settled (voided)
  if (txn.clubMemberId) {
    await db.update(memberAccountChargesTable)
      .set({ isSettled: true, settledAt: new Date(), settlementNote: "Transaction voided" })
      .where(and(
        eq(memberAccountChargesTable.posTransactionId, txnId),
        eq(memberAccountChargesTable.isSettled, false),
      ));
  }

  res.json({ ok: true });
});

// ─── MEMBER ACCOUNT CHARGES ────────────────────────────────────────────────────

// GET /organizations/:orgId/pos/member-charges/:memberId
router.get("/member-charges/:memberId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const charges = await db
    .select()
    .from(memberAccountChargesTable)
    .where(and(
      eq(memberAccountChargesTable.clubMemberId, memberId),
      eq(memberAccountChargesTable.organizationId, orgId),
    ))
    .orderBy(desc(memberAccountChargesTable.createdAt));

  const [balRow] = await db
    .select({ outstanding: sum(memberAccountChargesTable.amount) })
    .from(memberAccountChargesTable)
    .where(and(
      eq(memberAccountChargesTable.clubMemberId, memberId),
      eq(memberAccountChargesTable.organizationId, orgId),
      eq(memberAccountChargesTable.isSettled, false),
    ));

  res.json({
    charges,
    outstandingBalance: parseFloat(balRow?.outstanding ?? "0") || 0,
  });
});

// POST /organizations/:orgId/pos/member-charges/:chargeId/settle
router.post("/member-charges/:chargeId/settle", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const chargeId = parseInt(String((req.params as Record<string, string>).chargeId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const user = req.user as { id: number };
  const { note } = req.body;

  const [charge] = await db
    .select()
    .from(memberAccountChargesTable)
    .where(and(eq(memberAccountChargesTable.id, chargeId), eq(memberAccountChargesTable.organizationId, orgId)));

  if (!charge) {
    res.status(404).json({ error: "Charge not found." });
    return;
  }
  if (charge.isSettled) {
    res.status(400).json({ error: "Charge is already settled." });
    return;
  }

  await db.update(memberAccountChargesTable)
    .set({
      isSettled: true,
      settledAt: new Date(),
      settledByUserId: user.id,
      settlementNote: note ?? null,
      updatedAt: new Date(),
    })
    .where(eq(memberAccountChargesTable.id, chargeId));

  res.json({ ok: true });
});

// POST /organizations/:orgId/pos/member-charges/settle-all/:memberId
router.post("/member-charges/settle-all/:memberId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const user = req.user as { id: number };
  const { note } = req.body;

  await db.update(memberAccountChargesTable)
    .set({
      isSettled: true,
      settledAt: new Date(),
      settledByUserId: user.id,
      settlementNote: note ?? "Month-end settlement",
      updatedAt: new Date(),
    })
    .where(and(
      eq(memberAccountChargesTable.clubMemberId, memberId),
      eq(memberAccountChargesTable.organizationId, orgId),
      eq(memberAccountChargesTable.isSettled, false),
    ));

  res.json({ ok: true });
});

// ─── DAILY REPORTS & RECONCILIATION ──────────────────────────────────────────

// GET /organizations/:orgId/pos/reports/daily?date=YYYY-MM-DD
router.get("/reports/daily", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const dateStr = req.query.date ? String(req.query.date) : new Date().toISOString().slice(0, 10);
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  const dayEnd = new Date(`${dateStr}T23:59:59.999Z`);

  const transactions = await db
    .select()
    .from(posTransactionsTable)
    .where(and(
      eq(posTransactionsTable.organizationId, orgId),
      gte(posTransactionsTable.transactedAt, dayStart),
      lte(posTransactionsTable.transactedAt, dayEnd),
      eq(posTransactionsTable.status, "completed"),
    ));

  const items = transactions.length > 0
    ? await db
      .select()
      .from(posTransactionItemsTable)
      .where(inArray(posTransactionItemsTable.transactionId, transactions.map(t => t.id)))
    : [];

  // Sales by payment method
  const byPaymentMethod: Record<string, { count: number; total: number }> = {};
  for (const txn of transactions) {
    const m = txn.paymentMethod;
    if (!byPaymentMethod[m]) byPaymentMethod[m] = { count: 0, total: 0 };
    byPaymentMethod[m].count++;
    byPaymentMethod[m].total += parseFloat(String(txn.totalAmount));
  }

  // Sales by category
  const byCategory: Record<string, { quantity: number; total: number }> = {};
  for (const item of items) {
    const cat = item.category ?? "uncategorised";
    if (!byCategory[cat]) byCategory[cat] = { quantity: 0, total: 0 };
    byCategory[cat].quantity += item.quantity;
    byCategory[cat].total += parseFloat(String(item.lineTotal));
  }

  const totalRevenue = transactions.reduce((s, t) => s + parseFloat(String(t.totalAmount)), 0);
  const totalTransactions = transactions.length;
  const voidedCount = (await db
    .select({ c: count() })
    .from(posTransactionsTable)
    .where(and(
      eq(posTransactionsTable.organizationId, orgId),
      gte(posTransactionsTable.transactedAt, dayStart),
      lte(posTransactionsTable.transactedAt, dayEnd),
      eq(posTransactionsTable.status, "voided"),
    )))[0]?.c ?? 0;

  res.json({
    date: dateStr,
    totalRevenue: +totalRevenue.toFixed(2),
    totalTransactions,
    voidedCount,
    byPaymentMethod,
    byCategory,
    transactions: transactions.slice(0, 100),
  });
});

// ─── POS RETURNS ─────────────────────────────────────────────────────────────

const POS_FRAUD_THRESHOLD = 60;

/** Rules-based fraud scoring for POS returns (0–100). Harmonised with online fraud rules. */
async function scorePosReturnFraud(
  orgId: number,
  customerEmail: string,
  refundTotal: number,
  posTransactionId?: number,
): Promise<{ score: number; flagReason: string | null }> {
  const reasons: string[] = [];
  let score = 0;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // Rule 1: Frequency — 3+ returns from same email in last 90 days (online + POS)
  const [freqRow] = await db.select({ cnt: count() }).from(shopReturnsTable)
    .where(and(
      eq(shopReturnsTable.organizationId, orgId),
      eq(shopReturnsTable.customerEmail, customerEmail),
      gte(shopReturnsTable.createdAt, ninetyDaysAgo),
    ));
  const recentCount = Number(freqRow?.cnt ?? 0);
  if (recentCount >= 5) { score += 40; reasons.push(`${recentCount} returns in last 90 days`); }
  else if (recentCount >= 3) { score += 20; reasons.push(`${recentCount} returns in last 90 days`); }

  // Rule 2: High-value return (> ₹5000)
  if (refundTotal > 5000) { score += 20; reasons.push(`high-value POS return ₹${refundTotal.toFixed(0)}`); }

  // Rule 3: Prior fraud flags for same email (online + POS)
  const [flagRow] = await db.select({ cnt: count() }).from(shopReturnsTable)
    .where(and(
      eq(shopReturnsTable.organizationId, orgId),
      eq(shopReturnsTable.customerEmail, customerEmail),
      eq(shopReturnsTable.fraudFlag, true),
    ));
  const priorFlags = Number(flagRow?.cnt ?? 0);
  if (priorFlags > 0) { score += 30; reasons.push(`${priorFlags} prior fraud flag(s)`); }

  // Rule 4: No prior purchase history — email has no online orders or POS transactions
  // (Proxy for new/anonymous customers trying to exploit the return policy)
  const [onlineOrderRow] = await db.select({ cnt: count() }).from(shopOrdersTable)
    .where(and(eq(shopOrdersTable.organizationId, orgId), eq(shopOrdersTable.customerEmail, customerEmail)));
  const [posOrderRow] = await db.select({ cnt: count() }).from(posTransactionsTable)
    .where(and(eq(posTransactionsTable.organizationId, orgId), eq(posTransactionsTable.customerEmail, customerEmail)));
  if (Number(onlineOrderRow?.cnt ?? 0) === 0 && Number(posOrderRow?.cnt ?? 0) <= 1) {
    score += 15; reasons.push("no/minimal prior purchase history for this email");
  }

  // Rule 5: Prior completed non-rejected return already exists for this POS transaction (double-dip)
  if (posTransactionId) {
    const [dblRow] = await db.select({ cnt: count() }).from(shopReturnsTable)
      .where(and(
        eq(shopReturnsTable.organizationId, orgId),
        eq(shopReturnsTable.posTransactionId, posTransactionId),
        sql`${shopReturnsTable.status} NOT IN ('rejected', 'flagged')`,
      ));
    if (Number(dblRow?.cnt ?? 0) > 0) {
      score += 50; reasons.push("prior completed return already exists for this POS transaction");
    }
  }

  score = Math.min(100, score);
  return { score, flagReason: reasons.length > 0 ? reasons.join("; ") : null };
}

// POST /organizations/:orgId/pos/returns — staff processes a POS return
router.post("/returns", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const staff = req.user as { id: number };
  const {
    posTransactionId,
    items, // Array<{ productId?, variantId?, productName, quantity, unitPrice }>
    reason,
    reasonDetail,
    refundMethod, // "cash" | "member_account"
    clubMemberId,
    customerName,
    customerEmail,
  } = req.body;

  if (!posTransactionId) { { res.status(400).json({ error: "posTransactionId is required" }); return; } }
  if (!reason) { { res.status(400).json({ error: "reason is required" }); return; } }
  if (!refundMethod || !["cash", "member_account"].includes(refundMethod)) {
    res.status(400).json({ error: "refundMethod must be 'cash' or 'member_account'" }); return;
  }
  if (refundMethod === "member_account" && !clubMemberId) {
    res.status(400).json({ error: "clubMemberId is required when refundMethod is 'member_account'" }); return;
  }
  if (!Array.isArray(items) || items.length === 0) { { res.status(400).json({ error: "items array is required" }); return; } }

  // Verify transaction belongs to this org
  const [txn] = await db.select().from(posTransactionsTable)
    .where(and(eq(posTransactionsTable.id, posTransactionId), eq(posTransactionsTable.organizationId, orgId)));
  if (!txn) { { res.status(404).json({ error: "POS transaction not found" }); return; } }
  if (txn.status === "voided" || txn.status === "refunded") {
    res.status(400).json({ error: "Transaction is already voided or refunded" }); return;
  }

  // Resolve clubMemberId → app_users.id (shop_returns.userId FK references app_users)
  let memberAppUserId: number | null = null;
  if (clubMemberId) {
    const [memberRow] = await db.select({ userId: clubMembersTable.userId })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.id, clubMemberId),
        eq(clubMembersTable.organizationId, orgId),
      ));
    memberAppUserId = memberRow?.userId ?? null;
  }

  // Validate returned items against the original transaction line items
  const txnItems = await db.select().from(posTransactionItemsTable)
    .where(eq(posTransactionItemsTable.transactionId, posTransactionId));

  const txnItemByVariant = new Map(txnItems.filter(i => i.variantId).map(i => [i.variantId!, i]));
  const txnItemByProduct = new Map(txnItems.filter(i => !i.variantId && i.productId).map(i => [i.productId!, i]));

  // Compute already-returned quantities per variant/product across all non-rejected prior returns for this transaction
  const priorPosReturns = await db.select({
    variantId: shopReturnItemsTable.variantId,
    productId: shopReturnItemsTable.productId,
    quantity: shopReturnItemsTable.quantity,
  })
    .from(shopReturnItemsTable)
    .innerJoin(shopReturnsTable, eq(shopReturnItemsTable.returnId, shopReturnsTable.id))
    .where(and(
      eq(shopReturnsTable.posTransactionId, posTransactionId),
      eq(shopReturnsTable.organizationId, orgId),
      sql`${shopReturnsTable.status} NOT IN ('rejected')`,
    ));

  // Build cumulative-returned-qty map: variantId → qty, or productId → qty for no-variant items
  const alreadyReturnedByVariant = new Map<number, number>();
  const alreadyReturnedByProduct = new Map<number, number>();
  for (const pr of priorPosReturns) {
    if (pr.variantId) {
      alreadyReturnedByVariant.set(pr.variantId, (alreadyReturnedByVariant.get(pr.variantId) ?? 0) + pr.quantity);
    } else if (pr.productId) {
      alreadyReturnedByProduct.set(pr.productId, (alreadyReturnedByProduct.get(pr.productId) ?? 0) + pr.quantity);
    }
  }

  const validatedItems: typeof items = [];
  for (const item of items) {
    const varId = item.variantId ? parseInt(String(item.variantId)) : null;
    const prodId = item.productId ? parseInt(String(item.productId)) : null;
    const txnItem = (varId && txnItemByVariant.get(varId)) ?? (prodId && txnItemByProduct.get(prodId)) ?? null;
    if (!txnItem) {
      res.status(400).json({ error: `Item "${item.productName}" (variant=${varId ?? "n/a"}, product=${prodId ?? "n/a"}) not found in original transaction` });
      return;
    }
    const requestedQty = parseInt(String(item.quantity));
    if (!Number.isInteger(requestedQty) || requestedQty <= 0) {
      res.status(400).json({ error: `Return quantity for "${item.productName}" must be a positive integer` });
      return;
    }
    const alreadyReturned = varId
      ? (alreadyReturnedByVariant.get(varId) ?? 0)
      : prodId ? (alreadyReturnedByProduct.get(prodId) ?? 0) : 0;
    const maxReturnable = txnItem.quantity - alreadyReturned;
    if (requestedQty > maxReturnable) {
      res.status(400).json({
        error: `Return quantity ${requestedQty} for "${item.productName}" exceeds returnable quantity ${maxReturnable} (${txnItem.quantity} purchased, ${alreadyReturned} already returned)`,
      });
      return;
    }
    // Use the original transaction unit price, not the client-supplied price
    validatedItems.push({ ...item, unitPrice: txnItem.unitPrice, quantity: requestedQty });
  }

  // Determine if this is a full return using CUMULATIVE returned quantities (prior + current request)
  const isFullReturn = txnItems.every(txnItem => {
    const varId = txnItem.variantId;
    const prodId = txnItem.productId;
    const priorReturned = varId
      ? (alreadyReturnedByVariant.get(varId) ?? 0)
      : (prodId ? (alreadyReturnedByProduct.get(prodId) ?? 0) : 0);
    const currentMatch = validatedItems.find(vi =>
      (varId && vi.variantId && parseInt(String(vi.variantId)) === varId) ||
      (!varId && prodId && vi.productId && parseInt(String(vi.productId)) === prodId)
    );
    const currentReturned = currentMatch ? parseInt(String(currentMatch.quantity)) : 0;
    return (priorReturned + currentReturned) >= txnItem.quantity;
  });

  const refundTotal = validatedItems.reduce((s: number, i: { quantity: number | string; unitPrice: number | string }) =>
    s + (parseFloat(String(i.unitPrice)) * parseInt(String(i.quantity))), 0);

  // POS fraud scoring (runs before transaction for fail-fast flagging)
  const effectiveEmail = customerEmail ?? txn.customerEmail ?? "";
  const { score: posFraudScore, flagReason: posFraudFlagReason } = effectiveEmail
    ? await scorePosReturnFraud(orgId, effectiveEmail, refundTotal, posTransactionId)
    : { score: 0, flagReason: null };
  const isPosReturnFlagged = posFraudScore >= POS_FRAUD_THRESHOLD;

  const newReturn = await db.transaction(async (tx) => {
    const [ret] = await tx.insert(shopReturnsTable).values({
      organizationId: orgId,
      posTransactionId,
      sourceType: "pos",
      userId: memberAppUserId ?? null,
      customerName: customerName ?? txn.customerName ?? txn.memberName ?? "Walk-in",
      customerEmail: effectiveEmail,
      reason: reason as typeof shopReturnsTable.$inferInsert["reason"],
      reasonDetail: reasonDetail ?? null,
      status: isPosReturnFlagged ? "flagged" : "received",
      returnType: "refund",
      refundAmount: String(refundTotal.toFixed(2)),
      currency: txn.currency,
      posRefundMethod: refundMethod,
      fraudScore: posFraudScore,
      fraudFlag: isPosReturnFlagged,
      fraudFlagReason: posFraudFlagReason ?? null,
    }).returning();

    // Use validatedItems (server-verified quantities and prices) not client-supplied items
    for (const item of validatedItems) {
      const [insertedItem] = await tx.insert(shopReturnItemsTable).values({
        returnId: ret.id,
        productId: item.productId ? parseInt(String(item.productId)) : null,
        variantId: item.variantId ? parseInt(String(item.variantId)) : null,
        productName: item.productName ?? "Item",
        quantity: parseInt(String(item.quantity)),
        unitPrice: String(parseFloat(String(item.unitPrice))),
        restocked: false,
      }).returning();

      // Restock and credit only when NOT flagged — flagged returns are held for admin review
      if (!isPosReturnFlagged) {
        const itemVarId = item.variantId ? parseInt(String(item.variantId)) : null;
        const itemProdId = item.productId ? parseInt(String(item.productId)) : null;
        const itemQty = parseInt(String(item.quantity));
        if (itemVarId) {
          await tx.update(shopProductVariantsTable)
            .set({ stockQty: sql`${shopProductVariantsTable.stockQty} + ${itemQty}`, updatedAt: new Date() })
            .where(eq(shopProductVariantsTable.id, itemVarId));
          await tx.update(shopReturnItemsTable).set({ restocked: true })
            .where(eq(shopReturnItemsTable.id, insertedItem.id));
        } else if (itemProdId) {
          await tx.update(shopProductsTable)
            .set({ stockCount: sql`COALESCE(${shopProductsTable.stockCount}, 0) + ${itemQty}`, updatedAt: new Date() })
            .where(eq(shopProductsTable.id, itemProdId));
          await tx.update(shopReturnItemsTable).set({ restocked: true })
            .where(eq(shopReturnItemsTable.id, insertedItem.id));
        }
      }
    }

    // For member_account refund: credit the account only if NOT flagged for fraud
    if (!isPosReturnFlagged && refundMethod === "member_account" && clubMemberId) {
      await tx.insert(memberAccountChargesTable).values({
        organizationId: orgId,
        clubMemberId,
        posTransactionId,
        amount: String((-refundTotal).toFixed(2)),
        description: `POS Return — Ref #${ret.id}`,
      });
    }

    // Only mark transaction as "refunded" for full, non-flagged returns
    if (!isPosReturnFlagged && isFullReturn) {
      await tx.update(posTransactionsTable)
        .set({ status: "refunded", updatedAt: new Date() })
        .where(eq(posTransactionsTable.id, posTransactionId));
    }

    return ret;
  });

  // Log the POS return creation in shop_order_events for timeline visibility
  db.insert(shopOrderEventsTable).values({
    organizationId: orgId,
    orderId: null,
    returnId: newReturn.id,
    eventType: isPosReturnFlagged ? "pos_return_flagged" : "pos_return_submitted",
    description: isPosReturnFlagged
      ? `POS return flagged for fraud review — score ${posFraudScore}${posFraudFlagReason ? `: ${posFraudFlagReason}` : ""}`
      : `POS return submitted for ${newReturn.currency} ${refundTotal.toFixed(2)} via ${refundMethod}`,
    userId: staff.id,
    metadata: { posTransactionId, refundTotal, fraudScore: posFraudScore, isPosReturnFlagged },
  }).catch(() => {});

  res.status(201).json(newReturn);
});

// GET /organizations/:orgId/pos/returns — staff/admin views POS returns
router.get("/returns", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const returns = await db.select().from(shopReturnsTable)
    .where(and(eq(shopReturnsTable.organizationId, orgId), eq(shopReturnsTable.sourceType, "pos")))
    .orderBy(desc(shopReturnsTable.createdAt))
    .limit(100);

  res.json(returns);
});

// ─── OFFLINE POS SYNC ─────────────────────────────────────────────────────────
// POST /organizations/:orgId/pos/offline-sync
// Accepts a batch of transactions queued while the POS was offline.
// IDEMPOTENT: each transaction must include a stable `clientTransactionId` used
// as the receipt number suffix. If a transaction with the same receipt number
// already exists for this org, it is treated as already-synced (success) without
// duplicating records or stock decrements.
router.post("/offline-sync", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;
  const user = req.user as { id: number };

  const { transactions } = req.body;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    res.status(400).json({ error: "transactions array required" });
    return;
  }

  const results: { localId: string; status: "ok" | "duplicate" | "error"; error?: string; txnId?: number }[] = [];

  for (const tx of transactions) {
    try {
      const { localId, clientTransactionId, items, paymentMethod, totalAmount, subtotal, notes, customerName, customerEmail, clubMemberId, memberName } = tx;

      // Use a deterministic receipt number from clientTransactionId if provided,
      // otherwise fall back to a timestamp-based one (less idempotent).
      const receiptNumber = clientTransactionId
        ? `POS-${orgId}-OFFLINE-${String(clientTransactionId).slice(0, 40)}`
        : `POS-${orgId}-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}-OFF`;

      // ── IDEMPOTENCY CHECK ─────────────────────────────────────────────────────
      // If a transaction with this receipt already exists, skip it and report as
      // already-synced. This prevents duplicate inserts and stock decrements on retry.
      const [existing] = await db
        .select({ id: posTransactionsTable.id })
        .from(posTransactionsTable)
        .where(and(
          eq(posTransactionsTable.organizationId, orgId),
          eq(posTransactionsTable.receiptNumber, receiptNumber),
        ));
      if (existing) {
        results.push({ localId, status: "duplicate", txnId: existing.id });
        continue;
      }

      const validPaymentMethod = ["cash", "razorpay_pos", "member_account", "gift_card", "split_gift_card_cash"].includes(paymentMethod)
        ? paymentMethod as "cash" | "razorpay_pos" | "member_account" | "gift_card" | "split_gift_card_cash"
        : "cash";
      const total = parseFloat(String(totalAmount ?? 0));
      const sub = parseFloat(String(subtotal ?? totalAmount ?? 0));

      const [defaultLoc] = await db.select({ id: shopLocationsTable.id })
        .from(shopLocationsTable)
        .where(and(eq(shopLocationsTable.organizationId, orgId), eq(shopLocationsTable.isDefault, true)));
      const syncLocationId: number | null = defaultLoc?.id ?? null;

      type ValidatedItem = {
        productId: number | null; variantId: number | null; bundleId?: number;
        productName: string; sku: string | null; category: string | null;
        qty: number; unitPrice: number; discountPct: number; lineTotal: number;
        bundleComponents?: { variantId: number | null; productId: number; quantity: number }[];
      };
      const validatedItems: ValidatedItem[] = [];
      for (const item of (items && Array.isArray(items) ? items : [])) {
        const qty = item.quantity ?? 1;
        const unitPrice = item.unitPrice ?? item.price ?? 0;
        const discountPct = item.discountPct ?? 0;
        const lineTotal = item.lineTotal ?? item.totalPrice ?? qty * unitPrice;
        if (item.variantId) {
          const [varCheck] = await db.select({ id: shopProductVariantsTable.id })
            .from(shopProductVariantsTable)
            .innerJoin(shopProductsTable, eq(shopProductVariantsTable.productId, shopProductsTable.id))
            .where(and(eq(shopProductVariantsTable.id, item.variantId), eq(shopProductsTable.organizationId, orgId))).limit(1);
          if (!varCheck) continue;
          validatedItems.push({ productId: item.productId ?? null, variantId: item.variantId, productName: item.productName ?? item.name ?? "Item", sku: item.sku ?? null, category: item.category ?? null, qty, unitPrice, discountPct, lineTotal });
        } else if (item.bundleId) {
          const bundleComponents = await db
            .select({ variantId: shopBundleComponentsTable.variantId, productId: shopBundleComponentsTable.productId, quantity: shopBundleComponentsTable.quantity })
            .from(shopBundleComponentsTable)
            .innerJoin(shopBundlesTable, eq(shopBundleComponentsTable.bundleId, shopBundlesTable.id))
            .where(and(eq(shopBundleComponentsTable.bundleId, item.bundleId), eq(shopBundlesTable.organizationId, orgId)));
          validatedItems.push({ productId: null, variantId: null, bundleId: item.bundleId, productName: item.productName ?? item.name ?? "Bundle", sku: item.sku ?? null, category: item.category ?? null, qty, unitPrice, discountPct, lineTotal, bundleComponents });
        } else if (item.productId) {
          validatedItems.push({ productId: item.productId, variantId: null, productName: item.productName ?? item.name ?? "Item", sku: item.sku ?? null, category: item.category ?? null, qty, unitPrice, discountPct, lineTotal });
        }
      }

      // Wrap all writes atomically; failed attempts remain retryable via idempotency key
      let txnId: number;
      await db.transaction(async (dbt) => {
        const [txn] = await dbt.insert(posTransactionsTable).values({
          organizationId: orgId, receiptNumber, offlineSynced: true,
          totalAmount: String(total), subtotal: String(sub),
          paymentMethod: validPaymentMethod,
          notes: (notes ? notes + " | " : "") + "Offline sync",
          customerName: customerName ?? null, customerEmail: customerEmail ?? null,
          clubMemberId: clubMemberId ?? null, memberName: memberName ?? null,
          status: "completed",
        }).returning();
        txnId = txn.id;

        for (const item of validatedItems) {
          await dbt.insert(posTransactionItemsTable).values({
            transactionId: txn.id, productId: item.productId ?? null, variantId: item.variantId ?? null,
            productName: item.productName, sku: item.sku, category: item.category,
            quantity: item.qty, unitPrice: String(item.unitPrice),
            discountPct: String(item.discountPct), lineTotal: String(item.lineTotal),
          });

          if (item.variantId) {
            await dbt.update(shopProductVariantsTable)
              .set({ stockQty: sql`GREATEST(0, ${shopProductVariantsTable.stockQty} - ${item.qty})` })
              .where(eq(shopProductVariantsTable.id, item.variantId));
            if (syncLocationId) {
              await dbt.insert(shopVariantStockTable).values({ variantId: item.variantId, locationId: syncLocationId, quantity: 0 }).onConflictDoNothing();
              await dbt.update(shopVariantStockTable)
                .set({ quantity: sql`${shopVariantStockTable.quantity} - ${item.qty}`, updatedAt: new Date() })
                .where(and(eq(shopVariantStockTable.variantId, item.variantId), eq(shopVariantStockTable.locationId, syncLocationId)));
              await dbt.insert(shopStockAdjustmentsTable).values({
                organizationId: orgId, variantId: item.variantId, locationId: syncLocationId,
                qtyDelta: -item.qty, type: "sale",
                reason: `Offline POS sale — receipt ${receiptNumber}`,
                referenceId: String(txn.id), createdByUserId: user.id,
              });
            }
          } else if (item.bundleId && item.bundleComponents) {
            for (const comp of item.bundleComponents) {
              const dQty = comp.quantity * item.qty;
              if (comp.variantId) {
                await dbt.update(shopProductVariantsTable)
                  .set({ stockQty: sql`GREATEST(0, ${shopProductVariantsTable.stockQty} - ${dQty})` })
                  .where(eq(shopProductVariantsTable.id, comp.variantId));
                if (syncLocationId) {
                  await dbt.insert(shopVariantStockTable).values({ variantId: comp.variantId, locationId: syncLocationId, quantity: 0 }).onConflictDoNothing();
                  await dbt.update(shopVariantStockTable)
                    .set({ quantity: sql`${shopVariantStockTable.quantity} - ${dQty}`, updatedAt: new Date() })
                    .where(and(eq(shopVariantStockTable.variantId, comp.variantId), eq(shopVariantStockTable.locationId, syncLocationId)));
                  await dbt.insert(shopStockAdjustmentsTable).values({
                    organizationId: orgId, variantId: comp.variantId, locationId: syncLocationId,
                    qtyDelta: -dQty, type: "sale",
                    reason: `Offline bundle sale (bundle#${item.bundleId}) — receipt ${receiptNumber}`,
                    referenceId: String(txn.id), createdByUserId: user.id,
                  });
                }
              } else if (comp.productId) {
                await dbt.update(shopProductsTable)
                  .set({ stockCount: sql`CASE WHEN ${shopProductsTable.stockCount} IS NOT NULL THEN GREATEST(0, ${shopProductsTable.stockCount} - ${dQty}) ELSE NULL END` })
                  .where(and(eq(shopProductsTable.id, comp.productId), eq(shopProductsTable.organizationId, orgId)));
              }
            }
          } else if (item.productId) {
            await dbt.update(shopProductsTable)
              .set({ stockCount: sql`CASE WHEN ${shopProductsTable.stockCount} IS NOT NULL THEN GREATEST(0, ${shopProductsTable.stockCount} - ${item.qty}) ELSE NULL END` })
              .where(and(eq(shopProductsTable.id, item.productId), eq(shopProductsTable.organizationId, orgId)));
          }
        }

        // Member account charge — mirror online checkout behavior
        if (validPaymentMethod === "member_account" && clubMemberId) {
          await dbt.insert(memberAccountChargesTable).values({
            organizationId: orgId,
            clubMemberId,
            posTransactionId: txn.id,
            amount: String(total),
            description: `POS Transaction ${receiptNumber}`,
          });
        }
      });

      results.push({ localId, status: "ok", txnId: txnId! });
    } catch (err) {
      results.push({ localId: tx.localId ?? "?", status: "error", error: String(err) });
    }
  }

  res.json({
    synced: results.filter(r => r.status === "ok").length,
    duplicates: results.filter(r => r.status === "duplicate").length,
    errors: results.filter(r => r.status === "error").length,
    total: transactions.length,
    results,
  });
});

export default router;
