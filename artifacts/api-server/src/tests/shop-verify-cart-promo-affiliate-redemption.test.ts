/**
 * Integration test: shop verify-cart endpoint → promo + affiliate redemption
 * (Task #1946 — guards the inline promo/affiliate redemption blocks against
 * the same status-flip race that previously caused duplicate stock
 * deductions in Task #1572 and duplicate receipts in Task #1307).
 *
 * The verify-cart route reads `pendingOrders` BEFORE the status-flip
 * UPDATE and then, for the cart's first order, runs SELECT-then-INSERT
 * idempotency checks against `promotionRedemptionsTable` and
 * `affiliateRedemptionsTable`. If two verify-cart calls land
 * concurrently for the same Stripe session, both reach the existence
 * check before either insert lands — without a status-flip gate, both
 * would bump `promotions.usedCount` / `affiliateCodes.totalOrders` and
 * write duplicate redemption rows (or trip the unique index and 5xx).
 *
 * Confirms that:
 *   1. A normal verify-cart call increments promo `usedCount` and
 *      affiliate `totalOrders` exactly once and writes one redemption
 *      row in each table.
 *   2. Two concurrent verify-cart calls for the same session result in
 *      exactly one increment per usage counter and exactly one
 *      redemption row in each table — the loser of the status-flip
 *      UPDATE must skip the redemption work entirely.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendShopOrderReceiptEmail: vi.fn(async () => undefined),
  sendDuesReceiptEmail: vi.fn(async () => undefined),
  sendReceiptEmail: vi.fn(async () => undefined),
  verifyCheckoutPayment: vi.fn(),
}));

vi.mock("../lib/paymentReceipts", () => ({
  sendShopOrderReceiptEmail: mocks.sendShopOrderReceiptEmail,
  sendDuesReceiptEmail: mocks.sendDuesReceiptEmail,
  sendReceiptEmail: mocks.sendReceiptEmail,
  currencySymbol: (c: string) => (c === "INR" ? "₹" : c),
}));

vi.mock("../lib/checkout", async () => {
  const actual = await vi.importActual<typeof import("../lib/checkout")>("../lib/checkout");
  return {
    ...actual,
    verifyCheckoutPayment: mocks.verifyCheckoutPayment,
  };
});

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  shopProductsTable,
  shopProductVariantsTable,
  shopOrdersTable,
  shopLocationsTable,
  shopVariantStockTable,
  promotionsTable,
  promotionRedemptionsTable,
  affiliateCodesTable,
  affiliateRedemptionsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const INITIAL_VARIANT_STOCK = 50;
const INITIAL_LOCATION_STOCK = 30;
const ORDER_QTY = 2;
const UNIT_PRICE = 1500;
const PROMO_DISCOUNT = 100;
const AFFILIATE_DISCOUNT = 50;
const AFFILIATE_COMMISSION = 30;
const ORDER_TOTAL = (UNIT_PRICE * ORDER_QTY - PROMO_DISCOUNT - AFFILIATE_DISCOUNT).toFixed(2);

async function setupShopOrderWithPromoAndAffiliate(opts: { sessionId: string }) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `Shop Promo Test ${suffix}`,
    slug: `shop-promo-${suffix}`,
    subscriptionTier: "pro",
    subscriptionStatus: "active",
  }).returning();

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `shop-promo-${suffix}`,
    username: `shop_promo_${suffix}`,
    role: "player",
    email: `buyer_${suffix}@example.com`,
  }).returning();

  const [product] = await db.insert(shopProductsTable).values({
    organizationId: org.id,
    name: "Test Polo Shirt",
    basePrice: "1000.00",
    markupPrice: String(UNIT_PRICE.toFixed(2)),
    currency: "INR",
  }).returning();

  const [variant] = await db.insert(shopProductVariantsTable).values({
    productId: product.id,
    color: "Red",
    size: "M",
    stockQty: INITIAL_VARIANT_STOCK,
  }).returning();

  const [location] = await db.insert(shopLocationsTable).values({
    organizationId: org.id,
    name: "Pro Shop",
    isDefault: true,
  }).returning();

  await db.insert(shopVariantStockTable).values({
    variantId: variant.id,
    locationId: location.id,
    quantity: INITIAL_LOCATION_STOCK,
  });

  const promoCode = `SAVE_${suffix}`.toUpperCase();
  const [promo] = await db.insert(promotionsTable).values({
    organizationId: org.id,
    code: promoCode,
    description: "Test promo",
    discountType: "fixed",
    discountValue: String(PROMO_DISCOUNT.toFixed(2)),
    isActive: true,
  }).returning();

  const affiliateCode = `AFF_${suffix}`.toUpperCase();
  const [aff] = await db.insert(affiliateCodesTable).values({
    organizationId: org.id,
    code: affiliateCode,
    ownerName: "Affiliate Owner",
    commissionType: "fixed",
    commissionValue: String(AFFILIATE_COMMISSION.toFixed(2)),
    buyerDiscountType: "fixed",
    buyerDiscountValue: String(AFFILIATE_DISCOUNT.toFixed(2)),
    isActive: true,
  }).returning();

  const [order] = await db.insert(shopOrdersTable).values({
    organizationId: org.id,
    productId: product.id,
    variantId: variant.id,
    userId: user.id,
    customerName: "Buyer Test",
    customerEmail: user.email!,
    quantity: ORDER_QTY,
    size: "M",
    unitPrice: String(UNIT_PRICE.toFixed(2)),
    totalAmount: ORDER_TOTAL,
    currency: "INR",
    razorpayOrderId: opts.sessionId,
    paymentMode: "stripe",
    status: "pending",
    promoCode,
    affiliateCode,
    discountTotal: String((PROMO_DISCOUNT + AFFILIATE_DISCOUNT).toFixed(2)),
    discountBreakdown: [
      { type: "promo", label: "Promo SAVE", amount: PROMO_DISCOUNT },
      { type: "affiliate", label: "Affiliate AFF", amount: AFFILIATE_DISCOUNT, commission: AFFILIATE_COMMISSION } as
        unknown as { type: "affiliate"; label: string; amount: number },
    ],
  }).returning();

  return { org, user, product, variant, location, promo, aff, order };
}

beforeAll(() => {
  mocks.verifyCheckoutPayment.mockResolvedValue({
    paid: true,
    amountMinor: Math.round(parseFloat(ORDER_TOTAL) * 100),
    currency: "INR",
    paymentRef: "pi_test_default",
    objectId: "cs_test_default",
    metadata: {},
  });
});

beforeEach(() => {
  mocks.sendShopOrderReceiptEmail.mockClear();
  mocks.sendDuesReceiptEmail.mockClear();
  mocks.sendReceiptEmail.mockClear();
  mocks.verifyCheckoutPayment.mockClear();
});

describe("POST /shop/orders/verify-cart → promo + affiliate redemption (Task #1946)", () => {
  it("records exactly one promo + one affiliate redemption (and bumps each usage counter once) on a single verify-cart", async () => {
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_single`;
    const { org, user, promo, aff, order } = await setupShopOrderWithPromoAndAffiliate({ sessionId });

    const buyer: TestUser = {
      id: user.id,
      username: user.username,
      role: "player",
      organizationId: org.id,
    };
    const app = createTestApp(buyer);

    mocks.verifyCheckoutPayment.mockResolvedValueOnce({
      paid: true,
      amountMinor: Math.round(parseFloat(ORDER_TOTAL) * 100),
      currency: "INR",
      paymentRef: `pi_${sessionId}`,
      objectId: sessionId,
      metadata: { orgId: String(org.id) },
    });

    const res = await request(app)
      .post(`/api/organizations/${org.id}/shop/orders/verify-cart`)
      .set("Content-Type", "application/json")
      .send({ stripeCheckoutSessionId: sessionId });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Promo: usedCount bumped exactly once + one redemption row.
    const [promoAfter] = await db.select().from(promotionsTable).where(eq(promotionsTable.id, promo.id));
    expect(promoAfter.usedCount).toBe(1);
    const promoRedemptions = await db.select().from(promotionRedemptionsTable)
      .where(and(
        eq(promotionRedemptionsTable.promotionId, promo.id),
        eq(promotionRedemptionsTable.orderId, order.id),
      ));
    expect(promoRedemptions).toHaveLength(1);
    expect(parseFloat(promoRedemptions[0]!.discountAmount)).toBe(PROMO_DISCOUNT);

    // Affiliate: totalOrders bumped exactly once + one redemption row.
    const [affAfter] = await db.select().from(affiliateCodesTable).where(eq(affiliateCodesTable.id, aff.id));
    expect(affAfter.totalOrders).toBe(1);
    expect(parseFloat(affAfter.totalDiscountGiven)).toBe(AFFILIATE_DISCOUNT);
    expect(parseFloat(affAfter.totalCommissionEarned)).toBe(AFFILIATE_COMMISSION);
    const affRedemptions = await db.select().from(affiliateRedemptionsTable)
      .where(and(
        eq(affiliateRedemptionsTable.affiliateCodeId, aff.id),
        eq(affiliateRedemptionsTable.orderId, order.id),
      ));
    expect(affRedemptions).toHaveLength(1);
    expect(parseFloat(affRedemptions[0]!.discountAmount)).toBe(AFFILIATE_DISCOUNT);
    expect(parseFloat(affRedemptions[0]!.commissionAmount)).toBe(AFFILIATE_COMMISSION);
  });

  it("only records one promo + one affiliate redemption when verify-cart is posted concurrently for the same Stripe session", async () => {
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_race`;
    const { org, user, promo, aff, order } = await setupShopOrderWithPromoAndAffiliate({ sessionId });

    const app = createTestApp({
      id: user.id,
      username: user.username,
      role: "player",
      organizationId: org.id,
    });

    mocks.verifyCheckoutPayment.mockResolvedValue({
      paid: true,
      amountMinor: Math.round(parseFloat(ORDER_TOTAL) * 100),
      currency: "INR",
      paymentRef: `pi_${sessionId}`,
      objectId: sessionId,
      metadata: { orgId: String(org.id) },
    });

    // Fire two verify-cart calls in parallel for the same Stripe session.
    // Both will read the same `pendingOrders` snapshot and both will pass
    // the redemption existence check before either insert lands — but
    // only one will win the status-flip UPDATE. The loser must NOT bump
    // usage counters or write a duplicate redemption row.
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/organizations/${org.id}/shop/orders/verify-cart`)
        .set("Content-Type", "application/json")
        .send({ stripeCheckoutSessionId: sessionId }),
      request(app)
        .post(`/api/organizations/${org.id}/shop/orders/verify-cart`)
        .set("Content-Type", "application/json")
        .send({ stripeCheckoutSessionId: sessionId }),
    ]);

    // Both responses must be either 200 (won the flip / read snapshot
    // before the other landed) or 400 (read after the winner had already
    // flipped). Anything else (5xx) would mean the route blew up — e.g.
    // tripped the redemption unique index and crashed.
    for (const r of [r1, r2]) {
      expect([200, 400]).toContain(r.status);
    }
    const okCount = [r1, r2].filter((r) => r.status === 200).length;
    expect(okCount).toBeGreaterThanOrEqual(1);

    // Promo usage counter bumped exactly once + exactly one redemption row.
    const [promoAfter] = await db.select().from(promotionsTable).where(eq(promotionsTable.id, promo.id));
    expect(promoAfter.usedCount).toBe(1);
    const promoRedemptions = await db.select().from(promotionRedemptionsTable)
      .where(and(
        eq(promotionRedemptionsTable.promotionId, promo.id),
        eq(promotionRedemptionsTable.orderId, order.id),
      ));
    expect(promoRedemptions).toHaveLength(1);

    // Affiliate counters bumped exactly once + exactly one redemption row.
    const [affAfter] = await db.select().from(affiliateCodesTable).where(eq(affiliateCodesTable.id, aff.id));
    expect(affAfter.totalOrders).toBe(1);
    expect(parseFloat(affAfter.totalDiscountGiven)).toBe(AFFILIATE_DISCOUNT);
    expect(parseFloat(affAfter.totalCommissionEarned)).toBe(AFFILIATE_COMMISSION);
    const affRedemptions = await db.select().from(affiliateRedemptionsTable)
      .where(and(
        eq(affiliateRedemptionsTable.affiliateCodeId, aff.id),
        eq(affiliateRedemptionsTable.orderId, order.id),
      ));
    expect(affRedemptions).toHaveLength(1);

    // Order is paid exactly once with the right payment ref.
    const [final] = await db.select().from(shopOrdersTable)
      .where(eq(shopOrdersTable.id, order.id));
    expect(final.status).toBe("paid");
    expect(final.razorpayPaymentId).toBe(`pi_${sessionId}`);
  });
});
