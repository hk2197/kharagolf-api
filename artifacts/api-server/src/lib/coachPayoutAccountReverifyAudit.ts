/**
 * Task #1222 — Audit-row helper for admin-triggered payout-account
 * re-verifications.
 *
 * Extracted into its own module so the route handler keeps a single
 * persistence call site (no inline DB plumbing) and so tests can swap
 * the implementation via `vi.mock` with a strict, typed signature
 * instead of poking at the global Drizzle handle.
 *
 * The function masks UPI / bank details exactly the same way the
 * coach-initiated `created` / `updated` rows are masked elsewhere in
 * the codebase. It is intentionally a fail-loud function: if the
 * insert fails the caller propagates a 500 so the admin retries.
 * `reverifyOne` is idempotent — re-running it converges on the same
 * verification status — so a retry will produce a single audit row
 * once persistence succeeds rather than leaving an unaudited state
 * change.
 */
import {
  db,
  coachMarketplaceProfilesTable,
  coachPayoutAccountHistoryTable,
} from "@workspace/db";

/**
 * Mirror of the masking the web/mobile UIs apply to `payoutVpa` so the
 * audit log never reveals the full VPA. Kept in sync with the local
 * helper of the same name in `routes/coach-marketplace.ts` (Task #764).
 */
function maskUpiVpa(vpa: string): string {
  const [name, domain] = vpa.split("@");
  if (!name || !domain) return vpa;
  const visible = name.slice(0, 2);
  return `${visible}${"•".repeat(Math.max(2, name.length - 2))}@${domain}`;
}

export interface RecordAdminReverifyHistoryParams {
  proId: number;
  organizationId: number;
  adminUserId: number;
  /**
   * Snapshot of the marketplace profile *before* re-verification so
   * the audit row carries the same masked details (UPI/last4/IFSC) as
   * the coach- and admin-initiated change rows.
   */
  profileBefore: typeof coachMarketplaceProfilesTable.$inferSelect;
  outcome: "verified" | "needs_attention" | "skipped" | "error";
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export async function recordAdminReverifyHistory(
  params: RecordAdminReverifyHistoryParams,
): Promise<void> {
  const { profileBefore } = params;
  await db.insert(coachPayoutAccountHistoryTable).values({
    proId: params.proId,
    organizationId: params.organizationId,
    changedByUserId: params.adminUserId,
    changedByRole: "admin",
    changeKind: "admin_reverify",
    method: profileBefore.payoutMethod === "upi" ? "upi" : "bank_account",
    accountHolderName: profileBefore.payoutAccountHolderName ?? null,
    upiVpaMasked: profileBefore.payoutMethod === "upi" && profileBefore.payoutVpa
      ? maskUpiVpa(profileBefore.payoutVpa)
      : null,
    bankAccountLast4: profileBefore.payoutMethod === "bank_account" && profileBefore.payoutBankAccountNumber
      ? profileBefore.payoutBankAccountNumber.slice(-4)
      : null,
    bankIfsc: profileBefore.payoutMethod === "bank_account"
      ? profileBefore.payoutBankIfsc ?? null
      : null,
    razorpayContactId: null,
    payoutAccountId: profileBefore.payoutAccountId,
    verificationOutcome: params.outcome,
    verificationReason: params.reason,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });
}
