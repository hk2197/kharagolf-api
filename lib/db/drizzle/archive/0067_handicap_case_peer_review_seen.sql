-- Task #745 — track when a peer reviewer has at least opened the invitation
-- from the mobile inbox so the unread dot on the inbox card can settle.
-- Separate from `responded_at`, which only flips once they actually submit
-- a recommendation.

-- post-merge-guard: fresh-DB guard (table:handicap_case_peer_reviews)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'handicap_case_peer_reviews') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE "handicap_case_peer_reviews"
  ADD COLUMN IF NOT EXISTS "seen_at" timestamp with time zone;

\else
\echo 'parent table handicap_case_peer_reviews not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

