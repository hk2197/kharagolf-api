-- Task #1327 — on-demand re-probe of legacy videos whose original
-- backfill (Task #855) couldn't measure their duration.
--
-- Some of those backfill failures were transient (ffprobe timeout,
-- temporary storage hiccup), so the admin "Unverifiable videos" page
-- now exposes a per-row "Re-check" action and a top-of-page "Re-check
-- all" button. When the re-probe still fails we stamp this column so
-- the row stays in the list with a "last attempted" timestamp instead
-- of looking untried — that way admins can tell at a glance which
-- rows are genuinely stuck vs. simply never re-tried.
--
-- Nullable + no default so existing rows read as "never re-checked"
-- exactly the way the on-demand endpoint expects.
ALTER TABLE "media"
  ADD COLUMN IF NOT EXISTS "duration_last_checked_at" timestamp with time zone;
