-- Task 297: Add WhatsApp as a 4th channel for privacy notices.
-- Mirrors the push/SMS retry-tracking columns so WhatsApp delivery for
-- mandatory privacy/data-protection notices gets the same per-attempt
-- telemetry, bounded retries, and exhaustion-alert dedup as the existing
-- channels.


-- post-merge-guard: fresh-DB guard (table:member_data_requests)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_data_requests') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE member_data_requests
  ADD COLUMN IF NOT EXISTS last_whatsapp_status TEXT,
  ADD COLUMN IF NOT EXISTS last_whatsapp_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_whatsapp_error TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_whatsapp_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_retry_exhausted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_exhaustion_notified_at TIMESTAMPTZ;

\else
\echo 'parent table member_data_requests not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

