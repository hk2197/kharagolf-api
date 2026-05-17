-- Task 507: Track WhatsApp delivery receipts for levy receipts.
--
-- Provider-issued WhatsApp message id (Twilio SID, MSG91 request_id)
-- recorded at send time on the per-levy-receipt attempts row so the
-- WhatsApp delivery webhook can map an asynchronous status callback
-- (delivered/failed/undelivered/blocked) back to the originating levy
-- receipt and update whatsappStatus + lastWhatsappError. Failed/
-- undelivered callbacks re-flip the row to `failed` so the existing
-- levy-receipt retry cron picks it up.

ALTER TABLE member_levy_receipt_attempts
  ADD COLUMN IF NOT EXISTS last_whatsapp_message_id TEXT;

CREATE INDEX IF NOT EXISTS member_levy_receipt_attempts_whatsapp_msg_id_idx
  ON member_levy_receipt_attempts (last_whatsapp_message_id);
