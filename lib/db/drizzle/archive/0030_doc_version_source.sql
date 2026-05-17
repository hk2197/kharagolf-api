-- Task 200: Distinguish restore-snapshot rows from member-replace rows in
-- member_document_versions, so admins can see who restored a document and when.
--
-- Wrapped in a DO block so it is a no-op on environments where the upstream
-- member_documents / member_document_versions tables have not yet been
-- materialised by drizzle push (the schema definitions add the new columns
-- with the same defaults, so a fresh push produces an equivalent result).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_document_versions') THEN
    ALTER TABLE member_document_versions
      ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'replace';
    ALTER TABLE member_document_versions
      ADD COLUMN IF NOT EXISTS restored_from_version_id INTEGER;
  END IF;
END $$;
