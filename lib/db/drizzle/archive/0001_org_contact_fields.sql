ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "contact_email" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "contact_phone" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "address" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "website" text;--> statement-breakpoint
UPDATE "organizations" SET "logo_url" = '/logo.png' WHERE "id" = 1 AND ("logo_url" IS NULL OR "logo_url" = '');
