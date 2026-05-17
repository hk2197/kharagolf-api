-- Task #1127 — proactively page org admins when an orphan-file deletion
-- crosses the bounded-retry exhaustion threshold (>= 10 attempts).
--
-- The cron's processPendingStorageDeletions worker stamps this column
-- with the moment the alert is dispatched and uses an atomic conditional
-- UPDATE on `WHERE exhaustion_notified_at IS NULL` to make sure the
-- alert is delivered exactly once per row, regardless of how many
-- subsequent retry ticks the row sits through.
ALTER TABLE "pending_storage_deletions"
  ADD COLUMN IF NOT EXISTS "exhaustion_notified_at" timestamptz;
