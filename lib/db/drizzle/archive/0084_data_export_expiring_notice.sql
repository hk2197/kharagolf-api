-- Task #922 — "Email members when their data export download is about to
-- expire". Two new columns on member_data_requests:
--
--   artifact_downloaded_at: stamped by the portal /download and /signed-url
--     endpoints when a member fetches their archive. Used to suppress the
--     "expires in 24h" reminder for members who already have the file.
--   expiring_notice_sent_at: set by the daily reminder cron when the
--     `export_expiring` notice has been dispatched for the row, so the
--     same archive isn't re-nudged on subsequent runs.
ALTER TABLE "member_data_requests"
  ADD COLUMN IF NOT EXISTS "artifact_downloaded_at" timestamptz;
ALTER TABLE "member_data_requests"
  ADD COLUMN IF NOT EXISTS "expiring_notice_sent_at" timestamptz;
