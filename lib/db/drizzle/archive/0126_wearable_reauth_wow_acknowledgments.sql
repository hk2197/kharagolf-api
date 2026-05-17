-- Task #1578 — Let admins acknowledge / snooze the week-over-week wearable
-- re-auth drift alert from the dashboard.
--
-- The drift tile already surfaces the cron evaluator's per-org watermark
-- (`organizations.wearable_reauth_wow_alert_last_sent_at`), but admins had
-- no way to clear or extend the badge from the UI. With this table, the
-- new POST /admin/wellness-reauth-wow-drift/acknowledge endpoint:
--   1. Bumps the watermark forward so `nextEligibleAt` (= watermark + 7d)
--      lands on `now + snoozeDays`, suppressing the next email.
--   2. Appends a row here capturing who clicked, with what duration, and
--      the watermark values before/after — so a postmortem can prove who
--      silenced the alert and when, even after the cron has stamped the
--      column again.
--
-- Append-only: there is no UPDATE / DELETE path. The dashboard reads the
-- most-recent row per org via the (organization_id, created_at DESC)
-- index to render the "Acknowledged by X on Y" line under the tile.

CREATE TABLE IF NOT EXISTS "wearable_reauth_wow_acknowledgments" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL,
  "acknowledged_by_user_id" integer,
  "acknowledged_by_name" text,
  "acknowledged_by_role" text,
  "snooze_days" integer NOT NULL,
  "prev_watermark" timestamp with time zone,
  "new_watermark" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "wearable_reauth_wow_acknowledgments"
    ADD CONSTRAINT "wearable_reauth_wow_ack_org_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "wearable_reauth_wow_acknowledgments"
    ADD CONSTRAINT "wearable_reauth_wow_ack_user_id_fk"
    FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "app_users"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "wearable_reauth_wow_ack_org_created_idx"
  ON "wearable_reauth_wow_acknowledgments" ("organization_id", "created_at");
