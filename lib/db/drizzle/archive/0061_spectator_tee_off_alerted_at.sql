-- Task #634 — Persist spectator tee-off countdown dedup across server restarts.
-- Records when the spectator tee-off alert was dispatched for a given tee time
-- so the cron's in-memory dedup set is not the only thing preventing duplicate
-- pushes after an API server restart inside the 5-minute polling window.
ALTER TABLE "tee_times"
  ADD COLUMN IF NOT EXISTS "spectator_tee_off_alerted_at" timestamp with time zone;
