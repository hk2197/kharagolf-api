/**
 * Integration tests: in-app push notification (`notifyStripePaymentSettled`)
 * for the Razorpay branches added in Task #978 / #1136.
 *
 * Covers:
 *   - POST /api/payments/tournament-player/:id/verify (Razorpay)
 *   - POST /api/payments/league-member/:id/verify   (Razorpay)
 *   - POST /api/payments/webhook  payment.captured  (player + member)
 *   - POST /api/payments/webhook  payment_link.paid (player + member)
 *   - POST /api/organizations/:orgId/shop/orders/verify-cart   (Razorpay)
 *   - POST /api/organizations/:orgId/shop/orders/:orderId/verify (Razorpay)
 *   - POST /api/organizations/:orgId/dues-billing/invoices/:id/verify-payment
 *   - POST /api/webhooks/razorpay-subscription  subscription.charged
 *
 * For each surface we assert that the push fires exactly once on the
 * status-flip transition and that idempotency guards (status-flip /
 * lastPaymentId for subscriptions) prevent re-fires on duplicate deliveries.
 *
 * `notifyStripePaymentSettled` itself, the Razorpay signature verifier, and
 * all receipt-email side-effect helpers are mocked at module boundaries.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notifyStripePaymentSettled: vi.fn(
    async (_opts: Record<string, unknown>) => ({ status: "sent" as const }),
  ),
  notifyHighlightReady: vi.fn(
    async (_opts: Record<string, unknown>) => ({ status: "sent" as const }),
  ),
  verifyPaymentSignature: vi.fn(() => true),
  sendReceiptEmail: vi.fn(async () => undefined),
  sendShopOrderReceiptEmail: vi.fn(async () => undefined),
  sendDuesReceiptEmail: vi.fn(async () => undefined),
  sendBroadcastEmail: vi.fn(async () => undefined),
}));

vi.mock("../lib/notifications", () => ({
  notifyStripePaymentSettled: mocks.notifyStripePaymentSettled,
  notifyHighlightReady: mocks.notifyHighlightReady,
}));

vi.mock("../lib/razorpay", async () => {
  const actual = await vi.importActual<typeof import("../lib/razorpay")>("../lib/razorpay");
  return {
    ...actual,
    verifyPaymentSignature: mocks.verifyPaymentSignature,
  };
});

vi.mock("../lib/paymentReceipts", () => ({
  sendReceiptEmail: mocks.sendReceiptEmail,
  sendShopOrderReceiptEmail: mocks.sendShopOrderReceiptEmail,
  sendDuesReceiptEmail: mocks.sendDuesReceiptEmail,
  currencySymbol: (c: string) => (c === "INR" ? "₹" : c),
}));

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  leaguesTable,
  leagueMembersTable,
  shopProductsTable,
  shopOrdersTable,
  clubMembersTable,
  memberInvoicesTable,
  memberSubscriptionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

// ─── Env preserve/restore ──────────────────────────────────────────────────
let prevWebhookSecret: string | undefined;
let prevNodeEnv: string | undefined;

beforeAll(() => {
  prevWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  prevNodeEnv = process.env.NODE_ENV;
  // Both Razorpay webhook handlers (payments and subscription) skip signature
  // verification when no secret is configured. The subscription handler
  // additionally requires NODE_ENV === "development" to allow the missing
  // secret (otherwise it fails closed with 503).
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.NODE_ENV = "development";
});

afterAll(() => {
  if (prevWebhookSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
  else process.env.RAZORPAY_WEBHOOK_SECRET = prevWebhookSecret;
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
});

beforeEach(() => {
  mocks.notifyStripePaymentSettled.mockClear();
  mocks.verifyPaymentSignature.mockClear();
  mocks.verifyPaymentSignature.mockReturnValue(true);
  mocks.sendReceiptEmail.mockClear();
  mocks.sendShopOrderReceiptEmail.mockClear();
  mocks.sendDuesReceiptEmail.mockClear();
});

function suffix() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function makeOrg(opts?: { tier?: "free" | "pro" }) {
  const s = suffix();
  const values: typeof organizationsTable.$inferInsert = {
    name: `RzpNotify ${s}`,
    slug: `rzp-notify-${s}`,
  };
  if (opts?.tier) values.subscriptionTier = opts.tier;
  const [org] = await db.insert(organizationsTable).values(values).returning();
  return org;
}

async function makeUser(orgId?: number) {
  const s = suffix();
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `rzp-${s}`,
    username: `rzp_${s}`,
    email: `${s}@example.test`,
    displayName: "Razorpay Tester",
    role: "player",
    organizationId: orgId,
  }).returning();
  return u;
}

// ─── Tournament-player verify (Razorpay) ───────────────────────────────────
describe("POST /payments/tournament-player/:id/verify (Razorpay)", () => {
  it("fires the push once on the pending → paid flip and skips on re-verify", async () => {
    const org = await makeOrg();
    const user = await makeUser(org.id);
    const [course] = await db.insert(coursesTable).values({
      organizationId: org.id, name: `C ${suffix()}`, slug: `c-${suffix()}`,
    }).returning();
    const [tour] = await db.insert(tournamentsTable).values({
      organizationId: org.id, courseId: course.id,
      name: "Razorpay Open", startDate: new Date(), rounds: 1,
      entryFee: "1500.00", currency: "INR",
    }).returning();
    const orderId = `order_rzp_${suffix()}`;
    const [player] = await db.insert(playersTable).values({
      tournamentId: tour.id, userId: user.id,
      firstName: "Pay", lastName: "Player",
      paymentStatus: "unpaid", razorpayOrderId: orderId,
    }).returning();

    const app = createTestApp();
    const body = {
      razorpay_order_id: orderId,
      razorpay_payment_id: `pay_${suffix()}`,
      razorpay_signature: "sig",
    };
    const r1 = await request(app).post(`/api/payments/tournament-player/${player.id}/verify`).send(body);
    expect(r1.status).toBe(200);
    expect(r1.body.processor).toBe("razorpay");
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
    const call = mocks.notifyStripePaymentSettled.mock.calls[0]![0];
    expect(call).toMatchObject({
      userId: user.id, kind: "tournament", eventName: "Razorpay Open",
      currency: "INR", paymentRef: body.razorpay_payment_id,
      organizationId: org.id, entityId: tour.id, amountMinor: 150000,
    });

    // Re-verify: status already paid, push must NOT fire again.
    // Re-set razorpayOrderId because the first verify nulled it; the route
    // requires the order id to match before processing — otherwise it
    // short-circuits with 400 *before* touching the push path.
    await db.update(playersTable)
      .set({ razorpayOrderId: orderId })
      .where(eq(playersTable.id, player.id));
    const r2 = await request(app).post(`/api/payments/tournament-player/${player.id}/verify`).send(body);
    expect(r2.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
  });
});

// ─── League-member verify (Razorpay) ───────────────────────────────────────
describe("POST /payments/league-member/:id/verify (Razorpay)", () => {
  it("fires the push once on the pending → paid flip and skips on re-verify", async () => {
    const org = await makeOrg();
    const user = await makeUser(org.id);
    const [league] = await db.insert(leaguesTable).values({
      organizationId: org.id, name: "Razorpay League",
      entryFee: "2500.00", currency: "INR",
    }).returning();
    const orderId = `order_rzp_${suffix()}`;
    const [member] = await db.insert(leagueMembersTable).values({
      leagueId: league.id, userId: user.id,
      firstName: "Pay", lastName: "Member",
      paymentStatus: "unpaid", razorpayOrderId: orderId,
    }).returning();

    const app = createTestApp();
    const body = {
      razorpay_order_id: orderId,
      razorpay_payment_id: `pay_${suffix()}`,
      razorpay_signature: "sig",
    };
    const r1 = await request(app).post(`/api/payments/league-member/${member.id}/verify`).send(body);
    expect(r1.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
    expect(mocks.notifyStripePaymentSettled.mock.calls[0]![0]).toMatchObject({
      userId: user.id, kind: "league", eventName: "Razorpay League",
      currency: "INR", paymentRef: body.razorpay_payment_id,
      organizationId: org.id, entityId: league.id, amountMinor: 250000,
    });

    await db.update(leagueMembersTable)
      .set({ razorpayOrderId: orderId })
      .where(eq(leagueMembersTable.id, member.id));
    const r2 = await request(app).post(`/api/payments/league-member/${member.id}/verify`).send(body);
    expect(r2.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
  });
});

// ─── /payments/webhook payment.captured ────────────────────────────────────
describe("POST /payments/webhook  payment.captured (Razorpay)", () => {
  it("fires push for tournament player on first delivery; redelivery is a no-op", async () => {
    const org = await makeOrg();
    const user = await makeUser(org.id);
    const [course] = await db.insert(coursesTable).values({
      organizationId: org.id, name: `C ${suffix()}`, slug: `c-${suffix()}`,
    }).returning();
    const [tour] = await db.insert(tournamentsTable).values({
      organizationId: org.id, courseId: course.id,
      name: "Webhook Open", startDate: new Date(), rounds: 1,
      entryFee: "1000.00", currency: "INR",
    }).returning();
    const [player] = await db.insert(playersTable).values({
      tournamentId: tour.id, userId: user.id,
      firstName: "WH", lastName: "Player",
      paymentStatus: "unpaid",
    }).returning();

    const app = createTestApp();
    const paymentId = `pay_wh_${suffix()}`;
    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: paymentId, amount: 100000, currency: "INR",
            notes: { playerId: String(player.id) },
          },
        },
      },
    };
    const r1 = await request(app).post(`/api/payments/webhook`).send(event);
    expect(r1.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
    expect(mocks.notifyStripePaymentSettled.mock.calls[0]![0]).toMatchObject({
      userId: user.id, kind: "tournament", eventName: "Webhook Open",
      paymentRef: paymentId, amountMinor: 100000, currency: "INR",
      organizationId: org.id, entityId: tour.id,
    });

    // Redelivery: already paid → status-flip guard returns 0 rows → no push.
    const r2 = await request(app).post(`/api/payments/webhook`).send(event);
    expect(r2.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
  });

  it("fires push for league member on first delivery; redelivery is a no-op", async () => {
    const org = await makeOrg();
    const user = await makeUser(org.id);
    const [league] = await db.insert(leaguesTable).values({
      organizationId: org.id, name: "Webhook League",
      entryFee: "500.00", currency: "INR",
    }).returning();
    const [member] = await db.insert(leagueMembersTable).values({
      leagueId: league.id, userId: user.id,
      firstName: "WH", lastName: "Member",
      paymentStatus: "unpaid",
    }).returning();

    const app = createTestApp();
    const paymentId = `pay_wh_${suffix()}`;
    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: paymentId, amount: 50000, currency: "INR",
            notes: { memberId: String(member.id) },
          },
        },
      },
    };
    const r1 = await request(app).post(`/api/payments/webhook`).send(event);
    expect(r1.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
    expect(mocks.notifyStripePaymentSettled.mock.calls[0]![0]).toMatchObject({
      userId: user.id, kind: "league", eventName: "Webhook League",
      paymentRef: paymentId, amountMinor: 50000, organizationId: org.id, entityId: league.id,
    });

    const r2 = await request(app).post(`/api/payments/webhook`).send(event);
    expect(r2.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
  });
});

// ─── /payments/webhook payment_link.paid ───────────────────────────────────
describe("POST /payments/webhook  payment_link.paid (Razorpay)", () => {
  it("fires push for tournament player; redelivery is a no-op", async () => {
    const org = await makeOrg();
    const user = await makeUser(org.id);
    const [course] = await db.insert(coursesTable).values({
      organizationId: org.id, name: `C ${suffix()}`, slug: `c-${suffix()}`,
    }).returning();
    const [tour] = await db.insert(tournamentsTable).values({
      organizationId: org.id, courseId: course.id,
      name: "Link Open", startDate: new Date(), rounds: 1,
      entryFee: "750.00", currency: "INR",
    }).returning();
    const [player] = await db.insert(playersTable).values({
      tournamentId: tour.id, userId: user.id,
      firstName: "Link", lastName: "Player",
      paymentStatus: "unpaid",
    }).returning();

    const app = createTestApp();
    const paymentId = `pay_pl_${suffix()}`;
    const event = {
      event: "payment_link.paid",
      payload: {
        payment_link: { entity: { notes: { playerId: String(player.id) } } },
        payment: { entity: { id: paymentId } },
      },
    };
    const r1 = await request(app).post(`/api/payments/webhook`).send(event);
    expect(r1.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
    expect(mocks.notifyStripePaymentSettled.mock.calls[0]![0]).toMatchObject({
      userId: user.id, kind: "tournament", eventName: "Link Open",
      paymentRef: paymentId, amountMinor: 75000,
      organizationId: org.id, entityId: tour.id,
    });

    const r2 = await request(app).post(`/api/payments/webhook`).send(event);
    expect(r2.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
  });

  it("fires push for league member; redelivery is a no-op", async () => {
    const org = await makeOrg();
    const user = await makeUser(org.id);
    const [league] = await db.insert(leaguesTable).values({
      organizationId: org.id, name: "Link League",
      entryFee: "1200.00", currency: "INR",
    }).returning();
    const [member] = await db.insert(leagueMembersTable).values({
      leagueId: league.id, userId: user.id,
      firstName: "Link", lastName: "Member",
      paymentStatus: "unpaid",
    }).returning();

    const app = createTestApp();
    const paymentId = `pay_pl_${suffix()}`;
    const event = {
      event: "payment_link.paid",
      payload: {
        payment_link: { entity: { notes: { memberId: String(member.id) } } },
        payment: { entity: { id: paymentId } },
      },
    };
    const r1 = await request(app).post(`/api/payments/webhook`).send(event);
    expect(r1.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
    expect(mocks.notifyStripePaymentSettled.mock.calls[0]![0]).toMatchObject({
      userId: user.id, kind: "league", eventName: "Link League",
      paymentRef: paymentId, amountMinor: 120000,
      organizationId: org.id, entityId: league.id,
    });

    const r2 = await request(app).post(`/api/payments/webhook`).send(event);
    expect(r2.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
  });
});

// ─── Shop /verify-cart (Razorpay) ──────────────────────────────────────────
describe("POST /shop/orders/verify-cart (Razorpay)", () => {
  it("fires the push once on the pending → paid flip and skips on re-verify", async () => {
    const org = await makeOrg({ tier: "pro" });
    const user = await makeUser(org.id);
    const [product] = await db.insert(shopProductsTable).values({
      organizationId: org.id, name: "Cap", basePrice: "100.00", markupPrice: "150.00", currency: "INR",
    }).returning();
    const orderId = `order_rzp_${suffix()}`;
    const [order] = await db.insert(shopOrdersTable).values({
      organizationId: org.id, productId: product.id, userId: user.id,
      customerName: "Buyer", customerEmail: `buyer_${suffix()}@example.com`,
      quantity: 2, unitPrice: "150.00", totalAmount: "300.00", currency: "INR",
      razorpayOrderId: orderId, paymentMode: "razorpay", status: "pending",
    }).returning();

    const tu: TestUser = { id: user.id, username: user.username ?? "u", role: "player" };
    const app = createTestApp(tu);
    const paymentId = `pay_${suffix()}`;
    const body = {
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: "sig",
    };
    const r1 = await request(app).post(`/api/organizations/${org.id}/shop/orders/verify-cart`).send(body);
    expect(r1.status).toBe(200);
    expect(r1.body.processor).toBe("razorpay");
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
    expect(mocks.notifyStripePaymentSettled.mock.calls[0]![0]).toMatchObject({
      userId: user.id, kind: "shop", paymentRef: paymentId,
      amountMinor: 30000, currency: "INR",
      organizationId: org.id, entityId: order.id,
    });

    // Second verify attempt: order already paid, no pending row matches.
    // Route returns 400 "No pending orders found" — push must not fire again.
    const r2 = await request(app).post(`/api/organizations/${org.id}/shop/orders/verify-cart`).send(body);
    expect(r2.status).toBe(400);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
  });
});

// ─── Shop single-order /verify (Razorpay) ──────────────────────────────────
describe("POST /shop/orders/:orderId/verify (Razorpay)", () => {
  it("fires the push once on the pending → paid flip and skips on re-verify", async () => {
    const org = await makeOrg({ tier: "pro" });
    const user = await makeUser(org.id);
    const [product] = await db.insert(shopProductsTable).values({
      organizationId: org.id, name: "Glove", basePrice: "100.00", markupPrice: "200.00", currency: "INR",
    }).returning();
    const orderId = `order_rzp_${suffix()}`;
    const [order] = await db.insert(shopOrdersTable).values({
      organizationId: org.id, productId: product.id, userId: user.id,
      customerName: "Buyer", customerEmail: `buyer_${suffix()}@example.com`,
      quantity: 1, unitPrice: "200.00", totalAmount: "200.00", currency: "INR",
      razorpayOrderId: orderId, paymentMode: "razorpay", status: "pending",
    }).returning();

    const tu: TestUser = { id: user.id, username: user.username ?? "u", role: "player" };
    const app = createTestApp(tu);
    const paymentId = `pay_${suffix()}`;
    const body = {
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: "sig",
    };
    const r1 = await request(app).post(`/api/organizations/${org.id}/shop/orders/${order.id}/verify`).send(body);
    expect(r1.status).toBe(200);
    expect(r1.body.processor).toBe("razorpay");
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
    expect(mocks.notifyStripePaymentSettled.mock.calls[0]![0]).toMatchObject({
      userId: user.id, kind: "shop", paymentRef: paymentId,
      amountMinor: 20000, currency: "INR",
      organizationId: org.id, entityId: order.id,
    });

    // Re-verify: order is now paid, route rejects with 400 ("not in pending state").
    const r2 = await request(app).post(`/api/organizations/${org.id}/shop/orders/${order.id}/verify`).send(body);
    expect(r2.status).toBe(400);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
  });
});

// ─── Dues invoice /verify-payment (Razorpay) ───────────────────────────────
describe("POST /dues-billing/invoices/:id/verify-payment (Razorpay)", () => {
  it("fires the push once on the pending → paid flip and skips on re-verify", async () => {
    const org = await makeOrg({ tier: "pro" });
    const user = await makeUser(org.id);
    const [member] = await db.insert(clubMembersTable).values({
      organizationId: org.id, userId: user.id,
      firstName: "Dues", lastName: "Member", email: `dues_${suffix()}@example.com`,
    }).returning();
    const invoiceNumber = `INV-${suffix()}`;
    const [invoice] = await db.insert(memberInvoicesTable).values({
      organizationId: org.id, clubMemberId: member.id,
      invoiceNumber, status: "sent",
      totalAmount: "5000.00", currency: "INR",
    }).returning();

    const tu: TestUser = { id: user.id, username: user.username ?? "u", role: "player" };
    const app = createTestApp(tu);
    const body = { razorpayPaymentId: `pay_${suffix()}` };

    const r1 = await request(app)
      .post(`/api/organizations/${org.id}/dues-billing/invoices/${invoice.id}/verify-payment`)
      .send(body);
    expect(r1.status).toBe(200);
    expect(r1.body.processor).toBe("razorpay");
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
    expect(mocks.notifyStripePaymentSettled.mock.calls[0]![0]).toMatchObject({
      userId: user.id, kind: "dues",
      paymentRef: body.razorpayPaymentId,
      amountMinor: 500000, currency: "INR",
      organizationId: org.id, entityId: invoice.id,
    });

    // Re-verify: invoice is now paid → status-flip guard returns 0 rows → no push.
    const r2 = await request(app)
      .post(`/api/organizations/${org.id}/dues-billing/invoices/${invoice.id}/verify-payment`)
      .send(body);
    expect(r2.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
  });
});

// ─── /webhooks/razorpay-subscription subscription.charged ──────────────────
describe("POST /webhooks/razorpay-subscription  subscription.charged", () => {
  it("fires push on first charge; redelivery with same payment id is idempotent", async () => {
    const org = await makeOrg();
    const user = await makeUser(org.id);
    const [member] = await db.insert(clubMembersTable).values({
      organizationId: org.id, userId: user.id,
      firstName: "Sub", lastName: "Member", email: `sub_${suffix()}@example.com`,
    }).returning();
    const subscriptionId = `sub_${suffix()}`;
    await db.insert(memberSubscriptionsTable).values({
      organizationId: org.id, clubMemberId: member.id,
      razorpaySubscriptionId: subscriptionId, status: "pending",
    });

    const app = createTestApp();
    const paymentId = `pay_sub_${suffix()}`;
    const event = {
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: subscriptionId, charge_at: Math.floor(Date.now() / 1000) + 86400 } },
        payment: { entity: { id: paymentId, amount: 250000, currency: "INR" } },
      },
    };

    const r1 = await request(app).post(`/api/webhooks/razorpay-subscription`).send(event);
    expect(r1.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);
    expect(mocks.notifyStripePaymentSettled.mock.calls[0]![0]).toMatchObject({
      userId: user.id, kind: "dues",
      paymentRef: paymentId, amountMinor: 250000, currency: "INR",
      organizationId: org.id,
    });

    // Redelivery with same payment id — idempotent (lastPaymentId match).
    const r2 = await request(app).post(`/api/webhooks/razorpay-subscription`).send(event);
    expect(r2.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(1);

    // A genuinely new charge (different payment id) DOES fire again.
    const newPaymentId = `pay_sub_${suffix()}_new`;
    const event2 = {
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: subscriptionId, charge_at: Math.floor(Date.now() / 1000) + 2 * 86400 } },
        payment: { entity: { id: newPaymentId, amount: 250000, currency: "INR" } },
      },
    };
    const r3 = await request(app).post(`/api/webhooks/razorpay-subscription`).send(event2);
    expect(r3.status).toBe(200);
    expect(mocks.notifyStripePaymentSettled).toHaveBeenCalledTimes(2);
    expect(mocks.notifyStripePaymentSettled.mock.calls[1]![0]).toMatchObject({
      paymentRef: newPaymentId,
    });
  });
});
