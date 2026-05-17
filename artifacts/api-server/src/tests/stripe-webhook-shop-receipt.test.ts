/**
 * Integration test: Stripe webhook → shop-order receipt branch (Task #976
 * covering the shop receipt flow added in Task #831).
 *
 * Verifies that when a `checkout.session.completed` event lands for a
 * pending shop order:
 *   1. The order flips to `paid`.
 *   2. `sendShopOrderReceiptEmail` is invoked with line items, total and
 *      buyer details derived from the original order.
 *   3. A duplicate webhook delivery (Stripe retries the same event) does
 *      NOT trigger a second receipt email — the status-gated update
 *      (`if (o.status !== "pending") continue;`) protects against resend.
 *
 * The mailer side-effect path is mocked at the `paymentReceipts` boundary
 * so we can spy on the call without touching SMTP / object storage.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendShopOrderReceiptEmail: vi.fn(
    async (_opts: {
      email: string;
      buyerName: string;
      orderId: number;
      lineItems: Array<{ description: string; quantity: number; totalAmountSubunit: number }>;
      totalSubunit: number;
      currency: string;
      paymentId: string;
      paidAt?: Date;
      branding?: { orgName?: string; orgId?: number };
    }): Promise<void> => undefined,
  ),
  sendDuesReceiptEmail: vi.fn(async () => undefined),
  sendReceiptEmail: vi.fn(async () => undefined),
}));
const { sendShopOrderReceiptEmail, sendDuesReceiptEmail } = mocks;

vi.mock("../lib/paymentReceipts", () => ({
  sendShopOrderReceiptEmail: mocks.sendShopOrderReceiptEmail,
  sendDuesReceiptEmail: mocks.sendDuesReceiptEmail,
  sendReceiptEmail: mocks.sendReceiptEmail,
  currencySymbol: (c: string) => (c === "INR" ? "₹" : c),
}));

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  shopProductsTable,
  shopOrdersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

const app = createTestApp();

let prevNodeEnv: string | undefined;
let prevWebhookSecret: string | undefined;

beforeAll(() => {
  // The Stripe webhook handler skips signature verification when running in
  // development AND no STRIPE_WEBHOOK_SECRET is configured. We need both for
  // these tests to pass without forging a real signature.
  prevNodeEnv = process.env.NODE_ENV;
  prevWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.NODE_ENV = "development";
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

afterAll(() => {
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
  if (prevWebhookSecret !== undefined) process.env.STRIPE_WEBHOOK_SECRET = prevWebhookSecret;
});

beforeEach(() => {
  sendShopOrderReceiptEmail.mockClear();
  sendDuesReceiptEmail.mockClear();
  mocks.sendReceiptEmail.mockClear();
});

async function setupShopOrder(opts: { sessionId: string; quantity?: number; size?: string | null }) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `Shop Webhook Test ${suffix}`,
    slug: `shop-wh-${suffix}`,
  }).returning();

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `shop-wh-${suffix}`,
    username: `shop_wh_${suffix}`,
    role: "player",
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
    customerEmail: `buyer_${suffix}@example.com`,
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

function stripeSessionEvent(sessionId: string, opts: { amountMinor: number; currency?: string }) {
  return {
    id: `evt_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        payment_intent: `pi_${sessionId}`,
        payment_status: "paid",
        amount_total: opts.amountMinor,
        currency: (opts.currency ?? "INR").toLowerCase(),
        metadata: {},
      },
    },
  };
}

describe("Stripe webhook → shop order receipt (Task #976 / #831)", () => {
  it("invokes sendShopOrderReceiptEmail with the buyer + line items and flips the order to paid", async () => {
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const { org, order, product } = await setupShopOrder({ sessionId });

    const event = stripeSessionEvent(sessionId, { amountMinor: 300000 });
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);

    // Order is now paid + payment ref recorded.
    const [updated] = await db.select().from(shopOrdersTable).where(eq(shopOrdersTable.id, order.id));
    expect(updated.status).toBe("paid");
    expect(updated.razorpayPaymentId).toBe(`pi_${sessionId}`);
    expect(updated.paymentMode).toBe("stripe");

    // Receipt email captured with the right shape.
    expect(sendShopOrderReceiptEmail).toHaveBeenCalledTimes(1);
    const call = sendShopOrderReceiptEmail.mock.calls[0]![0] as {
      email: string;
      buyerName: string;
      orderId: number;
      lineItems: Array<{ description: string; quantity: number; totalAmountSubunit: number }>;
      totalSubunit: number;
      currency: string;
      paymentId: string;
      branding?: { orgName?: string; orgId?: number };
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
    // Task #1319 — orgId must be present in the branding so the Postmark
    // bounce webhook (Task #981) can attribute hard bounces back to this
    // club instantly, instead of falling through to the campaign /
    // membership scan fallback.
    expect(call.branding?.orgId).toBe(org.id);

    // Dues receipt is NOT touched on the shop branch.
    expect(sendDuesReceiptEmail).not.toHaveBeenCalled();
  });

  it("does not re-send the receipt email when Stripe redelivers the same event", async () => {
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_dup`;
    const { order } = await setupShopOrder({ sessionId });

    const event = stripeSessionEvent(sessionId, { amountMinor: 300000 });

    // First delivery — applies + sends email.
    const r1 = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(event);
    expect(r1.status).toBe(200);
    expect(r1.body.applied).toBe(true);
    expect(sendShopOrderReceiptEmail).toHaveBeenCalledTimes(1);

    // Second (duplicate) delivery — order is already paid, so the
    // status-gated update short-circuits and no further email is sent.
    const r2 = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(event);
    expect(r2.status).toBe(200);
    expect(r2.body.applied).toBe(false);

    expect(sendShopOrderReceiptEmail).toHaveBeenCalledTimes(1);

    // Order remains paid and untouched (no extra mutations).
    const [final] = await db.select().from(shopOrdersTable).where(eq(shopOrdersTable.id, order.id));
    expect(final.status).toBe("paid");
  });
});
