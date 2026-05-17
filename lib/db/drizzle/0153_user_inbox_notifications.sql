-- Task #2159 — Generic per-user in-app notification inbox.
--
-- Until now, the only durable in-app notification stream the web/mobile
-- portal surfaced was `handicap_case_notifications`, which is tightly
-- coupled to a committee review case (case_id / organization_id NOT
-- NULL). Other notifications such as `social.follow.new` only had a
-- push or email path — web users who don't have push enabled missed
-- them entirely once the toast was gone.
--
-- This table is the generic alternative: a per-user inbox row keyed by
-- the registry `notification_key` (e.g. `social.follow.new`), with the
-- title/body that was dispatched and a free-form `payload` for any
-- per-event metadata (followerId, deepLink, etc.). The notifications
-- inbox page reads from BOTH this table AND `handicap_case_notifications`,
-- merged by `created_at` desc, so the player sees a single feed.
--
-- IF NOT EXISTS so reruns and fresh DB bootstraps both succeed.

CREATE TABLE IF NOT EXISTS "user_inbox_notifications" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "notification_key" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "payload" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "read_at" timestamp with time zone,
  CONSTRAINT "user_inbox_notifications_user_id_app_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "app_users"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "user_inbox_notif_user_idx"
  ON "user_inbox_notifications" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "user_inbox_notif_unread_idx"
  ON "user_inbox_notifications" ("user_id", "read_at");
