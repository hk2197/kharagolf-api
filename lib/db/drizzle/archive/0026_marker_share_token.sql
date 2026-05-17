-- Add marker live share token fields to round_submissions
ALTER TABLE round_submissions
  ADD COLUMN IF NOT EXISTS marker_share_token TEXT,
  ADD COLUMN IF NOT EXISTS marker_share_token_expires_at TIMESTAMPTZ;

-- Unique index allows multiple NULL values (only one non-null token per active share link)
CREATE UNIQUE INDEX IF NOT EXISTS uq_round_submissions_marker_share_token
  ON round_submissions (marker_share_token)
  WHERE marker_share_token IS NOT NULL;
