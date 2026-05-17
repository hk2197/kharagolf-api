-- Task #1786 — Per-campaign push delivery counters surfaced on the
-- campaign stats page. Until now `dispatchCampaign` in
-- `routes/marketing.ts` swallowed every push delivery error in a bare
-- `try { ... } catch { /* log and continue */ }` block, so when push
-- fan-out failed (Expo down, all tokens invalid, batch rejected)
-- nothing surfaced in the admin dashboards and operators had no way to
-- know members were missed.
--
-- These two columns let the dispatcher classify each per-recipient
-- `sendPushToUsers` result through `classifyPushDelivery` (the same
-- helper used by every other notify path — see Task #1070 for the
-- "no_address vs. failed" rule) and bump the appropriate counter.
-- The campaign stats endpoint reads them back so the totals appear in
-- the admin Campaign → Stats view.
--
-- Default 0 / NOT NULL so existing rows backfill cleanly and the
-- update path can always rely on a numeric value. `IF NOT EXISTS` so
-- reruns and fresh DB bootstraps both succeed.
ALTER TABLE "marketing_campaigns"
  ADD COLUMN IF NOT EXISTS "total_push_sent" integer NOT NULL DEFAULT 0;

ALTER TABLE "marketing_campaigns"
  ADD COLUMN IF NOT EXISTS "total_push_failed" integer NOT NULL DEFAULT 0;
