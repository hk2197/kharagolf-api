-- Task #2019 — Break down email CTR by club so each organisation sees its
-- own engagement.
--
-- Before this task `email_cta_clicks` and `email_cta_send_stats` were
-- both keyed only by `notification_key`, so the admin CTR report could
-- only show one combined number per key — every super-admin saw the
-- platform-wide total and org-admins saw nothing meaningful at all
-- (they couldn't slice down to their own club).
--
-- This migration adds an `organization_id` dimension to both tables so
-- the report can roll up per (key, org). Encoded into the (HMAC-signed)
-- tracking token at send time so the redirect route can stamp it on
-- the click row without an extra DB lookup on the hot path.
--
-- All `ADD COLUMN` / `CREATE INDEX` use IF NOT EXISTS so a partial
-- replay during a deploy retry is safe; the send-stats PK swap is
-- guarded with a DO block that no-ops when the new shape is already
-- in place.

-- 1) Click table — add the org column + the matching access-pattern index.
--    Nullable so recipients with no organisation (unaffiliated players,
--    system users) can still be counted; FK is `set null` so deleting an
--    org doesn't retroactively destroy historical engagement rows.
ALTER TABLE "email_cta_clicks"
  ADD COLUMN IF NOT EXISTS "organization_id" integer;

DO $do$ BEGIN
  ALTER TABLE "email_cta_clicks"
    ADD CONSTRAINT "email_cta_clicks_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
END $do$;

CREATE INDEX IF NOT EXISTS "email_cta_clicks_org_key_clicked_idx"
  ON "email_cta_clicks" ("organization_id", "notification_key", "clicked_at");

-- 2) Send-stats table — add `id` + `organization_id`, swap the PK from
--    `notification_key` to the surrogate `id`, and enforce uniqueness on
--    (notification_key, organization_id) with NULLS NOT DISTINCT so all
--    sends to recipients with no organisation share a single
--    "unaffiliated" bucket instead of proliferating one row per send.
--
--    Existing rows (one per key, no org) are preserved verbatim — they
--    represent the historical "global" denominator and read as the
--    `organization_id IS NULL` bucket going forward, which is exactly
--    what we want: pre-2019 sends were never tagged with an org, so
--    counting them under "unaffiliated" is the only honest backfill.
ALTER TABLE "email_cta_send_stats"
  ADD COLUMN IF NOT EXISTS "id" serial;

ALTER TABLE "email_cta_send_stats"
  ADD COLUMN IF NOT EXISTS "organization_id" integer;

DO $do$ BEGIN
  ALTER TABLE "email_cta_send_stats"
    ADD CONSTRAINT "email_cta_send_stats_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
END $do$;

DO $do$ BEGIN
  -- Drop the legacy single-column PK so we can re-stamp it on `id`.
  ALTER TABLE "email_cta_send_stats" DROP CONSTRAINT "email_cta_send_stats_pkey";
EXCEPTION
  WHEN undefined_object THEN null;
END $do$;

DO $do$ BEGIN
  ALTER TABLE "email_cta_send_stats" ADD CONSTRAINT "email_cta_send_stats_pkey" PRIMARY KEY ("id");
EXCEPTION
  WHEN invalid_table_definition THEN null;
END $do$;

DO $do$ BEGIN
  ALTER TABLE "email_cta_send_stats"
    ADD CONSTRAINT "email_cta_send_stats_key_org_unique"
    UNIQUE NULLS NOT DISTINCT ("notification_key", "organization_id");
EXCEPTION
  WHEN duplicate_object THEN null;
  WHEN duplicate_table  THEN null;
END $do$;
