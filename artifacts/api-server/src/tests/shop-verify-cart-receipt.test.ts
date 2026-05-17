/**
 * Integration test: shop verify-cart endpoint → instant Stripe receipt email
 * (Task #1134 — covers the inline receipt path that runs immediately after
 * a buyer is redirected back from Stripe Checkout).
 *
 * The Stripe webhook → shop branch is already covered by
 * `stripe-webhook-shop-receipt.test.ts`. This test exercises the *other*
 * settlement path — `POST /organizations/:orgId/shop/orders/verify-cart`
 * with a `stripeCheckoutSessionId` — which is what the storefront calls
 * the moment Checkout returns. A regression here would silently stop
 * receipt emails for the fastest, most common settlement path.
 *
 * Confirms that:
 *   1. The pending shop order flips to `paid` and records the Stripe
 *      payment ref + payment mode.
 *   2. `sendShopOrderReceiptEmail` is invoked with the buyer details,
 *      line items, total and Stripe payment id derived from the order.
 *   3. Re-posting the same session does not re-send the receipt email —
 *      the second call fails the `status = "pending"` lookup so no
 *      duplicate mail / settlement work happens.
 *
 * The Stripe verifier and the receipt mailer are both mocked at module
 * boundaries so we don't touch Stripe or SMTP.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendShopOrderReceiptEmail: vi.fn(
    async (_opts: Record<string, unknown>) => undefined,
  ),
  sendDuesReceiptEmail: vi.fn(
    async (_opts: Record<string, unknown>) => undefined,
  ),
  sendReceiptEmail: vi.fn(
    async (_opts: Record<string, unknown>) => undefined,
  ),
  verifyCheckoutPayment: vi.fn(
    async (_opts: Record<string, unknown>): Promise<{
      paid: boolean;
      amountMinor: number;
      currency: string;
      paymentRef: string;
      objectId: string;
      metadata: Record<string, unknown>;
    }> => ({
      paid: true,
      amountMinor: 0,
      currency: "INR",
      paymentRef: "",
      objectId: "",
      metadata: {},
    }),
  ),
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
  shopOrdersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

async function setupShopOrder(opts: { sessionId: string; quantity?: number; size?: string | null }) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `Shop Verify Test ${suffix}`,
    slug: `shop-verify-${suffix}`,
    // Shop router is gated by `shopLockerAccess` (pro+); without an active
    // pro tier the verify-cart route returns 402 before our handler runs.
    subscriptionTier: "pro",
    subscriptionStatus: "active",
  }).returning();

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `shop-verify-${suffix}`,
    username: `shop_verify_${suffix}`,
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

  const qty = opts.quantity ?? 2;
  const total = (1500 * qty).toFixed(2);

  const [order] = await db.insert(shopOrdersTable).values({
    organizationId: org.id,
    productId: product.id,
    userId: user.id,
    customerName: "Buyer Test",
    customerEmail: user.email!,
    quantity: qty,
    size: opts.size === undefined ? "M" : opts.size,
    unitPrice: "1500.00",
    totalAmount: total,
    currency: "INR",
    razorpayOrderId: opts.sessionId,
    paymentMode: "stripe",
    status: "pending",
  }).returning();

  return { org, user, product, order };
}

/**
 * The receipt email is dispatched from a fire-and-forget async IIFE inside
 * the verify-cart route, so the response can return before the mailer call
 * resolves. Poll briefly until the mock is invoked (or until we hit timeout).
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor: predicate did not pass within ${timeoutMs}ms`);
}

beforeAll(() => {
  // Sensible default; individual tests override per session.
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

describe("POST /shop/orders/verify-cart → instant Stripe receipt email (Task #1134)", () => {
  it("flips the order to paid and invokes sendShopOrderReceiptEmail with the buyer + line items", async () => {
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const { org, user, product, order } = await setupShopOrder({ sessionId });

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
    expect(res.body.processor).toBe("stripe");
    expect(res.body.orderIds).toContain(order.id);

    // Stripe verifier was asked about the right session.
    expect(mocks.verifyCheckoutPayment).toHaveBeenCalledTimes(1);
    expect(mocks.verifyCheckoutPayment.mock.calls[0]![0]).toMatchObject({
      processor: "stripe",
      stripeCheckoutSessionId: sessionId,
    });

    // Order persisted as paid with the Stripe payment ref + mode.
    const [persisted] = await db.select().from(shopOrdersTable)
      .where(eq(shopOrdersTable.id, order.id));
    expect(persisted.status).toBe("paid");
    expect(persisted.razorpayPaymentId).toBe(`pi_${sessionId}`);
    expect(persisted.paymentMode).toBe("stripe");

    // Receipt mailer is dispatched from a fire-and-forget async block; wait
    // briefly until it lands before asserting the payload.
    await waitFor(() => mocks.sendShopOrderReceiptEmail.mock.calls.length >= 1);

    expect(mocks.sendShopOrderReceiptEmail).toHaveBeenCalledTimes(1);
    const call = mocks.sendShopOrderReceiptEmail.mock.calls[0]![0] as {
      email: string;
      buyerName: string;
      orderId: number;
      lineItems: Array<{ description: string; quantity: number; totalAmountSubunit: number }>;
      totalSubunit: number;
      currency: string;
      paymentId: string;
      branding?: { orgName?: string };
    };
    expect(call.email).toBe(order.customerEmail);
    expect(call.buyerName).toBe("Buyer Test");
    expect(call.orderId).toBe(order.id);
    expect(call.currency).toBe("INR");
    expect(call.paymentId).toBe(`pi_${sessionId}`);
    expect(call.totalSubunit).toBe(300000);
    expect(call.lineItems).toHaveLength(1);
    expect(call.lineItems[0]!.description).toBe(`${product.name} (M)`);
    expect(call.lineItems[0]!.quantity).toBe(2);
    expect(call.lineItems[0]!.totalAmountSubunit).toBe(300000);
    expect(call.branding?.orgName).toBe(org.name);

    // Dues receipt is NOT touched on the shop branch.
    expect(mocks.sendDuesReceiptEmail).not.toHaveBeenCalled();
  });

  it("does not re-send the receipt email when verify-cart is re-posted with the same session", async () => {
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_dup`;
    const { org, user, order } = await setupShopOrder({ sessionId });

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

    // First delivery — flips to paid + dispatches the receipt email.
    const r1 = await request(app)
      .post(`/api/organizations/${org.id}/shop/orders/verify-cart`)
      .set("Content-Type", "application/json")
      .send({ stripeCheckoutSessionId: sessionId });
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);

    await waitFor(() => mocks.sendShopOrderReceiptEmail.mock.calls.length >= 1);
    expect(mocks.sendShopOrderReceiptEmail).toHaveBeenCalledTimes(1);

    // Second (duplicate) verify — order is already paid so the
    // `status = "pending"` lookup returns nothing and the route
    // short-circuits with 400 before doing any further work.
    const r2 = await request(app)
      .post(`/api/organizations/${org.id}/shop/orders/verify-cart`)
      .set("Content-Type", "application/json")
      .send({ stripeCheckoutSessionId: sessionId });
    expect(r2.status).toBe(400);

    // Give the (non-existent) async block a moment to prove no extra
    // mailer call sneaks in after the response returns.
    await new Promise((r) => setTimeout(r, 100));
    expect(mocks.sendShopOrderReceiptEmail).toHaveBeenCalledTimes(1);

    // Order remains paid + untouched.
    const [final] = await db.select().from(shopOrdersTable)
      .where(eq(shopOrdersTable.id, order.id));
    expect(final.status).toBe("paid");
    expect(final.razorpayPaymentId).toBe(`pi_${sessionId}`);
  });

  it("only sends one receipt when verify-cart is posted concurrently for the same Stripe session (Task #1307)", async () => {
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_race`;
    const { org, user, order } = await setupShopOrder({ sessionId });

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
    // win the status-flip UPDATE — the other must NOT email a receipt.
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
    // means the route blew up under concurrency and is a regression.
    for (const r of [r1, r2]) {
      expect([200, 400]).toContain(r.status);
    }
    const okCount = [r1, r2].filter((r) => r.status === 200).length;
    expect(okCount).toBeGreaterThanOrEqual(1);

    // Wait for the winning request's fire-and-forget mailer to land,
    // then poll a short window so a stray second mailer call from the
    // loser would still be observed before we assert.
    await waitFor(() => mocks.sendShopOrderReceiptEmail.mock.calls.length >= 1);
    const settledAt = Date.now();
    while (Date.now() - settledAt < 250) {
      if (mocks.sendShopOrderReceiptEmail.mock.calls.length > 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(mocks.sendShopOrderReceiptEmail).toHaveBeenCalledTimes(1);

    // Order is paid exactly once with the right payment ref.
    const [final] = await db.select().from(shopOrdersTable)
      .where(eq(shopOrdersTable.id, order.id));
    expect(final.status).toBe("paid");
    expect(final.razorpayPaymentId).toBe(`pi_${sessionId}`);
  });
});
