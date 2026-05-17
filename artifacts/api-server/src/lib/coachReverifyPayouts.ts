/**
 * Task #913 — Periodic re-verification of coach payout accounts.
 *
 * The first time a coach saves their payout details we hit Razorpay's VPA
 * lookup / bank penny-drop helpers (see `lib/razorpay.ts`). A VPA can be
 * deactivated and a bank account can be closed long after that initial
 * check though, so this job re-runs the same validation periodically and
 * marks the account as needing attention if it has gone dead. The
 * disburse helper in `lib/coachPayouts.ts` then parks any payouts to the
 * coach until they re-save (and so re-verify) their account.
 *
 * Runs daily; touches at most `MAX_BATCH` accounts per tick so a Razorpay
 * outage doesn't cause us to lose state mid-batch. Best-effort: any per-
 * coach failure is logged and skipped, never aborts the rest of the run.
 */

import {
  db,
  coachMarketplaceProfilesTable,
  teachingProsTable,
  appUsersTable,
  organizationsTable,
  clubMembersTable,
  memberCommPrefsTable,
  userNotificationPrefsTable,
  coachPayoutNotificationsTable,
  coachPayoutsTable,
} from "@workspace/db";
import { and, desc, eq, isNotNull, lt, or, isNull, inArray } from "drizzle-orm";
import {
  validateRazorpayVpa,
  validateRazorpayBankFundAccount,
} from "./razorpay";
import {
  sendCoachPayoutAccountNeedsAttentionEmail,
  sendCoachPayoutAccountReverifiedByAdminEmail,
  type EmailBranding,
} from "./mailer";
import { sendPushToUsers } from "./push";
import { logger as baseLogger } from "./logger";

const logger = baseLogger.child({ module: "coach-reverify-payouts" });

/** Max accounts touched per cron tick (defensive bound on Razorpay calls). */
const MAX_BATCH = 50;

/** Default re-verification staleness window. Override with COACH_PAYOUT_REVERIFY_DAYS. */
const DEFAULT_REVERIFY_DAYS = 60;

function getReverifyDays(): number {
  const raw = process.env.COACH_PAYOUT_REVERIFY_DAYS;
  if (!raw) return DEFAULT_REVERIFY_DAYS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REVERIFY_DAYS;
  return n;
}

export interface ReverifyResult {
  proId: number;
  organizationId: number;
  method: "upi" | "bank_account";
  outcome: "verified" | "needs_attention" | "skipped" | "error";
  reason?: string;
}

export interface ReverifyRunSummary {
  considered: number;
  verified: number;
  needsAttention: number;
  errors: number;
  skipped: number;
  results: ReverifyResult[];
}

/**
 * Build the human-friendly label used in emails / banners. We never echo
 * the full VPA or bank account; mirror the masking applied elsewhere.
 */
function accountLabel(profile: typeof coachMarketplaceProfilesTable.$inferSelect): string {
  if (profile.payoutMethod === "upi" && profile.payoutVpa) {
    const [name, domain] = profile.payoutVpa.split("@");
    if (!name || !domain) return profile.payoutVpa;
    const visible = name.slice(0, 2);
    return `${visible}${"•".repeat(Math.max(2, name.length - 2))}@${domain}`;
  }
  if (profile.payoutMethod === "bank_account" && profile.payoutBankAccountNumber) {
    const last4 = profile.payoutBankAccountNumber.slice(-4);
    const ifsc = profile.payoutBankIfsc ?? "";
    return `${ifsc} ••••${last4}`;
  }
  return "(account on file)";
}

/**
 * Find every coach with a saved payout account that hasn't been
 * re-validated in the last N days. Excludes coaches whose status is
 * already 'needs_attention' so we don't spam them daily — they get one
 * notification and stay parked until they re-save.
 */
async function loadStaleAccounts(): Promise<Array<typeof coachMarketplaceProfilesTable.$inferSelect>> {
  const cutoff = new Date(Date.now() - getReverifyDays() * 24 * 60 * 60 * 1000);
  return db.select().from(coachMarketplaceProfilesTable).where(and(
    isNotNull(coachMarketplaceProfilesTable.payoutAccountId),
    isNotNull(coachMarketplaceProfilesTable.payoutMethod),
    or(
      isNull(coachMarketplaceProfilesTable.payoutVerifiedAt),
      lt(coachMarketplaceProfilesTable.payoutVerifiedAt, cutoff),
    ),
    or(
      isNull(coachMarketplaceProfilesTable.payoutVerificationStatus),
      eq(coachMarketplaceProfilesTable.payoutVerificationStatus, "verified"),
    ),
  )).limit(MAX_BATCH);
}

/**
 * Best-effort load of the coach's user record + organization branding
 * for the email / push notification.
 */
async function loadCoachContact(profile: typeof coachMarketplaceProfilesTable.$inferSelect) {
  const [pro] = await db.select({
    displayName: teachingProsTable.displayName,
    proEmail: teachingProsTable.email,
    userId: teachingProsTable.userId,
  }).from(teachingProsTable).where(eq(teachingProsTable.id, profile.proId)).limit(1);

  let userEmail: string | null = null;
  let userName: string | null = null;
  let userLang: string | null = null;
  let coachUserId: number | null = pro?.userId ?? null;
  if (coachUserId) {
    const [u] = await db.select({
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      preferredLanguage: appUsersTable.preferredLanguage,
    }).from(appUsersTable).where(eq(appUsersTable.id, coachUserId)).limit(1);
    userEmail = u?.email ?? null;
    userName = u?.displayName ?? null;
    userLang = u?.preferredLanguage ?? null;
  }

  let branding: EmailBranding = { orgName: "KHARAGOLF" };
  try {
    const [org] = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    }).from(organizationsTable).where(eq(organizationsTable.id, profile.organizationId)).limit(1);
    if (org) {
      branding = {
        orgName: org.name,
        logoUrl: org.logoUrl ?? undefined,
        primaryColor: org.primaryColor ?? undefined,
      };
    }
  } catch (err) {
    logger.warn({ err, proId: profile.proId }, "failed to load org branding");
  }

  return {
    coachUserId,
    coachName: userName ?? pro?.displayName ?? "Coach",
    recipientEmail: userEmail ?? pro?.proEmail ?? null,
    coachLang: userLang,
    branding,
  };
}

/**
 * Honour the coach's `billing` comm prefs (default ON when no row).
 * Uses the same lookup pattern as `notifyCoachPayoutPaid`.
 */
async function loadBillingPrefs(
  organizationId: number,
  coachUserId: number | null,
): Promise<{ email: boolean; push: boolean }> {
  const defaults = { email: true, push: true };
  if (!coachUserId) return defaults;
  try {
    const [member] = await db.select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, organizationId),
        eq(clubMembersTable.userId, coachUserId),
      )).limit(1);
    if (!member) return defaults;
    const [row] = await db.select({
      emailEnabled: memberCommPrefsTable.emailEnabled,
      pushEnabled: memberCommPrefsTable.pushEnabled,
    })
      .from(memberCommPrefsTable)
      .where(and(
        eq(memberCommPrefsTable.clubMemberId, member.id),
        eq(memberCommPrefsTable.category, "billing"),
      )).limit(1);
    if (!row) return defaults;
    return {
      email: Boolean(row.emailEnabled),
      push: Boolean(row.pushEnabled),
    };
  } catch (err) {
    logger.warn({ err, organizationId, coachUserId }, "failed to load billing prefs; defaulting to ON");
    return defaults;
  }
}

/**
 * Task #1724 — load the per-event `notifyAdminPayoutReverify` flag for
 * the coach. Defaults to true when no row exists (matching the schema
 * default) so existing coaches keep getting the courtesy notice. The
 * flag gates only `notifyCoachOfAdminReverify` — the cron-side
 * needs-attention email and any other admin notifications stay on
 * unless their own per-event toggle is flipped.
 */
async function loadAdminPayoutReverifyPref(coachUserId: number | null): Promise<boolean> {
  if (!coachUserId) return true;
  try {
    const [row] = await db
      .select({ notifyAdminPayoutReverify: userNotificationPrefsTable.notifyAdminPayoutReverify })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, coachUserId))
      .limit(1);
    if (!row) return true;
    return row.notifyAdminPayoutReverify !== false;
  } catch (err) {
    logger.warn({ err, coachUserId }, "failed to load notifyAdminPayoutReverify pref; defaulting to ON");
    return true;
  }
}

/**
 * Notify the coach that their payout account failed re-verification.
 * Best-effort: any channel failure is logged but never thrown.
 */
async function notifyCoachAccountNeedsAttention(
  profile: typeof coachMarketplaceProfilesTable.$inferSelect,
  failureReason: string,
): Promise<void> {
  const method = profile.payoutMethod === "upi" ? "upi" : "bank_account";
  const label = accountLabel(profile);
  const { coachUserId, coachName, recipientEmail, branding } = await loadCoachContact(profile);
  const prefs = await loadBillingPrefs(profile.organizationId, coachUserId);

  // ── Email ─────────────────────────────────────────────────────────
  if (prefs.email && recipientEmail) {
    try {
      await sendCoachPayoutAccountNeedsAttentionEmail({
        to: recipientEmail,
        coachName,
        method,
        accountLabel: label,
        failureReason,
        branding,
      });
      logger.info({ proId: profile.proId, to: recipientEmail }, "needs-attention email sent");
    } catch (err) {
      logger.error({ err, proId: profile.proId }, "failed to send needs-attention email");
    }
  }

  // ── In-app push (only if we know which app user owns this coach) ──
  // Task #1240 — fire-and-forget: the PushDeliveryResult is discarded
  // (only the throw path is logged) so no `classifyPushDelivery` mapping
  // is needed. The push is a companion to the email + the in-app
  // notification row written below; it is never the sole signal.
  if (coachUserId && prefs.push) {
    try {
      await sendPushToUsers(
        [coachUserId],
        "Re-verify your payout account",
        `We couldn't re-verify your ${method === "upi" ? "UPI ID" : "bank account"} (${label}). Re-save it in your coach workspace so we can resume payouts.`,
        {
          type: "coach_payout_account_needs_attention",
          proId: profile.proId,
          organizationId: profile.organizationId,
          method,
        },
      );
    } catch (err) {
      logger.warn({ err, proId: profile.proId }, "failed to push needs-attention notification");
    }
  }

  // ── In-app notification row, surfaced as a banner in the coach
  //    workspace alongside the payout-paid notifications. We piggyback on
  //    the most-recent unpaid payout (if any) so the existing
  //    `coach_payout_notifications` table can carry the banner without a
  //    new schema. If the coach has no outstanding payout we skip the
  //    in-app row — the email/push above is enough; the banner backed by
  //    `payoutVerificationStatus` itself is shown by the workspace UI.
  if (coachUserId) {
    try {
      const [latest] = await db.select({ id: coachPayoutsTable.id })
        .from(coachPayoutsTable)
        .where(and(
          eq(coachPayoutsTable.proId, profile.proId),
          inArray(coachPayoutsTable.status, ["pending", "failed"] as const),
        ))
        .orderBy(desc(coachPayoutsTable.createdAt))
        .limit(1);
      if (latest) {
        await db.insert(coachPayoutNotificationsTable).values({
          coachUserId,
          payoutId: latest.id,
          organizationId: profile.organizationId,
          title: "Re-verify your payout account",
          body: `We couldn't re-verify ${label}. Re-save your details to resume payouts.`,
          amountPaise: 0,
          reference: null,
          notes: failureReason,
        }).onConflictDoNothing({ target: coachPayoutNotificationsTable.payoutId });
      }
    } catch (err) {
      logger.warn({ err, proId: profile.proId }, "failed to insert in-app needs-attention row");
    }
  }
}

/**
 * Task #1428 — Notify the coach that an organisation admin manually
 * re-verified their payout account, regardless of whether the outcome
 * was `verified` or `needs_attention`. The cron-only `needs_attention`
 * path is already covered by `notifyCoachAccountNeedsAttention` (called
 * from `reverifyOne`); this helper closes the visibility gap on the
 * admin-triggered path by attributing the re-check to a human operator
 * with a date and an explicit status.
 *
 * Honours the same `billing` comm-prefs opt-out as the cron-side
 * needs-attention email so coaches can silence transactional payout
 * account notices in one place.
 *
 * Best-effort: any per-channel failure is logged but never thrown — the
 * admin-side request must not fail because the courtesy notice didn't
 * land.
 */
export async function notifyCoachOfAdminReverify(opts: {
  profile: typeof coachMarketplaceProfilesTable.$inferSelect;
  outcome: "verified" | "needs_attention";
  reason?: string | null;
  reverifiedAt?: Date;
}): Promise<void> {
  const { profile, outcome, reason } = opts;
  const reverifiedAt = opts.reverifiedAt ?? new Date();
  const method = profile.payoutMethod === "upi" ? "upi" : "bank_account";
  const label = accountLabel(profile);
  const { coachUserId, coachName, recipientEmail, coachLang, branding } = await loadCoachContact(profile);
  const prefs = await loadBillingPrefs(profile.organizationId, coachUserId);
  // Task #1724 — per-event opt-out gate. Honoured in addition to the
  // broader `billing` comm-prefs check above so coaches can mute *just*
  // the admin courtesy notice without silencing payout receipts or the
  // cron-side needs-attention email. Defaults to true when the row is
  // missing, matching the schema default.
  const perEventEnabled = await loadAdminPayoutReverifyPref(coachUserId);
  if (!perEventEnabled) {
    logger.debug(
      { proId: profile.proId, coachUserId, outcome },
      "skipping admin-reverify coach notice — per-event opt-out (notifyAdminPayoutReverify=false)",
    );
    return;
  }
  if (!prefs.email || !recipientEmail) {
    logger.debug(
      { proId: profile.proId, hasEmail: Boolean(recipientEmail), prefEmail: prefs.email, outcome },
      "skipping admin-reverify coach notice — opted out or no recipient email",
    );
    return;
  }
  try {
    await sendCoachPayoutAccountReverifiedByAdminEmail({
      to: recipientEmail,
      coachName,
      method,
      accountLabel: label,
      outcome,
      reason: reason ?? null,
      reverifiedAt,
      branding,
      lang: coachLang,
    });
    logger.info(
      { proId: profile.proId, to: recipientEmail, outcome },
      "admin-reverify coach notice sent",
    );
  } catch (err) {
    logger.error(
      { err, proId: profile.proId, outcome },
      "failed to send admin-reverify coach notice",
    );
  }
}

/**
 * Re-validate a single coach's saved fund account against Razorpay and
 * update the marketplace profile + (optionally) notify the coach.
 *
 * Exported for reuse by the admin "Re-verify now" endpoint (Task #1062);
 * the cron entry-point still calls this internally.
 */
export async function reverifyOne(
  profile: typeof coachMarketplaceProfilesTable.$inferSelect,
): Promise<ReverifyResult> {
  const proId = profile.proId;
  const organizationId = profile.organizationId;
  const method = profile.payoutMethod === "upi" ? "upi" : "bank_account";
  const fundAccountId = profile.payoutAccountId!;

  try {
    if (method === "upi") {
      if (!profile.payoutVpa) {
        // Misconfigured row — flag as needs_attention so it doesn't keep
        // turning up in the daily batch, and notify the coach so they
        // can re-save (consistent with normal failure handling).
        const reason = "UPI ID is missing from your saved payout details";
        await db.update(coachMarketplaceProfilesTable).set({
          payoutVerificationStatus: "needs_attention",
          payoutVerificationFailureReason: reason,
          updatedAt: new Date(),
        }).where(eq(coachMarketplaceProfilesTable.proId, proId));
        await notifyCoachAccountNeedsAttention(profile, reason);
        return { proId, organizationId, method, outcome: "needs_attention", reason };
      }
      const v = await validateRazorpayVpa(profile.payoutVpa);
      if (!v.success) {
        const reason = "UPI ID is no longer accepting transfers";
        await db.update(coachMarketplaceProfilesTable).set({
          payoutVerificationStatus: "needs_attention",
          payoutVerificationFailureReason: reason,
          updatedAt: new Date(),
        }).where(eq(coachMarketplaceProfilesTable.proId, proId));
        await notifyCoachAccountNeedsAttention(profile, reason);
        return { proId, organizationId, method, outcome: "needs_attention", reason };
      }
    } else {
      const v = await validateRazorpayBankFundAccount(fundAccountId);
      if (v.status === "failed" || v.results?.account_status === "invalid") {
        const reason = v.error?.description ?? "Bank account is no longer accepting transfers";
        await db.update(coachMarketplaceProfilesTable).set({
          payoutVerificationStatus: "needs_attention",
          payoutVerificationFailureReason: reason,
          updatedAt: new Date(),
        }).where(eq(coachMarketplaceProfilesTable.proId, proId));
        await notifyCoachAccountNeedsAttention(profile, reason);
        return { proId, organizationId, method, outcome: "needs_attention", reason };
      }
      if (v.status !== "completed") {
        // Penny-drop still in flight — don't penalise the coach. Try
        // again on the next tick.
        return { proId, organizationId, method, outcome: "skipped", reason: "validation pending" };
      }
    }

    // Verified — bump the timestamp and clear any stale failure reason.
    await db.update(coachMarketplaceProfilesTable).set({
      payoutVerifiedAt: new Date(),
      payoutVerificationStatus: "verified",
      payoutVerificationFailureReason: null,
      updatedAt: new Date(),
    }).where(eq(coachMarketplaceProfilesTable.proId, proId));
    return { proId, organizationId, method, outcome: "verified" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ err, proId }, "re-verification call failed");
    return { proId, organizationId, method, outcome: "error", reason };
  }
}

/**
 * Admin entry-point (Task #1062). Loads the coach's marketplace profile
 * by `proId` and re-runs the same VPA / bank-fund-account validation the
 * cron uses. Returns `null` if the coach has no saved payout account,
 * letting the route surface a friendly 400 instead of a generic error.
 */
export async function reverifyCoachPayoutAccountById(
  proId: number,
): Promise<ReverifyResult | null> {
  const [profile] = await db.select()
    .from(coachMarketplaceProfilesTable)
    .where(eq(coachMarketplaceProfilesTable.proId, proId))
    .limit(1);
  if (!profile) return null;
  if (!profile.payoutAccountId || !profile.payoutMethod) return null;
  return reverifyOne(profile);
}

/**
 * Cron entry-point. Re-validates up to MAX_BATCH stale payout accounts.
 */
export async function reverifyStalePayoutAccounts(): Promise<ReverifyRunSummary> {
  const stale = await loadStaleAccounts();
  const summary: ReverifyRunSummary = {
    considered: stale.length,
    verified: 0,
    needsAttention: 0,
    errors: 0,
    skipped: 0,
    results: [],
  };
  if (stale.length === 0) {
    logger.debug("no stale coach payout accounts");
    return summary;
  }
  logger.info({ count: stale.length, days: getReverifyDays() }, "re-verifying stale coach payout accounts");
  for (const profile of stale) {
    const r = await reverifyOne(profile);
    summary.results.push(r);
    switch (r.outcome) {
      case "verified": summary.verified++; break;
      case "needs_attention": summary.needsAttention++; break;
      case "error": summary.errors++; break;
      case "skipped": summary.skipped++; break;
    }
  }
  logger.info(summary, "coach payout re-verification batch complete");
  return summary;
}
