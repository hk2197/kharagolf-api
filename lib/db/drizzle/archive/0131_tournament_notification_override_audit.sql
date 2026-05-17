-- Task #1674 — Audit trail for the org-wide bulk-apply of notification
-- defaults onto individual tournaments. Each row captures a single
-- tournament whose stored value was actually flipped by a club admin
-- pressing the "Apply to all tournaments" button on club-settings.
-- The tournament-detail page reads the latest unacknowledged row for
-- the current tournament + setting and surfaces a one-line
-- "Your manual-entry alert preference was overridden by a club admin
-- on <date>" notice with a one-click "restore my preference" action.
--
-- `setting` deliberately stores the canonical column name on
-- `tournaments` (currently only 'notify_manual_entry_alerts') so the
-- next bulk-apply column can reuse this trail without another
-- migration. `previous_value` is what the row held immediately before
-- the bulk-apply (the value the affected director would want to
-- restore to). `acknowledged_at` marks the notice as resolved (either
-- via dismiss or restore); `restored_at` is set only when the director
-- actually clicked "restore my preference" so audits can distinguish
-- the two outcomes.
--
-- Backfill: history-starts-here. Pre-#1674 bulk-applies left no audit
-- record at all and we do not have the data to reconstruct them.

-- FK names are kept short (the auto-generated names exceed Postgres's
-- 63-char identifier limit; see task #805). The "tnoa_" prefix stands
-- for tournament_notification_override_audit.
CREATE TABLE IF NOT EXISTS "tournament_notification_override_audit" (
  "id" serial PRIMARY KEY,
  "tournament_id" integer NOT NULL,
  "organization_id" integer NOT NULL,
  "setting" text NOT NULL,
  "previous_value" boolean NOT NULL,
  "applied_value" boolean NOT NULL,
  "applied_by_user_id" integer,
  "acknowledged_at" timestamp with time zone,
  "restored_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "tnoa_tournament_id_fk" FOREIGN KEY ("tournament_id")
    REFERENCES "tournaments"("id") ON DELETE CASCADE,
  CONSTRAINT "tnoa_organization_id_fk" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "tnoa_applied_by_user_id_fk" FOREIGN KEY ("applied_by_user_id")
    REFERENCES "app_users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "tournament_notif_override_audit_open_idx"
  ON "tournament_notification_override_audit" ("tournament_id", "setting")
  WHERE "acknowledged_at" IS NULL;

CREATE INDEX IF NOT EXISTS "tournament_notif_override_audit_org_idx"
  ON "tournament_notification_override_audit" ("organization_id", "created_at");
