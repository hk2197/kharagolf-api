-- Task #2219 — Rate-limit watermark table for the per-digest "you just muted
-- this from the portal" confirmation emails. Task #1776 introduced the
-- safety-net pattern for the stuck-erasure digest only, with its watermark
-- on `user_notification_prefs`
-- (`notify_erasure_storage_digest_mute_confirmation_last_sent_at`).
-- Extending the same pattern to the wallet-refund / side-game-receipt /
-- levy-ledger / levy-reminders / exhaustion-admin / silent-alerts digests
-- would otherwise mean adding 6+ near-identical watermark columns. This
-- side table keyed on (user_id, digest_slug) lets future digests join the
-- registry without another schema migration. The existing erasure column
-- stays where it is — it's already in production and there's no upside to
-- migrating it across.
--
-- Rows are inserted only AFTER a successful confirmation send, so a
-- transient mailer outage doesn't poison the next genuine attempt. The
-- portal handler reads `last_sent_at` and suppresses the re-send when
-- (now - last_sent_at) is below the throttle window (default 5 minutes,
-- mirroring `ERASURE_DIGEST_MUTE_CONFIRMATION_THROTTLE_MS`).
--
-- ON DELETE CASCADE on `user_id` so the row is reaped when the user is
-- deleted via the auto-erasure cron — the watermark is meaningless once
-- the recipient is gone. Wrapped in IF NOT EXISTS so reruns and fresh DB
-- bootstraps both succeed.
CREATE TABLE IF NOT EXISTS "portal_digest_mute_confirmation_sends" (
  "user_id" integer NOT NULL,
  "digest_slug" text NOT NULL,
  "last_sent_at" timestamptz NOT NULL,
  CONSTRAINT "portal_digest_mute_confirmation_sends_pkey" PRIMARY KEY ("user_id", "digest_slug"),
  CONSTRAINT "portal_digest_mute_confirmation_sends_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE CASCADE
);
