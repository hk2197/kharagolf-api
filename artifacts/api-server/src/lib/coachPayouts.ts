/**
 * Shared helpers for disbursing coach payouts via RazorpayX.
 *
 * Extracted from `routes/swing-reviews.ts` so that other routes (e.g. the coach
 * payout-account registration endpoint in `routes/coach-marketplace.ts`) can
 * automatically re-attempt stuck payouts without duplicating the disbursement
 * logic.
 */

import { db, coachPayoutsTable, coachMarketplaceProfilesTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { createRazorpayPayout, type RazorpayPayoutMode } from "./razorpay";
import { logger as baseLogger } from "./logger";

const logger = baseLogger.child({ module: "coach-payouts" });

export interface DisburseResult {
  status: "processing" | "pending" | "failed";
  razorpayPayoutId?: string;
  error?: string;
}

/**
 * Push a single payout row to RazorpayX. Mutates the `coach_payouts` row to
 * reflect the API outcome (processing / failed / unchanged-pending).
 */
export async function disburseCoachPayout(
  payoutId: number,
  profile: typeof coachMarketplaceProfilesTable.$inferSelect | undefined,
  netPayoutPaise: number,
): Promise<DisburseResult> {
  if (netPayoutPaise <= 0) {
    const reason = "Net payout is zero — nothing to disburse";
    await db.update(coachPayoutsTable).set({
      failureReason: reason, attemptedAt: new Date(),
    }).where(eq(coachPayoutsTable.id, payoutId));
    return { status: "pending", error: reason };
  }
  const fundAccountId = profile?.payoutAccountId;
  const method = profile?.payoutMethod;
  if (!fundAccountId || !method) {
    const reason = "Coach has not registered a payout account";
    await db.update(coachPayoutsTable).set({
      failureReason: reason, attemptedAt: new Date(),
    }).where(eq(coachPayoutsTable.id, payoutId));
    return { status: "pending", error: reason };
  }
  // Task #913 — Park the payout if the latest periodic re-verification of
  // this fund account failed. The coach has been emailed/notified to
  // re-verify; once they save the account again `payoutVerificationStatus`
  // flips back to 'verified' and the payout is auto-retried.
  if (profile?.payoutVerificationStatus === "needs_attention") {
    const reason = profile?.payoutVerificationFailureReason
      ? `Payout account needs re-verification: ${profile.payoutVerificationFailureReason}`
      : "Payout account needs re-verification by the coach";
    await db.update(coachPayoutsTable).set({
      failureReason: reason, attemptedAt: new Date(),
    }).where(eq(coachPayoutsTable.id, payoutId));
    return { status: "pending", error: reason };
  }
  const mode: RazorpayPayoutMode = method === "upi" ? "UPI" : "IMPS";
  try {
    const referenceId = `coachpayout_${payoutId}`;
    const rzpPayout = await createRazorpayPayout({
      fund_account_id: fundAccountId,
      amount: netPayoutPaise,
      mode,
      purpose: "vendor advance",
      reference_id: referenceId,
      narration: `Coach payout #${payoutId}`,
      notes: { coachPayoutId: String(payoutId), proId: String(profile!.proId) },
      queue_if_low_balance: true,
    });
    await db.update(coachPayoutsTable).set({
      status: "processing",
      payoutReference: rzpPayout.id,
      payoutMode: mode,
      attemptedAt: new Date(),
      failureReason: null,
    }).where(eq(coachPayoutsTable.id, payoutId));
    logger.info(
      { payoutId, razorpayPayoutId: rzpPayout.id, mode, amount: netPayoutPaise },
      "Coach payout submitted to RazorpayX",
    );
    return { status: "processing", razorpayPayoutId: rzpPayout.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "RazorpayX payout failed";
    await db.update(coachPayoutsTable).set({
      status: "failed",
      failureReason: reason,
      attemptedAt: new Date(),
      payoutMode: mode,
    }).where(eq(coachPayoutsTable.id, payoutId));
    logger.error({ err, payoutId }, "Coach payout submission failed");
    return { status: "failed", error: reason };
  }
}

export interface RetryStuckResult {
  payoutId: number;
  netPayoutPaise: number;
  previousStatus: "pending" | "failed";
  status: DisburseResult["status"];
  razorpayPayoutId?: string;
  error?: string;
}

/**
 * Re-attempt every `pending` / `failed` coach_payouts row for the given pro.
 *
 * Intended to be called after a coach saves (or fixes) their payout account,
 * so previously-parked payouts get pushed to RazorpayX automatically without
 * an admin having to retry each one.
 */
export async function retryStuckCoachPayouts(
  proId: number,
  profile: typeof coachMarketplaceProfilesTable.$inferSelect | undefined,
  trigger: string,
): Promise<RetryStuckResult[]> {
  const stuck = await db.select().from(coachPayoutsTable).where(and(
    eq(coachPayoutsTable.proId, proId),
    inArray(coachPayoutsTable.status, ["pending", "failed"] as const),
  ));
  if (stuck.length === 0) return [];

  logger.info(
    { proId, count: stuck.length, trigger, payoutIds: stuck.map(p => p.id) },
    "Auto-retrying stuck coach payouts",
  );

  const results: RetryStuckResult[] = [];
  for (const payout of stuck) {
    const previousStatus = payout.status as "pending" | "failed";
    const r = await disburseCoachPayout(payout.id, profile, payout.netPayoutPaise);
    results.push({
      payoutId: payout.id,
      netPayoutPaise: payout.netPayoutPaise,
      previousStatus,
      status: r.status,
      razorpayPayoutId: r.razorpayPayoutId,
      error: r.error,
    });
    logger.info(
      {
        proId, trigger, payoutId: payout.id,
        previousStatus, newStatus: r.status,
        razorpayPayoutId: r.razorpayPayoutId, error: r.error,
      },
      "Auto-retry attempt complete",
    );
  }
  return results;
}
