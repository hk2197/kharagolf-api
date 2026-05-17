-- Task #1845 — persist a per-attempt audit row for the consent-style
-- email a member receives when an admin overrides one of their
-- notification preferences (`notifyMemberOfAdminCommPrefOverride`,
-- originally added by Task #1504), and back the new
-- `retryFailedAdminCommPrefOverrideEmail` cron sweep so a transient
-- SMTP / Postmark hiccup no longer silently swallows the only timely
-- consent notice the affected member would have received.
--
-- Mirrors the per-attempt persistence + 5/10/20/40/80-min backoff
-- pattern shipped in Task #1280 for `coach_payout_account_change_notify_attempts`,
-- but email-only — the in-app inbox row written by the same helper
-- stays synchronous and has no retry leg today (see follow-up #2313
-- for revisiting the inbox-side gap).
--
-- We snapshot enough of the change context (org, target user, admin,
-- prefKey, prefLabel, prev / new value, reason, changedAt) on the
-- attempts row so the retry helper can re-fire the email faithfully
-- even if the underlying `user_notification_prefs` row is re-toggled
-- between original send and retry — the snapshot is what protects the
-- member from receiving a misleading "your X was changed to Y" notice
-- in that race.
--
-- IF NOT EXISTS so reruns and fresh DB bootstraps both succeed.

CREATE TABLE IF NOT EXISTS "admin_comm_pref_override_notify_attempts" (
  "id"                          serial PRIMARY KEY NOT NULL,
  "organization_id"             integer NOT NULL,
  "target_user_id"              integer NOT NULL,
  "admin_user_id"               integer NOT NULL,
  "pref_key"                    text NOT NULL,
  "pref_label"                  text NOT NULL,
  "previous_value"              boolean NOT NULL,
  "new_value"                   boolean NOT NULL,
  "reason"                      text,
  "changed_at"                  timestamp with time zone NOT NULL,
  "created_at"                  timestamp with time zone DEFAULT now() NOT NULL,
  "email_status"                text,
  "email_attempts"              integer DEFAULT 0 NOT NULL,
  "last_email_at"               timestamp with time zone,
  "last_email_error"            text,
  "last_email_retry_at"         timestamp with time zone,
  "next_email_retry_at"         timestamp with time zone,
  "email_retry_exhausted_at"    timestamp with time zone
);

DO $$ BEGIN
  ALTER TABLE "admin_comm_pref_override_notify_attempts"
    ADD CONSTRAINT "admin_comm_pref_override_notify_attempts_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Hot-path index used by `retryFailedAdminCommPrefOverrideEmail` to
-- pick up failed-and-not-yet-exhausted rows on each 5-minute sweep.
CREATE INDEX IF NOT EXISTS "admin_comm_pref_override_notify_attempts_email_failed_idx"
  ON "admin_comm_pref_override_notify_attempts" USING btree ("email_status","email_attempts");

-- Member-history lookups (e.g. surfacing recent admin-driven pref
-- changes on the member detail screen — see follow-up #2312).
CREATE INDEX IF NOT EXISTS "admin_comm_pref_override_notify_attempts_target_idx"
  ON "admin_comm_pref_override_notify_attempts" USING btree ("target_user_id");
