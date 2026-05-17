-- Task 274: per-org scheduling preferences for the bounced-levy reminders
-- email digest. The cron now polls hourly, but only emails an org when its
-- chosen frequency (daily/weekday/weekly), local hour and timezone all match.
-- NULL hour/timezone preserves the legacy "fire on first cron tick of the
-- UTC day" behaviour for orgs that never opened the settings page.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS bounced_digest_frequency text NOT NULL DEFAULT 'daily',
  ADD COLUMN IF NOT EXISTS bounced_digest_hour_local integer,
  ADD COLUMN IF NOT EXISTS bounced_digest_timezone text,
  ADD COLUMN IF NOT EXISTS bounced_digest_last_sent_on text;
