/**
 * Ops alert for retry-exhausted notification rows (Task #1130).
 *
 * Task #967 added a bounded retry cron for coach payout-paid push/SMS
 * notifications. Once a row hits its per-channel cap the cron stamps
 * `pushRetryExhaustedAt` / `smsRetryExhaustedAt` and stops retrying.
 * Without an alert path a systemic outage (FCM key revoked, Twilio
 * suspended, `SMS_PROVIDER` unset in prod) would silently strand
 * coach payout notifications without anyone noticing.
 *
 * This module runs on the cron (daily by default) and:
 *   - Counts rows in `coach_payout_notification_attempts` with a recent
 *     `pushRetryExhaustedAt` or `smsRetryExhaustedAt` (default window 24h).
 *   - Same for `member_levy_receipt_attempts` (Task #1130 — parity with
 *     the existing levy-receipt retry pipeline).
 *   - When the combined count clears the configured threshold, sends a
 *     single ops alert email summarising the breakdown so engineers can
 *     investigate the outage instead of waiting for individual member
 *     complaints.
 *
 * Configuration:
 *   - `OPS_ALERT_EMAILS` (env) — comma-separated recipient list.
 *   - Threshold + lookback window are tunable per environment WITHOUT a
 *     redeploy via the singleton `ops_alert_settings` row managed by the
 *     super-admin UI (Task #1305). When the row leaves a column NULL we
 *     fall back to `OPS_NOTIFY_EXHAUSTION_THRESHOLD` /
 *     `OPS_NOTIFY_EXHAUSTION_WINDOW_HOURS`, and when those are unset the
 *     hardcoded defaults below kick in. See `./opsAlertSettings.ts` for
 *     the resolver.
 *
 * Dedup: in-process — `lastAlertedDateUtc` is compared against today's
 * UTC date. A process restart can re-send today's alert at most once,
 * which is acceptable (and matches the noise floor of the existing
 * daily digests). Suppression on zero-count days means quiet days never
 * burn a dedup stamp, so a fresh outage tomorrow still alerts.
 */
import {
  db,
  coachPayoutNotificationAttemptsTable,
  memberLevyReceiptAttemptsTable,
  type CoachPayoutNotificationAttempt,
  type MemberLevyReceiptAttempt,
} from "@workspace/db";
import { and, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import { sendNotifyRetryExhaustionOpsAlertEmail } from "./mailer";
import { logger } from "./logger";
import { resolveOpsAlertConfig, type ResolvedOpsAlertRecipients } from "./opsAlertSettings";
import { retryCoachPayoutPush, retryCoachPayoutSms, type CoachPayoutRetryResult } from "./coachPayoutNotify";
import { retryLevyReceiptPush, retryLevyReceiptSms, type LevyReceiptRetryResult } from "./levyReceiptNotify";
import {
  postNotifyRetryExhaustionOpsAlertSlack,
  triggerNotifyRetryExhaustionOpsAlertPagerDuty,
  resolveOpsAlertChatTargets,
  resolveOpsAlertChatTargetsStatus,
  type OpsAlertChatTargets,
  type OpsAlertChatTargetsStatus,
} from "./opsAlertChat";

import {
  DEFAULT_OPS_NOTIFY_EXHAUSTION_THRESHOLD,
  DEFAULT_OPS_NOTIFY_EXHAUSTION_WINDOW_HOURS,
} from "./notifyExhaustionOpsAlert.constants";
export {
  DEFAULT_OPS_NOTIFY_EXHAUSTION_THRESHOLD,
  DEFAULT_OPS_NOTIFY_EXHAUSTION_WINDOW_HOURS,
} from "./notifyExhaustionOpsAlert.constants";

export interface ExhaustionCounts {
  /** Per-channel: rows where push retries hit the cap in the window. */
  push: number;
  /** Per-channel: rows where SMS retries hit the cap in the window. */
  sms: number;
  /**
   * Distinct rows with at least one channel exhausted in the window.
   * This is the row-count metric used for thresholding so a single row
   * that fails both push and SMS counts as one incident, not two.
   */
  rows: number;
}

export interface NotifyExhaustionAlertSummary {
  windowHours: number;
  threshold: number;
  coachPayout: ExhaustionCounts;
  levyReceipt: ExhaustionCounts;
  /** Distinct exhausted rows across both pipelines. */
  totalRows: number;
}

/**
 * Count coach-payout attempts whose `pushRetryExhaustedAt` or
 * `smsRetryExhaustedAt` was stamped within the lookback window.
 *
 * `push` / `sms` are per-channel exhaustion counts (a row that
 * exhausted both channels contributes to both). `rows` is the distinct
 * row count — used for thresholding so we measure incident volume, not
 * channel volume.
 */
export async function countRecentlyExhaustedCoachPayoutNotifications(
  since: Date,
): Promise<ExhaustionCounts> {
  const [row] = await db
    .select({
      push: sql<number>`count(*) FILTER (WHERE ${coachPayoutNotificationAttemptsTable.pushRetryExhaustedAt} >= ${since})`.mapWith(Number),
      sms: sql<number>`count(*) FILTER (WHERE ${coachPayoutNotificationAttemptsTable.smsRetryExhaustedAt} >= ${since})`.mapWith(Number),
      rows: sql<number>`count(*)`.mapWith(Number),
    })
    .from(coachPayoutNotificationAttemptsTable)
    .where(or(
      gte(coachPayoutNotificationAttemptsTable.pushRetryExhaustedAt, since),
      gte(coachPayoutNotificationAttemptsTable.smsRetryExhaustedAt, since),
    ));
  return {
    push: row?.push ?? 0,
    sms: row?.sms ?? 0,
    rows: row?.rows ?? 0,
  };
}

/**
 * Mirror of {@link countRecentlyExhaustedCoachPayoutNotifications} for
 * the levy-receipt attempts table. Same semantics — an outage in the
 * shared push/SMS providers tends to surface in both pipelines, so
 * including levy-receipt parity keeps the ops alert in sync with the
 * underlying systemic failure.
 */
export async function countRecentlyExhaustedLevyReceiptNotifications(
  since: Date,
): Promise<ExhaustionCounts> {
  const [row] = await db
    .select({
      push: sql<number>`count(*) FILTER (WHERE ${memberLevyReceiptAttemptsTable.pushRetryExhaustedAt} >= ${since})`.mapWith(Number),
      sms: sql<number>`count(*) FILTER (WHERE ${memberLevyReceiptAttemptsTable.smsRetryExhaustedAt} >= ${since})`.mapWith(Number),
      rows: sql<number>`count(*)`.mapWith(Number),
    })
    .from(memberLevyReceiptAttemptsTable)
    .where(or(
      gte(memberLevyReceiptAttemptsTable.pushRetryExhaustedAt, since),
      gte(memberLevyReceiptAttemptsTable.smsRetryExhaustedAt, since),
    ));
  return {
    push: row?.push ?? 0,
    sms: row?.sms ?? 0,
    rows: row?.rows ?? 0,
  };
}

/**
 * Returns the configured ops-alert recipient list so admin UIs can
 * show, alongside the history page, exactly which addresses would
 * have received a breach email. Exposed as its own helper so the
 * resolution rules stay in one place — duplicating the env parsing /
 * DB lookup in the route would risk the UI showing a different set
 * than the cron actually mailed.
 *
 * Task #1910 — converted to async + returns the full
 * {@link ResolvedOpsAlertRecipients} envelope so the
 * notify-exhaustion-history page can render an "org_override" badge
 * (and show the env-fallback list) when a super admin has stored a
 * DB override. The cron and the admin route both go through the same
 * resolver so they can never disagree on who gets paged.
 */
export async function getConfiguredOpsAlertRecipients(): Promise<ResolvedOpsAlertRecipients> {
  const cfg = await resolveOpsAlertConfig();
  return cfg.recipients;
}

/**
 * Resolve the env-driven Slack webhook + PagerDuty routing key targets
 * for the notification-retry exhaustion alert (Task #1652).
 *
 * Lookup order — same shared-fallback shape used by every
 * `OPS_ALERT_EMAILS` flow that pages humans:
 *   1. `OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK` /
 *      `OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY` — dedicated,
 *      lets ops route this signal to a focused channel without
 *      having to re-route every other ops alert.
 *   2. `OPS_ALERT_SLACK_WEBHOOK` / `OPS_ALERT_PAGERDUTY_ROUTING_KEY`
 *      — shared fallback, the same pair the watch GPS spike alert
 *      (Task #1374) uses. Most deploys will only ever set this pair.
 */
function getNotifyRetryExhaustionChatTargets(): OpsAlertChatTargets {
  return resolveOpsAlertChatTargets({
    slackEnvVar: "OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK",
    pagerDutyEnvVar: "OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY",
  });
}

/**
 * Public, sanitized view of the chat-channel configuration for the
 * super-admin Ops Alert card (Task #2057). Only exposes whether each
 * channel is configured — never the webhook URL or routing key — so a
 * UI render of this struct can't accidentally leak credentials into a
 * screenshot or browser console.
 */
export interface NotifyRetryExhaustionOpsAlertChatTargetsStatus {
  slackConfigured: boolean;
  pagerDutyConfigured: boolean;
}

export function getNotifyRetryExhaustionOpsAlertChatTargetsStatus(): NotifyRetryExhaustionOpsAlertChatTargetsStatus {
  const { slackWebhook, pagerDutyRoutingKey } = getNotifyRetryExhaustionChatTargets();
  return {
    slackConfigured: slackWebhook !== null,
    pagerDutyConfigured: pagerDutyRoutingKey !== null,
  };
}

/**
 * Fire-and-forget dispatch of the notification-retry exhaustion ops
 * alert to Slack and/or PagerDuty (Task #1652). Mirrors the per-channel
 * try/catch + warn-log pattern used by `dispatchTrendOpsAlertChat` in
 * `watchPositionMetrics.ts`:
 *   - A missing-config (no chat target set anywhere) emits one warn log
 *     and returns — the email branch already handled the
 *     "no recipients" warn for the email-only flow.
 *   - Per-channel try/catch so a Slack outage doesn't suppress the
 *     PagerDuty trigger and vice versa.
 *
 * Test pages (Task #1547) flow through the same dispatcher with
 * `isTest: true`; the chat helpers shape the message / PD severity /
 * dedup key so a test send never collapses onto a real incident.
 */
function dispatchNotifyRetryExhaustionChat(opts: {
  summary: NotifyExhaustionAlertSummary;
  since: Date;
  now: Date;
  isTest?: boolean;
}): void {
  const { slackWebhook, pagerDutyRoutingKey } = getNotifyRetryExhaustionChatTargets();
  if (!slackWebhook && !pagerDutyRoutingKey) {
    logger.warn(
      { summary: opts.summary, isTest: opts.isTest ?? false },
      "[ops-alert] notification retry exhaustion alert fired but no chat target configured (set OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK / OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY, or the shared OPS_ALERT_SLACK_WEBHOOK / OPS_ALERT_PAGERDUTY_ROUTING_KEY); skipping ops chat page",
    );
    return;
  }
  const shared = {
    summary: opts.summary,
    since: opts.since,
    now: opts.now,
    isTest: opts.isTest,
  };
  if (slackWebhook) {
    void postNotifyRetryExhaustionOpsAlertSlack({ webhookUrl: slackWebhook, ...shared }).catch(
      (err: unknown) => {
        logger.warn(
          { err, isTest: opts.isTest ?? false },
          "[ops-alert] failed to post notification retry exhaustion ops alert to Slack",
        );
      },
    );
  }
  if (pagerDutyRoutingKey) {
    void triggerNotifyRetryExhaustionOpsAlertPagerDuty({ routingKey: pagerDutyRoutingKey, ...shared }).catch(
      (err: unknown) => {
        logger.warn(
          { err, isTest: opts.isTest ?? false },
          "[ops-alert] failed to trigger notification retry exhaustion ops alert on PagerDuty",
        );
      },
    );
  }
}

/**
 * Test helper — exposes the env-driven chat-target resolver so unit
 * tests can cover the dedicated → shared fallback order without
 * filling the DB.
 */
export function _resolveNotifyRetryExhaustionChatTargetsForTests(): OpsAlertChatTargets {
  return getNotifyRetryExhaustionChatTargets();
}

/**
 * Sanitised view of which chat-channels are wired up for the
 * notification-retry exhaustion ops alert (Task #2055). Reads the
 * same env vars the dispatcher uses but never returns the webhook URL
 * or routing key, so the GET
 * `/super-admin/ops-alert-settings/chat-targets` endpoint can render a
 * "Slack ✓ (shared) / PagerDuty ✗" badge on the super-admin Ops Alert
 * card without leaking secrets to the browser.
 *
 * Per-channel `source` is `"dedicated"` when the per-flow env var is
 * set (e.g. `OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK`), `"shared"` when
 * only the shared fallback (`OPS_ALERT_SLACK_WEBHOOK`) is set, and
 * `null` when neither is set.
 */
export function getNotifyRetryExhaustionChatTargetsStatus(): OpsAlertChatTargetsStatus {
  return resolveOpsAlertChatTargetsStatus({
    slackEnvVar: "OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK",
    pagerDutyEnvVar: "OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY",
  });
}

/**
 * Test helper — exposes the chat dispatcher so unit tests can drive
 * the chat path directly (no DB / mailer setup needed).
 */
export function _dispatchNotifyRetryExhaustionChatForTests(opts: {
  summary: NotifyExhaustionAlertSummary;
  since: Date;
  now: Date;
  isTest?: boolean;
}): void {
  dispatchNotifyRetryExhaustionChat(opts);
}

/** UTC YYYY-MM-DD string used for daily in-process dedup. */
function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

let lastAlertedDateUtc: string | null = null;

/** Test-only: reset in-process dedup state. */
export function _resetNotifyExhaustionAlertDedupForTest(): void {
  lastAlertedDateUtc = null;
}

export interface RunNotifyExhaustionOpsAlertOpts {
  /** Override the lookback window (defaults to env / 24h). */
  windowHours?: number;
  /** Override the alert threshold (defaults to env / 5). */
  threshold?: number;
  /** Override recipient list (defaults to `OPS_ALERT_EMAILS`). */
  opsEmails?: string[];
  /** Bypass the daily dedup (used by tests / manual triggers). */
  force?: boolean;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /**
   * Task #1547 — manual delivery check from the super-admin dashboard.
   * When true:
   *   - The DB exhaustion counts are NOT consulted; a small synthetic
   *     summary is emitted instead so the email body is meaningful even
   *     when the system is healthy.
   *   - The threshold check is skipped (we always send if there are
   *     recipients).
   *   - The daily dedup is neither read nor written — sending a test
   *     must not silence today's real alert if one fires later.
   *   - The email itself is flagged `isTest:true` so the subject /
   *     banner make it obvious this is not a live incident.
   * `force` and `isTest` are independent flags; tests still use `force`.
   */
  isTest?: boolean;
  /**
   * Task #1917 — optional one-off recipient for the test alert. Only
   * honoured when `isTest` is true. When set:
   *   - The email is sent ONLY to this address (not OPS_ALERT_EMAILS),
   *     still flagged `isTest:true`.
   *   - Slack / PagerDuty chat dispatch is skipped — the admin is
   *     previewing the email on their own inbox; paging the team would
   *     defeat the purpose of the override.
   * Caller is responsible for validating the address; the job assumes
   * a syntactically valid email and does not re-validate.
   */
  overrideRecipient?: string | null;
}

export interface RunNotifyExhaustionOpsAlertResult {
  alerted: boolean;
  reason?: string;
  summary: NotifyExhaustionAlertSummary;
  recipients: number;
  /** True when this run was a manual delivery check (Task #1547). */
  isTest?: boolean;
}

/**
 * Synthetic exhaustion summary used by the "Send test alert" button.
 * Small non-zero counts so the email's per-pipeline breakdown table is
 * legible without implying a real outage. Kept here (rather than inline
 * in the route) so the constants travel with the rest of the alert
 * pipeline and can evolve together.
 */
function buildSyntheticTestSummary(windowHours: number, threshold: number): NotifyExhaustionAlertSummary {
  return {
    windowHours,
    threshold,
    coachPayout: { push: 1, sms: 1, rows: 1 },
    levyReceipt: { push: 1, sms: 0, rows: 1 },
    totalRows: 2,
  };
}

/**
 * Compute the exhaustion summary and, when above threshold, send the
 * ops alert email. Returns a structured result so cron / tests can
 * assert on the outcome without scraping logs.
 */
export async function runNotifyExhaustionOpsAlertJob(
  opts: RunNotifyExhaustionOpsAlertOpts = {},
): Promise<RunNotifyExhaustionOpsAlertResult> {
  const now = opts.now ?? new Date();

  // Resolve threshold + window from the DB-backed singleton row when the
  // caller hasn't pinned them explicitly (Task #1305 — admin-tunable
  // without a redeploy). The resolver internally falls back to the env
  // vars and then the hardcoded defaults so existing behaviour is
  // preserved on environments that haven't customised anything.
  let windowHours = opts.windowHours;
  let threshold = opts.threshold;
  let resolvedRecipients: ResolvedOpsAlertRecipients | null = null;
  if (windowHours === undefined || threshold === undefined || opts.opsEmails === undefined) {
    const cfg = await resolveOpsAlertConfig();
    if (windowHours === undefined) windowHours = cfg.windowHours;
    if (threshold === undefined) threshold = cfg.threshold;
    resolvedRecipients = cfg.recipients;
  }
  // Task #1910 — recipient list now flows through the same DB-then-env
  // resolver as the threshold/window so a super admin can edit the list
  // from the dashboard without a redeploy. The override is bypassed
  // whenever the caller pinned `opsEmails` explicitly (test paths /
  // future per-call overrides).
  const recipients = opts.opsEmails ?? resolvedRecipients?.effective ?? [];

  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  // Test path (Task #1547): skip the DB scan, threshold check, and dedup
  // — emit a synthetic summary so an admin can verify recipients are
  // reachable independently of whether any real exhaustions are
  // happening today. Crucially we DO NOT touch `lastAlertedDateUtc`,
  // so a test send cannot suppress today's real alert if one fires
  // later in the day.
  if (opts.isTest) {
    const summary = buildSyntheticTestSummary(windowHours, threshold);
    // Task #1917 — when the admin supplied a one-off override recipient,
    // route the email there only and skip chat dispatch entirely. The
    // override flow is explicitly "preview the email on my own inbox"
    // — paging the on-call Slack / PagerDuty channels at the same time
    // would defeat the point of avoiding the live OPS_ALERT_EMAILS list.
    const overrideRecipient = opts.overrideRecipient?.trim() || null;
    if (overrideRecipient) {
      try {
        await sendNotifyRetryExhaustionOpsAlertEmail({
          to: overrideRecipient,
          summary,
          since,
          now,
          isTest: true,
        });
        logger.info(
          { overrideRecipient },
          "[ops-alert] Test alert dispatched to override recipient",
        );
        return { alerted: true, summary, recipients: 1, isTest: true };
      } catch (err) {
        logger.warn(
          { err, to: overrideRecipient },
          "[ops-alert] Failed to send TEST notification-retry exhaustion ops alert email to override recipient",
        );
        return { alerted: false, summary, recipients: 0, isTest: true };
      }
    }
    // Task #1652 — also fire a TEST chat page so admins can verify the
    // Slack / PagerDuty wiring at the same time. Independent of the
    // email recipient list (a deploy might have only chat configured).
    // The chat dispatcher's own warn-log handles the
    // "no chat target configured" case.
    dispatchNotifyRetryExhaustionChat({ summary, since, now, isTest: true });
    if (recipients.length === 0) {
      logger.warn(
        { summary },
        "[ops-alert] Test alert requested but OPS_ALERT_EMAILS is unset; skipping email",
      );
      return { alerted: false, reason: "no_recipients", summary, recipients: 0, isTest: true };
    }
    let sent = 0;
    for (const to of recipients) {
      try {
        await sendNotifyRetryExhaustionOpsAlertEmail({ to, summary, since, now, isTest: true });
        sent += 1;
      } catch (err) {
        logger.warn(
          { err, to },
          "[ops-alert] Failed to send TEST notification-retry exhaustion ops alert email",
        );
      }
    }
    logger.info(
      { recipients: sent, requested: recipients.length },
      "[ops-alert] Test alert dispatched",
    );
    return { alerted: sent > 0, summary, recipients: sent, isTest: true };
  }

  const [coachPayout, levyReceipt] = await Promise.all([
    countRecentlyExhaustedCoachPayoutNotifications(since),
    countRecentlyExhaustedLevyReceiptNotifications(since),
  ]);

  const summary: NotifyExhaustionAlertSummary = {
    windowHours,
    threshold,
    coachPayout,
    levyReceipt,
    totalRows: coachPayout.rows + levyReceipt.rows,
  };

  if (summary.totalRows < threshold) {
    return { alerted: false, reason: "below_threshold", summary, recipients: 0 };
  }

  // Daily dedup: if we've already alerted today, suppress. A non-zero
  // day that we already flagged is still an open incident — engineers
  // are looking at it; another email isn't useful. Reset on a new UTC
  // day so a fresh outage on day N+1 always triggers. The chat dispatch
  // below shares this gate so a sustained spike pages on chat at most
  // once per UTC day per replica too (mirroring the email cadence).
  //
  // Note on chat re-paging risk: the in-process dedup stamp
  // (`lastAlertedDateUtc`) is only set when the email branch
  // succeeds (`sent > 0`). In a chat-only deploy (or one where SMTP
  // is the thing that's down), a second cron tick on the same UTC
  // day would re-enter this block and re-dispatch chat. This is
  // acceptable because the cron interval is 24h (so a same-day re-tick
  // only happens via process restart or manual force) AND the
  // PagerDuty `dedup_key` is itself UTC-date-scoped — PagerDuty
  // collapses the duplicate trigger into the same open incident on
  // its side. Slack, which has no equivalent dedup, would post a
  // duplicate message in that edge case; that is the price of keeping
  // chat firing when email is broken (the more important property).
  const todayKey = utcDateKey(now);
  if (!opts.force && lastAlertedDateUtc === todayKey) {
    return { alerted: false, reason: "already_alerted_today", summary, recipients: 0 };
  }

  // Task #1652 — page on-call via Slack / PagerDuty so an outage
  // surfaces faster than the daily email. Independent of the email
  // recipient list (a deploy might have only chat configured) and
  // independent of email send success, so a Slack page still goes out
  // even if the SMTP provider is the thing that's down. The chat
  // dispatcher logs its own warn when no chat target is set.
  //
  // The job's return shape (`alerted` / `recipients`) intentionally
  // continues to reflect email outcomes only. Its sole consumer is
  // the super-admin "Send test alert" button (POST
  // `/super-admin/ops-alert-settings/test`), whose UI is explicitly
  // about confirming the email recipient list — broadening these
  // fields to mean "any page sent" would change that endpoint's
  // semantics. A future task (follow-up #2055 — surface chat
  // configuration on the super-admin Ops Alert card) is a better
  // place to expose chat-delivery status to the UI.
  dispatchNotifyRetryExhaustionChat({ summary, since, now });

  if (recipients.length === 0) {
    logger.warn(
      { summary },
      "[ops-alert] Notification retries exhausted above threshold but OPS_ALERT_EMAILS is unset; skipping email",
    );
    return { alerted: false, reason: "no_recipients", summary, recipients: 0 };
  }

  let sent = 0;
  for (const to of recipients) {
    try {
      await sendNotifyRetryExhaustionOpsAlertEmail({ to, summary, since, now });
      sent += 1;
    } catch (err) {
      logger.warn(
        { err, to },
        "[ops-alert] Failed to send notification-retry exhaustion ops alert email",
      );
    }
  }

  if (sent > 0) {
    lastAlertedDateUtc = todayKey;
    logger.warn(
      { summary, recipients: sent },
      "[ops-alert] Notification retry exhaustion threshold breached — ops alerted",
    );
  }

  return { alerted: sent > 0, summary, recipients: sent };
}

// ─── Per-day history (Task #1304) ────────────────────────────────────────
//
// The cron above runs once a day, computes a single rolling-window summary,
// and emails it. To surface the same data in-app — so admins can see trends
// and confirm fixes without grepping email — we expose two read helpers:
//
//   • `getExhaustionHistoryByDay`: per-UTC-day aggregate of the same
//     `pushRetryExhaustedAt` / `smsRetryExhaustedAt` stamps the cron reads,
//     bucketed by the date the channel was marked exhausted. Each day
//     reports per-pipeline / per-channel counts and a `totalRows` distinct
//     row tally that mirrors the cron's threshold metric (one row that
//     fails both push + SMS counts as a single incident, not two).
//
//   • `listExhaustedRowsForDay`: drills into the rows behind one
//     (pipeline, channel, day) bucket so the admin UI can link triagers
//     to the affected coach payout / levy charge.
//
// We deliberately compute history on demand from the persisted exhaustion
// stamps rather than persisting a separate cron-run history table:
// the underlying columns already survive restarts, and computing on the
// fly guarantees the dashboard view stays consistent with whatever the
// next cron tick will see — including any operator-driven row resets.

export type ExhaustionPipeline = "coach_payout" | "levy_receipt";
export type ExhaustionChannel = "push" | "sms";

export interface ExhaustionDailyBucket {
  /** UTC YYYY-MM-DD date this bucket represents. */
  date: string;
  coachPayout: ExhaustionCounts;
  levyReceipt: ExhaustionCounts;
  /** Distinct exhausted rows across both pipelines for this UTC day. */
  totalRows: number;
  /**
   * Whether this day's `totalRows` met or exceeded the threshold the cron
   * uses — i.e. whether an ops-alert email would have fired for this day.
   * Lets the UI flag breaches at a glance so admins can see fix days drop
   * out of the alert band as they roll off.
   */
  alerted: boolean;
}

export interface ExhaustionRowSummary {
  id: number;
  organizationId: number;
  /** ISO timestamp the channel exhaustion was stamped. */
  exhaustedAt: string;
  /** UTC YYYY-MM-DD date the channel exhaustion was stamped. */
  date: string;
  /** Coach-payout pipeline only. */
  payoutId?: number;
  proId?: number;
  reference?: string | null;
  /** Levy-receipt pipeline only. */
  chargeId?: number;
  clubMemberId?: number;
  levyName?: string | null;
}

interface DailyChannelRow {
  day: string;
  push: number;
  sms: number;
  rows: number;
}

/**
 * Aggregate per-day counts of channel exhaustions for one pipeline table.
 *
 * Implemented as `UNION ALL` of one row per (id, channel) exhaustion event
 * within the lookback window, then bucketed by UTC day. `count(DISTINCT id)`
 * gives the row-count metric the cron's threshold uses (so a row exhausted
 * on both channels in the same day still counts as one incident for
 * `rows`, even though `push` and `sms` each tick to 1).
 *
 * Only one shape of query is needed for both pipelines because they share
 * the `pushRetryExhaustedAt` / `smsRetryExhaustedAt` column convention —
 * we just template in the table reference.
 */
async function aggregateDailyChannelCounts(
  table: typeof coachPayoutNotificationAttemptsTable | typeof memberLevyReceiptAttemptsTable,
  since: Date,
  organizationId: number | null,
): Promise<Map<string, DailyChannelRow>> {
  // Tenant scope: org_admin / tournament_director callers pass their
  // own organizationId so they only see exhaustions for their own org.
  // super_admin (and the cron itself) pass null for a platform-wide
  // view. Without this filter an org admin could otherwise see
  // exhaustion counts (and, via the rows endpoint, ids) for other
  // clubs, which would be a tenant data leak.
  const orgFilterPush = organizationId == null
    ? sql``
    : sql` AND ${table.organizationId} = ${organizationId}`;
  const orgFilterSms = orgFilterPush;
  const result = await db.execute(sql`
    WITH events AS (
      SELECT id, 'push' AS channel,
        ${table.pushRetryExhaustedAt} AS event_at
      FROM ${table}
      WHERE ${table.pushRetryExhaustedAt} IS NOT NULL
        AND ${table.pushRetryExhaustedAt} >= ${since}${orgFilterPush}
      UNION ALL
      SELECT id, 'sms' AS channel,
        ${table.smsRetryExhaustedAt} AS event_at
      FROM ${table}
      WHERE ${table.smsRetryExhaustedAt} IS NOT NULL
        AND ${table.smsRetryExhaustedAt} >= ${since}${orgFilterSms}
    )
    SELECT
      to_char(date_trunc('day', event_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
      COUNT(*) FILTER (WHERE channel = 'push')::int AS push,
      COUNT(*) FILTER (WHERE channel = 'sms')::int AS sms,
      COUNT(DISTINCT id)::int AS rows
    FROM events
    GROUP BY 1
  `);

  // Drizzle's pg execute returns either a `{ rows: [...] }` shape (node-pg)
  // or the array directly (neon-http). Accept both for portability.
  type Row = { day: string; push: number | string; sms: number | string; rows: number | string };
  const rows: Row[] =
    (result as unknown as { rows?: Row[] }).rows
    ?? (result as unknown as Row[])
    ?? [];

  const out = new Map<string, DailyChannelRow>();
  for (const row of rows) {
    out.set(row.day, {
      day: row.day,
      push: Number(row.push) || 0,
      sms: Number(row.sms) || 0,
      rows: Number(row.rows) || 0,
    });
  }
  return out;
}

/** UTC midnight Date for the start of the day N days ago (inclusive). */
function utcDayStart(now: Date, daysAgo: number): Date {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysAgo,
  ));
}

export interface GetExhaustionHistoryOpts {
  /** Number of past UTC days to include (including today). Default 30, max 90. */
  days?: number;
  /** Override the alerting threshold (defaults to env / 5). */
  threshold?: number;
  /** Override "now" for deterministic tests. */
  now?: Date;
  /**
   * Restrict counts to a single organization. Required when an org admin
   * calls this so they only see their own club's data. Pass `null` for
   * the platform-wide view (super_admin, cron).
   */
  organizationId?: number | null;
}

/**
 * Returns the per-UTC-day exhaustion history for the last `days` days
 * (default 30, max 90), oldest day first. Days with no exhaustions are
 * still emitted (with zeroed counts) so the UI can render a continuous
 * trend without gaps.
 */
export async function getExhaustionHistoryByDay(
  opts: GetExhaustionHistoryOpts = {},
): Promise<ExhaustionDailyBucket[]> {
  const now = opts.now ?? new Date();
  const requestedDays = opts.days ?? 30;
  const days = Math.max(1, Math.min(90, Math.floor(requestedDays)));
  // Resolve the alerting threshold the same way the cron does
  // (DB-backed singleton → env var → hardcoded default) so the
  // `alerted` flag the UI shows for each day matches what the cron
  // actually mailed for that day. Falls back to the hardcoded default
  // if the resolver ever throws (e.g. the migration hasn't run yet on
  // a brand-new env), which preserves the historical UI behaviour.
  let threshold = opts.threshold;
  if (threshold === undefined) {
    try {
      const cfg = await resolveOpsAlertConfig();
      threshold = cfg.threshold;
    } catch {
      const envRaw = process.env.OPS_NOTIFY_EXHAUSTION_THRESHOLD;
      const envParsed = envRaw ? parseInt(envRaw, 10) : NaN;
      threshold = Number.isFinite(envParsed) && envParsed > 0
        ? envParsed
        : DEFAULT_OPS_NOTIFY_EXHAUSTION_THRESHOLD;
    }
  }

  const since = utcDayStart(now, days - 1);
  const orgId = opts.organizationId ?? null;

  const [coachByDay, levyByDay] = await Promise.all([
    aggregateDailyChannelCounts(coachPayoutNotificationAttemptsTable, since, orgId),
    aggregateDailyChannelCounts(memberLevyReceiptAttemptsTable, since, orgId),
  ]);

  const buckets: ExhaustionDailyBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = utcDayStart(now, i);
    const date = dayStart.toISOString().slice(0, 10);
    const coach = coachByDay.get(date) ?? { day: date, push: 0, sms: 0, rows: 0 };
    const levy = levyByDay.get(date) ?? { day: date, push: 0, sms: 0, rows: 0 };
    const totalRows = coach.rows + levy.rows;
    buckets.push({
      date,
      coachPayout: { push: coach.push, sms: coach.sms, rows: coach.rows },
      levyReceipt: { push: levy.push, sms: levy.sms, rows: levy.rows },
      totalRows,
      alerted: totalRows >= threshold,
    });
  }
  return buckets;
}

export interface ListExhaustedRowsOpts {
  pipeline: ExhaustionPipeline;
  channel: ExhaustionChannel;
  /** UTC YYYY-MM-DD calendar date to filter on. */
  date: string;
  /** Cap returned rows. Default 100, max 500. */
  limit?: number;
  /**
   * Restrict rows to a single organization. Required when an org admin
   * calls this so they only see their own club's affected rows. Pass
   * `null` for the platform-wide view (super_admin only).
   */
  organizationId?: number | null;
}

/** Validate `YYYY-MM-DD` and return the UTC midnight Date, or null. */
function parseUtcDateOnly(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map((p) => parseInt(p, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  // Round-trip check rejects e.g. 2025-02-31.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt;
}

/**
 * Lists rows whose chosen channel was marked exhausted within the given
 * UTC day. Powers the admin drill-down: clicking a (pipeline, channel)
 * cell on a day surfaces the affected coach-payout / levy-receipt rows
 * so admins can jump to coach-admin or member-360 for triage.
 */
export async function listExhaustedRowsForDay(
  opts: ListExhaustedRowsOpts,
): Promise<ExhaustionRowSummary[]> {
  const dayStart = parseUtcDateOnly(opts.date);
  if (!dayStart) return [];
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));

  const orgId = opts.organizationId ?? null;

  if (opts.pipeline === "coach_payout") {
    const exhaustedCol = opts.channel === "push"
      ? coachPayoutNotificationAttemptsTable.pushRetryExhaustedAt
      : coachPayoutNotificationAttemptsTable.smsRetryExhaustedAt;
    const baseFilter = and(gte(exhaustedCol, dayStart), lt(exhaustedCol, dayEnd));
    const where = orgId == null
      ? baseFilter
      : and(baseFilter, eq(coachPayoutNotificationAttemptsTable.organizationId, orgId));
    const rows = await db
      .select({
        id: coachPayoutNotificationAttemptsTable.id,
        organizationId: coachPayoutNotificationAttemptsTable.organizationId,
        payoutId: coachPayoutNotificationAttemptsTable.payoutId,
        proId: coachPayoutNotificationAttemptsTable.proId,
        reference: coachPayoutNotificationAttemptsTable.reference,
        exhaustedAt: exhaustedCol,
      })
      .from(coachPayoutNotificationAttemptsTable)
      .where(where)
      .orderBy(desc(exhaustedCol))
      .limit(limit);
    return rows
      .filter((r) => r.exhaustedAt != null)
      .map((r) => ({
        id: r.id,
        organizationId: r.organizationId,
        exhaustedAt: (r.exhaustedAt as Date).toISOString(),
        date: opts.date,
        payoutId: r.payoutId,
        proId: r.proId,
        reference: r.reference,
      }));
  }

  const exhaustedCol = opts.channel === "push"
    ? memberLevyReceiptAttemptsTable.pushRetryExhaustedAt
    : memberLevyReceiptAttemptsTable.smsRetryExhaustedAt;
  const baseFilter = and(gte(exhaustedCol, dayStart), lt(exhaustedCol, dayEnd));
  const where = orgId == null
    ? baseFilter
    : and(baseFilter, eq(memberLevyReceiptAttemptsTable.organizationId, orgId));
  const rows = await db
    .select({
      id: memberLevyReceiptAttemptsTable.id,
      organizationId: memberLevyReceiptAttemptsTable.organizationId,
      chargeId: memberLevyReceiptAttemptsTable.chargeId,
      clubMemberId: memberLevyReceiptAttemptsTable.clubMemberId,
      levyName: memberLevyReceiptAttemptsTable.levyName,
      exhaustedAt: exhaustedCol,
    })
    .from(memberLevyReceiptAttemptsTable)
    .where(where)
    .orderBy(desc(exhaustedCol))
    .limit(limit);
  return rows
    .filter((r) => r.exhaustedAt != null)
    .map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      exhaustedAt: (r.exhaustedAt as Date).toISOString(),
      date: opts.date,
      chargeId: r.chargeId,
      clubMemberId: r.clubMemberId,
      levyName: r.levyName,
    }));
}

// ─── Admin actions on exhausted rows (Task #1542) ─────────────────────
//
// The history page shows admins the rows whose push/SMS retries the
// cron has stopped attempting. Without an in-page action they have to
// pivot into coach-admin or member-360 to do anything about it. The two
// helpers below let that drill-down expose:
//
//   • clearChannelExhaustion — wipe the `*RetryExhaustedAt` stamp so
//     the row drops out of the exhaustion history. Use this when the
//     underlying delivery problem has already been resolved by some
//     other means and the admin just wants to ack the alert.
//
//   • retryExhaustedChannel — wipe the exhaustion stamp, reset the
//     channel attempts counter back to zero and flip the channel
//     status back to `failed` so the existing retry helper accepts the
//     row, then immediately fire one retry. This lets an admin nudge a
//     stuck delivery from inside the history view; subsequent retries
//     are picked up by the normal retry cron because we left the row
//     in `failed` (when the manual retry doesn't succeed).
//
// Both helpers are tenant-scoped via `organizationId`: org_admin /
// tournament_director must pass their own org so they can never act on
// another club's rows. super_admin passes `null` for the platform-wide
// view used by the history page above.

export interface ExhaustionActionOpts {
  pipeline: ExhaustionPipeline;
  channel: ExhaustionChannel;
  attemptId: number;
  /**
   * Restrict the row lookup to a single organization. `null` means no
   * tenant scope (super_admin only). Org-bound admins must pass their
   * org id so a stray attemptId from another club is a 404 not a leak.
   */
  organizationId?: number | null;
}

export type ExhaustionAttemptRow =
  | (CoachPayoutNotificationAttempt & { _pipeline: "coach_payout" })
  | (MemberLevyReceiptAttempt & { _pipeline: "levy_receipt" });

export interface ExhaustionActionResult {
  pipeline: ExhaustionPipeline;
  channel: ExhaustionChannel;
  attemptId: number;
  /** True iff a row was found + updated (i.e. tenant-scoped lookup hit). */
  ok: boolean;
  /** Updated attempt row after the action. Null when no row matched. */
  attempt: ExhaustionAttemptRow | null;
  /**
   * For action="retry" — the dispatch outcome from the channel-specific
   * retry helper. `null` if the row was reset but the helper still
   * declined (e.g. SMS_PROVIDER_not_configured short-circuited it),
   * which we surface as `noopReason` so the UI can show why nothing
   * was sent.
   */
  retryResult?: CoachPayoutRetryResult | LevyReceiptRetryResult | null;
  noopReason?: string;
}

async function loadCoachAttempt(
  attemptId: number,
  organizationId: number | null,
): Promise<CoachPayoutNotificationAttempt | null> {
  const where = organizationId == null
    ? eq(coachPayoutNotificationAttemptsTable.id, attemptId)
    : and(
      eq(coachPayoutNotificationAttemptsTable.id, attemptId),
      eq(coachPayoutNotificationAttemptsTable.organizationId, organizationId),
    );
  const [row] = await db.select().from(coachPayoutNotificationAttemptsTable).where(where).limit(1);
  return row ?? null;
}

async function loadLevyAttempt(
  attemptId: number,
  organizationId: number | null,
): Promise<MemberLevyReceiptAttempt | null> {
  const where = organizationId == null
    ? eq(memberLevyReceiptAttemptsTable.id, attemptId)
    : and(
      eq(memberLevyReceiptAttemptsTable.id, attemptId),
      eq(memberLevyReceiptAttemptsTable.organizationId, organizationId),
    );
  const [row] = await db.select().from(memberLevyReceiptAttemptsTable).where(where).limit(1);
  return row ?? null;
}

/**
 * Clear the `<channel>RetryExhaustedAt` stamp on a single attempt row
 * so the row drops out of the exhaustion history. Returns `ok: false`
 * with `attempt: null` when the row is not visible to the caller —
 * either it does not exist or the org scope filtered it out. We do
 * NOT touch the channel status / attempts counter: the caller has
 * indicated the alert is acknowledged, not that the row should be
 * resent (that is what `retryExhaustedChannel` is for).
 */
export async function clearChannelExhaustion(
  opts: ExhaustionActionOpts,
): Promise<ExhaustionActionResult> {
  const orgId = opts.organizationId ?? null;
  if (opts.pipeline === "coach_payout") {
    const existing = await loadCoachAttempt(opts.attemptId, orgId);
    if (!existing) {
      return { pipeline: opts.pipeline, channel: opts.channel, attemptId: opts.attemptId, ok: false, attempt: null };
    }
    const patch = opts.channel === "push"
      ? { pushRetryExhaustedAt: null }
      : { smsRetryExhaustedAt: null };
    await db.update(coachPayoutNotificationAttemptsTable)
      .set(patch)
      .where(eq(coachPayoutNotificationAttemptsTable.id, existing.id));
    const updated = await loadCoachAttempt(existing.id, orgId);
    return {
      pipeline: opts.pipeline, channel: opts.channel, attemptId: opts.attemptId,
      ok: true,
      attempt: updated ? { ...updated, _pipeline: "coach_payout" } : null,
    };
  }

  const existing = await loadLevyAttempt(opts.attemptId, orgId);
  if (!existing) {
    return { pipeline: opts.pipeline, channel: opts.channel, attemptId: opts.attemptId, ok: false, attempt: null };
  }
  const patch = opts.channel === "push"
    ? { pushRetryExhaustedAt: null }
    : { smsRetryExhaustedAt: null };
  await db.update(memberLevyReceiptAttemptsTable)
    .set(patch)
    .where(eq(memberLevyReceiptAttemptsTable.id, existing.id));
  const updated = await loadLevyAttempt(existing.id, orgId);
  return {
    pipeline: opts.pipeline, channel: opts.channel, attemptId: opts.attemptId,
    ok: true,
    attempt: updated ? { ...updated, _pipeline: "levy_receipt" } : null,
  };
}

/**
 * Reset the row so the bounded retry helper accepts it (clear the
 * exhaustion stamp, zero the per-channel attempts counter, flip the
 * channel status back to `failed`), then immediately call the
 * channel-specific retry helper. The retry helper still gates on its
 * own preconditions (e.g. levy SMS short-circuits to `skipped` when
 * SMS_PROVIDER is unset) — when it returns `null` we surface that as
 * `retryResult: null` with a `noopReason` so the UI can explain why
 * the row didn't actually re-dispatch.
 */
export async function retryExhaustedChannel(
  opts: ExhaustionActionOpts,
): Promise<ExhaustionActionResult> {
  const orgId = opts.organizationId ?? null;

  if (opts.pipeline === "coach_payout") {
    const existing = await loadCoachAttempt(opts.attemptId, orgId);
    if (!existing) {
      return { pipeline: opts.pipeline, channel: opts.channel, attemptId: opts.attemptId, ok: false, attempt: null };
    }
    // Reset the channel state so `retryCoachPayout*` accepts the row.
    // We do this even if the row is not exhausted yet — admins on the
    // history view always operate on rows that have been stamped, and
    // a defensive reset here also covers the edge case where the cron
    // bumped the attempts counter between the page render and the
    // click.
    const resetPatch = opts.channel === "push"
      ? {
        pushStatus: "failed" as const,
        pushAttempts: 0,
        pushRetryExhaustedAt: null,
        lastPushError: null,
      }
      : {
        smsStatus: "failed" as const,
        smsAttempts: 0,
        smsRetryExhaustedAt: null,
        lastSmsError: null,
      };
    await db.update(coachPayoutNotificationAttemptsTable)
      .set(resetPatch)
      .where(eq(coachPayoutNotificationAttemptsTable.id, existing.id));
    const reset = await loadCoachAttempt(existing.id, orgId);
    if (!reset) {
      return { pipeline: opts.pipeline, channel: opts.channel, attemptId: opts.attemptId, ok: false, attempt: null };
    }
    const retryResult = opts.channel === "push"
      ? await retryCoachPayoutPush({ attempt: reset, logContext: { route: "admin.notify-exhaustion-action", attemptId: reset.id, pipeline: opts.pipeline, channel: opts.channel } })
      : await retryCoachPayoutSms({ attempt: reset, logContext: { route: "admin.notify-exhaustion-action", attemptId: reset.id, pipeline: opts.pipeline, channel: opts.channel } });
    const updated = await loadCoachAttempt(existing.id, orgId);
    return {
      pipeline: opts.pipeline, channel: opts.channel, attemptId: opts.attemptId,
      ok: true,
      attempt: updated ? { ...updated, _pipeline: "coach_payout" } : null,
      retryResult,
      noopReason: retryResult ? undefined : "channel_helper_declined",
    };
  }

  const existing = await loadLevyAttempt(opts.attemptId, orgId);
  if (!existing) {
    return { pipeline: opts.pipeline, channel: opts.channel, attemptId: opts.attemptId, ok: false, attempt: null };
  }
  const resetPatch = opts.channel === "push"
    ? {
      pushStatus: "failed" as const,
      pushAttempts: 0,
      pushRetryExhaustedAt: null,
      lastPushError: null,
    }
    : {
      smsStatus: "failed" as const,
      smsAttempts: 0,
      smsRetryExhaustedAt: null,
      lastSmsError: null,
    };
  await db.update(memberLevyReceiptAttemptsTable)
    .set(resetPatch)
    .where(eq(memberLevyReceiptAttemptsTable.id, existing.id));
  const reset = await loadLevyAttempt(existing.id, orgId);
  if (!reset) {
    return { pipeline: opts.pipeline, channel: opts.channel, attemptId: opts.attemptId, ok: false, attempt: null };
  }
  const retryResult = opts.channel === "push"
    ? await retryLevyReceiptPush({ attempt: reset, logContext: { route: "admin.notify-exhaustion-action", attemptId: reset.id, pipeline: opts.pipeline, channel: opts.channel } })
    : await retryLevyReceiptSms({ attempt: reset, logContext: { route: "admin.notify-exhaustion-action", attemptId: reset.id, pipeline: opts.pipeline, channel: opts.channel } });
  const updated = await loadLevyAttempt(existing.id, orgId);
  return {
    pipeline: opts.pipeline, channel: opts.channel, attemptId: opts.attemptId,
    ok: true,
    attempt: updated ? { ...updated, _pipeline: "levy_receipt" } : null,
    retryResult,
    noopReason: retryResult ? undefined : "channel_helper_declined",
  };
}

// ── Ops alert wiring test (Task #2057) ───────────────────────────────────
//
// Sibling of `sendWatchGpsOpsAlertTestPage` — fires a clearly-labelled
// `[TEST]` page through the same Slack / PagerDuty senders the real
// notify-retry exhaustion alert uses, awaiting both so the dashboard
// can show per-channel success/failure synchronously.
//
// Implementation notes (mirror watch GPS):
//   - Awaits the senders so the route can return per-channel results.
//   - Re-emits the same warn-log on per-channel failure so a wiring
//     failure detected via the test button is indistinguishable in the
//     log stream from a wiring failure detected by a real spike.
//   - Independent try/catch per channel so a Slack 404 doesn't suppress
//     the PagerDuty result (and vice versa).
//   - Reuses `buildSyntheticTestSummary` so the chat body matches the
//     same synthetic shape the email test path produces.

export interface NotifyRetryExhaustionOpsAlertChatTestResult {
  /** Whether each channel was configured at the moment the test fired. */
  targets: NotifyRetryExhaustionOpsAlertChatTargetsStatus;
  /** Per-channel outcome. `attempted` is false when the channel wasn't
   *  configured at all (no env var set). When `attempted` is true,
   *  `ok` reflects whether the underlying sender resolved successfully;
   *  `error` carries the error message on failure for the toast. */
  slack: { configured: boolean; attempted: boolean; ok: boolean; error: string | null };
  pagerDuty: { configured: boolean; attempted: boolean; ok: boolean; error: string | null };
}

export async function sendNotifyRetryExhaustionOpsAlertTestPage(opts: {
  now?: Date;
} = {}): Promise<NotifyRetryExhaustionOpsAlertChatTestResult> {
  const now = opts.now ?? new Date();
  const { slackWebhook, pagerDutyRoutingKey } = getNotifyRetryExhaustionChatTargets();
  // Resolve the same window/threshold the real cron uses so the
  // synthetic body's window label is meaningful (e.g. "last 24h").
  const cfg = await resolveOpsAlertConfig();
  const summary = buildSyntheticTestSummary(cfg.windowHours, cfg.threshold);
  const since = new Date(now.getTime() - cfg.windowHours * 60 * 60 * 1000);
  const shared = { summary, since, now, isTest: true as const };

  const result: NotifyRetryExhaustionOpsAlertChatTestResult = {
    targets: {
      slackConfigured: slackWebhook !== null,
      pagerDutyConfigured: pagerDutyRoutingKey !== null,
    },
    slack: { configured: slackWebhook !== null, attempted: false, ok: false, error: null },
    pagerDuty: { configured: pagerDutyRoutingKey !== null, attempted: false, ok: false, error: null },
  };

  const tasks: Promise<void>[] = [];
  if (slackWebhook) {
    result.slack.attempted = true;
    tasks.push(
      postNotifyRetryExhaustionOpsAlertSlack({ webhookUrl: slackWebhook, ...shared })
        .then(() => {
          result.slack.ok = true;
        })
        .catch((err: unknown) => {
          result.slack.ok = false;
          result.slack.error = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err, opsAlertWiringTest: true },
            "[ops-alert] failed to post notification retry exhaustion ops alert to Slack",
          );
        }),
    );
  }
  if (pagerDutyRoutingKey) {
    result.pagerDuty.attempted = true;
    tasks.push(
      triggerNotifyRetryExhaustionOpsAlertPagerDuty({ routingKey: pagerDutyRoutingKey, ...shared })
        .then(() => {
          result.pagerDuty.ok = true;
        })
        .catch((err: unknown) => {
          result.pagerDuty.ok = false;
          result.pagerDuty.error = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err, opsAlertWiringTest: true },
            "[ops-alert] failed to trigger notification retry exhaustion ops alert on PagerDuty",
          );
        }),
    );
  }
  await Promise.all(tasks);
  return result;
}
