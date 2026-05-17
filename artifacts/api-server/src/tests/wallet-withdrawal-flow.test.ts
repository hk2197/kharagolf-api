/**
 * Task #770 — wallet withdrawal flow tests.
 *
 * Exercises the helpers in lib/walletPayouts.ts (limit checks, atomic
 * debit, refund-on-failure, idempotent webhook reconciliation). We avoid
 * hitting RazorpayX directly — `dispatchWalletWithdrawal` is the only
 * function that talks to Razorpay and is covered indirectly by checking
 * that markWithdrawalProcessed / markWithdrawalFailed correctly reconcile
 * the local row + wallet balance the way the webhook handler will.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubWalletsTable,
  clubWalletTxnsTable,
  walletPayoutAccountsTable,
  clubWalletWithdrawalsTable,
} from "@workspace/db";
import { eq, inArray, and } from "drizzle-orm";
import {
  checkWithdrawalLimits,
  debitWalletForWithdrawal,
  refundWithdrawal,
  markWithdrawalProcessed,
  markWithdrawalFailed,
  markWithdrawalProcessing,
  findWithdrawalByPayoutId,
  findWithdrawalByReference,
  MIN_WITHDRAWAL_INR,
  MAX_WITHDRAWAL_PER_TXN_INR,
} from "../lib/walletPayouts.js";

let orgId: number;
let userId: number;
let walletId: number;
let payoutAccountId: number;

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `T770-${ts}`, slug: `t770-${ts}`, contactEmail: `t770-${ts}@example.test`,
  }).returning();
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t770_${ts}`,
    username: `t770_user_${ts}`,
    email: `t770_${ts}@example.test`,
    displayName: "Withdrawer",
    role: "player",
    organizationId: orgId,
  }).returning();
  userId = user.id;

  const [w] = await db.insert(clubWalletsTable).values({
    organizationId: orgId, userId, currency: "INR", balance: "5000.00",
  }).returning();
  walletId = w.id;
  await db.insert(clubWalletTxnsTable).values({
    walletId: w.id, kind: "credit", amount: "5000.00", currency: "INR",
    sourceType: "test_seed", balanceAfter: "5000.00",
  });

  const [acct] = await db.insert(walletPayoutAccountsTable).values({
    organizationId: orgId, userId, method: "upi",
    accountHolderName: "Withdrawer", upiVpa: "test@upi",
    razorpayContactId: "cont_test", razorpayFundAccountId: "fa_test",
  }).returning();
  payoutAccountId = acct.id;
});

afterAll(async () => {
  await db.delete(clubWalletWithdrawalsTable).where(eq(clubWalletWithdrawalsTable.organizationId, orgId));
  await db.delete(walletPayoutAccountsTable).where(eq(walletPayoutAccountsTable.organizationId, orgId));
  await db.delete(clubWalletTxnsTable).where(inArray(clubWalletTxnsTable.walletId, [walletId]));
  await db.delete(clubWalletsTable).where(eq(clubWalletsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("Task #770 — wallet withdrawal helpers", () => {
  it("rejects below-minimum and above-per-txn-limit amounts", async () => {
    const lo = await checkWithdrawalLimits({ userId, organizationId: orgId, currency: "INR", amount: MIN_WITHDRAWAL_INR - 1 });
    expect(lo.ok).toBe(false);
    const hi = await checkWithdrawalLimits({ userId, organizationId: orgId, currency: "INR", amount: MAX_WITHDRAWAL_PER_TXN_INR + 1 });
    expect(hi.ok).toBe(false);
    const ok = await checkWithdrawalLimits({ userId, organizationId: orgId, currency: "INR", amount: 500 });
    expect(ok.ok).toBe(true);
  });

  it("debits the wallet atomically and writes a withdrawal row + ledger entry", async () => {
    const before = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    expect(Number(before[0].balance)).toBeCloseTo(5000, 2);

    const r = await debitWalletForWithdrawal({
      walletId, organizationId: orgId, userId, amount: 200, currency: "INR",
      method: "upi", payoutAccountId, razorpayFundAccountId: "fa_test",
    });
    expect(r.withdrawalId).toBeGreaterThan(0);

    const [w] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    expect(Number(w.balance)).toBeCloseTo(4800, 2);

    const [wd] = await db.select().from(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, r.withdrawalId));
    expect(wd.status).toBe("pending");
    expect(Number(wd.amount)).toBeCloseTo(200, 2);
    expect(wd.debitTxnId).not.toBeNull();
  });

  it("processes the webhook idempotently (markProcessed twice)", async () => {
    const r = await debitWalletForWithdrawal({
      walletId, organizationId: orgId, userId, amount: 300, currency: "INR",
      method: "upi", payoutAccountId, razorpayFundAccountId: "fa_test",
    });
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_x1", utr: "UTR123",
    });
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_x1", utr: "UTR-DIFFERENT",
    });
    const [wd] = await db.select().from(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, r.withdrawalId));
    expect(wd.status).toBe("processed");
    // Wallet balance must NOT change again on a duplicate processed event.
    const [w] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    // Started at 4800 after the previous test's 200 debit; minus 300 = 4500.
    expect(Number(w.balance)).toBeCloseTo(4500, 2);
  });

  it("refunds the wallet exactly once when the payout fails", async () => {
    const r = await debitWalletForWithdrawal({
      walletId, organizationId: orgId, userId, amount: 150, currency: "INR",
      method: "upi", payoutAccountId, razorpayFundAccountId: "fa_test",
    });
    const [walletAfterDebit] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    expect(Number(walletAfterDebit.balance)).toBeCloseTo(4350, 2);

    await markWithdrawalFailed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_failed",
      status: "failed", reason: "test failure",
    });
    // Calling refund again must NOT double-credit (idempotency).
    await refundWithdrawal(r.withdrawalId, "duplicate");

    const [wallet] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    expect(Number(wallet.balance)).toBeCloseTo(4500, 2);

    const [wd] = await db.select().from(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, r.withdrawalId));
    expect(wd.status).toBe("failed");
    expect(wd.refundTxnId).not.toBeNull();
    expect(wd.failureReason).toBe("test failure");
  });

  it("does NOT double-credit when a `processed` webhook arrives after refund (ambiguous dispatch -> failed -> processed)", async () => {
    // Simulates the bug surfaced in code review:
    //   1. dispatch errors out (e.g. timeout) — wallet is debited; status becomes dispatch_unknown.
    //      Critically, no auto-refund is performed.
    //   2. webhook later confirms `processed` — money DID leave the bank.
    //   3. wallet must remain debited (no refund txn ever created).
    const r = await debitWalletForWithdrawal({
      walletId, organizationId: orgId, userId, amount: 250, currency: "INR",
      method: "upi", payoutAccountId, razorpayFundAccountId: "fa_test",
    });
    const [walletAfterDebit] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    const balanceAfterDebit = Number(walletAfterDebit.balance);

    // Simulate dispatch error: row is parked in dispatch_unknown, NO refund.
    await db.update(clubWalletWithdrawalsTable).set({
      status: "dispatch_unknown", failureReason: "timeout", attemptedAt: new Date(),
    }).where(eq(clubWalletWithdrawalsTable.id, r.withdrawalId));

    // Webhook later says the payout actually went through.
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_du_ok", utr: "UTR-DU-OK",
    });

    const [wd] = await db.select().from(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, r.withdrawalId));
    expect(wd.status).toBe("processed");
    expect(wd.refundTxnId).toBeNull();

    const [wallet] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    expect(Number(wallet.balance)).toBeCloseTo(balanceAfterDebit, 2); // unchanged
  });

  it("guards against payout_processed arriving AFTER a refund (flags paid_after_refund, no double-credit)", async () => {
    // Variant: webhook says failed first (wallet refunded), then a late
    // `processed` event arrives. Wallet must NOT be credited again — row
    // is moved to `paid_after_refund` for ops to reconcile.
    const r = await debitWalletForWithdrawal({
      walletId, organizationId: orgId, userId, amount: 175, currency: "INR",
      method: "upi", payoutAccountId, razorpayFundAccountId: "fa_test",
    });
    const [walletAfterDebit] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    const balanceAfterDebit = Number(walletAfterDebit.balance);

    // First webhook: failed -> wallet refunded.
    await markWithdrawalFailed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_late", status: "failed", reason: "race",
    });
    const [walletAfterRefund] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    expect(Number(walletAfterRefund.balance)).toBeCloseTo(balanceAfterDebit + 175, 2);

    // Second webhook (race): processed arrives late.
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_late", utr: "UTR-LATE",
    });

    const [wd] = await db.select().from(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, r.withdrawalId));
    expect(wd.status).toBe("paid_after_refund");
    expect(wd.refundTxnId).not.toBeNull();
    expect(wd.utr).toBe("UTR-LATE");
    expect(wd.failureReason).toMatch(/PAID AFTER REFUND/i);

    // Wallet must NOT have been credited a second time.
    const [walletFinal] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    expect(Number(walletFinal.balance)).toBeCloseTo(balanceAfterDebit + 175, 2);
  });

  it("guards against failed/reversed webhook arriving AFTER processed (no refund applied)", async () => {
    // The reverse race: processed first (money left bank), then a failed
    // webhook arrives. We must NOT refund the wallet — that would be a
    // double payment.
    const r = await debitWalletForWithdrawal({
      walletId, organizationId: orgId, userId, amount: 125, currency: "INR",
      method: "upi", payoutAccountId, razorpayFundAccountId: "fa_test",
    });
    const [walletAfterDebit] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    const balanceAfterDebit = Number(walletAfterDebit.balance);

    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_first_ok", utr: "UTR-OK",
    });
    // Late spurious failed event.
    await markWithdrawalFailed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_first_ok", status: "failed", reason: "spurious",
    });

    const [wd] = await db.select().from(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, r.withdrawalId));
    expect(wd.status).toBe("processed"); // unchanged
    expect(wd.refundTxnId).toBeNull();

    const [walletFinal] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    expect(Number(walletFinal.balance)).toBeCloseTo(balanceAfterDebit, 2); // unchanged
  });

  it("refundWithdrawal is concurrency-safe: parallel refund calls produce exactly one credit ledger row", async () => {
    // Simulate two duplicate webhook deliveries / a webhook + a manual
    // ops refund firing simultaneously. With proper row-level locking
    // inside the transaction, exactly one refund must be applied.
    const r = await debitWalletForWithdrawal({
      walletId, organizationId: orgId, userId, amount: 333, currency: "INR",
      method: "upi", payoutAccountId, razorpayFundAccountId: "fa_test",
    });
    const [walletAfterDebit] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    const balanceBefore = Number(walletAfterDebit.balance);

    // Mark as failed but bypass markWithdrawalFailed so the helper's
    // own refundWithdrawal call doesn't pre-empt the race we want to test.
    await db.update(clubWalletWithdrawalsTable).set({
      status: "failed", failureReason: "race-test", failedAt: new Date(),
    }).where(eq(clubWalletWithdrawalsTable.id, r.withdrawalId));

    // Fire many concurrent refund attempts.
    await Promise.all(
      Array.from({ length: 8 }).map(() => refundWithdrawal(r.withdrawalId, "concurrent")),
    );

    // Exactly one refund credit must exist for this withdrawal.
    const credits = await db.select().from(clubWalletTxnsTable).where(and(
      eq(clubWalletTxnsTable.walletId, walletId),
      eq(clubWalletTxnsTable.sourceType, "wallet_withdrawal_refund"),
      eq(clubWalletTxnsTable.sourceId, String(r.withdrawalId)),
    ));
    expect(credits.length).toBe(1);

    // Wallet balance must have moved up by exactly the withdrawal amount.
    const [walletFinal] = await db.select().from(clubWalletsTable).where(eq(clubWalletsTable.id, walletId));
    expect(Number(walletFinal.balance)).toBeCloseTo(balanceBefore + 333, 2);

    const [wd] = await db.select().from(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, r.withdrawalId));
    expect(wd.refundTxnId).not.toBeNull();
  });

  it("markWithdrawalProcessing is a no-op once the row is in a terminal state (no status regression)", async () => {
    // Race ordering: failed -> late payout.updated -> would-be processing.
    // Without the guard, the row would regress from `failed` back to
    // `processing`, which both misleads the member and makes the row
    // count toward daily limits (which only excludes failed/reversed/cancelled).
    const r = await debitWalletForWithdrawal({
      walletId, organizationId: orgId, userId, amount: 90, currency: "INR",
      method: "upi", payoutAccountId, razorpayFundAccountId: "fa_test",
    });
    await markWithdrawalFailed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_term_failed",
      status: "failed", reason: "test",
    });
    // Late `payout.updated` arrives — must NOT regress status.
    await markWithdrawalProcessing({ withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_term_failed" });
    const [wd] = await db.select().from(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, r.withdrawalId));
    expect(wd.status).toBe("failed");
    expect(wd.refundTxnId).not.toBeNull();
  });

  it("markWithdrawalProcessing leaves processed/paid_after_refund rows untouched", async () => {
    // Processed: late payout.updated must not regress.
    const r1 = await debitWalletForWithdrawal({
      walletId, organizationId: orgId, userId, amount: 80, currency: "INR",
      method: "upi", payoutAccountId, razorpayFundAccountId: "fa_test",
    });
    await markWithdrawalProcessed({ withdrawalId: r1.withdrawalId, razorpayPayoutId: "pout_proc_ok", utr: "UTR-PROC" });
    await markWithdrawalProcessing({ withdrawalId: r1.withdrawalId, razorpayPayoutId: "pout_proc_ok" });
    const [wd1] = await db.select().from(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, r1.withdrawalId));
    expect(wd1.status).toBe("processed");

    // paid_after_refund: an even later payout.updated must not regress.
    const r2 = await debitWalletForWithdrawal({
      walletId, organizationId: orgId, userId, amount: 70, currency: "INR",
      method: "upi", payoutAccountId, razorpayFundAccountId: "fa_test",
    });
    await markWithdrawalFailed({
      withdrawalId: r2.withdrawalId, razorpayPayoutId: "pout_par", status: "failed", reason: "race",
    });
    await markWithdrawalProcessed({ withdrawalId: r2.withdrawalId, razorpayPayoutId: "pout_par", utr: "UTR-PAR" });
    await markWithdrawalProcessing({ withdrawalId: r2.withdrawalId, razorpayPayoutId: "pout_par" });
    const [wd2] = await db.select().from(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, r2.withdrawalId));
    expect(wd2.status).toBe("paid_after_refund");
  });

  it("findWithdrawalByPayoutId / Reference work", async () => {
    const byPayout = await findWithdrawalByPayoutId("pout_x1");
    expect(byPayout?.razorpayPayoutId).toBe("pout_x1");

    // Reference id format is `walletwd_<id>` (set by dispatchWalletWithdrawal),
    // but in this test we never dispatched live, so look up by a known id.
    const allWds = await db.select().from(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.organizationId, orgId));
    expect(allWds.length).toBeGreaterThan(0);
    const someId = allWds[0].id;
    // markWithdrawalProcessing/Processed/Failed all stamp reference_id-equivalents
    // through razorpayPayoutId; a missing ref shouldn't crash:
    const noRef = await findWithdrawalByReference("walletwd_999999999");
    expect(noRef).toBeUndefined();
    void someId;
  });
});
