-- Task #698 — Saved caption-style templates for the highlight reel editor.
-- When a player favorites an auto-generated caption chip, we store the
-- pattern (e.g. "Hole {hole} · {club} · {carry}y") plus the ordered list
-- of token keys it expects. Future suggestions for shots that have the
-- same set of tokens are rendered through the saved pattern so captions
-- feel consistent with the player's preferred style.

CREATE TABLE IF NOT EXISTS "highlight_caption_templates" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "app_users"("id") ON DELETE CASCADE,
  "organization_id" integer REFERENCES "organizations"("id") ON DELETE SET NULL,
  "pattern" text NOT NULL,
  "token_keys" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "sample_caption" text NOT NULL,
  "use_count" integer NOT NULL DEFAULT 0,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "highlight_caption_templates_user_idx"
  ON "highlight_caption_templates" ("user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "highlight_caption_templates_user_pattern_uniq"
  ON "highlight_caption_templates" ("user_id", "pattern");
