/**
 * Task #1883 — Watchdog that emails admins when the daily Stripe-webhook
 * retention sweep (`sweepOldStripeWebhookDeliveries` in `cron.ts`) has
 * been silent for too long.
 *
 * Background — Task #1295 added the orange "Sweep stalled" badge that
 * the admin Stripe webhook audit page renders when
 * `isStripeWebhookSweepStale()` is true (~36h without a recorded run).
 * That banner only fires when an admin happens to load the page; a cron
 * that has silently stopped firing therefore goes unnoticed until
 * `stripe_webhook_deliveries` grows enough for someone to look. This
 * watchdog closes that loop: an hourly job evaluates the same
 * `isStripeWebhookSweepStale` predicate the badge uses and pages
 * super-admins + the on-call inbox when it trips.
 *
 * Recipients mirror the wellness re-auth alert (Task #1151) and the
 * org-plan-cancelled notification (Task #1540): the union of every
 * platform-level admin email and the on-call inbox. Concretely:
 *   - every super_admin in `app_users` with a non-null email, AND
 *   - every org_admin across all orgs — resolved from both
 *     `org_memberships.role = 'org_admin'` and the legacy
 *     `app_users.role = 'org_admin'` rows so an admin present in either
 *     table is still paged exactly once (mirrors the dual-source lookup
 *     in `loadOrgAdmins` from `orgPlanCancelledNotify.ts`), AND
 *   - the on-call list parsed from `OPS_ALERT_EMAILS`.
 * Emails are case-insensitively deduped so an admin who is also listed
 * in `OPS_ALERT_EMAILS` is not paged twice.
 *
 * Cooldown: persisted to the `stripe_webhook_sweep_stale_alerts` audit
 * table so a sustained outage paged at 09:00 does not re-page at 10:00,
 * 11:00, ... — even across a deploy that lands inside the cooldown
 * window or across multiple cron processes racing. The same row also
 * doubles as the audit log the task asks for ("a new audit row records
 * the outgoing notification so we can see in admin tooling that the
 * alert went out and to whom"). Mirrors the singleton-cooldown shape
 * used by the badge-share variant (Task #1814) but appends per page so
 * the dashboard / digest tooling can show a history of pages, not just
 * the most recent one.
 *
 * Configuration (env, all optional):
 *   - `OPS_STRIPE_WEBHOOK_SWEEP_STALE_COOLDOWN_HOURS`  default 24
 *   - `OPS_ALERT_EMAILS`                               comma-separated on-call list
 *   - `APP_BASE_URL` / `PUBLIC_BASE_URL`               used to build the dashboard deep-link
 */
import {
  db,
  appUsersTable,
  orgMembershipsTable,
  stripeWebhookSweepStaleAlertsTable,
} from "@workspace/db";
import { eq, desc, inArray, or } from "drizzle-orm";
import { logger } from "./logger";
import { sendStripeWebhookSweepStaleOpsAlertEmail } from "./mailer";
import {
  getLastStripeWebhookSweepResult,
  isStripeWebhookSweepStale,
  STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS,
  type StripeWebhookSweepStatus,
} from "./stripeWebhookSweepStatus";

/**
 * Default cooldown (hours) between watchdog pages while the sweep stays
 * stale. Defaults to 24h — i.e. one alert per day until the sweep
 * recovers — because a stalled daily cron is "broken until somebody
 * fixes it", not a transient flap, and on-call should not be paged once
 * an hour for the same root cause. Tunable via
 * `OPS_STRIPE_WEBHOOK_SWEEP_STALE_COOLDOWN_HOURS`.
 */
export const DEFAULT_STRIPE_WEBHOOK_SWEEP_STALE_COOLDOWN_HOURS = 24;

export function getStripeWebhookSweepStaleOpsAlertCooldownHours(): number {
  const raw = process.env.OPS_STRIPE_WEBHOOK_SWEEP_STALE_COOLDOWN_HOURS;
  if (!raw) return DEFAULT_STRIPE_WEBHOOK_SWEEP_STALE_COOLDOWN_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? n
    : DEFAULT_STRIPE_WEBHOOK_SWEEP_STALE_COOLDOWN_HOURS;
}

export interface RunStripeWebhookSweepStaleOpsAlertOpts {
  /** Override the cooldown in hours (defaults to env / 24). */
  cooldownHours?: number;
  /**
   * Override the recipient list. When unset, the union of all
   * super_admin emails and `OPS_ALERT_EMAILS` is used.
   */
  recipients?: string[];
  /** Override the deep-link base URL. */
  baseUrl?: string;
  /**
   * Override the last-sweep status (used by tests to bypass the DB and
   * the in-memory cache).
   */
  status?: StripeWebhookSweepStatus | null;
  /** Bypass the cooldown (used by tests / manual triggers). */
  force?: boolean;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export interface RunStripeWebhookSweepStaleOpsAlertResult {
  alerted: boolean;
  reason?:
    | "not_stale"
    | "in_cooldown"
    | "no_recipients"
    | "send_failed";
  status: StripeWebhookSweepStatus | null;
  cooldownHours: number;
  staleThresholdMs: number;
  recipientsAttempted: number;
  recipientsEmailed: number;
}

/**
 * Read the most recent persisted "watchdog paged on-call" timestamp
 * from `stripe_webhook_sweep_stale_alerts`. Returns `null` when the
 * watchdog has never fired on this database. Surfaced for the admin
 * audit page so admins can see how recently the alert pipeline last
 * actually fired and correlate the badge with the email they should
 * have received.
 */
export async function loadLastStripeWebhookSweepStaleAlertAt(): Promise<Date | null> {
  const rows = await db
    .select({ pagedAt: stripeWebhookSweepStaleAlertsTable.pagedAt })
    .from(stripeWebhookSweepStaleAlertsTable)
    .orderBy(desc(stripeWebhookSweepStaleAlertsTable.pagedAt))
    .limit(1);
  return rows[0]?.pagedAt ?? null;
}

/** Test-only: clear the audit log so cooldown gating starts fresh. */
export async function _resetStripeWebhookSweepStaleOpsAlertDedupForTest(): Promise<void> {
  await db.delete(stripeWebhookSweepStaleAlertsTable);
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

/** Role used in `app_users.role` and `org_memberships.role` for org admins. */
const ORG_ADMIN_ROLE = "org_admin";

/**
 * Resolve every platform-level admin email address: super_admin users
 * + org_admins (across every org, from both the modern `org_memberships`
 * source and the legacy `app_users.role = 'org_admin'` source). Mirrors
 * the dual-source lookup used by `loadOrgAdmins` in
 * `orgPlanCancelledNotify.ts` so admins represented in either table are
 * paged exactly once. Users without an email are silently dropped; the
 * caller dedupes case-insensitively against the on-call list.
 */
async function loadAdminEmails(): Promise<string[]> {
  const userIds = new Set<number>();

  // Modern source: org_memberships rows with role = "org_admin" for any org.
  const memberRows = await db
    .select({ userId: orgMembershipsTable.userId })
    .from(orgMembershipsTable)
    .where(eq(orgMembershipsTable.role, ORG_ADMIN_ROLE));
  for (const r of memberRows) userIds.add(r.userId);

  // Resolve user rows for super_admins + legacy org_admins + ids gathered
  // from org_memberships above. Done in one query so we deduplicate at
  // the user level (an admin can be both `super_admin` and `org_admin`,
  // or appear in both `app_users` and `org_memberships`).
  const memberIdList = [...userIds];
  const userRows = await db
    .select({ id: appUsersTable.id, email: appUsersTable.email })
    .from(appUsersTable)
    .where(
      memberIdList.length > 0
        ? or(
            eq(appUsersTable.role, "super_admin"),
            eq(appUsersTable.role, ORG_ADMIN_ROLE),
            inArray(appUsersTable.id, memberIdList),
          )
        : or(
            eq(appUsersTable.role, "super_admin"),
            eq(appUsersTable.role, ORG_ADMIN_ROLE),
          ),
    );

  const seenIds = new Set<number>();
  const emails: string[] = [];
  for (const r of userRows) {
    if (seenIds.has(r.id)) continue;
    seenIds.add(r.id);
    if (r.email) emails.push(r.email);
  }
  return emails;
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
 * trigger snapshot (last-sweep timestamp + threshold) and the actual
 * recipient list, so admin tooling can render "Last alert: 2h ago,
 * paged 3 admins" and support can confirm a specific address was
 * reached without re-deriving the lookup.
 */
async function recordStripeWebhookSweepStaleAlert(
  pagedAt: Date,
  status: StripeWebhookSweepStatus | null,
  staleThresholdMs: number,
  recipients: string[],
): Promise<void> {
  await db.insert(stripeWebhookSweepStaleAlertsTable).values({
    pagedAt,
    lastSweepRanAt: status ? new Date(status.ranAt) : null,
    staleThresholdMs,
    recipientCount: recipients.length,
    recipientEmails: recipients,
  });
}

/**
 * Watchdog job: load the most recent sweep status, decide whether the
 * sweep is stale, and email super-admins + on-call when so. Returns a
 * structured result so tests / callers can assert on the outcome
 * without scraping logs.
 */
export async function runStripeWebhookSweepStaleOpsAlertJob(
  opts: RunStripeWebhookSweepStaleOpsAlertOpts = {},
): Promise<RunStripeWebhookSweepStaleOpsAlertResult> {
  const now = opts.now ?? new Date();
  const cooldownHours =
    opts.cooldownHours ?? getStripeWebhookSweepStaleOpsAlertCooldownHours();
  const staleThresholdMs = STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS;

  const status =
    opts.status !== undefined
      ? opts.status
      : await getLastStripeWebhookSweepResult();

  const baseResult: Omit<
    RunStripeWebhookSweepStaleOpsAlertResult,
    "alerted" | "reason" | "recipientsAttempted" | "recipientsEmailed"
  > = {
    status,
    cooldownHours,
    staleThresholdMs,
  };

  if (!isStripeWebhookSweepStale(status, now.getTime())) {
    return {
      ...baseResult,
      alerted: false,
      reason: "not_stale",
      recipientsAttempted: 0,
      recipientsEmailed: 0,
    };
  }

  // Cooldown gate — keep a sustained outage to one page per cooldown
  // window. Persisted in `stripe_webhook_sweep_stale_alerts` so the
  // gate survives a process restart inside the window. `force` lets
  // manual triggers / tests bypass.
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  if (!opts.force) {
    const lastAlertedAt = await loadLastStripeWebhookSweepStaleAlertAt();
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
    const [admins, onCall] = await Promise.all([
      loadAdminEmails(),
      Promise.resolve(parseRecipients(process.env.OPS_ALERT_EMAILS)),
    ]);
    recipients = dedupEmails([...admins, ...onCall]);
  } else {
    recipients = dedupEmails(recipients);
  }

  if (recipients.length === 0) {
    logger.warn(
      { status },
      "[ops-alert] stripe-webhook sweep is stale but no super_admin / org_admin / OPS_ALERT_EMAILS recipient is configured; skipping email",
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
    "/super-admin/stripe-webhook-audit";

  let emailed = 0;
  const reachedRecipients: string[] = [];
  for (const to of recipients) {
    try {
      await sendStripeWebhookSweepStaleOpsAlertEmail({
        to,
        status,
        staleThresholdMs,
        cooldownHours,
        dashboardUrl,
        now,
      });
      emailed += 1;
      reachedRecipients.push(to);
    } catch (err) {
      logger.warn(
        { err, to },
        "[ops-alert] failed to send stripe-webhook sweep stale ops alert email",
      );
    }
  }

  if (emailed > 0) {
    try {
      await recordStripeWebhookSweepStaleAlert(
        now,
        status,
        staleThresholdMs,
        reachedRecipients,
      );
    } catch (err) {
      // The audit insert is best-effort: the email already went out, so
      // we must not fail the watchdog over an audit-table write. Log
      // loudly so a broken audit row doesn't silently hide repeat pages.
      logger.warn(
        { err, recipientsEmailed: emailed },
        "[ops-alert] failed to record stripe-webhook sweep stale alert audit row",
      );
    }
    logger.warn(
      { status, recipientsEmailed: emailed },
      "[ops-alert] stripe-webhook sweep is stale — admins paged",
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

