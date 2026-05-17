-- Task #818 — Record the timestamp of the most recent admin notification
-- for the custom-domain HTTPS lifecycle, so the admin UI can render
-- "Last notified admins: HTTPS active on Apr 21, 14:02".

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "custom_domain_cert_notified_at" timestamp with time zone;
