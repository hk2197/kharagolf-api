-- Task #1679 — Persisted block list for the "mute a runaway watch session"
-- super-admin action (Task #1393).
--
-- The mute used to live only in an in-process Map inside the API server's
-- `watchPositionMetrics.ts`, so every restart / deploy silently lifted every
-- active mute without re-emitting an audit event. This table is the new
-- source of truth: the in-memory Map is hydrated from it on boot, every
-- mute / unmute writes through here, and expired rows are reaped by the
-- existing daily watch-position-metrics prune cron.
--
-- One row per active mute, keyed by `session_id` (matches the
-- `watch_position_metrics.session_id` shape). Re-muting the same session
-- updates `expires_at` via ON CONFLICT.
CREATE TABLE IF NOT EXISTS "watch_session_mutes" (
  "session_id" text PRIMARY KEY,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Supports the periodic "delete WHERE expires_at < now()" sweep without a
-- sequential scan once the table accumulates many short-lived rows.
CREATE INDEX IF NOT EXISTS "watch_session_mutes_expires_at_idx"
  ON "watch_session_mutes" ("expires_at");
