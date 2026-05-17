-- Task #450 — Persist Year-in-Golf launch broadcaster send-state across
-- API server restarts. Each row claims a (year, period, day) tuple before
-- the cron dispatches the push, so a restart inside a launch window can
-- no longer cause duplicate notifications.
CREATE TABLE IF NOT EXISTS "recap_broadcasts" (
  "year" integer NOT NULL,
  "period" text NOT NULL,
  "day" integer NOT NULL,
  "recipients" integer NOT NULL DEFAULT 0,
  "sent_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "recap_broadcasts_pkey" PRIMARY KEY ("year", "period", "day")
);
