-- Task 528: Per-user marketplace saved-search alert frequency & quiet hours.
--
-- Adds three optional per-saved-search overrides:
--   * `daily_cap` – when set, takes precedence over the global default
--     `MARKETPLACE_ALERT_DAILY_CAP_PER_USER` for *this* search. Power users
--     can raise it above the global default; casual users can lower it.
--   * `quiet_hours_start`/`quiet_hours_end` – an hour-of-day window
--     (0-23) during which the saved-search alert worker defers pushes for
--     this search. Supports overnight windows (e.g. 22→7).
--   * `quiet_hours_tz` – IANA timezone the quiet-hours window is
--     interpreted in. Defaults to 'Asia/Kolkata' so existing rows keep the
--     same behaviour as the rest of the marketplace stack.


-- post-merge-guard: fresh-DB guard (table:marketplace_saved_searches)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'marketplace_saved_searches') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE marketplace_saved_searches
  ADD COLUMN IF NOT EXISTS daily_cap          integer,
  ADD COLUMN IF NOT EXISTS quiet_hours_start  integer,
  ADD COLUMN IF NOT EXISTS quiet_hours_end    integer,
  ADD COLUMN IF NOT EXISTS quiet_hours_tz     text NOT NULL DEFAULT 'Asia/Kolkata';

\else
\echo 'parent table marketplace_saved_searches not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

