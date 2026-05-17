-- Task #2020 — Track post-click conversions per email CTA.
--
-- We already record a row in `email_cta_clicks` every time a recipient
-- follows an email's CTA via `/api/r/email/<token>`. That tells us who
-- clicked, but not whether the click translated into the action the
-- email was nudging them toward (booking a tee time, registering for a
-- tournament, watching their highlight, etc).
--
-- This migration adds two pieces:
--
--   1. A `click_id` column on `email_cta_clicks`. The redirect handler
--      now mints a short random id per click, persists it here, and
--      forwards it to the destination as both a `kg_email_click=…`
--      cookie (so subsequent same-origin requests carry it) and an
--      `?ec=…` query string (cookie-loss fallback). Backed by a unique
--      index so we can look the click up by id in O(1) when a
--      conversion fires.
--
--   2. A new `email_cta_conversions` table. One row per (clickId,
--      conversionType) — the unique constraint makes the recorder
--      idempotent so a flow that runs twice (e.g. retried POST) only
--      counts once. We snapshot the click's `notification_key` and
--      `user_id` at insert time so the admin report doesn't have to
--      re-join against `email_cta_clicks` on the hot path.
--
-- Conversion attribution window is enforced by the application layer
-- (currently 24h — see `EMAIL_CTA_CONVERSION_WINDOW_MS` in
-- `emailCtaConversion.ts`); we still store the raw `converted_at` so
-- the report can re-window without losing data.
--
-- Both changes use IF NOT EXISTS so a partial replay during a deploy
-- retry is safe.

ALTER TABLE "email_cta_clicks"
  ADD COLUMN IF NOT EXISTS "click_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "email_cta_clicks_click_id_uidx"
  ON "email_cta_clicks" ("click_id")
  WHERE "click_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "email_cta_conversions" (
  "id" serial PRIMARY KEY,
  "click_id" text NOT NULL,
  "notification_key" text NOT NULL,
  "user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "conversion_type" text NOT NULL,
  "converted_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Idempotency: a single click never produces two rows of the same
-- conversion type. The recorder uses ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS "email_cta_conversions_click_type_uidx"
  ON "email_cta_conversions" ("click_id", "conversion_type");

-- Drives the per-key admin report (counts + last-seen aggregates).
CREATE INDEX IF NOT EXISTS "email_cta_conversions_key_converted_idx"
  ON "email_cta_conversions" ("notification_key", "converted_at");
