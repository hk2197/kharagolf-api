-- Task #1657 — Persist a row per non-delivery `notifyManualEntryRound` call
-- so the super-admin manual-entry alert dashboard can render a breakdown
-- chart of WHY rounds get skipped (org_muted, tournament_muted,
-- below_threshold, no_recipients, …) for the 7d / 30d windows without
-- the support team having to grep logs by hand.
--
-- The structured `[manual-entry-notify] result` log line is still the
-- source of truth (it carries every field the function knows about),
-- but logs are not aggregatable from inside the app process. This table
-- is the minimum amount of state that lets us answer "how many rounds
-- got skipped because the org was muted in the last 7 days?".
--
-- One row per call where the outcome was `skipped` or `failed`. Sent
-- alerts continue to land in `manual_entry_alerts`. The two tables
-- together describe the full population of notify calls.
--
-- `reason` is stored as free text (not a check constraint) so adding a
-- new branch to `notifyManualEntryRound` doesn't require a coupled
-- migration — the dashboard enumerates `MANUAL_ENTRY_NOTIFY_REASONS`
-- on the read side and renders an "Other" bucket as a defensive
-- backstop for unexpected values.

CREATE TABLE IF NOT EXISTS "manual_entry_notify_skips" (
  "id" serial PRIMARY KEY,
  "submission_id" integer NOT NULL,
  -- 'skipped' (the alert legitimately didn't fan out — e.g. org muted)
  -- or 'failed' (something errored before fan-out). Both are
  -- non-deliveries the chart needs to surface.
  "status" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "manual_entry_notify_skips_status_chk"
    CHECK ("status" IN ('skipped','failed'))
);

-- Window aggregations group by reason inside a time range.
CREATE INDEX IF NOT EXISTS "manual_entry_notify_skips_created_idx"
  ON "manual_entry_notify_skips" ("created_at");
CREATE INDEX IF NOT EXISTS "manual_entry_notify_skips_reason_created_idx"
  ON "manual_entry_notify_skips" ("reason", "created_at");
