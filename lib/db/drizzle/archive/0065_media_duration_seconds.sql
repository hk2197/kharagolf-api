-- Task #703 — Stop players from picking a start time past the end of the video.
-- Stores the true duration (in seconds, rounded up) of uploaded videos so the
-- highlight editor can disable the start/length steppers once they would
-- exceed the video's end, and so the renderer can clamp `startSec` as a
-- safety net. NULL on non-video uploads (and on legacy rows uploaded before
-- this column existed).
ALTER TABLE "media"
  ADD COLUMN IF NOT EXISTS "duration_seconds" integer;
