-- Task #2079 — Distinguish synthetic "Send test page" rows in
-- manual_entry_alert_page_history so the dashboard banner / history
-- list can label them as wiring tests instead of mistaking them for a
-- real outage page.
--
-- Background. Task #1665 introduced the page-history table so the
-- dashboard could show "Last paged on-call …" without DM'ing
-- engineering. The auto-page job (Task #1387) is currently the only
-- writer, so every row in the table is a real outage. Task #2079
-- adds a super-admin "Send test page" button that re-uses the same
-- recipient resolution + Resend wiring as the cron, and persists a
-- row to the same table so the test exercises the history-write code
-- path end-to-end. We need a marker column so test pages don't
-- pollute the breach-history banner.
--
-- `is_test boolean default false not null` matches the schema
-- (`isTest` in `lib/db/src/schema/golf.ts`). NOT NULL with a default
-- of false means existing rows backfilled by Task #1665 keep their
-- "real page" semantics with no manual update, and the cron's
-- existing INSERT doesn't need to specify the column unless it
-- chooses to.
--
-- Wrapped in `IF NOT EXISTS` for replay-safety, mirroring every other
-- migration in this directory.

ALTER TABLE "manual_entry_alert_page_history"
  ADD COLUMN IF NOT EXISTS "is_test" boolean DEFAULT false NOT NULL;
