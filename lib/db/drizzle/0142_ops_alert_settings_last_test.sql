-- Task #1916 — record when the last "Send test alert" was fired so the
-- super-admin Ops Alert card can display "Last test sent <relative time>
-- ago to N recipient(s)" beside the button.
--
-- Background: Task #1547 added the "Send test alert" button that posts
-- to /super-admin/ops-alert-settings/test, but the dashboard immediately
-- forgets the test ever happened. After a reload there's no way to tell
-- whether anyone has tested delivery this week, so admins re-test "just
-- in case" and the on-call inbox fills with duplicate test emails.
--
-- All three columns are nullable: NULL means "no test has ever been
-- recorded on this row", which preserves the historical behaviour for
-- existing environments and lets the UI render "No test has been sent
-- yet" until the first stamp lands.
--
-- IF NOT EXISTS / DROP CONSTRAINT IF EXISTS gates so reruns and fresh
-- DB bootstraps both succeed.

ALTER TABLE "ops_alert_settings"
  ADD COLUMN IF NOT EXISTS "last_test_sent_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_test_sent_by_user_id" integer,
  ADD COLUMN IF NOT EXISTS "last_test_recipient_count" integer;

ALTER TABLE "ops_alert_settings"
  DROP CONSTRAINT IF EXISTS "ops_alert_settings_last_test_sent_by_user_id_app_users_id_fk";
ALTER TABLE "ops_alert_settings"
  ADD CONSTRAINT "ops_alert_settings_last_test_sent_by_user_id_app_users_id_fk"
  FOREIGN KEY ("last_test_sent_by_user_id") REFERENCES "app_users" ("id") ON DELETE SET NULL;

ALTER TABLE "ops_alert_settings"
  DROP CONSTRAINT IF EXISTS "ops_alert_settings_last_test_recipient_count_chk";
ALTER TABLE "ops_alert_settings"
  ADD CONSTRAINT "ops_alert_settings_last_test_recipient_count_chk"
  CHECK ("last_test_recipient_count" IS NULL OR "last_test_recipient_count" >= 0);
