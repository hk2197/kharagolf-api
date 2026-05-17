/**
 * Auto-page on-call when the profile-share rollup cron stops firing
 * (Task #1813).
 *
 * Background — Task #1259 introduced the daily `profile_share_events`
 * rollup; Task #1474 surfaced its health on the
 * `/super-admin/profile-share-rollup` panel via a loud red banner that
 * fires when the last successful run is older than
 * `STALE_RUN_WARNING_MS` (36h). The banner is only useful if a
 * super-admin happens to load the page — if the cron silently stops
 * firing (deploy regression, container OOM-killed mid-run, runaway
 * transaction blocking the rollup query) the raw event table grows
 * unbounded until someone notices. This module closes the loop: an
 * hourly cron reuses the same admin summary and pages super-admins +
 * the on-call inbox when the rollup is stale AND there are raw events
 * that should have been rolled up.
 *
 * This is the sibling of `badgeShareRollupOpsAlert.ts` (Task #1478) for
 * the profile-share rollup. Same shape, same semantics — the only
 * differences are the summary loader, the dashboard deep-link path,
 * the email template, and the env-var name for the cooldown.
 *
 * Why "AND raw events > 0"? On a fresh deploy — or for a small
 * organisation that never produces any profile shares — `lastRun` is
 * legitimately old / null. Without the raw-event guard we would page
 * on-call every hour for a perfectly healthy quiet system. The only
 * thing the rollup actually does on an empty table is touch the
 * singleton `profile_share_rollup_runs` row, so the *value* of the
 * cron is what it does to non-empty raw events. If raw events have
 * piled up and the rollup hasn't fired, that's the alarm-worthy state.
 *
 * Recipients are the union of:
 *   - every super_admin in `app_users` with a non-null email, AND
 *   - the on-call list parsed from `OPS_ALERT_EMAILS` (the same env the
 *     existing manual-entry-alert health, notify-exhaustion, and
 *     badge-share rollup alerts use, so on-call only configures one
 *     address).
 *
 * Cooldown: persisted to the append-only `profile_share_rollup_ops_alerts`
 * audit log (Task #2261) so a sustained outage paged at 9am won't
 * re-page at 10am, 11am, ... — even across a process restart inside
 * the cooldown window. The previous in-process timestamp gate was
 * vulnerable to rolling deploys re-paging on-call; promoting the
 * state to the DB closes that hole and, as a happy side-effect, lets
 * the super-admin profile-share-rollup panel show a "Recent ops
 * alerts" feed so admins can confirm the pipeline is firing without
 * grepping inboxes or logs.
 *
 * Configuration (env, all optional):
 *   - `OPS_PROFILE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS`  default 6
 *   - `OPS_ALERT_EMAILS`                               comma-separated on-call list
 *   - `APP_BASE_URL` / `PUBLIC_BASE_URL`               used to build the
 *                                                      dashboard deep-link
 */
import {
  db,
  appUsersTable,
  profileShareRollupOpsAlertsTable,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { logger } from "./logger";
import { sendProfileShareRollupStaleOpsAlertEmail } from "./mailer";
import {
  getProfileShareRollupAdminSummary,
  type ProfileShareRollupAdminSummary,
} from "./profileShareRollup";

export const DEFAULT_PROFILE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS = 6;

export function getProfileShareRollupOpsAlertCooldownHours(): number {
  const raw = process.env.OPS_PROFILE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS;
  if (!raw) return DEFAULT_PROFILE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? n
    : DEFAULT_PROFILE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS;
}

export interface RunProfileShareRollupStaleOpsAlertOpts {
  /** Override the cooldown in hours (defaults to env / 6). */
  cooldownHours?: number;
  /**
   * Override the recipient list. When unset, the union of all
   * super_admin emails and `OPS_ALERT_EMAILS` is used.
   */
  recipients?: string[];
  /** Override the deep-link base URL. */
  baseUrl?: string;
  /** Override the summary loader (used by tests to bypass the DB). */
  summary?: ProfileShareRollupAdminSummary;
  /** Bypass the cooldown (used by tests / manual triggers). */
  force?: boolean;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export interface RunProfileShareRollupStaleOpsAlertResult {
  alerted: boolean;
  reason?:
    | "not_stale"
    | "no_raw_events"
    | "in_cooldown"
    | "no_recipients"
    | "send_failed";
  summary: ProfileShareRollupAdminSummary;
  cooldownHours: number;
  recipientsAttempted: number;
  recipientsEmailed: number;
}

/**
 * One row in the "Recent ops alerts" feed surfaced on the super-admin
 * profile-share-rollup panel. Mirrors the
 * `manualEntryAlertPageHistoryTable` row shape used by the sibling
 * silent-alerts dashboard (Task #1665) so the same UI conventions
 * carry across — `pagedAt` is ISO-formatted for direct render.
 */
export interface ProfileShareRollupOpsAlertHistoryRow {
  id: number;
  pagedAt: string;
  lastRunRanAt: string | null;
  rollupAgeMs: number;
  staleThresholdMs: number;
  currentRawEventCount: number;
  currentAggregateRowCount: number;
  cooldownHours: number;
  recipientCount: number;
  recipientEmails: string[];
}

/**
 * Read the persisted "last paged on-call" timestamp from the most
 * recent `profile_share_rollup_ops_alerts` row. Returns `null` when
 * the auto-pager has never fired on this database.
 *
 * Surfaced on the super-admin profile-share-rollup panel (Task #2261)
 * so admins can confirm the alert pipeline is wired up and correlate
 * the loud red banner with the email they received.
 */
export async function loadLastProfileShareRollupOpsAlertAt(): Promise<Date | null> {
  const rows = await db
    .select({ pagedAt: profileShareRollupOpsAlertsTable.pagedAt })
    .from(profileShareRollupOpsAlertsTable)
    .orderBy(desc(profileShareRollupOpsAlertsTable.pagedAt))
    .limit(1);
  return rows[0]?.pagedAt ?? null;
}

/**
 * Read the most recent N pages from the `profile_share_rollup_ops_alerts`
 * audit log so the super-admin panel (Task #2261) can render a
 * "Recent ops alerts" feed with simple `limit` / `offset` pagination.
 * Mirrors the badge-share variant in look-and-feel — same row shape,
 * same DESC-by-pagedAt ordering — so the same UI helper handles both.
 */
export async function loadRecentProfileShareRollupOpsAlerts(opts: {
  limit: number;
  offset?: number;
}): Promise<ProfileShareRollupOpsAlertHistoryRow[]> {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const rows = await db
    .select({
      id: profileShareRollupOpsAlertsTable.id,
      pagedAt: profileShareRollupOpsAlertsTable.pagedAt,
      lastRunRanAt: profileShareRollupOpsAlertsTable.lastRunRanAt,
      rollupAgeMs: profileShareRollupOpsAlertsTable.rollupAgeMs,
      staleThresholdMs: profileShareRollupOpsAlertsTable.staleThresholdMs,
      currentRawEventCount: profileShareRollupOpsAlertsTable.currentRawEventCount,
      currentAggregateRowCount: profileShareRollupOpsAlertsTable.currentAggregateRowCount,
      cooldownHours: profileShareRollupOpsAlertsTable.cooldownHours,
      recipientCount: profileShareRollupOpsAlertsTable.recipientCount,
      recipientEmails: profileShareRollupOpsAlertsTable.recipientEmails,
    })
    .from(profileShareRollupOpsAlertsTable)
    .orderBy(desc(profileShareRollupOpsAlertsTable.pagedAt))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({
    id: r.id,
    pagedAt:
      r.pagedAt instanceof Date ? r.pagedAt.toISOString() : String(r.pagedAt),
    lastRunRanAt: r.lastRunRanAt
      ? r.lastRunRanAt instanceof Date
        ? r.lastRunRanAt.toISOString()
        : String(r.lastRunRanAt)
      : null,
    rollupAgeMs: r.rollupAgeMs,
    staleThresholdMs: r.staleThresholdMs,
    currentRawEventCount: r.currentRawEventCount,
    currentAggregateRowCount: r.currentAggregateRowCount,
    // numeric() comes back as a string from pg — coerce so the UI can
    // format without an extra parseFloat dance.
    cooldownHours: Number(r.cooldownHours),
    recipientCount: r.recipientCount,
    recipientEmails: r.recipientEmails,
  }));
}

/** Test-only: clear the persisted audit log so cooldown gating starts fresh. */
export async function _resetProfileShareRollupStaleOpsAlertDedupForTest(): Promise<void> {
  await db.delete(profileShareRollupOpsAlertsTable);
}

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function parseRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function dedupEmails(emails: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of emails) {
    if (!e) continue;
    const key = e.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(e.trim());
  }
  return out;
}

async function loadSuperAdminEmails(): Promise<string[]> {
  const rows = await db
    .select({ email: appUsersTable.email })
    .from(appUsersTable)
    .where(eq(appUsersTable.role, "super_admin"));
  return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
}

function resolveBaseUrl(): string {
  return (
    process.env.APP_BASE_URL ??
    process.env.PUBLIC_BASE_URL ??
    `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`
  );
}

/**
 * Insert one audit row for the page that just went out. Records the
 * trigger snapshot (last-run timestamp + raw/aggregate counts +
 * threshold + cooldown) and the actual recipient list so the
 * super-admin panel can render "Last alert: 2h ago, paged 3 admins"
 * and support can confirm a specific address was reached without
 * re-deriving the lookup.
 */
async function recordProfileShareRollupOpsAlert(
  pagedAt: Date,
  summary: ProfileShareRollupAdminSummary,
  cooldownHours: number,
  recipients: string[],
): Promise<void> {
  await db.insert(profileShareRollupOpsAlertsTable).values({
    pagedAt,
    lastRunRanAt: summary.lastRun ? new Date(summary.lastRun.ranAt) : null,
    rollupAgeMs: Math.min(2_147_483_647, Math.max(0, Math.floor(summary.rollupAgeMs))),
    staleThresholdMs: Math.min(
      2_147_483_647,
      Math.max(0, Math.floor(summary.staleThresholdMs)),
    ),
    currentRawEventCount: summary.currentRawEventCount,
    currentAggregateRowCount: summary.currentAggregateRowCount,
    cooldownHours: cooldownHours.toFixed(2),
    recipientCount: recipients.length,
    recipientEmails: recipients,
  });
}

/**
 * Hourly job: load the profile-share rollup admin summary, decide
 * whether the rollup is stale (and there is actually work waiting on
 * it), and email super-admins + on-call when so. Returns a structured
 * result so tests / callers can assert on the outcome without scraping
 * logs.
 */
export async function runProfileShareRollupStaleOpsAlertJob(
  opts: RunProfileShareRollupStaleOpsAlertOpts = {},
): Promise<RunProfileShareRollupStaleOpsAlertResult> {
  const now = opts.now ?? new Date();

  const cooldownHours =
    opts.cooldownHours ??
    parseEnvNumber(
      "OPS_PROFILE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS",
      DEFAULT_PROFILE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS,
    );

  const summary =
    opts.summary ?? (await getProfileShareRollupAdminSummary(now.getTime()));

  const baseResult: Omit<
    RunProfileShareRollupStaleOpsAlertResult,
    "alerted" | "reason" | "recipientsAttempted" | "recipientsEmailed"
  > = {
    summary,
    cooldownHours,
  };

  if (!summary.isStale) {
    return {
      ...baseResult,
      alerted: false,
      reason: "not_stale",
      recipientsAttempted: 0,
      recipientsEmailed: 0,
    };
  }

  if (summary.currentRawEventCount === 0) {
    // No work waiting on the rollup — a fresh / quiet system, not an
    // outage. Stay silent so we don't page on-call for nothing.
    return {
      ...baseResult,
      alerted: false,
      reason: "no_raw_events",
      recipientsAttempted: 0,
      recipientsEmailed: 0,
    };
  }

  // Cooldown gate — keep a sustained outage to one page per cooldown
  // window. Persisted in `profile_share_rollup_ops_alerts` so the
  // gate survives a process restart inside the window. `force` lets
  // manual triggers / tests bypass.
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  if (!opts.force) {
    const lastAlertedAt = await loadLastProfileShareRollupOpsAlertAt();
    if (
      lastAlertedAt != null &&
      now.getTime() - lastAlertedAt.getTime() < cooldownMs
    ) {
      return {
        ...baseResult,
        alerted: false,
        reason: "in_cooldown",
        recipientsAttempted: 0,
        recipientsEmailed: 0,
      };
    }
  }

  let recipients = opts.recipients;
  if (!recipients) {
    const [superAdmins, onCall] = await Promise.all([
      loadSuperAdminEmails(),
      Promise.resolve(parseRecipients(process.env.OPS_ALERT_EMAILS)),
    ]);
    recipients = dedupEmails([...superAdmins, ...onCall]);
  } else {
    recipients = dedupEmails(recipients);
  }

  if (recipients.length === 0) {
    logger.warn(
      { summary },
      "[ops-alert] profile-share rollup is stale but no super_admin or OPS_ALERT_EMAILS recipient is configured; skipping email",
    );
    return {
      ...baseResult,
      alerted: false,
      reason: "no_recipients",
      recipientsAttempted: 0,
      recipientsEmailed: 0,
    };
  }

  const dashboardUrl =
    (opts.baseUrl ?? resolveBaseUrl()).replace(/\/$/, "") +
    "/super-admin/profile-share-rollup";

  let emailed = 0;
  const reachedRecipients: string[] = [];
  for (const to of recipients) {
    try {
      await sendProfileShareRollupStaleOpsAlertEmail({
        to,
        summary,
        cooldownHours,
        dashboardUrl,
        now,
      });
      emailed += 1;
      reachedRecipients.push(to);
    } catch (err) {
      logger.warn(
        { err, to },
        "[ops-alert] failed to send profile-share rollup stale ops alert email",
      );
    }
  }

  if (emailed > 0) {
    try {
      await recordProfileShareRollupOpsAlert(
        now,
        summary,
        cooldownHours,
        reachedRecipients,
      );
    } catch (err) {
      // The audit insert is best-effort: the email already went out, so
      // we must not fail the watchdog over an audit-table write. Log
      // loudly so a broken audit row doesn't silently hide repeat pages.
      logger.warn(
        { err, recipientsEmailed: emailed },
        "[ops-alert] failed to record profile-share rollup stale alert audit row",
      );
    }
    logger.warn(
      { summary, recipientsEmailed: emailed },
      "[ops-alert] profile-share rollup is stale — ops paged",
    );
    return {
      ...baseResult,
      alerted: true,
      recipientsAttempted: recipients.length,
      recipientsEmailed: emailed,
    };
  }

  return {
    ...baseResult,
    alerted: false,
    reason: "send_failed",
    recipientsAttempted: recipients.length,
    recipientsEmailed: 0,
  };
}
