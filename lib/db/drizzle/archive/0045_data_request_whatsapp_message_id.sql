-- Task 347: Track WhatsApp delivery receipts for privacy notices.
--
-- Provider-issued WhatsApp message id (Twilio SID, MSG91 request_id)
-- recorded at send time so the WhatsApp delivery webhook can map an
-- asynchronous status callback (delivered/failed/undelivered/blocked)
-- back to the originating privacy notice and update lastWhatsappStatus +
-- lastWhatsappError. Failed/undelivered callbacks re-flip the row to
-- `failed` so the existing retry cron picks it up.

ALTER TABLE member_data_requests
  ADD COLUMN IF NOT EXISTS last_whatsapp_message_id TEXT;

CREATE INDEX IF NOT EXISTS member_data_requests_whatsapp_msg_id_idx
  ON member_data_requests (last_whatsapp_message_id);
