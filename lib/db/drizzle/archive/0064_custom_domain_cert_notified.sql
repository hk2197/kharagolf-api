-- Task #668 — Track which (host, status) pair we last emailed club admins
-- about so the new "HTTPS live / failed" notification doesn't re-spam on
-- a retry that ends in the same state. NULL means we have not notified
-- about the current host yet.

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "custom_domain_cert_notified_status" text;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "custom_domain_cert_notified_host" text;
