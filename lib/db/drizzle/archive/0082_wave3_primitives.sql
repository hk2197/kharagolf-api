-- Migration 0082 — Wave 3 load-bearing primitives (Task #938)
--
-- Adds the tables that gate Wave 3 deliverables across W3-A through W3-L
-- and the cross-cutting themes. Each table is the data primitive that any
-- subsequent UI / endpoint / wiring task can hang off without re-doing
-- schema work. Every CREATE is idempotent so post-merge replays are safe.

BEGIN;

-- ── W3-A: TOTP 2FA + active sessions ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "user_totp_secrets" (
  "id"            serial PRIMARY KEY,
  "user_id"       integer NOT NULL UNIQUE REFERENCES "app_users"("id") ON DELETE CASCADE,
  "secret_enc"    text NOT NULL,
  "confirmed_at"  timestamp with time zone,
  "last_used_at"  timestamp with time zone,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "user_active_sessions" (
  "id"             serial PRIMARY KEY,
  "user_id"        integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "session_token"  text NOT NULL UNIQUE,
  "device_label"   text,
  "ip"             text,
  "user_agent"     text,
  "last_seen_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at"     timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "user_active_sessions_user_idx"
  ON "user_active_sessions" ("user_id");

-- ── W3-F: social graph + verified-handicap badge ─────────────────────────
CREATE TABLE IF NOT EXISTS "user_follows" (
  "follower_id"  integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "followee_id"  integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("follower_id", "followee_id")
);
CREATE INDEX IF NOT EXISTS "user_follows_followee_idx"
  ON "user_follows" ("followee_id");

CREATE TABLE IF NOT EXISTS "verified_handicap_badges" (
  "user_id"      integer PRIMARY KEY REFERENCES "app_users"("id") ON DELETE CASCADE,
  "source"       text NOT NULL,
  "external_id"  text,
  "verified_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"   timestamp with time zone
);

-- ── W3-G: feed @-mentions + unified moderation inbox ─────────────────────
CREATE TABLE IF NOT EXISTS "feed_post_mentions" (
  "id"                  serial PRIMARY KEY,
  "post_id"             integer NOT NULL REFERENCES "feed_posts"("id") ON DELETE CASCADE,
  "mentioned_user_id"   integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "feed_post_mentions_uq"
  ON "feed_post_mentions" ("post_id", "mentioned_user_id");
CREATE INDEX IF NOT EXISTS "feed_post_mentions_user_idx"
  ON "feed_post_mentions" ("mentioned_user_id");

CREATE TABLE IF NOT EXISTS "moderation_inbox" (
  "id"               serial PRIMARY KEY,
  "organization_id"  integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "source_type"      text NOT NULL,
  "source_id"        integer NOT NULL,
  "summary"          text,
  "status"           text NOT NULL DEFAULT 'open',
  "assigned_to"      integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "resolved_by"      integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "resolved_at"      timestamp with time zone,
  "action"           text,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "moderation_inbox_org_status_idx"
  ON "moderation_inbox" ("organization_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "moderation_inbox_source_uq"
  ON "moderation_inbox" ("source_type", "source_id");

-- ── W3-H: sponsor self-serve + click tracking ────────────────────────────
CREATE TABLE IF NOT EXISTS "sponsor_assets" (
  "id"             serial PRIMARY KEY,
  "sponsor_id"     integer NOT NULL REFERENCES "sponsors"("id") ON DELETE CASCADE,
  "kind"           text NOT NULL,
  "url"            text NOT NULL,
  "status"         text NOT NULL DEFAULT 'pending',
  "uploaded_by"    integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "reviewed_by"    integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "reviewed_at"    timestamp with time zone,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "sponsor_assets_sponsor_idx"
  ON "sponsor_assets" ("sponsor_id");

CREATE TABLE IF NOT EXISTS "sponsor_clicks" (
  "id"            bigserial PRIMARY KEY,
  "sponsor_id"    integer NOT NULL REFERENCES "sponsors"("id") ON DELETE CASCADE,
  "placement"     text NOT NULL,
  "user_id"       integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "kind"          text NOT NULL DEFAULT 'click',
  "ts"            timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "sponsor_clicks_sponsor_ts_idx"
  ON "sponsor_clicks" ("sponsor_id", "ts");

-- ── W3-I: subscription SKUs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "subscription_skus" (
  "id"               serial PRIMARY KEY,
  "organization_id"  integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name"             text NOT NULL,
  "period_months"    integer NOT NULL DEFAULT 1,
  "price_minor"      integer NOT NULL,
  "currency"         text NOT NULL DEFAULT 'INR',
  "active"           boolean NOT NULL DEFAULT true,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "subscription_skus_org_idx"
  ON "subscription_skus" ("organization_id");

-- ── W3-K: marshal pace alerts ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "marshal_pace_alerts" (
  "id"               serial PRIMARY KEY,
  "tournament_id"    integer REFERENCES "tournaments"("id") ON DELETE CASCADE,
  "organization_id"  integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "group_label"      text NOT NULL,
  "hole_number"      integer NOT NULL,
  "minutes_behind"   integer NOT NULL,
  "alerted_at"       timestamp with time zone NOT NULL DEFAULT now(),
  "acknowledged_by"  integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "acknowledged_at"  timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "marshal_pace_alerts_dedupe"
  ON "marshal_pace_alerts" ("tournament_id", "group_label", "hole_number");

-- ── W3-L: per-club theming + benchmarking placeholder ────────────────────
CREATE TABLE IF NOT EXISTS "club_theming" (
  "organization_id"  integer PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
  "primary_color"    text,
  "accent_color"     text,
  "font_family"      text,
  "logo_url"         text,
  "favicon_url"      text,
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now()
);

-- ── W3-D: TV motion templates ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tv_motion_templates" (
  "id"               serial PRIMARY KEY,
  "organization_id"  integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name"             text NOT NULL,
  "kind"             text NOT NULL,
  "config"           jsonb NOT NULL DEFAULT '{}'::jsonb,
  "active"           boolean NOT NULL DEFAULT true,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "tv_motion_templates_org_idx"
  ON "tv_motion_templates" ("organization_id");

-- ── W3-E: streaks + near-miss prompts ────────────────────────────────────
CREATE TABLE IF NOT EXISTS "user_streaks" (
  "id"             serial PRIMARY KEY,
  "user_id"        integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "kind"           text NOT NULL,
  "current_len"    integer NOT NULL DEFAULT 0,
  "best_len"       integer NOT NULL DEFAULT 0,
  "last_incr_at"   timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_streaks_user_kind_uq"
  ON "user_streaks" ("user_id", "kind");

CREATE TABLE IF NOT EXISTS "near_miss_prompts" (
  "id"            serial PRIMARY KEY,
  "user_id"       integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "badge_key"     text NOT NULL,
  "missed_by"     text,
  "prompted_at"   timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "near_miss_prompts_user_idx"
  ON "near_miss_prompts" ("user_id");

COMMIT;
