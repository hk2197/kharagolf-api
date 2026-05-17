-- Task #1597 — Protect uploaders from accidental email blasts on bulk
-- re-upload by tracking the most recent re-upload nudge per media row.
--
-- The bulk-request-reupload endpoint previously sent one email per
-- selected mediaId, with no per-uploader de-duplication and no rate
-- limit. Selecting "all" on a club with hundreds of broken legacy
-- uploads could send the same uploader several emails in a single
-- click, or trigger an outbound burst that risks tripping the email
-- provider's abuse limits.
--
-- This migration adds the timestamp the bulk endpoint uses to:
--   * de-duplicate within a single call: rows are grouped by uploader
--     and a single email is sent per uploader listing all of their
--     selected broken clips, then every nudged row is stamped.
--   * rate-limit across calls: before sending we check
--     MAX(last_reupload_request_at) across the uploader's rows in the
--     org and refuse another nudge within the cooldown window
--     (REUPLOAD_REQUEST_COOLDOWN_HOURS in the API server).
--
-- Added with IF NOT EXISTS so a partial replay during a deploy retry
-- is safe.

ALTER TABLE "media"
  ADD COLUMN IF NOT EXISTS "last_reupload_request_at" timestamp with time zone;
