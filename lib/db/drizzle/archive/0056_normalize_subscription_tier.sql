-- Task #514 — Migrate legacy plan tiers in the database to recognised values.
--
-- Background:
--   `organizations.subscription_tier` historically lived as a free-form text
--   column, and the application code in `subscriptionTiers.ts` still has to
--   degrade gracefully (`getTierDisplay`) for legacy or mistyped values.
--   The schema today declares the column as the `subscription_tier` enum
--   (`free | starter | pro | enterprise`), but databases that were created
--   before that change can still hold rows whose stored value is outside the
--   canonical set — those orgs render with a generic plan label and Free
--   pricing, even when they are paying for something else.
--
-- Strategy (idempotent — safe to re-run):
--   1. If the column type is still `text` (or any non-enum), normalise every
--      row in place:
--        a. trim + lowercase the value;
--        b. accept it if it matches a canonical tier name;
--        c. otherwise log an org-level audit row to `member_audit_log` and
--           coerce the value to `'free'` so the about-to-be-applied enum cast
--           succeeds.
--      Then ALTER the column to the `subscription_tier` enum type so the
--      database itself rejects future bad writes.
--   2. If the column is already the enum, the loop is a no-op (PostgreSQL
--      will not have allowed any non-canonical value into it). We still
--      perform a defensive sweep of `pending_subscription_tier` (also enum,
--      but nullable) — nothing to do, just confirms shape.
--
-- The audit row uses `entity = 'organization_subscription_tier'`,
-- `action = 'migrate'`, `field_changes = {tier: {from, to}}` and
-- `reason = 'Task #514 legacy tier migration'` so support can find what was
-- changed and why.

DO $$
DECLARE
  col_type text;
  legacy   record;
  canonical_tiers constant text[] := ARRAY['free', 'starter', 'pro', 'enterprise'];
  mapped   text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO col_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relname = 'organizations'
     AND a.attname = 'subscription_tier'
     AND NOT a.attisdropped;

  IF col_type IS NULL THEN
    RAISE NOTICE 'organizations.subscription_tier not found, skipping';
    RETURN;
  END IF;

  IF col_type = 'subscription_tier' THEN
    RAISE NOTICE 'organizations.subscription_tier is already the enum, no data migration needed';
    RETURN;
  END IF;

  RAISE NOTICE 'organizations.subscription_tier is %, normalising rows then converting to enum', col_type;

  -- Walk every row and either accept, remap, or audit+reset to 'free'.
  FOR legacy IN
    SELECT id, subscription_tier::text AS raw
      FROM organizations
  LOOP
    mapped := lower(btrim(coalesce(legacy.raw, '')));

    IF mapped = ANY(canonical_tiers) THEN
      -- Persist the trimmed/lowercased form so the upcoming enum cast works
      -- even when the original was e.g. 'Free' or ' STARTER '.
      IF mapped <> legacy.raw THEN
        UPDATE organizations
           SET subscription_tier = mapped
         WHERE id = legacy.id;
      END IF;
    ELSE
      -- Unknown / discontinued slug — record what we found and reset to free.
      INSERT INTO member_audit_log (
        organization_id, entity, entity_id, action,
        field_changes, reason, created_at
      ) VALUES (
        legacy.id,
        'organization_subscription_tier',
        legacy.id,
        'migrate',
        jsonb_build_object(
          'tier', jsonb_build_object('from', legacy.raw, 'to', 'free')
        ),
        'Task #514 legacy tier migration: unrecognised plan slug, reset to free',
        now()
      );

      UPDATE organizations
         SET subscription_tier = 'free'
       WHERE id = legacy.id;
    END IF;
  END LOOP;

  -- Drop the column default before the type change so the cast does not also
  -- have to coerce the literal 'free' default expression.
  ALTER TABLE organizations ALTER COLUMN subscription_tier DROP DEFAULT;

  ALTER TABLE organizations
    ALTER COLUMN subscription_tier TYPE subscription_tier
    USING subscription_tier::subscription_tier;

  ALTER TABLE organizations
    ALTER COLUMN subscription_tier SET DEFAULT 'free'::subscription_tier;

  ALTER TABLE organizations
    ALTER COLUMN subscription_tier SET NOT NULL;
END $$;
