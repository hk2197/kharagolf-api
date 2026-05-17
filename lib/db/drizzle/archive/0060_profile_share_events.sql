-- Task #625 — Track how often members share their public profile.
-- Each row is a single share action (copy link, web share sheet, native
-- share sheet, or QR code open) emitted by the privacy/share UI on the
-- web portal and the mobile portal-privacy screen. The handle is captured
-- as a snapshot string so analytics survive a member later renaming or
-- releasing the handle. Counts are derived with COUNT(*) GROUP BY at read
-- time.

DO $$ BEGIN
  CREATE TYPE "profile_share_method" AS ENUM ('copy', 'web_share', 'native_share', 'qr_open');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "profile_share_events" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "handle" text NOT NULL,
  "method" "profile_share_method" NOT NULL,
  "source" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "profile_share_events_user_idx"
  ON "profile_share_events" ("user_id");

CREATE INDEX IF NOT EXISTS "profile_share_events_handle_idx"
  ON "profile_share_events" ("handle");

CREATE INDEX IF NOT EXISTS "profile_share_events_user_method_idx"
  ON "profile_share_events" ("user_id", "method");

CREATE INDEX IF NOT EXISTS "profile_share_events_created_idx"
  ON "profile_share_events" ("created_at");
