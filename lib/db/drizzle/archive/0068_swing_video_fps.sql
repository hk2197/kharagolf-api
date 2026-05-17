-- Task #761 — store the source video's true frame rate so the coach delivery
-- canvas can step ±1 real frame regardless of capture fps (30 / 60 / 120 / 240).
-- NULL on legacy rows; clients fall back to 30fps until a value is recorded.
-- The web coach UI detects fps via requestVideoFrameCallback and patches it
-- back so future viewers (web + mobile) get accurate stepping.

-- post-merge-guard: fresh-DB guard (table:swing_videos)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'swing_videos') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "swing_videos"
  ADD COLUMN IF NOT EXISTS "fps" numeric(6, 3);

\else
\echo 'parent table swing_videos not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

