-- Task #654 — Persist the per-org throttle that prevents duplicate
-- schedule-change heads-up emails (and audit rows) so it survives an
-- API server restart. Previously this lived in an in-memory Map, which
-- meant restarting the server inside the 60-second window let an admin
-- save twice and trigger two notifications + two audit rows.
--
-- The notify path now atomically claims the throttle via a conditional
-- UPDATE on this column, so concurrent saves and restarts both yield
-- exactly one send per 60-second window.

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "bounced_digest_schedule_notify_at" timestamp with time zone;
