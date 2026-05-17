ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "default_language" text NOT NULL DEFAULT 'en';
ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "preferred_language" text NOT NULL DEFAULT 'en';
