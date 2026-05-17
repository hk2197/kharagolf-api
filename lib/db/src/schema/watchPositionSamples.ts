/**
 * Task #1392 / Task #1676 — Recent raw watch GPS payloads.
 *
 * Companion to `watch_position_metrics`: that table tells ops *how loud* a
 * watch session is (per-minute counters). This one stores the actual
 * lat/lng/accuracy/timestamp of the most recent samples so ops can drill
 * into a misbehaving session and decide whether the watch is stuck in a
 * tight loop, drifting, or being faked.
 *
 * Originally an in-process per-replica ring buffer (Task #1392). Promoted
 * to a shared table in Task #1676 so a misbehaving watch's recent positions
 * are visible from any api-server replica — the WS socket pins the writer
 * to one replica, but the dashboard request (read) lands on whichever
 * replica the load balancer picks. Per-replica visibility was a real ops
 * gap when a deployment ran more than one replica.
 *
 * Eviction:
 *   - Per-session ring cap (POSITION_SAMPLE_RING_SIZE rows) enforced
 *     opportunistically on every insert; keeps the table size bounded by
 *     `(active sessions × ring size)`.
 *   - TTL prune (POSITION_SAMPLE_TTL_MS) runs on the same daily cron as
 *     `watch_position_metrics`; sweeps anything older than the TTL even
 *     for sessions that disconnected without being trimmed.
 */
import {
  pgTable,
  serial,
  text,
  doublePrecision,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const watchPositionSamplesTable = pgTable(
  "watch_position_samples",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    /** Server-side wall-clock time of when the sample was received. */
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    /** GPS accuracy in metres if the watch reported one; null otherwise. */
    accuracy: doublePrecision("accuracy"),
    batteryMode: boolean("battery_mode").notNull().default(false),
  },
  (t) => [
    // Drives the per-session "most recent N" read in
    // `getRecentWatchPositionSamples` and the per-session ring trim in
    // `recordWatchPositionSample`. Composite (session_id, recorded_at desc)
    // so both the LIMIT-N read and the "ids beyond top N" delete can index
    // straight off this without a sort.
    index("watch_position_samples_session_recorded_idx").on(
      t.sessionId,
      t.recordedAt.desc(),
    ),
    // Drives the global TTL prune in `pruneWatchPositionSamples`.
    index("watch_position_samples_recorded_idx").on(t.recordedAt),
  ],
);
