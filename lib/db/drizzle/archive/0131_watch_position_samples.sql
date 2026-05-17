-- Task #1676 — Promote the in-process watch GPS position-sample ring buffer
-- (added in Task #1392) to a shared Postgres table so a misbehaving watch's
-- recent positions are visible from any api-server replica, not just the one
-- the WS socket is pinned to.
--
-- The companion `watch_position_metrics` table tells ops *how loud* a watch
-- session is (per-minute counters); this one stores the actual lat/lng/
-- accuracy/timestamp so they can decide whether the watch is stuck in a tight
-- loop, drifting, or being faked when they drill in from the chart.
--
-- Eviction: the writer enforces a per-session ring cap on every insert so
-- the table size is bounded by `(active sessions × ring size)`; a daily
-- TTL prune (piggy-backing on the existing watch-position-metrics prune
-- cron) sweeps anything older than the ring TTL even for sessions that
-- disconnected without being trimmed.
--
-- Backfill: history-starts-here. Pre-#1676 samples only ever lived in the
-- per-replica in-process map and weren't durable; there is nothing to
-- backfill.

CREATE TABLE IF NOT EXISTS "watch_position_samples" (
  "id" serial PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lat" double precision NOT NULL,
  "lng" double precision NOT NULL,
  "accuracy" double precision,
  "battery_mode" boolean DEFAULT false NOT NULL
);

-- Drives the per-session "most recent N" read in
-- `getRecentWatchPositionSamples` and the per-session ring trim in
-- `recordWatchPositionSample`.
CREATE INDEX IF NOT EXISTS "watch_position_samples_session_recorded_idx"
  ON "watch_position_samples" ("session_id", "recorded_at" DESC);

-- Drives the global TTL prune in `pruneWatchPositionSamples`.
CREATE INDEX IF NOT EXISTS "watch_position_samples_recorded_idx"
  ON "watch_position_samples" ("recorded_at");
