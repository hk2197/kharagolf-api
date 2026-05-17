-- Migration 0077 — Task #851
--
-- Restore the "one shot per (player, tournament, round, hole, shotNumber)"
-- and the "one shot per (user, generalPlayRound, round, hole, shotNumber)"
-- unique guards on `shots`.
--
-- Background:
--   POST /api/portal/shots/detect commits accepted shots with
--     .onConflictDoNothing({ target: [playerId, tournamentId, round, holeNumber, shotNumber] })
--   (and the analogous general-play target). PostgreSQL only matches an
--   ON CONFLICT target against a NON-partial unique constraint covering
--   exactly those columns. Migration 0059 (`canonicalize_fk_names`)
--   intentionally dropped the older PARTIAL-WHERE copies of these
--   indexes (originally introduced by migration 0027 with
--   `WHERE player_id IS NOT NULL AND tournament_id IS NOT NULL` /
--   `WHERE user_id IS NOT NULL AND general_play_round_id IS NOT NULL`),
--   leaving the route's commit branch with nothing to land on: every
--   commit raises "there is no unique or exclusion constraint matching
--   the ON CONFLICT specification" and HTTP 500s. Without the
--   constraint a retried commit could also insert duplicate shots.
--
--   The drizzle schema (`lib/db/src/schema/golf.ts`, `shotsTable`) now
--   declares both indexes; this migration recreates them on existing
--   databases so the schema diff stays clean and the route works in
--   production.
--
-- We DROP first and then CREATE (rather than `CREATE ... IF NOT EXISTS`)
-- because some environments may still carry the older PARTIAL versions
-- of these indexes under the same names — e.g. if 0059 was applied
-- partially or skipped on a particular DB. A bare `CREATE ... IF NOT
-- EXISTS` would silently no-op there and leave ON CONFLICT broken; the
-- explicit DROP guarantees we end with the non-partial form regardless
-- of upgrade history.

-- post-merge-guard: fresh-DB guard (column:shots.user_id)
-- The `shots.user_id` and `shots.player_id` columns are added by the
-- 0116 baseline catch-up migration. On a fresh DB the guard skips this
-- file so post-merge.sh can run with ON_ERROR_STOP=1; the catch-up
-- recreates these indexes through the schema sync.
SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'shots'
    AND column_name = 'user_id'
) AS post_merge_dep_present \gset
\if :post_merge_dep_present

BEGIN;

DROP INDEX IF EXISTS shots_player_tournament_round_hole_shot_unique;
DROP INDEX IF EXISTS shots_user_gp_round_hole_shot_unique;

CREATE UNIQUE INDEX shots_player_tournament_round_hole_shot_unique
  ON shots (player_id, tournament_id, round, hole_number, shot_number);

CREATE UNIQUE INDEX shots_user_gp_round_hole_shot_unique
  ON shots (user_id, general_play_round_id, round, hole_number, shot_number);

COMMIT;

\else
\echo 'parent column shots.user_id not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif
