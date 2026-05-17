/**
 * Integration test: shop verify-cart endpoint → variant stock deduction
 * (Task #1572 — guards the inline stock-deduction loop against the same
 * status-flip race that previously caused duplicate receipt emails in
 * Task #1307).
 *
 * The verify-cart route reads `pendingOrders` BEFORE the status-flip
 * UPDATE and then iterates that snapshot to decrement variant stock,
 * decrement per-location stock, and append a `sale` row to the
 * stock-adjustments ledger. If two verify-cart calls land concurrently
 * for the same Stripe session, both reach the loop with the same
 * snapshot — only one wins the UPDATE, but without a guard both would
 * still double-deduct stock and emit two ledger rows for the same order.
 *
 * Confirms that:
 *   1. A normal verify-cart call decrements variant + per-location stock
 *      exactly once and writes one "sale" stock adjustment.
 *   2. Two concurrent verify-cart calls for the same session result in
 *      exactly one stock decrement and one ledger row — the loser of
 *      the status-flip UPDATE must skip the deduction loop entirely.
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
  shopStockAdjustmentsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const INITIAL_VARIANT_STOCK = 50;
const INITIAL_LOCATION_STOCK = 30;
const ORDER_QTY = 2;

async function setupShopOrderWithVariant(opts: { sessionId: string }) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `Shop Stock Test ${suffix}`,
    slug: `shop-stock-${suffix}`,
    subscriptionTier: "pro",
    subscriptionStatus: "active",
  }).returning();

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `shop-stock-${suffix}`,
    username: `shop_stock_${suffix}`,
    role: "player",
    email: `buyer_${suffix}@example.com`,
  }).returning();

  const [product] = await db.insert(shopProductsTable).values({
    organizationId: org.id,
    name: "Test Polo Shirt",
    basePrice: "1000.00",
    markupPrice: "1500.00",
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

  const total = (1500 * ORDER_QTY).toFixed(2);
  const [order] = await db.insert(shopOrdersTable).values({
    organizationId: org.id,
    productId: product.id,
    variantId: variant.id,
    userId: user.id,
    customerName: "Buyer Test",
    customerEmail: user.email!,
    quantity: ORDER_QTY,
    size: "M",
    unitPrice: "1500.00",
    totalAmount: total,
    currency: "INR",
    razorpayOrderId: opts.sessionId,
    paymentMode: "stripe",
    status: "pending",
  }).returning();

  return { org, user, product, variant, location, order };
}

beforeAll(() => {
  mocks.verifyCheckoutPayment.mockResolvedValue({
    paid: true,
    amountMinor: 300000,
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

describe("POST /shop/orders/verify-cart → variant stock deduction (Task #1572)", () => {
  it("decrements variant stock + per-location stock and writes one sale ledger row on a single verify-cart", async () => {
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_single`;
    const { org, user, variant, location } = await setupShopOrderWithVariant({ sessionId });

    const buyer: TestUser = {
      id: user.id,
      username: user.username,
      role: "player",
      organizationId: org.id,
    };
    const app = createTestApp(buyer);

    mocks.verifyCheckoutPayment.mockResolvedValueOnce({
      paid: true,
      amountMinor: 300000,
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

    // Variant aggregate stock decremented exactly once.
    const [variantAfter] = await db.select().from(shopProductVariantsTable)
      .where(eq(shopProductVariantsTable.id, variant.id));
    expect(variantAfter.stockQty).toBe(INITIAL_VARIANT_STOCK - ORDER_QTY);

    // Per-location stock decremented exactly once.
    const [locStockAfter] = await db.select().from(shopVariantStockTable)
      .where(and(
        eq(shopVariantStockTable.variantId, variant.id),
        eq(shopVariantStockTable.locationId, location.id),
      ));
    expect(locStockAfter.quantity).toBe(INITIAL_LOCATION_STOCK - ORDER_QTY);

    // Exactly one "sale" stock-adjustment ledger row.
    const adjustments = await db.select().from(shopStockAdjustmentsTable)
      .where(and(
        eq(shopStockAdjustmentsTable.organizationId, org.id),
        eq(shopStockAdjustmentsTable.variantId, variant.id),
        eq(shopStockAdjustmentsTable.type, "sale"),
      ));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]!.qtyDelta).toBe(-ORDER_QTY);
  });

  it("only decrements variant stock once when verify-cart is posted concurrently for the same Stripe session", async () => {
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_race`;
    const { org, user, order, variant, location } = await setupShopOrderWithVariant({ sessionId });

    const app = createTestApp({
      id: user.id,
      username: user.username,
      role: "player",
      organizationId: org.id,
    });

    mocks.verifyCheckoutPayment.mockResolvedValue({
      paid: true,
      amountMinor: 300000,
      currency: "INR",
      paymentRef: `pi_${sessionId}`,
      objectId: sessionId,
      metadata: { orgId: String(org.id) },
    });

    // Fire two verify-cart calls in parallel for the same Stripe session.
    // Both will read the same `pendingOrders` snapshot, but only one will
    // win the status-flip UPDATE — the other must NOT decrement stock or
    // append a duplicate stock-adjustment row.
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

    // At least one request must succeed; the other may either succeed
    // (read the snapshot before either UPDATE landed) or 400 (read after
    // the winner had already flipped to paid). Anything else (e.g. 5xx)
    // would mean the route blew up under concurrency.
    for (const r of [r1, r2]) {
      expect([200, 400]).toContain(r.status);
    }
    const okCount = [r1, r2].filter((r) => r.status === 200).length;
    expect(okCount).toBeGreaterThanOrEqual(1);

    // Variant aggregate stock decremented exactly once.
    const [variantAfter] = await db.select().from(shopProductVariantsTable)
      .where(eq(shopProductVariantsTable.id, variant.id));
    expect(variantAfter.stockQty).toBe(INITIAL_VARIANT_STOCK - ORDER_QTY);

    // Per-location stock decremented exactly once.
    const [locStockAfter] = await db.select().from(shopVariantStockTable)
      .where(and(
        eq(shopVariantStockTable.variantId, variant.id),
        eq(shopVariantStockTable.locationId, location.id),
      ));
    expect(locStockAfter.quantity).toBe(INITIAL_LOCATION_STOCK - ORDER_QTY);

    // Exactly one "sale" ledger row, tagged to this order.
    const adjustments = await db.select().from(shopStockAdjustmentsTable)
      .where(and(
        eq(shopStockAdjustmentsTable.organizationId, org.id),
        eq(shopStockAdjustmentsTable.variantId, variant.id),
        eq(shopStockAdjustmentsTable.type, "sale"),
      ));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]!.qtyDelta).toBe(-ORDER_QTY);
    expect(adjustments[0]!.referenceId).toBe(String(order.id));

    // Order is paid exactly once with the right payment ref.
    const [final] = await db.select().from(shopOrdersTable)
      .where(eq(shopOrdersTable.id, order.id));
    expect(final.status).toBe("paid");
    expect(final.razorpayPaymentId).toBe(`pi_${sessionId}`);
  });
});
