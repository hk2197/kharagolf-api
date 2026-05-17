-- Migration 0083 — fix marshal_pace_alerts NULL dedupe + add org index.
--
-- 0082 created a composite UNIQUE index on (tournament_id, group_label,
-- hole_number). PostgreSQL treats NULLs as distinct in unique indexes, so
-- general-play alerts (tournament_id IS NULL) bypass the dedupe. Replace
-- with two partial indexes so dedupe holds in both regimes. Also add the
-- per-org filter index used by the marshal dashboard hot path.

BEGIN;

DROP INDEX IF EXISTS "marshal_pace_alerts_dedupe";

CREATE UNIQUE INDEX IF NOT EXISTS "marshal_pace_alerts_t_dedupe"
  ON "marshal_pace_alerts" ("tournament_id", "group_label", "hole_number")
  WHERE "tournament_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "marshal_pace_alerts_gp_dedupe"
  ON "marshal_pace_alerts" ("organization_id", "group_label", "hole_number")
  WHERE "tournament_id" IS NULL;

CREATE INDEX IF NOT EXISTS "marshal_pace_alerts_org_idx"
  ON "marshal_pace_alerts" ("organization_id");

COMMIT;
