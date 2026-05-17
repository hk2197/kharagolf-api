/**
 * Shared helper for verifying a freshly-created Razorpay fund account
 * before we let a member or coach withdraw / receive money.
 *
 * Coach payouts (Task #763) and member wallet withdrawals (Task #770)
 * both register a Razorpay contact + fund account and then need to confirm
 * with the bank that the VPA is reachable / the account number + IFSC
 * combination accepts a ₹1 penny drop. This module centralises that call
 * so the failure / pending semantics stay identical for both flows.
 */
import {
  validateRazorpayVpa,
  validateRazorpayBankFundAccount,
} from "./razorpay.js";

export type PayoutAccountVerifyOutcome =
  | { status: "verified"; verifiedHolderName: string | null }
  | { status: "failed"; errorMessage: string }
  | { status: "pending"; errorMessage: string };

export interface VerifyPayoutAccountOpts {
  method: "upi" | "bank_account";
  /** Required when method === "upi". */
  upiVpa?: string;
  /** Razorpay fund-account id returned by createRazorpayFundAccount. */
  fundAccountId: string;
}

const FAIL_UPI =
  "We couldn't verify this UPI ID with the bank. Double-check the VPA and try again.";
const FAIL_BANK =
  "We couldn't verify this bank account with a ₹1 test deposit. Double-check the account number and IFSC.";
const PENDING_BANK =
  "Bank verification is taking longer than expected. Please try again in a minute.";

/**
 * Run the appropriate Razorpay validation for a payout account. Returns a
 * structured outcome that the caller turns into a 422 / persisted row.
 *
 * Throws only on programmer error (e.g. missing upiVpa for the UPI flow).
 * Network / Razorpay errors are translated into `{ status: "failed" }`
 * so callers can surface a friendly message to members without leaking
 * upstream details.
 */
export async function verifyRazorpayPayoutAccount(
  opts: VerifyPayoutAccountOpts,
): Promise<PayoutAccountVerifyOutcome> {
  try {
    if (opts.method === "upi") {
      if (!opts.upiVpa) {
        throw new Error("verifyRazorpayPayoutAccount: upiVpa is required when method === 'upi'");
      }
      const v = await validateRazorpayVpa(opts.upiVpa);
      if (!v.success) return { status: "failed", errorMessage: FAIL_UPI };
      return { status: "verified", verifiedHolderName: v.customer_name?.trim() || null };
    }
    const v = await validateRazorpayBankFundAccount(opts.fundAccountId);
    if (v.status === "failed" || v.results?.account_status === "invalid") {
      return { status: "failed", errorMessage: v.error?.description ?? FAIL_BANK };
    }
    if (v.status !== "completed") {
      return { status: "pending", errorMessage: PENDING_BANK };
    }
    return {
      status: "verified",
      verifiedHolderName: v.results?.registered_name?.trim() || null,
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("verifyRazorpayPayoutAccount:")) {
      throw err;
    }
    return {
      status: "failed",
      errorMessage:
        "We couldn't verify this account right now. Double-check your details and try again in a moment.",
    };
  }
}
