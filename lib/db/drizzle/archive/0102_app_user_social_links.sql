-- Task #1225 — "Let players unlink Apple or Google from their account".
--
-- Apple/Google sign-in already auto-links by verified email (see
-- routes/social-auth.ts), but until now there was no record of WHICH
-- providers attached to each user, so the portal had nothing to show on the
-- account screen and no surgical way to remove a stale Apple ID / Google
-- account from a player's KHARAGOLF account.
--
-- This migration introduces:
--   * `social_auth_provider` enum — currently {apple, google}.
--   * `app_user_social_links` — one row per (user, provider) recording the
--     provider's stable subject claim. The (provider, sub) pair is globally
--     unique so the same Apple ID / Google account cannot map to two users,
--     mirroring the lookup order in routes/social-auth.ts.
--
-- The route layer is responsible for refusing to delete the last login
-- method on a row (no password AND no other linked provider AND no Replit
-- OAuth identity) so unlinking can never leave a player permanently locked
-- out of their account.

DO $$ BEGIN
  CREATE TYPE "social_auth_provider" AS ENUM ('apple', 'google');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "app_user_social_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "provider" "social_auth_provider" NOT NULL,
  "provider_sub" text NOT NULL,
  "linked_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_used_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "app_user_social_links_provider_sub_uq"
  ON "app_user_social_links" ("provider", "provider_sub");

CREATE UNIQUE INDEX IF NOT EXISTS "app_user_social_links_user_provider_uq"
  ON "app_user_social_links" ("user_id", "provider");

CREATE INDEX IF NOT EXISTS "app_user_social_links_user_idx"
  ON "app_user_social_links" ("user_id");
