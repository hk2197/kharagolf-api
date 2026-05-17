-- Task #2131 — Persisted, named drawing-preset library per coach.
--
-- Background. Task #1712 introduced an in-memory "drawings clipboard"
-- so a Copy in one swing-review survives opening another review in the
-- same session (Coach Workspace + mobile CoachDeliverModal). Coaches
-- who teach the same handful of recurring swing faults (early
-- extension, over-the-top, sway, hip-spin) actually want a small
-- *named* library — "Setup checkpoints", "Impact angle pack", "Tempo
-- bars" — they can pick from on every review. This migration adds the
-- table that backs the new GET/POST/PATCH/DELETE routes under
-- `/api/swing-reviews/coach/drawing-presets` so presets survive
-- between sessions and devices for the signed-in coach.
--
-- Shape blob mirrors the `drawings` payload accepted by
-- `/requests/:id/deliver` (an array of {kind: line|arrow|circle|angle,
-- t, …, color} objects). Times are preserved verbatim so the paste
-- helper on the client can re-apply the same offset-preserving math
-- the clipboard paste already uses (anchor the earliest shape at the
-- playhead and shift the rest by the same delta).
--
-- IF NOT EXISTS guards on the table + index so a partial replay
-- during a deploy retry is safe.

CREATE TABLE IF NOT EXISTS "coach_drawing_presets" (
  "id" serial PRIMARY KEY NOT NULL,
  "pro_id" integer NOT NULL,
  "name" text NOT NULL,
  "drawings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $do$ BEGIN
  ALTER TABLE "coach_drawing_presets"
    ADD CONSTRAINT "coach_drawing_presets_pro_id_teaching_pros_id_fk"
    FOREIGN KEY ("pro_id") REFERENCES "teaching_pros"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $do$;

-- The picker fetches a coach's presets ordered by recently-used. Cover
-- both the `where pro_id = ?` filter and the `order by updated_at desc`
-- in one composite index so the list is a single index scan.
CREATE INDEX IF NOT EXISTS "coach_drawing_presets_pro_idx"
  ON "coach_drawing_presets" ("pro_id", "updated_at");
