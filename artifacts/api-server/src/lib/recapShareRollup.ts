/**
 * Task #1281 — Bound the `recap_share_events` table by rolling old rows
 * into the per-day `recap_share_daily_aggregates` table and deleting
 * the originals. Mirrors the badge-share rollup added in Task #1096
 * (`badgeShareRollup.ts`) and the profile-share rollup added in Task
 * #1259 (`profileShareRollup.ts`).
 *
 * Why a rollup rather than a hard prune?
 *  - The portal recap-share-stats endpoint surfaces totals over the
 *    entire history of the player. Hard-deleting old events would
 *    silently drop those counts; rollup preserves the totals while
 *    bounding row growth to one row per (user_id, asset, period, year,
 *    source, day) instead of one row per recap link hit. Crawler hits
 *    in particular fan out one share into many fetches.
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
 */
import { db, recapShareEventsTable, recapShareDailyAggregatesTable } from "@workspace/db";
import { lt, sql } from "drizzle-orm";
import { logger } from "./logger";

/** Roll up events older than this into the daily aggregates table. */
export const ROLLUP_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Drop daily-aggregate rows older than this. ~3y of history is plenty. */
export const MAX_AGGREGATE_AGE_MS = 3 * 365 * 24 * 60 * 60 * 1000;

export interface RecapShareRollupSummary {
  rolledUpEvents: number;
  upsertedAggregateRows: number;
  prunedAggregateRows: number;
}

export async function pruneAndRollupRecapShareEvents(
  nowMs: number = Date.now(),
): Promise<RecapShareRollupSummary> {
  const cutoff = new Date(nowMs - ROLLUP_AGE_MS);
  const aggregateCutoff = new Date(nowMs - MAX_AGGREGATE_AGE_MS);

  const summary: RecapShareRollupSummary = {
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
      INSERT INTO ${recapShareDailyAggregatesTable} (user_id, asset, period, year, source, day, count)
      SELECT
        ${recapShareEventsTable.userId},
        ${recapShareEventsTable.asset},
        ${recapShareEventsTable.period},
        ${recapShareEventsTable.year},
        ${recapShareEventsTable.source},
        date_trunc('day', ${recapShareEventsTable.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day,
        COUNT(*)::int AS count
      FROM ${recapShareEventsTable}
      WHERE ${recapShareEventsTable.createdAt} < ${cutoff}
      GROUP BY 1, 2, 3, 4, 5, 6
      ON CONFLICT (user_id, asset, period, year, source, day)
      DO UPDATE SET count = ${recapShareDailyAggregatesTable.count} + EXCLUDED.count
    `);
    summary.upsertedAggregateRows = upsertResult.rowCount ?? 0;

    const deleteResult = await tx
      .delete(recapShareEventsTable)
      .where(lt(recapShareEventsTable.createdAt, cutoff));
    summary.rolledUpEvents = deleteResult.rowCount ?? 0;

    const aggDeleteResult = await tx
      .delete(recapShareDailyAggregatesTable)
      .where(lt(recapShareDailyAggregatesTable.day, aggregateCutoff));
    summary.prunedAggregateRows = aggDeleteResult.rowCount ?? 0;
  });

  if (
    summary.rolledUpEvents > 0 ||
    summary.upsertedAggregateRows > 0 ||
    summary.prunedAggregateRows > 0
  ) {
    logger.info(
      summary,
      "[recap-share-rollup] aggregated and pruned recap_share_events",
    );
  }

  return summary;
}
