-- Tee Booking Reminder Tracking
-- Adds persistent reminder-sent timestamps to tee_bookings so cron jobs do not
-- re-send 24h/2h reminders after a server restart.
-- NOTE: Idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout).


-- post-merge-guard: fresh-DB guard (table:tee_bookings)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tee_bookings') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "tee_bookings"
  ADD COLUMN IF NOT EXISTS "reminder_24h_sent_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "reminder_2h_sent_at"  timestamptz;

\else
\echo 'parent table tee_bookings not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

