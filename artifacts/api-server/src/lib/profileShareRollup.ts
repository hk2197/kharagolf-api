/**
 * Task #1259 — Bound the `profile_share_events` table by rolling old
 * rows into the per-day `profile_share_daily_aggregates` table and
 * deleting the originals. Mirrors the badge-share rollup added in
 * Task #1096 (`badgeShareRollup.ts`).
 *
 * Why a rollup rather than a hard prune?
 *  - The public share-stats endpoint, the portal share-stats endpoint,
 *    and the admin profile-share leaderboard all surface counts over
 *    the entire history of a user (or a date range that may extend
 *    past the rollup window). Hard-deleting old events would silently
 *    drop those counts; rollup preserves the totals while bounding
 *    row growth to one row per (user_id, method, day) instead of one
 *    row per share click.
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
 * Task #1474 — After every successful run we UPSERT a singleton
 * `profile_share_rollup_runs` row so a super-admin "storage savings"
 * panel can show the most recent run's summary alongside the badge-share
 * variant from Task #1260, and warn loudly when the cron has been silent.
 */
import {
  db,
  profileShareEventsTable,
  profileShareDailyAggregatesTable,
  profileShareRollupRunsTable,
} from "@workspace/db";
import { eq, lt, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  computeShareRollupSavings,
  type ShareRollupStorageSavings,
} from "./shareRollupSavings";

/** Roll up events older than this into the daily aggregates table. */
export const ROLLUP_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Drop daily-aggregate rows older than this. ~3y of history is plenty. */
export const MAX_AGGREGATE_AGE_MS = 3 * 365 * 24 * 60 * 60 * 1000;

/**
 * If the most recent successful rollup is older than this, the
 * super-admin panel renders a loud "the cron may have stopped firing"
 * warning. The job runs once per day, so 36 h gives a comfortable
 * one-cycle slack before raising the alarm. Matches the badge-share
 * variant so both panels use the same threshold.
 */
export const STALE_RUN_WARNING_MS = 36 * 60 * 60 * 1000;

export interface ProfileShareRollupSummary {
  rolledUpEvents: number;
  upsertedAggregateRows: number;
  prunedAggregateRows: number;
}

/**
 * Public summary surfaced on the super-admin storage-savings panel
 * (Task #1474). Mirrors `BadgeShareRollupAdminSummary` so the panel
 * can render both rollups side by side with one shared component.
 *  - `lastRun` is the persisted state from the most recent successful
 *    `pruneAndRollupProfileShareEvents` invocation (null if the job
 *    has never completed on this database — e.g. fresh deploy before
 *    the first cron tick).
 *  - The two `currentRowCount` fields are read live so the panel
 *    reflects today's table size rather than the size at last run.
 *  - `storageSavings.savingsPercent` / `storageSavings.savingsRatio`
 *    are the row-count compression KPIs ("X% smaller than raw" / "raw
 *    events would be N× larger without rollup") so the panel can
 *    surface the impact at a glance without making the client redo
 *    the math. Both are `null` when the rollup has not yet collapsed
 *    any events — the panel renders that case as "no savings to
 *    report yet" instead of "0%".
 *  - `isStale` is true when the last successful run is older than
 *    `STALE_RUN_WARNING_MS`, or when no run has ever completed.
 */
export interface ProfileShareRollupAdminSummary {
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
   *   - Task #1817 surfaces the row-count compression KPIs
   *     (`savingsPercent`, `savingsRatio`) on the profile-share panel,
   *     mirroring the badge-share variant from Task #1479 so the same
   *     UI helper can render both with one shared "% saved" headline.
   * The byte-level numbers are estimates — Postgres per-row overhead
   * varies — and the UI labels them as such.
   */
  storageSavings: ShareRollupStorageSavings;
  isStale: boolean;
  staleThresholdMs: number;
  rollupAgeMs: number;
  generatedAt: string;
}

export async function pruneAndRollupProfileShareEvents(
  nowMs: number = Date.now(),
): Promise<ProfileShareRollupSummary> {
  const cutoff = new Date(nowMs - ROLLUP_AGE_MS);
  const aggregateCutoff = new Date(nowMs - MAX_AGGREGATE_AGE_MS);

  const summary: ProfileShareRollupSummary = {
    rolledUpEvents: 0,
    upsertedAggregateRows: 0,
    prunedAggregateRows: 0,
  };

  await db.transaction(async (tx) => {
    // Sum every old event into per-day buckets in a single statement
    // and UPSERT into the aggregate table. Using INSERT … SELECT … ON
    // CONFLICT lets the database do the bucketing without round-tripping
    // every row to the application.
    // Task #1781 — Group by `source` too so the per-day rollup preserves
    // the web-vs-mobile split for events older than the rollup window.
    // Raw `source` is nullable, but the aggregate column is NOT NULL
    // (it's part of the PK), so we COALESCE NULLs to the sentinel
    // `'unknown'`. The `bySource` read paths exclude `'unknown'` so the
    // chips only reflect events that were actually tagged at write time.
    const upsertResult = await tx.execute(sql`
      INSERT INTO ${profileShareDailyAggregatesTable} (user_id, method, source, day, count)
      SELECT
        ${profileShareEventsTable.userId},
        ${profileShareEventsTable.method},
        COALESCE(${profileShareEventsTable.source}, 'unknown') AS source,
        date_trunc('day', ${profileShareEventsTable.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day,
        COUNT(*)::int AS count
      FROM ${profileShareEventsTable}
      WHERE ${profileShareEventsTable.createdAt} < ${cutoff}
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (user_id, method, day, source)
      DO UPDATE SET count = ${profileShareDailyAggregatesTable.count} + EXCLUDED.count
    `);
    summary.upsertedAggregateRows = upsertResult.rowCount ?? 0;

    const deleteResult = await tx
      .delete(profileShareEventsTable)
      .where(lt(profileShareEventsTable.createdAt, cutoff));
    summary.rolledUpEvents = deleteResult.rowCount ?? 0;

    const aggDeleteResult = await tx
      .delete(profileShareDailyAggregatesTable)
      .where(lt(profileShareDailyAggregatesTable.day, aggregateCutoff));
    summary.prunedAggregateRows = aggDeleteResult.rowCount ?? 0;

    // Task #1474 — Persist the last-run state. Always upsert (even when
    // no rows changed) so the super-admin panel can see the cron is
    // still firing on schedule, not just when it has work to do.
    await tx.execute(sql`
      INSERT INTO ${profileShareRollupRunsTable}
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
  });

  if (
    summary.rolledUpEvents > 0 ||
    summary.upsertedAggregateRows > 0 ||
    summary.prunedAggregateRows > 0
  ) {
    logger.info(
      summary,
      "[profile-share-rollup] aggregated and pruned profile_share_events",
    );
  }

  return summary;
}

/**
 * Build the super-admin panel payload (Task #1474). Combines the
 * persisted last-run state with live `COUNT(*)` queries against the
 * raw and aggregate tables so operators can confirm both that the
 * rollup keeps firing AND that the bound is working in practice.
 * Shape matches `getBadgeShareRollupAdminSummary` so the same UI
 * component can render either variant.
 */
export async function getProfileShareRollupAdminSummary(
  nowMs: number = Date.now(),
): Promise<ProfileShareRollupAdminSummary> {
  const [lastRunRow, rawCountRow, aggCountRow] = await Promise.all([
    db.select().from(profileShareRollupRunsTable).where(eq(profileShareRollupRunsTable.id, 1)).limit(1),
    db.execute(sql<{ count: string }>`SELECT COUNT(*)::text AS count FROM ${profileShareEventsTable}`),
    db.execute(sql<{ count: string }>`SELECT COUNT(*)::text AS count FROM ${profileShareDailyAggregatesTable}`),
  ]);

  const lastRun = lastRunRow[0] ?? null;
  const rawCount = Number((rawCountRow.rows[0] as { count: string } | undefined)?.count ?? 0);
  const aggCount = Number((aggCountRow.rows[0] as { count: string } | undefined)?.count ?? 0);

  const storageSavings = await computeShareRollupSavings({
    rawTableSqlName: "profile_share_events",
    aggregateTableSqlName: "profile_share_daily_aggregates",
    currentRawEventCount: rawCount,
    currentAggregateRowCount: aggCount,
  });

  const ranAtMs = lastRun ? lastRun.ranAt.getTime() : null;
  const isStale =
    ranAtMs === null || nowMs - ranAtMs > STALE_RUN_WARNING_MS;

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
    isStale,
    staleThresholdMs: STALE_RUN_WARNING_MS,
    rollupAgeMs: ROLLUP_AGE_MS,
    generatedAt: new Date(nowMs).toISOString(),
  };
}
