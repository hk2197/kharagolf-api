-- Task #570 — Stop the FK / UNIQUE rename churn that bloats every schema sync.
--
-- Two related kinds of historical drift accumulated in the live DB and
-- caused `pnpm sync` to re-emit ~1100 paired DROP/ADD CONSTRAINT
-- statements on every introspect:
--
--  1. Foreign keys originally created without an explicit constraint
--     name received drizzle's default 4-argument name
--     (`<table>_<col>_<reftable>_<refcol>_fk`). For long table/column
--     names that exceeded the 63-char identifier limit and was
--     silently truncated, e.g.
--       member_account_charges_pos_transaction_id_pos_transactions_id_f
--     The schema files have since been updated to give each of these
--     FKs an explicit short name (e.g.
--     `member_account_charges_pos_transaction_id_fk`), but several
--     databases ended up with BOTH the legacy truncated constraint AND
--     the new canonical one (drizzle's pushSchema added the canonical
--     one without removing the legacy one).
--
--  2. Several other tables retained legacy short names
--     (`*_org_fk`, `*_user_fk`, `*_course_fk`, …) alongside drizzle's
--     newer 4-arg canonical names. Same situation: schema and live DB
--     each have one form, the diff churns paired DROP/ADD on every
--     sync.
--
-- This migration resolves the duplicates so the schema diff settles
-- to a true no-op:
--   * If the canonical name already exists, simply DROP the legacy one.
--   * Otherwise, RENAME the legacy constraint to the canonical name.
--
-- A small set of leftover indexes (older unique indexes / per-org
-- indexes that drizzle no longer emits because the schema now lists
-- them differently) are dropped at the end. They have no functional
-- replacement on the schema side; the schema files are the source of
-- truth.
--
-- Wrapped in a single PL/pgSQL block so it is idempotent and survives
-- `ON_ERROR_STOP=0` re-runs in `scripts/post-merge.sh`.
DO $$
DECLARE
  rec record;
BEGIN
  -- 1. FK rename / dedup pairs. Each row: (table_name, legacy_name,
  --    canonical_name).
  FOR rec IN
    SELECT * FROM (VALUES
      -- Truncated 4-arg names → explicit short names already declared
      -- in the schema.
      ('announcement_read_receipts',
        'announcement_read_receipts_announcement_id_tournament_announcem',
        'announcement_read_receipts_announcement_id_fk'),
      ('delivery_receipt_lines',
        'delivery_receipt_lines_purchase_order_line_id_purchase_order_li',
        'delivery_receipt_lines_purchase_order_line_id_fk'),
      ('member_account_charges',
        'member_account_charges_pos_transaction_id_pos_transactions_id_f',
        'member_account_charges_pos_transaction_id_fk'),
      ('member_account_charges',
        'member_account_charges_vendor_operator_id_vendor_operators_id_f',
        'member_account_charges_vendor_operator_id_fk'),
      ('staff_checkins',
        'staff_checkins_volunteer_assignment_id_volunteer_assignments_id',
        'staff_checkins_volunteer_assignment_id_fk'),
      ('store_credit_transactions',
        'store_credit_transactions_account_id_store_credit_accounts_id_f',
        'store_credit_transactions_account_id_fk'),
      -- Truncated 4-arg names → drizzle's canonical 4-arg names that
      -- now fit within 63 chars (different column referenced).
      ('delivery_receipt_lines',
        'delivery_receipt_lines_delivery_receipt_id_delivery_receipts_id',
        'delivery_receipt_lines_delivery_receipt_id_fk'),
      ('staff_checkins',
        'staff_checkins_caddie_assignment_id_caddie_event_assignments_id',
        'staff_checkins_caddie_assignment_id_fk'),
      -- Legacy short names → drizzle's canonical 4-arg names.
      ('course_review_reports',
        'course_review_reports_user_fk',
        'course_review_reports_reporter_user_id_app_users_id_fk'),
      ('course_review_reports',
        'course_review_reports_review_fk',
        'course_review_reports_review_id_course_reviews_id_fk'),
      ('course_reviews',
        'course_reviews_course_fk',
        'course_reviews_course_id_courses_id_fk'),
      ('course_reviews',
        'course_reviews_org_fk',
        'course_reviews_organization_id_organizations_id_fk'),
      ('course_reviews',
        'course_reviews_user_fk',
        'course_reviews_user_id_app_users_id_fk'),
      ('tee_dynamic_pricing_audit',
        'tee_dyn_pricing_audit_actor_fk',
        'tee_dynamic_pricing_audit_actor_user_id_app_users_id_fk'),
      ('tee_dynamic_pricing_audit',
        'tee_dyn_pricing_audit_org_fk',
        'tee_dynamic_pricing_audit_organization_id_organizations_id_fk'),
      ('tee_dynamic_pricing_config',
        'tee_dyn_pricing_config_org_fk',
        'tee_dynamic_pricing_config_organization_id_organizations_id_fk'),
      ('tee_dynamic_pricing_modifiers',
        'tee_dyn_pricing_mods_course_fk',
        'tee_dynamic_pricing_modifiers_course_id_courses_id_fk'),
      ('tee_dynamic_pricing_modifiers',
        'tee_dyn_pricing_mods_org_fk',
        'tee_dynamic_pricing_modifiers_organization_id_fk'),
      ('tee_dynamic_pricing_tiers',
        'tee_dyn_pricing_tiers_course_fk',
        'tee_dynamic_pricing_tiers_course_id_courses_id_fk'),
      ('tee_dynamic_pricing_tiers',
        'tee_dyn_pricing_tiers_org_fk',
        'tee_dynamic_pricing_tiers_organization_id_organizations_id_fk')
    ) AS t(table_name, old_name, new_name)
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
    END IF;
  END LOOP;

  -- 2. Drop leftover indexes the schema no longer declares. These
  --    were either renamed in the schema files or replaced by
  --    differently-keyed unique indexes; the live DB still carries
  --    the older copies and drizzle wants them removed on every diff.
  FOR rec IN
    SELECT unnest(ARRAY[
      'tournament_staff_unique',
      'league_staff_unique',
      'locker_audit_org_idx',
      'locker_assignments_org_idx',
      'tee_schedule_templates_org_course_idx',
      'member_levy_charge_events_reverses_idx',
      'uq_round_submissions_marker_share_token',
      'shots_player_tournament_round_hole_shot_unique',
      'shots_user_gp_round_hole_shot_unique'
    ]) AS index_name
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', rec.index_name);
  END LOOP;
END$$;
