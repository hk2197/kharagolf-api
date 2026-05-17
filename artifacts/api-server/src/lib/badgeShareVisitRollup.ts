/**
 * Task #2255 — Bound the `badge_share_visit_events` table by rolling
 * old rows into the per-day `badge_share_visit_daily_aggregates`
 * table and deleting the originals.
 *
 * Mirrors the `pruneAndRollupBadgeShareEvents` job (Task #1096) for
 * the share-event table, with one extra dimension: visits carry a
 * `source` column ("web" | "mobile" | "crawler" | "unknown") that the
 * leaderboard endpoints filter on (`source != 'crawler'`) to exclude
 * link-preview renders from the conversion ratio. We preserve `source`
 * in the bucketing key here so that filter keeps working against
 * post-rollup aggregate rows the same way it does against raw rows.
 *
 * The rollup runs in a single transaction:
 *  1. Aggregate every event with `created_at < cutoff` into per-day
 *     buckets and UPSERT them into the aggregate table (sum on
 *     conflict so re-running the rollup is safe — e.g. after an
 *     interrupted run that aggregated some rows but failed to delete
 *     them, the next run will add the same counts again, then delete
 *     them, keeping the visible total stable).
 *  2. Delete those events.
 *  3. Drop aggregates older than the long-term retention window.
 */
import {
  db,
  badgeShareVisitEventsTable,
  badgeShareVisitDailyAggregatesTable,
} from "@workspace/db";
import { lt, sql } from "drizzle-orm";
import { logger } from "./logger";

/** Roll up events older than this into the daily aggregates table. */
export const VISIT_ROLLUP_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Drop daily-aggregate rows older than this. ~3y of history is plenty. */
export const VISIT_MAX_AGGREGATE_AGE_MS =
  3 * 365 * 24 * 60 * 60 * 1000;

export interface BadgeShareVisitRollupSummary {
  rolledUpEvents: number;
  upsertedAggregateRows: number;
  prunedAggregateRows: number;
}

export async function pruneAndRollupBadgeShareVisitEvents(
  nowMs: number = Date.now(),
): Promise<BadgeShareVisitRollupSummary> {
  const cutoff = new Date(nowMs - VISIT_ROLLUP_AGE_MS);
  const aggregateCutoff = new Date(nowMs - VISIT_MAX_AGGREGATE_AGE_MS);

  const summary: BadgeShareVisitRollupSummary = {
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
      INSERT INTO ${badgeShareVisitDailyAggregatesTable} (handle, badge_type, source, day, count)
      SELECT
        ${badgeShareVisitEventsTable.handle},
        ${badgeShareVisitEventsTable.badgeType},
        ${badgeShareVisitEventsTable.source},
        date_trunc('day', ${badgeShareVisitEventsTable.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day,
        COUNT(*)::int AS count
      FROM ${badgeShareVisitEventsTable}
      WHERE ${badgeShareVisitEventsTable.createdAt} < ${cutoff}
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (handle, badge_type, source, day)
      DO UPDATE SET count = ${badgeShareVisitDailyAggregatesTable.count} + EXCLUDED.count
    `);
    summary.upsertedAggregateRows = upsertResult.rowCount ?? 0;

    const deleteResult = await tx
      .delete(badgeShareVisitEventsTable)
      .where(lt(badgeShareVisitEventsTable.createdAt, cutoff));
    summary.rolledUpEvents = deleteResult.rowCount ?? 0;

    const aggDeleteResult = await tx
      .delete(badgeShareVisitDailyAggregatesTable)
      .where(lt(badgeShareVisitDailyAggregatesTable.day, aggregateCutoff));
    summary.prunedAggregateRows = aggDeleteResult.rowCount ?? 0;
  });

  if (
    summary.rolledUpEvents > 0 ||
    summary.upsertedAggregateRows > 0 ||
    summary.prunedAggregateRows > 0
  ) {
    logger.info(
      summary,
      "[badge-share-visit-rollup] aggregated and pruned badge_share_visit_events",
    );
  }

  return summary;
}
