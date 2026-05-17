-- Task #773 — record exactly when an expired data-export archive was purged
-- by the daily cron, so the member portal and controller dashboard can show
-- "Removed on <date>" instead of just inferring "expired" from the 7-day
-- clock against resolved_at. NULL on legacy rows that were already cleared
-- before the column existed.
ALTER TABLE "member_data_requests"
  ADD COLUMN IF NOT EXISTS "purged_at" timestamptz;
