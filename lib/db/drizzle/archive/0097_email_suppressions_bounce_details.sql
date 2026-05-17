-- Task #1138 — surface bounce details in the Suppressions admin tab.
-- The Postmark webhook now persists the bounce sub-type (e.g. "HardBounce",
-- "BadMailbox", "Blocked"), the Postmark MessageID of the original send,
-- and a short human-readable description alongside each suppression so
-- admins can decide whether to manually re-enable a recipient or chase
-- down a typo.  All three columns are nullable: existing rows and manual
-- additions stay valid, and only Postmark-sourced suppressions populate
-- them.
ALTER TABLE "email_suppressions"
  ADD COLUMN IF NOT EXISTS "bounce_type" text;
ALTER TABLE "email_suppressions"
  ADD COLUMN IF NOT EXISTS "message_id" text;
ALTER TABLE "email_suppressions"
  ADD COLUMN IF NOT EXISTS "description" text;
