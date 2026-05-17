-- Task #581: Automatically issue HTTPS certificates for club custom domains.
--
-- Records the lifecycle of the cert provisioning request the platform makes
-- to its ingress provider (Cloudflare for SaaS, Caddy on-demand TLS, mock
-- for dev). The admin UI surfaces pending/active/failed and offers a retry.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS custom_domain_cert_status TEXT NOT NULL DEFAULT 'none';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS custom_domain_cert_provider TEXT;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS custom_domain_cert_error TEXT;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS custom_domain_cert_requested_at TIMESTAMPTZ;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS custom_domain_cert_issued_at TIMESTAMPTZ;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS custom_domain_cert_checked_at TIMESTAMPTZ;
