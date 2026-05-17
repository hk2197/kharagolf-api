-- Task #1310 — show admins which campaign or transactional flow triggered
-- each bounce. Task #1138 added Postmark Type/MessageID/Description so
-- admins can tell *why* an address bounced; this migration adds the
-- *source* of the original send so admins can also tell *which campaign
-- or flow* the bounced message came from.
--
-- Two new nullable columns:
--   triggered_by_campaign_id  — FK to marketing_campaigns.id when the
--                               bouncing message was a marketing campaign
--                               send (set via Metadata.campaignId on the
--                               outbound Postmark request). ON DELETE SET
--                               NULL so deleting an old campaign doesn't
--                               cascade-delete the historical suppression
--                               row (admins still need to see the bounce).
--   triggered_by_flow         — short transactional flow name, e.g.
--                               "dues_receipt", "tournament_invite",
--                               "password_reset". Captured from the
--                               Postmark Tag or Metadata.flow field on
--                               the original send. Null for manual
--                               suppressions and for sends that did not
--                               carry any flow tag.

ALTER TABLE "email_suppressions"
  ADD COLUMN IF NOT EXISTS "triggered_by_campaign_id" integer;
ALTER TABLE "email_suppressions"
  ADD COLUMN IF NOT EXISTS "triggered_by_flow" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.table_constraints
    WHERE  constraint_name = 'email_suppressions_triggered_by_campaign_id_fk'
      AND  table_name      = 'email_suppressions'
  ) THEN
    ALTER TABLE "email_suppressions"
      ADD CONSTRAINT "email_suppressions_triggered_by_campaign_id_fk"
      FOREIGN KEY ("triggered_by_campaign_id")
      REFERENCES "marketing_campaigns"("id")
      ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "email_suppressions_triggered_campaign_idx"
  ON "email_suppressions" ("organization_id", "triggered_by_campaign_id");

CREATE INDEX IF NOT EXISTS "email_suppressions_triggered_flow_idx"
  ON "email_suppressions" ("organization_id", "triggered_by_flow");
