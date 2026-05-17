-- Task #1298 — "Honor Do-Not-Track / Apple Mail Privacy Protection signals
-- on the open pixel".
--
-- The Task #1124 open-pixel handler stamps `expiring_reminder_email_opened_at`
-- every time the GIF is fetched. Apple Mail Privacy Protection (AMPP),
-- GoogleImageProxy, YahooMailProxy and similar privacy-protecting mail
-- proxies eagerly prefetch every <img> in inbound mail from a relay IP
-- *without the recipient ever opening the email*, which inflates the
-- controller dashboard's open rate and can mislead admins about how
-- effective the reminder really is.
--
-- We add a separate `expiring_reminder_email_prefetched_at` column so the
-- pixel handler can stamp likely-prefetch fetches into a parallel column
-- (rather than dropping the signal entirely). The dashboard widget
-- excludes prefetches by default and exposes an admin toggle to fold
-- them back in for audit/debugging.
ALTER TABLE "member_data_requests"
  ADD COLUMN IF NOT EXISTS "expiring_reminder_email_prefetched_at" timestamptz;
