/**
 * Manual-entry round notification (Task #870).
 *
 * Fired the moment a tournament round transitions to `countersigned` (i.e.
 * the round is officially closed). When more than half of the captured
 * shots for that player + round have `source = 'manual'`, the round's
 * data is mostly hand-keyed and therefore less trustworthy for SG /
 * dispersion analytics — exactly the rounds the amber data-quality
 * banner on the Players tab surfaces.
 *
 * Without this notification a TD only catches a hand-keyed round if they
 * happen to open the Players tab. Pushing it the moment the round closes
 * means TDs catch unreliable data even if they never look.
 *
 * Recipients:
 *   - Tournament directors / org admins / committee members for the
 *     tournament's organization (every appUser with one of those roles
 *     in `org_memberships` for the tournament's org).
 *
 * Channels (per recipient, best-effort, isolated):
 *   - Push (sendPushToUsers) — honours `userNotificationPrefsTable.preferPush`.
 *   - Email (sendManualEntryAlertEmail) — honours
 *     `userNotificationPrefsTable.preferEmail`.
 *
 * Push payload deep-links straight to the tournament's Players tab:
 *   data.type           = "manual_entry_round_flagged"
 *   data.tournamentId   = number
 *   data.organizationId = number
 *   data.playerId       = number
 *   data.round          = number
 *   data.manualPct      = number  (one decimal, e.g. 73.4)
 *   data.submissionId   = number
 *
 * Fire-and-forget: every channel is best-effort and isolated. Failures
 * are logged but never thrown — the underlying countersign has already
 * succeeded.
 */
import { db } from "@workspace/db";
import {
  roundSubmissionsTable,
  tournamentsTable,
  organizationsTable,
  playersTable,
  shotsTable,
  orgMembershipsTable,
  userNotificationPrefsTable,
  appUsersTable,
  manualEntryAlertsTable,
  manualEntryAlertRecipientsTable,
  manualEntryNotifySkipsTable,
  type ManualEntryAlertRecipient,
} from "@workspace/db";
import { and, eq, inArray, isNull, count } from "drizzle-orm";
import { sendPushToUsers } from "./push";
import { sendManualEntryAlertEmail, classifyMailerError, type EmailBranding } from "./mailer";
import { logger } from "./logger";

/**
 * Canonical per-recipient delivery status persisted to
 * `manual_entry_alert_recipients` (Task #1386). Mirrors the channel-level
 * outcomes the notify path can produce for a single (user, channel) pair.
 */
export type ManualEntryRecipientStatus =
  | "sent"
  | "failed"
  | "no_address"
  | "no_email"
  | "opted_out"
  // Task #1849 — `skipped` covers the env-level provider-misconfig
  // case (`classifyMailerError() === "provider_unconfigured"`). It is
  // distinct from `failed` so the per-recipient failure count in
  // director-facing dashboards isn't inflated by an env bug.
  | "skipped";

interface RecipientAttempt {
  userId: number;
  channel: "push" | "email";
  status: ManualEntryRecipientStatus;
  errorMessage: string | null;
  // Task #1847 — email-only fields. `emailRecipient` snapshots the
  // address we tried so the retry helper can re-render the same
  // payload, and `hardBounce` lets `persistAudit` jump straight to
  // `emailRetryExhaustedAt` (Task #1279) on the very first send.
  emailRecipient?: string | null;
  hardBounce?: boolean;
}

const MANUAL_THRESHOLD = 0.5; // >50% manual triggers the alert

// Task #1847 — per-recipient email retry budget for the manual-entry
// round alert. Cap = 5 deliveries (initial + 4 retries) so transient
// SMTP blips don't drop the TD's heads-up that a round is mostly
// hand-keyed; a hard SMTP bounce (Task #1279) jumps straight to
// exhausted instead of consuming the remaining budget.
export const MANUAL_ENTRY_MAX_EMAIL_ATTEMPTS = 5;
const MANUAL_ENTRY_EMAIL_BACKOFF_BASE_MS = 5 * 60 * 1000;
const MANUAL_ENTRY_EMAIL_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export function computeManualEntryNextEmailRetryAt(completedAttempts: number, from: Date = new Date()): Date {
  const exp = Math.max(0, completedAttempts - 1);
  const delay = Math.min(
    MANUAL_ENTRY_EMAIL_BACKOFF_BASE_MS * Math.pow(2, exp),
    MANUAL_ENTRY_EMAIL_BACKOFF_MAX_MS,
  );
  return new Date(from.getTime() + delay);
}

// Roles that should be alerted — mirrors the TD/committee fan-outs already
// used elsewhere (cron overdue escalations, round-robin tie-break notify).
const DIRECTOR_ROLES = ["org_admin", "tournament_director", "committee_member", "competition_secretary"] as const;

export type ManualEntryNotifyStatus = "sent" | "skipped" | "failed";

export interface ManualEntryNotifyResult {
  status: ManualEntryNotifyStatus;
  reason?: string;
  manualPct?: number;
  totalShots?: number;
  recipients?: number[];
  push?: { attempted: number; sent: number };
  email?: { attempted: number; sent: number };
}

/**
 * Every exit-point reason returned from `notifyManualEntryRound`. Listed
 * explicitly (rather than left as a free-form string) so dashboards and
 * log searches that bucket by `reason` can be kept in sync when a new
 * branch is added — e.g. Task #1188 added `org_muted` for the org-wide
 * mute switch, and missing it from this list was how the support team
 * lost visibility into "why didn't this round trigger an alert?".
 *
 * Keep this list aligned with the `result.reason = "..."` assignments
 * in `runNotify` below. The `[manual-entry-notify] result` log line at
 * the end of `notifyManualEntryRound` emits this value as a structured
 * field so it can be aggregated downstream, AND every value (other than
 * `submission_not_found`, see `persistAudit`) is also persisted to the
 * `manual_entry_alerts.reason` column (Task #1658) so support can answer
 * "why didn't this round trigger an alert?" against a durable record.
 */
export const MANUAL_ENTRY_NOTIFY_REASONS = [
  "submission_not_found",
  "no_shots_captured",
  "below_threshold",
  "tournament_not_found",
  "tournament_muted",
  "org_lookup_failed",
  "org_muted",
  "no_recipients",
  "all_recipients_opted_out",
] as const;
export type ManualEntryNotifyReason = (typeof MANUAL_ENTRY_NOTIFY_REASONS)[number];

/**
 * Mutable accumulator that tracks every field the audit row needs as the
 * notify pipeline progresses. We carry this through `runNotify` instead of
 * recomputing the values at the persistence step so each early-return
 * branch can hand off whatever it has resolved so far (e.g. `tournament_muted`
 * already knows the tournament; `no_shots_captured` knows nothing beyond the
 * submission). The corresponding `persistAudit` helper converts whatever
 * fields are populated into a single insert that records the outcome.
 */
interface AuditAccumulator {
  tournamentId?: number;
  // Task #1847 — captured once we resolve the tournament so the
  // admin exhaustion-alert helper can fan-out to org admins without
  // a second tournament lookup. Optional because the early-return
  // branches (tournament_not_found / submission_not_found) reach
  // `persistAudit` without ever resolving an org.
  organizationId?: number;
  playerId: number;
  round: number;
  manualPct?: number;
  manualShots?: number;
  totalShots?: number;
  recipientCount: number;
  pushAttempted: number;
  pushSent: number;
  emailAttempted: number;
  emailSent: number;
  attempts: RecipientAttempt[];
}

/**
 * Inspect the just-closed round, and if its captured shots are mostly
 * manual entries, alert the tournament's TDs.
 *
 * Safe to call after every countersign — the threshold check gates the
 * fan-out, so rounds with healthy data quality are silently ignored.
 *
 * Always emits a structured `[manual-entry-notify] result` log line
 * carrying `status` and (when skipped/failed) `reason`, so the support
 * team can answer "why didn't this round trigger an alert?" without
 * having to replay the countersign. See `MANUAL_ENTRY_NOTIFY_REASONS`
 * for the canonical list of reason values.
 */
export async function notifyManualEntryRound(submissionId: number): Promise<ManualEntryNotifyResult> {
  const result = await runNotify(submissionId);
  // Single structured log line per call, regardless of outcome. This is the
  // observability hook the support team and the (future) skip-reason
  // dashboards key off — every reason value (including `org_muted`) flows
  // through here, so nothing gets silently bucketed as "other".
  logger.info(
    {
      submissionId,
      status: result.status,
      reason: result.reason,
      manualPct: result.manualPct,
      totalShots: result.totalShots,
      recipientCount: result.recipients?.length,
      pushAttempted: result.push?.attempted,
      pushSent: result.push?.sent,
      emailAttempted: result.email?.attempted,
      emailSent: result.email?.sent,
    },
    "[manual-entry-notify] result",
  );
  // Task #1657 — persist a row per non-delivery so the super-admin
  // dashboard can render a "why did rounds get skipped?" breakdown
  // chart for the 7d / 30d windows. Successful fan-outs land in
  // `manual_entry_alerts` already; together the two tables describe
  // the full population of notify calls. Best-effort: a write failure
  // here must not mask the underlying alert outcome the caller relies
  // on (the structured log line above remains the source of truth).
  if ((result.status === "skipped" || result.status === "failed") && result.reason) {
    try {
      await db.insert(manualEntryNotifySkipsTable).values({
        submissionId,
        status: result.status,
        reason: result.reason,
      });
    } catch (err) {
      logger.warn(
        { submissionId, status: result.status, reason: result.reason, err },
        "[manual-entry-notify] failed to persist skip event",
      );
    }
  }
  return result;
}

/**
 * Persist a single `manual_entry_alerts` row for the just-completed
 * notify call (Task #1019; widened to all skip paths in Task #1658).
 *
 * Every status — 'sent', 'skipped', 'failed' — gets a row except for
 * `submission_not_found`, where the FK to `round_submissions` cannot be
 * satisfied (the submission row doesn't exist by definition). Per-recipient
 * attempt rows are only persisted when at least one delivery was
 * attempted; skip paths short-circuit before any attempt is made and so
 * have no recipient rows to write.
 *
 * Best-effort: a write failure here MUST NOT mask the underlying notify
 * outcome the caller relies on, so we catch and warn-log.
 */
async function persistAudit(
  submissionId: number,
  audit: AuditAccumulator,
  result: ManualEntryNotifyResult,
): Promise<void> {
  // The only branch that genuinely cannot be persisted: there is no
  // round_submissions row to satisfy the FK against. The structured
  // log line above is the durable record for this rare path.
  if (result.reason === "submission_not_found") return;

  try {
    const [alert] = await db.insert(manualEntryAlertsTable).values({
      submissionId,
      tournamentId: audit.tournamentId ?? 0,
      playerId: audit.playerId,
      round: audit.round,
      manualPct: (audit.manualPct ?? 0).toFixed(2),
      manualShots: audit.manualShots ?? 0,
      totalShots: audit.totalShots ?? 0,
      recipientCount: audit.recipientCount,
      pushAttempted: audit.pushAttempted,
      pushSent: audit.pushSent,
      emailAttempted: audit.emailAttempted,
      emailSent: audit.emailSent,
      status: result.status,
      // Per the column comment: NULL when the alert was actually sent so
      // dashboards can WHERE reason IS NOT NULL to surface skip rows
      // without having to also exclude status='sent'.
      reason: result.status === "sent" ? null : (result.reason ?? null),
    }).returning({ id: manualEntryAlertsTable.id });
    if (alert && audit.attempts.length > 0) {
      try {
        const now = new Date();
        // Task #1847 — capture the inserted ids so we can fire admin
        // exhaustion alerts for any rows that hit a hard SMTP bounce
        // on the very first send (Task #1279). Returning each row's
        // id lets `notifyAdminsOfManualEntryEmailExhaustion` re-load
        // the freshly-stamped record without a follow-up search.
        const inserted = await db.insert(manualEntryAlertRecipientsTable).values(
          audit.attempts.map(a => {
            const isEmail = a.channel === "email";
            const isFailed = isEmail && a.status === "failed";
            const exhaustedNow = isFailed && a.hardBounce === true;
            const persistedAttempts = isEmail
              ? (exhaustedNow
                  ? MANUAL_ENTRY_MAX_EMAIL_ATTEMPTS
                  : (a.status === "sent" || isFailed ? 1 : 0))
              : 0;
            const nextRetry = isFailed && !exhaustedNow
              ? computeManualEntryNextEmailRetryAt(1, now)
              : null;
            return {
              alertId: alert.id,
              userId: a.userId,
              channel: a.channel,
              status: a.status,
              errorMessage: a.errorMessage,
              emailAttempts: persistedAttempts,
              lastEmailAt: isEmail && (a.status === "sent" || isFailed) ? now : null,
              lastEmailError: isEmail ? a.errorMessage : null,
              nextEmailRetryAt: nextRetry,
              emailRetryExhaustedAt: exhaustedNow ? now : null,
              emailRecipient: isEmail ? (a.emailRecipient ?? null) : null,
            };
          }),
        ).returning({
          id: manualEntryAlertRecipientsTable.id,
          channel: manualEntryAlertRecipientsTable.channel,
          status: manualEntryAlertRecipientsTable.status,
          emailRetryExhaustedAt: manualEntryAlertRecipientsTable.emailRetryExhaustedAt,
        });

        // Fire admin alerts for rows we just stamped exhausted on the
        // first send (hard bounce). Best-effort: a failure here never
        // masks the underlying notify outcome.
        const exhaustedRows = inserted.filter(r =>
          r.channel === "email" && r.status === "failed" && r.emailRetryExhaustedAt != null,
        );
        for (const row of exhaustedRows) {
          try {
            const [stamped] = await db.select()
              .from(manualEntryAlertRecipientsTable)
              .where(eq(manualEntryAlertRecipientsTable.id, row.id))
              .limit(1);
            if (stamped && audit.organizationId != null) {
              await notifyAdminsOfManualEntryEmailExhaustion({
                recipient: stamped,
                alertId: alert.id,
                organizationId: audit.organizationId,
                reason: "hard_bounce",
                logContext: { submissionId, alertId: alert.id },
              });
            }
          } catch (err) {
            logger.warn(
              { submissionId, alertId: alert.id, recipientRowId: row.id, err },
              "[manual-entry-notify] admin email exhaustion alert (initial hard bounce) failed",
            );
          }
        }
      } catch (err) {
        logger.warn({ submissionId, alertId: alert.id, err }, "[manual-entry-notify] failed to persist recipient rows");
      }
    }
  } catch (err) {
    logger.warn(
      { submissionId, status: result.status, reason: result.reason, err },
      "[manual-entry-notify] failed to persist audit row",
    );
  }
}

async function runNotify(submissionId: number): Promise<ManualEntryNotifyResult> {
  const result: ManualEntryNotifyResult = { status: "skipped" };

  let submission: typeof roundSubmissionsTable.$inferSelect | undefined;
  try {
    const [row] = await db.select().from(roundSubmissionsTable)
      .where(eq(roundSubmissionsTable.id, submissionId)).limit(1);
    submission = row;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ submissionId, errMsg: reason }, "[manual-entry-notify] failed to load submission");
    result.status = "failed";
    result.reason = reason;
    // No submission lookup means we cannot resolve a tournament/player/round
    // to satisfy the audit-row FKs; treat this like submission_not_found.
    return result;
  }
  if (!submission) {
    result.reason = "submission_not_found";
    return result;
  }

  // Once we have the submission row, every subsequent return — success
  // or skip — must persist an audit row. The accumulator carries
  // whatever fields each branch has resolved at the time it bails.
  const audit: AuditAccumulator = {
    playerId: submission.playerId,
    round: submission.round,
    tournamentId: submission.tournamentId,
    recipientCount: 0,
    pushAttempted: 0,
    pushSent: 0,
    emailAttempted: 0,
    emailSent: 0,
    attempts: [],
  };

  // Tally shots by source for this player+round.
  let manualShots = 0;
  let totalShots = 0;
  try {
    const rows = await db
      .select({ source: shotsTable.source, n: count(shotsTable.id) })
      .from(shotsTable)
      .where(and(
        eq(shotsTable.playerId, submission.playerId),
        eq(shotsTable.round, submission.round),
      ))
      .groupBy(shotsTable.source);
    for (const r of rows) {
      const n = Number(r.n);
      totalShots += n;
      // Untagged shots are treated as manual to match the data-quality endpoint.
      if ((r.source ?? "manual") === "manual") manualShots += n;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ submissionId, errMsg: reason }, "[manual-entry-notify] failed to tally shots");
    result.status = "failed";
    result.reason = reason;
    await persistAudit(submissionId, audit, result);
    return result;
  }

  result.totalShots = totalShots;
  audit.totalShots = totalShots;
  audit.manualShots = manualShots;
  if (totalShots === 0) {
    result.reason = "no_shots_captured";
    audit.manualPct = 0;
    await persistAudit(submissionId, audit, result);
    return result;
  }
  const manualPct = manualShots / totalShots;
  result.manualPct = Math.round(manualPct * 1000) / 10;
  audit.manualPct = result.manualPct;
  if (manualPct <= MANUAL_THRESHOLD) {
    result.reason = "below_threshold";
    await persistAudit(submissionId, audit, result);
    return result;
  }

  // Resolve tournament + player + org branding.
  let tournament: { id: number; name: string | null; organizationId: number; notifyManualEntryAlerts: boolean } | undefined;
  let playerName = `Player #${submission.playerId}`;
  let branding: EmailBranding = { orgName: "KHARAGOLF" };
  try {
    const [t] = await db.select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      organizationId: tournamentsTable.organizationId,
      notifyManualEntryAlerts: tournamentsTable.notifyManualEntryAlerts,
    }).from(tournamentsTable).where(eq(tournamentsTable.id, submission.tournamentId)).limit(1);
    tournament = t;
  } catch (err) {
    logger.warn({ submissionId, err }, "[manual-entry-notify] failed to load tournament");
  }
  if (!tournament) {
    result.reason = "tournament_not_found";
    await persistAudit(submissionId, audit, result);
    return result;
  }
  // Task #1847 — capture the org id now that we have it so the
  // admin email-exhaustion alert helper called from `persistAudit`
  // can fan-out to org admins without a second tournament lookup.
  audit.organizationId = tournament.organizationId;
  // Task #1018 — TDs can mute the alert per tournament for noisy social
  // leagues without affecting their other notifications.
  if (!tournament.notifyManualEntryAlerts) {
    result.reason = "tournament_muted";
    await persistAudit(submissionId, audit, result);
    return result;
  }

  // Load org branding + the org-wide manual-entry mute switch in one query.
  // Task #1188 — when an org admin has muted the alert at the club level,
  // every tournament in the org is silent regardless of its per-tournament
  // toggle. This lets clubs running hundreds of casual social events flip
  // the alert off once instead of per event.
  //
  // NB: this read is intentionally **fail-closed** for the mute flag —
  // if the org row can't be loaded, we cannot prove the alert is allowed
  // and so we suppress it (status=failed, reason=org_lookup_failed)
  // rather than risk waking up tournament directors at clubs that have
  // explicitly muted the alert. The branding fallback inside the same
  // result is cosmetic (used for the email template) and is allowed to
  // fail-open to the default KHARAGOLF branding when the row is present
  // but the columns are null.
  let orgRow:
    | { name: string | null; logoUrl: string | null; primaryColor: string | null; notifyManualEntryAlerts: boolean }
    | undefined;
  try {
    const rows = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
      notifyManualEntryAlerts: organizationsTable.notifyManualEntryAlerts,
    }).from(organizationsTable).where(eq(organizationsTable.id, tournament.organizationId)).limit(1);
    orgRow = rows[0];
  } catch (err) {
    logger.error({ submissionId, err }, "[manual-entry-notify] failed to load org row — failing closed");
  }
  if (!orgRow) {
    result.status = "failed";
    result.reason = "org_lookup_failed";
    await persistAudit(submissionId, audit, result);
    return result;
  }
  branding = {
    orgName: orgRow.name ?? "KHARAGOLF",
    logoUrl: orgRow.logoUrl ?? undefined,
    primaryColor: orgRow.primaryColor ?? undefined,
  };
  if (!orgRow.notifyManualEntryAlerts) {
    result.reason = "org_muted";
    await persistAudit(submissionId, audit, result);
    return result;
  }

  try {
    const [p] = await db.select({
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
    }).from(playersTable).where(eq(playersTable.id, submission.playerId)).limit(1);
    if (p) {
      const composed = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim();
      if (composed) playerName = composed;
    }
  } catch (err) {
    logger.warn({ submissionId, err }, "[manual-entry-notify] failed to load player name");
  }

  // Resolve recipients (directors/admins/committee for the tournament's org).
  let recipientIds: number[] = [];
  try {
    const directors = await db
      .select({ userId: orgMembershipsTable.userId })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, tournament.organizationId),
        inArray(orgMembershipsTable.role, [...DIRECTOR_ROLES]),
      ));
    const seen = new Set<number>();
    for (const d of directors) {
      if (d.userId != null && !seen.has(d.userId)) {
        seen.add(d.userId);
        recipientIds.push(d.userId);
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ submissionId, errMsg: reason }, "[manual-entry-notify] failed to load directors");
    result.status = "failed";
    result.reason = reason;
    await persistAudit(submissionId, audit, result);
    return result;
  }
  result.recipients = recipientIds;
  if (recipientIds.length === 0) {
    result.reason = "no_recipients";
    await persistAudit(submissionId, audit, result);
    return result;
  }

  // Per-recipient channel preferences (and Task #1018 per-user opt-out
  // for the manual-entry alert specifically).
  let prefById = new Map<number, { preferPush: boolean | null; preferEmail: boolean | null; notifyManualEntryAlerts: boolean | null }>();
  try {
    const prefs = await db.select({
      userId: userNotificationPrefsTable.userId,
      preferPush: userNotificationPrefsTable.preferPush,
      preferEmail: userNotificationPrefsTable.preferEmail,
      notifyManualEntryAlerts: userNotificationPrefsTable.notifyManualEntryAlerts,
    }).from(userNotificationPrefsTable)
      .where(inArray(userNotificationPrefsTable.userId, recipientIds));
    prefById = new Map(prefs.map(p => [p.userId, { preferPush: p.preferPush, preferEmail: p.preferEmail, notifyManualEntryAlerts: p.notifyManualEntryAlerts }]));
  } catch (err) {
    logger.warn({ submissionId, err }, "[manual-entry-notify] failed to read prefs; defaulting to opted-in");
  }

  // Drop recipients who turned off the manual-entry alert in their personal
  // notification prefs — they keep receiving every other notification type.
  const optedInRecipients = recipientIds.filter(id => prefById.get(id)?.notifyManualEntryAlerts !== false);
  if (optedInRecipients.length === 0) {
    result.reason = "all_recipients_opted_out";
    await persistAudit(submissionId, audit, result);
    return result;
  }
  recipientIds = optedInRecipients;
  result.recipients = recipientIds;
  audit.recipientCount = recipientIds.length;

  const pctDisplay = result.manualPct.toFixed(1);
  const tName = tournament.name?.trim() || "tournament";
  const title = "⚠️ Manual-entry round flagged";
  const body = `${playerName}'s round ${submission.round} in ${tName} is ${pctDisplay}% hand-entered (${manualShots}/${totalShots} shots). Open the Players tab to review.`;

  // Per-recipient/channel attempts. The aggregate counts populated below
  // are derived from these so the audit table and the summary stay in
  // lockstep — a single source of truth, not two parallel tallies.
  const attempts: RecipientAttempt[] = [];

  // ── PUSH ──────────────────────────────────────────────────────────
  // We deliberately call sendPushToUsers per user so the per-recipient
  // outcome is accurate (the bulk variant only returns aggregate counts,
  // making it impossible to attribute a failure back to a specific
  // device-token owner — which is exactly what Task #1386 needs).
  let pushAttempted = 0, pushSent = 0;
  for (const userId of recipientIds) {
    if (prefById.get(userId)?.preferPush === false) {
      attempts.push({ userId, channel: "push", status: "opted_out", errorMessage: null });
      continue;
    }
    pushAttempted += 1;
    try {
      const push = await sendPushToUsers([userId], title, body, {
        type: "manual_entry_round_flagged",
        submissionId,
        tournamentId: tournament.id,
        organizationId: tournament.organizationId,
        playerId: submission.playerId,
        round: submission.round,
        manualPct: result.manualPct,
      });
      // Map the single-user aggregate back onto our canonical statuses.
      // attempted=0 here means the user had no device tokens at all
      // (sendPushToUsers short-circuits on `rows.length === 0`); the
      // non-Expo / invalid token case yields invalid > 0 and sent === 0
      // — both surface as "no_address" so ops know there's no device to
      // chase rather than treating a missing token as a transport bug.
      let status: ManualEntryRecipientStatus;
      if (push.sent > 0) {
        pushSent += 1;
        status = "sent";
      } else if (push.failed > 0) {
        status = "failed";
      } else {
        status = "no_address";
      }
      attempts.push({ userId, channel: "push", status, errorMessage: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ submissionId, userId, errMsg: msg }, "[manual-entry-notify] push delivery failed");
      attempts.push({ userId, channel: "push", status: "failed", errorMessage: msg });
    }
  }
  result.push = { attempted: pushAttempted, sent: pushSent };
  audit.pushAttempted = pushAttempted;
  audit.pushSent = pushSent;

  // ── EMAIL ─────────────────────────────────────────────────────────
  let emailAttempted = 0, emailSent = 0;
  const emailTargets = recipientIds.filter(id => prefById.get(id)?.preferEmail !== false);
  // Record opted-out users up-front so the audit table reflects every
  // recipient considered (not just the ones we tried to email).
  for (const userId of recipientIds) {
    if (prefById.get(userId)?.preferEmail === false) {
      attempts.push({ userId, channel: "email", status: "opted_out", errorMessage: null });
    }
  }
  let emailRecipients: Array<{ id: number; email: string | null; displayName: string | null; username: string | null }> = [];
  if (emailTargets.length > 0) {
    try {
      emailRecipients = await db.select({
        id: appUsersTable.id,
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      }).from(appUsersTable).where(inArray(appUsersTable.id, emailTargets));
    } catch (err) {
      logger.warn({ submissionId, err }, "[manual-entry-notify] failed to load recipient emails");
    }
  }
  const emailRecipientById = new Map(emailRecipients.map(r => [r.id, r]));
  const deepLink = `https://app.kharagolf.com/tournaments/${tournament.id}#players`;
  for (const userId of emailTargets) {
    const r = emailRecipientById.get(userId);
    if (!r || !r.email) {
      // Either the user row vanished mid-flight (extremely unlikely; we
      // just resolved it via org_memberships) or the user has no email
      // address on file. Either way there is no inbox to deliver to.
      attempts.push({ userId, channel: "email", status: "no_email", errorMessage: null, emailRecipient: null });
      continue;
    }
    emailAttempted += 1;
    try {
      await sendManualEntryAlertEmail({
        to: r.email,
        recipientName: (r.displayName ?? r.username ?? "").trim(),
        tournamentName: tName,
        playerName,
        round: submission.round,
        manualPct: result.manualPct,
        manualShots,
        totalShots,
        reviewUrl: deepLink,
        branding,
      });
      emailSent += 1;
      attempts.push({ userId, channel: "email", status: "sent", errorMessage: null, emailRecipient: r.email });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errClass = classifyMailerError(err);
      // Provider misconfiguration is an env issue, not a delivery
      // failure. Task #1849 widened the recipients status check
      // constraint so we can record this as terminal `skipped` (with
      // no marker error string) instead of inflating the per-recipient
      // failure count with a stand-in `failed` row. We also suppress
      // the per-recipient warn-level log to stop billing the admin's
      // log dashboard for what is fundamentally a deploy-config gap.
      // Task #1847 — still persist `emailRecipient` so the retry-budget
      // bookkeeping in `persistAudit` records WHO the skipped attempt
      // was bound for (matches the levy-receipt / wallet-withdrawal
      // precedent and lets admin alert screens render the recipient).
      if (errClass === "provider_unconfigured") {
        attempts.push({ userId, channel: "email", status: "skipped", errorMessage: null, emailRecipient: r.email });
      } else {
        logger.warn({ submissionId, userId, errMsg: msg, errClass }, "[manual-entry-notify] email delivery failed");
        attempts.push({
          userId,
          channel: "email",
          status: "failed",
          errorMessage: msg,
          emailRecipient: r.email,
          // Task #1279 — flag hard SMTP bounces so `persistAudit` can
          // jump the row straight to exhausted on the very first send.
          hardBounce: errClass === "hard_bounce",
        });
      }
    }
  }
  result.email = { attempted: emailAttempted, sent: emailSent };
  audit.emailAttempted = emailAttempted;
  audit.emailSent = emailSent;
  audit.attempts = attempts;

  if (pushSent > 0 || emailSent > 0) result.status = "sent";
  else if (pushAttempted === 0 && emailAttempted === 0) result.status = "skipped";
  else result.status = "failed";

  // Task #1019 — persist the audit row so the Players-tab data-quality table
  // can show "alerted at HH:MM" per (player, round) and ops can debug missed
  // deliveries. Task #1386 also persists one row per (alert, recipient,
  // channel) attempt so the super-admin drill-down can list which TDs
  // specifically got nothing on a silent alert. Task #1658 widened this to
  // every skip-path branch above (each of which now calls `persistAudit`
  // before returning), so a single helper writes both the success path
  // here and every skip path with the same code.
  await persistAudit(submissionId, audit, result);
  return result;
}

/**
 * Task #1847 — Re-attempt a previously failed manual-entry email
 * delivery for a single recipient row. Looks up the recipient's
 * current email address (so a TD who fixes their on-file address
 * between attempts gets through), re-renders the alert payload from
 * the parent `manual_entry_alerts` row, fires the mail, and updates
 * the recipient row with the new status / attempt count / next
 * retry-at.
 *
 * Returns `null` when the row is no longer eligible (channel != email,
 * status != failed, cap reached, or backoff window not yet elapsed).
 * Provider-not-configured errors flip the row to terminal `skipped`
 * so the cron stops re-selecting it. Hard SMTP bounces (Task #1279)
 * jump straight to exhausted and page org admins via
 * `notifyAdminsOfManualEntryEmailExhaustion`.
 */
export async function retryManualEntryEmail(opts: {
  recipient: ManualEntryAlertRecipient;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<{ status: ManualEntryRecipientStatus | "skipped"; attempts: number; exhausted: boolean; error?: string } | null> {
  const { recipient, logContext } = opts;
  const now = opts.now ?? new Date();
  if (recipient.channel !== "email") return null;
  if (recipient.status !== "failed") return null;
  const currentAttempts = recipient.emailAttempts ?? 0;
  if (currentAttempts >= MANUAL_ENTRY_MAX_EMAIL_ATTEMPTS) return null;
  if (recipient.nextEmailRetryAt && recipient.nextEmailRetryAt.getTime() > now.getTime()) return null;

  // Re-load the parent alert + tournament + player + org so we can
  // re-render the email body. If any of these are gone (cascade
  // delete on tournament removal, etc), there is nothing meaningful
  // to retry — flip to terminal skipped so the cron stops trying.
  const [alert] = await db.select()
    .from(manualEntryAlertsTable)
    .where(eq(manualEntryAlertsTable.id, recipient.alertId))
    .limit(1);
  if (!alert) {
    await db.update(manualEntryAlertRecipientsTable).set({
      status: "skipped",
      lastEmailAt: now,
      lastEmailError: "alert_row_missing",
      lastEmailRetryAt: now,
      nextEmailRetryAt: null,
    }).where(eq(manualEntryAlertRecipientsTable.id, recipient.id));
    return { status: "skipped", attempts: currentAttempts, exhausted: false, error: "alert_row_missing" };
  }

  const [tournament] = await db.select({
    id: tournamentsTable.id,
    name: tournamentsTable.name,
    organizationId: tournamentsTable.organizationId,
  }).from(tournamentsTable).where(eq(tournamentsTable.id, alert.tournamentId)).limit(1);
  if (!tournament) {
    await db.update(manualEntryAlertRecipientsTable).set({
      status: "skipped",
      lastEmailAt: now,
      lastEmailError: "tournament_missing",
      lastEmailRetryAt: now,
      nextEmailRetryAt: null,
    }).where(eq(manualEntryAlertRecipientsTable.id, recipient.id));
    return { status: "skipped", attempts: currentAttempts, exhausted: false, error: "tournament_missing" };
  }

  let branding: EmailBranding = { orgName: "KHARAGOLF" };
  try {
    const [org] = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    }).from(organizationsTable).where(eq(organizationsTable.id, tournament.organizationId)).limit(1);
    if (org) {
      branding = {
        orgName: org.name ?? "KHARAGOLF",
        logoUrl: org.logoUrl ?? undefined,
        primaryColor: org.primaryColor ?? undefined,
        // Task #1319 — propagate the org id so the Postmark bounce
        // webhook (Task #981) attributes any hard bounce back to
        // this club.
        orgId: tournament.organizationId,
      };
    }
  } catch {
    // best-effort; fall back to default branding
  }

  let playerName = `Player #${alert.playerId}`;
  try {
    const [p] = await db.select({
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
    }).from(playersTable).where(eq(playersTable.id, alert.playerId)).limit(1);
    if (p) {
      const composed = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim();
      if (composed) playerName = composed;
    }
  } catch {
    // best-effort
  }

  // Re-derive the recipient address: prefer the current app_users.email
  // (so a TD who fixed their address between attempts gets through),
  // fall back to the snapshot we captured at first-send.
  let recipientName = "";
  let liveEmail: string | null = null;
  if (recipient.userId != null) {
    try {
      const [u] = await db.select({
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      }).from(appUsersTable).where(eq(appUsersTable.id, recipient.userId)).limit(1);
      if (u) {
        liveEmail = u.email ?? null;
        recipientName = (u.displayName ?? u.username ?? "").trim();
      }
    } catch {
      // best-effort
    }
  }
  const targetEmail = liveEmail ?? recipient.emailRecipient ?? null;

  const nextAttempts = currentAttempts + 1;
  let status: ManualEntryRecipientStatus | "skipped";
  let error: string | undefined;
  let hardBounce = false;

  if (!targetEmail) {
    status = "no_email";
  } else {
    const tName = tournament.name?.trim() || "tournament";
    const deepLink = `https://app.kharagolf.com/tournaments/${tournament.id}#players`;
    try {
      await sendManualEntryAlertEmail({
        to: targetEmail,
        recipientName,
        tournamentName: tName,
        playerName,
        round: alert.round,
        manualPct: Number(alert.manualPct),
        manualShots: alert.manualShots,
        totalShots: alert.totalShots,
        reviewUrl: deepLink,
        branding,
      });
      status = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errClass = classifyMailerError(err);
      if (errClass === "provider_unconfigured") {
        await db.update(manualEntryAlertRecipientsTable).set({
          status: "skipped",
          lastEmailAt: now,
          lastEmailError: "provider_not_configured",
          lastEmailRetryAt: now,
          nextEmailRetryAt: null,
        }).where(eq(manualEntryAlertRecipientsTable.id, recipient.id));
        return { status: "skipped", attempts: currentAttempts, exhausted: false, error: "provider_not_configured" };
      }
      status = "failed";
      error = msg;
      if (errClass === "hard_bounce") hardBounce = true;
      logger.warn(
        { ...logContext, recipientRowId: recipient.id, attempt: nextAttempts, errMsg: msg, errClass },
        "[manual-entry-notify] email retry failed",
      );
    }
  }

  const exhausted = status === "failed" && (hardBounce || nextAttempts >= MANUAL_ENTRY_MAX_EMAIL_ATTEMPTS);
  const persistedAttempts = exhausted && hardBounce
    ? MANUAL_ENTRY_MAX_EMAIL_ATTEMPTS
    : nextAttempts;
  await db.update(manualEntryAlertRecipientsTable).set({
    status,
    errorMessage: error ?? null,
    emailAttempts: persistedAttempts,
    lastEmailAt: now,
    lastEmailError: error ?? null,
    lastEmailRetryAt: now,
    nextEmailRetryAt: status === "failed" && !exhausted ? computeManualEntryNextEmailRetryAt(nextAttempts, now) : null,
    emailRetryExhaustedAt: exhausted ? now : null,
    // Refresh the snapshot so the admin alert (and the next retry)
    // sees the most recent address we tried.
    emailRecipient: targetEmail ?? recipient.emailRecipient ?? null,
  }).where(eq(manualEntryAlertRecipientsTable.id, recipient.id));

  if (exhausted) {
    try {
      const [stamped] = await db.select()
        .from(manualEntryAlertRecipientsTable)
        .where(eq(manualEntryAlertRecipientsTable.id, recipient.id))
        .limit(1);
      if (stamped) {
        await notifyAdminsOfManualEntryEmailExhaustion({
          recipient: stamped,
          alertId: recipient.alertId,
          organizationId: tournament.organizationId,
          reason: hardBounce ? "hard_bounce" : "max_attempts",
          logContext,
        });
      }
    } catch (err) {
      logger.warn(
        { ...logContext, recipientRowId: recipient.id, errMsg: err instanceof Error ? err.message : String(err) },
        "[manual-entry-notify] admin email exhaustion alert dispatch failed",
      );
    }
  }

  return { status, attempts: persistedAttempts, exhausted, error };
}

/**
 * Task #1847 — Notify org admins when a manual-entry email retry gives
 * up for a specific recipient. Mirrors the levy-receipt /
 * coach-payout exhaustion alerts:
 *   1. Atomic dedup via `emailExhaustionNotifiedAt` so the same
 *      exhaustion can never be announced twice across cron passes.
 *   2. Push fan-out to the same TD/admin/committee roles that would
 *      have received the original alert, so the failure surfaces
 *      immediately rather than waiting for someone to open the
 *      Players tab.
 *
 * Best-effort: any failure here is logged but never thrown — the
 * underlying recipient row is already marked exhausted, so callers
 * must not be derailed by an alerting error.
 */
export async function notifyAdminsOfManualEntryEmailExhaustion(opts: {
  recipient: ManualEntryAlertRecipient;
  alertId: number;
  organizationId: number;
  reason?: "hard_bounce" | "max_attempts";
  logContext?: Record<string, unknown>;
}): Promise<{ notified: boolean; recipients: number }> {
  const { recipient, alertId, organizationId, logContext } = opts;
  const reason = opts.reason ?? "max_attempts";

  // Resolve a friendly label for the affected recipient (the TD whose
  // email never landed) so the admin alert tells admins *who* to chase.
  let recipientLabel = `user #${recipient.userId ?? "(unknown)"}`;
  try {
    if (recipient.userId != null) {
      const [u] = await db.select({
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
        email: appUsersTable.email,
      }).from(appUsersTable).where(eq(appUsersTable.id, recipient.userId)).limit(1);
      if (u) {
        recipientLabel = (u.displayName ?? u.username ?? u.email ?? recipientLabel) || recipientLabel;
      }
    }
  } catch {
    // best-effort
  }

  // 1) Atomic dedup: stamp `emailExhaustionNotifiedAt` only if still
  //    NULL. The conditional UPDATE ensures only one caller "wins" —
  //    subsequent passes see the stamped row and short-circuit.
  let winner = false;
  try {
    const stamped = await db.update(manualEntryAlertRecipientsTable)
      .set({ emailExhaustionNotifiedAt: new Date() })
      .where(and(
        eq(manualEntryAlertRecipientsTable.id, recipient.id),
        isNull(manualEntryAlertRecipientsTable.emailExhaustionNotifiedAt),
      ))
      .returning({ id: manualEntryAlertRecipientsTable.id });
    winner = stamped.length > 0;
  } catch (err) {
    logger.warn(
      { ...logContext, recipientRowId: recipient.id, errMsg: err instanceof Error ? err.message : String(err) },
      "[manual-entry-notify] admin exhaustion stamp failed",
    );
    return { notified: false, recipients: 0 };
  }
  if (!winner) return { notified: false, recipients: 0 };

  // 2) Push to the same TD / admin / committee fan-out used for the
  //    original alert. Suppressed `userId` from the alert: we don't
  //    want the affected TD to also receive a "you didn't get this
  //    email" push.
  const directors = await db
    .select({ userId: orgMembershipsTable.userId })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, organizationId),
      inArray(orgMembershipsTable.role, [...DIRECTOR_ROLES]),
    ));
  const userIds = new Set<number>();
  for (const d of directors) {
    if (d.userId != null && d.userId !== recipient.userId) userIds.add(d.userId);
  }
  const recipients = [...userIds];

  if (recipients.length > 0) {
    try {
      await sendPushToUsers(
        recipients,
        "⚠️ Manual-entry email never reached a TD",
        reason === "hard_bounce"
          ? `Email to ${recipientLabel} for alert #${alertId} permanently bounced. Check their on-file address and notify them another way.`
          : `Email to ${recipientLabel} for alert #${alertId} failed ${MANUAL_ENTRY_MAX_EMAIL_ATTEMPTS} times. Manual follow-up required.`,
        {
          type: "manual_entry_email_exhausted",
          alertId,
          recipientRowId: recipient.id,
          organizationId,
          targetUserId: recipient.userId,
          reason,
        },
      );
    } catch (err) {
      logger.warn(
        { ...logContext, recipientRowId: recipient.id, errMsg: err instanceof Error ? err.message : String(err) },
        "[manual-entry-notify] admin exhaustion push failed",
      );
    }
  }

  logger.info(
    { ...logContext, recipientRowId: recipient.id, alertId, reason, recipients: recipients.length },
    "[manual-entry-notify] admins alerted: email retry exhausted",
  );

  return { notified: true, recipients: recipients.length };
}
