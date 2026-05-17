/**
 * Task #1119 — Periodic re-verification of members' wallet payout accounts.
 *
 * Mirrors `coachReverifyPayouts.ts` (Task #913) but for the
 * `wallet_payout_accounts` table that backs member wallet withdrawals
 * (Task #770). The first time a member saves a UPI / bank account we
 * run a Razorpay VPA lookup or penny-drop via `verifyRazorpayPayoutAccount`
 * (Task #965). The VPA can be retired or the bank account closed long
 * after that initial check though — without this job a member happily
 * withdraws months later to a dead destination and only finds out when
 * the payout fails.
 *
 * On each tick we:
 *   1. Load up to MAX_BATCH wallet payout accounts whose `verifiedAt` is
 *      older than N days (default 60) AND whose verificationStatus is
 *      either `verified` or null. Already-needs_attention rows are
 *      skipped — they get one notification, then sit parked until the
 *      member re-saves.
 *   2. Re-run `verifyRazorpayPayoutAccount` for each.
 *   3. On failure → flip `verificationStatus = 'needs_attention'`,
 *      stamp `verificationFailureReason`, and notify the member via
 *      push + email + in-app message. The Withdraw button already
 *      surfaces the failure reason (side-games-v2.ts:2108).
 *   4. On success → bump `verifiedAt` and clear the stale failure reason.
 *   5. On a "pending" penny-drop response → skip; we'll retry next tick.
 *
 * Best-effort: any per-member failure is logged and skipped so a single
 * Razorpay glitch doesn't abort the rest of the batch.
 */

import {
  db,
  walletPayoutAccountsTable,
  appUsersTable,
  organizationsTable,
  clubMembersTable,
  memberCommPrefsTable,
  memberMessagesTable,
  type WalletPayoutAccount,
} from "@workspace/db";
import { and, eq, isNotNull, lt, or, isNull } from "drizzle-orm";
import { verifyRazorpayPayoutAccount } from "./razorpayPayoutVerify";
import { sendMemberPayoutAccountNeedsAttentionEmail, type EmailBranding } from "./mailer";
import { sendPushToUsers } from "./push";
import { logger as baseLogger } from "./logger";

const logger = baseLogger.child({ module: "wallet-reverify-payouts" });

/** Max accounts touched per cron tick (defensive bound on Razorpay calls). */
const MAX_BATCH = 50;

/** Default re-verification staleness window. Override with WALLET_PAYOUT_REVERIFY_DAYS. */
const DEFAULT_REVERIFY_DAYS = 60;

function getReverifyDays(): number {
  const raw = process.env.WALLET_PAYOUT_REVERIFY_DAYS;
  if (!raw) return DEFAULT_REVERIFY_DAYS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REVERIFY_DAYS;
  return n;
}

export interface WalletReverifyResult {
  accountId: number;
  userId: number;
  organizationId: number;
  method: "upi" | "bank_account";
  outcome: "verified" | "needs_attention" | "skipped" | "error";
  reason?: string;
}

export interface WalletReverifyRunSummary {
  considered: number;
  verified: number;
  needsAttention: number;
  errors: number;
  skipped: number;
  results: WalletReverifyResult[];
}

/**
 * Build a member-friendly mask for the saved account, mirroring the
 * masking applied elsewhere (we never echo the full VPA / account #).
 */
function accountLabel(row: WalletPayoutAccount): string {
  if (row.method === "upi" && row.upiVpa) {
    const [name, domain] = row.upiVpa.split("@");
    if (!name || !domain) return row.upiVpa;
    const visible = name.slice(0, 2);
    return `${visible}${"•".repeat(Math.max(2, name.length - 2))}@${domain}`;
  }
  if (row.method === "bank_account" && row.bankAccountNumber) {
    const last4 = row.bankAccountNumber.slice(-4);
    const ifsc = row.bankIfsc ?? "";
    return `${ifsc} ••••${last4}`;
  }
  return "(account on file)";
}

/**
 * Find every wallet payout account that hasn't been re-validated in the
 * last N days. Excludes rows whose status is already 'needs_attention'
 * so we don't spam the member daily — they get one notification and
 * stay parked until they re-save (and so re-verify) the account.
 */
async function loadStaleAccounts(): Promise<WalletPayoutAccount[]> {
  const cutoff = new Date(Date.now() - getReverifyDays() * 24 * 60 * 60 * 1000);
  return db.select().from(walletPayoutAccountsTable).where(and(
    isNotNull(walletPayoutAccountsTable.razorpayFundAccountId),
    or(
      isNull(walletPayoutAccountsTable.verifiedAt),
      lt(walletPayoutAccountsTable.verifiedAt, cutoff),
    ),
    or(
      isNull(walletPayoutAccountsTable.verificationStatus),
      eq(walletPayoutAccountsTable.verificationStatus, "verified"),
    ),
  )).limit(MAX_BATCH);
}

/**
 * Best-effort load of the member's contact info + organization branding
 * for the email / push notification.
 */
async function loadMemberContact(row: WalletPayoutAccount) {
  let recipientEmail: string | null = null;
  let displayName: string | null = null;
  try {
    const [u] = await db.select({
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    }).from(appUsersTable).where(eq(appUsersTable.id, row.userId)).limit(1);
    recipientEmail = u?.email ?? null;
    displayName = u?.displayName ?? u?.username ?? null;
  } catch (err) {
    logger.warn({ err, userId: row.userId }, "failed to load member user row");
  }

  // Member rows in the org carry a richer contact record; prefer their
  // first/last name + email when available.
  let clubMemberId: number | null = null;
  try {
    const [m] = await db.select({
      id: clubMembersTable.id,
      email: clubMembersTable.email,
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
    }).from(clubMembersTable).where(and(
      eq(clubMembersTable.organizationId, row.organizationId),
      eq(clubMembersTable.userId, row.userId),
    )).limit(1);
    if (m) {
      clubMemberId = m.id;
      if (!recipientEmail) recipientEmail = m.email;
      const fullName = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim();
      if (fullName) displayName = fullName;
    }
  } catch (err) {
    logger.warn({ err, userId: row.userId }, "failed to load club_members row");
  }

  let branding: EmailBranding = { orgName: "KHARAGOLF" };
  try {
    const [org] = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    }).from(organizationsTable).where(eq(organizationsTable.id, row.organizationId)).limit(1);
    if (org) {
      branding = {
        orgName: org.name,
        logoUrl: org.logoUrl ?? undefined,
        primaryColor: org.primaryColor ?? undefined,
      };
    }
  } catch (err) {
    logger.warn({ err, organizationId: row.organizationId }, "failed to load org branding");
  }

  return {
    clubMemberId,
    recipientEmail,
    memberName: displayName ?? row.accountHolderName ?? "Member",
    branding,
  };
}

/**
 * Honour the member's `billing` comm prefs (default ON when no row).
 * Mirrors the lookup used in `walletWithdrawalNotify.ts` so opt-outs
 * apply consistently across all wallet-billing notifications.
 */
async function loadBillingPrefs(
  clubMemberId: number | null,
): Promise<{ email: boolean; push: boolean }> {
  const defaults = { email: true, push: true };
  if (!clubMemberId) return defaults;
  try {
    const [row] = await db.select({
      emailEnabled: memberCommPrefsTable.emailEnabled,
      pushEnabled: memberCommPrefsTable.pushEnabled,
    }).from(memberCommPrefsTable).where(and(
      eq(memberCommPrefsTable.clubMemberId, clubMemberId),
      eq(memberCommPrefsTable.category, "billing"),
    )).limit(1);
    if (!row) return defaults;
    return {
      email: Boolean(row.emailEnabled),
      push: Boolean(row.pushEnabled),
    };
  } catch (err) {
    logger.warn({ err, clubMemberId }, "failed to load billing prefs; defaulting to ON");
    return defaults;
  }
}

/**
 * Notify the member that their saved wallet payout account failed
 * re-verification. Best-effort: any channel failure is logged but never
 * thrown — the failure flag has already been persisted by the caller.
 */
async function notifyMemberAccountNeedsAttention(
  row: WalletPayoutAccount,
  failureReason: string,
): Promise<void> {
  const method = row.method === "upi" ? "upi" : "bank_account";
  const label = accountLabel(row);
  const { clubMemberId, recipientEmail, memberName, branding } = await loadMemberContact(row);
  const prefs = await loadBillingPrefs(clubMemberId);

  // ── Email ─────────────────────────────────────────────────────────
  if (prefs.email && recipientEmail) {
    try {
      await sendMemberPayoutAccountNeedsAttentionEmail({
        to: recipientEmail,
        memberName,
        method,
        accountLabel: label,
        failureReason,
        branding,
      });
      logger.info({ accountId: row.id, to: recipientEmail }, "needs-attention email sent");
    } catch (err) {
      logger.error({ err, accountId: row.id }, "failed to send needs-attention email");
    }
  }

  // ── Push ──────────────────────────────────────────────────────────
  // Task #1240 — fire-and-forget: result is discarded (only throws are
  // logged), so no `classifyPushDelivery` mapping is needed. Mirrors the
  // coachReverifyPayouts.ts companion path; the email + in-app row below
  // are the durable signals.
  if (prefs.push) {
    try {
      await sendPushToUsers(
        [row.userId],
        "Re-verify your payout account",
        `We couldn't re-verify your ${method === "upi" ? "UPI ID" : "bank account"} (${label}). Re-save it in your wallet so withdrawals can resume.`,
        {
          type: "wallet_payout_account_needs_attention",
          accountId: row.id,
          organizationId: row.organizationId,
          method,
        },
      );
    } catch (err) {
      logger.warn({ err, accountId: row.id }, "failed to push needs-attention notification");
    }
  }

  // ── In-app message (only when we know the club_members row) ────────
  if (clubMemberId) {
    try {
      await db.insert(memberMessagesTable).values({
        organizationId: row.organizationId,
        clubMemberId,
        channel: "in_app",
        subject: "Re-verify your payout account",
        body: `We couldn't re-verify ${label}. Re-save your details in the wallet to resume withdrawals. Reason: ${failureReason}`,
        status: "sent",
        relatedEntity: "wallet_payout_account",
        relatedEntityId: row.id,
      });
    } catch (err) {
      logger.warn({ err, accountId: row.id }, "failed to insert in-app needs-attention row");
    }
  }
}

/**
 * Re-validate a single wallet payout account against Razorpay and
 * update the row + (optionally) notify the member.
 */
export async function reverifyOneWalletAccount(
  row: WalletPayoutAccount,
): Promise<WalletReverifyResult> {
  const accountId = row.id;
  const userId = row.userId;
  const organizationId = row.organizationId;
  const method = row.method === "upi" ? "upi" : "bank_account";
  const fundAccountId = row.razorpayFundAccountId!;

  try {
    if (method === "upi" && !row.upiVpa) {
      // Misconfigured row — flag as needs_attention so it doesn't keep
      // turning up in the daily batch, and notify the member so they
      // can re-save (consistent with normal failure handling).
      const reason = "UPI ID is missing from your saved payout details";
      await db.update(walletPayoutAccountsTable).set({
        verificationStatus: "needs_attention",
        verificationFailureReason: reason,
        updatedAt: new Date(),
      }).where(eq(walletPayoutAccountsTable.id, accountId));
      await notifyMemberAccountNeedsAttention(row, reason);
      return { accountId, userId, organizationId, method, outcome: "needs_attention", reason };
    }

    const v = await verifyRazorpayPayoutAccount({
      method,
      upiVpa: row.upiVpa ?? undefined,
      fundAccountId,
    });

    if (v.status === "pending") {
      // Penny-drop still in flight — don't penalise the member. Try
      // again on the next tick.
      return { accountId, userId, organizationId, method, outcome: "skipped", reason: "validation pending" };
    }

    if (v.status === "failed") {
      const reason = v.errorMessage;
      await db.update(walletPayoutAccountsTable).set({
        verificationStatus: "needs_attention",
        verificationFailureReason: reason,
        updatedAt: new Date(),
      }).where(eq(walletPayoutAccountsTable.id, accountId));
      await notifyMemberAccountNeedsAttention(row, reason);
      return { accountId, userId, organizationId, method, outcome: "needs_attention", reason };
    }

    // Verified — bump the timestamp and clear any stale failure reason.
    await db.update(walletPayoutAccountsTable).set({
      verifiedAt: new Date(),
      verifiedHolderName: v.verifiedHolderName ?? row.verifiedHolderName,
      verificationStatus: "verified",
      verificationFailureReason: null,
      updatedAt: new Date(),
    }).where(eq(walletPayoutAccountsTable.id, accountId));
    return { accountId, userId, organizationId, method, outcome: "verified" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ err, accountId }, "wallet re-verification call failed");
    return { accountId, userId, organizationId, method, outcome: "error", reason };
  }
}

/**
 * Cron entry-point. Re-validates up to MAX_BATCH stale wallet payout
 * accounts per tick.
 */
export async function reverifyStaleWalletPayoutAccounts(): Promise<WalletReverifyRunSummary> {
  const stale = await loadStaleAccounts();
  const summary: WalletReverifyRunSummary = {
    considered: stale.length,
    verified: 0,
    needsAttention: 0,
    errors: 0,
    skipped: 0,
    results: [],
  };
  if (stale.length === 0) {
    logger.debug("no stale wallet payout accounts");
    return summary;
  }
  logger.info({ count: stale.length, days: getReverifyDays() }, "re-verifying stale wallet payout accounts");
  for (const row of stale) {
    const r = await reverifyOneWalletAccount(row);
    summary.results.push(r);
    switch (r.outcome) {
      case "verified": summary.verified++; break;
      case "needs_attention": summary.needsAttention++; break;
      case "error": summary.errors++; break;
      case "skipped": summary.skipped++; break;
    }
  }
  logger.info(summary, "wallet payout re-verification batch complete");
  return summary;
}
