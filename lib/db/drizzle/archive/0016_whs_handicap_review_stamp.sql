-- WHS Annual Handicap Review stamp fields for organizations table
-- Added by Task #77: WHS 2024/2026 Compliance Engine + GHIN/IGU Integration
-- Tracks when an Org Admin ran the annual Low H.I. reset and who did it.

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "handicap_review_completed_at" TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "handicap_review_completed_by_user_id" INTEGER REFERENCES "app_users"("id");
