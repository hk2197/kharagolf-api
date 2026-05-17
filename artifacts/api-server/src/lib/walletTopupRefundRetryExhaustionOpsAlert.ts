/**
 * Auto-page on-call when wallet-topup-refund SMS / WhatsApp retry
 * budgets keep burning out (Task #1863).
 *
 * Background — Task #1280 made the wallet-topup-refund notify pipeline
 * durable in `wallet_topup_refund_notify_attempts`, and Task #1508
 * extended the retry sweep to SMS and WhatsApp with a 5-attempt cap.
 * After the 5th failure the row is stamped `smsRetryExhaustedAt` /
 * `whatsappRetryExhaustedAt` and never retried again.
 *
 * Until now nothing surfaced those exhaustions to engineering. Task
 * #1507's daily admin digest covers the *org-admin* angle (who never
 * got their refund notice), but that runs once per day and pages org
 * staff, not on-call. A Twilio outage / SMS_PROVIDER misconfiguration
 * could quietly drain the retry budget across many refunds for hours
 * before anyone noticed.
 *
 * This module closes the loop. The hourly cron tick invokes
 * `runWalletTopupRefundRetryExhaustionOpsAlertJob`, which:
 *
 *   - Counts wallet-topup-refund notify rows whose SMS or WhatsApp
 *     retry budget burned out inside the last `windowHours` (default
 *     1h), grouped by organization.
 *
 *   - Pages on-call when ANY organization's count meets/exceeds the
 *     configured threshold (`OPS_WALLET_REFUND_RETRY_EXHAUSTION_THRESHOLD`,
 *     default 3 inside the lookback window). Per-org because a single
 *     bad provider integration usually breaks just one organization at
 *     a time, and an org-level breakdown lets the recipient route the
 *     incident faster than a global aggregate would.
 *
 *   - Embeds, per breached org, a sample of the most recent provider
 *     error strings captured in `last_sms_error` / `last_whatsapp_error`
 *     so the page is actionable on its own ("Twilio 21610: Recipient
 *     unsubscribed" vs. "ECONNRESET" tells you very different things).
 *
 *   - Honours an in-process cooldown (`OPS_WALLET_REFUND_RETRY_EXHAUSTION_COOLDOWN_HOURS`,
 *     default 1h) so a sustained outage stays at one page per replica
 *     per hour. A process restart can re-page once inside the cooldown,
 *     matching the dedup semantics of every other ops-alert module.
 *
 *   - Fan-outs to email + Slack + PagerDuty in parallel via the same
 *     `OPS_ALERT_EMAILS` / `OPS_ALERT_SLACK_WEBHOOK` /
 *     `OPS_ALERT_PAGERDUTY_ROUTING_KEY` resolution chain every other
 *     ops-alert flow uses, with dedicated overrides for this flow:
 *       OPS_WALLET_REFUND_RETRY_ALERT_SLACK_WEBHOOK
 *       OPS_WALLET_REFUND_RETRY_ALERT_PAGERDUTY_ROUTING_KEY
 *
 * Configuration (env, all optional — no DB-backed settings for this
 * task per the spec):
 *   - `OPS_WALLET_REFUND_RETRY_EXHAUSTION_THRESHOLD`         default 3
 *   - `OPS_WALLET_REFUND_RETRY_EXHAUSTION_WINDOW_HOURS`      default 1
 *   - `OPS_WALLET_REFUND_RETRY_EXHAUSTION_COOLDOWN_HOURS`    default 1
 *   - `OPS_WALLET_REFUND_RETRY_EXHAUSTION_SAMPLE_SIZE`       default 5
 *   - `OPS_ALERT_EMAILS`                                     comma-separated on-call list
 *   - `OPS_WALLET_REFUND_RETRY_ALERT_SLACK_WEBHOOK`          optional; falls back to OPS_ALERT_SLACK_WEBHOOK
 *   - `OPS_WALLET_REFUND_RETRY_ALERT_PAGERDUTY_ROUTING_KEY`  optional; falls back to OPS_ALERT_PAGERDUTY_ROUTING_KEY
 */
import {
  db,
  organizationsTable,
  walletTopupRefundNotifyAttemptsTable,
} from "@workspace/db";
import { and, eq, gte, isNotNull, or } from "drizzle-orm";
import { logger } from "./logger";
import { sendWalletTopupRefundRetryExhaustionOpsAlertEmail } from "./mailer";
import {
  postWalletTopupRefundRetryExhaustionOpsAlertSlack,
  resolveOpsAlertChatTargets,
  triggerWalletTopupRefundRetryExhaustionOpsAlertPagerDuty,
} from "./opsAlertChat";

import {
  DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_COOLDOWN_HOURS,
  DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_SAMPLE_SIZE,
  DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_THRESHOLD,
  DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_WINDOW_HOURS,
} from "./walletTopupRefundRetryExhaustionOpsAlert.constants";
export {
  DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_COOLDOWN_HOURS,
  DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_SAMPLE_SIZE,
  DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_THRESHOLD,
  DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_WINDOW_HOURS,
} from "./walletTopupRefundRetryExhaustionOpsAlert.constants";

/**
 * Per-organization rollup the alert renders. Plain primitives so the
 * struct can be shoved straight into the email / Slack / PagerDuty
 * payloads and asserted on by tests without any DB ceremony.
 */
export interface WalletTopupRefundRetryExhaustionOrgBreakdown {
  organizationId: number;
  /** Org name resolved via `organizations` join — null if the org row
   *  was hard-deleted (defensive; the FK is `on delete cascade` so this
   *  should not happen in practice). */
  organizationName: string | null;
  /** Rows whose `smsRetryExhaustedAt` is inside the lookback window. */
  smsExhausted: number;
  /** Rows whose `whatsappRetryExhaustedAt` is inside the lookback window. */
  whatsappExhausted: number;
  /** Distinct rows touched (a single row that exhausted both channels
   *  is counted once). This is what's compared against the threshold. */
  rowsExhausted: number;
  /** Up to N most-recent distinct provider error strings observed across
   *  the breached rows, in display order (newest first). */
  sampleErrors: WalletTopupRefundRetryExhaustionSampleError[];
}

export interface WalletTopupRefundRetryExhaustionSampleError {
  channel: "sms" | "whatsapp";
  /** ISO timestamp the row was stamped exhausted on this channel. */
  exhaustedAt: string;
  /** Provider error message captured at the final failure, truncated. */
  message: string | null;
}

export interface RunWalletTopupRefundRetryExhaustionOpsAlertOpts {
  /**
   * Per-organization threshold. When unset, falls back to
   * `OPS_WALLET_REFUND_RETRY_EXHAUSTION_THRESHOLD` env var, then the
   * hardcoded default.
   */
  threshold?: number;
  /** Override the lookback window in hours. */
  windowHours?: number;
  /** Override the cooldown in hours. */
  cooldownHours?: number;
  /** Override the per-org sample size in the email/Slack/PagerDuty body. */
  sampleSize?: number;
  /**
   * Override the recipient list for email. When unset, parsed from
   * `OPS_ALERT_EMAILS`. Per the task spec, this flow does NOT also
   * page super_admins from the DB — the recipient list is env-only,
   * matching every other engineering-targeted alert.
   */
  recipients?: string[];
  /**
   * Override the per-org breakdown loader (used by tests so they
   * don't have to seed the DB to assert on the email payload).
   */
  breakdownOverride?: WalletTopupRefundRetryExhaustionOrgBreakdown[];
  /** Bypass the cooldown (used by tests / manual triggers). */
  force?: boolean;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export interface RunWalletTopupRefundRetryExhaustionOpsAlertResult {
  alerted: boolean;
  reason?:
    | "below_threshold"
    | "in_cooldown"
    | "no_recipients_or_chat"
    | "all_dispatch_failed";
  threshold: number;
  windowHours: number;
  cooldownHours: number;
  sampleSize: number;
  /** Every org with at least one exhaustion in the window — including
   *  ones that did not breach the threshold. Lets dashboards / tests
   *  see the raw data the gate evaluated. */
  observedBreakdown: WalletTopupRefundRetryExhaustionOrgBreakdown[];
  /** Subset of `observedBreakdown` whose `rowsExhausted >= threshold`. */
  breachedBreakdown: WalletTopupRefundRetryExhaustionOrgBreakdown[];
  recipientsAttempted: number;
  recipientsEmailed: number;
  slackAttempted: boolean;
  slackPosted: boolean;
  pagerDutyAttempted: boolean;
  pagerDutyTriggered: boolean;
}

let lastAlertedAtMs: number | null = null;

/** Test-only: reset in-process cooldown state. */
export function _resetWalletTopupRefundRetryExhaustionOpsAlertDedupForTest(): void {
  lastAlertedAtMs = null;
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

/**
 * Maximum length we keep for any single provider error string before
 * truncation. Twilio/WhatsApp errors include trace ids that can blow
 * past the email body's reasonable bounds — and a 240-char prefix is
 * always enough to identify the error code + class.
 */
const PROVIDER_ERROR_TRUNCATE_AT = 240;

function truncateError(msg: string | null): string | null {
  if (msg == null) return null;
  return msg.length > PROVIDER_ERROR_TRUNCATE_AT
    ? `${msg.slice(0, PROVIDER_ERROR_TRUNCATE_AT)}…`
    : msg;
}

/**
 * Pull every `wallet_topup_refund_notify_attempts` row whose SMS or
 * WhatsApp retry budget burned out at or after `since`, and roll them
 * up by organization with up to `sampleSize` distinct provider error
 * strings per org.
 *
 * Volumes here are tiny by construction: this query only returns rows
 * for the lookback window (default 1h) and only ones that hit the
 * 5-attempt cap, which under normal operation is zero. We grab the
 * full rows so we can sample distinct error strings without a second
 * round-trip.
 */
export async function loadWalletTopupRefundRetryExhaustionBreakdown(opts: {
  since: Date;
  sampleSize: number;
}): Promise<WalletTopupRefundRetryExhaustionOrgBreakdown[]> {
  const { since, sampleSize } = opts;
  const safeSampleSize = Math.max(1, Math.min(sampleSize, 50));

  const rows = await db
    .select({
      organizationId: walletTopupRefundNotifyAttemptsTable.organizationId,
      organizationName: organizationsTable.name,
      smsRetryExhaustedAt: walletTopupRefundNotifyAttemptsTable.smsRetryExhaustedAt,
      whatsappRetryExhaustedAt: walletTopupRefundNotifyAttemptsTable.whatsappRetryExhaustedAt,
      lastSmsError: walletTopupRefundNotifyAttemptsTable.lastSmsError,
      lastWhatsappError: walletTopupRefundNotifyAttemptsTable.lastWhatsappError,
    })
    .from(walletTopupRefundNotifyAttemptsTable)
    .leftJoin(
      organizationsTable,
      eq(organizationsTable.id, walletTopupRefundNotifyAttemptsTable.organizationId),
    )
    .where(
      or(
        and(
          isNotNull(walletTopupRefundNotifyAttemptsTable.smsRetryExhaustedAt),
          gte(walletTopupRefundNotifyAttemptsTable.smsRetryExhaustedAt, since),
        ),
        and(
          isNotNull(walletTopupRefundNotifyAttemptsTable.whatsappRetryExhaustedAt),
          gte(walletTopupRefundNotifyAttemptsTable.whatsappRetryExhaustedAt, since),
        ),
      ),
    );

  // Roll up in Node — the per-org SQL aggregation we'd otherwise need
  // (window function over distinct error strings) is fiddly across
  // Postgres versions and the row count here is bounded by the cap
  // (5 attempts × any pending refunds inside 1h, in practice ≪ 1k).
  const byOrg = new Map<number, {
    organizationId: number;
    organizationName: string | null;
    smsExhausted: number;
    whatsappExhausted: number;
    rowsExhausted: number;
    samples: WalletTopupRefundRetryExhaustionSampleError[];
  }>();

  for (const r of rows) {
    let bucket = byOrg.get(r.organizationId);
    if (!bucket) {
      bucket = {
        organizationId: r.organizationId,
        organizationName: r.organizationName ?? null,
        smsExhausted: 0,
        whatsappExhausted: 0,
        rowsExhausted: 0,
        samples: [],
      };
      byOrg.set(r.organizationId, bucket);
    }
    const smsHit =
      r.smsRetryExhaustedAt != null && r.smsRetryExhaustedAt >= since;
    const whatsappHit =
      r.whatsappRetryExhaustedAt != null && r.whatsappRetryExhaustedAt >= since;
    if (smsHit) bucket.smsExhausted += 1;
    if (whatsappHit) bucket.whatsappExhausted += 1;
    if (smsHit || whatsappHit) bucket.rowsExhausted += 1;
    if (smsHit) {
      bucket.samples.push({
        channel: "sms",
        exhaustedAt: r.smsRetryExhaustedAt!.toISOString(),
        message: truncateError(r.lastSmsError),
      });
    }
    if (whatsappHit) {
      bucket.samples.push({
        channel: "whatsapp",
        exhaustedAt: r.whatsappRetryExhaustedAt!.toISOString(),
        message: truncateError(r.lastWhatsappError),
      });
    }
  }

  const result: WalletTopupRefundRetryExhaustionOrgBreakdown[] = [];
  for (const bucket of byOrg.values()) {
    // Newest first, then dedup by (channel, message) so a Twilio
    // outage that produces the same error code 50 times shows once.
    bucket.samples.sort((a, b) => b.exhaustedAt.localeCompare(a.exhaustedAt));
    const seen = new Set<string>();
    const sampleErrors: WalletTopupRefundRetryExhaustionSampleError[] = [];
    for (const s of bucket.samples) {
      const key = `${s.channel}::${s.message ?? "(null)"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sampleErrors.push(s);
      if (sampleErrors.length >= safeSampleSize) break;
    }
    result.push({
      organizationId: bucket.organizationId,
      organizationName: bucket.organizationName,
      smsExhausted: bucket.smsExhausted,
      whatsappExhausted: bucket.whatsappExhausted,
      rowsExhausted: bucket.rowsExhausted,
      sampleErrors,
    });
  }
  // Largest blast radius first — makes the email/Slack body lead with
  // the org most likely to be the canary for the underlying outage.
  result.sort((a, b) => b.rowsExhausted - a.rowsExhausted);
  return result;
}

export async function runWalletTopupRefundRetryExhaustionOpsAlertJob(
  opts: RunWalletTopupRefundRetryExhaustionOpsAlertOpts = {},
): Promise<RunWalletTopupRefundRetryExhaustionOpsAlertResult> {
  const now = opts.now ?? new Date();

  const threshold =
    opts.threshold ??
    parseEnvNumber(
      "OPS_WALLET_REFUND_RETRY_EXHAUSTION_THRESHOLD",
      DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_THRESHOLD,
    );
  const windowHours =
    opts.windowHours ??
    parseEnvNumber(
      "OPS_WALLET_REFUND_RETRY_EXHAUSTION_WINDOW_HOURS",
      DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_WINDOW_HOURS,
    );
  const cooldownHours =
    opts.cooldownHours ??
    parseEnvNumber(
      "OPS_WALLET_REFUND_RETRY_EXHAUSTION_COOLDOWN_HOURS",
      DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_COOLDOWN_HOURS,
    );
  const sampleSize =
    opts.sampleSize ??
    parseEnvNumber(
      "OPS_WALLET_REFUND_RETRY_EXHAUSTION_SAMPLE_SIZE",
      DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_SAMPLE_SIZE,
    );

  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const observedBreakdown =
    opts.breakdownOverride ??
    (await loadWalletTopupRefundRetryExhaustionBreakdown({ since, sampleSize }));
  const breachedBreakdown = observedBreakdown.filter(
    (b) => b.rowsExhausted >= threshold,
  );

  const baseResult: Omit<
    RunWalletTopupRefundRetryExhaustionOpsAlertResult,
    | "alerted"
    | "reason"
    | "recipientsAttempted"
    | "recipientsEmailed"
    | "slackAttempted"
    | "slackPosted"
    | "pagerDutyAttempted"
    | "pagerDutyTriggered"
  > = {
    threshold,
    windowHours,
    cooldownHours,
    sampleSize,
    observedBreakdown,
    breachedBreakdown,
  };

  if (breachedBreakdown.length === 0) {
    return {
      ...baseResult,
      alerted: false,
      reason: "below_threshold",
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      slackAttempted: false,
      slackPosted: false,
      pagerDutyAttempted: false,
      pagerDutyTriggered: false,
    };
  }

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
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      slackAttempted: false,
      slackPosted: false,
      pagerDutyAttempted: false,
      pagerDutyTriggered: false,
    };
  }

  const recipients = dedupEmails(
    opts.recipients ?? parseRecipients(process.env.OPS_ALERT_EMAILS),
  );
  const chatTargets = resolveOpsAlertChatTargets({
    slackEnvVar: "OPS_WALLET_REFUND_RETRY_ALERT_SLACK_WEBHOOK",
    pagerDutyEnvVar: "OPS_WALLET_REFUND_RETRY_ALERT_PAGERDUTY_ROUTING_KEY",
  });

  if (
    recipients.length === 0 &&
    chatTargets.slackWebhook == null &&
    chatTargets.pagerDutyRoutingKey == null
  ) {
    logger.warn(
      {
        threshold,
        windowHours,
        breachedOrgs: breachedBreakdown.map((b) => ({
          organizationId: b.organizationId,
          rowsExhausted: b.rowsExhausted,
        })),
      },
      "[ops-alert] wallet-topup-refund retry exhaustion crossed threshold but no OPS_ALERT_EMAILS / OPS_ALERT_SLACK_WEBHOOK / OPS_ALERT_PAGERDUTY_ROUTING_KEY recipient is configured; skipping page",
    );
    return {
      ...baseResult,
      alerted: false,
      reason: "no_recipients_or_chat",
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      slackAttempted: false,
      slackPosted: false,
      pagerDutyAttempted: false,
      pagerDutyTriggered: false,
    };
  }

  let emailed = 0;
  for (const to of recipients) {
    try {
      await sendWalletTopupRefundRetryExhaustionOpsAlertEmail({
        to,
        threshold,
        windowHours,
        cooldownHours,
        since,
        now,
        breached: breachedBreakdown,
      });
      emailed += 1;
    } catch (err) {
      logger.warn(
        { err, to },
        "[ops-alert] failed to send wallet-topup-refund retry exhaustion ops alert email",
      );
    }
  }

  let slackPosted = false;
  if (chatTargets.slackWebhook != null) {
    try {
      await postWalletTopupRefundRetryExhaustionOpsAlertSlack({
        webhookUrl: chatTargets.slackWebhook,
        threshold,
        windowHours,
        cooldownHours,
        since,
        now,
        breached: breachedBreakdown,
      });
      slackPosted = true;
    } catch (err) {
      logger.warn(
        { err },
        "[ops-alert] failed to post wallet-topup-refund retry exhaustion Slack alert",
      );
    }
  }

  let pagerDutyTriggered = false;
  if (chatTargets.pagerDutyRoutingKey != null) {
    try {
      await triggerWalletTopupRefundRetryExhaustionOpsAlertPagerDuty({
        routingKey: chatTargets.pagerDutyRoutingKey,
        threshold,
        windowHours,
        cooldownHours,
        since,
        now,
        breached: breachedBreakdown,
      });
      pagerDutyTriggered = true;
    } catch (err) {
      logger.warn(
        { err },
        "[ops-alert] failed to trigger wallet-topup-refund retry exhaustion PagerDuty alert",
      );
    }
  }

  const anyChannelSucceeded =
    emailed > 0 || slackPosted || pagerDutyTriggered;

  // Cooldown is only set when at least one channel actually delivered.
  // If every channel failed (e.g. SMTP outage + bad webhook) we want
  // the next hourly tick to retry rather than swallow the page for an
  // hour — the per-channel try/catch above already prevents the
  // misconfigured-webhook-pages-every-tick problem because individual
  // channel failures don't crash the job, and a partial success still
  // counts as a real page.
  if (anyChannelSucceeded) {
    lastAlertedAtMs = now.getTime();
  } else {
    logger.warn(
      {
        threshold,
        windowHours,
        recipientsAttempted: recipients.length,
        slackAttempted: chatTargets.slackWebhook != null,
        pagerDutyAttempted: chatTargets.pagerDutyRoutingKey != null,
        breachedOrgs: breachedBreakdown.map((b) => ({
          organizationId: b.organizationId,
          rowsExhausted: b.rowsExhausted,
        })),
      },
      "[ops-alert] wallet-topup-refund retry exhaustion crossed threshold but every dispatch channel failed; will retry on next tick",
    );
  }

  return {
    ...baseResult,
    alerted: anyChannelSucceeded,
    reason: anyChannelSucceeded ? undefined : "all_dispatch_failed",
    recipientsAttempted: recipients.length,
    recipientsEmailed: emailed,
    slackAttempted: chatTargets.slackWebhook != null,
    slackPosted,
    pagerDutyAttempted: chatTargets.pagerDutyRoutingKey != null,
    pagerDutyTriggered,
  };
}
