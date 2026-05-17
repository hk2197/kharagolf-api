/**
 * Task #1474 — Shared storage-savings estimator for the share-event
 * rollup admin panels.
 *
 * Both `badge_share_events` (Task #1096) and `profile_share_events`
 * (Task #1259) follow the same rollup pattern: many raw event rows are
 * folded into one row per (..., day) tuple in a `*_daily_aggregates`
 * table whose `count` column records how many raw events were collapsed.
 * That gives us everything we need to estimate the storage the rollup
 * has saved over the lifetime of the table:
 *
 *   - `aggregatedEventCount` — SUM(count) over the aggregate table.
 *     This is the number of raw events that *would* still be in the
 *     raw table if the rollup had never run.
 *
 *   - `estimatedRowsSaved` — how many raw rows the rollup eliminated:
 *       aggregatedEventCount - currentAggregateRowCount
 *     (every collapsed group still keeps one aggregate row).
 *
 *   - `estimatedBytesSaved` — how many bytes those eliminated raw rows
 *     would have occupied. We use the live raw table's actual disk
 *     usage divided by its current row count to get a per-row size
 *     (`estimatedBytesPerRawRow`) that includes heap, indexes, and
 *     TOAST overhead — far more accurate than a hardcoded constant.
 *
 *     If the raw table is empty (fresh DB / first deploy), we fall
 *     back to `DEFAULT_RAW_ROW_BYTES_FALLBACK` so the panel still
 *     renders a sensible number rather than 0 / NaN.
 *
 * The numbers are explicitly *estimates* — Postgres's per-row overhead
 * varies with TOAST compression, index bloat, and dead tuples — and the
 * UI surfaces them with that caveat. The shape is shared by both
 * variants so the same UI component can render either one.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Fallback per-row size when the raw table has no rows yet, so we can't
 * derive the number from `pg_total_relation_size / row_count`. Sized to
 * match the typical heap+index footprint of a single row in either
 * `badge_share_events` or `profile_share_events` (small handful of
 * fixed-width columns + one short text + a couple of indexes).
 */
export const DEFAULT_RAW_ROW_BYTES_FALLBACK = 96;

export interface ShareRollupStorageSavings {
  /** SUM(count) over the aggregate table — total raw events folded down. */
  aggregatedEventCount: number;
  /** How many raw rows the rollup has eliminated (aggregated - current aggregates). */
  estimatedRowsSaved: number;
  /** Bytes the eliminated raw rows would have occupied (rowsSaved * bytesPerRawRow). */
  estimatedBytesSaved: number;
  /**
   * Bytes per raw row derived live from `pg_total_relation_size /
   * current_row_count`. Falls back to `DEFAULT_RAW_ROW_BYTES_FALLBACK`
   * when the raw table is empty.
   */
  estimatedBytesPerRawRow: number;
  /**
   * Task #1479 — Compression KPIs derived purely from row counts so the
   * panel can surface "X% smaller than raw" / "raw events would be N×
   * larger without rollup" without making the client redo the math.
   *   savingsPercent = (1 - storedRows / withoutRollupRows) * 100
   *   savingsRatio   = withoutRollupRows / storedRows
   *     where  storedRows        = currentRawEventCount + currentAggregateRowCount
   *            withoutRollupRows = currentRawEventCount + aggregatedEventCount
   * Both are `null` when the rollup has not yet collapsed any events
   * (no aggregates exist) so the UI can render an empty state instead
   * of a misleading "0%".
   */
  savingsPercent: number | null;
  savingsRatio: number | null;
}

/**
 * Compute the savings estimate for one rollup pair.
 *
 * @param rawTableSqlName Unquoted Postgres relation name for the raw event table.
 * @param aggregateTableSqlName Unquoted Postgres relation name for the
 *   per-day aggregate table; must have an integer `count` column.
 * @param currentRawEventCount Live row count of the raw table (already
 *   queried by the caller — pass it in to avoid double work).
 * @param currentAggregateRowCount Live row count of the aggregate table.
 */
export async function computeShareRollupSavings(opts: {
  rawTableSqlName: string;
  aggregateTableSqlName: string;
  currentRawEventCount: number;
  currentAggregateRowCount: number;
}): Promise<ShareRollupStorageSavings> {
  // Both queries are read-only and the relation names come from
  // hardcoded callers (badge/profile share rollup modules), so
  // sql.raw() is safe here — there is no user input in the path.
  const [aggSumResult, sizeResult] = await Promise.all([
    db.execute(sql.raw(
      `SELECT COALESCE(SUM(count), 0)::text AS sum FROM "${opts.aggregateTableSqlName}"`,
    )),
    db.execute(sql.raw(
      `SELECT pg_total_relation_size('"${opts.rawTableSqlName}"')::text AS raw_bytes`,
    )),
  ]);

  const aggregatedEventCount = Number(
    (aggSumResult.rows[0] as { sum?: string } | undefined)?.sum ?? 0,
  );
  const estimatedRowsSaved = Math.max(
    0,
    aggregatedEventCount - opts.currentAggregateRowCount,
  );

  const rawTotalBytes = Number(
    (sizeResult.rows[0] as { raw_bytes?: string } | undefined)?.raw_bytes ?? 0,
  );
  const estimatedBytesPerRawRow =
    opts.currentRawEventCount > 0 && rawTotalBytes > 0
      ? Math.max(1, Math.round(rawTotalBytes / opts.currentRawEventCount))
      : DEFAULT_RAW_ROW_BYTES_FALLBACK;

  const estimatedBytesSaved = estimatedRowsSaved * estimatedBytesPerRawRow;

  // Task #1479 — row-count-based compression KPIs. Skip the math when
  // the rollup hasn't collapsed anything (no aggregates) so the panel
  // can render an empty state instead of a meaningless "0%".
  const withoutRollupRows = opts.currentRawEventCount + aggregatedEventCount;
  const withRollupRows = opts.currentRawEventCount + opts.currentAggregateRowCount;
  let savingsPercent: number | null = null;
  let savingsRatio: number | null = null;
  if (
    opts.currentAggregateRowCount > 0 &&
    aggregatedEventCount > 0 &&
    withRollupRows > 0
  ) {
    savingsPercent = (1 - withRollupRows / withoutRollupRows) * 100;
    savingsRatio = withoutRollupRows / withRollupRows;
  }

  return {
    aggregatedEventCount,
    estimatedRowsSaved,
    estimatedBytesSaved,
    estimatedBytesPerRawRow,
    savingsPercent,
    savingsRatio,
  };
}
