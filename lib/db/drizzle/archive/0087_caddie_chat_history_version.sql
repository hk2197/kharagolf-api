-- Task #989 — optimistic-concurrency for AI Caddie chat-history sync.
--
-- Last-write-wins on the whole transcript array meant a player who had the
-- caddie open on two devices could lose recently-sent turns when the second
-- device PUT its (older) snapshot. Add a per-row `version` integer that the
-- server bumps on every successful PUT and that clients echo back as
-- `baseVersion`. Stale PUTs are now rejected with HTTP 409 so the mobile
-- client can merge by message id and retry.

ALTER TABLE "caddie_chat_history"
  ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
