-- 0030 — Sync raw-SQL Member 360 schema with Drizzle (Task 355)
--
-- Many of the Member 360 tables (member_levies, member_levy_charges,
-- member_messages, member_profile_ext, member_documents, member_consents,
-- member_family_links, member_disciplinary, member_access_cards,
-- member_committee_roles) were created in earlier dev/CI runs by raw SQL and
-- ended up with Postgres-default `_fkey` foreign-key names instead of the
-- `_fk` names Drizzle generates. The member_account_charges table was also
-- missing the `vendor_operator_id` column + index + FK that Drizzle expects.
--
-- This migration realigns those tables so they exactly match the canonical
-- definitions in lib/db/src/schema/golf.ts. After applying this migration,
-- `pnpm --filter @workspace/db sync` reports an empty (no-op) diff.
--
-- It is written to be idempotent (CREATE INDEX IF NOT EXISTS, conditional
-- constraint renames, ADD CONSTRAINT only when missing) so it is safe to
-- run on environments that have already converged manually.

-- 1) Add the missing vendor_operator_id column on member_account_charges.
ALTER TABLE "member_account_charges"
  ADD COLUMN IF NOT EXISTS "vendor_operator_id" integer;

DO $$
BEGIN
  -- If a Postgres-default `_fkey` form already exists on this column,
  -- rename it to the Drizzle form (truncated by PG to 63 chars) instead
  -- of leaving the drift in place.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'member_account_charges'::regclass
      AND conname = 'member_account_charges_vendor_operator_id_fkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'member_account_charges'::regclass
      AND conname IN (
        'member_account_charges_vendor_operator_id_vendor_operators_id_f',
        'member_account_charges_vendor_operator_id_vendor_operators_id_fk'
      )
  ) THEN
    EXECUTE 'ALTER TABLE "member_account_charges"
      RENAME CONSTRAINT "member_account_charges_vendor_operator_id_fkey"
      TO "member_account_charges_vendor_operator_id_vendor_operators_id_fk"';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'member_account_charges'::regclass
      AND contype = 'f'
      AND conname IN (
        'member_account_charges_vendor_operator_id_vendor_operators_id_f',
        'member_account_charges_vendor_operator_id_vendor_operators_id_fk'
      )
  ) THEN
    EXECUTE 'ALTER TABLE "member_account_charges"
      ADD CONSTRAINT "member_account_charges_vendor_operator_id_vendor_operators_id_fk"
      FOREIGN KEY ("vendor_operator_id") REFERENCES "vendor_operators"("id") ON DELETE SET NULL';
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "member_account_charges_vendor_idx"
  ON "member_account_charges" ("vendor_operator_id");

-- 2) Rename Postgres-default `_fkey` constraints to Drizzle's `_fk` form so
--    drizzle-kit no longer sees them as drift on the next sync. The DO block
--    skips renames whose old name no longer exists (idempotency).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    -- to_regclass() returns NULL when the table doesn't exist, so this
    -- is also safe on environments that never had the raw-SQL table
    -- created (e.g. a fresh DB built only from the canonical schema).
    SELECT tbl, old_name, new_name FROM (VALUES
      ('member_access_cards'::text, 'member_access_cards_club_member_id_fkey'::text, 'member_access_cards_club_member_id_club_members_id_fk'::text),
      ('member_access_cards'::text, 'member_access_cards_issued_by_user_id_fkey'::text, 'member_access_cards_issued_by_user_id_app_users_id_fk'::text),
      ('member_access_cards'::text, 'member_access_cards_organization_id_fkey'::text, 'member_access_cards_organization_id_organizations_id_fk'::text),
      ('member_committee_roles'::text, 'member_committee_roles_club_member_id_fkey'::text, 'member_committee_roles_club_member_id_club_members_id_fk'::text),
      ('member_committee_roles'::text, 'member_committee_roles_organization_id_fkey'::text, 'member_committee_roles_organization_id_organizations_id_fk'::text),
      ('member_consents'::text, 'member_consents_club_member_id_fkey'::text, 'member_consents_club_member_id_club_members_id_fk'::text),
      ('member_consents'::text, 'member_consents_organization_id_fkey'::text, 'member_consents_organization_id_organizations_id_fk'::text),
      ('member_consents'::text, 'member_consents_recorded_by_user_id_fkey'::text, 'member_consents_recorded_by_user_id_app_users_id_fk'::text),
      ('member_disciplinary'::text, 'member_disciplinary_club_member_id_fkey'::text, 'member_disciplinary_club_member_id_club_members_id_fk'::text),
      ('member_disciplinary'::text, 'member_disciplinary_organization_id_fkey'::text, 'member_disciplinary_organization_id_organizations_id_fk'::text),
      ('member_disciplinary'::text, 'member_disciplinary_recorded_by_user_id_fkey'::text, 'member_disciplinary_recorded_by_user_id_app_users_id_fk'::text),
      ('member_documents'::text, 'member_documents_club_member_id_fkey'::text, 'member_documents_club_member_id_club_members_id_fk'::text),
      ('member_documents'::text, 'member_documents_organization_id_fkey'::text, 'member_documents_organization_id_organizations_id_fk'::text),
      ('member_documents'::text, 'member_documents_rejected_by_user_id_fkey'::text, 'member_documents_rejected_by_user_id_app_users_id_fk'::text),
      ('member_documents'::text, 'member_documents_uploaded_by_user_id_fkey'::text, 'member_documents_uploaded_by_user_id_app_users_id_fk'::text),
      ('member_documents'::text, 'member_documents_verified_by_user_id_fkey'::text, 'member_documents_verified_by_user_id_app_users_id_fk'::text),
      ('member_family_links'::text, 'member_family_links_created_by_user_id_fkey'::text, 'member_family_links_created_by_user_id_app_users_id_fk'::text),
      ('member_family_links'::text, 'member_family_links_linked_member_id_fkey'::text, 'member_family_links_linked_member_id_club_members_id_fk'::text),
      ('member_family_links'::text, 'member_family_links_organization_id_fkey'::text, 'member_family_links_organization_id_organizations_id_fk'::text),
      ('member_family_links'::text, 'member_family_links_primary_member_id_fkey'::text, 'member_family_links_primary_member_id_club_members_id_fk'::text),
      ('member_levies'::text, 'member_levies_applied_by_user_id_fkey'::text, 'member_levies_applied_by_user_id_app_users_id_fk'::text),
      ('member_levies'::text, 'member_levies_organization_id_fkey'::text, 'member_levies_organization_id_organizations_id_fk'::text),
      ('member_levy_charges'::text, 'member_levy_charges_club_member_id_fkey'::text, 'member_levy_charges_club_member_id_club_members_id_fk'::text),
      ('member_levy_charges'::text, 'member_levy_charges_levy_id_fkey'::text, 'member_levy_charges_levy_id_member_levies_id_fk'::text),
      ('member_messages'::text, 'member_messages_club_member_id_fkey'::text, 'member_messages_club_member_id_club_members_id_fk'::text),
      ('member_messages'::text, 'member_messages_organization_id_fkey'::text, 'member_messages_organization_id_organizations_id_fk'::text),
      ('member_messages'::text, 'member_messages_sender_user_id_fkey'::text, 'member_messages_sender_user_id_app_users_id_fk'::text),
      ('member_profile_ext'::text, 'member_profile_ext_club_member_id_fkey'::text, 'member_profile_ext_club_member_id_club_members_id_fk'::text),
      ('member_profile_ext'::text, 'member_profile_ext_kyc_verified_by_user_id_fkey'::text, 'member_profile_ext_kyc_verified_by_user_id_app_users_id_fk'::text),
      ('member_profile_ext'::text, 'member_profile_ext_organization_id_fkey'::text, 'member_profile_ext_organization_id_organizations_id_fk'::text)
    ) AS t(tbl, old_name, new_name)
  LOOP
    IF to_regclass(r.tbl) IS NULL THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = r.tbl::regclass
        AND conname = r.old_name
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = r.tbl::regclass
        AND conname = r.new_name
    ) THEN
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
                     r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END$$;
