/**
 * Regression test for Task #1955 — concurrent single-order verify calls
 * (the mobile-compat `POST /shop/orders/:orderId/verify` endpoint) for
 * the same Stripe Checkout session must NOT record two FX ledger rows.
 *
 * Same race-condition family as Task #1573 (which gated the FX
 * settlement insert on the verify-cart route behind
 * `flippedShopOrders.length > 0`). The single-order verify endpoint's
 * FX settlement insert was previously unconditional, so two concurrent
 * mobile retries for the same payment would both reach
 * `recordCheckoutSettlement` and write two `fx_ledger_entries` rows for
 * one settled order — inflating the org's settled-amount totals and
 * polluting FX reconciliation.
 *
 * The fix mirrors the existing receipt + push gating already present on
 * this endpoint: the FX settlement block now only runs for the request
 * that actually flipped the order to paid.
 *
 * Setup notes:
 *   - The org's club_currency_profile is set to USD so the booked
 *     currency (USD) differs from the settled currency (INR) the Stripe
 *     verifier returns. `recordCheckoutSettlement` short-circuits when
 *     booked == settled, so this is required to actually exercise the
 *     ledger insert path.
 *   - `getFxRate` falls through to the static USD->INR fallback rate
 *     when no `fx_rates` row is present, so we don't need to seed one.
 *   - Stripe verifier and the receipt mailer are mocked at module
 *     boundaries so the test never touches Stripe or SMTP.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
  shopOrdersTable,
  clubCurrencyProfilesTable,
  fxLedgerEntriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

async function setupOrgWithUsdProfile(opts: { sessionId: string }) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `Shop FX Single-Order Test ${suffix}`,
    slug: `shop-fx-single-${suffix}`,
    // Shop router is gated by `shopLockerAccess` (pro+).
    subscriptionTier: "pro",
    subscriptionStatus: "active",
  }).returning();

  // Booked currency = USD so the INR settlement actually triggers the
  // FX ledger insert path inside `recordCheckoutSettlement`.
  await db.insert(clubCurrencyProfilesTable).values({
    organizationId: org.id,
    baseCurrency: "USD",
    displayCurrencies: ["USD", "INR"],
  });

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `shop-fx-single-${suffix}`,
    username: `shop_fx_single_${suffix}`,
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

  const [order] = await db.insert(shopOrdersTable).values({
    organizationId: org.id,
    productId: product.id,
    userId: user.id,
    customerName: "Buyer Test",
    customerEmail: user.email!,
    quantity: 2,
    size: "M",
    unitPrice: "1500.00",
    totalAmount: "3000.00",
    currency: "INR",
    razorpayOrderId: opts.sessionId,
    paymentMode: "stripe",
    status: "pending",
  }).returning();

  return { org, user, product, order };
}

beforeEach(() => {
  mocks.sendShopOrderReceiptEmail.mockClear();
  mocks.sendDuesReceiptEmail.mockClear();
  mocks.sendReceiptEmail.mockClear();
  mocks.verifyCheckoutPayment.mockClear();
});

describe("POST /shop/orders/:orderId/verify → FX settlement is recorded once per order (Task #1955)", () => {
  it("only records one FX ledger row when single-order verify is posted concurrently for the same Stripe session", async () => {
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_sofxrace`;
    const { org, user, order } = await setupOrgWithUsdProfile({ sessionId });

    const buyer: TestUser = {
      id: user.id,
      username: user.username,
      role: "player",
      organizationId: org.id,
    };
    const app = createTestApp(buyer);

    mocks.verifyCheckoutPayment.mockResolvedValue({
      paid: true,
      amountMinor: 300000,
      currency: "INR",
      paymentRef: `pi_${sessionId}`,
      objectId: sessionId,
      metadata: { orgId: String(org.id) },
    });

    // Fire two single-order verify calls in parallel for the same Stripe
    // session. Both will read the same pending-order snapshot, but only
    // one will win the status-flip UPDATE — the other must NOT write a
    // second FX ledger row.
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/organizations/${org.id}/shop/orders/${order.id}/verify`)
        .set("Content-Type", "application/json")
        .send({ stripeCheckoutSessionId: sessionId }),
      request(app)
        .post(`/api/organizations/${org.id}/shop/orders/${order.id}/verify`)
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

    // Order is paid exactly once.
    const [persisted] = await db.select().from(shopOrdersTable)
      .where(eq(shopOrdersTable.id, order.id));
    expect(persisted.status).toBe("paid");
    expect(persisted.razorpayPaymentId).toBe(`pi_${sessionId}`);

    // Wait briefly to let any stray loser-thread settlement insert land
    // before asserting on the ledger count.
    await new Promise((r) => setTimeout(r, 250));

    const ledgerRows = await db.select().from(fxLedgerEntriesTable)
      .where(eq(fxLedgerEntriesTable.organizationId, org.id));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.bookedCurrency).toBe("USD");
    expect(ledgerRows[0]!.settledCurrency).toBe("INR");
    expect(ledgerRows[0]!.settledAmount).toBe("3000.00");
    expect(ledgerRows[0]!.sourceType).toBe("shop_order");
    expect(ledgerRows[0]!.sourceId).toBe(String(order.id));
    expect(ledgerRows[0]!.processor).toBe("stripe");
  });

  it("records exactly one FX ledger row on a normal (non-concurrent) settlement", async () => {
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_sofxsingle`;
    const { org, user, order } = await setupOrgWithUsdProfile({ sessionId });

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

    const r1 = await request(app)
      .post(`/api/organizations/${org.id}/shop/orders/${order.id}/verify`)
      .set("Content-Type", "application/json")
      .send({ stripeCheckoutSessionId: sessionId });
    expect(r1.status).toBe(200);

    // A second verify after the order is already paid must NOT write a
    // duplicate FX ledger row — the route's "Order is not in pending
    // state" guard rejects the request before reaching the insert.
    const r2 = await request(app)
      .post(`/api/organizations/${org.id}/shop/orders/${order.id}/verify`)
      .set("Content-Type", "application/json")
      .send({ stripeCheckoutSessionId: sessionId });
    expect(r2.status).toBe(400);

    await new Promise((r) => setTimeout(r, 100));

    const ledgerRows = await db.select().from(fxLedgerEntriesTable)
      .where(eq(fxLedgerEntriesTable.organizationId, org.id));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.sourceType).toBe("shop_order");
    expect(ledgerRows[0]!.sourceId).toBe(String(order.id));
  });
});
