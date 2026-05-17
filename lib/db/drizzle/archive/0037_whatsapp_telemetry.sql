-- Task #296: WhatsApp notification foundation.
--
-- Adds matching WhatsApp telemetry columns to the two per-attempt tables
-- that already track push/SMS retries (member_data_requests for privacy
-- notices, member_levy_receipt_attempts for levy receipts). The downstream
-- per-surface tasks (privacy notices, levy receipts, levy reminders,
-- document-rejection alerts) will populate these columns as they fan out
-- notifications to WhatsApp via the new sendTransactionalWhatsapp helper.
--
-- Mirrors the existing SMS columns one-for-one so the existing retry cron
-- patterns can be extended uniformly. Idempotent via IF NOT EXISTS so the
-- post-merge script applies cleanly on environments that have already run
-- earlier migrations.


-- post-merge-guard: fresh-DB guard (table:member_data_requests)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_data_requests') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE member_data_requests
  ADD COLUMN IF NOT EXISTS last_whatsapp_status        TEXT,
  ADD COLUMN IF NOT EXISTS last_whatsapp_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_whatsapp_error         TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_attempts           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_whatsapp_retry_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_retry_exhausted_at TIMESTAMPTZ;

ALTER TABLE member_levy_receipt_attempts
  ADD COLUMN IF NOT EXISTS whatsapp_status             TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_attempts           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_whatsapp_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_whatsapp_error         TEXT,
  ADD COLUMN IF NOT EXISTS last_whatsapp_retry_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_retry_exhausted_at TIMESTAMPTZ;

\else
\echo 'parent table member_data_requests not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

