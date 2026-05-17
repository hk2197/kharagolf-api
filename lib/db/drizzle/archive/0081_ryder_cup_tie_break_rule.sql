-- Task #892 — Allow admins to choose the team-match playoff format
-- (sudden_death | extra_holes_3 | none) for Ryder Cup team matches,
-- mirroring the option already available on individual brackets.

ALTER TABLE "ryder_cup_config"
  ADD COLUMN IF NOT EXISTS "tie_break_rule" text NOT NULL DEFAULT 'sudden_death';
