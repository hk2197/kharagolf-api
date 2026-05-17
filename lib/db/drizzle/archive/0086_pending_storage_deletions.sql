-- Task #973 — retry queue for object-storage deletions that failed during the
-- account-erasure cron. Each row is one orphan file the worker still needs to
-- remove from the bucket. Rows are deleted on success; on failure attempts is
-- bumped and next_attempt_at is rescheduled with exponential backoff.
CREATE TABLE IF NOT EXISTS "pending_storage_deletions" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "club_member_id" integer,
  "source_audit_id" integer,
  CONSTRAINT "pending_storage_deletions_audit_fk" FOREIGN KEY ("source_audit_id") REFERENCES "member_audit_log"("id") ON DELETE SET NULL,
  "path" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_attempt_at" timestamptz,
  "last_error" text,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "pending_storage_deletions_next_attempt_idx"
  ON "pending_storage_deletions" ("next_attempt_at");
CREATE INDEX IF NOT EXISTS "pending_storage_deletions_org_idx"
  ON "pending_storage_deletions" ("organization_id");
CREATE INDEX IF NOT EXISTS "pending_storage_deletions_member_idx"
  ON "pending_storage_deletions" ("club_member_id");
