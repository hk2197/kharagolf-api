-- Task #640 — Restore the FK constraints on `broadcast_overlay_state_templates`
-- whose names were silently truncated by Postgres's 63-char identifier limit.
--
-- Migration 0058 created three FKs using drizzle's default 4-arg names:
--   broadcast_overlay_state_templates_tournament_id_tournaments_id_fk      (66 chars)
--   broadcast_overlay_state_templates_organization_id_organizations_id_fk  (69 chars)
--   broadcast_overlay_state_templates_created_by_user_id_app_users_id_fk   (68 chars)
-- All three exceeded Postgres's 63-char `NAMEDATALEN-1` limit and were
-- silently truncated when applied to the live test DB (e.g.
-- `broadcast_overlay_state_templates_tournament_id_tournaments_id_`).
-- Drizzle still expects the full names in the schema, so every drift
-- check re-emitted paired DROP/ADD CONSTRAINT statements for them.
--
-- The schema file (`lib/db/src/schema/golf.ts`) has been updated to
-- give these three FKs explicit short names that fit within 63 chars,
-- matching the pattern established in migration 0059. This migration
-- renames the truncated constraints to the new canonical names so the
-- live DB stops drifting.
--
-- If a database somehow has both the truncated and the canonical name
-- (e.g. a partial earlier sync), the truncated one is dropped instead
-- of renamed. If neither exists, the FK is created from scratch.
--
-- Wrapped in a single PL/pgSQL block so it is idempotent and safe under
-- `ON_ERROR_STOP=0` re-runs from `scripts/post-merge.sh`.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('broadcast_overlay_state_templates',
        'tournament_id',
        'tournaments',
        'id',
        'CASCADE',
        'broadcast_overlay_state_templates_tournament_id_tournaments_id_',
        'broadcast_overlay_state_templates_tournament_id_fk'),
      ('broadcast_overlay_state_templates',
        'organization_id',
        'organizations',
        'id',
        'CASCADE',
        'broadcast_overlay_state_templates_organization_id_organizations',
        'broadcast_overlay_state_templates_organization_id_fk'),
      ('broadcast_overlay_state_templates',
        'created_by_user_id',
        'app_users',
        'id',
        'SET NULL',
        'broadcast_overlay_state_templates_created_by_user_id_app_users_',
        'broadcast_overlay_state_templates_created_by_user_id_fk')
    ) AS t(table_name, col_name, ref_table, ref_col, on_delete, old_name, new_name)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = rec.old_name) THEN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = rec.new_name) THEN
        EXECUTE format(
          'ALTER TABLE %I DROP CONSTRAINT %I',
          rec.table_name, rec.old_name
        );
      ELSE
        EXECUTE format(
          'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
          rec.table_name, rec.old_name, rec.new_name
        );
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = rec.new_name) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(%I) ON DELETE %s',
        rec.table_name, rec.new_name, rec.col_name,
        rec.ref_table, rec.ref_col, rec.on_delete
      );
    END IF;
  END LOOP;
END$$;
