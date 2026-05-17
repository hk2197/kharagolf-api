-- Migration 0077 — AI Caddie chat history (Task #843).
-- Stores each player's AI Caddie transcript on the server so it follows
-- them across phones, tablets, and the web portal. The mobile client also
-- keeps a local AsyncStorage copy and falls back to it when offline.
--
-- Single row per signed-in player. Messages are stored as a JSON array
-- (capped client-side to 50 turns) — last write wins across devices.

CREATE TABLE IF NOT EXISTS "caddie_chat_history" (
  "user_id"    integer PRIMARY KEY REFERENCES "app_users"("id") ON DELETE CASCADE,
  "messages"   jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
