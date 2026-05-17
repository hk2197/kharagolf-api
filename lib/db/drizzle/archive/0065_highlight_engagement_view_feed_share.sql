-- Task #708 — Extend highlight reel engagement events with two new types so
-- producers can see the full engagement story for a reel:
--   • 'view'        — reel was watched past a threshold (e.g. 2s) inside the
--                     social feed (mobile or web).
--   • 'feed_share'  — reel was re-shared from the feed surface (distinct from
--                     'share', which the highlights gallery fires when the
--                     owner hands a reel off to a system share sheet).

DO $$ BEGIN
  ALTER TYPE "highlight_reel_engagement_type" ADD VALUE IF NOT EXISTS 'view';
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "highlight_reel_engagement_type" ADD VALUE IF NOT EXISTS 'feed_share';
EXCEPTION WHEN others THEN NULL; END $$;
