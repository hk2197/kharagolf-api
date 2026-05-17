-- Task #796 — Persist 24h/1h tournament tee-off reminder dispatch.
-- Without these columns the cron only deduped via in-memory `Set<number>`s,
-- so a server restart inside the 30-minute (24h) or 10-minute (1h) polling
-- window would re-push every registered player. Mirrors the pattern already
-- used for tee_bookings.reminder_24h_sent_at / reminder_2h_sent_at.
ALTER TABLE "tournaments"
  ADD COLUMN IF NOT EXISTS "reminder_24h_sent_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "reminder_1h_sent_at"  timestamptz;
