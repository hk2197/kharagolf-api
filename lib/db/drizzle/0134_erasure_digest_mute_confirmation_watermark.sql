-- Task #1776 — Rate-limit watermark for the one-time confirmation email
-- sent when a controller mutes the stuck-erasure digest from the
-- in-portal toggle (PATCH /portal/notification-preferences). The PATCH
-- handler stamps this column AFTER a confirmation send actually succeeds;
-- a re-send is suppressed when (now - watermark) is below the throttle
-- window so a quick toggle off → on → off doesn't spam the controller's
-- inbox.
--
-- Nullable (no default) so a fresh row reads as "never sent" and the
-- first mute always emits a confirmation. Wrapped in IF NOT EXISTS so
-- reruns and fresh DB bootstraps both succeed.
ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_erasure_storage_digest_mute_confirmation_last_sent_at" timestamptz;
