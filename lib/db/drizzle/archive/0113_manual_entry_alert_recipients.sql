-- Task #1386 — Per-recipient delivery audit for the manual-entry round
-- alert. The aggregate counts already on `manual_entry_alerts`
-- (`pushAttempted`, `pushSent`, `emailAttempted`, `emailSent`,
-- `recipientCount`) answer "did this alert reach anyone?", but they
-- can't answer "which TD specifically got nothing?". Without a
-- per-recipient row, ops can spot a tournament with a zero delivery
-- rate but cannot reach out to the silent recipient individually or
-- pinpoint a stale device token.
--
-- One row per (alert, user, channel) attempt closes the gap. Status
-- values are constrained to the canonical set the notify path emits:
--   "sent"       — channel call succeeded for this user.
--   "failed"     — channel call failed (transport error / bounce).
--                  `error_message` carries the surfaced reason.
--   "no_address" — push only: user has no registered Expo device tokens.
--   "no_email"   — email only: user row carries no email address.
--   "opted_out"  — user disabled this channel for the alert in their
--                  notification prefs (kept for audit completeness).


-- post-merge-guard: fresh-DB guard (table:manual_entry_alerts)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'manual_entry_alerts') AS post_merge_dep_present \gset
\if :post_merge_dep_present

CREATE TABLE IF NOT EXISTS "manual_entry_alert_recipients" (
  "id" serial PRIMARY KEY,
  "alert_id" integer NOT NULL,
  "user_id" integer,
  "channel" text NOT NULL,
  "status" text NOT NULL,
  "error_message" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- Short FK names because the auto-generated ones overflow Postgres's
  -- 63-char identifier limit (Task #805); the schema declares the same
  -- names via foreignKey({ name: ... }).
  CONSTRAINT "manual_entry_alert_recipients_alert_fk"
    FOREIGN KEY ("alert_id") REFERENCES "manual_entry_alerts" ("id") ON DELETE CASCADE,
  CONSTRAINT "manual_entry_alert_recipients_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "app_users" ("id") ON DELETE SET NULL,
  CONSTRAINT "manual_entry_alert_recipients_channel_chk"
    CHECK ("channel" IN ('push','email')),
  CONSTRAINT "manual_entry_alert_recipients_status_chk"
    CHECK ("status" IN ('sent','failed','no_address','no_email','opted_out'))
);

CREATE INDEX IF NOT EXISTS "manual_entry_alert_recipients_alert_idx"
  ON "manual_entry_alert_recipients" ("alert_id");
CREATE INDEX IF NOT EXISTS "manual_entry_alert_recipients_user_idx"
  ON "manual_entry_alert_recipients" ("user_id");

\else
\echo 'parent table manual_entry_alerts not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

