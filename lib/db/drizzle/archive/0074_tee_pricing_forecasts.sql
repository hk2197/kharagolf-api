-- Task #821 — Persisted forecast snapshots so admins can compare prior
-- projections to realised revenue. Each row captures the projected
-- numbers, the assumptions that produced them, and the date window the
-- forecast covered.

CREATE TABLE IF NOT EXISTS "tee_pricing_forecasts" (
  "id" serial PRIMARY KEY,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "course_id" integer REFERENCES "courses"("id") ON DELETE SET NULL,
  "actor_user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "scenario" text NOT NULL DEFAULT 'active',
  "label" text,
  "horizon_days" integer NOT NULL,
  "window_start" date NOT NULL,
  "window_end" date NOT NULL,
  "projected_revenue" numeric(14, 2) NOT NULL DEFAULT '0',
  "projected_avg_price" numeric(12, 2) NOT NULL DEFAULT '0',
  "projected_seats_booked" integer NOT NULL DEFAULT 0,
  "projected_seats_total" integer NOT NULL DEFAULT 0,
  "assumptions" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "tee_pricing_forecasts_org_idx"
  ON "tee_pricing_forecasts" ("organization_id", "window_end");
CREATE INDEX IF NOT EXISTS "tee_pricing_forecasts_course_idx"
  ON "tee_pricing_forecasts" ("course_id", "window_end");
