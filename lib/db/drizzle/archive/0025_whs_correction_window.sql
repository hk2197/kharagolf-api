ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "correction_window_hours" integer NOT NULL DEFAULT 24;
