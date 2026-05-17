/**
 * Auto-page on-call when the swing-video fps-probe queue accumulates
 * persistent `failed` rows (Task #1704).
 *
 * Background — Task #1217 made the fps-probe queue durable in
 * `swing_video_fps_probes` (one row per swing video). Task #1412 added
 * a daily retention sweep that deletes `done` rows older than ~30 days
 * but intentionally retains `failed` rows so persistent failures stay
 * visible to operators. The sweep already returns a `failedRetained`
 * count, but until now nothing surfaced it: a slow accumulation of
 * failed probes (e.g. caused by a bad ffprobe deploy, or a storage
 * outage that silently corrupted some objects) only showed up in the
 * daily cron log line and would otherwise pile up forever.
 *
 * This module closes the loop. The daily retention sweep now also
 * invokes `runFpsProbeFailureOpsAlertJob`, which:
 *
 *   - Pages on-call (super-admin emails ∪ `OPS_ALERT_EMAILS`) when the
 *     observed `failed` row count meets or exceeds the configured
 *     threshold (`OPS_FPS_PROBE_FAILED_THRESHOLD`, default 25).
 *
 *   - Embeds a sample of the most recent failed rows — `swing_video_id`
 *     plus the captured `error_message` and `completed_at` — so the
 *     email is actionable on its own without the recipient having to
 *     SSH into the DB.
 *
 *   - Honours an in-process cooldown (`OPS_FPS_PROBE_FAILED_COOLDOWN_HOURS`,
 *     default 24h) so a sustained backlog stays at one page per day per
 *     replica. Matches the dedup semantics of every other ops-alert
 *     module — a process restart can re-page once inside the cooldown,
 *     which is preferable to losing the page entirely if the only
 *     replica that knew about the cooldown crashed mid-incident.
 *
 * Recipients: union of every super_admin in `app_users` with a non-null
 * email AND the on-call list parsed from `OPS_ALERT_EMAILS`. Mirrors
 * `manualEntryAlertHealthOpsAlert` and `badgeShareRollupOpsAlert` so
 * on-call only ever has to configure one address.
 *
 * Configuration (env, all optional):
 *   - `OPS_FPS_PROBE_FAILED_THRESHOLD`        default 25
 *   - `OPS_FPS_PROBE_FAILED_COOLDOWN_HOURS`   default 24
 *   - `OPS_FPS_PROBE_FAILED_SAMPLE_SIZE`      default 10
 *   - `OPS_ALERT_EMAILS`                      comma-separated on-call list
 *   - `APP_BASE_URL` / `PUBLIC_BASE_URL`      used to build the
 *                                             dashboard deep-link
 */
import {
  appUsersTable,
  db,
  swingVideoFpsProbesTable,
} from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendSwingFpsProbeFailureOpsAlertEmail } from "./mailer";
import {
  postSwingFpsProbeFailureOpsAlertSlack,
  resolveOpsAlertChatTargets,
  triggerSwingFpsProbeFailureOpsAlertPagerDuty,
  type OpsAlertChatTargets,
  type SwingFpsProbeFailureChatOpts,
} from "./opsAlertChat";

import {
  DEFAULT_OPS_FPS_PROBE_FAILED_THRESHOLD,
  DEFAULT_OPS_FPS_PROBE_FAILED_COOLDOWN_HOURS,
  DEFAULT_OPS_FPS_PROBE_FAILED_SAMPLE_SIZE,
  DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_DELTA,
  DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_LOOKBACK_HOURS,
} from "./swingFpsProbeFailureOpsAlert.constants";
export {
  DEFAULT_OPS_FPS_PROBE_FAILED_THRESHOLD,
  DEFAULT_OPS_FPS_PROBE_FAILED_COOLDOWN_HOURS,
  DEFAULT_OPS_FPS_PROBE_FAILED_SAMPLE_SIZE,
  DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_DELTA,
  DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_LOOKBACK_HOURS,
} from "./swingFpsProbeFailureOpsAlert.constants";

/**
 * One row in the "recent failures" sample we embed in the alert email
 * so the recipient can start triaging without having to query the DB.
 * Kept structurally simple (plain primitives, ISO strings) so it can be
 * shoved straight into the email template.
 */
export interface FpsProbeFailureSample {
  swingVideoId: number;
  /** ISO timestamp the probe row was last updated to its terminal
   * `failed` state, or null if never set (defensive — column is
   * nullable in the schema even though `recordFpsProbeFailure` always
   * stamps it). */
  completedAt: string | null;
  /** Truncated error message captured by `recordFpsProbeFailure`. */
  errorMessage: string | null;
}

export interface RunFpsProbeFailureOpsAlertOpts {
  /**
   * Override the alert threshold. When unset, falls back to
   * `OPS_FPS_PROBE_FAILED_THRESHOLD` env var, then the hardcoded
   * default.
   */
  threshold?: number;
  /** Override the cooldown in hours. Same fallback chain as above. */
  cooldownHours?: number;
  /** Override the recent-failures sample size in the email. */
  sampleSize?: number;
  /**
   * Override the growth trigger delta — the minimum number of *new*
   * `failed` rows in the lookback window that fires the growth-based
   * alert independently of the absolute threshold. Falls back to
   * `OPS_FPS_PROBE_FAILED_GROWTH_DELTA` then the hardcoded default.
   */
  growthDelta?: number;
  /**
   * Override the lookback window (hours) the growth trigger compares
   * against. Falls back to `OPS_FPS_PROBE_FAILED_GROWTH_LOOKBACK_HOURS`
   * then the hardcoded default.
   */
  growthLookbackHours?: number;
  /**
   * The current `failed` row count, as observed by the caller (the
   * daily retention sweep already counts it). Required so we don't
   * issue a duplicate `count(*)` query — the sweep just queried it.
   * Tests can pass any value here.
   */
  failedRetained: number;
  /**
   * Override the growth count (number of `failed` rows whose
   * `updated_at` is inside the lookback window). When unset, computed
   * from the DB. Tests can inject a deterministic value to avoid
   * seeding rows.
   */
  growthCountOverride?: number;
  /**
   * Override the recipient list. When unset, the union of all
   * super_admin emails and `OPS_ALERT_EMAILS` is used.
   */
  recipients?: string[];
  /** Override the deep-link base URL. */
  baseUrl?: string;
  /**
   * Override the recent-failures sample loader (used by tests so they
   * don't have to seed the DB to assert on the email payload).
   */
  recentFailuresOverride?: FpsProbeFailureSample[];
  /** Bypass the cooldown (used by tests / manual triggers). */
  force?: boolean;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

/**
 * Why the alert fired. Both flags can be true on the same run when a
 * sustained backlog is also still actively growing — we still send a
 * single email but flag both reasons in the structured result so a
 * dashboard can render "absolute threshold + growth" instead of having
 * to pick one.
 */
export interface FpsProbeFailureAlertTrigger {
  thresholdBreached: boolean;
  growthBreached: boolean;
}

export interface RunFpsProbeFailureOpsAlertResult {
  alerted: boolean;
  reason?:
    | "below_threshold"
    | "in_cooldown"
    | "no_recipients"
    | "send_failed";
  failedRetained: number;
  threshold: number;
  cooldownHours: number;
  sampleSize: number;
  /** Number of `failed` rows whose `updated_at` is inside the lookback
   *  window (i.e. the run-over-run growth signal). */
  growthCount: number;
  /** Configured minimum growth that triggers the growth alert. */
  growthDelta: number;
  /** Configured lookback window (hours) for the growth signal. */
  growthLookbackHours: number;
  /** Both trigger flags. Populated even on no-alert results so callers
   *  / tests can assert on what the gate evaluated. */
  trigger: FpsProbeFailureAlertTrigger;
  recentFailures: FpsProbeFailureSample[];
  recipientsAttempted: number;
  recipientsEmailed: number;
}

let lastAlertedAtMs: number | null = null;

/** Test-only: reset in-process cooldown state. */
export function _resetFpsProbeFailureOpsAlertDedupForTest(): void {
  lastAlertedAtMs = null;
}

/**
 * Resolve the env-driven Slack webhook + PagerDuty routing key targets
 * for the swing fps-probe failure backlog alert (Task #2123).
 *
 * Lookup order — same shared-fallback shape every `OPS_ALERT_EMAILS`
 * flow uses:
 *   1. `OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK` /
 *      `OPS_FPS_PROBE_FAILED_PAGERDUTY_ROUTING_KEY` — dedicated, lets
 *      ops route this signal to a focused channel without re-routing
 *      every other ops alert.
 *   2. `OPS_ALERT_SLACK_WEBHOOK` / `OPS_ALERT_PAGERDUTY_ROUTING_KEY` —
 *      shared fallback, the same pair every other paging ops alert
 *      (notify-retry exhaustion, badge-share rollup stale, manual-entry
 *      alert health, watch GPS spike) defaults to. Most deploys will
 *      only ever set this pair.
 */
function getSwingFpsProbeFailureChatTargets(): OpsAlertChatTargets {
  return resolveOpsAlertChatTargets({
    slackEnvVar: "OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK",
    pagerDutyEnvVar: "OPS_FPS_PROBE_FAILED_PAGERDUTY_ROUTING_KEY",
  });
}

/**
 * Fire-and-forget dispatch of the swing fps-probe failure backlog ops
 * alert to Slack and/or PagerDuty (Task #2123). Mirrors the per-channel
 * try/catch + warn-log pattern used by the badge-share rollup stale and
 * notification-retry exhaustion dispatchers:
 *   - A missing-config (no chat target set anywhere) emits one warn log
 *     and returns — the email branch already handles its own
 *     "no recipients" warn for the email-only flow.
 *   - Per-channel try/catch so a Slack outage doesn't suppress the
 *     PagerDuty trigger and vice versa.
 *   - Independent of the email recipient list and email send success,
 *     so a Slack page still goes out even if the SMTP provider is the
 *     thing that's down.
 */
function dispatchSwingFpsProbeFailureChat(
  opts: SwingFpsProbeFailureChatOpts,
): void {
  const { slackWebhook, pagerDutyRoutingKey } = getSwingFpsProbeFailureChatTargets();
  if (!slackWebhook && !pagerDutyRoutingKey) {
    logger.warn(
      {
        failedRetained: opts.failedRetained,
        threshold: opts.threshold,
        growthCount: opts.growthCount,
        growthDelta: opts.growthDelta,
        trigger: opts.trigger,
      },
      "[ops-alert] swing fps-probe failure backlog crossed threshold but no chat target configured (set OPS_FPS_PROBE_FAILED_SLACK_WEBHOOK / OPS_FPS_PROBE_FAILED_PAGERDUTY_ROUTING_KEY, or the shared OPS_ALERT_SLACK_WEBHOOK / OPS_ALERT_PAGERDUTY_ROUTING_KEY); skipping ops chat page",
    );
    return;
  }
  if (slackWebhook) {
    void postSwingFpsProbeFailureOpsAlertSlack({
      webhookUrl: slackWebhook,
      ...opts,
    }).catch((err: unknown) => {
      logger.warn(
        { err },
        "[ops-alert] failed to post swing fps-probe failure ops alert to Slack",
      );
    });
  }
  if (pagerDutyRoutingKey) {
    void triggerSwingFpsProbeFailureOpsAlertPagerDuty({
      routingKey: pagerDutyRoutingKey,
      ...opts,
    }).catch((err: unknown) => {
      logger.warn(
        { err },
        "[ops-alert] failed to trigger swing fps-probe failure ops alert on PagerDuty",
      );
    });
  }
}

/**
 * Test helper — exposes the env-driven chat-target resolver so unit
 * tests can cover the dedicated → shared fallback order without
 * touching the DB.
 */
export function _resolveSwingFpsProbeFailureChatTargetsForTests(): OpsAlertChatTargets {
  return getSwingFpsProbeFailureChatTargets();
}

/**
 * Test helper — exposes the chat dispatcher so unit tests can drive
 * the chat path directly (no DB / mailer setup needed).
 */
export function _dispatchSwingFpsProbeFailureChatForTests(
  opts: SwingFpsProbeFailureChatOpts,
): void {
  dispatchSwingFpsProbeFailureChat(opts);
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
 * Pull the most recent `failed` probe rows so the alert email has
 * actionable swing_video_id + error_message data. Ordered by
 * `updatedAt DESC` because that's the column `recordFpsProbeFailure`
 * always stamps when transitioning a row to `failed` (every other
 * timestamp on the row is nullable / non-monotonic).
 */
export async function loadRecentFpsProbeFailures(
  limit: number,
): Promise<FpsProbeFailureSample[]> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const rows = await db
    .select({
      swingVideoId: swingVideoFpsProbesTable.swingVideoId,
      completedAt: swingVideoFpsProbesTable.completedAt,
      errorMessage: swingVideoFpsProbesTable.errorMessage,
    })
    .from(swingVideoFpsProbesTable)
    .where(eq(swingVideoFpsProbesTable.status, "failed"))
    .orderBy(desc(swingVideoFpsProbesTable.updatedAt))
    .limit(safeLimit);
  return rows.map((r) => ({
    swingVideoId: r.swingVideoId,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    errorMessage: r.errorMessage,
  }));
}

/**
 * Count `failed` probe rows whose `updated_at` is at or after `since`
 * — i.e. how many *new* failures piled up inside the lookback window.
 *
 * This is the "growth since last run" signal. Because the retention
 * sweep never deletes `failed` rows (Task #1412) and
 * `recordFpsProbeFailure` is the only writer that produces this state
 * and always stamps `updated_at` on the transition, this query is
 * mathematically equal to `currentFailedRetained - failedRetainedAtSince`
 * — i.e. the run-over-run delta — without needing to persist last-run
 * stats anywhere. Stateless by design so the check survives process
 * restarts and replicas trivially.
 */
export async function loadFpsProbeFailureGrowthCount(
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(swingVideoFpsProbesTable)
    .where(
      and(
        eq(swingVideoFpsProbesTable.status, "failed"),
        gte(swingVideoFpsProbesTable.updatedAt, since),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Daily job: given the `failed` row count from the retention sweep,
 * decide whether the threshold is breached and, if so, page on-call.
 * Returns a structured result so cron / tests can assert on the
 * outcome without scraping logs.
 */
export async function runFpsProbeFailureOpsAlertJob(
  opts: RunFpsProbeFailureOpsAlertOpts,
): Promise<RunFpsProbeFailureOpsAlertResult> {
  const now = opts.now ?? new Date();

  const threshold =
    opts.threshold ??
    parseEnvNumber(
      "OPS_FPS_PROBE_FAILED_THRESHOLD",
      DEFAULT_OPS_FPS_PROBE_FAILED_THRESHOLD,
    );
  const cooldownHours =
    opts.cooldownHours ??
    parseEnvNumber(
      "OPS_FPS_PROBE_FAILED_COOLDOWN_HOURS",
      DEFAULT_OPS_FPS_PROBE_FAILED_COOLDOWN_HOURS,
    );
  const sampleSize =
    opts.sampleSize ??
    parseEnvNumber(
      "OPS_FPS_PROBE_FAILED_SAMPLE_SIZE",
      DEFAULT_OPS_FPS_PROBE_FAILED_SAMPLE_SIZE,
    );
  const growthDelta =
    opts.growthDelta ??
    parseEnvNumber(
      "OPS_FPS_PROBE_FAILED_GROWTH_DELTA",
      DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_DELTA,
    );
  const growthLookbackHours =
    opts.growthLookbackHours ??
    parseEnvNumber(
      "OPS_FPS_PROBE_FAILED_GROWTH_LOOKBACK_HOURS",
      DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_LOOKBACK_HOURS,
    );

  // Growth signal — count `failed` rows that landed inside the
  // lookback window. Computed before the gates because it's also a
  // primary trigger and needs to be present in the structured result
  // even when the absolute threshold is not breached. Stateless query
  // (see `loadFpsProbeFailureGrowthCount` rationale) so it survives
  // restarts / replicas without needing a persisted "last observed"
  // counter.
  const growthSince = new Date(
    now.getTime() - growthLookbackHours * 60 * 60 * 1000,
  );
  const growthCount =
    opts.growthCountOverride ??
    (await loadFpsProbeFailureGrowthCount(growthSince));

  const thresholdBreached = opts.failedRetained >= threshold;
  const growthBreached = growthCount >= growthDelta;
  const trigger: FpsProbeFailureAlertTrigger = {
    thresholdBreached,
    growthBreached,
  };

  const baseResult: Omit<
    RunFpsProbeFailureOpsAlertResult,
    "alerted" | "reason" | "recipientsAttempted" | "recipientsEmailed" | "recentFailures"
  > = {
    failedRetained: opts.failedRetained,
    threshold,
    cooldownHours,
    sampleSize,
    growthCount,
    growthDelta,
    growthLookbackHours,
    trigger,
  };

  // Below both triggers — no alert, nothing more to do.
  if (!thresholdBreached && !growthBreached) {
    return {
      ...baseResult,
      alerted: false,
      reason: "below_threshold",
      recentFailures: [],
      recipientsAttempted: 0,
      recipientsEmailed: 0,
    };
  }

  // Cooldown gate — keep a sustained backlog to one page per cooldown
  // window. `force` lets manual triggers / tests bypass. Applies to
  // both the threshold and growth triggers so a sustained-and-growing
  // backlog still pages at most once per cooldown window.
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  if (
    !opts.force &&
    lastAlertedAtMs != null &&
    now.getTime() - lastAlertedAtMs < cooldownMs
  ) {
    return {
      ...baseResult,
      alerted: false,
      reason: "in_cooldown",
      recentFailures: [],
      recipientsAttempted: 0,
      recipientsEmailed: 0,
    };
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

  // Load the recent-failures sample even when there are no recipients,
  // so the structured result still carries actionable data for any
  // synchronous caller (e.g. a future "Send test alert" route or a
  // dashboard that wants to render the same payload). Also surfaced
  // inline in the Slack section / PagerDuty `custom_details` so the
  // chat page is actionable on its own without recipients having to
  // open the dashboard.
  const recentFailures =
    opts.recentFailuresOverride ?? (await loadRecentFpsProbeFailures(sampleSize));

  const dashboardUrl =
    (opts.baseUrl ?? resolveBaseUrl()).replace(/\/$/, "") +
    "/super-admin/swing-video-diagnostics";

  // Task #2123 — page on-call via Slack / PagerDuty so a sustained
  // backlog surfaces in the same channels as every other paging ops
  // alert (notify-retry exhaustion, badge-share rollup stale, etc.),
  // not just the daily email. Dispatched independently of the email
  // recipient list (a deploy might have only chat configured) and
  // independently of email send success (so a Slack page still goes
  // out even if the SMTP provider is the thing that's down). The
  // chat dispatcher logs its own warn when no chat target is set.
  //
  // Note on chat re-paging risk: the in-process cooldown stamp
  // (`lastAlertedAtMs`) is only set when the email branch succeeds
  // (`emailed > 0`). In a chat-only deploy (or one where SMTP is the
  // thing that's down), a second cron tick on the same UTC day would
  // re-enter this block and re-dispatch chat. This is acceptable
  // because the cron interval is 24h (so a same-day re-tick only
  // happens via process restart or manual force) AND the PagerDuty
  // `dedup_key` is itself UTC-date-scoped — PagerDuty collapses the
  // duplicate trigger into the same open incident on its side. Slack,
  // which has no equivalent dedup, would post a duplicate message in
  // that edge case; that is the price of keeping chat firing when
  // email is broken (the more important property). Matches the
  // documented dedup semantics of `notifyExhaustionOpsAlert`.
  dispatchSwingFpsProbeFailureChat({
    failedRetained: opts.failedRetained,
    threshold,
    cooldownHours,
    growthCount,
    growthDelta,
    growthLookbackHours,
    trigger,
    recentFailures,
    dashboardUrl,
    now,
  });

  if (recipients.length === 0) {
    logger.warn(
      {
        failedRetained: opts.failedRetained,
        threshold,
        growthCount,
        growthDelta,
        growthLookbackHours,
        trigger,
      },
      "[ops-alert] swing fps-probe failure backlog crossed threshold but no super_admin or OPS_ALERT_EMAILS recipient is configured; skipping email",
    );
    return {
      ...baseResult,
      alerted: false,
      reason: "no_recipients",
      recentFailures,
      recipientsAttempted: 0,
      recipientsEmailed: 0,
    };
  }

  let emailed = 0;
  for (const to of recipients) {
    try {
      await sendSwingFpsProbeFailureOpsAlertEmail({
        to,
        failedRetained: opts.failedRetained,
        threshold,
        cooldownHours,
        growthCount,
        growthDelta,
        growthLookbackHours,
        trigger,
        recentFailures,
        dashboardUrl,
        now,
      });
      emailed += 1;
    } catch (err) {
      logger.warn(
        { err, to },
        "[ops-alert] failed to send swing fps-probe failure ops alert email",
      );
    }
  }

  if (emailed > 0) {
    lastAlertedAtMs = now.getTime();
    logger.warn(
      {
        failedRetained: opts.failedRetained,
        threshold,
        growthCount,
        growthDelta,
        growthLookbackHours,
        trigger,
        recipientsEmailed: emailed,
      },
      "[ops-alert] swing fps-probe failure backlog above threshold — ops paged",
    );
    return {
      ...baseResult,
      alerted: true,
      recentFailures,
      recipientsAttempted: recipients.length,
      recipientsEmailed: emailed,
    };
  }

  return {
    ...baseResult,
    alerted: false,
    reason: "send_failed",
    recentFailures,
    recipientsAttempted: recipients.length,
    recipientsEmailed: 0,
  };
}
