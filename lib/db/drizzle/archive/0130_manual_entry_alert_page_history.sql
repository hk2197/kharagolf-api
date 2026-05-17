-- Task #1665 — durable record of every manual-entry alert health
-- ops page sent by `runManualEntryAlertHealthOpsAlertJob` (Task
-- #1387).
--
-- The auto-page job keeps its cooldown / "last paged at" state in
-- process memory, so super-admins looking at
-- `/super-admin/manual-entry-alerts` could not tell whether on-call
-- had already been notified about a current outage. This table
-- appends one row per successful page so the dashboard can surface
-- a "Last paged" banner without anyone having to DM on-call to
-- confirm, and so support has a long-tail history when reconstructing
-- an incident.

CREATE TABLE IF NOT EXISTS "manual_entry_alert_page_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "paged_at" timestamp with time zone DEFAULT now() NOT NULL,
  "breach_kinds" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "recipient_count" integer DEFAULT 0 NOT NULL,
  "recipient_emails" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "threshold_pct" numeric(6, 2) NOT NULL,
  "cooldown_hours" numeric(6, 2) NOT NULL,
  "alert_count_7d" integer NOT NULL,
  "any_delivery_rate_7d" numeric(6, 2) NOT NULL,
  "zero_delivery_count_7d" integer NOT NULL
);

CREATE INDEX IF NOT EXISTS "manual_entry_alert_page_history_paged_at_idx"
  ON "manual_entry_alert_page_history" USING btree ("paged_at");
