-- Match Play Brackets & Ryder Cup Formats
-- Adds new tournament format values and tables for draw-based match play brackets
-- and Ryder Cup / Presidents Cup team events.
-- NOTE: This migration is idempotent (IF NOT EXISTS / DO NOTHING guards throughout).

-- ── Extend tournament_format enum ──────────────────────────────────────────
DO $$ BEGIN
  ALTER TYPE "tournament_format" ADD VALUE IF NOT EXISTS 'match_play_bracket';
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
  ALTER TYPE "tournament_format" ADD VALUE IF NOT EXISTS 'ryder_cup';
EXCEPTION WHEN others THEN null; END $$;

-- ── New enums ───────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "bracket_type" AS ENUM('main', 'consolation');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "match_result" AS ENUM('pending', 'player1_wins', 'player2_wins', 'halved', 'conceded');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ryder_cup_session_type" AS ENUM('foursomes', 'four_ball', 'singles');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── match_play_brackets ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "match_play_brackets" (
  "id" serial PRIMARY KEY NOT NULL,
  "tournament_id" integer NOT NULL UNIQUE REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "seeded_from_tournament_id" integer REFERENCES "tournaments"("id") ON DELETE SET NULL,
  "seeding_method" text DEFAULT 'manual' NOT NULL,
  "has_consolation" boolean DEFAULT false NOT NULL,
  "total_rounds" integer DEFAULT 1 NOT NULL,
  "draw_generated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "match_play_bracket_tournament_idx" ON "match_play_brackets"("tournament_id");

-- ── bracket_rounds ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bracket_rounds" (
  "id" serial PRIMARY KEY NOT NULL,
  "bracket_id" integer NOT NULL REFERENCES "match_play_brackets"("id") ON DELETE CASCADE,
  "round_number" integer NOT NULL,
  "name" text NOT NULL,
  "bracket_type" "bracket_type" DEFAULT 'main' NOT NULL,
  "scheduled_date" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "bracket_round_unique" ON "bracket_rounds"("bracket_id", "round_number", "bracket_type");
CREATE INDEX IF NOT EXISTS "bracket_rounds_bracket_idx" ON "bracket_rounds"("bracket_id");

-- ── bracket_matches ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bracket_matches" (
  "id" serial PRIMARY KEY NOT NULL,
  "bracket_id" integer NOT NULL REFERENCES "match_play_brackets"("id") ON DELETE CASCADE,
  "round_id" integer NOT NULL REFERENCES "bracket_rounds"("id") ON DELETE CASCADE,
  "match_number" integer NOT NULL,
  "bracket_type" "bracket_type" DEFAULT 'main' NOT NULL,
  "player1_id" integer REFERENCES "players"("id") ON DELETE SET NULL,
  "player2_id" integer REFERENCES "players"("id") ON DELETE SET NULL,
  "player1_is_bye" boolean DEFAULT false NOT NULL,
  "player2_is_bye" boolean DEFAULT false NOT NULL,
  "result" "match_result" DEFAULT 'pending' NOT NULL,
  "winner_id" integer REFERENCES "players"("id") ON DELETE SET NULL,
  "hole_results" jsonb DEFAULT '{}',
  "match_status" text,
  "conceded_by_player_id" integer REFERENCES "players"("id") ON DELETE SET NULL,
  "conceded_on_hole" integer,
  "next_match_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "bracket_match_round_num_unique" ON "bracket_matches"("round_id", "match_number", "bracket_type");
CREATE INDEX IF NOT EXISTS "bracket_matches_bracket_idx" ON "bracket_matches"("bracket_id");
CREATE INDEX IF NOT EXISTS "bracket_matches_round_idx" ON "bracket_matches"("round_id");
CREATE INDEX IF NOT EXISTS "bracket_matches_player1_idx" ON "bracket_matches"("player1_id");
CREATE INDEX IF NOT EXISTS "bracket_matches_player2_idx" ON "bracket_matches"("player2_id");

-- ── ryder_cup_config ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ryder_cup_config" (
  "id" serial PRIMARY KEY NOT NULL,
  "tournament_id" integer NOT NULL UNIQUE REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "team1_name" text DEFAULT 'Team 1' NOT NULL,
  "team2_name" text DEFAULT 'Team 2' NOT NULL,
  "team1_colour" text DEFAULT '#1e40af',
  "team2_colour" text DEFAULT '#dc2626',
  "total_points" integer DEFAULT 28 NOT NULL,
  "team1_total_points" numeric(6,1) DEFAULT '0' NOT NULL,
  "team2_total_points" numeric(6,1) DEFAULT '0' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "ryder_cup_config_tournament_idx" ON "ryder_cup_config"("tournament_id");

-- ── ryder_cup_sessions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ryder_cup_sessions" (
  "id" serial PRIMARY KEY NOT NULL,
  "tournament_id" integer NOT NULL REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "session_number" integer NOT NULL,
  "session_type" "ryder_cup_session_type" DEFAULT 'singles' NOT NULL,
  "name" text NOT NULL,
  "team1_name" text DEFAULT 'Team 1' NOT NULL,
  "team2_name" text DEFAULT 'Team 2' NOT NULL,
  "scheduled_date" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ryder_cup_session_unique" ON "ryder_cup_sessions"("tournament_id", "session_number");
CREATE INDEX IF NOT EXISTS "ryder_cup_sessions_tournament_idx" ON "ryder_cup_sessions"("tournament_id");

-- ── ryder_cup_matches ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ryder_cup_matches" (
  "id" serial PRIMARY KEY NOT NULL,
  "session_id" integer NOT NULL REFERENCES "ryder_cup_sessions"("id") ON DELETE CASCADE,
  "tournament_id" integer NOT NULL REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "match_number" integer NOT NULL,
  "team1_player1_id" integer REFERENCES "players"("id") ON DELETE SET NULL,
  "team1_player2_id" integer REFERENCES "players"("id") ON DELETE SET NULL,
  "team2_player1_id" integer REFERENCES "players"("id") ON DELETE SET NULL,
  "team2_player2_id" integer REFERENCES "players"("id") ON DELETE SET NULL,
  "result" "match_result" DEFAULT 'pending' NOT NULL,
  "team1_points" numeric(3,1) DEFAULT '0' NOT NULL,
  "team2_points" numeric(3,1) DEFAULT '0' NOT NULL,
  "hole_results" jsonb DEFAULT '{}',
  "match_status" text,
  "conceded_by_team" text,
  "conceded_on_hole" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ryder_cup_match_session_num_unique" ON "ryder_cup_matches"("session_id", "match_number");
CREATE INDEX IF NOT EXISTS "ryder_cup_matches_session_idx" ON "ryder_cup_matches"("session_id");
CREATE INDEX IF NOT EXISTS "ryder_cup_matches_tournament_idx" ON "ryder_cup_matches"("tournament_id");
