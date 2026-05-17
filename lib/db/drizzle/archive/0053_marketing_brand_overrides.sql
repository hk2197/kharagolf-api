-- Task #584 — Per-site brand overrides on top of marketing-site themes.
-- Admins can override the primary color, accent color, and heading font
-- without abandoning their chosen theme. NULL = "use the theme default".
ALTER TABLE "club_marketing_sites"
  ADD COLUMN IF NOT EXISTS "brand_primary_color" text,
  ADD COLUMN IF NOT EXISTS "brand_accent_color" text,
  ADD COLUMN IF NOT EXISTS "brand_heading_font" text;
