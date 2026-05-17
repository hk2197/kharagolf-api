-- Task #1555 — show admins which template (not just campaign or flow) caused
-- each bounce. Builds on Task #1310 (campaign / flow attribution).
--
-- Two structural changes:
--
--   1. `marketing_campaigns.template_id` (nullable, FK → email_templates_marketing.id
--      ON DELETE SET NULL): records which saved template a campaign was
--      built from. The dispatcher reads this and forwards it as
--      `Metadata.templateId` on every outbound Postmark request.
--
--   2. `email_suppressions.triggered_by_template_id` (nullable, FK →
--      email_templates_marketing.id ON DELETE SET NULL): the Postmark
--      bounce webhook reads `Metadata.templateId` back, verifies the
--      template is owned by the resolved org (or is a global template
--      with `is_global=true`), and writes the id here. The Suppressions
--      tab joins it back so admins can click straight through to the
--      template editor and fix the typo at source.
--
-- ON DELETE SET NULL on both FKs: deleting an old template should not
-- cascade-delete historical campaigns or suppression rows that pointed
-- at it (admins still need to see those for audit / forensics).

ALTER TABLE "marketing_campaigns"
  ADD COLUMN IF NOT EXISTS "template_id" integer;

ALTER TABLE "email_suppressions"
  ADD COLUMN IF NOT EXISTS "triggered_by_template_id" integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.table_constraints
    WHERE  constraint_name = 'marketing_campaigns_template_id_fk'
      AND  table_name      = 'marketing_campaigns'
  ) THEN
    ALTER TABLE "marketing_campaigns"
      ADD CONSTRAINT "marketing_campaigns_template_id_fk"
      FOREIGN KEY ("template_id")
      REFERENCES "email_templates_marketing"("id")
      ON DELETE SET NULL;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.table_constraints
    WHERE  constraint_name = 'email_suppressions_triggered_by_template_id_fk'
      AND  table_name      = 'email_suppressions'
  ) THEN
    ALTER TABLE "email_suppressions"
      ADD CONSTRAINT "email_suppressions_triggered_by_template_id_fk"
      FOREIGN KEY ("triggered_by_template_id")
      REFERENCES "email_templates_marketing"("id")
      ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "mktg_campaigns_template_idx"
  ON "marketing_campaigns" ("organization_id", "template_id");

CREATE INDEX IF NOT EXISTS "email_suppressions_triggered_template_idx"
  ON "email_suppressions" ("organization_id", "triggered_by_template_id");
