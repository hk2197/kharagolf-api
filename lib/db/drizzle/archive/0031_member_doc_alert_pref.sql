-- Task 183: Per-staff toggle for member_document_pending email/push alerts.
-- Adds notify_member_documents boolean column (default true) so existing
-- staff continue to receive alerts unless they explicitly opt out.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_notification_prefs') THEN
    ALTER TABLE user_notification_prefs
      ADD COLUMN IF NOT EXISTS notify_member_documents BOOLEAN NOT NULL DEFAULT TRUE;
  END IF;
END $$;
