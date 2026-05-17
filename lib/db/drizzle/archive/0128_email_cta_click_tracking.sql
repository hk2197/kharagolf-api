-- Task #1622 — Track and report email CTA click-through rates.
--
-- We now wrap every branded notification email's CTA href with a
-- tracking redirect (`/api/r/email/<token>`). The redirect route records
-- one row in `email_cta_clicks` per click before 302-ing onto the real
-- destination, and the dispatcher increments the per-key counter in
-- `email_cta_send_stats` on each successful send. The admin CTR report
-- joins the two to compute clicks / sends per `notification_key`.
--
-- Both tables are created with IF NOT EXISTS so a partial replay during
-- a deploy retry is safe.

CREATE TABLE IF NOT EXISTS "email_cta_clicks" (
  "id" serial PRIMARY KEY,
  "notification_key" text NOT NULL,
  "user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "original_url" text NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "clicked_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "email_cta_clicks_key_clicked_idx"
  ON "email_cta_clicks" ("notification_key", "clicked_at");
CREATE INDEX IF NOT EXISTS "email_cta_clicks_user_idx"
  ON "email_cta_clicks" ("user_id");

CREATE TABLE IF NOT EXISTS "email_cta_send_stats" (
  "notification_key" text PRIMARY KEY,
  "send_count" integer NOT NULL DEFAULT 0,
  "last_sent_at" timestamp with time zone NOT NULL DEFAULT now()
);
