-- Task #513 — audit trail of schedule-change emails dispatched to admins.
-- One row per successful send; recipients snapshotted as JSONB so the
-- club-settings UI can show "last sent at … to N people" and survive
-- profile/email changes after the fact. The per-org throttle and the
-- "no recipients" path skip the insert, so re-saves do not double-count.

CREATE TABLE IF NOT EXISTS "bounced_digest_schedule_sends" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "sent_at" timestamp with time zone NOT NULL DEFAULT now(),
  "changed_by_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "recipients" jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS "bounced_digest_schedule_sends_org_sent_idx"
  ON "bounced_digest_schedule_sends" ("organization_id", "sent_at");
