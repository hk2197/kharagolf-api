-- Task #666 — Marketing-site logo + favicon overrides.
-- Admins can upload a marketing-specific logo (shown in the public site
-- header in place of the generic org logo) and favicon (injected as
-- link rel="icon"). NULL on either column means "fall back to the org
-- logo / platform default favicon".
ALTER TABLE "club_marketing_sites"
  ADD COLUMN IF NOT EXISTS "logo_image_url" text,
  ADD COLUMN IF NOT EXISTS "favicon_url" text;
