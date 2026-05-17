/**
 * Task #877 — Per-minute counter of watch GPS `position` messages.
 *
 * Task #722 made the watch app debounce redundant GPS pings before sending
 * them to the server. We had no server-side measurement to confirm the drop
 * in volume, or to catch a future regression that re-floods the channel.
 *
 * One row per (active watch session × minute bucket): how many `position`
 * messages the WS handler received for that session in that minute. The
 * super-admin ops dashboard aggregates over the last 24h / 7d / 30d so we
 * can compare pre- and post-#722 traffic and watch the rate over time.
 *
 * Rows are flushed when the bucket rolls forward or the session closes;
 * old rows (>90 days) are swept by the existing daily prune cron.
 */
import { pgTable, serial, integer, text, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const watchPositionMetricsTable = pgTable("watch_position_metrics", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  sessionId: text("session_id").notNull(),
  tournamentId: integer("tournament_id"),
  batteryMode: boolean("battery_mode").notNull().default(false),
  // Truncated to the minute (UTC) — primary aggregation key.
  bucketMinute: timestamp("bucket_minute", { withTimezone: true }).notNull(),
  positionCount: integer("position_count").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("watch_position_metrics_bucket_minute_idx").on(t.bucketMinute),
  // Allows upsert-on-conflict if the same session somehow reports the same
  // minute twice (e.g. handler bug or retry); also guarantees one row per
  // (session, minute) which keeps aggregations sensible.
  uniqueIndex("watch_position_metrics_session_bucket_uq").on(t.sessionId, t.bucketMinute),
]);
