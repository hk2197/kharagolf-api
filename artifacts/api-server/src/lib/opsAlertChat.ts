/**
 * Slack / PagerDuty senders for ops alerts that page humans (as opposed
 * to dashboard-only signals). Originally added in Task #1374 for the
 * watch GPS message-rate spike; generalised in Task #1652 so other
 * `OPS_ALERT_EMAILS` flows — most notably the notification-retry
 * exhaustion alert (Task #1130) — can reuse the same shape instead of
 * landing in email only.
 *
 * Why a separate module from `mailer.ts`?
 *   - `mailer.ts` is exclusively SMTP / email-provider code. Slack
 *     webhooks and PagerDuty Events API v2 are HTTP POSTs that have
 *     nothing to do with the email-adapter pipeline (suppression
 *     lists, branding, multi-provider routing).
 *   - Keeping the chat-channel senders in their own file avoids
 *     bloating mailer.ts further (~5.5k LOC already) and lets future
 *     ops alerts (custom-domain HTTPS failures, badge-share rollup
 *     stale, manual-entry alert health, etc.) reuse the same shape.
 *
 * All senders mirror the email senders' public contract:
 *   - Throw on transport failure so the caller can warn-log.
 *   - Pure helpers, no env reads — the dispatch site owns env var
 *     lookup + cooldown gating (see `resolveOpsAlertChatTargets`
 *     below for the env-resolution helper).
 */

const SLACK_POST_TIMEOUT_MS = 5000;
const PAGERDUTY_POST_TIMEOUT_MS = 5000;
const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";

function fmtUtc(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// ── Shared env-driven chat-target resolver (Task #1652) ──────────────────
//
// Each ops-alert flow gets its own dedicated Slack-webhook / PagerDuty-
// routing-key env vars (e.g. `OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK`,
// `OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK`). When the dedicated ones are
// unset, the resolver falls back to the shared
// `OPS_ALERT_SLACK_WEBHOOK` / `OPS_ALERT_PAGERDUTY_ROUTING_KEY` so most
// deploys only need to set one pair of env vars to page on every flow
// — mirroring how `OPS_ALERT_EMAILS` is the shared default for the
// email branch.
//
// Whitespace-only values are normalised to "unset" so an accidentally
// blank secret in the env doesn't trip the dispatcher.

export interface OpsAlertChatTargets {
  slackWebhook: string | null;
  pagerDutyRoutingKey: string | null;
}

export const SHARED_OPS_ALERT_SLACK_ENV = "OPS_ALERT_SLACK_WEBHOOK";
export const SHARED_OPS_ALERT_PAGERDUTY_ENV = "OPS_ALERT_PAGERDUTY_ROUTING_KEY";

function readEnvTrim(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

export function resolveOpsAlertChatTargets(opts: {
  /** Dedicated Slack webhook env var name (e.g. `OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK`). */
  slackEnvVar: string;
  /** Dedicated PagerDuty routing key env var name (e.g. `OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY`). */
  pagerDutyEnvVar: string;
  /** Override the shared Slack fallback env var (defaults to `OPS_ALERT_SLACK_WEBHOOK`). */
  sharedSlackEnvVar?: string;
  /** Override the shared PagerDuty fallback env var (defaults to `OPS_ALERT_PAGERDUTY_ROUTING_KEY`). */
  sharedPagerDutyEnvVar?: string;
}): OpsAlertChatTargets {
  const sharedSlack = opts.sharedSlackEnvVar ?? SHARED_OPS_ALERT_SLACK_ENV;
  const sharedPd = opts.sharedPagerDutyEnvVar ?? SHARED_OPS_ALERT_PAGERDUTY_ENV;
  return {
    slackWebhook: readEnvTrim(opts.slackEnvVar) ?? readEnvTrim(sharedSlack),
    pagerDutyRoutingKey:
      readEnvTrim(opts.pagerDutyEnvVar) ?? readEnvTrim(sharedPd),
  };
}

// ── Sanitised chat-target status for super-admin dashboards (Task #2055) ─
//
// Mirrors `resolveOpsAlertChatTargets` but only exposes whether each
// channel resolved AND which env source resolved it (dedicated vs.
// shared) — never the webhook URL or routing key itself. Powers the
// GET `/super-admin/ops-alert-settings/chat-targets` endpoint so an
// admin can tell at a glance whether the "Send test alert" button will
// also fire a chat page, and whether the dedicated env var or the
// shared fallback is the one carrying it.
//
// Source semantics:
//   - "dedicated" — the per-flow env var (e.g.
//     `OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK`) was set and used.
//   - "shared"    — the per-flow env var was unset; the shared
//     fallback (e.g. `OPS_ALERT_SLACK_WEBHOOK`) was used instead.
//   - null        — neither env var was set; the channel is missing.

export interface OpsAlertChatChannelStatus {
  status: "configured" | "missing";
  source: "dedicated" | "shared" | null;
  /** Dedicated env var name inspected first (always reported so admins know what to set). */
  dedicatedEnvVar: string;
  /** Shared fallback env var name inspected second. */
  sharedEnvVar: string;
}

export interface OpsAlertChatTargetsStatus {
  slack: OpsAlertChatChannelStatus;
  pagerDuty: OpsAlertChatChannelStatus;
}

function statusForChannel(opts: {
  dedicatedEnvVar: string;
  sharedEnvVar: string;
}): OpsAlertChatChannelStatus {
  const { dedicatedEnvVar, sharedEnvVar } = opts;
  if (readEnvTrim(dedicatedEnvVar) !== null) {
    return { status: "configured", source: "dedicated", dedicatedEnvVar, sharedEnvVar };
  }
  if (readEnvTrim(sharedEnvVar) !== null) {
    return { status: "configured", source: "shared", dedicatedEnvVar, sharedEnvVar };
  }
  return { status: "missing", source: null, dedicatedEnvVar, sharedEnvVar };
}

export function resolveOpsAlertChatTargetsStatus(opts: {
  /** Dedicated Slack webhook env var name. */
  slackEnvVar: string;
  /** Dedicated PagerDuty routing key env var name. */
  pagerDutyEnvVar: string;
  /** Override the shared Slack fallback env var (defaults to `OPS_ALERT_SLACK_WEBHOOK`). */
  sharedSlackEnvVar?: string;
  /** Override the shared PagerDuty fallback env var (defaults to `OPS_ALERT_PAGERDUTY_ROUTING_KEY`). */
  sharedPagerDutyEnvVar?: string;
}): OpsAlertChatTargetsStatus {
  return {
    slack: statusForChannel({
      dedicatedEnvVar: opts.slackEnvVar,
      sharedEnvVar: opts.sharedSlackEnvVar ?? SHARED_OPS_ALERT_SLACK_ENV,
    }),
    pagerDuty: statusForChannel({
      dedicatedEnvVar: opts.pagerDutyEnvVar,
      sharedEnvVar: opts.sharedPagerDutyEnvVar ?? SHARED_OPS_ALERT_PAGERDUTY_ENV,
    }),
  };
}

// ── Generic Slack / PagerDuty senders (Task #1652) ───────────────────────
//
// Each ops-alert flow shapes its message to its own subject by passing
// a headline / fields / body / cooldown-note bundle to `sendOpsAlertSlack`
// (Block Kit) or a summary / source / component / dedup-key bundle to
// `triggerOpsAlertPagerDuty` (Events API v2). Per-flow wrappers below
// translate their domain inputs into this shape so call sites stay
// readable.

/** Display row rendered both in the Slack section and in PD `custom_details`. */
export interface OpsAlertChatField {
  label: string;
  value: string | number;
}

export interface OpsAlertSlackOpts {
  webhookUrl: string;
  /**
   * Headline shown both in the Slack message preview (`text`) and in
   * push notifications. Should usually start with an emoji shortcode
   * (e.g. `:warning:`) to mirror the email subject line.
   */
  headline: string;
  /**
   * Block Kit header text (plain text, no Markdown). When omitted,
   * the leading emoji is stripped from `headline` and the rest used.
   */
  headerText?: string;
  /** Bullet rows printed under the timestamp. Empty values are skipped. */
  fields?: OpsAlertChatField[];
  /** Free-form Markdown body shown after the field rows (e.g. a diagnostic hint). */
  body?: string;
  /** Italic suppression note printed at the bottom (e.g. cooldown wording). */
  cooldownNote?: string;
  now: Date;
}

export async function sendOpsAlertSlack(opts: OpsAlertSlackOpts): Promise<void> {
  const { webhookUrl, headline, headerText, fields, body, cooldownNote, now } = opts;
  const fieldLines = (fields ?? [])
    .filter((f) => f.value !== "" && f.value != null)
    .map((f) => `*${f.label}:* ${f.value}`);
  const sectionLines = [`*When:* ${fmtUtc(now)}`, ...fieldLines];
  if (body) {
    sectionLines.push("", body);
  }
  if (cooldownNote) {
    sectionLines.push("", `_${cooldownNote}_`);
  }
  const payload = {
    text: headline,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: headerText ?? headline.replace(/^:[^:\s]+:\s*/, ""),
          emoji: true,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: sectionLines.join("\n") },
      },
    ],
  };
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Slack returns "ok" in body on success and "invalid_payload"/etc on
    // error; the HTTP status is also 200/non-200, which is enough for our
    // purposes (we just want to surface non-delivery to the warn log).
    const detail = await res.text().catch(() => "");
    throw new Error(`Slack webhook returned ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export interface OpsAlertPagerDutyOpts {
  routingKey: string;
  /** PD `payload.summary` — short single-line description (≤ 1024 chars). */
  summary: string;
  /** PD `payload.source` — identifies the emitting subsystem. */
  source: string;
  /** PD `payload.component` — finer-grained source path. */
  component: string;
  /** PD `payload.group` — broad grouping for routing rules. */
  group: string;
  /** PD `payload.class` — incident sub-type used by routing rules. */
  className: string;
  /** PD severity. Defaults to `warning`. */
  severity?: "info" | "warning" | "error" | "critical";
  /**
   * PD `dedup_key` — fixed (or scoped, e.g. by UTC date) per alert
   * flow so a sustained spike folds into one open incident in
   * PagerDuty (complementing per-replica cooldowns at the call site).
   */
  dedupKey: string;
  /** Free-form key/value pairs surfaced under PD's "Custom Details". */
  customDetails: Record<string, string | number | boolean | null>;
  now: Date;
}

export async function triggerOpsAlertPagerDuty(opts: OpsAlertPagerDutyOpts): Promise<void> {
  const {
    routingKey,
    summary,
    source,
    component,
    group,
    className,
    severity = "warning",
    dedupKey,
    customDetails,
    now,
  } = opts;
  const payload = {
    routing_key: routingKey,
    event_action: "trigger" as const,
    dedup_key: dedupKey,
    payload: {
      summary,
      source,
      severity,
      timestamp: now.toISOString(),
      component,
      group,
      class: className,
      custom_details: customDetails,
    },
  };
  const res = await fetch(PAGERDUTY_EVENTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(PAGERDUTY_POST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`PagerDuty Events API returned ${res.status}: ${detail.slice(0, 200)}`);
  }
}

// ── Watch GPS spike (Task #1374) ─────────────────────────────────────────
//
// Per-flow wrappers around the generic senders above. Implemented as
// wrappers (rather than inlined) so call sites in
// `watchPositionMetrics.ts` stay tiny and the watch-GPS subject /
// PagerDuty routing fields are co-located with the rest of the
// per-flow chat logic.
//
// Task #1653 — `testMode` toggles a "Send test page" variant fired from
// the super-admin ops dashboard. The test variant is clearly labelled
// "[TEST]" + "no real spike", uses a separate PagerDuty `dedup_key` so
// it can never collapse into an in-flight real incident, and downgrades
// PD severity to "info" so a wiring check doesn't wake on-call. The
// test still goes through the same Slack/PagerDuty HTTP code path so a
// misconfigured webhook URL or routing key surfaces the same warn log
// as a real failure — that's the whole point of the button.

export interface WatchPositionTrendOpsAlertChatOpts {
  recentAvg: number;
  baselineAvg: number;
  windowSize: number;
  multiplier: number;
  cooldownMinutes: number;
  now: Date;
  /**
   * Task #1653 — when true, render a clearly-labelled "[TEST]" wiring
   * verification instead of a real spike alert. See the section header
   * above for the full rationale.
   */
  testMode?: boolean;
}

/**
 * Post a Slack message about a watch GPS message-rate spike to the
 * given incoming-webhook URL. Mirrors the structure of the email
 * sender so on-call sees the same information regardless of channel.
 */
export async function postWatchPositionTrendOpsAlertSlack(opts: {
  webhookUrl: string;
} & WatchPositionTrendOpsAlertChatOpts): Promise<void> {
  const { webhookUrl, recentAvg, baselineAvg, windowSize, multiplier, cooldownMinutes, now, testMode } = opts;
  const ratio = baselineAvg > 0 ? Math.round((recentAvg / baselineAvg) * 100) / 100 : null;
  if (testMode) {
    await sendOpsAlertSlack({
      webhookUrl,
      headline: ":test_tube: [TEST] Watch GPS ops alert wiring test — no real spike is happening",
      headerText: "[TEST] Watch GPS ops alert wiring",
      body: [
        "*This is a test page from the super-admin ops dashboard.*",
        "It confirms that the Slack incoming webhook URL configured for `OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK` (or the shared `OPS_ALERT_SLACK_WEBHOOK`) reaches this channel.",
        "No real watch GPS spike is happening; you can ignore this message.",
        "",
        "_When a real spike is detected, the message body includes the recent vs. baseline rates, the ratio, and a regression hint._",
      ].join("\n"),
      cooldownNote: "Test pages are not subject to the spike-alert cooldown.",
      now,
    });
    return;
  }
  await sendOpsAlertSlack({
    webhookUrl,
    headline: `:warning: Watch GPS message rate spiking — ${recentAvg.toFixed(2)} msgs/session-minute (baseline ${baselineAvg.toFixed(2)})`,
    headerText: "Watch GPS message rate spiking",
    fields: [
      { label: `Recent ${windowSize}-bucket avg`, value: `${recentAvg.toFixed(2)} msgs/session-minute` },
      { label: `Baseline ${windowSize}-bucket avg`, value: `${baselineAvg.toFixed(2)} msgs/session-minute` },
      ...(ratio !== null ? [{ label: "Ratio", value: `${ratio}× (threshold ${multiplier}×)` }] : []),
    ],
    body: "This usually means Task #722's client-side debounce on the watch is no longer suppressing redundant `position` pings. Recent watch / mobile / api-server changes are the most likely culprits — bisect from the most recent deploy.",
    cooldownNote: `Repeat alerts are suppressed for ${cooldownMinutes} minute(s) per replica while the spike persists.`,
    now,
  });
}

/**
 * Trigger a PagerDuty incident about a watch GPS message-rate spike via
 * the Events API v2 (`/v2/enqueue`). The fixed `dedup_key` keeps
 * successive triggers inside the same incident window deduplicated to
 * one open incident in PagerDuty.
 */
export async function triggerWatchPositionTrendOpsAlertPagerDuty(opts: {
  routingKey: string;
} & WatchPositionTrendOpsAlertChatOpts): Promise<void> {
  const { routingKey, recentAvg, baselineAvg, windowSize, multiplier, cooldownMinutes, now, testMode } = opts;
  const ratio = baselineAvg > 0 ? Math.round((recentAvg / baselineAvg) * 100) / 100 : null;
  if (testMode) {
    await triggerOpsAlertPagerDuty({
      routingKey,
      summary: "[TEST] Watch GPS ops alert wiring test — no real spike is happening",
      source: "api-server/watchPositionMetrics",
      component: "ws-watch/metrics",
      group: "watch-gps",
      // Distinct class so PD routing rules keyed on `class: "trend-spike"`
      // don't apply to test pages.
      className: "trend-spike-wiring-test",
      // Real spikes page on "warning"; the test page is downgraded to "info"
      // so a wiring check doesn't wake up on-call. Operators should be aware
      // that PagerDuty escalation policies which only trigger on "warning"+
      // will receive the test event but won't notify a person — the test
      // still verifies routing-key validity + Events API reachability, which
      // is the part that actually breaks silently.
      severity: "info",
      // Separate dedup_key so a wiring test doesn't collapse into (or get
      // suppressed by) the open incident from a real spike in flight, and
      // vice versa.
      dedupKey: "watch-position-trend-spike-test",
      customDetails: {
        test_page: true,
        note: "This is a wiring verification fired from the super-admin ops dashboard. No real watch GPS spike is happening; the on-call rotation can ignore (and resolve) this incident.",
        window_size: windowSize,
        multiplier,
        cooldown_minutes: cooldownMinutes,
      },
      now,
    });
    return;
  }
  await triggerOpsAlertPagerDuty({
    routingKey,
    summary: `Watch GPS message rate spiking — ${recentAvg.toFixed(2)} msgs/session-minute (baseline ${baselineAvg.toFixed(2)})`,
    source: "api-server/watchPositionMetrics",
    component: "ws-watch/metrics",
    group: "watch-gps",
    className: "trend-spike",
    severity: "warning",
    dedupKey: "watch-position-trend-spike",
    customDetails: {
      recent_avg_msgs_per_session_minute: Math.round(recentAvg * 100) / 100,
      baseline_avg_msgs_per_session_minute: Math.round(baselineAvg * 100) / 100,
      window_size: windowSize,
      multiplier,
      ratio,
      cooldown_minutes: cooldownMinutes,
      hint: "Likely regression of Task #722's watch-side debounce. Bisect from the most recent deploy.",
    },
    now,
  });
}

// ── Notification retry exhaustion (Task #1652) ───────────────────────────
//
// Sibling of `sendNotifyRetryExhaustionOpsAlertEmail` in `mailer.ts`.
// Generalises the watch-GPS wrappers above to the notification-retry
// flow: same per-channel try/catch + missing-config warn-log pattern
// at the dispatch site (`notifyExhaustionOpsAlert.ts`), but the
// message text / PD routing fields are shaped to this flow's subject
// rather than reusing the watch-GPS copy.
//
// Test pages (Task #1547) get an `isTest` flag so the Slack header /
// PD severity make it obvious this is not a live incident, and the PD
// `dedup_key` is salted with a timestamp so a test page never collapses
// onto a real incident already open in PagerDuty.

export interface NotifyRetryExhaustionChatOpts {
  summary: {
    windowHours: number;
    threshold: number;
    coachPayout: { push: number; sms: number; rows: number };
    levyReceipt: { push: number; sms: number; rows: number };
    totalRows: number;
  };
  since: Date;
  now: Date;
  /** When true, the message is clearly labelled as a manually triggered TEST. */
  isTest?: boolean;
}

export async function postNotifyRetryExhaustionOpsAlertSlack(opts: {
  webhookUrl: string;
} & NotifyRetryExhaustionChatOpts): Promise<void> {
  const { webhookUrl, summary, since, now, isTest } = opts;
  const totalLabel = `${summary.totalRows} ${isTest ? "synthetic " : ""}exhausted row${summary.totalRows === 1 ? "" : "s"}`;
  const headline = isTest
    ? `:test_tube: [TEST] Ops alert delivery check — ${totalLabel}`
    : `:warning: Notification retries exhausted — ${totalLabel} in the last ${summary.windowHours}h`;
  const headerText = isTest
    ? "Notification retry exhaustion — test alert"
    : "Notification retries exhausted";
  const body = isTest
    ? "This is a manually triggered delivery check from the super-admin Ops Alert card — no real exhaustions occurred. The numbers above are synthetic. If you see this message, the chat-page wiring is correct."
    : "A spike usually indicates a systemic outage — FCM/APNs key revoked, Twilio account suspended, or `SMS_PROVIDER` unset in prod. Investigate the provider configuration and replay the affected rows once the underlying issue is resolved.";
  await sendOpsAlertSlack({
    webhookUrl,
    headline,
    headerText,
    fields: [
      { label: "Window", value: `${fmtUtc(since)} → ${fmtUtc(now)} (${summary.windowHours}h)` },
      { label: "Threshold", value: summary.threshold },
      { label: "Total exhausted rows", value: summary.totalRows },
      { label: "Coach payout (push / SMS / rows)", value: `${summary.coachPayout.push} / ${summary.coachPayout.sms} / ${summary.coachPayout.rows}` },
      { label: "Levy receipt (push / SMS / rows)", value: `${summary.levyReceipt.push} / ${summary.levyReceipt.sms} / ${summary.levyReceipt.rows}` },
    ],
    body,
    cooldownNote: isTest
      ? "Test pages do not consume the daily dedup."
      : "One alert per UTC day per replica.",
    now,
  });
}

// ── Wallet refund SMS/WhatsApp retry exhaustion (Task #1863) ─────────────
//
// Sibling of the cross-pipeline `notify-retry-exhaustion` chat helpers
// above. Per-org, hourly cadence, scoped to the wallet-topup-refund
// SMS / WhatsApp pipeline because that flow is structurally different
// (members already got their money back; the alert is purely about the
// dropped delivery confirmation) and has its own dedicated env-driven
// configuration. Embeds per-org rows + sample provider error strings
// in both the Slack section and the PagerDuty `custom_details` so
// on-call has actionable evidence in whichever surface they get the
// page on.

export interface WalletTopupRefundRetryExhaustionChatOrgRow {
  organizationId: number;
  organizationName: string | null;
  smsExhausted: number;
  whatsappExhausted: number;
  rowsExhausted: number;
  sampleErrors: Array<{
    channel: "sms" | "whatsapp";
    exhaustedAt: string;
    message: string | null;
  }>;
}

export interface WalletTopupRefundRetryExhaustionChatOpts {
  threshold: number;
  windowHours: number;
  cooldownHours: number;
  since: Date;
  now: Date;
  /** Orgs whose `rowsExhausted >= threshold`. Always non-empty. */
  breached: WalletTopupRefundRetryExhaustionChatOrgRow[];
}

function summariseRefundOrgForChat(b: WalletTopupRefundRetryExhaustionChatOrgRow): string {
  const orgLabel = b.organizationName
    ? `${b.organizationName} (id ${b.organizationId})`
    : `org id ${b.organizationId}`;
  const sample = b.sampleErrors.slice(0, 3).map((s) => {
    const msg = (s.message ?? "(no message)").slice(0, 160);
    return `    • [${s.channel}] ${msg}`;
  });
  return [
    `*${orgLabel}* — ${b.rowsExhausted} row${b.rowsExhausted === 1 ? "" : "s"} (sms ${b.smsExhausted} / wa ${b.whatsappExhausted})`,
    ...sample,
  ].join("\n");
}

export async function postWalletTopupRefundRetryExhaustionOpsAlertSlack(opts: {
  webhookUrl: string;
} & WalletTopupRefundRetryExhaustionChatOpts): Promise<void> {
  const { webhookUrl, threshold, windowHours, cooldownHours, since, now, breached } = opts;
  const totalRows = breached.reduce((acc, b) => acc + b.rowsExhausted, 0);
  const orgWord = breached.length === 1 ? "org" : "orgs";
  const headline = `:warning: Wallet refund SMS/WhatsApp retries dropped — ${totalRows} row${totalRows === 1 ? "" : "s"} across ${breached.length} ${orgWord}`;
  const orgBlocks = breached.map(summariseRefundOrgForChat).join("\n\n");
  const body = [
    "Members were refunded but never received the SMS/WhatsApp confirmation. A spike across multiple refunds in this window almost always means a Twilio outage, a revoked WhatsApp Business token, or `SMS_PROVIDER` unset in prod — not isolated bad phone numbers.",
    "",
    "*Breached orgs:*",
    "",
    orgBlocks,
  ].join("\n");
  await sendOpsAlertSlack({
    webhookUrl,
    headline,
    headerText: "Wallet refund SMS/WhatsApp retries dropped",
    fields: [
      { label: "Window", value: `${fmtUtc(since)} → ${fmtUtc(now)} (${windowHours}h)` },
      { label: "Per-org threshold", value: threshold },
      { label: "Total exhausted rows", value: totalRows },
      { label: "Orgs breached", value: breached.length },
    ],
    body,
    cooldownNote: `Repeat alerts suppressed for ${cooldownHours}h per replica while the issue persists.`,
    now,
  });
}

export async function triggerWalletTopupRefundRetryExhaustionOpsAlertPagerDuty(opts: {
  routingKey: string;
} & WalletTopupRefundRetryExhaustionChatOpts): Promise<void> {
  const { routingKey, threshold, windowHours, cooldownHours, since, now, breached } = opts;
  const totalRows = breached.reduce((acc, b) => acc + b.rowsExhausted, 0);
  const orgWord = breached.length === 1 ? "org" : "orgs";
  // Cap the orgs serialised into custom_details so the PD payload stays
  // well under the documented 512 KB limit even on a pathological
  // cross-tenant outage. The full breakdown is always in the email.
  const PD_ORG_CAP = 20;
  const cappedBreached = breached.slice(0, PD_ORG_CAP);
  await triggerOpsAlertPagerDuty({
    routingKey,
    summary: `Wallet refund SMS/WhatsApp retries dropped — ${totalRows} row${totalRows === 1 ? "" : "s"} across ${breached.length} ${orgWord} (per-org threshold ${threshold}, last ${windowHours}h)`,
    source: "api-server/walletTopupRefundRetryExhaustionOpsAlert",
    component: "wallet-topup-refund-notify",
    group: "ops-alerts",
    className: "retry-exhaustion",
    severity: "warning",
    // Scope the dedup key to the UTC hour so an hour-long outage folds
    // into one PD incident, but a fresh outage the next hour pages
    // again. Mirrors the per-replica cooldown semantics used for the
    // email/Slack branch.
    dedupKey: `wallet-refund-retry-exhaustion-${now.toISOString().slice(0, 13)}`,
    customDetails: {
      window_hours: windowHours,
      cooldown_hours: cooldownHours,
      per_org_threshold: threshold,
      total_rows_exhausted: totalRows,
      orgs_breached: breached.length,
      orgs_breached_preview: JSON.stringify(
        cappedBreached.map((b) => ({
          organization_id: b.organizationId,
          organization_name: b.organizationName,
          rows_exhausted: b.rowsExhausted,
          sms_exhausted: b.smsExhausted,
          whatsapp_exhausted: b.whatsappExhausted,
          sample_errors: b.sampleErrors.slice(0, 3).map((s) => ({
            channel: s.channel,
            exhausted_at: s.exhaustedAt,
            message: s.message,
          })),
        })),
      ),
      orgs_breached_truncated:
        breached.length > PD_ORG_CAP ? breached.length - PD_ORG_CAP : 0,
      since: since.toISOString(),
      hint: "Likely systemic outage in Twilio (SMS/WhatsApp) or a missing SMS_PROVIDER env. Check provider configuration before triaging individual rows.",
    },
    now,
  });
}

export async function triggerNotifyRetryExhaustionOpsAlertPagerDuty(opts: {
  routingKey: string;
} & NotifyRetryExhaustionChatOpts): Promise<void> {
  const { routingKey, summary, since, now, isTest } = opts;
  const summaryText = isTest
    ? `[TEST] Ops alert delivery check — ${summary.totalRows} synthetic exhausted row${summary.totalRows === 1 ? "" : "s"}`
    : `Notification retries exhausted — ${summary.totalRows} row${summary.totalRows === 1 ? "" : "s"} permanently failed in the last ${summary.windowHours}h`;
  await triggerOpsAlertPagerDuty({
    routingKey,
    summary: summaryText,
    source: "api-server/notifyExhaustionOpsAlert",
    component: "notification-retry",
    group: "ops-alerts",
    className: "retry-exhaustion",
    severity: isTest ? "info" : "warning",
    // Include the UTC date in the dedup key so each day's incident gets
    // its own PD ticket — matches the cron's daily dedup semantics. A
    // sustained outage spanning UTC midnight pages once on each side of
    // the boundary, which mirrors how the email branch behaves. Test
    // pages get a full-timestamp suffix so they never collapse onto a
    // real incident already open in PagerDuty.
    dedupKey: isTest
      ? `notify-retry-exhaustion-test-${now.toISOString()}`
      : `notify-retry-exhaustion-${now.toISOString().slice(0, 10)}`,
    customDetails: {
      is_test: isTest ?? false,
      window_hours: summary.windowHours,
      threshold: summary.threshold,
      total_rows: summary.totalRows,
      coach_payout_push: summary.coachPayout.push,
      coach_payout_sms: summary.coachPayout.sms,
      coach_payout_rows: summary.coachPayout.rows,
      levy_receipt_push: summary.levyReceipt.push,
      levy_receipt_sms: summary.levyReceipt.sms,
      levy_receipt_rows: summary.levyReceipt.rows,
      since: since.toISOString(),
      hint: isTest
        ? "Synthetic test page — no real outage in progress."
        : "Likely systemic outage in FCM/APNs or Twilio. Check provider configuration before triaging individual rows.",
    },
    now,
  });
}

// ── Manual-entry alert health (Task #2054) ──────────────────────────────
//
// Sibling of `sendManualEntryAlertHealthOpsAlertEmail` in `mailer.ts`.
// Reuses the generic Slack / PagerDuty senders above so the
// dispatch site (`manualEntryAlertHealthOpsAlert.ts`) follows the
// same per-channel try/catch + missing-config warn-log pattern as the
// notification-retry exhaustion (Task #1652) and watch GPS spike
// (Task #1374) flows. Message text / PD routing fields are shaped to
// the manual-entry-alert subject; PD `dedup_key` is hour-scoped so a
// sustained outage folds into one PD incident across hourly cron
// ticks (mirroring the per-replica email cooldown).

export interface ManualEntryAlertHealthChatOpts {
  breaches: Array<{
    /**
     * Task #2066 added `muted_pile_up` for the auto-page rule that
     * catches an org left silently muted with `org_muted` /
     * `tournament_muted` skips piling up. Slack/PagerDuty render the
     * breach detail string verbatim, so no per-kind handling is
     * required here — only the type list needs to keep parity with
     * `ManualEntryAlertHealthBreachKind`.
     */
    kind: "delivery_rate" | "consecutive_zero" | "muted_pile_up";
    detail: string;
  }>;
  summary7d: {
    alertCount: number;
    anyDeliveryRate: number;
    pushDeliveryRate: number;
    emailDeliveryRate: number;
    zeroDeliveryCount: number;
  };
  thresholdPct: number;
  minSample: number;
  consecutiveZero: number;
  cooldownHours: number;
  dashboardUrl: string;
  now: Date;
  /**
   * Task #2066 — orgs whose `org_muted` + `tournament_muted` row count
   * in the 7d window crossed `mutedPileUpThreshold`. Optional so
   * existing callers without this signal don't have to construct an
   * empty list, and so future callers building a chat-only path don't
   * have to fan out the muted-skip query themselves. The dispatcher
   * adds a Slack section listing the offending orgs/tournaments only
   * when this is non-empty; otherwise the chat message looks identical
   * to the pre-#2066 layout.
   */
  mutedPileUpThreshold?: number;
  mutedPileUpOrgs?: Array<{
    organizationId: number | null;
    organizationName: string | null;
    totalCount: number;
    orgMutedCount: number;
    tournamentMutedCount: number;
    tournaments: Array<{
      tournamentId: number | null;
      tournamentName: string | null;
      count: number;
      orgMutedCount: number;
      tournamentMutedCount: number;
    }>;
  }>;
  /**
   * Task #2057 — when true, render a clearly-labelled `[TEST]` page so
   * an admin verifying the wiring from the dashboard can tell the page
   * apart from a real delivery-rate breach, and the PagerDuty
   * `dedup_key` is salted with a full timestamp so the test never
   * collapses onto a real open incident. Mirrors the notify-retry /
   * watch-GPS test-page pattern.
   */
  isTest?: boolean;
}

function describeManualEntryBreachKinds(
  breaches: ManualEntryAlertHealthChatOpts["breaches"],
): string {
  return breaches.map((b) => b.kind).join("+") || "delivery-health";
}

export async function postManualEntryAlertHealthOpsAlertSlack(opts: {
  webhookUrl: string;
} & ManualEntryAlertHealthChatOpts): Promise<void> {
  const {
    webhookUrl,
    breaches,
    summary7d,
    thresholdPct,
    minSample,
    consecutiveZero,
    cooldownHours,
    dashboardUrl,
    now,
    mutedPileUpThreshold,
    mutedPileUpOrgs,
    isTest,
  } = opts;
  const breachLines = breaches.map((b) => `• ${b.detail}`);
  // Task #2066 — when an org tripped the muted-skip pile-up rule, embed
  // the offending orgs/tournaments inline so on-call can DM the right
  // TD without opening the dashboard. Skipped for the Task #2057 test
  // page since the synthetic payload never includes muted-skip data.
  const mutedSection = mutedPileUpOrgs && mutedPileUpOrgs.length > 0
    ? [
        "",
        `*Stuck-muted orgs (>= ${mutedPileUpThreshold ?? "?"} muted skips in 7d):*`,
        ...formatMutedPileUpOrgsForSlack(mutedPileUpOrgs),
      ]
    : [];
  const headline = isTest
    ? `:test_tube: [TEST] Manual-entry alert health ops alert wiring test — no real delivery breach`
    : `:warning: Manual-entry alerts not reaching anyone — ${describeManualEntryBreachKinds(breaches)} breach`;
  const headerText = isTest
    ? "[TEST] Manual-entry alert health ops alert wiring"
    : "Manual-entry alert health breach";
  const body = isTest
    ? "*This is a test page from the super-admin manual-entry alerts dashboard.* It confirms that the Slack incoming webhook URL configured for `OPS_MANUAL_ENTRY_ALERT_HEALTH_SLACK_WEBHOOK` (or the shared `OPS_ALERT_SLACK_WEBHOOK`) reaches this channel. No real delivery-rate breach is happening; you can ignore this message."
    : [
        "*Breaches:*",
        ...breachLines,
        ...mutedSection,
        "",
        "Likely a stale APNs cert, a bouncing tournament-director inbox, or an SMTP outage. Open the dashboard linked above for the per-tournament / per-recipient breakdown before triaging individual rows.",
      ].join("\n");
  await sendOpsAlertSlack({
    webhookUrl,
    headline,
    headerText,
    fields: [
      {
        label: "7d any-delivery rate",
        value: `${summary7d.anyDeliveryRate}% (threshold ${thresholdPct}%)`,
      },
      {
        label: "7d push / email delivery rate",
        value: `${summary7d.pushDeliveryRate}% / ${summary7d.emailDeliveryRate}%`,
      },
      {
        label: "7d alerts (zero-delivery / total)",
        value: `${summary7d.zeroDeliveryCount} / ${summary7d.alertCount}`,
      },
      {
        label: "Min sample / consecutive-zero trigger",
        value: `${minSample} / ${consecutiveZero}`,
      },
      { label: "Dashboard", value: dashboardUrl },
    ],
    body,
    cooldownNote: isTest
      ? "Test pages are not subject to the per-replica delivery-health cooldown."
      : `Repeat alerts suppressed for ${cooldownHours}h per replica while the issue persists.`,
    now,
  });
}

function formatMutedPileUpOrgsForSlack(
  orgs: NonNullable<ManualEntryAlertHealthChatOpts["mutedPileUpOrgs"]>,
): string[] {
  const lines: string[] = [];
  for (const o of orgs) {
    const orgLabel = o.organizationName
      ? `${o.organizationName} (#${o.organizationId ?? "?"})`
      : o.organizationId != null
        ? `org #${o.organizationId}`
        : "(unknown organization)";
    lines.push(
      `• *${orgLabel}* — ${o.totalCount} muted skip(s)` +
        ` (org_muted=${o.orgMutedCount}, tournament_muted=${o.tournamentMutedCount})`,
    );
    for (const t of o.tournaments) {
      const tLabel = t.tournamentName
        ? `${t.tournamentName} (#${t.tournamentId ?? "?"})`
        : t.tournamentId != null
          ? `tournament #${t.tournamentId}`
          : "(unknown tournament)";
      lines.push(`    ◦ ${tLabel} — ${t.count}`);
    }
  }
  return lines;
}

export async function triggerManualEntryAlertHealthOpsAlertPagerDuty(opts: {
  routingKey: string;
} & ManualEntryAlertHealthChatOpts): Promise<void> {
  const {
    routingKey,
    breaches,
    summary7d,
    thresholdPct,
    minSample,
    consecutiveZero,
    cooldownHours,
    dashboardUrl,
    now,
    mutedPileUpThreshold,
    mutedPileUpOrgs,
    isTest,
  } = opts;
  const breachKinds = breaches.map((b) => b.kind);
  // Task #2066 — surface the offending orgs/tournaments in the PD
  // payload so the on-call responder can act from the incident page
  // without round-tripping to the dashboard. Cap the list at 10 orgs
  // to keep the PD `custom_details` blob from blowing up if a global
  // outage tripped the rule across many orgs.
  const PD_ORG_CAP = 10;
  const cappedMutedOrgs = (mutedPileUpOrgs ?? []).slice(0, PD_ORG_CAP);
  const summaryText = isTest
    ? "[TEST] Manual-entry alert health ops alert wiring test — no real delivery breach"
    : `Manual-entry alerts not reaching anyone — ${describeManualEntryBreachKinds(breaches)} breach (7d any-delivery ${summary7d.anyDeliveryRate}%, threshold ${thresholdPct}%)`;
  await triggerOpsAlertPagerDuty({
    routingKey,
    summary: summaryText,
    source: "api-server/manualEntryAlertHealthOpsAlert",
    component: "manual-entry-alerts",
    group: "ops-alerts",
    className: isTest ? "delivery-health-wiring-test" : "delivery-health",
    severity: isTest ? "info" : "warning",
    // Real breach pages use an hour-scoped dedup so a sustained outage
    // folds into one PD incident across the hourly cron ticks, matching
    // the per-replica email cooldown. Test pages get a full-timestamp
    // suffix so they never collapse onto a real open incident.
    dedupKey: isTest
      ? `manual-entry-alert-health-test-${now.toISOString()}`
      : `manual-entry-alert-health-${now.toISOString().slice(0, 13)}`,
    customDetails: {
      is_test: isTest ?? false,
      breach_kinds: breachKinds.join(","),
      breach_details: breaches.map((b) => b.detail).join(" | "),
      window: "7d",
      alert_count_7d: summary7d.alertCount,
      any_delivery_rate_7d: summary7d.anyDeliveryRate,
      push_delivery_rate_7d: summary7d.pushDeliveryRate,
      email_delivery_rate_7d: summary7d.emailDeliveryRate,
      zero_delivery_count_7d: summary7d.zeroDeliveryCount,
      threshold_pct: thresholdPct,
      min_sample: minSample,
      consecutive_zero: consecutiveZero,
      cooldown_hours: cooldownHours,
      dashboard_url: dashboardUrl,
      muted_pile_up_threshold: mutedPileUpThreshold ?? null,
      muted_pile_up_org_count: (mutedPileUpOrgs ?? []).length,
      muted_pile_up_orgs_preview: JSON.stringify(
        cappedMutedOrgs.map((o) => ({
          org_id: o.organizationId,
          org_name: o.organizationName,
          total: o.totalCount,
          org_muted: o.orgMutedCount,
          tournament_muted: o.tournamentMutedCount,
          tournaments: o.tournaments.map((t) => ({
            id: t.tournamentId,
            name: t.tournamentName,
            count: t.count,
          })),
        })),
      ),
      muted_pile_up_orgs_truncated:
        (mutedPileUpOrgs ?? []).length > PD_ORG_CAP
          ? (mutedPileUpOrgs ?? []).length - PD_ORG_CAP
          : 0,
      hint: isTest
        ? "Synthetic test page — no real delivery-rate breach in progress."
        : "Likely a stale APNs cert, a bouncing tournament-director inbox, an SMTP outage, or — for muted_pile_up — an org-wide alert toggle left off after troubleshooting. Open the dashboard before triaging individual rows.",
    },
    now,
  });
}

// ── Badge-share rollup stale (Task #2054) ────────────────────────────────
//
// Sibling of `sendBadgeShareRollupStaleOpsAlertEmail` in `mailer.ts`.
// Same per-channel try/catch + missing-config warn-log pattern at the
// dispatch site (`badgeShareRollupOpsAlert.ts`); message text / PD
// routing fields are shaped to the rollup-stale subject. PD
// `dedup_key` is hour-scoped to mirror the singleton-persisted
// cooldown — a sustained stall folds into one PD incident across the
// hourly cron ticks.

export interface BadgeShareRollupStaleChatOpts {
  summary: {
    currentRawEventCount: number;
    currentAggregateRowCount: number;
    rollupAgeMs: number;
    staleThresholdMs: number;
    lastRun: { ranAt: string; rolledUpEvents: number } | null;
  };
  cooldownHours: number;
  dashboardUrl: string;
  now: Date;
  /**
   * Task #2057 — when true, render a clearly-labelled `[TEST]` page so
   * an admin verifying the wiring from the dashboard can tell the page
   * apart from a real stall, and the PagerDuty `dedup_key` is salted
   * with a full timestamp so the test never collapses onto a real open
   * incident. Mirrors the notify-retry / watch-GPS test-page pattern.
   */
  isTest?: boolean;
}

/**
 * Format a millisecond duration as a compact "Xh Ym" / "Ym" string for
 * human-readable Slack / PagerDuty bodies. Whole-hours-only durations
 * collapse to "Xh"; sub-hour durations show "Ym" only.
 */
function formatDurationFromMs(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export async function postBadgeShareRollupStaleOpsAlertSlack(opts: {
  webhookUrl: string;
} & BadgeShareRollupStaleChatOpts): Promise<void> {
  const { webhookUrl, summary, cooldownHours, dashboardUrl, now, isTest } = opts;
  const ageStr = formatDurationFromMs(summary.rollupAgeMs);
  const thresholdStr = formatDurationFromMs(summary.staleThresholdMs);
  const headline = isTest
    ? `:test_tube: [TEST] Badge-share rollup ops alert wiring test — no real stall is happening`
    : `:warning: Badge-share rollup is stale — last run ${ageStr} ago with ${summary.currentRawEventCount} raw event${summary.currentRawEventCount === 1 ? "" : "s"} waiting`;
  const headerText = isTest
    ? "[TEST] Badge-share rollup ops alert wiring"
    : "Badge-share rollup is stale";
  const body = isTest
    ? "*This is a test page from the super-admin badge-share rollup dashboard.* It confirms that the Slack incoming webhook URL configured for `OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK` (or the shared `OPS_ALERT_SLACK_WEBHOOK`) reaches this channel. No real stall is happening; you can ignore this message."
    : "The daily badge-share rollup has not run inside its stale threshold and there are raw events queued up. Likely a deploy regression, a container OOM-killed mid-run, or a runaway transaction blocking the rollup query. Open the dashboard linked above before triaging individual rows.";
  await sendOpsAlertSlack({
    webhookUrl,
    headline,
    headerText,
    fields: [
      {
        label: "Rollup age",
        value: `${ageStr} (stale threshold ${thresholdStr})`,
      },
      { label: "Raw events waiting", value: summary.currentRawEventCount },
      { label: "Aggregate rows", value: summary.currentAggregateRowCount },
      {
        label: "Last successful run",
        value: summary.lastRun
          ? `${summary.lastRun.ranAt} (rolled up ${summary.lastRun.rolledUpEvents} events)`
          : "never",
      },
      { label: "Dashboard", value: dashboardUrl },
    ],
    body,
    cooldownNote: isTest
      ? "Test pages are not subject to the stale-rollup cooldown."
      : `Repeat alerts suppressed for ${cooldownHours}h via the persisted singleton cooldown.`,
    now,
  });
}

// ── Swing fps-probe failure backlog (Task #2123) ─────────────────────────
//
// Sibling of `sendSwingFpsProbeFailureOpsAlertEmail` in `mailer.ts`.
// Same per-channel try/catch + missing-config warn-log pattern at the
// dispatch site (`swingFpsProbeFailureOpsAlert.ts`); message text /
// PD routing fields are shaped to the fps-probe-failure subject. PD
// `dedup_key` is UTC-date-scoped so a sustained-and-retriggered
// backlog folds into one PD incident across same-day cron ticks
// (mirroring the per-replica daily cooldown). The trigger flags
// (`thresholdBreached` / `growthBreached`) ride along in both the
// Slack section and the PD `custom_details` so on-call can see at a
// glance whether the absolute count or the run-over-run growth (or
// both) is the one that fired.
//
// No `isTest` flag — unlike the notify-retry / watch-GPS / badge-share
// flows, this alert has no super-admin "Send test page" surface; the
// retention sweep is the only caller. If a test surface is added later
// it should follow the same pattern those wrappers use (timestamp-
// salted `dedup_key`, `severity: "info"`).

export interface SwingFpsProbeFailureChatOpts {
  failedRetained: number;
  threshold: number;
  cooldownHours: number;
  growthCount: number;
  growthDelta: number;
  growthLookbackHours: number;
  trigger: { thresholdBreached: boolean; growthBreached: boolean };
  recentFailures: Array<{
    swingVideoId: number;
    completedAt: string | null;
    errorMessage: string | null;
  }>;
  dashboardUrl: string;
  now: Date;
}

/**
 * Compact label for the trigger combination — kept symmetric with the
 * email subject in `sendSwingFpsProbeFailureOpsAlertEmail` so on-call
 * sees the same wording across channels.
 */
function describeFpsProbeFailureTrigger(
  trigger: SwingFpsProbeFailureChatOpts["trigger"],
): string {
  if (trigger.thresholdBreached && trigger.growthBreached) return "count + growth";
  if (trigger.thresholdBreached) return "count";
  return "growth";
}

/**
 * How many recent-failure rows we embed inline in the Slack section /
 * PagerDuty `custom_details`. The full sample (whatever the alert job
 * loaded) is always relayed in `custom_details.recent_failures_preview`
 * up to this cap so the PD payload doesn't blow past PagerDuty's
 * `payload` size limit on a really nasty backlog.
 */
const FPS_PROBE_FAILURE_CHAT_SAMPLE_CAP = 5;

function formatFpsProbeFailureSampleForSlack(
  recentFailures: SwingFpsProbeFailureChatOpts["recentFailures"],
): string[] {
  if (recentFailures.length === 0) {
    return ["    _(no recent failed rows could be loaded)_"];
  }
  return recentFailures.slice(0, FPS_PROBE_FAILURE_CHAT_SAMPLE_CAP).map((r) => {
    const when = r.completedAt ?? "—";
    const msg = (r.errorMessage ?? "(no error message captured)").slice(0, 200);
    return `    • \`swing_video_id=${r.swingVideoId}\` @ ${when} — ${msg}`;
  });
}

export async function postSwingFpsProbeFailureOpsAlertSlack(opts: {
  webhookUrl: string;
} & SwingFpsProbeFailureChatOpts): Promise<void> {
  const {
    webhookUrl,
    failedRetained,
    threshold,
    cooldownHours,
    growthCount,
    growthDelta,
    growthLookbackHours,
    trigger,
    recentFailures,
    dashboardUrl,
    now,
  } = opts;
  const triggerLabel = describeFpsProbeFailureTrigger(trigger);
  const headline = `:warning: Swing fps-probe failures piling up — ${failedRetained} failed row${failedRetained === 1 ? "" : "s"} (${triggerLabel})`;
  const sampleLines = formatFpsProbeFailureSampleForSlack(recentFailures);
  const truncated = recentFailures.length > FPS_PROBE_FAILURE_CHAT_SAMPLE_CAP
    ? recentFailures.length - FPS_PROBE_FAILURE_CHAT_SAMPLE_CAP
    : 0;
  const body = [
    "*Most recent failures:*",
    ...sampleLines,
    ...(truncated > 0 ? [`    _…and ${truncated} more — see dashboard_`] : []),
    "",
    "`failed` rows are deliberately retained by the daily sweep so persistent failures stay visible. A growing backlog usually means a bad ffprobe deploy, a storage outage corrupting some objects, or a regression in the worker — not isolated bad uploads.",
  ].join("\n");
  await sendOpsAlertSlack({
    webhookUrl,
    headline,
    headerText: "Swing fps-probe failures piling up",
    fields: [
      {
        label: "Failed rows",
        value: `${failedRetained} (threshold ${threshold})`,
      },
      {
        label: `New failures in last ${growthLookbackHours}h`,
        value: `${growthCount} (growth delta ${growthDelta})`,
      },
      { label: "Trigger", value: triggerLabel },
      { label: "Dashboard", value: dashboardUrl },
    ],
    body,
    cooldownNote: `Repeat alerts are suppressed for ${cooldownHours}h per replica while the issue persists.`,
    now,
  });
}

export async function triggerSwingFpsProbeFailureOpsAlertPagerDuty(opts: {
  routingKey: string;
} & SwingFpsProbeFailureChatOpts): Promise<void> {
  const {
    routingKey,
    failedRetained,
    threshold,
    cooldownHours,
    growthCount,
    growthDelta,
    growthLookbackHours,
    trigger,
    recentFailures,
    dashboardUrl,
    now,
  } = opts;
  const triggerLabel = describeFpsProbeFailureTrigger(trigger);
  const cappedRecent = recentFailures.slice(0, FPS_PROBE_FAILURE_CHAT_SAMPLE_CAP);
  const summary = `Swing fps-probe failures piling up — ${failedRetained} failed row${failedRetained === 1 ? "" : "s"} (${triggerLabel})`;
  await triggerOpsAlertPagerDuty({
    routingKey,
    summary,
    source: "api-server/swingFpsProbeFailureOpsAlert",
    component: "swing-fps-probe",
    group: "ops-alerts",
    className: "fps-probe-failure-backlog",
    severity: "warning",
    // Real backlog pages use a UTC-date-scoped dedup so a sustained
    // backlog folds into one PD incident across same-day cron ticks
    // (mirroring the per-replica daily cooldown). Same shape the
    // notify-retry exhaustion alert uses.
    dedupKey: `swing-fps-probe-failure-${now.toISOString().slice(0, 10)}`,
    customDetails: {
      failed_retained: failedRetained,
      threshold,
      cooldown_hours: cooldownHours,
      growth_count: growthCount,
      growth_delta: growthDelta,
      growth_lookback_hours: growthLookbackHours,
      threshold_breached: trigger.thresholdBreached,
      growth_breached: trigger.growthBreached,
      trigger_label: triggerLabel,
      dashboard_url: dashboardUrl,
      recent_failures_count: recentFailures.length,
      recent_failures_truncated:
        recentFailures.length > FPS_PROBE_FAILURE_CHAT_SAMPLE_CAP
          ? recentFailures.length - FPS_PROBE_FAILURE_CHAT_SAMPLE_CAP
          : 0,
      recent_failures_preview: JSON.stringify(
        cappedRecent.map((r) => ({
          swing_video_id: r.swingVideoId,
          completed_at: r.completedAt,
          error_message: r.errorMessage,
        })),
      ),
      hint: "Likely a bad ffprobe deploy, a storage outage corrupting some objects, or a regression in the swing-fps-probe worker. Open the dashboard before triaging individual rows.",
    },
    now,
  });
}

export async function triggerBadgeShareRollupStaleOpsAlertPagerDuty(opts: {
  routingKey: string;
} & BadgeShareRollupStaleChatOpts): Promise<void> {
  const { routingKey, summary, cooldownHours, dashboardUrl, now, isTest } = opts;
  const ageStr = formatDurationFromMs(summary.rollupAgeMs);
  const summaryText = isTest
    ? "[TEST] Badge-share rollup ops alert wiring test — no real stall is happening"
    : `Badge-share rollup is stale — last run ${ageStr} ago with ${summary.currentRawEventCount} raw event${summary.currentRawEventCount === 1 ? "" : "s"} waiting`;
  await triggerOpsAlertPagerDuty({
    routingKey,
    summary: summaryText,
    source: "api-server/badgeShareRollupOpsAlert",
    component: "badge-share-rollup",
    group: "ops-alerts",
    className: isTest ? "rollup-stale-wiring-test" : "rollup-stale",
    severity: isTest ? "info" : "warning",
    // Real stall pages use an hour-scoped dedup so a sustained stall
    // folds into one PD incident across the hourly cron ticks. Test
    // pages get a full-timestamp suffix so they never collapse onto a
    // real open incident already up in PD.
    dedupKey: isTest
      ? `badge-share-rollup-stale-test-${now.toISOString()}`
      : `badge-share-rollup-stale-${now.toISOString().slice(0, 13)}`,
    customDetails: {
      is_test: isTest ?? false,
      rollup_age_ms: summary.rollupAgeMs,
      stale_threshold_ms: summary.staleThresholdMs,
      raw_events_waiting: summary.currentRawEventCount,
      aggregate_row_count: summary.currentAggregateRowCount,
      last_run_at: summary.lastRun?.ranAt ?? null,
      last_run_rolled_up_events: summary.lastRun?.rolledUpEvents ?? null,
      cooldown_hours: cooldownHours,
      dashboard_url: dashboardUrl,
      hint: isTest
        ? "Synthetic test page — no real stall in progress."
        : "Likely a deploy regression, OOM-killed cron, or runaway transaction blocking the rollup query. Open the dashboard before triaging individual rows.",
    },
    now,
  });
}
