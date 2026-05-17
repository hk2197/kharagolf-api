-- Task #1855 — Per-recipient durable record of every send the daily
-- exhaustion admin digest (`sendNotifyExhaustionAdminDigest` in
-- `lib/cron.ts`) attempts. Solves the silent-bounce problem reported
-- against Task #1507: previously a `logger.warn` was the only trace
-- when an admin inbox bounced, so a fully bouncing recipient list
-- looked identical to a healthy one in the dashboard.
--
-- One row per (org, recipient_email, run) capturing whether the send
-- went out (`sent`), threw at the mailer (`failed`), was pre-empted
-- because the address is already on `email_suppressions`
-- (`paused_suppressed`), or could not be attempted at all because the
-- org has no admin recipients with an email address (`no_recipients`,
-- recipient_email = "").
--
-- Wraps three indexes:
--   * `(organization_id, created_at)` — admin-side per-org history.
--   * `(recipient_email, created_at)` — "who is bouncing me?" lookups.
--   * `(status)` — health dashboards filtering on failed/paused.
--
-- The `recipient_user_id` FK is `set null` so a deleted admin user does
-- not cascade-wipe the historical send trail (mirrors how
-- `manual_entry_alert_recipients` and `silent_alerts_digest` audit
-- trails treat user deletion).

CREATE TABLE IF NOT EXISTS "notify_exhaustion_admin_digest_recipient_sends" (
  "id"                  serial PRIMARY KEY NOT NULL,
  "organization_id"     integer NOT NULL,
  "recipient_user_id"   integer,
  "recipient_email"     text NOT NULL,
  "status"              text NOT NULL,
  "error_message"       text,
  "error_class"         text,
  "bounce_type"         text,
  "suppression_reason"  text,
  "wallet_item_count"   integer NOT NULL DEFAULT 0,
  "coach_item_count"    integer NOT NULL DEFAULT 0,
  "run_started_at"      timestamp with time zone NOT NULL,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "notify_exhaustion_admin_digest_recipient_sends"
    ADD CONSTRAINT "notify_exh_admin_digest_recip_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "notify_exhaustion_admin_digest_recipient_sends"
    ADD CONSTRAINT "notify_exh_admin_digest_recip_user_fk"
    FOREIGN KEY ("recipient_user_id") REFERENCES "public"."app_users"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "notify_exh_admin_digest_recip_org_created_idx"
  ON "notify_exhaustion_admin_digest_recipient_sends" USING btree ("organization_id","created_at");

CREATE INDEX IF NOT EXISTS "notify_exh_admin_digest_recip_email_created_idx"
  ON "notify_exhaustion_admin_digest_recipient_sends" USING btree ("recipient_email","created_at");

CREATE INDEX IF NOT EXISTS "notify_exh_admin_digest_recip_status_idx"
  ON "notify_exhaustion_admin_digest_recipient_sends" USING btree ("status");

-- Task #1855 — per-user opt-out for the new super-admin fallback alert
-- (`notify.exhaustion.admin_digest.failed`). Defaults to true so every
-- super_admin keeps receiving the alert unless they explicitly opt
-- out, mirroring `notifySilentAlertsDigest` (Task #1663).
ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_exhaustion_admin_digest_failed" boolean NOT NULL DEFAULT true;
