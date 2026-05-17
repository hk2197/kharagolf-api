-- Task #1170 — Per-notification-key delivery preference.
--
-- Lets a player pick whether each digestable notification key is sent in
-- real-time or batched into the daily digest, overriding the global
-- `digest_mode` flag in `user_notification_prefs` for that key only.
-- Absence of a row means "fall back to the user's global digest_mode".
--
-- Only digestable keys (per `notification_type_registry.digestable`)
-- ever produce rows here — non-digestable keys always send immediately
-- regardless of any pref, so the dispatcher never reads this table for
-- them.
CREATE TABLE IF NOT EXISTS "user_notification_key_prefs" (
  "user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "notification_key" text NOT NULL,
  "delivery_mode" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_notification_key_prefs_pkey" PRIMARY KEY ("user_id", "notification_key"),
  CONSTRAINT "user_notification_key_prefs_delivery_mode_chk"
    CHECK ("delivery_mode" IN ('realtime', 'digest'))
);

CREATE INDEX IF NOT EXISTS "user_notification_key_prefs_user_idx"
  ON "user_notification_key_prefs" ("user_id");
