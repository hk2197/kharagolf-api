-- Task #418 — Move highlight rendering off the API process.
-- Adds queue bookkeeping columns to highlight_reels so a separate worker
-- process can claim queued renders with SELECT ... FOR UPDATE SKIP LOCKED
-- and retry failed jobs with exponential backoff.


-- post-merge-guard: fresh-DB guard (table:highlight_reels)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'highlight_reels') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "highlight_reels"
  ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;

ALTER TABLE "highlight_reels"
  ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS "highlight_reels_queue_idx"
  ON "highlight_reels" ("status", "next_attempt_at");

\else
\echo 'parent table highlight_reels not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

