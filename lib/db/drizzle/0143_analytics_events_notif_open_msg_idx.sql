-- Task #1944 — keep the push-tap dedupe lookup fast as
-- analytics_events grows.
--
-- Background: Task #1564 added a dedupe SELECT inside
-- POST /portal/notifications/push-opened that filters
-- analytics_events by:
--   event_name = 'notification_opened'
--   AND user_id = $1
--   AND occurred_at >= $2          (recent window)
--   AND payload->>'messageId' = $3
--
-- The first three predicates are covered by the existing
-- analytics_events_event_idx (event_name, occurred_at) and
-- analytics_events_user_idx (user_id, occurred_at). The JSONB
-- extraction `payload->>'messageId'` is not — so the planner can
-- pick a covered index, walk every notification_opened row in the
-- window for that user, and re-check the JSONB on each candidate.
-- That's fine while the table is small; once mobile push volume
-- grows, every cold-start tap pays this cost twice (once for
-- dedupe, once for the insert).
--
-- This partial expression index keys on (user_id,
-- payload->>'messageId') and is constrained to the single event
-- name the dedupe queries, so:
--   * the dedupe terminates in a single index seek regardless of
--     overall analytics_events size,
--   * storage stays small because rows for any other event_name
--     are not indexed,
--   * no other analytics consumer is affected (no existing query
--     references this index).
--
-- IF NOT EXISTS so reruns and fresh DB bootstraps both succeed.

CREATE INDEX IF NOT EXISTS "analytics_events_notif_open_msg_idx"
  ON "analytics_events" ("user_id", (("payload"->>'messageId')))
  WHERE "event_name" = 'notification_opened';
