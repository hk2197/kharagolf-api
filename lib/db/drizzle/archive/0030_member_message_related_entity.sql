-- Task 192: link a member_messages row back to the entity that triggered it
-- (e.g. a levy reminder) so admins can list/retry only the failed reminders
-- for that specific entity from the levy detail UI.


-- post-merge-guard: fresh-DB guard (table:member_messages)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'member_messages') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE member_messages
  ADD COLUMN IF NOT EXISTS related_entity TEXT,
  ADD COLUMN IF NOT EXISTS related_entity_id INTEGER;

CREATE INDEX IF NOT EXISTS member_messages_related_idx
  ON member_messages (related_entity, related_entity_id);

\else
\echo 'parent table member_messages not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

