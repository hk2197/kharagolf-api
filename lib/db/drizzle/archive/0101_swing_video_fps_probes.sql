-- Task #1217 — Make swing-video frame-rate detection survive server restarts.
--
-- Task #1057 moved the fps probe out of the upload-completion request and
-- into an in-process background scheduler. That kept uploads snappy but
-- the scheduled probes lived only in API server memory: a deploy or crash
-- between the swing_videos INSERT and the ffprobe finishing left the row
-- stuck at fps=NULL forever, recoverable only by re-running the manual
-- backfill script. This migration adds a durable queue (modeled on
-- highlight_reels' worker queue from Task #418) so a separate worker can
-- claim pending probes with FOR UPDATE SKIP LOCKED, run ffprobe, persist
-- the result, and survive any number of API/worker restarts.


-- post-merge-guard: fresh-DB guard (table:swing_videos)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'swing_videos') AS post_merge_dep_present \gset
\if :post_merge_dep_present

DO $$ BEGIN
  CREATE TYPE "swing_video_fps_probe_status" AS ENUM ('queued', 'probing', 'done', 'failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "swing_video_fps_probes" (
  "id" serial PRIMARY KEY NOT NULL,
  "swing_video_id" integer NOT NULL REFERENCES "swing_videos"("id") ON DELETE CASCADE,
  "object_path" text NOT NULL,
  "status" "swing_video_fps_probe_status" NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp with time zone NOT NULL DEFAULT now(),
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "error_message" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "swing_video_fps_probes_video_uniq"
  ON "swing_video_fps_probes" ("swing_video_id");

CREATE INDEX IF NOT EXISTS "swing_video_fps_probes_queue_idx"
  ON "swing_video_fps_probes" ("status", "next_attempt_at");

\else
\echo 'parent table swing_videos not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

