/**
 * Integration test: dues verify-payment endpoint → PDF receipt email
 * (Task #976 covering the dues receipt flow added in Task #831).
 *
 * Confirms that POSTing a successful Stripe checkout-session verification to
 * `/api/organizations/:orgId/dues-billing/invoices/:id/verify-payment`
 * marks the invoice paid AND triggers `sendDuesReceiptEmail` with a line
 * item, total and payment id derived from the invoice.
 *
 * The Stripe verifier and the receipt mailer are both mocked at module
 * boundaries — the test exercises the route's plumbing, not the underlying
 * payment processor or SMTP.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendDuesReceiptEmail: vi.fn(
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
  sendDuesReceiptEmail: mocks.sendDuesReceiptEmail,
  // Other helpers aren't called from this route, but we re-export shapes the
  // module advertises so any stray import elsewhere doesn't blow up.
  sendShopOrderReceiptEmail: vi.fn(async () => undefined),
  sendReceiptEmail: vi.fn(async () => undefined),
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
  orgMembershipsTable,
  clubMembersTable,
  memberInvoicesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

async function setupInvoice(opts: { sessionId: string; totalAmount?: string; currency?: string }) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `Dues Receipt Test ${suffix}`,
    slug: `dues-receipt-${suffix}`,
    // duesBilling is gated to pro/enterprise tiers; the verify-payment route
    // sits behind the `gateFeature("duesBilling")` middleware.
    subscriptionTier: "pro",
    subscriptionStatus: "active",
  }).returning();

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `dues-${suffix}`,
    username: `dues_${suffix}`,
    role: "org_admin",
  }).returning();

  await db.insert(orgMembershipsTable).values({
    userId: user.id,
    organizationId: org.id,
    role: "org_admin",
  });

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: org.id,
    userId: user.id,
    firstName: "Dues",
    lastName: "Member",
    email: `member_${suffix}@example.com`,
    memberNumber: `M-${suffix}`,
    subscriptionStatus: "active",
  }).returning();

  const totalAmount = opts.totalAmount ?? "5000.00";
  const invoiceNumber = `INV-${suffix}`;
  const [invoice] = await db.insert(memberInvoicesTable).values({
    organizationId: org.id,
    clubMemberId: member.id,
    invoiceNumber,
    status: "sent",
    totalAmount,
    currency: opts.currency ?? "INR",
    razorpayPaymentLinkId: opts.sessionId,
  }).returning();

  return { org, user, member, invoice };
}

beforeAll(() => {
  // Default the Stripe verifier mock to "paid" — individual tests override
  // metadata + amount as needed.
  mocks.verifyCheckoutPayment.mockResolvedValue({
    paid: true,
    amountMinor: 500000,
    currency: "INR",
    paymentRef: "pi_test_default",
    objectId: "cs_test_default",
    metadata: {},
  });
});

beforeEach(() => {
  mocks.sendDuesReceiptEmail.mockClear();
  mocks.verifyCheckoutPayment.mockClear();
});

describe("POST /dues-billing/invoices/:id/verify-payment → PDF receipt email", () => {
  it("flips the invoice to paid and invokes sendDuesReceiptEmail with member + line item details", async () => {
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const { org, user, member, invoice } = await setupInvoice({ sessionId });

    const adminUser: TestUser = {
      id: user.id,
      username: user.username,
      role: "org_admin",
      organizationId: org.id,
    };
    const app = createTestApp(adminUser);

    mocks.verifyCheckoutPayment.mockResolvedValueOnce({
      paid: true,
      amountMinor: 500000,
      currency: "INR",
      paymentRef: `pi_${sessionId}`,
      objectId: sessionId,
      metadata: { invoiceId: String(invoice.id), orgId: String(org.id) },
    });

    const res = await request(app)
      .post(`/api/organizations/${org.id}/dues-billing/invoices/${invoice.id}/verify-payment`)
      .set("Content-Type", "application/json")
      .send({ stripeCheckoutSessionId: sessionId });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paid");
    expect(res.body.processor).toBe("stripe");

    // Stripe verifier got the right session id.
    expect(mocks.verifyCheckoutPayment).toHaveBeenCalledTimes(1);
    expect(mocks.verifyCheckoutPayment.mock.calls[0]![0]).toMatchObject({
      processor: "stripe",
      stripeCheckoutSessionId: sessionId,
    });

    // Invoice persisted as paid with the Stripe payment ref.
    const [persisted] = await db.select().from(memberInvoicesTable)
      .where(eq(memberInvoicesTable.id, invoice.id));
    expect(persisted.status).toBe("paid");
    expect(persisted.razorpayPaymentId).toBe(`pi_${sessionId}`);

    // Receipt email captured with the right shape.
    expect(mocks.sendDuesReceiptEmail).toHaveBeenCalledTimes(1);
    const call = mocks.sendDuesReceiptEmail.mock.calls[0]![0] as {
      email: string;
      memberName: string;
      invoiceId: number;
      invoiceNumber: string;
      lineItems: Array<{ description: string; quantity: number; totalAmountSubunit: number }>;
      totalSubunit: number;
      currency: string;
      paymentId: string;
      branding?: { orgName?: string };
    };
    expect(call.email).toBe(member.email);
    expect(call.memberName).toBe("Dues Member");
    expect(call.invoiceId).toBe(invoice.id);
    expect(call.invoiceNumber).toBe(invoice.invoiceNumber);
    expect(call.totalSubunit).toBe(500000);
    expect(call.currency).toBe("INR");
    expect(call.paymentId).toBe(`pi_${sessionId}`);
    expect(call.lineItems).toHaveLength(1);
    expect(call.lineItems[0]!.description).toContain(invoice.invoiceNumber);
    expect(call.lineItems[0]!.totalAmountSubunit).toBe(500000);
    expect(call.branding?.orgName).toBe(org.name);
  });

  it("rejects with 400 and does NOT send a receipt email when Stripe metadata is mismatched", async () => {
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_bad`;
    const { org, user, invoice } = await setupInvoice({ sessionId });

    const app = createTestApp({
      id: user.id,
      username: user.username,
      role: "org_admin",
      organizationId: org.id,
    });

    mocks.verifyCheckoutPayment.mockResolvedValueOnce({
      paid: true,
      amountMinor: 500000,
      currency: "INR",
      paymentRef: `pi_${sessionId}`,
      objectId: sessionId,
      // Mismatched invoiceId metadata — should be rejected.
      metadata: { invoiceId: "999999", orgId: String(org.id) },
    });

    const res = await request(app)
      .post(`/api/organizations/${org.id}/dues-billing/invoices/${invoice.id}/verify-payment`)
      .set("Content-Type", "application/json")
      .send({ stripeCheckoutSessionId: sessionId });

    expect(res.status).toBe(400);
    expect(mocks.sendDuesReceiptEmail).not.toHaveBeenCalled();

    // Invoice unchanged.
    const [persisted] = await db.select().from(memberInvoicesTable)
      .where(eq(memberInvoicesTable.id, invoice.id));
    expect(persisted.status).toBe("sent");
  });
});
