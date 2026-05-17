/**
 * Aggregations over `manual_entry_alerts` for the super-admin delivery-health
 * dashboard (Task #1193).
 *
 * Schema records aggregate counts per alert (`pushAttempted`, `pushSent`,
 * `emailAttempted`, `emailSent`, `recipientCount`) so:
 *  - "zero-delivery" = `pushSent = 0 AND emailSent = 0` (alert reached
 *    nobody on either channel).
 *
 * `silentRecipientTotal` (and the per-tournament / per-org variants) is
 * now derived from `manual_entry_alert_recipients` (Task #1386), which
 * persists one row per (alert, user, channel) attempt. A user is "silent"
 * for an alert when they have at least one attempt row but no row with
 * status `sent`. This replaces the older proxy that summed alert-level
 * `recipientCount` across zero-delivery alerts and lets the dashboard
 * surface partially-silent alerts (e.g. half the TDs got nothing) with
 * the actual missed-recipient count instead of an upper bound (Task #1671).
 *
 * The per-alert drill-down (`getManualEntryAlertSilentRecipients`) reads
 * from the same recipient table for the per-(alert, user, channel) attempt
 * status surfaced in the dashboard's silent-recipient panel.
 */
import {
  db,
  manualEntryAlertsTable,
  manualEntryAlertRecipientsTable,
  manualEntryNotifySkipsTable,
  tournamentsTable,
  playersTable,
  organizationsTable,
  appUsersTable,
} from "@workspace/db";
import { and, eq, gte, sql, desc, asc } from "drizzle-orm";
import { MANUAL_ENTRY_NOTIFY_REASONS } from "./manualEntryNotify";

/**
 * Task #2066 — per-org / per-tournament aggregation of `org_muted` and
 * `tournament_muted` skip rows in a window. Powers the auto-page rule
 * in `manualEntryAlertHealthOpsAlert.ts` that catches an org which got
 * stuck muted (org-wide toggle left off after troubleshooting) and is
 * silently piling up muted skips.
 */
export type ManualEntryNotifyMutedReason = "org_muted" | "tournament_muted";

export interface ManualEntryNotifyMutedSkipTournamentBucket {
  tournamentId: number | null;
  tournamentName: string | null;
  /** Total muted-skip rows for this tournament (sum of orgMuted +
   *  tournamentMuted). */
  count: number;
  orgMutedCount: number;
  tournamentMutedCount: number;
}

export interface ManualEntryNotifyMutedSkipOrg {
  organizationId: number | null;
  organizationName: string | null;
  /** Total muted-skip rows for this org across all tournaments and
   *  reasons. The auto-page rule trips when this >= the configured
   *  per-org threshold. */
  totalCount: number;
  orgMutedCount: number;
  tournamentMutedCount: number;
  /** Per-tournament breakdown so on-call can see which tournament(s)
   *  the muted skips are concentrated on. Sorted by `count` desc.
   *  Includes a NULL-tournamentId row when a skip's submission no
   *  longer resolves to a tournament (e.g. cascade-deleted), so the
   *  totals always reconcile against `totalCount`. */
  tournaments: ManualEntryNotifyMutedSkipTournamentBucket[];
}

export interface ManualEntryAlertWindow {
  alertCount: number;
  recipientTotal: number;
  pushAttemptedTotal: number;
  pushSentTotal: number;
  emailAttemptedTotal: number;
  emailSentTotal: number;
  /** % of alerts where at least one push notification was successfully sent. */
  pushDeliveryRate: number;
  /** % of alerts where at least one email was successfully sent. */
  emailDeliveryRate: number;
  /** % of alerts where at least one delivery (push OR email) succeeded. */
  anyDeliveryRate: number;
  /** Alerts where neither push nor email reached anyone. */
  zeroDeliveryCount: number;
  /** Distinct users who, for some alert in the window, had at least one
   *  recipient-attempt row but none with status `sent` — i.e. they got
   *  nothing on any channel for that alert. Counted from
   *  `manual_entry_alert_recipients`; alerts with no recipient rows yet
   *  contribute zero (Task #1671). */
  silentRecipientTotal: number;
}

export interface ManualEntryAlertTopTournament {
  tournamentId: number;
  tournamentName: string | null;
  organizationId: number | null;
  organizationName: string | null;
  alertCount: number;
  zeroDeliveryCount: number;
  silentRecipientTotal: number;
}

export interface ManualEntryAlertTopPlayer {
  playerId: number;
  playerName: string | null;
  alertCount: number;
  zeroDeliveryCount: number;
}

export interface ManualEntryAlertTopSilentOrg {
  organizationId: number | null;
  organizationName: string | null;
  zeroDeliveryAlertCount: number;
  silentRecipientTotal: number;
}

/**
 * Per-reason bucket for the "why did rounds get skipped?" breakdown
 * panel (Task #1657). One row per known `MANUAL_ENTRY_NOTIFY_REASONS`
 * value plus an "Other" bucket as a defensive backstop for unexpected
 * values (e.g. an exception message that flowed through `result.reason`
 * before a coupled migration could land). Every known reason is
 * always present in the response, even with `count: 0`, so the chart
 * can render every bucket without a silent "other" catch-all.
 */
export interface ManualEntryNotifySkipBucket {
  reason: string;
  /** True for the catch-all bucket holding any non-canonical reason
   *  values that slipped through (defence in depth). */
  isOther: boolean;
  count: number;
  /** Split of the total between true skips (e.g. `org_muted`) and
   *  failures (e.g. `org_lookup_failed`) so the dashboard can colour
   *  them differently without losing the per-reason granularity. */
  skippedCount: number;
  failedCount: number;
  /** Pre-rendered URL into the team's structured-log search system —
   *  null if `MANUAL_ENTRY_NOTIFY_LOG_SEARCH_URL_TEMPLATE` is unset.
   *  Lets ops drill from a bucket straight to the matching log lines.
   */
  logSearchUrl: string | null;
}

export interface ManualEntryNotifySkipBreakdownWindow {
  /** Sum of `count` across every bucket — i.e. the total non-delivery
   *  call volume in the window. */
  totalCount: number;
  buckets: ManualEntryNotifySkipBucket[];
}

export interface ManualEntryNotifySkipBreakdown {
  "7d": ManualEntryNotifySkipBreakdownWindow;
  "30d": ManualEntryNotifySkipBreakdownWindow;
}

/**
 * Per-reason daily time-series for the dashboard's trend chart
 * (Task #2065). The static 7d / 30d bar breakdown above tells ops
 * which reason dominates over a window; this series tells them
 * whether a reason is *trending up* day-over-day so a regression
 * (e.g. `org_lookup_failed` spiking after a deploy) jumps out hours
 * earlier than re-querying the row table by hand.
 *
 * Shape is column-oriented (`days[]` axis + parallel `counts[]` per
 * reason) so the React chart can hand it straight to Recharts after
 * a thin row-zip transform without needing to re-key by date in the
 * client.
 */
export interface ManualEntryNotifySkipDailySeriesPoint {
  reason: string;
  /** True only for the catch-all "other" series — same semantics as
   *  the existing breakdown bucket (defensive backstop for unknown
   *  reason values). */
  isOther: boolean;
  /** Daily counts aligned 1:1 with `days` on the parent series. */
  counts: number[];
  /** Sum of `counts` across the window — convenience for the legend
   *  ("org_muted · 12 in 30d") and so the client doesn't need to
   *  re-sum to decide whether a series is non-empty. */
  total: number;
}

export interface ManualEntryNotifySkipDailySeries {
  /** Window size in days (30 today; matches the longer of the two
   *  breakdown windows so the chart and bar panel never disagree on
   *  totals). */
  sinceDays: number;
  /** ISO-8601 start of the window (UTC, day-aligned). The first
   *  entry in `days` matches this date. */
  since: string;
  /** UTC day labels (`YYYY-MM-DD`), oldest → newest, one per day in
   *  `[since, today]` inclusive. Always exactly `sinceDays + 1`
   *  entries so the chart's x-axis is dense (no gaps for days that
   *  had zero rows). */
  days: string[];
  /** One series per canonical `MANUAL_ENTRY_NOTIFY_REASONS` value
   *  (always present, even when every day's count is 0 — mirrors the
   *  bar-breakdown's "no silent classification of known reasons"
   *  rule), plus a single "other" series only when at least one row
   *  in the window had an unrecognised reason. */
  series: ManualEntryNotifySkipDailySeriesPoint[];
  /** Sum of every `counts[i]` across every series — the "did anything
   *  happen in this window?" total. Matches `breakdown[30d].totalCount`
   *  by construction. */
  totalCount: number;
}

export interface ManualEntryAlertHealthSummary {
  windows: {
    "7d": ManualEntryAlertWindow;
    "30d": ManualEntryAlertWindow;
  };
  topTournaments7d: ManualEntryAlertTopTournament[];
  topZeroDeliveryTournaments30d: ManualEntryAlertTopTournament[];
  topPlayers30d: ManualEntryAlertTopPlayer[];
  /** Orgs whose recipient inboxes (TDs etc.) are most often missed —
   *  ranked by silentRecipientTotal in the 30d window. */
  topSilentRecipientOrgs30d: ManualEntryAlertTopSilentOrg[];
  /** Task #1657 — per-reason breakdown of skipped/failed `notifyManualEntryRound`
   *  calls for the 7d / 30d windows. Sourced from
   *  `manual_entry_notify_skips` (a row per non-delivery call). */
  skipReasonBreakdown: ManualEntryNotifySkipBreakdown;
  /** Task #2065 — daily-bucket time-series of the same skip rows over
   *  the last 30 days, grouped by reason. Powers the dashboard's
   *  trend chart so ops can spot a reason ramping up day-over-day
   *  (e.g. `org_lookup_failed` after a deploy) hours earlier than the
   *  static 7d / 30d totals would show. */
  skipReasonDailySeries: ManualEntryNotifySkipDailySeries;
  generatedAt: string;
}

const EMPTY_WINDOW: ManualEntryAlertWindow = {
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

function pct(num: number, den: number): number {
  if (den <= 0) return 0;
  return Math.round((num / den) * 1000) / 10;
}

function composeName(first: string | null, last: string | null): string | null {
  const parts = [first, last].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(" ") : null;
}

// Counts distinct (alert, user) pairs where the user has at least one
// recipient-attempt row for an in-window alert and none of those rows is
// status `sent` — the per-recipient definition of "silent" (Task #1671).
// Rows with a NULL user_id (user deleted via the `set null` FK) are
// skipped because we can't deduplicate per-user without an identity.
// Task #1658 — also restricted to `a.status = 'sent'` so skip-audit
// alerts (org_muted / below_threshold / …) don't pollute the silent
// recipient totals on the delivery-health dashboard. Recipients on a
// skip row never had delivery attempted, so calling them "silent"
// would be misleading.
async function silentRecipientCount(since: Date): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS silent FROM (
      SELECT r.alert_id, r.user_id
      FROM manual_entry_alert_recipients r
      JOIN manual_entry_alerts a ON a.id = r.alert_id
      WHERE a.sent_at >= ${since}
        AND a.status = 'sent'
        AND r.user_id IS NOT NULL
      GROUP BY r.alert_id, r.user_id
      HAVING bool_and(r.status <> 'sent')
    ) silent
  `);
  const row = result.rows[0] as { silent?: number | string } | undefined;
  return Number(row?.silent ?? 0);
}

async function aggregateWindow(since: Date): Promise<ManualEntryAlertWindow> {
  const [aggRows, silentRecipientTotal] = await Promise.all([
    db
      .select({
        alertCount: sql<number>`count(*)::int`,
        recipientTotal: sql<number>`coalesce(sum(${manualEntryAlertsTable.recipientCount}), 0)::int`,
        pushAttemptedTotal: sql<number>`coalesce(sum(${manualEntryAlertsTable.pushAttempted}), 0)::int`,
        pushSentTotal: sql<number>`coalesce(sum(${manualEntryAlertsTable.pushSent}), 0)::int`,
        emailAttemptedTotal: sql<number>`coalesce(sum(${manualEntryAlertsTable.emailAttempted}), 0)::int`,
        emailSentTotal: sql<number>`coalesce(sum(${manualEntryAlertsTable.emailSent}), 0)::int`,
        pushSentAlerts: sql<number>`count(*) filter (where ${manualEntryAlertsTable.pushSent} > 0)::int`,
        emailSentAlerts: sql<number>`count(*) filter (where ${manualEntryAlertsTable.emailSent} > 0)::int`,
        anyDeliveredAlerts: sql<number>`count(*) filter (where ${manualEntryAlertsTable.pushSent} > 0 or ${manualEntryAlertsTable.emailSent} > 0)::int`,
        zeroDeliveryCount: sql<number>`count(*) filter (where ${manualEntryAlertsTable.pushSent} = 0 and ${manualEntryAlertsTable.emailSent} = 0)::int`,
      })
      .from(manualEntryAlertsTable)
      // Task #1658 — only the rows that *actually fired* (status='sent')
      // count toward the delivery-rate semantics. Without this filter the
      // skip-audit rows (org_muted / below_threshold / …) would each
      // look like a "zero-delivery alert" and tank the rate to ~0%,
      // generating false-positive ops pages. Skip rows are still
      // queryable via the row-list endpoint and the data-quality
      // table; they just don't belong in delivery-health aggregations.
      .where(and(
        gte(manualEntryAlertsTable.sentAt, since),
        eq(manualEntryAlertsTable.status, "sent"),
      )),
    silentRecipientCount(since),
  ]);

  const r = aggRows[0];
  if (!r || Number(r.alertCount) === 0) {
    return { ...EMPTY_WINDOW, silentRecipientTotal };
  }
  const alertCount = Number(r.alertCount);
  return {
    alertCount,
    recipientTotal: Number(r.recipientTotal),
    pushAttemptedTotal: Number(r.pushAttemptedTotal),
    pushSentTotal: Number(r.pushSentTotal),
    emailAttemptedTotal: Number(r.emailAttemptedTotal),
    emailSentTotal: Number(r.emailSentTotal),
    pushDeliveryRate: pct(Number(r.pushSentAlerts), alertCount),
    emailDeliveryRate: pct(Number(r.emailSentAlerts), alertCount),
    anyDeliveryRate: pct(Number(r.anyDeliveredAlerts), alertCount),
    zeroDeliveryCount: Number(r.zeroDeliveryCount),
    silentRecipientTotal,
  };
}

async function topTournaments(since: Date, opts: { onlyZeroDelivery?: boolean; limit: number }): Promise<ManualEntryAlertTopTournament[]> {
  // Task #1658 — same status='sent' filter as `aggregateWindow`. The "top
  // tournaments by alert volume" panel must not double-count a club's
  // skip rows as alerts they fired on a player.
  const where = opts.onlyZeroDelivery
    ? and(
        gte(manualEntryAlertsTable.sentAt, since),
        eq(manualEntryAlertsTable.status, "sent"),
        eq(manualEntryAlertsTable.pushSent, 0),
        eq(manualEntryAlertsTable.emailSent, 0),
      )
    : and(
        gte(manualEntryAlertsTable.sentAt, since),
        eq(manualEntryAlertsTable.status, "sent"),
      );

  const rows = await db
    .select({
      tournamentId: manualEntryAlertsTable.tournamentId,
      tournamentName: tournamentsTable.name,
      organizationId: tournamentsTable.organizationId,
      organizationName: organizationsTable.name,
      alertCount: sql<number>`count(*)::int`,
      zeroDeliveryCount: sql<number>`count(*) filter (where ${manualEntryAlertsTable.pushSent} = 0 and ${manualEntryAlertsTable.emailSent} = 0)::int`,
    })
    .from(manualEntryAlertsTable)
    .leftJoin(tournamentsTable, eq(tournamentsTable.id, manualEntryAlertsTable.tournamentId))
    .leftJoin(organizationsTable, eq(organizationsTable.id, tournamentsTable.organizationId))
    .where(where)
    .groupBy(manualEntryAlertsTable.tournamentId, tournamentsTable.name, tournamentsTable.organizationId, organizationsTable.name)
    .orderBy(sql`count(*) desc`)
    .limit(Math.max(1, Math.min(50, opts.limit)));

  // Resolve `silentRecipientTotal` per tournament from the recipient
  // table so partial silence is reflected (Task #1671). Fetched in one
  // query, then merged into the alert-level rows above.
  const silentByTournament = await silentRecipientTotalsByTournament({
    since,
    onlyZeroDeliveryAlerts: opts.onlyZeroDelivery,
  });

  return rows.map((r) => ({
    tournamentId: r.tournamentId,
    tournamentName: r.tournamentName,
    organizationId: r.organizationId,
    organizationName: r.organizationName,
    alertCount: Number(r.alertCount),
    zeroDeliveryCount: Number(r.zeroDeliveryCount),
    silentRecipientTotal: silentByTournament.get(r.tournamentId) ?? 0,
  }));
}

async function silentRecipientTotalsByTournament(opts: {
  since: Date;
  onlyZeroDeliveryAlerts?: boolean;
}): Promise<Map<number, number>> {
  const zeroClause = opts.onlyZeroDeliveryAlerts
    ? sql`AND a.push_sent = 0 AND a.email_sent = 0`
    : sql``;
  // Task #1658 — `a.status = 'sent'` filter mirrors `aggregateWindow`
  // and `topTournaments` so skip-audit rows don't show up here.
  const result = await db.execute(sql`
    SELECT a.tournament_id AS tournament_id, count(*)::int AS silent
    FROM (
      SELECT r.alert_id, r.user_id
      FROM manual_entry_alert_recipients r
      JOIN manual_entry_alerts a ON a.id = r.alert_id
      WHERE a.sent_at >= ${opts.since}
        AND a.status = 'sent'
        AND r.user_id IS NOT NULL
        ${zeroClause}
      GROUP BY r.alert_id, r.user_id
      HAVING bool_and(r.status <> 'sent')
    ) silent
    JOIN manual_entry_alerts a ON a.id = silent.alert_id
    GROUP BY a.tournament_id
  `);
  const m = new Map<number, number>();
  for (const r of result.rows as Array<{ tournament_id: number; silent: number | string }>) {
    m.set(Number(r.tournament_id), Number(r.silent));
  }
  return m;
}

async function topPlayers(since: Date, limit: number): Promise<ManualEntryAlertTopPlayer[]> {
  const rows = await db
    .select({
      playerId: manualEntryAlertsTable.playerId,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      alertCount: sql<number>`count(*)::int`,
      zeroDeliveryCount: sql<number>`count(*) filter (where ${manualEntryAlertsTable.pushSent} = 0 and ${manualEntryAlertsTable.emailSent} = 0)::int`,
    })
    .from(manualEntryAlertsTable)
    .leftJoin(playersTable, eq(playersTable.id, manualEntryAlertsTable.playerId))
    // Task #1658 — only count alerts that actually fired; skip rows
    // would otherwise inflate a player's "alerts triggered" count.
    .where(and(
      gte(manualEntryAlertsTable.sentAt, since),
      eq(manualEntryAlertsTable.status, "sent"),
    ))
    .groupBy(manualEntryAlertsTable.playerId, playersTable.firstName, playersTable.lastName)
    .orderBy(sql`count(*) desc`)
    .limit(Math.max(1, Math.min(50, limit)));

  return rows.map((r) => ({
    playerId: r.playerId,
    playerName: composeName(r.firstName, r.lastName),
    alertCount: Number(r.alertCount),
    zeroDeliveryCount: Number(r.zeroDeliveryCount),
  }));
}

async function topSilentRecipientOrgs(since: Date, limit: number): Promise<ManualEntryAlertTopSilentOrg[]> {
  // Group silent (alert, user) pairs by org via the tournament FK.
  // `zeroDeliveryAlertCount` counts the distinct alerts contributing
  // silent recipients in the org (Task #1671) — a partially-silent
  // alert now counts here even though it isn't alert-level "zero
  // delivery", which matches the column's purpose of "alerts where
  // an inbox got missed".
  // Task #1658 — same `a.status = 'sent'` guard as the other health
  // aggregations so a flood of skip rows (e.g. a club that just muted
  // manual-entry alerts org-wide) doesn't appear here as "this org's
  // recipients are silent".
  const result = await db.execute(sql`
    SELECT t.organization_id AS organization_id,
           o.name AS organization_name,
           count(DISTINCT silent.alert_id)::int AS zero_delivery_alert_count,
           count(*)::int AS silent_recipient_total
    FROM (
      SELECT r.alert_id, r.user_id
      FROM manual_entry_alert_recipients r
      JOIN manual_entry_alerts a ON a.id = r.alert_id
      WHERE a.sent_at >= ${since}
        AND a.status = 'sent'
        AND r.user_id IS NOT NULL
      GROUP BY r.alert_id, r.user_id
      HAVING bool_and(r.status <> 'sent')
    ) silent
    JOIN manual_entry_alerts a ON a.id = silent.alert_id
    LEFT JOIN tournaments t ON t.id = a.tournament_id
    LEFT JOIN organizations o ON o.id = t.organization_id
    GROUP BY t.organization_id, o.name
    ORDER BY silent_recipient_total DESC, zero_delivery_alert_count DESC
    LIMIT ${Math.max(1, Math.min(50, limit))}
  `);
  return (result.rows as Array<{
    organization_id: number | null;
    organization_name: string | null;
    zero_delivery_alert_count: number | string;
    silent_recipient_total: number | string;
  }>).map((r) => ({
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    zeroDeliveryAlertCount: Number(r.zero_delivery_alert_count),
    silentRecipientTotal: Number(r.silent_recipient_total),
  }));
}

/**
 * Build a deep-link into the team's structured-log search system for
 * a given skip reason and time window. Returns null when no template
 * has been configured (the dashboard then renders the bucket without
 * a drill-through, but still shows the count).
 *
 * Supported placeholders in `MANUAL_ENTRY_NOTIFY_LOG_SEARCH_URL_TEMPLATE`:
 *   {reason}    — URL-encoded reason value (e.g. `org_muted`)
 *   {sinceDays} — integer window size in days (7 or 30)
 *
 * Example template:
 *   `https://logs.example.com/?q=%5Bmanual-entry-notify%5D%20result%20reason%3D{reason}&from=now-{sinceDays}d`
 */
function buildLogSearchUrl(reason: string, sinceDays: number): string | null {
  const template = process.env.MANUAL_ENTRY_NOTIFY_LOG_SEARCH_URL_TEMPLATE;
  if (!template) return null;
  return template
    .replace(/\{reason\}/g, encodeURIComponent(reason))
    .replace(/\{sinceDays\}/g, String(sinceDays));
}

/**
 * Bucket the rows in `manual_entry_notify_skips` for `[since, now]` by
 * reason. Always returns one bucket per `MANUAL_ENTRY_NOTIFY_REASONS`
 * value (count zero if the reason hasn't fired in the window) plus a
 * single "Other" bucket carrying any unrecognised reason values — the
 * task explicitly forbids a silent "other" catch-all that absorbs
 * known reasons, so the canonical buckets always render even when
 * empty and the "Other" bucket is only present when it has > 0 rows.
 */
async function aggregateSkipReasonBuckets(
  since: Date,
  sinceDays: number,
): Promise<ManualEntryNotifySkipBreakdownWindow> {
  const rows = await db
    .select({
      reason: manualEntryNotifySkipsTable.reason,
      status: manualEntryNotifySkipsTable.status,
      n: sql<number>`count(*)::int`,
    })
    .from(manualEntryNotifySkipsTable)
    .where(gte(manualEntryNotifySkipsTable.createdAt, since))
    .groupBy(manualEntryNotifySkipsTable.reason, manualEntryNotifySkipsTable.status);

  // Aggregate by reason, splitting status counts.
  const byReason = new Map<string, { skipped: number; failed: number }>();
  for (const r of rows) {
    const key = r.reason ?? "";
    const cur = byReason.get(key) ?? { skipped: 0, failed: 0 };
    if (r.status === "skipped") cur.skipped += Number(r.n);
    else if (r.status === "failed") cur.failed += Number(r.n);
    byReason.set(key, cur);
  }

  const known = new Set<string>(MANUAL_ENTRY_NOTIFY_REASONS);
  const buckets: ManualEntryNotifySkipBucket[] = [];

  // Canonical buckets — always emitted, even at count 0.
  for (const reason of MANUAL_ENTRY_NOTIFY_REASONS) {
    const counts = byReason.get(reason) ?? { skipped: 0, failed: 0 };
    buckets.push({
      reason,
      isOther: false,
      count: counts.skipped + counts.failed,
      skippedCount: counts.skipped,
      failedCount: counts.failed,
      logSearchUrl: buildLogSearchUrl(reason, sinceDays),
    });
  }

  // "Other" — defensive backstop for unrecognised reason strings (e.g.
  // a thrown error message that propagated through `result.reason`
  // before a coupled migration extended `MANUAL_ENTRY_NOTIFY_REASONS`).
  // Only surfaced when it actually has rows so the chart isn't
  // cluttered with an empty zero bucket.
  let otherSkipped = 0;
  let otherFailed = 0;
  for (const [reason, counts] of byReason) {
    if (!known.has(reason)) {
      otherSkipped += counts.skipped;
      otherFailed += counts.failed;
    }
  }
  if (otherSkipped + otherFailed > 0) {
    buckets.push({
      reason: "other",
      isOther: true,
      count: otherSkipped + otherFailed,
      skippedCount: otherSkipped,
      failedCount: otherFailed,
      // The log search can't filter on "anything not in this set", so
      // skip the deep-link — ops have to drop into raw logs for the
      // catch-all bucket. (This is rare by design.)
      logSearchUrl: null,
    });
  }

  const totalCount = buckets.reduce((acc, b) => acc + b.count, 0);
  return { totalCount, buckets };
}

/**
 * Build the daily-bucket time-series for the trend chart (Task #2065).
 *
 * Uses Postgres' `date_trunc('day', created_at)` to bucket the rows
 * into UTC days. The query is served by either of the table's
 * existing indices (`manual_entry_notify_skips_created_idx` or
 * `manual_entry_notify_skips_reason_created_idx`) — the leading
 * `created_at` predicate is enough for an index scan and grouping by
 * `(day, reason)` keeps the aggregation cheap. The task explicitly
 * called out reusing the existing indexes; no new ones added.
 *
 * The returned `days[]` axis is dense (every UTC day in `[since,
 * today]` inclusive, even days with zero rows) so the chart's x-axis
 * doesn't collapse gaps and a flatline reads as "this reason was
 * silent" instead of "this reason wasn't observed yet".
 *
 * The series list is canonical-first (one per `MANUAL_ENTRY_NOTIFY_REASONS`
 * value, always present), with a trailing "other" series only when at
 * least one row in the window has an unrecognised reason — same rules
 * as the bar-breakdown so the two panels never disagree on which
 * reasons exist.
 */
async function aggregateSkipReasonDailySeries(
  since: Date,
  sinceDays: number,
  now: Date,
): Promise<ManualEntryNotifySkipDailySeries> {
  // Day-align the window start in UTC so the first label in `days[]`
  // matches the first row date_trunc would emit. The aggregator uses
  // `since` (the rolling timestamp) as the row filter so the most
  // recent `sinceDays * 24h` is always included even when the cron
  // runs mid-day.
  const sinceDayUtc = new Date(Date.UTC(
    since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate(),
  ));
  const todayUtc = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  ));

  // Build the dense UTC-day axis once — we'll lookup into it to put
  // each grouped row on the right index. `days.length` may be larger
  // than `sinceDays` by 1 because we include both endpoints.
  const days: string[] = [];
  const dayIndex = new Map<string, number>();
  for (let d = sinceDayUtc.getTime(); d <= todayUtc.getTime(); d += 24 * 60 * 60 * 1000) {
    const iso = new Date(d).toISOString().slice(0, 10); // `YYYY-MM-DD`
    dayIndex.set(iso, days.length);
    days.push(iso);
  }

  // One row per (day, reason) bucket. We query `date_trunc('day', …)
  // AT TIME ZONE 'UTC'` so the bucket boundaries match the JS-side
  // axis above regardless of the database server's TZ setting.
  const rows = await db.execute(sql`
    SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           reason,
           count(*)::int AS n
    FROM manual_entry_notify_skips
    WHERE created_at >= ${since}
    GROUP BY date_trunc('day', created_at AT TIME ZONE 'UTC'), reason
  `);

  const known = new Set<string>(MANUAL_ENTRY_NOTIFY_REASONS);
  const seriesByReason = new Map<string, number[]>();
  let otherCounts: number[] | null = null;

  // Seed canonical series with all-zero arrays so they always appear
  // in the response (mirrors the bar-breakdown rule).
  for (const reason of MANUAL_ENTRY_NOTIFY_REASONS) {
    seriesByReason.set(reason, new Array(days.length).fill(0));
  }

  for (const r of rows.rows as Array<{ day: string; reason: string | null; n: number | string }>) {
    const day = r.day;
    const idx = dayIndex.get(day);
    if (idx == null) continue; // Out-of-window slop (cron raced midnight) — drop.
    const n = Number(r.n);
    const reason = r.reason ?? "";
    if (known.has(reason)) {
      seriesByReason.get(reason)![idx] += n;
    } else {
      if (!otherCounts) otherCounts = new Array(days.length).fill(0);
      otherCounts[idx] += n;
    }
  }

  const series: ManualEntryNotifySkipDailySeriesPoint[] = [];
  let totalCount = 0;
  for (const reason of MANUAL_ENTRY_NOTIFY_REASONS) {
    const counts = seriesByReason.get(reason)!;
    const total = counts.reduce((a, b) => a + b, 0);
    totalCount += total;
    series.push({ reason, isOther: false, counts, total });
  }
  if (otherCounts) {
    const total = otherCounts.reduce((a, b) => a + b, 0);
    totalCount += total;
    series.push({ reason: "other", isOther: true, counts: otherCounts, total });
  }

  return {
    sinceDays,
    since: sinceDayUtc.toISOString(),
    days,
    series,
    totalCount,
  };
}

/**
 * Task #2066 — list orgs whose `org_muted` + `tournament_muted` skip-row
 * count in `[since, now]` is at or above `minPerOrg`. Used by the
 * auto-page job to detect the "stuck muted" failure mode where an
 * org-wide toggle was left off after troubleshooting and muted alerts
 * are silently piling up.
 *
 * Resolves the org via `manual_entry_notify_skips → round_submissions
 * → tournaments → organizations`. Skips whose submission has been
 * cascade-deleted (or never existed) flow into a single `organizationId
 * = null` bucket so a flood of orphaned rows is still visible — the
 * email renders the bucket as "(unknown organization)".
 *
 * Per-tournament breakdown inside each org is sorted by row count
 * descending and capped at `perOrgLimit` (default 5) so the email body
 * stays readable when an outage produced dozens of muted-skip rows
 * across many tournaments. The truncated count is implicit in the
 * difference between `totalCount` and the sum of bucket counts.
 */
export async function getManualEntryNotifyMutedSkipsByOrg(opts: {
  since: Date;
  minPerOrg: number;
  perOrgLimit?: number;
}): Promise<ManualEntryNotifyMutedSkipOrg[]> {
  const minPerOrg = Math.max(1, opts.minPerOrg);
  const perOrgLimit = Math.max(1, opts.perOrgLimit ?? 5);

  const result = await db.execute(sql`
    SELECT
      o.id   AS organization_id,
      o.name AS organization_name,
      t.id   AS tournament_id,
      t.name AS tournament_name,
      s.reason AS reason,
      count(*)::int AS n
    FROM manual_entry_notify_skips s
    LEFT JOIN round_submissions rs ON rs.id = s.submission_id
    LEFT JOIN tournaments t        ON t.id  = rs.tournament_id
    LEFT JOIN organizations o      ON o.id  = t.organization_id
    WHERE s.created_at >= ${opts.since}
      AND s.reason IN ('org_muted', 'tournament_muted')
    GROUP BY o.id, o.name, t.id, t.name, s.reason
  `);

  // Roll the (org, tournament, reason) rows up first by org, then by
  // tournament inside each org. Two passes is plenty — the result set
  // is bounded by O(orgs * tournaments * 2 reasons) which in practice
  // is small.
  type Row = {
    organization_id: number | null;
    organization_name: string | null;
    tournament_id: number | null;
    tournament_name: string | null;
    reason: string;
    n: number | string;
  };
  const orgs = new Map<string, ManualEntryNotifyMutedSkipOrg & {
    _tournaments: Map<string, ManualEntryNotifyMutedSkipTournamentBucket>;
  }>();
  for (const r of result.rows as Row[]) {
    const orgKey = r.organization_id == null ? "null" : String(r.organization_id);
    let org = orgs.get(orgKey);
    if (!org) {
      org = {
        organizationId: r.organization_id,
        organizationName: r.organization_name,
        totalCount: 0,
        orgMutedCount: 0,
        tournamentMutedCount: 0,
        tournaments: [],
        _tournaments: new Map(),
      };
      orgs.set(orgKey, org);
    }
    const n = Number(r.n);
    org.totalCount += n;
    if (r.reason === "org_muted") org.orgMutedCount += n;
    else if (r.reason === "tournament_muted") org.tournamentMutedCount += n;

    const tKey = r.tournament_id == null ? "null" : String(r.tournament_id);
    let t = org._tournaments.get(tKey);
    if (!t) {
      t = {
        tournamentId: r.tournament_id,
        tournamentName: r.tournament_name,
        count: 0,
        orgMutedCount: 0,
        tournamentMutedCount: 0,
      };
      org._tournaments.set(tKey, t);
    }
    t.count += n;
    if (r.reason === "org_muted") t.orgMutedCount += n;
    else if (r.reason === "tournament_muted") t.tournamentMutedCount += n;
  }

  const out: ManualEntryNotifyMutedSkipOrg[] = [];
  for (const org of orgs.values()) {
    if (org.totalCount < minPerOrg) continue;
    const tournaments = Array.from(org._tournaments.values()).sort(
      (a, b) => b.count - a.count,
    );
    out.push({
      organizationId: org.organizationId,
      organizationName: org.organizationName,
      totalCount: org.totalCount,
      orgMutedCount: org.orgMutedCount,
      tournamentMutedCount: org.tournamentMutedCount,
      tournaments: tournaments.slice(0, perOrgLimit),
    });
  }
  // Highest-volume offending org first — that's the one on-call should
  // contact first if there are several.
  out.sort((a, b) => b.totalCount - a.totalCount);
  return out;

}

export async function getManualEntryAlertHealthSummary(): Promise<ManualEntryAlertHealthSummary> {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const since7 = new Date(now - 7 * day);
  const since30 = new Date(now - 30 * day);
  const [w7d, w30d, top7, topZero30, players30, silentOrgs30, skip7, skip30, dailySeries30] =
    await Promise.all([
      aggregateWindow(since7),
      aggregateWindow(since30),
      topTournaments(since7, { limit: 10 }),
      topTournaments(since30, { onlyZeroDelivery: true, limit: 10 }),
      topPlayers(since30, 10),
      topSilentRecipientOrgs(since30, 10),
      aggregateSkipReasonBuckets(since7, 7),
      aggregateSkipReasonBuckets(since30, 30),
      aggregateSkipReasonDailySeries(since30, 30, new Date(now)),
    ]);
  return {
    windows: { "7d": w7d, "30d": w30d },
    topTournaments7d: top7,
    topZeroDeliveryTournaments30d: topZero30,
    topPlayers30d: players30,
    topSilentRecipientOrgs30d: silentOrgs30,
    skipReasonBreakdown: { "7d": skip7, "30d": skip30 },
    skipReasonDailySeries: dailySeries30,
    generatedAt: new Date(now).toISOString(),
  };
}

export interface ManualEntryAlertRow {
  id: number;
  submissionId: number;
  tournamentId: number;
  tournamentName: string | null;
  organizationId: number | null;
  organizationName: string | null;
  playerId: number;
  playerName: string | null;
  round: number;
  manualPct: number;
  manualShots: number;
  totalShots: number;
  recipientCount: number;
  pushAttempted: number;
  pushSent: number;
  emailAttempted: number;
  emailSent: number;
  zeroDelivery: boolean;
  /**
   * Outcome of the notify call that produced this audit row (Task #1658).
   * Always one of 'sent' | 'skipped' | 'failed' (enforced by the
   * `manual_entry_alerts_status_chk` check constraint at the DB layer).
   */
  status: string;
  /**
   * Canonical skip reason from `MANUAL_ENTRY_NOTIFY_REASONS` (Task #1658).
   * NULL when the alert actually fired (status='sent').
   */
  reason: string | null;
  sentAt: string;
}

/**
 * Status filter accepted by `listManualEntryAlertRows`. Picked to
 * cover the dashboard's three useful slices:
 *   - 'all' — every row in the audit log (default; matches the
 *     pre-#1658 behaviour for callers that don't specify a status).
 *   - 'sent' — only successful alerts (matches the original semantics
 *     of the row table — useful when the user just wants to see real
 *     alerts and ignore the noise of skip-audit rows).
 *   - 'skipped' — every reason='org_muted' / 'below_threshold' / …
 *     row, for support to answer "why didn't this fire?".
 *   - 'failed' — alerts the notifier itself errored on (rare).
 */
export type ManualEntryAlertRowsStatus = "all" | "sent" | "skipped" | "failed";

export interface ManualEntryAlertRowsQuery {
  tournamentId?: number;
  playerId?: number;
  organizationId?: number;
  sinceDays?: number;
  zeroDeliveryOnly?: boolean;
  /** Restrict to rows with a specific notifier status (Task #1658). */
  status?: ManualEntryAlertRowsStatus;
  limit?: number;
  offset?: number;
  /**
   * Upper bound for `limit`. Defaults to 200 (the dashboard page-size cap).
   * The CSV export route raises this so a single download contains every
   * row matching the active filters (Task #1388).
   */
  maxLimit?: number;
}

export interface ManualEntryAlertRowsResult {
  rows: ManualEntryAlertRow[];
  total: number;
  limit: number;
  offset: number;
}

export async function listManualEntryAlertRows(q: ManualEntryAlertRowsQuery): Promise<ManualEntryAlertRowsResult> {
  const maxLimit = Math.max(1, q.maxLimit ?? 200);
  const limit = Math.max(1, Math.min(maxLimit, q.limit ?? 50));
  const offset = Math.max(0, q.offset ?? 0);
  const sinceDays = Math.max(1, Math.min(365, q.sinceDays ?? 30));
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const filters = [gte(manualEntryAlertsTable.sentAt, since)];
  if (q.tournamentId != null) filters.push(eq(manualEntryAlertsTable.tournamentId, q.tournamentId));
  if (q.playerId != null) filters.push(eq(manualEntryAlertsTable.playerId, q.playerId));
  if (q.organizationId != null) filters.push(eq(tournamentsTable.organizationId, q.organizationId));
  if (q.zeroDeliveryOnly) {
    // "Silent only" pre-#1658 implicitly meant "fired but reached nobody";
    // a skip row trivially satisfies pushSent=0 AND emailSent=0 but is
    // a different concept entirely, so we also pin status='sent' here
    // to preserve the original semantic (otherwise toggling Silent Only
    // would suddenly include every below_threshold skip row).
    filters.push(eq(manualEntryAlertsTable.status, "sent"));
    filters.push(eq(manualEntryAlertsTable.pushSent, 0));
    filters.push(eq(manualEntryAlertsTable.emailSent, 0));
  } else if (q.status && q.status !== "all") {
    // Task #1658 — explicit status filter for the dashboard's
    // sent/skipped/failed dropdown.
    filters.push(eq(manualEntryAlertsTable.status, q.status));
  }
  const where = and(...filters);

  const baseQuery = db
    .select({
      id: manualEntryAlertsTable.id,
      submissionId: manualEntryAlertsTable.submissionId,
      tournamentId: manualEntryAlertsTable.tournamentId,
      tournamentName: tournamentsTable.name,
      organizationId: tournamentsTable.organizationId,
      organizationName: organizationsTable.name,
      playerId: manualEntryAlertsTable.playerId,
      playerFirstName: playersTable.firstName,
      playerLastName: playersTable.lastName,
      round: manualEntryAlertsTable.round,
      manualPct: manualEntryAlertsTable.manualPct,
      manualShots: manualEntryAlertsTable.manualShots,
      totalShots: manualEntryAlertsTable.totalShots,
      recipientCount: manualEntryAlertsTable.recipientCount,
      pushAttempted: manualEntryAlertsTable.pushAttempted,
      pushSent: manualEntryAlertsTable.pushSent,
      emailAttempted: manualEntryAlertsTable.emailAttempted,
      emailSent: manualEntryAlertsTable.emailSent,
      status: manualEntryAlertsTable.status,
      reason: manualEntryAlertsTable.reason,
      sentAt: manualEntryAlertsTable.sentAt,
    })
    .from(manualEntryAlertsTable)
    .leftJoin(tournamentsTable, eq(tournamentsTable.id, manualEntryAlertsTable.tournamentId))
    .leftJoin(organizationsTable, eq(organizationsTable.id, tournamentsTable.organizationId))
    .leftJoin(playersTable, eq(playersTable.id, manualEntryAlertsTable.playerId))
    .where(where)
    .orderBy(desc(manualEntryAlertsTable.sentAt))
    .limit(limit)
    .offset(offset);

  const totalQuery = db
    .select({ count: sql<number>`count(*)::int` })
    .from(manualEntryAlertsTable)
    .leftJoin(tournamentsTable, eq(tournamentsTable.id, manualEntryAlertsTable.tournamentId))
    .where(where);

  const [rows, totalRows] = await Promise.all([baseQuery, totalQuery]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      submissionId: r.submissionId,
      tournamentId: r.tournamentId,
      tournamentName: r.tournamentName,
      organizationId: r.organizationId,
      organizationName: r.organizationName,
      playerId: r.playerId,
      playerName: composeName(r.playerFirstName, r.playerLastName),
      round: r.round,
      manualPct: Number(r.manualPct),
      manualShots: r.manualShots,
      totalShots: r.totalShots,
      recipientCount: r.recipientCount,
      pushAttempted: r.pushAttempted,
      pushSent: r.pushSent,
      emailAttempted: r.emailAttempted,
      emailSent: r.emailSent,
      // `zeroDelivery` is the original "fired but reached nobody"
      // signal — meaningful only for status='sent'. For skip rows
      // (which always have pushSent=emailSent=0) returning true would
      // misleadingly suggest a delivery failure on a row that never
      // attempted delivery in the first place.
      zeroDelivery: r.status === "sent" && r.pushSent === 0 && r.emailSent === 0,
      status: r.status,
      reason: r.reason,
      sentAt: r.sentAt.toISOString(),
    })),
    total: Number(totalRows[0]?.count ?? 0),
    limit,
    offset,
  };
}

// ── Shared query-string parser for the rows endpoints ─────────────────
//
// Both the super-admin row endpoints (JSON + CSV) and the per-org rollup
// endpoint (Task #2068) accept the same set of filter params. Keeping
// the parser next to `listManualEntryAlertRows` ensures the validation
// rules stay in lock-step with the query interface.

export type ParseManualEntryAlertRowsQueryResult =
  | { ok: true; parsed: ManualEntryAlertRowsQuery }
  | { ok: false; field: string };

export function parseManualEntryAlertRowsQuery(
  q: Record<string, unknown>,
): ParseManualEntryAlertRowsQueryResult {
  const parsePositiveInt = (raw: unknown): number | undefined => {
    if (raw == null) return undefined;
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v !== "string" || v === "") return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.floor(n);
  };
  const parseNonNegativeInt = (raw: unknown): number | undefined => {
    if (raw == null) return undefined;
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v !== "string" || v === "") return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.floor(n);
  };
  const parseBool = (raw: unknown): boolean => {
    const v = Array.isArray(raw) ? raw[0] : raw;
    return v === "1" || v === "true";
  };

  // Task #1658 — `status` filter: 'all' | 'sent' | 'skipped' | 'failed'.
  // Anything else (or unset) is treated as the default 'all', matching
  // the pre-#1658 behaviour where every audit row was returned.
  type StatusParse =
    | { ok: true; value: ManualEntryAlertRowsStatus | undefined }
    | { ok: false };
  const parseStatus = (raw: unknown): StatusParse => {
    if (raw == null) return { ok: true, value: undefined };
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v !== "string" || v === "") return { ok: true, value: undefined };
    if (v === "all" || v === "sent" || v === "skipped" || v === "failed") {
      return { ok: true, value: v };
    }
    return { ok: false };
  };

  const statusResult = parseStatus(q.status);
  if (!statusResult.ok) {
    return { ok: false, field: "status" };
  }
  const status = statusResult.value;
  const zeroDeliveryOnly = parseBool(q.zeroDeliveryOnly);

  // Reject combined filters that contradict each other up-front rather
  // than silently overriding one with the other downstream. The "silent
  // only" view by definition operates on alerts that actually fired
  // (status='sent' but reached nobody), so combining it with
  // status='skipped'/'failed' would always return an empty set.
  if (zeroDeliveryOnly && status !== undefined && status !== "all" && status !== "sent") {
    return { ok: false, field: "status" };
  }

  const parsed: ManualEntryAlertRowsQuery = {
    tournamentId: parsePositiveInt(q.tournamentId),
    playerId: parsePositiveInt(q.playerId),
    organizationId: parsePositiveInt(q.organizationId),
    sinceDays: parsePositiveInt(q.sinceDays),
    zeroDeliveryOnly,
    status,
    limit: parsePositiveInt(q.limit),
    offset: parseNonNegativeInt(q.offset),
  };

  for (const field of ["tournamentId", "playerId", "organizationId", "sinceDays", "limit", "offset"] as const) {
    const raw = q[field];
    const present = raw != null && (Array.isArray(raw) ? raw[0] != null && raw[0] !== "" : raw !== "");
    if (present && parsed[field] === undefined) {
      return { ok: false, field };
    }
  }
  return { ok: true, parsed };
}

// ── Per-alert silent-recipient drill-down (Task #1386) ──────────────────

/**
 * Stable marker string written to `manual_entry_alert_recipients.error_message`
 * by the Task #1672 backfill script for every reconstructed row. Defined
 * here (rather than in the script) so the runtime drill-down can flag
 * those rows as `reconstructed` without keeping a duplicate copy of the
 * string in two places. The script imports this constant; if either side
 * changes it independently the dashboard pill silently stops appearing,
 * so the lockstep matters.
 *
 * NB: detection uses `MANUAL_ENTRY_ALERT_BACKFILL_MARKER_PREFIX`
 * (a `startsWith` check) so a future tweak that appends extra context
 * to the message — e.g. `"… — original per-recipient outcome unknown
 * (run 2026-04-30)"` — keeps registering as reconstructed.
 */
export const MANUAL_ENTRY_ALERT_BACKFILL_MARKER =
  "backfilled (Task #1672) — original per-recipient outcome unknown";

/**
 * Prefix used to recognize a reconstructed-recipient row by its
 * `error_message`. Mirrors the `WHERE error_message LIKE
 * 'backfilled (Task #1672)%'` predicate documented in the backfill
 * script's header comment.
 */
export const MANUAL_ENTRY_ALERT_BACKFILL_MARKER_PREFIX =
  "backfilled (Task #1672)";

/** True for rows the Task #1672 backfill reconstructed from aggregate
 *  counts (best-effort per-user attribution), false for rows the live
 *  Task #1386 notify path wrote at delivery time. */
export function isReconstructedRecipientErrorMessage(
  errorMessage: string | null | undefined,
): boolean {
  return typeof errorMessage === "string"
    && errorMessage.startsWith(MANUAL_ENTRY_ALERT_BACKFILL_MARKER_PREFIX);
}

export interface ManualEntryAlertSilentRecipient {
  userId: number | null;
  displayName: string | null;
  username: string | null;
  email: string | null;
  channel: "push" | "email";
  status: "failed" | "no_address" | "no_email" | "opted_out";
  errorMessage: string | null;
  createdAt: string;
  /**
   * True when this row was synthesized by the Task #1672 backfill from
   * aggregate alert counts rather than recorded at delivery time
   * (Task #1386). The bucket (`failed` / `opted_out` / etc) is correct
   * in aggregate for the alert, but the per-user mapping was inferred
   * from the org's current director roster in deterministic slot order
   * — so ops should not chase a stale device token for a specific
   * person on the strength of a reconstructed row alone.
   */
  reconstructed: boolean;
}

export interface ManualEntryAlertSilentRecipientsResult {
  alertId: number;
  /**
   * Recipients who got nothing on the named channel — i.e. the channel
   * status is anything other than "sent". Surfaced so a super-admin can
   * see "TD Jane never got the push because her token is no_address"
   * without grepping logs.
   *
   * NB: a user may appear twice (once per channel) if both attempts
   * failed; the dashboard groups by user.
   */
  silentRecipients: ManualEntryAlertSilentRecipient[];
  /** Total recipient rows persisted for this alert (incl. the "sent" ones). */
  totalRecipientRows: number;
}

// ── Shared CSV export helpers (Tasks #1388 + #1663) ────────────────────
//
// The super-admin route (`/super-admin/manual-entry-alerts/rows.csv`)
// and the weekly silent-failures cron digest both export the same row
// shape, so the column header + RFC 4180 escape helper live here and
// are reused by both. Keeping them next to `listManualEntryAlertRows`
// guarantees the file format stays in lock-step with the row shape.

export const MANUAL_ENTRY_ALERT_CSV_HEADER = [
  "alertId",
  "sentAt",
  "tournamentId",
  "tournamentName",
  "organizationId",
  "organizationName",
  "playerId",
  "playerName",
  "round",
  "manualPct",
  "recipientCount",
  "pushAttempted",
  "pushSent",
  "emailAttempted",
  "emailSent",
  "zeroDelivery",
  // Task #1658 — skip-context columns so a CSV ops shares with a TD
  // or engineering carries the same status + reason the dashboard
  // renders for skipped/failed alerts.
  "status",
  "reason",
];

/** Hard upper bound for a single CSV export, to bound memory if a stale
 *  filter pulls a giant window. Mirrors the route's per-request cap. */
export const MANUAL_ENTRY_ALERT_CSV_MAX_ROWS = 10_000;

/** RFC 4180 CSV escaping. Quotes a field if it contains a comma, quote,
 *  CR, or LF, and doubles any embedded quote characters. */
export function csvEscapeField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvLine(fields: unknown[]): string {
  return fields.map(csvEscapeField).join(",") + "\r\n";
}

/** Build a CSV body (header + one line per row) from a `listManualEntryAlertRows`
 *  result set. Used by both the route and the weekly cron digest so the
 *  formatting stays identical. */
export function buildManualEntryAlertsCsv(rows: ManualEntryAlertRow[]): string {
  const lines: string[] = [csvLine(MANUAL_ENTRY_ALERT_CSV_HEADER)];
  for (const r of rows) {
    lines.push(csvLine([
      r.id,
      r.sentAt,
      r.tournamentId,
      r.tournamentName ?? "",
      r.organizationId ?? "",
      r.organizationName ?? "",
      r.playerId,
      r.playerName ?? "",
      r.round,
      // Match the JSON contract's number type — toFixed keeps a stable
      // decimal representation even if upstream returns an integer.
      Number(r.manualPct).toFixed(2),
      r.recipientCount,
      r.pushAttempted,
      r.pushSent,
      r.emailAttempted,
      r.emailSent,
      r.zeroDelivery ? "true" : "false",
      // Task #1658 — surface the skip context in the CSV so it stays
      // in lock-step with the dashboard table.
      r.status,
      r.reason ?? "",
    ]));
  }
  return lines.join("");
}

export async function getManualEntryAlertSilentRecipients(
  alertId: number,
): Promise<ManualEntryAlertSilentRecipientsResult | null> {
  const [alert] = await db
    .select({ id: manualEntryAlertsTable.id })
    .from(manualEntryAlertsTable)
    .where(eq(manualEntryAlertsTable.id, alertId))
    .limit(1);
  if (!alert) return null;

  const rows = await db
    .select({
      userId: manualEntryAlertRecipientsTable.userId,
      channel: manualEntryAlertRecipientsTable.channel,
      status: manualEntryAlertRecipientsTable.status,
      errorMessage: manualEntryAlertRecipientsTable.errorMessage,
      createdAt: manualEntryAlertRecipientsTable.createdAt,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      email: appUsersTable.email,
    })
    .from(manualEntryAlertRecipientsTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, manualEntryAlertRecipientsTable.userId))
    .where(eq(manualEntryAlertRecipientsTable.alertId, alertId))
    .orderBy(asc(manualEntryAlertRecipientsTable.createdAt));

  const silent = rows.filter((r) => r.status !== "sent");

  return {
    alertId,
    totalRecipientRows: rows.length,
    silentRecipients: silent.map((r) => ({
      userId: r.userId,
      displayName: r.displayName,
      username: r.username,
      email: r.email,
      // The check constraint guarantees these stay within the canonical
      // string set the type alias models.
      channel: r.channel as "push" | "email",
      status: r.status as "failed" | "no_address" | "no_email" | "opted_out",
      errorMessage: r.errorMessage,
      createdAt: r.createdAt.toISOString(),
      // Task #2075 — flag rows synthesized by the Task #1672 backfill so
      // the dashboard / CSV consumer can render a "(reconstructed)"
      // pill and ops doesn't mistake bucket-assigned attribution for
      // real per-user delivery data.
      reconstructed: isReconstructedRecipientErrorMessage(r.errorMessage),
    })),
  };
}

// ── Per-alert silent-recipient CSV export (Task #2075) ──────────────────
//
// The dashboard's silent-recipients drill-down (Task #1386) is now also
// available as CSV so off-dashboard analyses (spreadsheet, BI tool,
// ad-hoc grep) carry the same provenance signal — including the
// `reconstructed` flag introduced for the Task #1672 backfill rows.
// Same column-shape conventions as `MANUAL_ENTRY_ALERT_CSV_HEADER`.

export const MANUAL_ENTRY_ALERT_SILENT_RECIPIENTS_CSV_HEADER = [
  "alertId",
  "userId",
  "displayName",
  "username",
  "email",
  "channel",
  "status",
  "errorMessage",
  "createdAt",
  // Task #2075 — provenance column. "true" for rows reconstructed by
  // the Task #1672 backfill from aggregate counts (best-effort
  // attribution); "false" for rows recorded at delivery time.
  "reconstructed",
];

export function buildManualEntryAlertSilentRecipientsCsv(
  alertId: number,
  recipients: ManualEntryAlertSilentRecipient[],
): string {
  const lines: string[] = [csvLine(MANUAL_ENTRY_ALERT_SILENT_RECIPIENTS_CSV_HEADER)];
  for (const r of recipients) {
    lines.push(csvLine([
      alertId,
      r.userId ?? "",
      r.displayName ?? "",
      r.username ?? "",
      r.email ?? "",
      r.channel,
      r.status,
      r.errorMessage ?? "",
      r.createdAt,
      r.reconstructed ? "true" : "false",
    ]));
  }
  return lines.join("");
}

