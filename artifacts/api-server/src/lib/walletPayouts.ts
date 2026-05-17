/**
 * Wallet payouts (Task #770) — disburse a member's club-wallet balance
 * back to a saved UPI / bank account via RazorpayX.
 *
 * The wallet is debited synchronously when the user requests a withdrawal
 * (so the UI can refuse on insufficient balance). The RazorpayX payout
 * is then dispatched and reconciled by the `/api/webhooks/razorpay-payout`
 * webhook, which marks the withdrawal `processed` (storing the UTR) or
 * `failed` (refunding the wallet).
 */

import { db } from "@workspace/db";
import {
  clubWalletWithdrawalsTable,
  clubWalletTxnsTable,
  clubWalletsTable,
  walletPayoutAccountsTable,
} from "@workspace/db";
import { eq, and, sql, gte } from "drizzle-orm";
import { createRazorpayPayout, type RazorpayPayoutMode } from "./razorpay";
import { logger as baseLogger } from "./logger";

const logger = baseLogger.child({ module: "wallet-payouts" });

// ── KYC / limits ────────────────────────────────────────────────────────
// Conservative defaults that match RazorpayX free-tier minimums and the
// typical KYC threshold under which a contact does not need PAN. Override
// via env vars so ops can tune without a deploy.
export const MIN_WITHDRAWAL_INR = Number(process.env.WALLET_WITHDRAWAL_MIN_INR ?? "100");
export const MAX_WITHDRAWAL_PER_TXN_INR = Number(process.env.WALLET_WITHDRAWAL_MAX_TXN_INR ?? "100000");
export const MAX_WITHDRAWAL_DAILY_INR = Number(process.env.WALLET_WITHDRAWAL_MAX_DAILY_INR ?? "100000");

export interface LimitCheck {
  ok: boolean;
  reason?: string;
}

/** Sum of withdrawals (excluding failed/cancelled) requested in the last 24h. */
async function sumLast24hWithdrawals(userId: number, organizationId: number, currency: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db.select({
    total: sql<string>`coalesce(sum(${clubWalletWithdrawalsTable.amount}), 0)`,
  }).from(clubWalletWithdrawalsTable).where(and(
    eq(clubWalletWithdrawalsTable.userId, userId),
    eq(clubWalletWithdrawalsTable.organizationId, organizationId),
    eq(clubWalletWithdrawalsTable.currency, currency),
    gte(clubWalletWithdrawalsTable.requestedAt, since),
    // Failed/reversed/cancelled withdrawals are refunded so they do not
    // count against the user's daily spend. dispatch_unknown / pending /
    // processing / processed / paid_after_refund all do count.
    sql`${clubWalletWithdrawalsTable.status} not in ('failed','reversed','cancelled')`,
  ));
  return Number(rows[0]?.total ?? 0);
}

export async function checkWithdrawalLimits(args: {
  userId: number;
  organizationId: number;
  currency: string;
  amount: number;
}): Promise<LimitCheck> {
  if (!Number.isFinite(args.amount) || args.amount <= 0) {
    return { ok: false, reason: "Enter a valid amount" };
  }
  if (args.amount < MIN_WITHDRAWAL_INR) {
    return { ok: false, reason: `Minimum withdrawal is ${args.currency} ${MIN_WITHDRAWAL_INR}` };
  }
  if (args.amount > MAX_WITHDRAWAL_PER_TXN_INR) {
    return { ok: false, reason: `Maximum per withdrawal is ${args.currency} ${MAX_WITHDRAWAL_PER_TXN_INR}` };
  }
  const last24h = await sumLast24hWithdrawals(args.userId, args.organizationId, args.currency);
  if (last24h + args.amount > MAX_WITHDRAWAL_DAILY_INR) {
    const remaining = Math.max(0, MAX_WITHDRAWAL_DAILY_INR - last24h);
    return {
      ok: false,
      reason: `Daily withdrawal limit reached. ${args.currency} ${remaining.toFixed(2)} remaining today.`,
    };
  }
  return { ok: true };
}

// ── Wallet ledger helpers ───────────────────────────────────────────────

/**
 * Atomically debit the wallet, record a `wallet_withdrawal_pending`
 * ledger entry, and create the withdrawal row in `pending` status.
 *
 * Throws "INSUFFICIENT_FUNDS" if the wallet does not have the balance.
 * Returns the new withdrawal id and the linked debit txn id.
 */
export async function debitWalletForWithdrawal(args: {
  walletId: number;
  organizationId: number;
  userId: number;
  amount: number;
  currency: string;
  method: "upi" | "bank_account";
  payoutAccountId: number;
  razorpayFundAccountId: string;
}): Promise<{ withdrawalId: number; debitTxnId: number; balanceAfter: number }> {
  return db.transaction(async (tx) => {
    const [wallet] = await tx.select().from(clubWalletsTable)
      .where(eq(clubWalletsTable.id, args.walletId))
      .for("update");
    if (!wallet) throw new Error(`wallet ${args.walletId} not found`);
    const current = Number(wallet.balance);
    const next = Math.round((current - args.amount) * 100) / 100;
    if (next < 0) throw new Error("INSUFFICIENT_FUNDS");

    const [withdrawal] = await tx.insert(clubWalletWithdrawalsTable).values({
      walletId: args.walletId,
      organizationId: args.organizationId,
      userId: args.userId,
      amount: String(args.amount),
      currency: args.currency,
      method: args.method,
      payoutAccountId: args.payoutAccountId,
      razorpayFundAccountId: args.razorpayFundAccountId,
      status: "pending",
    }).returning();

    await tx.update(clubWalletsTable).set({
      balance: String(next),
      updatedAt: new Date(),
    }).where(eq(clubWalletsTable.id, args.walletId));

    const [debitTxn] = await tx.insert(clubWalletTxnsTable).values({
      walletId: args.walletId,
      kind: "debit",
      amount: String(args.amount),
      currency: args.currency,
      sourceType: "wallet_withdrawal_pending",
      sourceId: String(withdrawal.id),
      note: "Withdrawal to bank/UPI",
      balanceAfter: String(next),
    }).returning();

    await tx.update(clubWalletWithdrawalsTable).set({
      debitTxnId: debitTxn.id,
      updatedAt: new Date(),
    }).where(eq(clubWalletWithdrawalsTable.id, withdrawal.id));

    return { withdrawalId: withdrawal.id, debitTxnId: debitTxn.id, balanceAfter: next };
  });
}

/**
 * Refund a failed/reversed withdrawal — credit wallet + ledger entry.
 *
 * SAFETY GUARDS (Task #770 financial-correctness review):
 *   - Atomically locks the withdrawal row (`SELECT ... FOR UPDATE`)
 *     INSIDE the transaction so concurrent callers (duplicate webhook
 *     deliveries, retries, manual ops) cannot both observe
 *     `refundTxnId IS NULL` and double-credit the wallet.
 *   - Refuses if a refund already exists (refundTxnId set) — re-checked
 *     under the row lock.
 *   - Refuses if the withdrawal is `processed` — the money already left
 *     the bank, so refunding would double-pay the member.
 */
export async function refundWithdrawal(withdrawalId: number, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock the withdrawal row first so concurrent refund attempts
    // serialize on it. The wallet row is locked second (always in this
    // order) to avoid lock-order deadlocks across concurrent calls.
    const [w] = await tx.select().from(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, withdrawalId)).for("update");
    if (!w) return;
    if (w.refundTxnId) return; // already refunded — checked under lock
    if (w.status === "processed") {
      logger.error(
        { withdrawalId },
        "Refund refused: withdrawal already processed by RazorpayX. Manual reconciliation required.",
      );
      return;
    }

    const [wallet] = await tx.select().from(clubWalletsTable)
      .where(eq(clubWalletsTable.id, w.walletId)).for("update");
    if (!wallet) throw new Error(`wallet ${w.walletId} not found`);
    const current = Number(wallet.balance);
    const amount = Number(w.amount);
    const next = Math.round((current + amount) * 100) / 100;
    await tx.update(clubWalletsTable).set({
      balance: String(next), updatedAt: new Date(),
    }).where(eq(clubWalletsTable.id, w.walletId));
    const [refundTxn] = await tx.insert(clubWalletTxnsTable).values({
      walletId: w.walletId,
      kind: "credit",
      amount: String(amount),
      currency: w.currency,
      sourceType: "wallet_withdrawal_refund",
      sourceId: String(w.id),
      note: `Withdrawal refunded: ${reason}`,
      balanceAfter: String(next),
    }).returning();
    await tx.update(clubWalletWithdrawalsTable).set({
      refundTxnId: refundTxn.id,
      updatedAt: new Date(),
    }).where(eq(clubWalletWithdrawalsTable.id, w.id));
  });
}

// ── RazorpayX dispatch ──────────────────────────────────────────────────

export interface DispatchResult {
  status: "processing" | "dispatch_unknown";
  razorpayPayoutId?: string;
  error?: string;
}

/**
 * Submit a previously-debited withdrawal to RazorpayX.
 *
 *   - Success → row moves to `processing` until the webhook flips it to
 *     `processed`.
 *   - Razorpay returns a definitive client error (4xx, e.g. invalid fund
 *     account) → the call still throws an exception in our SDK wrapper,
 *     but the payout was *not* created. We mark the row `dispatch_unknown`
 *     and DO NOT auto-refund, because we cannot distinguish a definitive
 *     rejection from an ambiguous network error from inside the catch:
 *     refunding eagerly would double-pay the member if the payout had in
 *     fact been created (later confirmed by the webhook with our
 *     `walletwd_<id>` reference id).
 *
 * `dispatch_unknown` rows require operator review:
 *   - If a webhook arrives saying `processed`, the wallet stays debited
 *     (correct: money left the bank).
 *   - If a webhook arrives saying `failed`/`reversed`, markWithdrawalFailed
 *     refunds the wallet (correct: money never left the bank).
 *   - If no webhook ever arrives, ops can manually call `refundWithdrawal`
 *     after confirming with Razorpay that the payout was never created.
 */
export async function dispatchWalletWithdrawal(args: {
  withdrawalId: number;
  fundAccountId: string;
  amountPaise: number;
  method: "upi" | "bank_account";
  userId: number;
  organizationId: number;
}): Promise<DispatchResult> {
  const mode: RazorpayPayoutMode = args.method === "upi" ? "UPI" : "IMPS";
  try {
    const referenceId = `walletwd_${args.withdrawalId}`;
    const rzp = await createRazorpayPayout({
      fund_account_id: args.fundAccountId,
      amount: args.amountPaise,
      mode,
      purpose: "refund",
      reference_id: referenceId,
      narration: `Wallet withdrawal #${args.withdrawalId}`,
      notes: {
        walletWithdrawalId: String(args.withdrawalId),
        userId: String(args.userId),
        organizationId: String(args.organizationId),
      },
      queue_if_low_balance: true,
    });
    await db.update(clubWalletWithdrawalsTable).set({
      status: "processing",
      razorpayPayoutId: rzp.id,
      payoutMode: mode,
      attemptedAt: new Date(),
      failureReason: null,
      updatedAt: new Date(),
    }).where(eq(clubWalletWithdrawalsTable.id, args.withdrawalId));
    logger.info(
      { withdrawalId: args.withdrawalId, razorpayPayoutId: rzp.id, mode, amount: args.amountPaise },
      "Wallet withdrawal submitted to RazorpayX",
    );
    return { status: "processing", razorpayPayoutId: rzp.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "RazorpayX payout failed";
    logger.error(
      { err, withdrawalId: args.withdrawalId },
      "Wallet withdrawal dispatch errored — marking dispatch_unknown for reconciliation",
    );
    // We CANNOT safely auto-refund here: the exception may be an ambiguous
    // network/timeout error where Razorpay actually created the payout. If
    // we refund and the webhook later confirms `processed`, the member is
    // double-credited. Park the row in `dispatch_unknown` and let the
    // webhook (or an operator) decide the final state.
    await db.update(clubWalletWithdrawalsTable).set({
      status: "dispatch_unknown",
      failureReason: reason,
      attemptedAt: new Date(),
      payoutMode: mode,
      updatedAt: new Date(),
    }).where(eq(clubWalletWithdrawalsTable.id, args.withdrawalId));
    return { status: "dispatch_unknown", error: reason };
  }
}

// ── Webhook handlers (called from /api/webhooks/razorpay-payout) ───────

export async function findWithdrawalByPayoutId(razorpayPayoutId: string) {
  const [row] = await db.select().from(clubWalletWithdrawalsTable)
    .where(eq(clubWalletWithdrawalsTable.razorpayPayoutId, razorpayPayoutId));
  return row;
}

export async function findWithdrawalByReference(referenceId: string) {
  if (!referenceId.startsWith("walletwd_")) return undefined;
  const id = parseInt(referenceId.slice("walletwd_".length));
  if (!Number.isFinite(id)) return undefined;
  const [row] = await db.select().from(clubWalletWithdrawalsTable)
    .where(eq(clubWalletWithdrawalsTable.id, id));
  return row;
}

/**
 * Result of a markWithdrawal* state transition. `transitioned` is true
 * iff the call moved the row to the requested terminal state for the
 * first time — callers (the webhook handler) gate member-facing
 * notifications on this so a replayed webhook never double-notifies
 * (Task #964).
 */
export interface MarkTransitionResult {
  transitioned: boolean;
}

export async function markWithdrawalProcessed(args: {
  withdrawalId: number;
  razorpayPayoutId?: string;
  utr?: string | null;
}): Promise<MarkTransitionResult> {
  // State-machine guard: if the wallet was already refunded (because an
  // earlier `failed`/`reversed` event came through), Razorpay still
  // sending us a `processed` event means the bank actually paid the
  // member after we'd already given the money back to their wallet. We
  // refuse to silently overwrite the row — flag it for ops instead.
  const [existing] = await db.select().from(clubWalletWithdrawalsTable)
    .where(eq(clubWalletWithdrawalsTable.id, args.withdrawalId));
  if (!existing) return { transitioned: false };
  if (existing.status === "processed") return { transitioned: false }; // idempotent
  if (existing.refundTxnId || existing.status === "failed" || existing.status === "reversed") {
    logger.error(
      {
        withdrawalId: args.withdrawalId,
        currentStatus: existing.status,
        refundTxnId: existing.refundTxnId,
        razorpayPayoutId: args.razorpayPayoutId,
        utr: args.utr,
      },
      "DOUBLE-CREDIT GUARD: Razorpay reports `processed` but withdrawal was already refunded. Manual reconciliation required.",
    );
    await db.update(clubWalletWithdrawalsTable).set({
      status: "paid_after_refund",
      razorpayPayoutId: args.razorpayPayoutId ?? sql`${clubWalletWithdrawalsTable.razorpayPayoutId}`,
      utr: args.utr ?? existing.utr,
      processedAt: new Date(),
      failureReason: "PAID AFTER REFUND — manual reconciliation required",
      updatedAt: new Date(),
    }).where(eq(clubWalletWithdrawalsTable.id, args.withdrawalId));
    // Already notified the member of the failure/refund — do NOT
    // re-notify them of a "success" that contradicts the earlier alert.
    return { transitioned: false };
  }
  await db.update(clubWalletWithdrawalsTable).set({
    status: "processed",
    razorpayPayoutId: args.razorpayPayoutId ?? sql`${clubWalletWithdrawalsTable.razorpayPayoutId}`,
    utr: args.utr ?? null,
    processedAt: new Date(),
    failureReason: null,
    updatedAt: new Date(),
  }).where(eq(clubWalletWithdrawalsTable.id, args.withdrawalId));
  return { transitioned: true };
}

export async function markWithdrawalFailed(args: {
  withdrawalId: number;
  razorpayPayoutId?: string;
  status: "failed" | "reversed";
  reason: string;
}): Promise<MarkTransitionResult> {
  // State-machine guard: if the row is already `processed`, the money
  // left the bank — we must not refund. (A reversed/failed webhook
  // arriving after `processed` should be handled out-of-band.)
  const [existing] = await db.select().from(clubWalletWithdrawalsTable)
    .where(eq(clubWalletWithdrawalsTable.id, args.withdrawalId));
  if (!existing) return { transitioned: false };
  if (existing.status === "processed") {
    logger.error(
      { withdrawalId: args.withdrawalId, newStatus: args.status, reason: args.reason },
      "DOUBLE-CREDIT GUARD: failed/reversed webhook arrived after `processed`. Not refunding; manual reconciliation required.",
    );
    return { transitioned: false };
  }
  // Idempotency for member-facing notifications: if the row is already
  // in the same terminal failed/reversed state (a replayed webhook),
  // skip the redundant update + refund attempt and tell the caller no
  // transition occurred so it does not re-notify (Task #964).
  if (existing.status === args.status && existing.refundTxnId) {
    return { transitioned: false };
  }
  await db.update(clubWalletWithdrawalsTable).set({
    status: args.status,
    razorpayPayoutId: args.razorpayPayoutId ?? sql`${clubWalletWithdrawalsTable.razorpayPayoutId}`,
    failureReason: args.reason,
    failedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(clubWalletWithdrawalsTable.id, args.withdrawalId));
  await refundWithdrawal(args.withdrawalId, args.reason);
  return { transitioned: true };
}

/** Terminal / refunded states that markWithdrawalProcessing must not regress. */
const TERMINAL_WITHDRAWAL_STATUSES = new Set([
  "processed",
  "failed",
  "reversed",
  "cancelled",
  "paid_after_refund",
]);

export async function markWithdrawalProcessing(args: {
  withdrawalId: number;
  razorpayPayoutId?: string;
}): Promise<void> {
  // State-machine guard: late `payout.updated` / `queued` / `pending`
  // events from RazorpayX must not regress a withdrawal that has already
  // reached a terminal / refunded state. Without this guard the row
  // would be rewritten to `processing`, which (a) is a misleading status
  // for the member and (b) makes the row count toward the daily-limit
  // sum (which excludes only failed/reversed/cancelled), unfairly
  // blocking subsequent legitimate withdrawals.
  const [existing] = await db.select().from(clubWalletWithdrawalsTable)
    .where(eq(clubWalletWithdrawalsTable.id, args.withdrawalId));
  if (!existing) return;
  if (TERMINAL_WITHDRAWAL_STATUSES.has(existing.status)) {
    logger.warn(
      { withdrawalId: args.withdrawalId, currentStatus: existing.status, razorpayPayoutId: args.razorpayPayoutId },
      "Ignoring late `processing` webhook for terminal withdrawal",
    );
    // Still record the razorpayPayoutId if we didn't have one (helpful
    // for ops to look the row up), but never change status.
    if (args.razorpayPayoutId && !existing.razorpayPayoutId) {
      await db.update(clubWalletWithdrawalsTable).set({
        razorpayPayoutId: args.razorpayPayoutId,
        updatedAt: new Date(),
      }).where(eq(clubWalletWithdrawalsTable.id, args.withdrawalId));
    }
    return;
  }
  await db.update(clubWalletWithdrawalsTable).set({
    status: "processing",
    razorpayPayoutId: args.razorpayPayoutId ?? sql`${clubWalletWithdrawalsTable.razorpayPayoutId}`,
    updatedAt: new Date(),
  }).where(eq(clubWalletWithdrawalsTable.id, args.withdrawalId));
}

export { walletPayoutAccountsTable, clubWalletWithdrawalsTable };
