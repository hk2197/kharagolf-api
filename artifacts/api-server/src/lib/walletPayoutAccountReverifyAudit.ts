/**
 * Task #1518 — Audit-row helper for admin-triggered re-verifications of
 * a member's wallet payout account.
 *
 * Mirrors `coachPayoutAccountReverifyAudit.ts` (Task #1222): one
 * persistence call site (no inline DB plumbing in the route handler) so
 * tests can swap it out via `vi.mock` with a strict, typed signature
 * instead of poking at the global Drizzle handle.
 *
 * The helper masks UPI / bank details exactly the same way the
 * `wallet_payout_accounts` row is masked elsewhere in the codebase
 * (see `accountLabel` in `walletReverifyPayouts.ts` and the member-
 * facing GET endpoint in `routes/side-games-v2.ts`). It is intentionally
 * fail-loud: if the insert fails the caller propagates a 500 so the
 * admin retries. `reverifyOneWalletAccount` is idempotent —
 * re-running it converges on the same verification status — so a
 * retry will produce a single audit row once persistence succeeds
 * rather than leaving an unaudited state change.
 */
import {
  db,
  walletPayoutAccountsTable,
  walletPayoutAccountHistoryTable,
} from "@workspace/db";

/**
 * Mirror of the masking the GET / list endpoints apply to `upiVpa` so
 * the audit log never reveals the full VPA. Kept in sync with the
 * `accountLabel` helper in `walletReverifyPayouts.ts`.
 */
function maskUpiVpa(vpa: string): string {
  const [name, domain] = vpa.split("@");
  if (!name || !domain) return vpa;
  const visible = name.slice(0, 2);
  return `${visible}${"•".repeat(Math.max(2, name.length - 2))}@${domain}`;
}

export interface RecordWalletAdminReverifyHistoryParams {
  walletPayoutAccountId: number;
  organizationId: number;
  userId: number;
  adminUserId: number;
  /**
   * Snapshot of the wallet payout account *before* re-verification so
   * the audit row carries the same masked details (UPI/last4/IFSC) as
   * any future created/updated rows we add for member self-saves.
   */
  accountBefore: typeof walletPayoutAccountsTable.$inferSelect;
  outcome: "verified" | "needs_attention" | "skipped" | "error";
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export async function recordWalletAdminReverifyHistory(
  params: RecordWalletAdminReverifyHistoryParams,
): Promise<void> {
  const { accountBefore } = params;
  await db.insert(walletPayoutAccountHistoryTable).values({
    walletPayoutAccountId: params.walletPayoutAccountId,
    organizationId: params.organizationId,
    userId: params.userId,
    changedByUserId: params.adminUserId,
    changedByRole: "admin",
    changeKind: "admin_reverify",
    method: accountBefore.method === "upi" ? "upi" : "bank_account",
    accountHolderName: accountBefore.accountHolderName ?? null,
    upiVpaMasked: accountBefore.method === "upi" && accountBefore.upiVpa
      ? maskUpiVpa(accountBefore.upiVpa)
      : null,
    bankAccountLast4: accountBefore.method === "bank_account" && accountBefore.bankAccountNumber
      ? accountBefore.bankAccountNumber.slice(-4)
      : null,
    bankIfsc: accountBefore.method === "bank_account"
      ? accountBefore.bankIfsc ?? null
      : null,
    razorpayContactId: accountBefore.razorpayContactId ?? null,
    razorpayFundAccountId: accountBefore.razorpayFundAccountId ?? null,
    verificationOutcome: params.outcome,
    verificationReason: params.reason,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });
}
