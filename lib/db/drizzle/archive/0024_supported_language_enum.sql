-- Create supported language enum type
DO $$ BEGIN
  CREATE TYPE "supported_language" AS ENUM (
    'en', 'hi', 'ar', 'es', 'fr', 'de', 'pt',
    'ja', 'ko', 'zh', 'th', 'ms', 'id', 'vi',
    'fil', 'sw', 'af', 'am', 'ha', 'zu', 'yo'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Migrate organizations.default_language from text to supported_language enum.
-- Wrapped in a DO block that checks the current column type so re-applying
-- against an already-migrated DB is a no-op (no error). The drop/set
-- DEFAULT pair is also gated so we do not churn the catalog on re-run.
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO col_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relname = 'organizations'
     AND a.attname = 'default_language'
     AND NOT a.attisdropped;

  IF col_type IS NOT NULL AND col_type <> 'supported_language' THEN
    ALTER TABLE "organizations"
      ALTER COLUMN "default_language" DROP DEFAULT;
    ALTER TABLE "organizations"
      ALTER COLUMN "default_language" TYPE "supported_language"
      USING "default_language"::"supported_language";
    ALTER TABLE "organizations"
      ALTER COLUMN "default_language" SET DEFAULT 'en';
  END IF;
END $$;

-- Migrate app_users.preferred_language from text to supported_language enum
-- (same idempotency guard as above).
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO col_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relname = 'app_users'
     AND a.attname = 'preferred_language'
     AND NOT a.attisdropped;

  IF col_type IS NOT NULL AND col_type <> 'supported_language' THEN
    ALTER TABLE "app_users"
      ALTER COLUMN "preferred_language" DROP DEFAULT;
    ALTER TABLE "app_users"
      ALTER COLUMN "preferred_language" TYPE "supported_language"
      USING "preferred_language"::"supported_language";
    ALTER TABLE "app_users"
      ALTER COLUMN "preferred_language" SET DEFAULT 'en';
  END IF;
END $$;
