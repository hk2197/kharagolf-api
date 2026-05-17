/**
 * Task #769 — auto-refund a failed wallet top-up if the bank charged the member.
 *
 * Two reconciliation paths are tested:
 *   1. `creditWalletTopupFromPayment` — invoked from the Razorpay webhook when
 *      a `payment.captured` event arrives for an order tagged `wallet_topup`.
 *      Idempotent on `paymentRef`.
 *   2. `refundOrphanedWalletTopups` — daily cron sweep that refunds any
 *      captured wallet-topup payment older than the orphan-age threshold whose
 *      paymentRef is missing from the wallet ledger, then writes a clearly
 *      labelled adjustment row.
 *
 * Razorpay is faked — we don't hit the real API. The fake records refund
 * calls so we can assert the cron actually issued them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Mock the notify helper BEFORE importing the unit under test so we can
// assert it's invoked exactly once per refunded payment (Task #919's
// per-user de-dup requirement) without exercising real push/email I/O.
vi.mock("../lib/walletTopupRefundNotify.js", () => ({
  notifyWalletTopupAutoRefunded: vi.fn(async () => ({
    status: "sent",
    inApp: { status: "sent" },
    push: { status: "sent" },
    email: { status: "sent" },
  })),
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubWalletsTable,
  clubWalletTxnsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  creditWalletTopupFromPayment,
  refundOrphanedWalletTopups,
} from "../routes/side-games-v2.js";
import { notifyWalletTopupAutoRefunded } from "../lib/walletTopupRefundNotify.js";

const notifyMock = vi.mocked(notifyWalletTopupAutoRefunded);

let orgId: number;
let userId: number;

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `T769-${ts}`,
    slug: `t769-${ts}`,
    contactEmail: `t769-${ts}@example.test`,
  }).returning();
  orgId = org.id;
  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t769_${ts}`,
    username: `t769_${ts}`,
    email: `u_${ts}@example.test`,
    displayName: "Top-up Member",
    role: "player",
    organizationId: orgId,
  }).returning();
  userId = user.id;
});

afterAll(async () => {
  const wallets = await db.select({ id: clubWalletsTable.id })
    .from(clubWalletsTable).where(eq(clubWalletsTable.organizationId, orgId));
  if (wallets.length) {
    await db.delete(clubWalletTxnsTable).where(inArray(clubWalletTxnsTable.walletId, wallets.map(w => w.id)));
  }
  await db.delete(clubWalletsTable).where(eq(clubWalletsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  // Reset wallet state for each test.
  const wallets = await db.select({ id: clubWalletsTable.id })
    .from(clubWalletsTable).where(eq(clubWalletsTable.organizationId, orgId));
  if (wallets.length) {
    await db.delete(clubWalletTxnsTable).where(inArray(clubWalletTxnsTable.walletId, wallets.map(w => w.id)));
    await db.delete(clubWalletsTable).where(inArray(clubWalletsTable.id, wallets.map(w => w.id)));
  }
  notifyMock.mockClear();
});

describe("creditWalletTopupFromPayment (webhook reconciliation)", () => {
  it("credits the wallet when the verify call never landed", async () => {
    const result = await creditWalletTopupFromPayment({
      paymentId: "pay_webhook_1",
      orderId: "order_webhook_1",
      amountMinor: 50000, // ₹500
      currency: "INR",
      notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) },
    });
    expect(result.credited).toBe(true);
    expect(result.balance).toBeCloseTo(500, 2);

    const [wallet] = await db.select().from(clubWalletsTable)
      .where(and(eq(clubWalletsTable.organizationId, orgId), eq(clubWalletsTable.userId, userId)));
    expect(Number(wallet.balance)).toBeCloseTo(500, 2);
  });

  it("is idempotent — second call for the same paymentId does not double-credit", async () => {
    const args = {
      paymentId: "pay_idempotent",
      orderId: "order_idempotent",
      amountMinor: 25000,
      currency: "INR",
      notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) },
    };
    const first = await creditWalletTopupFromPayment(args);
    const second = await creditWalletTopupFromPayment(args);
    expect(first.credited).toBe(true);
    expect(second.credited).toBe(false);
    expect(second.alreadyCredited).toBe(true);
    expect(second.balance).toBeCloseTo(250, 2);
  });

  it("ignores payments with non-wallet-topup notes", async () => {
    const result = await creditWalletTopupFromPayment({
      paymentId: "pay_other",
      orderId: "order_other",
      amountMinor: 10000,
      currency: "INR",
      notes: { kind: "tournament_entry", playerId: "1" },
    });
    expect(result.credited).toBe(false);
    expect(result.reason).toBe("not_wallet_topup");
  });

  it("rejects payments missing userId/orgId notes", async () => {
    const result = await creditWalletTopupFromPayment({
      paymentId: "pay_missing",
      orderId: "order_missing",
      amountMinor: 10000,
      currency: "INR",
      notes: { kind: "wallet_topup" },
    });
    expect(result.credited).toBe(false);
    expect(result.reason).toBe("missing_notes");
  });
});

describe("refundOrphanedWalletTopups (daily reconciliation cron)", () => {
  function makeFakeRazorpay(opts: {
    payments: Array<Record<string, unknown>>;
    refunded: Set<string>;
    failOn?: Set<string>;
  }) {
    return {
      payments: {
        all: async (_q: { from: number; to: number; count: number; skip: number }) => ({
          items: opts.payments,
        }),
        refund: async (paymentId: string, _opts: { amount: number; notes: Record<string, string> }) => {
          if (opts.failOn?.has(paymentId)) throw new Error("simulated refund failure");
          opts.refunded.add(paymentId);
          return { id: `rfnd_${paymentId}`, payment_id: paymentId };
        },
      },
    } as unknown as ReturnType<typeof import("../lib/razorpay").getRazorpayClient>;
  }

  it("refunds orphaned captured wallet top-ups and records a labelled adjustment row", async () => {
    const refunded = new Set<string>();
    const fakeRzp = makeFakeRazorpay({
      payments: [{
        id: "pay_orphan",
        status: "captured",
        amount: 75000, // ₹750
        amount_refunded: 0,
        currency: "INR",
        order_id: "order_orphan",
        notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) },
      }],
      refunded,
    });

    const result = await refundOrphanedWalletTopups({ razorpayClient: fakeRzp });
    expect(result.scanned).toBe(1);
    expect(result.refunded).toBe(1);
    expect(result.errors).toBe(0);
    expect(refunded.has("pay_orphan")).toBe(true);

    // Wallet was NOT credited — balance must stay at 0.
    const [wallet] = await db.select().from(clubWalletsTable)
      .where(and(eq(clubWalletsTable.organizationId, orgId), eq(clubWalletsTable.userId, userId)));
    expect(Number(wallet.balance)).toBeCloseTo(0, 2);

    // A labelled adjustment row exists in the ledger.
    const ledger = await db.select().from(clubWalletTxnsTable)
      .where(eq(clubWalletTxnsTable.walletId, wallet.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].sourceType).toBe("wallet_topup_refund");
    expect(ledger[0].paymentRef).toBe("pay_orphan");
    expect(Number(ledger[0].amount)).toBe(0);
    // Task #1072 — refunded amount is persisted in the structured
    // audit_amount column so the admin dashboard can read it directly.
    expect(ledger[0].auditAmount).not.toBeNull();
    expect(Number(ledger[0].auditAmount)).toBeCloseTo(750, 2);
    expect(ledger[0].note).toMatch(/Auto-refund/i);
    expect(ledger[0].note).toMatch(/750/);
  });

  it("skips payments that are already credited to the wallet", async () => {
    // Pre-credit the wallet for this paymentId.
    await creditWalletTopupFromPayment({
      paymentId: "pay_already_credited",
      orderId: "order_already_credited",
      amountMinor: 30000,
      currency: "INR",
      notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) },
    });
    const refunded = new Set<string>();
    const fakeRzp = makeFakeRazorpay({
      payments: [{
        id: "pay_already_credited",
        status: "captured",
        amount: 30000,
        amount_refunded: 0,
        currency: "INR",
        order_id: "order_already_credited",
        notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) },
      }],
      refunded,
    });

    const result = await refundOrphanedWalletTopups({ razorpayClient: fakeRzp });
    // Counted as scanned (payment is captured + wallet_topup), but skipped
    // before the refund attempt because the wallet ledger already shows it.
    expect(result.scanned).toBe(1);
    expect(result.refunded).toBe(0);
    expect(refunded.size).toBe(0);
  });

  it("skips non-captured and non-wallet-topup payments", async () => {
    const refunded = new Set<string>();
    const fakeRzp = makeFakeRazorpay({
      payments: [
        { id: "pay_failed", status: "failed", amount: 10000, amount_refunded: 0, currency: "INR",
          notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) } },
        { id: "pay_other", status: "captured", amount: 10000, amount_refunded: 0, currency: "INR",
          notes: { kind: "tournament_entry", playerId: "1" } },
      ],
      refunded,
    });
    const result = await refundOrphanedWalletTopups({ razorpayClient: fakeRzp });
    expect(result.scanned).toBe(0);
    expect(result.refunded).toBe(0);
    expect(refunded.size).toBe(0);
  });

  it("records adjustment row without re-refunding when Razorpay already refunded the payment", async () => {
    const refunded = new Set<string>();
    const fakeRzp = makeFakeRazorpay({
      payments: [{
        id: "pay_already_refunded",
        status: "captured",
        amount: 40000,
        amount_refunded: 40000, // already fully refunded at Razorpay
        currency: "INR",
        order_id: "order_already_refunded",
        notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) },
      }],
      refunded,
    });
    const result = await refundOrphanedWalletTopups({ razorpayClient: fakeRzp });
    expect(result.alreadyRefunded).toBe(1);
    expect(result.refunded).toBe(0);
    expect(refunded.size).toBe(0);

    const [wallet] = await db.select().from(clubWalletsTable)
      .where(and(eq(clubWalletsTable.organizationId, orgId), eq(clubWalletsTable.userId, userId)));
    const ledger = await db.select().from(clubWalletTxnsTable)
      .where(eq(clubWalletTxnsTable.walletId, wallet.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].sourceType).toBe("wallet_topup_refund");
    expect(ledger[0].note).toMatch(/already refunded/i);
  });

  it("counts errors when Razorpay refund call fails and does not insert an adjustment row", async () => {
    const refunded = new Set<string>();
    const fakeRzp = makeFakeRazorpay({
      payments: [{
        id: "pay_will_fail",
        status: "captured",
        amount: 10000,
        amount_refunded: 0,
        currency: "INR",
        order_id: "order_will_fail",
        notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) },
      }],
      refunded,
      failOn: new Set(["pay_will_fail"]),
    });
    const result = await refundOrphanedWalletTopups({ razorpayClient: fakeRzp });
    expect(result.errors).toBe(1);
    expect(result.refunded).toBe(0);

    const [wallet] = await db.select().from(clubWalletsTable)
      .where(and(eq(clubWalletsTable.organizationId, orgId), eq(clubWalletsTable.userId, userId)));
    const ledger = await db.select().from(clubWalletTxnsTable)
      .where(eq(clubWalletTxnsTable.walletId, wallet.id));
    expect(ledger).toHaveLength(0);
  });
});

describe("refundOrphanedWalletTopups → notifyWalletTopupAutoRefunded (Task #919)", () => {
  function makeFakeRazorpay(opts: {
    payments: Array<Record<string, unknown>>;
    refunded: Set<string>;
    failOn?: Set<string>;
  }) {
    return {
      payments: {
        all: async () => ({ items: opts.payments }),
        refund: async (paymentId: string) => {
          if (opts.failOn?.has(paymentId)) throw new Error("simulated refund failure");
          opts.refunded.add(paymentId);
          return { id: `rfnd_${paymentId}`, payment_id: paymentId };
        },
      },
    } as unknown as ReturnType<typeof import("../lib/razorpay").getRazorpayClient>;
  }

  it("notifies the member exactly once after issuing a refund, with the refund id", async () => {
    const refunded = new Set<string>();
    const fakeRzp = makeFakeRazorpay({
      payments: [{
        id: "pay_notify_1",
        status: "captured",
        amount: 75000,
        amount_refunded: 0,
        currency: "INR",
        order_id: "order_notify_1",
        notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) },
      }],
      refunded,
    });

    await refundOrphanedWalletTopups({ razorpayClient: fakeRzp });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      organizationId: orgId,
      userId,
      paymentId: "pay_notify_1",
      refundId: "rfnd_pay_notify_1",
      amount: 750,
      currency: "INR",
    });
  });

  it("notifies the member with refundId=null on the already-refunded-at-Razorpay branch", async () => {
    const refunded = new Set<string>();
    const fakeRzp = makeFakeRazorpay({
      payments: [{
        id: "pay_already_rzp",
        status: "captured",
        amount: 40000,
        amount_refunded: 40000,
        currency: "INR",
        order_id: "order_already_rzp",
        notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) },
      }],
      refunded,
    });

    await refundOrphanedWalletTopups({ razorpayClient: fakeRzp });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      organizationId: orgId,
      userId,
      paymentId: "pay_already_rzp",
      refundId: null,
      amount: 400,
      currency: "INR",
    });
  });

  it("per-user de-dup: a second cron pass over the same orphan does not re-notify", async () => {
    const refunded = new Set<string>();
    const payment = {
      id: "pay_dedup",
      status: "captured",
      amount: 10000,
      amount_refunded: 0,
      currency: "INR",
      order_id: "order_dedup",
      notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) },
    };
    const fakeRzp = makeFakeRazorpay({ payments: [payment], refunded });

    await refundOrphanedWalletTopups({ razorpayClient: fakeRzp });
    expect(notifyMock).toHaveBeenCalledTimes(1);

    // Second pass: simulate Razorpay now reporting it as refunded.
    payment.amount_refunded = 10000;
    await refundOrphanedWalletTopups({ razorpayClient: fakeRzp });

    // Audit row already exists from the first pass → notify is NOT
    // called again. This is the per-user de-dup the task requires.
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("does not notify for payments already credited to the wallet", async () => {
    await creditWalletTopupFromPayment({
      paymentId: "pay_credited_no_notify",
      orderId: "order_credited_no_notify",
      amountMinor: 30000,
      currency: "INR",
      notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) },
    });
    notifyMock.mockClear();

    const fakeRzp = makeFakeRazorpay({
      payments: [{
        id: "pay_credited_no_notify",
        status: "captured",
        amount: 30000,
        amount_refunded: 0,
        currency: "INR",
        order_id: "order_credited_no_notify",
        notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) },
      }],
      refunded: new Set<string>(),
    });

    await refundOrphanedWalletTopups({ razorpayClient: fakeRzp });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("does not notify when the Razorpay refund call fails", async () => {
    const refunded = new Set<string>();
    const fakeRzp = makeFakeRazorpay({
      payments: [{
        id: "pay_no_notify_on_failure",
        status: "captured",
        amount: 10000,
        amount_refunded: 0,
        currency: "INR",
        order_id: "order_no_notify_on_failure",
        notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userId) },
      }],
      refunded,
      failOn: new Set(["pay_no_notify_on_failure"]),
    });

    await refundOrphanedWalletTopups({ razorpayClient: fakeRzp });
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
