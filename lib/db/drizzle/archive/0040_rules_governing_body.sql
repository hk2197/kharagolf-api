-- Task #362 — per-club Rules Assistant variant + local rules content.
DO $$ BEGIN
  CREATE TYPE "rules_governing_body" AS ENUM ('rna', 'usga');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "rules_governing_body" "rules_governing_body" NOT NULL DEFAULT 'rna';

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "local_rules_content" text;
