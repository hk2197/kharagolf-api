-- Task #1126 — store a short machine-readable reason for non-2xx Stripe
-- webhook deliveries (e.g. "signature_mismatch", "missing_header",
-- "missing_secret", "missing_body", "reconciliation_failed") so admins can
-- see *why* a delivery failed in the Recent webhook deliveries panel
-- without grepping API server logs. Always NULL for successful (2xx) rows.
ALTER TABLE "stripe_webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "error_reason" text;
