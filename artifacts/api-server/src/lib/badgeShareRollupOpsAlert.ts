/**
 * Auto-page on-call when the badge-share rollup cron stops firing
 * (Task #1478).
 *
 * Background — Task #1096 introduced the daily `badge_share_events`
 * rollup; Task #1260 surfaced its health on the
 * `/super-admin/badge-share-rollup` panel via a loud red banner that
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
 * Why "AND raw events > 0"? On a fresh deploy — or for a small
 * organisation that never produces any badge shares — `lastRun` is
 * legitimately old / null. Without the raw-event guard we would page
 * on-call every hour for a perfectly healthy quiet system. The only
 * thing the rollup actually does on an empty table is touch the
 * singleton `badge_share_rollup_runs` row, so the *value* of the cron
 * is what it does to non-empty raw events. If raw events have piled up
 * and the rollup hasn't fired, that's the alarm-worthy state.
 *
 * Recipients are the union of:
 *   - every super_admin in `app_users` with a non-null email, AND
 *   - the on-call list parsed from `OPS_ALERT_EMAILS` (the same env the
 *     existing manual-entry-alert health and notify-exhaustion alerts
 *     use, so on-call only configures one address).
 *
 * Cooldown: persisted to the singleton `badge_share_rollup_ops_alerts`
 * table (Task #1814) so a sustained outage paged at 9am does not
 * re-page at 10am, 11am, ... — even across a process restart inside
 * the cooldown window. The previous in-process timestamp gate was
 * vulnerable to rolling deploys re-paging on-call; promoting the
 * state to the DB closes that hole and, as a happy side-effect, lets
 * the super-admin badge-share-rollup panel show a "Last ops alert: 2h
 * ago" line under the cooldown explanation so admins can confirm the
 * pipeline is firing without grepping inboxes or logs.
 *
 * Configuration (env, all optional):
 *   - `OPS_BADGE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS`  default 6
 *   - `OPS_ALERT_EMAILS`                             comma-separated on-call list
 *   - `OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK`        optional; falls back to
 *                                                    `OPS_ALERT_SLACK_WEBHOOK` (Task #2054)
 *   - `OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY` optional; falls back to
 *                                                    `OPS_ALERT_PAGERDUTY_ROUTING_KEY` (Task #2054)
 *   - `APP_BASE_URL` / `PUBLIC_BASE_URL`             used to build the
 *                                                    dashboard deep-link
 */
import {
  db,
  appUsersTable,
  badgeShareRollupOpsAlertsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendBadgeShareRollupStaleOpsAlertEmail } from "./mailer";
import {
  getBadgeShareRollupAdminSummary,
  type BadgeShareRollupAdminSummary,
} from "./badgeShareRollup";
import {
  DEFAULT_BADGE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS,
  getBadgeShareRollupOpsAlertCooldownHours,
} from "./badgeShareRollupOpsAlertConfig";
import {
  postBadgeShareRollupStaleOpsAlertSlack,
  resolveOpsAlertChatTargets,
  triggerBadgeShareRollupStaleOpsAlertPagerDuty,
  type BadgeShareRollupStaleChatOpts,
  type OpsAlertChatTargets,
} from "./opsAlertChat";

// Re-exported so existing callers / tests can keep importing the
// constant from this module's stable path.
export {
  DEFAULT_BADGE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS,
  getBadgeShareRollupOpsAlertCooldownHours,
};

export interface RunBadgeShareRollupStaleOpsAlertOpts {
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
  summary?: BadgeShareRollupAdminSummary;
  /** Bypass the cooldown (used by tests / manual triggers). */
  force?: boolean;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export interface RunBadgeShareRollupStaleOpsAlertResult {
  alerted: boolean;
  reason?:
    | "not_stale"
    | "no_raw_events"
    | "in_cooldown"
    | "no_recipients"
    | "send_failed";
  summary: BadgeShareRollupAdminSummary;
  cooldownHours: number;
  recipientsAttempted: number;
  recipientsEmailed: number;
}

/**
 * Read the persisted "last paged on-call" timestamp from the
 * `badge_share_rollup_ops_alerts` singleton. Returns `null` when the
 * auto-pager has never fired on this database.
 *
 * Surfaced on the super-admin badge-share-rollup panel so admins can
 * confirm the alert pipeline is wired up and correlate the loud red
 * banner with the email they received.
 */
export async function loadLastBadgeShareRollupOpsAlertAt(): Promise<Date | null> {
  const rows = await db
    .select({ lastAlertedAt: badgeShareRollupOpsAlertsTable.lastAlertedAt })
    .from(badgeShareRollupOpsAlertsTable)
    .where(eq(badgeShareRollupOpsAlertsTable.id, 1))
    .limit(1);
  return rows[0]?.lastAlertedAt ?? null;
}

/** Test-only: clear the persisted cooldown row. */
export async function _resetBadgeShareRollupStaleOpsAlertDedupForTest(): Promise<void> {
  await db.delete(badgeShareRollupOpsAlertsTable);
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
 * Resolve the env-driven Slack webhook + PagerDuty routing key targets
 * for the badge-share rollup stale alert (Task #2054).
 *
 * Lookup order — same shared-fallback shape every `OPS_ALERT_EMAILS`
 * flow uses:
 *   1. `OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK` /
 *      `OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY` — dedicated.
 *   2. `OPS_ALERT_SLACK_WEBHOOK` / `OPS_ALERT_PAGERDUTY_ROUTING_KEY` —
 *      shared fallback, the same pair the watch GPS spike (Task #1374),
 *      notify-retry exhaustion (Task #1652), and manual-entry alert
 *      health (Task #2054) flows use.
 */
function getBadgeShareRollupStaleChatTargets(): OpsAlertChatTargets {
  return resolveOpsAlertChatTargets({
    slackEnvVar: "OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK",
    pagerDutyEnvVar: "OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY",
  });
}

/**
 * Fire-and-forget dispatch of the badge-share rollup stale ops alert
 * to Slack and/or PagerDuty (Task #2054). Mirrors the pattern from
 * `dispatchNotifyRetryExhaustionChat`:
 *   - Missing-config (no chat target set anywhere) emits one warn log
 *     and returns. The email branch already handles its own
 *     "no recipients" warn for the email-only flow.
 *   - Per-channel try/catch so a Slack outage doesn't suppress the
 *     PagerDuty trigger and vice versa.
 */
function dispatchBadgeShareRollupStaleChat(opts: BadgeShareRollupStaleChatOpts): void {
  const { slackWebhook, pagerDutyRoutingKey } = getBadgeShareRollupStaleChatTargets();
  if (!slackWebhook && !pagerDutyRoutingKey) {
    logger.warn(
      {
        rollupAgeMs: opts.summary.rollupAgeMs,
        currentRawEventCount: opts.summary.currentRawEventCount,
      },
      "[ops-alert] badge-share rollup is stale but no chat target configured (set OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK / OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY, or the shared OPS_ALERT_SLACK_WEBHOOK / OPS_ALERT_PAGERDUTY_ROUTING_KEY); skipping ops chat page",
    );
    return;
  }
  if (slackWebhook) {
    void postBadgeShareRollupStaleOpsAlertSlack({ webhookUrl: slackWebhook, ...opts }).catch(
      (err: unknown) => {
        logger.warn(
          { err },
          "[ops-alert] failed to post badge-share rollup stale ops alert to Slack",
        );
      },
    );
  }
  if (pagerDutyRoutingKey) {
    void triggerBadgeShareRollupStaleOpsAlertPagerDuty({
      routingKey: pagerDutyRoutingKey,
      ...opts,
    }).catch((err: unknown) => {
      logger.warn(
        { err },
        "[ops-alert] failed to trigger badge-share rollup stale ops alert on PagerDuty",
      );
    });
  }
}

/**
 * Test helper — exposes the env-driven chat-target resolver so unit
 * tests can cover the dedicated → shared fallback order without
 * touching the DB.
 */
export function _resolveBadgeShareRollupStaleChatTargetsForTests(): OpsAlertChatTargets {
  return getBadgeShareRollupStaleChatTargets();
}

/**
 * Test helper — exposes the chat dispatcher so unit tests can drive
 * the chat path directly (no DB / mailer setup needed).
 */
export function _dispatchBadgeShareRollupStaleChatForTests(
  opts: BadgeShareRollupStaleChatOpts,
): void {
  dispatchBadgeShareRollupStaleChat(opts);
}

/**
 * UPSERT the singleton cooldown row to `at`. Called after a successful
 * page so the next invocation can compute the cooldown gate.
 */
async function recordBadgeShareRollupOpsAlertAt(at: Date): Promise<void> {
  await db.execute(sql`
    INSERT INTO ${badgeShareRollupOpsAlertsTable} (id, last_alerted_at)
    VALUES (1, ${at})
    ON CONFLICT (id) DO UPDATE SET last_alerted_at = EXCLUDED.last_alerted_at
  `);
}

/**
 * Hourly job: load the badge-share rollup admin summary, decide
 * whether the rollup is stale (and there is actually work waiting on
 * it), and email super-admins + on-call when so. Returns a structured
 * result so tests / callers can assert on the outcome without scraping
 * logs.
 */
export async function runBadgeShareRollupStaleOpsAlertJob(
  opts: RunBadgeShareRollupStaleOpsAlertOpts = {},
): Promise<RunBadgeShareRollupStaleOpsAlertResult> {
  const now = opts.now ?? new Date();

  const cooldownHours =
    opts.cooldownHours ?? getBadgeShareRollupOpsAlertCooldownHours();

  const summary =
    opts.summary ?? (await getBadgeShareRollupAdminSummary(now.getTime()));

  const baseResult: Omit<
    RunBadgeShareRollupStaleOpsAlertResult,
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
  // window. Persisted in `badge_share_rollup_ops_alerts` so the gate
  // survives a process restart inside the window. `force` lets manual
  // triggers / tests bypass.
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  if (!opts.force) {
    const lastAlertedAt = await loadLastBadgeShareRollupOpsAlertAt();
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

  const dashboardUrl =
    (opts.baseUrl ?? resolveBaseUrl()).replace(/\/$/, "") +
    "/super-admin/badge-share-rollup";

  // Task #2054 — fan the breach out to Slack / PagerDuty in parallel
  // with the email loop below. Fire-and-forget on purpose: chat is a
  // best-effort secondary channel and must not gate the email page or
  // the persisted-cooldown UPSERT if a Slack webhook is briefly
  // unreachable. Mirrors the pattern from `notifyExhaustionOpsAlert.ts`
  // (Task #1652).
  dispatchBadgeShareRollupStaleChat({
    summary: {
      currentRawEventCount: summary.currentRawEventCount,
      currentAggregateRowCount: summary.currentAggregateRowCount,
      rollupAgeMs: summary.rollupAgeMs,
      staleThresholdMs: summary.staleThresholdMs,
      lastRun: summary.lastRun
        ? {
            ranAt: summary.lastRun.ranAt,
            rolledUpEvents: summary.lastRun.rolledUpEvents,
          }
        : null,
    },
    cooldownHours,
    dashboardUrl,
    now,
  });

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
      "[ops-alert] badge-share rollup is stale but no super_admin or OPS_ALERT_EMAILS recipient is configured; skipping email",
    );
    return {
      ...baseResult,
      alerted: false,
      reason: "no_recipients",
      recipientsAttempted: 0,
      recipientsEmailed: 0,
    };
  }

  let emailed = 0;
  for (const to of recipients) {
    try {
      await sendBadgeShareRollupStaleOpsAlertEmail({
        to,
        summary,
        cooldownHours,
        dashboardUrl,
        now,
      });
      emailed += 1;
    } catch (err) {
      logger.warn(
        { err, to },
        "[ops-alert] failed to send badge-share rollup stale ops alert email",
      );
    }
  }

  if (emailed > 0) {
    await recordBadgeShareRollupOpsAlertAt(now);
    logger.warn(
      { summary, recipientsEmailed: emailed },
      "[ops-alert] badge-share rollup is stale — ops paged",
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

// ── Task #2057 — wiring badge + "Send test page" support ─────────────────
//
// Backs the super-admin badge-share rollup dashboard chip ("Slack:
// configured · PagerDuty: missing") and the dashboard's "Send test
// page" button. Status resolver only exposes whether each channel is
// configured — never the webhook URL or routing key — so a UI render
// can't leak credentials into a screenshot. Test-page sender awaits
// the per-channel sends so the route can return per-channel
// success/failure synchronously, mirrors the watch-GPS / notify-retry
// test-page pattern, and fires HEAD's senders with `isTest: true` so
// the rendered page is visibly synthetic and the PagerDuty `dedup_key`
// is salted with a full timestamp (won't collapse onto a real open
// incident).

/**
 * Public, sanitized view of the chat-channel configuration for the
 * super-admin badge-share rollup dashboard. Only exposes whether each
 * channel is configured — never the webhook URL or routing key — so a
 * UI render of this struct can't leak credentials into a screenshot.
 */
export interface BadgeShareRollupOpsAlertChatTargetsStatus {
  slackConfigured: boolean;
  pagerDutyConfigured: boolean;
}

export function getBadgeShareRollupOpsAlertChatTargetsStatus(): BadgeShareRollupOpsAlertChatTargetsStatus {
  const { slackWebhook, pagerDutyRoutingKey } = getBadgeShareRollupStaleChatTargets();
  return {
    slackConfigured: slackWebhook !== null,
    pagerDutyConfigured: pagerDutyRoutingKey !== null,
  };
}

export interface BadgeShareRollupOpsAlertChatTestResult {
  /** Whether each channel was configured at the moment the test fired. */
  targets: BadgeShareRollupOpsAlertChatTargetsStatus;
  /** Per-channel outcome — `attempted` is true only when the channel
   *  was configured at fire time; `ok` reflects whether the send
   *  resolved without throwing; `error` carries the message text on
   *  failure (already warn-logged at the dispatch site). */
  slack: { configured: boolean; attempted: boolean; ok: boolean; error: string | null };
  pagerDuty: { configured: boolean; attempted: boolean; ok: boolean; error: string | null };
}

/**
 * Fire a synthetic test page through both Slack and PagerDuty using
 * whichever of the dedicated / shared env vars are configured. Awaits
 * the senders so the super-admin route can return per-channel
 * success/failure to the dashboard. Uses zeroed-but-realistic summary
 * fields (mirrors watch-GPS test mode) so a downstream PagerDuty
 * consumer that reads `raw_events_waiting` can't mistake the test page
 * for a real stall — and the `isTest: true` flag does the visible
 * labelling on the headline / body / dedup key on both senders.
 */
export async function sendBadgeShareRollupOpsAlertTestPage(opts: {
  baseUrl?: string;
  now?: Date;
} = {}): Promise<BadgeShareRollupOpsAlertChatTestResult> {
  const now = opts.now ?? new Date();
  const { slackWebhook, pagerDutyRoutingKey } = getBadgeShareRollupStaleChatTargets();
  const cooldownHours = getBadgeShareRollupOpsAlertCooldownHours();
  const dashboardUrl =
    (opts.baseUrl ?? resolveBaseUrl()).replace(/\/$/, "") +
    "/super-admin/badge-share-rollup";
  const shared: BadgeShareRollupStaleChatOpts = {
    summary: {
      // Zero-valued so a downstream consumer can't mistake the test
      // payload for a real stall worth charting; the `isTest` flag /
      // copy do the labelling on both senders. `staleThresholdMs`
      // mirrors the 36h panel default so the rendered "Stale threshold"
      // field still reads sensibly even on a synthetic page.
      currentRawEventCount: 0,
      currentAggregateRowCount: 0,
      rollupAgeMs: 0,
      staleThresholdMs: 36 * 60 * 60 * 1000,
      lastRun: null,
    },
    cooldownHours,
    dashboardUrl,
    now,
    isTest: true,
  };

  const result: BadgeShareRollupOpsAlertChatTestResult = {
    targets: {
      slackConfigured: slackWebhook !== null,
      pagerDutyConfigured: pagerDutyRoutingKey !== null,
    },
    slack: { configured: slackWebhook !== null, attempted: false, ok: false, error: null },
    pagerDuty: {
      configured: pagerDutyRoutingKey !== null,
      attempted: false,
      ok: false,
      error: null,
    },
  };

  const tasks: Promise<void>[] = [];
  if (slackWebhook) {
    result.slack.attempted = true;
    tasks.push(
      postBadgeShareRollupStaleOpsAlertSlack({ webhookUrl: slackWebhook, ...shared })
        .then(() => {
          result.slack.ok = true;
        })
        .catch((err: unknown) => {
          result.slack.ok = false;
          result.slack.error = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err, opsAlertWiringTest: true },
            "[ops-alert] failed to post badge-share rollup stale ops alert to Slack",
          );
        }),
    );
  }
  if (pagerDutyRoutingKey) {
    result.pagerDuty.attempted = true;
    tasks.push(
      triggerBadgeShareRollupStaleOpsAlertPagerDuty({
        routingKey: pagerDutyRoutingKey,
        ...shared,
      })
        .then(() => {
          result.pagerDuty.ok = true;
        })
        .catch((err: unknown) => {
          result.pagerDuty.ok = false;
          result.pagerDuty.error = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err, opsAlertWiringTest: true },
            "[ops-alert] failed to trigger badge-share rollup stale ops alert on PagerDuty",
          );
        }),
    );
  }
  await Promise.all(tasks);
  return result;
}
