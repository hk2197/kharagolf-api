/**
 * Task #1444 — Bounce-aware recipient pausing for scheduled finance
 * digests.
 *
 * Originally introduced for the wallet auto-refund digest in Task #1233.
 * That implementation lives inline in `routes/side-games-v2.ts` for
 * historical reasons; the same shape is now reused by the per-levy
 * ledger, club-wide combined levy ledger, and bounced-levy reminders
 * digests via this shared helper so a single source of truth governs
 * how a digest cron decides which configured recipients are still
 * deliverable.
 *
 * Behaviour:
 *   1. Lower-cases each configured recipient (the bounce webhook stores
 *      addresses in lower case) and looks them up against
 *      `email_suppressions` for the org.
 *   2. Returns the non-suppressed addresses in `recipients` (preserving
 *      their original casing so dashboards keep showing them as the
 *      admin entered them) and the suppressed ones in `pausedRecipients`.
 *   3. On any DB error the helper returns the configured list intact
 *      and `pausedRecipients = []` — failing open is the correct safety
 *      stance because a transient suppression-table outage must not
 *      halt every digest in the system.
 *
 * Persistence of the trimmed list back onto the schedule row is the
 * caller's responsibility (each digest has its own schedule table) —
 * this helper deliberately stays read-only so it can be used from the
 * bounced-levy reminders cron, which has no schedule row to mutate.
 */
import { db, emailSuppressionsTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger.js";

/**
 * Per-recipient suppression metadata captured at the moment a digest
 * cron decided to drop the address. Persisted onto the digest's run row
 * (see e.g. `levy_ledger_email_runs.paused_recipients`,
 * `wallet_topup_refund_email_runs.paused_recipients`) so the schedule
 * editor's "X paused" chip + warning rows stay accurate even after
 * Task #1444 has pruned the address from `schedule.recipients` and even
 * after the suppression itself is later lifted.
 */
export interface DigestPausedRecipientSnapshot {
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
}

export interface PauseSuppressedRecipientsResult {
  /** Configured recipients that are NOT on the suppression list. */
  recipients: string[];
  /** Configured recipients that ARE on the suppression list. */
  pausedRecipients: string[];
  /**
   * Same set as `pausedRecipients` but with the suppression metadata
   * (`reason` / `bounceType` / `description`) the bounce webhook stored
   * when it suppressed the address. Callers that own a run-history
   * table with a `paused_recipients` jsonb column should persist this
   * snapshot so the dashboard can render the chip independently of the
   * live suppression list.
   */
  pausedRecipientsSnapshot: DigestPausedRecipientSnapshot[];
}

export async function pauseSuppressedRecipients(opts: {
  organizationId: number;
  configuredRecipients: string[];
  /** Caller tag used purely for log scoping when the suppression
   *  lookup fails — the same digest cron is the only one that will see
   *  the warning, so it knows which path failed open. */
  logScope?: string;
}): Promise<PauseSuppressedRecipientsResult> {
  const { organizationId, configuredRecipients, logScope } = opts;

  const lowerToOriginal = new Map<string, string>();
  for (const r of configuredRecipients) {
    const lower = String(r ?? "").trim().toLowerCase();
    if (lower) lowerToOriginal.set(lower, r);
  }
  const lowerList = [...lowerToOriginal.keys()];
  if (lowerList.length === 0) {
    return { recipients: [], pausedRecipients: [], pausedRecipientsSnapshot: [] };
  }

  const suppressionByLower = new Map<string, { reason: string; bounceType: string | null; description: string | null }>();
  try {
    const supRows = await db
      .select({
        email: emailSuppressionsTable.email,
        reason: emailSuppressionsTable.reason,
        bounceType: emailSuppressionsTable.bounceType,
        description: emailSuppressionsTable.description,
      })
      .from(emailSuppressionsTable)
      .where(and(
        eq(emailSuppressionsTable.organizationId, organizationId),
        inArray(emailSuppressionsTable.email, lowerList),
      ));
    for (const r of supRows) {
      suppressionByLower.set(String(r.email ?? "").toLowerCase(), {
        reason: r.reason,
        bounceType: r.bounceType,
        description: r.description,
      });
    }
  } catch (err) {
    logger.warn(
      { err, organizationId, scope: logScope ?? "digest" },
      "[digest-recipient-pause] suppression lookup failed; failing open",
    );
    suppressionByLower.clear();
  }

  const recipients: string[] = [];
  const pausedRecipients: string[] = [];
  const pausedRecipientsSnapshot: DigestPausedRecipientSnapshot[] = [];
  for (const [lower, original] of lowerToOriginal) {
    const hit = suppressionByLower.get(lower);
    if (hit) {
      pausedRecipients.push(original);
      pausedRecipientsSnapshot.push({
        email: original,
        reason: hit.reason,
        bounceType: hit.bounceType,
        description: hit.description,
      });
    } else {
      recipients.push(original);
    }
  }
  return { recipients, pausedRecipients, pausedRecipientsSnapshot };
}

/**
 * Task #2230 — Single-recipient suppression pre-check used by transactional
 * sends that have exactly one recipient (e.g. privacy-request notices).
 *
 * Returns the suppression metadata for the address when it is on the org's
 * `email_suppressions` list, or `null` when the address is deliverable. The
 * lookup is case-insensitive (matching the bounce webhook's lower-case
 * normalisation) and org-scoped — a hard bounce against one club must not
 * silently suppress sends from another club.
 *
 * Failure mode: any DB error returns `null` so the caller falls through to
 * its existing send path. Failing open here matches `pauseSuppressedRecipients`
 * — a transient suppression-table outage must never block a regulatory
 * privacy notice from being attempted.
 */
export interface EmailSuppressionHit {
  reason: string;
  bounceType: string | null;
  description: string | null;
}

export async function isEmailSuppressedForOrg(opts: {
  organizationId: number;
  email: string;
  /** Caller tag used purely for log scoping when the lookup fails. */
  logScope?: string;
}): Promise<EmailSuppressionHit | null> {
  const { organizationId, email, logScope } = opts;
  const normalised = String(email ?? "").trim().toLowerCase();
  if (!normalised) return null;
  try {
    // The bounce webhook stores addresses lower-cased, but we still compare
    // with `lower(email_suppressions.email)` as defence in depth: an
    // operator who hand-inserts a suppression row from a console (or a
    // future ingestion path that forgets to lowercase) must not be able to
    // silently bypass this guard. Matches the case-insensitive contract
    // the surrounding `pauseSuppressedRecipients` callers expect.
    const [row] = await db
      .select({
        reason: emailSuppressionsTable.reason,
        bounceType: emailSuppressionsTable.bounceType,
        description: emailSuppressionsTable.description,
      })
      .from(emailSuppressionsTable)
      .where(and(
        eq(emailSuppressionsTable.organizationId, organizationId),
        sql`lower(${emailSuppressionsTable.email}) = ${normalised}`,
      ))
      .limit(1);
    if (!row) return null;
    return {
      reason: row.reason,
      bounceType: row.bounceType,
      description: row.description,
    };
  } catch (err) {
    logger.warn(
      { err, organizationId, scope: logScope ?? "transactional" },
      "[digest-recipient-pause] single-recipient suppression lookup failed; failing open",
    );
    return null;
  }
}
