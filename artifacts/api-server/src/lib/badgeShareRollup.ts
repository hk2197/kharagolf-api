/**
 * Task #1096 — Bound the `badge_share_events` table by rolling old
 * rows into the per-day `badge_share_daily_aggregates` table and
 * deleting the originals.
 *
 * Why a rollup rather than a hard prune?
 *  - The portal stats and admin leaderboard endpoints surface counts
 *    over the entire history of a handle (or a date range that may
 *    extend past the rollup window). Hard-deleting old events would
 *    silently drop those counts; rollup preserves the totals while
 *    bounding row growth to one row per (handle, badge_type, method,
 *    day) instead of one row per share click.
 *
 * The rollup runs in a single transaction:
 *  1. Aggregate every event with `created_at < cutoff` into per-day
 *     buckets and UPSERT them into the aggregate table (sum on
 *     conflict so re-running the rollup is safe — e.g. after an
 *     interrupted run that aggregated some rows but failed to delete
 *     them, the next run will add the same counts again, then delete
 *     them, keeping the visible total stable).
 *  2. Delete those events.
 *
 * Aggregates older than `MAX_AGGREGATE_AGE_MS` are also deleted so the
 * summary table stays bounded too.
 *
 * Task #1260 — After every successful run we UPSERT a singleton
 * `badge_share_rollup_runs` row so a super-admin "storage savings"
 * panel can show the most recent run's summary plus when it last
 * fired (and warn loudly when the cron has been silent).
 */
import {
  db,
  badgeShareEventsTable,
  badgeShareDailyAggregatesTable,
  badgeShareRollupRunsTable,
  badgeShareRollupRunHistoryTable,
  badgeShareRollupOpsAlertsTable,
} from "@workspace/db";
import { asc, eq, gte, lt, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  computeShareRollupSavings,
  type ShareRollupStorageSavings,
} from "./shareRollupSavings";
import {
  DEFAULT_BADGE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS,
} from "./badgeShareRollupOpsAlertConfig";

/** Roll up events older than this into the daily aggregates table. */
export const ROLLUP_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Drop daily-aggregate rows older than this. ~3y of history is plenty. */
export const MAX_AGGREGATE_AGE_MS = 3 * 365 * 24 * 60 * 60 * 1000;

/**
 * If the most recent successful rollup is older than this, the
 * super-admin panel renders a loud "the cron may have stopped firing"
 * warning. The job runs once per day, so 36 h gives a comfortable
 * one-cycle slack before raising the alarm.
 */
export const STALE_RUN_WARNING_MS = 36 * 60 * 60 * 1000;

/**
 * Task #1821 — Retention bound for the append-only per-run history
 * table that backs the storage-savings sparkline. Anything older than
 * this is pruned at the end of every successful run so the table stays
 * small. The window is well above the default 7-day sparkline so a few
 * missed cron ticks don't immediately empty the chart.
 */
export const MAX_RUN_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Task #1821 — Default sparkline window surfaced on the super-admin
 * panel. The history table holds >= 30 days but the panel only renders
 * the last week so a single regression stands out at a glance.
 */
export const HISTORY_SPARKLINE_DAYS = 7;

export interface BadgeShareRollupSummary {
  rolledUpEvents: number;
  upsertedAggregateRows: number;
  prunedAggregateRows: number;
}

/**
 * Public summary surfaced on the super-admin storage-savings panel.
 *  - `lastRun` is the persisted state from the most recent successful
 *    `pruneAndRollupBadgeShareEvents` invocation (null if the job has
 *    never completed on this database — e.g. fresh deploy before the
 *    first cron tick).
 *  - The two `currentRowCount` fields are read live so the panel
 *    reflects today's table size rather than the size at last run.
 *  - `aggregatedEventVolume` is the total number of raw events that
 *    have been collapsed into the aggregate rows (i.e. SUM of the
 *    `count` column on `badge_share_daily_aggregates`). Together with
 *    `currentAggregateRowCount` it lets the panel show the actual
 *    compression the rollup is achieving (Task #1479).
 *  - `storageSavingsPercent` and `storageSavingsRatio` are derived KPIs
 *    so the panel can surface "X% smaller than raw" and "raw events
 *    would be N× larger without rollup" without making the client
 *    redo the math. Both are `null` when the rollup has not yet
 *    collapsed any events (no aggregates exist) — the panel renders
 *    that case as "no savings to report yet" instead of "0%".
 *  - `isStale` is true when the last successful run is older than
 *    `STALE_RUN_WARNING_MS`, or when no run has ever completed.
 */
/**
 * Task #1821 — One sample on the storage-savings sparkline. Mirrors the
 * `savingsPercent` / `savingsRatio` fields of `ShareRollupStorageSavings`
 * (same nullability rules — null when the run hadn't yet collapsed any
 * events at that point in time, which the panel renders as a gap).
 */
export interface BadgeShareRollupHistoryPoint {
  ranAt: string;
  savingsPercent: number | null;
  savingsRatio: number | null;
}

export interface BadgeShareRollupAdminSummary {
  lastRun: {
    ranAt: string;
    rolledUpEvents: number;
    upsertedAggregateRows: number;
    prunedAggregateRows: number;
  } | null;
  currentRawEventCount: number;
  currentAggregateRowCount: number;
  /**
   * Lifetime storage savings from the rollup. See `shareRollupSavings.ts`
   * for how each field is derived:
   *   - Task #1474 added the byte-level estimates (`estimatedRowsSaved`,
   *     `estimatedBytesSaved`, `estimatedBytesPerRawRow`,
   *     `aggregatedEventCount`).
   *   - Task #1479 added the row-count compression KPIs
   *     (`savingsPercent`, `savingsRatio`) so the panel can surface
   *     "X% smaller than raw" / "raw events would be N× larger
   *     without rollup" without making the client redo the math.
   * The byte-level numbers are estimates — Postgres per-row overhead
   * varies — and the UI labels them as such.
   */
  storageSavings: ShareRollupStorageSavings;
  /**
   * Task #1821 — Per-run trend points for the sparkline, ordered oldest
   * → newest. Limited to the last `historyDays` (default 7) so the
   * panel can render a compact inline chart; the underlying table holds
   * >= 30 days of history.
   */
  history: BadgeShareRollupHistoryPoint[];
  /** Window (in days) the `history` array covers — surfaces in panel labels. */
  historyDays: number;
  isStale: boolean;
  staleThresholdMs: number;
  rollupAgeMs: number;
  /**
   * Task #1814 — When the auto-pager (Task #1478) most recently emailed
   * super-admins + on-call about a stale badge-share rollup, persisted
   * to the singleton `badge_share_rollup_ops_alerts` table so the value
   * survives a process restart inside the cooldown window. `null` when
   * the auto-pager has never fired on this database (fresh deploy, or
   * the rollup has been healthy for the entire lifetime of the table).
   *
   * Surfaced on the super-admin badge-share-rollup panel so admins can
   * confirm the alert pipeline is wired up — and correlate the loud
   * red stale-cron banner with the email they (should have) received —
   * without grepping inboxes or logs.
   */
  lastOpsAlertAt: string | null;
  /**
   * Task #1814 — Cooldown window the auto-pager honours between
   * repeated pages for the same sustained outage. Surfaced alongside
   * `lastOpsAlertAt` so the panel can render "(won't re-page for
   * another Nh)" without redoing the env-var math on the client.
   */
  opsAlertCooldownMs: number;
  generatedAt: string;
}

export async function pruneAndRollupBadgeShareEvents(
  nowMs: number = Date.now(),
): Promise<BadgeShareRollupSummary> {
  const cutoff = new Date(nowMs - ROLLUP_AGE_MS);
  const aggregateCutoff = new Date(nowMs - MAX_AGGREGATE_AGE_MS);

  const summary: BadgeShareRollupSummary = {
    rolledUpEvents: 0,
    upsertedAggregateRows: 0,
    prunedAggregateRows: 0,
  };

  await db.transaction(async (tx) => {
    // Sum every old event into per-day buckets in a single statement
    // and UPSERT into the aggregate table. Using INSERT … SELECT … ON
    // CONFLICT lets the database do the bucketing without round-tripping
    // every row to the application.
    const upsertResult = await tx.execute(sql`
      INSERT INTO ${badgeShareDailyAggregatesTable} (handle, badge_type, method, day, count)
      SELECT
        ${badgeShareEventsTable.handle},
        ${badgeShareEventsTable.badgeType},
        ${badgeShareEventsTable.method},
        date_trunc('day', ${badgeShareEventsTable.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day,
        COUNT(*)::int AS count
      FROM ${badgeShareEventsTable}
      WHERE ${badgeShareEventsTable.createdAt} < ${cutoff}
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (handle, badge_type, method, day)
      DO UPDATE SET count = ${badgeShareDailyAggregatesTable.count} + EXCLUDED.count
    `);
    summary.upsertedAggregateRows = upsertResult.rowCount ?? 0;

    const deleteResult = await tx
      .delete(badgeShareEventsTable)
      .where(lt(badgeShareEventsTable.createdAt, cutoff));
    summary.rolledUpEvents = deleteResult.rowCount ?? 0;

    const aggDeleteResult = await tx
      .delete(badgeShareDailyAggregatesTable)
      .where(lt(badgeShareDailyAggregatesTable.day, aggregateCutoff));
    summary.prunedAggregateRows = aggDeleteResult.rowCount ?? 0;

    // Task #1260 — Persist the last-run state. Always upsert (even when
    // no rows changed) so the super-admin panel can see the cron is
    // still firing on schedule, not just when it has work to do.
    await tx.execute(sql`
      INSERT INTO ${badgeShareRollupRunsTable}
        (id, ran_at, rolled_up_events, upserted_aggregate_rows, pruned_aggregate_rows)
      VALUES
        (1, ${new Date(nowMs)}, ${summary.rolledUpEvents},
         ${summary.upsertedAggregateRows}, ${summary.prunedAggregateRows})
      ON CONFLICT (id) DO UPDATE SET
        ran_at = EXCLUDED.ran_at,
        rolled_up_events = EXCLUDED.rolled_up_events,
        upserted_aggregate_rows = EXCLUDED.upserted_aggregate_rows,
        pruned_aggregate_rows = EXCLUDED.pruned_aggregate_rows
    `);

    // Task #1821 — Append a per-run history row so the super-admin
    // panel can render a 7-day savings sparkline. The row counts and
    // aggregate sum are read inside the same transaction as the rollup
    // so the history point is consistent with the work that just
    // committed (no race with a concurrent reader inflating the
    // counts between rollup commit and the history insert).
    //
    // We compute `savingsPercent` / `savingsRatio` here using the same
    // formula as `shareRollupSavings.ts` so the history points line up
    // with what the lifetime KPI on the panel reports. Both are NULL
    // when the rollup hasn't yet collapsed any events, mirroring the
    // panel's "no savings to report yet" empty state.
    const rawCountRowsForHistory = await tx.execute(sql<{
      count: string;
    }>`SELECT COUNT(*)::text AS count FROM ${badgeShareEventsTable}`);
    const aggCountRowsForHistory = await tx.execute(sql<{
      count: string;
    }>`SELECT COUNT(*)::text AS count FROM ${badgeShareDailyAggregatesTable}`);
    const aggSumRowsForHistory = await tx.execute(sql<{
      sum: string;
    }>`SELECT COALESCE(SUM(count), 0)::text AS sum FROM ${badgeShareDailyAggregatesTable}`);

    const rawCountForHistory = Number(
      (rawCountRowsForHistory.rows[0] as { count?: string } | undefined)?.count ?? 0,
    );
    const aggCountForHistory = Number(
      (aggCountRowsForHistory.rows[0] as { count?: string } | undefined)?.count ?? 0,
    );
    const aggregatedEventCountForHistory = Number(
      (aggSumRowsForHistory.rows[0] as { sum?: string } | undefined)?.sum ?? 0,
    );

    const withRollupRows = rawCountForHistory + aggCountForHistory;
    const withoutRollupRows = rawCountForHistory + aggregatedEventCountForHistory;
    let historySavingsPercent: number | null = null;
    let historySavingsRatio: number | null = null;
    if (
      aggCountForHistory > 0 &&
      aggregatedEventCountForHistory > 0 &&
      withRollupRows > 0
    ) {
      historySavingsPercent =
        (1 - withRollupRows / withoutRollupRows) * 100;
      historySavingsRatio = withoutRollupRows / withRollupRows;
    }

    await tx.insert(badgeShareRollupRunHistoryTable).values({
      ranAt: new Date(nowMs),
      currentRawEventCount: rawCountForHistory,
      currentAggregateRowCount: aggCountForHistory,
      aggregatedEventCount: aggregatedEventCountForHistory,
      // numeric() columns accept strings; this preserves the exact
      // computed precision rather than relying on driver float coercion.
      savingsPercent:
        historySavingsPercent === null
          ? null
          : historySavingsPercent.toFixed(3),
      savingsRatio:
        historySavingsRatio === null
          ? null
          : historySavingsRatio.toFixed(3),
    });

    // Bound the history table — keep at least the sparkline window
    // (and a safety margin for missed runs) but no more, so the
    // append-only table can't grow forever.
    await tx
      .delete(badgeShareRollupRunHistoryTable)
      .where(
        lt(
          badgeShareRollupRunHistoryTable.ranAt,
          new Date(nowMs - MAX_RUN_HISTORY_AGE_MS),
        ),
      );
  });

  if (
    summary.rolledUpEvents > 0 ||
    summary.upsertedAggregateRows > 0 ||
    summary.prunedAggregateRows > 0
  ) {
    logger.info(
      summary,
      "[badge-share-rollup] aggregated and pruned badge_share_events",
    );
  }

  return summary;
}

/**
 * Build the super-admin panel payload (Task #1260). Combines the
 * persisted last-run state with live `COUNT(*)` queries against the
 * raw and aggregate tables so operators can confirm both that the
 * rollup keeps firing AND that the bound is working in practice.
 */
export async function getBadgeShareRollupAdminSummary(
  nowMs: number = Date.now(),
  historyDays: number = HISTORY_SPARKLINE_DAYS,
): Promise<BadgeShareRollupAdminSummary> {
  // Task #1821 — fetch the per-run history alongside the singleton
  // last-run state and live row counts. The history window is
  // intentionally small (default 7 days) so the panel can render an
  // inline sparkline; the underlying table holds >= 30 days.
  // Task #1814 — also fetch the persisted ops-alert cooldown row so
  // the panel can render "Last ops alert: 2h ago" alongside the
  // sparkline without an extra round-trip.
  const historyCutoff = new Date(nowMs - historyDays * 24 * 60 * 60 * 1000);
  const [lastRunRow, rawCountRow, aggCountRow, historyRows, lastAlertRow] = await Promise.all([
    db.select().from(badgeShareRollupRunsTable).where(eq(badgeShareRollupRunsTable.id, 1)).limit(1),
    db.execute(sql<{ count: string }>`SELECT COUNT(*)::text AS count FROM ${badgeShareEventsTable}`),
    db.execute(sql<{ count: string }>`SELECT COUNT(*)::text AS count FROM ${badgeShareDailyAggregatesTable}`),
    db
      .select({
        ranAt: badgeShareRollupRunHistoryTable.ranAt,
        savingsPercent: badgeShareRollupRunHistoryTable.savingsPercent,
        savingsRatio: badgeShareRollupRunHistoryTable.savingsRatio,
      })
      .from(badgeShareRollupRunHistoryTable)
      .where(gte(badgeShareRollupRunHistoryTable.ranAt, historyCutoff))
      .orderBy(asc(badgeShareRollupRunHistoryTable.ranAt)),
    // Task #1814 — Persisted "last paged on-call" timestamp (UPSERTed
    // by the auto-pager after a successful page). NULL row means the
    // alert pipeline hasn't fired yet on this database.
    db
      .select({ lastAlertedAt: badgeShareRollupOpsAlertsTable.lastAlertedAt })
      .from(badgeShareRollupOpsAlertsTable)
      .where(eq(badgeShareRollupOpsAlertsTable.id, 1))
      .limit(1),
  ]);

  const lastRun = lastRunRow[0] ?? null;
  const rawCount = Number((rawCountRow.rows[0] as { count: string } | undefined)?.count ?? 0);
  const aggCount = Number((aggCountRow.rows[0] as { count: string } | undefined)?.count ?? 0);
  const lastOpsAlertAt = lastAlertRow[0]?.lastAlertedAt ?? null;

  // Task #1474 + #1479 — single shared estimator computes both the
  // byte-level estimates and the row-count compression KPIs. Avoids
  // a redundant second SUM query (the estimator already needs SUM
  // for the byte math).
  const storageSavings = await computeShareRollupSavings({
    rawTableSqlName: "badge_share_events",
    aggregateTableSqlName: "badge_share_daily_aggregates",
    currentRawEventCount: rawCount,
    currentAggregateRowCount: aggCount,
  });

  const ranAtMs = lastRun ? lastRun.ranAt.getTime() : null;
  const isStale =
    ranAtMs === null || nowMs - ranAtMs > STALE_RUN_WARNING_MS;

  // Task #1821 — Coerce numeric() columns from the driver's `string`
  // representation to `number | null` so the panel can plot them
  // directly. NULL values are preserved (and rendered as gaps in the
  // sparkline) for the same reason `storageSavings.savingsPercent` is
  // nullable: the run hadn't yet collapsed any events at that point.
  const history: BadgeShareRollupHistoryPoint[] = historyRows.map((r) => ({
    ranAt: r.ranAt.toISOString(),
    savingsPercent: r.savingsPercent === null ? null : Number(r.savingsPercent),
    savingsRatio: r.savingsRatio === null ? null : Number(r.savingsRatio),
  }));

  return {
    lastRun: lastRun
      ? {
          ranAt: lastRun.ranAt.toISOString(),
          rolledUpEvents: lastRun.rolledUpEvents,
          upsertedAggregateRows: lastRun.upsertedAggregateRows,
          prunedAggregateRows: lastRun.prunedAggregateRows,
        }
      : null,
    currentRawEventCount: rawCount,
    currentAggregateRowCount: aggCount,
    storageSavings,
    history,
    historyDays,
    isStale,
    staleThresholdMs: STALE_RUN_WARNING_MS,
    rollupAgeMs: ROLLUP_AGE_MS,
    lastOpsAlertAt: lastOpsAlertAt ? lastOpsAlertAt.toISOString() : null,
    opsAlertCooldownMs:
      DEFAULT_BADGE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS * 60 * 60 * 1000,
    generatedAt: new Date(nowMs).toISOString(),
  };
}
