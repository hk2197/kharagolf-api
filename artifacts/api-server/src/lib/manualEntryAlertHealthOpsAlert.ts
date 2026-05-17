/**
 * Auto-page on-call when manual-entry alerts stop reaching anyone (Task #1387).
 *
 * Background — Task #1193 added `getManualEntryAlertHealthSummary()` and the
 * `/super-admin/manual-entry-alerts` dashboard so a human can spot when our
 * manual-entry-alert push/email pipelines start silently failing (e.g. a
 * stale APNs cert, a bouncing tournament-director inbox, an SMTP outage).
 * The dashboard surfaces the data, but it still required someone to look at
 * it. This module closes the loop: an hourly cron reuses the same summary
 * and pages super-admins + the on-call inbox when delivery health drops
 * below configurable thresholds, so a regression is caught proactively
 * instead of waiting for a tournament director to complain.
 *
 * Two breach detectors run in parallel — either trips the alert:
 *
 *   1. **Delivery-rate breach** — when the 7-day push-or-email delivery
 *      rate (`anyDeliveryRate`) drops below the configured threshold AND
 *      we have at least `MIN_SAMPLE` alerts in the window. The minimum
 *      sample protects against noisy alerts on quiet days where one
 *      stranded alert pulls the rate to 0%.
 *
 *   2. **Consecutive-zero breach** — when the most recent N alerts (env
 *      configurable, default 5) all have `pushSent = 0 AND emailSent = 0`.
 *      This catches a fast-moving outage that the rolling 7-day rate would
 *      smooth over, e.g. APNs returns 403 starting at 9am — by 10am the
 *      last 5 alerts are all silent even though the 7-day rate is still
 *      well above threshold.
 *
 * Recipients are the union of:
 *   - every super_admin in `app_users` with a non-null email, AND
 *   - the on-call list parsed from `OPS_ALERT_EMAILS` (the same env the
 *     existing notify-exhaustion alert uses, so on-call only configures
 *     one address).
 *
 * Cooldown: in-process timestamp gates re-sends within
 * `OPS_MANUAL_ENTRY_ALERT_COOLDOWN_HOURS` (default 6h) so a sustained
 * outage paged at 9am won't page again at 10am, 11am, ... A process
 * restart can re-page once inside the cooldown — acceptable, matches the
 * existing notify-exhaustion-ops-alert dedup semantics, and is preferable
 * to losing the page entirely if the only replica that knew about the
 * cooldown crashed mid-incident.
 *
 * Configuration (env, all optional):
 *   - `OPS_MANUAL_ENTRY_ALERT_RATE_THRESHOLD_PCT`  default 80
 *   - `OPS_MANUAL_ENTRY_ALERT_MIN_SAMPLE`          default 3
 *   - `OPS_MANUAL_ENTRY_ALERT_CONSECUTIVE_ZERO`    default 5
 *   - `OPS_MANUAL_ENTRY_ALERT_COOLDOWN_HOURS`      default 6
 *   - `OPS_ALERT_EMAILS`                           comma-separated on-call list
 *   - `OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK`        optional; falls back to
 *                                                  `OPS_ALERT_SLACK_WEBHOOK` (Task #2054)
 *   - `OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY` optional; falls back to
 *                                                  `OPS_ALERT_PAGERDUTY_ROUTING_KEY` (Task #2054)
 *   - `APP_BASE_URL` / `PUBLIC_BASE_URL`           used to build the
 *                                                  dashboard deep-link
 */
import {
  db,
  manualEntryAlertsTable,
  manualEntryAlertPageHistoryTable,
  appUsersTable,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { logger } from "./logger";
import { sendManualEntryAlertHealthOpsAlertEmail } from "./mailer";
import {
  getManualEntryAlertHealthSummary,
  getManualEntryNotifyMutedSkipsByOrg,
  type ManualEntryAlertHealthSummary,
  type ManualEntryAlertWindow,
  type ManualEntryNotifyMutedSkipOrg,
} from "./manualEntryAlertHealth";
import { resolveOpsAlertConfig } from "./opsAlertSettings";
import {
  postManualEntryAlertHealthOpsAlertSlack,
  resolveOpsAlertChatTargets,
  triggerManualEntryAlertHealthOpsAlertPagerDuty,
  type ManualEntryAlertHealthChatOpts,
  type OpsAlertChatTargets,
} from "./opsAlertChat";

// Re-export the hardcoded defaults from the constants module so existing
// importers keep working. The constants live in their own file so
// `opsAlertSettings.ts` can reference them without importing back from
// here (which would create a cycle, since this file now imports
// `resolveOpsAlertConfig`).
export {
  DEFAULT_MANUAL_ENTRY_ALERT_RATE_THRESHOLD_PCT,
  DEFAULT_MANUAL_ENTRY_ALERT_MIN_SAMPLE,
  DEFAULT_MANUAL_ENTRY_ALERT_CONSECUTIVE_ZERO,
  DEFAULT_MANUAL_ENTRY_ALERT_COOLDOWN_HOURS,
  DEFAULT_MANUAL_ENTRY_ALERT_MUTED_PILE_UP_THRESHOLD,
} from "./manualEntryAlertHealthOpsAlert.constants";

import { DEFAULT_MANUAL_ENTRY_ALERT_MUTED_PILE_UP_THRESHOLD } from "./manualEntryAlertHealthOpsAlert.constants";

export type ManualEntryAlertHealthBreachKind =
  | "delivery_rate"
  | "consecutive_zero"
  /**
   * Task #2066 — at least one org racked up >= the configured per-org
   * threshold of `org_muted` / `tournament_muted` skip rows in the 7d
   * window. Catches the "stuck muted" failure mode where an org-wide
   * toggle was left off after troubleshooting.
   */
  | "muted_pile_up";

export interface ManualEntryAlertHealthBreach {
  kind: ManualEntryAlertHealthBreachKind;
  /** Human-readable detail line for the email body / log. */
  detail: string;
}

export interface RunManualEntryAlertHealthOpsAlertOpts {
  /** Override the delivery-rate threshold percentage (defaults to env / 80). */
  thresholdPct?: number;
  /** Override the minimum 7d alert sample size (defaults to env / 3). */
  minSample?: number;
  /** Override the "N consecutive zero-delivery alerts" trigger (defaults to env / 5). */
  consecutiveZero?: number;
  /** Override the cooldown in hours (defaults to env / 6). */
  cooldownHours?: number;
  /**
   * Task #2081 — override the muted-skip pile-up `since` window in
   * hours (defaults to DB → env / 168 = 7d). Only affects the
   * muted-skip pile-up signal; the 7d / 30d delivery-rate summaries
   * are still computed by `getManualEntryAlertHealthSummary` over
   * fixed windows.
   */
  lookbackHours?: number;
  /**
   * Task #2081 — when true, evaluate breaches and return a structured
   * result but skip the email + chat dispatch (and the page-history
   * row, and the in-process cooldown stamp) so ops can dry-run a
   * tightened threshold against production traffic without paging
   * on-call. Defaults to DB → env / `false`.
   */
  dryRun?: boolean;
  /**
   * Task #2081 — cap on the deduplicated recipient list before the
   * email send loop. Defaults to DB → env / 50.
   */
  recipientLookupLimit?: number;
  /**
   * Task #2066 — override the per-org muted-skip pile-up threshold
   * (defaults to `OPS_MANUAL_ENTRY_ALERT_MUTED_PILE_UP_THRESHOLD` /
   * `DEFAULT_MANUAL_ENTRY_ALERT_MUTED_PILE_UP_THRESHOLD`). When >= this
   * many `org_muted` + `tournament_muted` rows accrue for any single
   * org in the 7d window, the muted-pile-up breach fires.
   */
  mutedPileUpThreshold?: number;
  /**
   * Override the recipient list. When unset, the union of all super_admin
   * emails and `OPS_ALERT_EMAILS` is used.
   */
  recipients?: string[];
  /** Override the deep-link base URL. */
  baseUrl?: string;
  /** Override the summary loader (used by tests to bypass the DB). */
  summary?: ManualEntryAlertHealthSummary;
  /**
   * Override the muted-skip pile-up snapshot (used by tests to bypass
   * the DB). When unset, the runner queries `manual_entry_notify_skips`
   * for the 7d window using the resolved threshold.
   */
  mutedPileUpOrgs?: ManualEntryNotifyMutedSkipOrg[];
  /** Bypass the cooldown (used by tests / manual triggers). */
  force?: boolean;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export interface RunManualEntryAlertHealthOpsAlertResult {
  alerted: boolean;
  reason?:
    | "no_breach"
    | "in_cooldown"
    | "no_recipients"
    // Task #2081 — breach detected but the dry-run flag was on, so
    // email + chat dispatch (and the page-history row) were skipped.
    | "dry_run"
    | "send_failed";
  breaches: ManualEntryAlertHealthBreach[];
  summary7d: ManualEntryAlertWindow;
  thresholdPct: number;
  minSample: number;
  consecutiveZero: number;
  /** Task #2081 — resolved tunables actually used for this run. */
  lookbackHours: number;
  dryRun: boolean;
  recipientLookupLimit: number;
  /** Task #2066 — resolved per-org muted-skip pile-up threshold actually
   *  used for this run. */
  mutedPileUpThreshold: number;
  /** Task #2066 — orgs that breached the muted-skip pile-up threshold
   *  in the 7d window (always present so callers / audit logs can see
   *  the snapshot we evaluated, even on a no-breach run where the list
   *  is empty). Sorted by `totalCount` desc. */
  mutedPileUpOrgs: ManualEntryNotifyMutedSkipOrg[];
  recipientsAttempted: number;
  recipientsEmailed: number;
}

let lastAlertedAtMs: number | null = null;

/** Test-only: reset in-process cooldown state. */
export function _resetManualEntryAlertHealthOpsAlertDedupForTest(): void {
  lastAlertedAtMs = null;
}

/**
 * Resolve the env-driven Slack webhook + PagerDuty routing key targets
 * for the manual-entry alert health alert (Task #2054).
 *
 * Lookup order — same shared-fallback shape every `OPS_ALERT_EMAILS`
 * flow that pages humans uses:
 *   1. `OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK` /
 *      `OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY` — dedicated, lets
 *      ops route this signal to a focused channel without re-routing
 *      every other ops alert.
 *   2. `OPS_ALERT_SLACK_WEBHOOK` / `OPS_ALERT_PAGERDUTY_ROUTING_KEY` —
 *      shared fallback, the same pair the watch GPS spike alert
 *      (Task #1374) and the notify-retry exhaustion alert
 *      (Task #1652) use. Most deploys only set this pair.
 */
function getManualEntryAlertHealthChatTargets(): OpsAlertChatTargets {
  return resolveOpsAlertChatTargets({
    slackEnvVar: "OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK",
    pagerDutyEnvVar: "OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY",
  });
}

/**
 * Fire-and-forget dispatch of the manual-entry alert health ops alert
 * to Slack and/or PagerDuty (Task #2054). Mirrors
 * `dispatchNotifyRetryExhaustionChat` in `notifyExhaustionOpsAlert.ts`:
 *   - Missing-config (no chat target set anywhere) emits one warn log
 *     and returns — the email branch already handled the
 *     "no recipients" warn for the email-only flow.
 *   - Per-channel try/catch so a Slack outage doesn't suppress the
 *     PagerDuty trigger and vice versa.
 */
function dispatchManualEntryAlertHealthChat(opts: ManualEntryAlertHealthChatOpts): void {
  const { slackWebhook, pagerDutyRoutingKey } = getManualEntryAlertHealthChatTargets();
  if (!slackWebhook && !pagerDutyRoutingKey) {
    logger.warn(
      {
        breaches: opts.breaches.map((b) => b.kind),
        summary7d: opts.summary7d,
      },
      "[ops-alert] manual-entry alert health breach but no chat target configured (set OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK / OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY, or the shared OPS_ALERT_SLACK_WEBHOOK / OPS_ALERT_PAGERDUTY_ROUTING_KEY); skipping ops chat page",
    );
    return;
  }
  if (slackWebhook) {
    void postManualEntryAlertHealthOpsAlertSlack({ webhookUrl: slackWebhook, ...opts }).catch(
      (err: unknown) => {
        logger.warn(
          { err },
          "[ops-alert] failed to post manual-entry alert health ops alert to Slack",
        );
      },
    );
  }
  if (pagerDutyRoutingKey) {
    void triggerManualEntryAlertHealthOpsAlertPagerDuty({
      routingKey: pagerDutyRoutingKey,
      ...opts,
    }).catch((err: unknown) => {
      logger.warn(
        { err },
        "[ops-alert] failed to trigger manual-entry alert health ops alert on PagerDuty",
      );
    });
  }
}

/**
 * Test helper — exposes the env-driven chat-target resolver so unit
 * tests can cover the dedicated → shared fallback order without
 * touching the DB.
 */
export function _resolveManualEntryAlertHealthChatTargetsForTests(): OpsAlertChatTargets {
  return getManualEntryAlertHealthChatTargets();
}

/**
 * Test helper — exposes the chat dispatcher so unit tests can drive
 * the chat path directly (no DB / mailer setup needed).
 */
export function _dispatchManualEntryAlertHealthChatForTests(
  opts: ManualEntryAlertHealthChatOpts,
): void {
  dispatchManualEntryAlertHealthChat(opts);
}

function parseRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Parse an env var as a positive integer; returns `null` on missing /
 *  empty / non-numeric / non-positive so the caller's `??`-chain falls
 *  through to the default. */
function parseEnvInt(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
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
 * Look at the most-recent N manual-entry alerts (any tournament/player) and
 * return whether every one of them was a zero-delivery alert. If fewer than
 * N alerts exist in the table at all, return false — we only want this
 * trigger to fire once we have a decisive run of failures, not on cold
 * start.
 */
async function lastNAreAllZeroDelivery(n: number): Promise<{
  total: number;
  zero: number;
  allZero: boolean;
}> {
  // Task #1658 — only consider rows that *actually fired* (status='sent').
  // Skip rows trivially have pushSent=emailSent=0 and would otherwise
  // satisfy the "all zero" predicate and page on-call as if APNs had
  // gone down — even though the notifier deliberately suppressed those
  // sends (org_muted, below_threshold, etc.) and there is nothing for
  // ops to fix.
  const rows = await db
    .select({
      pushSent: manualEntryAlertsTable.pushSent,
      emailSent: manualEntryAlertsTable.emailSent,
    })
    .from(manualEntryAlertsTable)
    .where(eq(manualEntryAlertsTable.status, "sent"))
    .orderBy(desc(manualEntryAlertsTable.sentAt))
    .limit(Math.max(1, n));
  const zero = rows.filter((r) => r.pushSent === 0 && r.emailSent === 0).length;
  return {
    total: rows.length,
    zero,
    allZero: rows.length >= n && zero === rows.length,
  };
}

/**
 * Compute the breaches given the summary + last-N stats. Pure function so
 * tests can pin behaviour without a DB.
 *
 * Task #2066 — also takes the muted-skip pile-up snapshot. Callers must
 * pre-filter the org list to those at/above `mutedPileUpThreshold`
 * (which `getManualEntryNotifyMutedSkipsByOrg` does); this function
 * just emits the breach when the list is non-empty so it stays a pure
 * function with no DB dependency.
 */
export function evaluateManualEntryAlertHealthBreaches(input: {
  summary: ManualEntryAlertWindow;
  thresholdPct: number;
  minSample: number;
  consecutiveZero: number;
  lastNStats: { total: number; zero: number; allZero: boolean };
  mutedPileUpThreshold: number;
  mutedPileUpOrgs: ManualEntryNotifyMutedSkipOrg[];
  /** Task #2081 — muted-skip pile-up `since` window in hours. Defaults
   *  to 168 (= 7d) so existing callers keep their old detail string. */
  lookbackHours?: number;
}): ManualEntryAlertHealthBreach[] {
  const {
    summary,
    thresholdPct,
    minSample,
    consecutiveZero,
    lastNStats,
    mutedPileUpThreshold,
    mutedPileUpOrgs,
    lookbackHours = 168,
  } = input;
  const breaches: ManualEntryAlertHealthBreach[] = [];

  if (
    summary.alertCount >= minSample &&
    summary.anyDeliveryRate < thresholdPct
  ) {
    breaches.push({
      kind: "delivery_rate",
      detail:
        `7-day delivery rate ${summary.anyDeliveryRate}% is below the ` +
        `${thresholdPct}% threshold (push ${summary.pushDeliveryRate}%, ` +
        `email ${summary.emailDeliveryRate}%, ${summary.zeroDeliveryCount} of ` +
        `${summary.alertCount} alerts reached nobody).`,
    });
  }

  if (lastNStats.allZero) {
    breaches.push({
      kind: "consecutive_zero",
      detail:
        `The last ${consecutiveZero} manual-entry alerts all reached ` +
        `zero recipients (push and email both failed for every one).`,
    });
  }

  if (mutedPileUpOrgs.length > 0) {
    // Headline number = total muted-skip rows across the offending orgs
    // so on-call sees the blast radius at a glance ("3 orgs, 47 silent
    // skips") before drilling into the per-org list in the email body.
    const totalRows = mutedPileUpOrgs.reduce((acc, o) => acc + o.totalCount, 0);
    const orgWord = mutedPileUpOrgs.length === 1 ? "org" : "orgs";
    // Task #2081 — render the lookback window in days when it's a clean
    // multiple (the typical 168 = 7d, 72 = 3d configurations) and fall
    // back to "in the last Nh" otherwise so a 36h dry-run is also
    // accurate.
    const windowLabel =
      lookbackHours % 24 === 0
        ? `in the last ${lookbackHours / 24} day${lookbackHours / 24 === 1 ? "" : "s"}`
        : `in the last ${lookbackHours}h`;
    breaches.push({
      kind: "muted_pile_up",
      detail:
        `${mutedPileUpOrgs.length} ${orgWord} accumulated >= ` +
        `${mutedPileUpThreshold} muted manual-entry skip(s) ${windowLabel} ` +
        `(${totalRows} total org_muted/tournament_muted rows). Likely ` +
        `cause: an org-wide alert toggle was left off after troubleshooting.`,
    });
  }

  return breaches;
}

/**
 * Task #2078 — read-only "is the auto-page job currently muted by an
 * active cooldown?" snapshot used by the super-admin dashboard.
 *
 * The page-history banner (Task #1665) already tells admins when on-call
 * was last auto-paged, but if a fresh breach is firing while we are
 * still inside `last_paged_at + cooldown_hours` they have no signal that
 * paging is being suppressed. This function combines the two pieces of
 * information the dashboard needs to surface that signal:
 *
 *   1. The most recent persisted page (`paged_at` + `cooldown_hours` from
 *      `manual_entry_alert_page_history`) — durable across process
 *      restarts so the dashboard can compute "next eligible" without
 *      depending on the in-process `lastAlertedAtMs` cooldown gate.
 *   2. The current breach state — same evaluator the cron uses
 *      (`evaluateManualEntryAlertHealthBreaches`), so the dashboard pill
 *      only lights up when "we would have paged but the cooldown is
 *      shielding on-call".
 *
 * `active` is true iff (a) a page-history row exists, (b) `now <
 * paged_at + cooldown_hours`, AND (c) at least one breach currently
 * fires. When no row exists or the cooldown has elapsed `active` is
 * false but `breachKinds` still reflects the live breach state so the
 * caller can render diagnostics if desired.
 */
export interface ManualEntryAlertHealthCooldownStatus {
  active: boolean;
  /** ISO timestamp of the latest persisted page, or null when none. */
  latestPagedAt: string | null;
  /** Cooldown hours snapshot stored on the latest page row. */
  cooldownHours: number | null;
  /** ISO timestamp of `latestPagedAt + cooldownHours`, or null. */
  nextPageEligibleAt: string | null;
  /** Currently-firing breach kinds (independent of the cooldown gate). */
  breachKinds: ManualEntryAlertHealthBreachKind[];
  /** Effective rate threshold the cron is comparing against right now. */
  thresholdPct: number;
}

export interface GetManualEntryAlertHealthCooldownStatusOpts {
  /** Override "now" for deterministic tests. */
  now?: Date;
  /** Inject a precomputed summary (tests / future caller fan-out). */
  summary?: ManualEntryAlertHealthSummary;
}

export async function getManualEntryAlertHealthCooldownStatus(
  opts: GetManualEntryAlertHealthCooldownStatusOpts = {},
): Promise<ManualEntryAlertHealthCooldownStatus> {
  const now = opts.now ?? new Date();

  // Resolve the same DB → env → default tunables the cron uses so the
  // breach evaluator behaves identically to a real `runManualEntry…Job`
  // tick. We also fall back to the latest page-history row's cooldown
  // snapshot for the "next eligible" math (see below).
  const resolved = await resolveOpsAlertConfig();
  const thresholdPct = resolved.manualEntry.rateThresholdPct;
  const minSample = resolved.manualEntry.minSample;
  const consecutiveZero = resolved.manualEntry.consecutiveZero;

  // Mirror the cron's pile-up detection so the dashboard pill agrees
  // with what the cron would actually fire on. `evaluateManualEntry…
  // Breaches` requires both the threshold AND the org list; if we
  // omit them the helper dereferences `mutedPileUpOrgs.length` and
  // throws.
  const mutedPileUpThreshold =
    parseEnvInt(process.env.OPS_MANUAL_ENTRY_ALERT_MUTED_PILE_UP_THRESHOLD) ??
    DEFAULT_MANUAL_ENTRY_ALERT_MUTED_PILE_UP_THRESHOLD;
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const summary = opts.summary ?? (await getManualEntryAlertHealthSummary());
  const summary7d = summary.windows["7d"];
  const [lastNStats, mutedPileUpOrgs] = await Promise.all([
    lastNAreAllZeroDelivery(consecutiveZero),
    getManualEntryNotifyMutedSkipsByOrg({
      since: since7d,
      minPerOrg: mutedPileUpThreshold,
    }),
  ]);
  const breaches = evaluateManualEntryAlertHealthBreaches({
    summary: summary7d,
    thresholdPct,
    minSample,
    consecutiveZero,
    lastNStats,
    mutedPileUpThreshold,
    mutedPileUpOrgs,
  });
  const breachKinds = breaches.map((b) => b.kind);

  const [latest] = await db
    .select({
      pagedAt: manualEntryAlertPageHistoryTable.pagedAt,
      cooldownHours: manualEntryAlertPageHistoryTable.cooldownHours,
    })
    .from(manualEntryAlertPageHistoryTable)
    .orderBy(desc(manualEntryAlertPageHistoryTable.pagedAt))
    .limit(1);

  if (!latest) {
    return {
      active: false,
      latestPagedAt: null,
      cooldownHours: null,
      nextPageEligibleAt: null,
      breachKinds,
      thresholdPct,
    };
  }

  // Use the cooldown_hours captured on the row, not the current
  // tunable: that's the value that actually governed re-paging at the
  // time of the page, and it stays consistent across an admin tweaking
  // the tunable mid-incident. Number() coerces the pg numeric -> JS.
  const pagedAtMs = (latest.pagedAt instanceof Date
    ? latest.pagedAt
    : new Date(latest.pagedAt as unknown as string)
  ).getTime();
  const cooldownH = Number(latest.cooldownHours);
  const nextEligibleMs = pagedAtMs + cooldownH * 60 * 60 * 1000;
  const insideCooldownWindow = now.getTime() < nextEligibleMs;

  return {
    active: insideCooldownWindow && breaches.length > 0,
    latestPagedAt: new Date(pagedAtMs).toISOString(),
    cooldownHours: cooldownH,
    nextPageEligibleAt: new Date(nextEligibleMs).toISOString(),
    breachKinds,
    thresholdPct,
  };
}

/**
 * Hourly job: load the manual-entry alert health summary, decide whether
 * the configured thresholds are breached, and email super-admins +
 * on-call when they are. Returns a structured result so tests / callers
 * can assert on the outcome without scraping logs.
 */
export async function runManualEntryAlertHealthOpsAlertJob(
  opts: RunManualEntryAlertHealthOpsAlertOpts = {},
): Promise<RunManualEntryAlertHealthOpsAlertResult> {
  const now = opts.now ?? new Date();

  // Task #1664 — the four tunables are now also editable from the
  // super-admin UI (DB-backed singleton row). Caller-supplied
  // `opts.*` always wins (used by tests and by the synthetic
  // "send test" trigger); otherwise we resolve in DB → env → default
  // order via `resolveOpsAlertConfig`, mirroring the retry-exhaustion
  // alert.
  const resolved = await resolveOpsAlertConfig();

  const thresholdPct = opts.thresholdPct ?? resolved.manualEntry.rateThresholdPct;
  const minSample = opts.minSample ?? resolved.manualEntry.minSample;
  const consecutiveZero = opts.consecutiveZero ?? resolved.manualEntry.consecutiveZero;
  const cooldownHours = opts.cooldownHours ?? resolved.manualEntry.cooldownHours;
  // Task #2081 — three additional tunables resolved in DB → env →
  // default order via the same `resolveOpsAlertConfig` helper.
  const lookbackHours = opts.lookbackHours ?? resolved.manualEntry.lookbackHours;
  const dryRun = opts.dryRun ?? resolved.manualEntry.dryRun;
  const recipientLookupLimit =
    opts.recipientLookupLimit ?? resolved.manualEntry.recipientLookupLimit;
  // Task #2066 — env-only knob (no DB-backed setting yet); the
  // re-exported default is the same value the constant module pins.
  const mutedPileUpThreshold =
    opts.mutedPileUpThreshold ??
    parseEnvInt(process.env.OPS_MANUAL_ENTRY_ALERT_MUTED_PILE_UP_THRESHOLD) ??
    DEFAULT_MANUAL_ENTRY_ALERT_MUTED_PILE_UP_THRESHOLD;

  const summary = opts.summary ?? (await getManualEntryAlertHealthSummary());
  const summary7d = summary.windows["7d"];
  // Task #2081 — the muted-skip pile-up `since` window is now tunable
  // via `lookbackHours` (default 168h = 7d preserves the original
  // behaviour). The rate / consecutive-zero signals still draw from
  // the fixed 7d / 30d summaries inside `getManualEntryAlertHealthSummary`,
  // so their detail strings stay correct as "7-day".
  const sinceMutedPileUp = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const [lastNStats, mutedPileUpOrgs] = await Promise.all([
    lastNAreAllZeroDelivery(consecutiveZero),
    opts.mutedPileUpOrgs
      ? Promise.resolve(opts.mutedPileUpOrgs)
      : getManualEntryNotifyMutedSkipsByOrg({
          since: sinceMutedPileUp,
          minPerOrg: mutedPileUpThreshold,
        }),
  ]);

  const breaches = evaluateManualEntryAlertHealthBreaches({
    summary: summary7d,
    thresholdPct,
    minSample,
    consecutiveZero,
    lastNStats,
    mutedPileUpThreshold,
    mutedPileUpOrgs,
    lookbackHours,
  });

  const baseResult: Omit<
    RunManualEntryAlertHealthOpsAlertResult,
    "alerted" | "reason" | "recipientsAttempted" | "recipientsEmailed"
  > = {
    breaches,
    summary7d,
    thresholdPct,
    minSample,
    consecutiveZero,
    lookbackHours,
    dryRun,
    recipientLookupLimit,
    mutedPileUpThreshold,
    mutedPileUpOrgs,
  };

  if (breaches.length === 0) {
    return {
      ...baseResult,
      alerted: false,
      reason: "no_breach",
      recipientsAttempted: 0,
      recipientsEmailed: 0,
    };
  }

  // Cooldown gate — keep a sustained outage to one page per cooldown
  // window. `force` lets manual triggers / tests bypass.
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
    };
  }

  // Task #2081 — dry-run gate. Skip the chat dispatch, recipient
  // lookup, email loop, page-history insert, and the in-process
  // cooldown stamp so an admin can dry-run a tightened threshold
  // against production traffic without paging on-call. The structured
  // result still surfaces the breach list + summary so the caller can
  // log / inspect what would have been paged.
  if (dryRun) {
    logger.warn(
      {
        breaches: breaches.map((b) => b.kind),
        summary7d,
        thresholdPct,
        minSample,
        consecutiveZero,
        lookbackHours,
        recipientLookupLimit,
      },
      "[ops-alert] manual-entry alert health breach detected but dry-run flag is on; skipping email + chat dispatch",
    );
    return {
      ...baseResult,
      alerted: false,
      reason: "dry_run",
      recipientsAttempted: 0,
      recipientsEmailed: 0,
    };
  }

  const dashboardUrl =
    (opts.baseUrl ?? resolveBaseUrl()).replace(/\/$/, "") +
    "/super-admin/manual-entry-alerts";

  // Task #2054 — fan the breach out to Slack / PagerDuty in parallel
  // with the email loop below. Fire-and-forget on purpose: chat is a
  // best-effort secondary channel and must not gate the email page or
  // cause us to mark the run as `send_failed` if a Slack webhook is
  // briefly unreachable. Mirrors the pattern from
  // `notifyExhaustionOpsAlert.ts` (Task #1652).
  dispatchManualEntryAlertHealthChat({
    breaches,
    summary7d: {
      alertCount: summary7d.alertCount,
      anyDeliveryRate: summary7d.anyDeliveryRate,
      pushDeliveryRate: summary7d.pushDeliveryRate,
      emailDeliveryRate: summary7d.emailDeliveryRate,
      zeroDeliveryCount: summary7d.zeroDeliveryCount,
    },
    thresholdPct,
    minSample,
    consecutiveZero,
    cooldownHours,
    dashboardUrl,
    now,
    // Task #2066 — chat dispatcher takes the offending org list so
    // Slack/PagerDuty can render the same per-org breakdown the email
    // does. Optional in the chat opts type so callers without the
    // muted-pile-up signal don't have to construct an empty list.
    mutedPileUpOrgs,
    mutedPileUpThreshold,
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

  // Task #2081 — cap the deduplicated recipient list before the email
  // send loop so a misconfigured super_admin sweep can't fan out to
  // hundreds of inboxes. Log the truncation once so an admin can spot
  // a bumping-against-the-cap configuration.
  if (recipients.length > recipientLookupLimit) {
    logger.warn(
      {
        limit: recipientLookupLimit,
        deduped: recipients.length,
        dropped: recipients.length - recipientLookupLimit,
      },
      "[ops-alert] manual-entry alert health recipient list exceeds configured lookup limit; truncating",
    );
    recipients = recipients.slice(0, recipientLookupLimit);
  }

  if (recipients.length === 0) {
    logger.warn(
      { summary7d, breaches },
      "[ops-alert] manual-entry alert health breach detected but no super_admin or OPS_ALERT_EMAILS recipient is configured; skipping email",
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
      await sendManualEntryAlertHealthOpsAlertEmail({
        to,
        breaches,
        summary7d,
        thresholdPct,
        minSample,
        consecutiveZero,
        cooldownHours,
        dashboardUrl,
        now,
        // Task #2066 — surface the offending orgs/tournaments so on-call
        // can reach out without having to open the dashboard.
        mutedPileUpThreshold,
        mutedPileUpOrgs,
      });
      emailed += 1;
    } catch (err) {
      logger.warn(
        { err, to },
        "[ops-alert] failed to send manual-entry alert health ops alert email",
      );
    }
  }

  if (emailed > 0) {
    lastAlertedAtMs = now.getTime();
    // Task #1665 — persist this page so super-admins can see on the
    // dashboard that on-call has already been notified about a current
    // outage without DM'ing them. Insert is best-effort: a DB write
    // failure here must not mask the fact that we DID page on-call,
    // otherwise we'd return `send_failed` and the cron would re-page
    // on the next tick.
    try {
      await db.insert(manualEntryAlertPageHistoryTable).values({
        pagedAt: now,
        breachKinds: breaches.map((b) => b.kind),
        recipientCount: emailed,
        recipientEmails: recipients,
        thresholdPct: thresholdPct.toFixed(2),
        cooldownHours: cooldownHours.toFixed(2),
        alertCount7d: summary7d.alertCount,
        anyDeliveryRate7d: summary7d.anyDeliveryRate.toFixed(2),
        zeroDeliveryCount7d: summary7d.zeroDeliveryCount,
        // Real outage page (Task #2079 added the column for synthetic
        // wiring tests fired from the dashboard; the cron always
        // inserts false so the dashboard banner can hide test rows).
        isTest: false,
      });
    } catch (err) {
      logger.warn(
        { err },
        "[ops-alert] manual-entry alert health page sent but failed to write page-history row",
      );
    }
    logger.warn(
      { breaches, summary7d, recipientsEmailed: emailed },
      "[ops-alert] manual-entry alert health threshold breached — ops paged",
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

// ── "Send test page" trigger (Task #2079) ─────────────────────────────────────
//
// Lets a super-admin verify on-call email routing on demand from the
// dashboard, without waiting for a real silent-alert breach. Mirrors
// the auto-page job's recipient resolution + Resend wiring so a pass
// here proves the same code path the cron will run during a real
// incident — distribution list, mailer auth, OPS_ALERT_EMAILS env,
// and the page-history insert.
//
// Distinguishing features vs. the cron:
//   - Always sends — no breach evaluation, no cooldown gate. The
//     operator clicked the button explicitly; suppressing on cooldown
//     would defeat the purpose of a wiring test.
//   - Mailer is invoked with `isTest: true` so the subject is
//     `[TEST] …` and the body has a leading "synthetic data" banner
//     so a recipient on the on-call list doesn't open an incident.
//   - Page-history row is written with `is_test = true` so the
//     dashboard banner / history list can label the row as a test
//     and not mistake a freshly-fired wiring test for an outage.

export interface SendManualEntryAlertHealthOpsAlertTestPageOpts {
  /**
   * Override the recipient list. When unset, the union of all
   * super_admin emails and `OPS_ALERT_EMAILS` is used — the same
   * lookup the cron uses, which is the whole point of the wiring test.
   */
  recipients?: string[];
  /** Override the deep-link base URL (used by tests). */
  baseUrl?: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export interface SendManualEntryAlertHealthOpsAlertTestPageResult {
  ok: boolean;
  reason?: "no_recipients" | "send_failed";
  recipientsAttempted: number;
  recipientsEmailed: number;
  /** The recipient list resolved by the same lookup the cron uses. */
  recipients: string[];
  /** Echo of the synthetic breaches so the dashboard can show what was sent. */
  breaches: ManualEntryAlertHealthBreach[];
  /** id of the inserted `manual_entry_alert_page_history` row, if any. */
  pageHistoryId: number | null;
}

/**
 * Synthetic breach payload used by the test page. Realistic-looking
 * numbers so the email body renders the same tables a real outage
 * would; the `[TEST]` subject and synthetic-data banner make the
 * intent unambiguous on the recipient side.
 */
function buildTestPageBreaches(): {
  breaches: ManualEntryAlertHealthBreach[];
  summary7d: ManualEntryAlertWindow;
} {
  const breaches: ManualEntryAlertHealthBreach[] = [
    {
      kind: "delivery_rate",
      detail:
        "[TEST] Synthetic breach — verifying on-call email routing. " +
        "No real outage; the dashboard's 'Send test page' button was " +
        "pressed by a super-admin to exercise this code path.",
    },
  ];
  const summary7d: ManualEntryAlertWindow = {
    alertCount: 0,
    recipientTotal: 0,
    pushAttemptedTotal: 0,
    pushSentTotal: 0,
    emailAttemptedTotal: 0,
    emailSentTotal: 0,
    pushDeliveryRate: 0,
    emailDeliveryRate: 0,
    anyDeliveryRate: 0,
    zeroDeliveryCount: 0,
    silentRecipientTotal: 0,
  };
  return { breaches, summary7d };
}

export async function sendManualEntryAlertHealthOpsAlertTestPage(
  opts: SendManualEntryAlertHealthOpsAlertTestPageOpts = {},
): Promise<SendManualEntryAlertHealthOpsAlertTestPageResult> {
  const now = opts.now ?? new Date();
  const { breaches, summary7d } = buildTestPageBreaches();
  // We resolve the same tunables the cron would use so the dashboard
  // banner / history row carries the operator's actual configuration
  // (a test row that says "threshold 80%" matches the next real page
  // a super-admin will see). `force=true` semantics aren't needed
  // here since the test page never runs the cooldown gate at all.
  const resolved = await resolveOpsAlertConfig();
  const thresholdPct = resolved.manualEntry.rateThresholdPct;
  const minSample = resolved.manualEntry.minSample;
  const consecutiveZero = resolved.manualEntry.consecutiveZero;
  const cooldownHours = resolved.manualEntry.cooldownHours;
  // Task #2081 — the test page path must apply the same recipient
  // lookup cap as the real cron path; otherwise an admin who tightens
  // the cap to e.g. 5 inboxes will still see a "Send test alert"
  // click fan out to every super_admin + every OPS_ALERT_EMAILS
  // entry, which would silently disagree with what the live pager
  // would do at 3 a.m. Truncation-with-warning mirrors the cron in
  // `runManualEntryAlertHealthOpsAlertJob` above.
  const recipientLookupLimit = resolved.manualEntry.recipientLookupLimit;

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

  if (recipients.length > recipientLookupLimit) {
    logger.warn(
      {
        limit: recipientLookupLimit,
        deduped: recipients.length,
        dropped: recipients.length - recipientLookupLimit,
      },
      "[ops-alert] manual-entry alert health TEST page recipient list exceeds configured lookup limit; truncating",
    );
    recipients = recipients.slice(0, recipientLookupLimit);
  }

  if (recipients.length === 0) {
    logger.warn(
      {},
      "[ops-alert] manual-entry alert health test page requested but no super_admin or OPS_ALERT_EMAILS recipient is configured",
    );
    return {
      ok: false,
      reason: "no_recipients",
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      recipients: [],
      breaches,
      pageHistoryId: null,
    };
  }

  const dashboardUrl =
    (opts.baseUrl ?? resolveBaseUrl()).replace(/\/$/, "") +
    "/super-admin/manual-entry-alerts";

  let emailed = 0;
  for (const to of recipients) {
    try {
      await sendManualEntryAlertHealthOpsAlertEmail({
        to,
        breaches,
        summary7d,
        thresholdPct,
        minSample,
        consecutiveZero,
        cooldownHours,
        dashboardUrl,
        now,
        isTest: true,
      });
      emailed += 1;
    } catch (err) {
      logger.warn(
        { err, to },
        "[ops-alert] failed to send manual-entry alert health TEST page email",
      );
    }
  }

  if (emailed === 0) {
    return {
      ok: false,
      reason: "send_failed",
      recipientsAttempted: recipients.length,
      recipientsEmailed: 0,
      recipients,
      breaches,
      pageHistoryId: null,
    };
  }

  // Best-effort write of the synthetic page-history row. Mirrors the
  // cron's swallow-and-warn behaviour: if the audit insert fails we
  // still return ok=true since the operator's ACTUAL test (did the
  // email go out?) succeeded.
  let pageHistoryId: number | null = null;
  try {
    const [row] = await db
      .insert(manualEntryAlertPageHistoryTable)
      .values({
        pagedAt: now,
        breachKinds: breaches.map((b) => b.kind),
        recipientCount: emailed,
        recipientEmails: recipients,
        thresholdPct: thresholdPct.toFixed(2),
        cooldownHours: cooldownHours.toFixed(2),
        alertCount7d: summary7d.alertCount,
        anyDeliveryRate7d: summary7d.anyDeliveryRate.toFixed(2),
        zeroDeliveryCount7d: summary7d.zeroDeliveryCount,
        // Task #2079 — flag the row so the dashboard banner / history
        // list can render it differently and not be mistaken for a
        // real outage page.
        isTest: true,
      })
      .returning({ id: manualEntryAlertPageHistoryTable.id });
    pageHistoryId = row?.id ?? null;
  } catch (err) {
    logger.warn(
      { err },
      "[ops-alert] manual-entry alert health TEST page sent but failed to write page-history row",
    );
  }

  logger.info(
    { recipientsEmailed: emailed, pageHistoryId },
    "[ops-alert] manual-entry alert health TEST page fired by super-admin",
  );

  return {
    ok: true,
    recipientsAttempted: recipients.length,
    recipientsEmailed: emailed,
    recipients,
    breaches,
    pageHistoryId,
  };
}

// ── Task #2057 — wiring badge + "Send chat test page" support ─────────────
//
// Backs the super-admin manual-entry alerts dashboard chip ("Slack:
// configured · PagerDuty: missing") and the dashboard's "Send chat
// test page" button. Sibling of the Task #2079 email test page above —
// that one exercises the on-call email routing path; this one exercises
// the Slack/PagerDuty chat routing path. Both can be fired
// independently from the dashboard so a super-admin can pinpoint which
// channel is misconfigured.
//
// Status resolver only exposes whether each channel is configured —
// never the webhook URL or routing key — so a UI render can't leak
// credentials into a screenshot. Test-page sender awaits the per-
// channel sends so the route can return per-channel success/failure
// synchronously, mirrors the watch-GPS / notify-retry chat test-page
// pattern, and fires the senders with `isTest: true` so the rendered
// page is visibly synthetic and the PagerDuty `dedup_key` is salted
// with a full timestamp (won't collapse onto a real open incident).

/**
 * Public, sanitized view of the chat-channel configuration for the
 * super-admin manual-entry alerts dashboard. Only exposes whether each
 * channel is configured — never the webhook URL or routing key — so a
 * UI render of this struct can't leak credentials into a screenshot.
 */
export interface ManualEntryAlertHealthOpsAlertChatTargetsStatus {
  slackConfigured: boolean;
  pagerDutyConfigured: boolean;
}

export function getManualEntryAlertHealthOpsAlertChatTargetsStatus(): ManualEntryAlertHealthOpsAlertChatTargetsStatus {
  const { slackWebhook, pagerDutyRoutingKey } = getManualEntryAlertHealthChatTargets();
  return {
    slackConfigured: slackWebhook !== null,
    pagerDutyConfigured: pagerDutyRoutingKey !== null,
  };
}

export interface ManualEntryAlertHealthOpsAlertChatTestResult {
  /** Whether each channel was configured at the moment the test fired. */
  targets: ManualEntryAlertHealthOpsAlertChatTargetsStatus;
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
 * success/failure to the dashboard. Resolves the same tunables the
 * real cron uses so the synthetic page's threshold/cooldown labels
 * match what would fire for real, and the `isTest: true` flag does the
 * visible labelling on the headline / body / dedup key on both senders.
 */
export async function sendManualEntryAlertHealthOpsAlertChatTestPage(opts: {
  baseUrl?: string;
  now?: Date;
} = {}): Promise<ManualEntryAlertHealthOpsAlertChatTestResult> {
  const now = opts.now ?? new Date();
  const { slackWebhook, pagerDutyRoutingKey } = getManualEntryAlertHealthChatTargets();
  // Resolve the same tunables the real cron uses so the synthetic
  // page's threshold/cooldown labels match what would fire for real.
  const resolved = await resolveOpsAlertConfig();
  const thresholdPct = resolved.manualEntry.rateThresholdPct;
  const minSample = resolved.manualEntry.minSample;
  const consecutiveZero = resolved.manualEntry.consecutiveZero;
  const cooldownHours = resolved.manualEntry.cooldownHours;
  const dashboardUrl =
    (opts.baseUrl ?? resolveBaseUrl()).replace(/\/$/, "") +
    "/super-admin/manual-entry-alerts";

  // Synthetic body fields — small numbers so a downstream PagerDuty
  // consumer reading `any_delivery_rate_7d` etc. can't mistake the
  // payload for a real breach worth charting; the `isTest` flag does
  // the labelling on both senders.
  const shared: ManualEntryAlertHealthChatOpts = {
    breaches: [
      {
        kind: "delivery_rate",
        detail: "Synthetic breach line — used to verify wiring. No real breach is happening.",
      },
    ],
    summary7d: {
      alertCount: 0,
      pushDeliveryRate: 0,
      emailDeliveryRate: 0,
      anyDeliveryRate: 0,
      zeroDeliveryCount: 0,
    },
    thresholdPct,
    minSample,
    consecutiveZero,
    cooldownHours,
    dashboardUrl,
    now,
    isTest: true,
  };

  const result: ManualEntryAlertHealthOpsAlertChatTestResult = {
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
      postManualEntryAlertHealthOpsAlertSlack({ webhookUrl: slackWebhook, ...shared })
        .then(() => {
          result.slack.ok = true;
        })
        .catch((err: unknown) => {
          result.slack.ok = false;
          result.slack.error = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err, opsAlertWiringTest: true },
            "[ops-alert] failed to post manual-entry alert health ops alert to Slack",
          );
        }),
    );
  }
  if (pagerDutyRoutingKey) {
    result.pagerDuty.attempted = true;
    tasks.push(
      triggerManualEntryAlertHealthOpsAlertPagerDuty({
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
            "[ops-alert] failed to trigger manual-entry alert health ops alert on PagerDuty",
          );
        }),
    );
  }
  await Promise.all(tasks);
  return result;
}
