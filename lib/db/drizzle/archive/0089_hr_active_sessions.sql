-- Task #1025 — make the abandoned-round HR check work across multiple API
-- instances. The active-HR-session marker added in Task #874 used to live in
-- a per-process Map; in a multi-instance deployment a session opened on
-- instance A would be invisible to instance B, so legitimate sample POSTs
-- hitting B were wrongly refused with `session_inactive`. Move the marker
-- to shared storage (Postgres) keyed by user_id with an expires_at TTL so
-- every instance sees the same state.
CREATE TABLE IF NOT EXISTS "hr_active_sessions" (
  "user_id" integer PRIMARY KEY NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
