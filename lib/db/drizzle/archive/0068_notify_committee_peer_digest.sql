-- Task #754 — per-user opt-out for the daily committee peer-response digest
-- email sent by `sendCommitteePeerResponsesDigests`. Defaults to true so
-- existing committee members keep receiving the digest. Real-time push +
-- inbox delivery is unaffected by this flag.
ALTER TABLE "user_notification_prefs"
  ADD COLUMN IF NOT EXISTS "notify_committee_peer_digest" boolean NOT NULL DEFAULT true;
