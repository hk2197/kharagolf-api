// Task #1854 — In-app dashboard for the daily admin digest of exhausted
// wallet auto-refund / coach payout-account-change notify retries
// (Task #1507).
//
// The original Task #1507 cron (`sendNotifyExhaustionAdminDigest` in
// `cron.ts`) emails org admins once a day with the rows whose email or
// push retry counter has run out. Until this task the email was the
// only place this information surfaced — there was no way to see
// today's currently-exhausted rows without waiting for tomorrow's
// digest, and no way to manually re-trigger a single notification.
//
// This module exposes the two read/action helpers the admin panel
// needs:
//
//   • `listExhaustedAdminNotifyRows` — returns every wallet-refund and
//     coach-payout-account-change attempt row whose `emailRetryExhaustedAt`
//     OR `pushRetryExhaustedAt` is set, joined with the affected
//     member/coach metadata so the UI can render a triage table without
//     extra round trips. Tenant-scoped: org_admin /
//     tournament_director only see their own org's rows; super_admin
//     sees all.
//
//   • `resendExhaustedAdminNotifyRow` — clears the exhaustion stamp on
//     whichever channels are exhausted, resets the channel attempts
//     counter back to zero and flips the channel status back to
//     `failed` so the existing retry helpers accept the row, then
//     immediately calls those helpers. Mirrors the
//     `retryExhaustedChannel` pattern used by the Task #1542 ops-alert
//     drill-down so the two surfaces have consistent semantics.
//
// We deliberately query the persisted exhaustion stamps directly
// rather than reading the row out of the digest payload: the digest is
// only emailed once per (orgId, day) window, but a row can stay
// exhausted across many windows, and an admin viewing the panel
// should always see the live state regardless of digest cadence.
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import {
  db,
  appUsersTable,
  clubMembersTable,
  coachPayoutAccountChangeNotifyAttemptsTable,
  organizationsTable,
  teachingProsTable,
  walletTopupRefundNotifyAttemptsTable,
  type CoachPayoutAccountChangeNotifyAttempt,
  type WalletTopupRefundNotifyAttempt,
} from "@workspace/db";
import {
  retryWalletTopupRefundEmail,
  retryWalletTopupRefundPush,
  type WalletTopupRefundNotifyRetryResult,
} from "./walletTopupRefundNotify";
import {
  retryCoachPayoutAccountChangeEmail,
  retryCoachPayoutAccountChangePush,
  type CoachPayoutAccountChangeNotifyRetryResult,
} from "./coachPayoutAccountChangeNotify";

export type AdminNotifyFailurePipeline =
  | "wallet_refund"
  | "coach_payout_account_change";

export type AdminNotifyFailureChannel = "email" | "push";

export interface AdminNotifyFailureWalletMeta {
  paymentId: string;
  refundId: string | null;
  currency: string;
  amount: string;
  userId: number;
  /** Best-effort club-member or app-user display name. */
  memberName: string | null;
  /** Best-effort recipient email (club_members.email → app_users.email). */
  memberEmail: string | null;
}

export interface AdminNotifyFailureCoachMeta {
  historyId: number;
  proId: number;
  coachUserId: number;
  coachName: string | null;
  coachEmail: string | null;
  changeKind: string;
  method: string;
}

export interface AdminNotifyFailureRow {
  pipeline: AdminNotifyFailurePipeline;
  attemptId: number;
  organizationId: number;
  organizationName: string | null;
  /** Which channels are currently flagged exhausted. */
  channels: AdminNotifyFailureChannel[];
  /** Most recent of (lastEmailError, lastPushError). */
  lastError: string | null;
  /** ISO timestamp — most recent of email / push exhaustion stamps. */
  exhaustedAt: string;
  /** ISO timestamp the row was first stamped onto the daily digest, or null. */
  digestedAt: string | null;
  /** Pipeline-specific row metadata. Exactly one of these two is set. */
  walletRefund?: AdminNotifyFailureWalletMeta;
  coachPayoutAccountChange?: AdminNotifyFailureCoachMeta;
}

export interface ListAdminNotifyFailuresOpts {
  /**
   * Tenant scope. Pass the caller's organizationId to restrict to one
   * club; pass `null` for the platform-wide view (super_admin only).
   */
  organizationId: number | null;
  /** Cap returned rows. Default 200, max 500. */
  limit?: number;
}

function pickChannels(row: {
  emailRetryExhaustedAt: Date | null;
  pushRetryExhaustedAt: Date | null;
}): AdminNotifyFailureChannel[] {
  const out: AdminNotifyFailureChannel[] = [];
  if (row.emailRetryExhaustedAt) out.push("email");
  if (row.pushRetryExhaustedAt) out.push("push");
  return out;
}

function latestStamp(row: {
  emailRetryExhaustedAt: Date | null;
  pushRetryExhaustedAt: Date | null;
}): Date {
  const e = row.emailRetryExhaustedAt?.getTime() ?? 0;
  const p = row.pushRetryExhaustedAt?.getTime() ?? 0;
  return new Date(Math.max(e, p));
}

function pickLastError(row: {
  lastEmailError: string | null;
  lastPushError: string | null;
  emailRetryExhaustedAt: Date | null;
  pushRetryExhaustedAt: Date | null;
}): string | null {
  // Prefer the error from whichever channel was exhausted most recently
  // so admins see the most relevant signal first; fall back to the
  // other channel's error if the leading one didn't capture anything.
  const emailAt = row.emailRetryExhaustedAt?.getTime() ?? 0;
  const pushAt = row.pushRetryExhaustedAt?.getTime() ?? 0;
  if (emailAt >= pushAt) {
    return row.lastEmailError ?? row.lastPushError ?? null;
  }
  return row.lastPushError ?? row.lastEmailError ?? null;
}

/**
 * Returns the combined wallet + coach-payout-account-change attempt
 * rows that have an exhausted email or push retry. Sorted by the
 * latest exhaustion stamp, newest first, so a fresh outage rises to
 * the top of the table. Tenant-scoped via `organizationId`.
 */
export async function listExhaustedAdminNotifyRows(
  opts: ListAdminNotifyFailuresOpts,
): Promise<AdminNotifyFailureRow[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 200)));
  const orgScope = opts.organizationId;

  // Wallet refund rows ───────────────────────────────────────────────
  const walletWhere = and(
    or(
      isNotNull(walletTopupRefundNotifyAttemptsTable.emailRetryExhaustedAt),
      isNotNull(walletTopupRefundNotifyAttemptsTable.pushRetryExhaustedAt),
    ),
    orgScope == null
      ? undefined
      : eq(walletTopupRefundNotifyAttemptsTable.organizationId, orgScope),
  );

  const walletRows = await db
    .select({
      attempt: walletTopupRefundNotifyAttemptsTable,
      memberFirstName: clubMembersTable.firstName,
      memberLastName: clubMembersTable.lastName,
      memberEmail: clubMembersTable.email,
      userDisplayName: appUsersTable.displayName,
      userEmail: appUsersTable.email,
      userUsername: appUsersTable.username,
      orgName: organizationsTable.name,
    })
    .from(walletTopupRefundNotifyAttemptsTable)
    .leftJoin(
      clubMembersTable,
      and(
        eq(clubMembersTable.userId, walletTopupRefundNotifyAttemptsTable.userId),
        eq(
          clubMembersTable.organizationId,
          walletTopupRefundNotifyAttemptsTable.organizationId,
        ),
      ),
    )
    .leftJoin(
      appUsersTable,
      eq(appUsersTable.id, walletTopupRefundNotifyAttemptsTable.userId),
    )
    .leftJoin(
      organizationsTable,
      eq(organizationsTable.id, walletTopupRefundNotifyAttemptsTable.organizationId),
    )
    .where(walletWhere)
    // Order by the *exhaustion* timestamp (newest first) so a freshly
    // exhausted row floats to the top of the page even when it was
    // created days ago. `GREATEST` handles the channel that wasn't
    // exhausted via `NULLS FIRST` semantics by collapsing nulls into
    // a sentinel `-infinity`.
    .orderBy(sql`GREATEST(
      COALESCE(${walletTopupRefundNotifyAttemptsTable.emailRetryExhaustedAt}, '-infinity'::timestamptz),
      COALESCE(${walletTopupRefundNotifyAttemptsTable.pushRetryExhaustedAt}, '-infinity'::timestamptz)
    ) DESC`)
    .limit(limit);

  // Coach payout account-change rows ─────────────────────────────────
  const coachWhere = and(
    or(
      isNotNull(coachPayoutAccountChangeNotifyAttemptsTable.emailRetryExhaustedAt),
      isNotNull(coachPayoutAccountChangeNotifyAttemptsTable.pushRetryExhaustedAt),
    ),
    orgScope == null
      ? undefined
      : eq(coachPayoutAccountChangeNotifyAttemptsTable.organizationId, orgScope),
  );

  const coachRows = await db
    .select({
      attempt: coachPayoutAccountChangeNotifyAttemptsTable,
      proName: teachingProsTable.displayName,
      proEmail: teachingProsTable.email,
      orgName: organizationsTable.name,
    })
    .from(coachPayoutAccountChangeNotifyAttemptsTable)
    .leftJoin(
      teachingProsTable,
      eq(teachingProsTable.id, coachPayoutAccountChangeNotifyAttemptsTable.proId),
    )
    .leftJoin(
      organizationsTable,
      eq(
        organizationsTable.id,
        coachPayoutAccountChangeNotifyAttemptsTable.organizationId,
      ),
    )
    .where(coachWhere)
    .orderBy(sql`GREATEST(
      COALESCE(${coachPayoutAccountChangeNotifyAttemptsTable.emailRetryExhaustedAt}, '-infinity'::timestamptz),
      COALESCE(${coachPayoutAccountChangeNotifyAttemptsTable.pushRetryExhaustedAt}, '-infinity'::timestamptz)
    ) DESC`)
    .limit(limit);

  const wallet: AdminNotifyFailureRow[] = walletRows.map((r) => {
    const a = r.attempt;
    const memberName =
      [r.memberFirstName ?? "", r.memberLastName ?? ""].join(" ").trim()
      || (r.userDisplayName ?? r.userUsername ?? null);
    return {
      pipeline: "wallet_refund",
      attemptId: a.id,
      organizationId: a.organizationId,
      organizationName: r.orgName ?? null,
      channels: pickChannels(a),
      lastError: pickLastError(a),
      exhaustedAt: latestStamp(a).toISOString(),
      digestedAt: a.adminDigestSentAt?.toISOString() ?? null,
      walletRefund: {
        paymentId: a.paymentId,
        refundId: a.refundId,
        currency: a.currency,
        amount: String(a.amount),
        userId: a.userId,
        memberName: memberName || null,
        memberEmail: r.memberEmail ?? r.userEmail ?? null,
      },
    };
  });

  const coach: AdminNotifyFailureRow[] = coachRows.map(({ attempt, proName, proEmail, orgName }) => ({
    pipeline: "coach_payout_account_change",
    attemptId: attempt.id,
    organizationId: attempt.organizationId,
    organizationName: orgName ?? null,
    channels: pickChannels(attempt),
    lastError: pickLastError(attempt),
    exhaustedAt: latestStamp(attempt).toISOString(),
    digestedAt: attempt.adminDigestSentAt?.toISOString() ?? null,
    coachPayoutAccountChange: {
      historyId: attempt.historyId,
      proId: attempt.proId,
      coachUserId: attempt.coachUserId,
      coachName: proName ?? null,
      coachEmail: proEmail ?? null,
      changeKind: attempt.changeKind,
      method: attempt.method,
    },
  }));

  // Merge + sort newest-exhausted first, then cap to `limit` so a flood
  // in one pipeline can't push the other entirely off the page.
  return [...wallet, ...coach]
    .sort((a, b) => b.exhaustedAt.localeCompare(a.exhaustedAt))
    .slice(0, limit);
}

// ─── Resend action ─────────────────────────────────────────────────

export interface ResendAdminNotifyOpts {
  pipeline: AdminNotifyFailurePipeline;
  attemptId: number;
  organizationId: number | null;
}

export interface ChannelResendOutcome {
  channel: AdminNotifyFailureChannel;
  /** True iff the channel was exhausted before the action and has now been reset. */
  reset: boolean;
  /**
   * Outcome of the channel-specific retry helper, or `null` when the
   * helper short-circuited (e.g. provider unconfigured) — the caller
   * can surface `noopReason` to explain the empty result.
   */
  retryResult:
    | WalletTopupRefundNotifyRetryResult
    | CoachPayoutAccountChangeNotifyRetryResult
    | null;
  noopReason?: string;
}

export interface ResendAdminNotifyResult {
  pipeline: AdminNotifyFailurePipeline;
  attemptId: number;
  /** True iff the row was visible to the caller (tenant-scoped lookup hit). */
  ok: boolean;
  /** Per-channel outcomes for whichever channels were exhausted. */
  outcomes: ChannelResendOutcome[];
}

async function loadWalletAttempt(
  attemptId: number,
  organizationId: number | null,
): Promise<WalletTopupRefundNotifyAttempt | null> {
  const where = organizationId == null
    ? eq(walletTopupRefundNotifyAttemptsTable.id, attemptId)
    : and(
      eq(walletTopupRefundNotifyAttemptsTable.id, attemptId),
      eq(walletTopupRefundNotifyAttemptsTable.organizationId, organizationId),
    );
  const [row] = await db
    .select()
    .from(walletTopupRefundNotifyAttemptsTable)
    .where(where)
    .limit(1);
  return row ?? null;
}

async function loadCoachAttempt(
  attemptId: number,
  organizationId: number | null,
): Promise<CoachPayoutAccountChangeNotifyAttempt | null> {
  const where = organizationId == null
    ? eq(coachPayoutAccountChangeNotifyAttemptsTable.id, attemptId)
    : and(
      eq(coachPayoutAccountChangeNotifyAttemptsTable.id, attemptId),
      eq(
        coachPayoutAccountChangeNotifyAttemptsTable.organizationId,
        organizationId,
      ),
    );
  const [row] = await db
    .select()
    .from(coachPayoutAccountChangeNotifyAttemptsTable)
    .where(where)
    .limit(1);
  return row ?? null;
}

/**
 * Reset whichever email/push channels are currently exhausted on the
 * given attempt row, then immediately fire a single retry on each
 * via the channel-specific helpers. Channels that were not exhausted
 * are left untouched so a half-recovered row (e.g. push delivered but
 * email still stuck) doesn't get its working channel reset.
 *
 * Returns `ok: false` with an empty `outcomes` array when the row is
 * not visible to the caller (org-scope filtered it out, or the id is
 * unknown) so the caller can surface a 404 without leaking existence
 * information across tenant boundaries.
 */
export async function resendExhaustedAdminNotifyRow(
  opts: ResendAdminNotifyOpts,
): Promise<ResendAdminNotifyResult> {
  if (opts.pipeline === "wallet_refund") {
    const existing = await loadWalletAttempt(opts.attemptId, opts.organizationId);
    if (!existing) {
      return { pipeline: opts.pipeline, attemptId: opts.attemptId, ok: false, outcomes: [] };
    }

    const outcomes: ChannelResendOutcome[] = [];

    if (existing.emailRetryExhaustedAt) {
      await db
        .update(walletTopupRefundNotifyAttemptsTable)
        .set({
          emailStatus: "failed",
          emailAttempts: 0,
          emailRetryExhaustedAt: null,
          lastEmailError: null,
          nextEmailRetryAt: null,
        })
        .where(eq(walletTopupRefundNotifyAttemptsTable.id, existing.id));
      const reset = await loadWalletAttempt(existing.id, opts.organizationId);
      const retryResult = reset
        ? await retryWalletTopupRefundEmail({
            attempt: reset,
            logContext: {
              route: "admin.notify-failures.resend",
              attemptId: existing.id,
              pipeline: opts.pipeline,
              channel: "email",
            },
          })
        : null;
      outcomes.push({
        channel: "email",
        reset: true,
        retryResult,
        noopReason: retryResult ? undefined : "channel_helper_declined",
      });
    }

    if (existing.pushRetryExhaustedAt) {
      await db
        .update(walletTopupRefundNotifyAttemptsTable)
        .set({
          pushStatus: "failed",
          pushAttempts: 0,
          pushRetryExhaustedAt: null,
          lastPushError: null,
          nextPushRetryAt: null,
        })
        .where(eq(walletTopupRefundNotifyAttemptsTable.id, existing.id));
      const reset = await loadWalletAttempt(existing.id, opts.organizationId);
      const retryResult = reset
        ? await retryWalletTopupRefundPush({
            attempt: reset,
            logContext: {
              route: "admin.notify-failures.resend",
              attemptId: existing.id,
              pipeline: opts.pipeline,
              channel: "push",
            },
          })
        : null;
      outcomes.push({
        channel: "push",
        reset: true,
        retryResult,
        noopReason: retryResult ? undefined : "channel_helper_declined",
      });
    }

    return { pipeline: opts.pipeline, attemptId: opts.attemptId, ok: true, outcomes };
  }

  // coach_payout_account_change
  const existing = await loadCoachAttempt(opts.attemptId, opts.organizationId);
  if (!existing) {
    return { pipeline: opts.pipeline, attemptId: opts.attemptId, ok: false, outcomes: [] };
  }

  const outcomes: ChannelResendOutcome[] = [];

  if (existing.emailRetryExhaustedAt) {
    await db
      .update(coachPayoutAccountChangeNotifyAttemptsTable)
      .set({
        emailStatus: "failed",
        emailAttempts: 0,
        emailRetryExhaustedAt: null,
        lastEmailError: null,
        nextEmailRetryAt: null,
      })
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.id, existing.id));
    const reset = await loadCoachAttempt(existing.id, opts.organizationId);
    const retryResult = reset
      ? await retryCoachPayoutAccountChangeEmail({
          attempt: reset,
          logContext: {
            route: "admin.notify-failures.resend",
            attemptId: existing.id,
            pipeline: opts.pipeline,
            channel: "email",
          },
        })
      : null;
    outcomes.push({
      channel: "email",
      reset: true,
      retryResult,
      noopReason: retryResult ? undefined : "channel_helper_declined",
    });
  }

  if (existing.pushRetryExhaustedAt) {
    await db
      .update(coachPayoutAccountChangeNotifyAttemptsTable)
      .set({
        pushStatus: "failed",
        pushAttempts: 0,
        pushRetryExhaustedAt: null,
        lastPushError: null,
        nextPushRetryAt: null,
      })
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.id, existing.id));
    const reset = await loadCoachAttempt(existing.id, opts.organizationId);
    const retryResult = reset
      ? await retryCoachPayoutAccountChangePush({
          attempt: reset,
          logContext: {
            route: "admin.notify-failures.resend",
            attemptId: existing.id,
            pipeline: opts.pipeline,
            channel: "push",
          },
        })
      : null;
    outcomes.push({
      channel: "push",
      reset: true,
      retryResult,
      noopReason: retryResult ? undefined : "channel_helper_declined",
    });
  }

  return { pipeline: opts.pipeline, attemptId: opts.attemptId, ok: true, outcomes };
}
