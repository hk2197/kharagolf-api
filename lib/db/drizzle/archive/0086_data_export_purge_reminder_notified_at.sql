-- Task #972 — "Email members a heads-up the day before their export
-- auto-deletes". Adds a one-shot dedup column on member_data_requests so
-- the daily purge-reminder cron never resends the courtesy notice for the
-- same archive.
ALTER TABLE "member_data_requests"
  ADD COLUMN IF NOT EXISTS "expiry_notified_at" timestamptz;
