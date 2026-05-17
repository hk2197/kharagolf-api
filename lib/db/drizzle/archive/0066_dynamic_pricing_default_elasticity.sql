-- Task #729 + Task #730: Persist per-club default price elasticity for the
-- forecast UI. Members are typically far less price-sensitive than walk-in
-- guests, so we store distinct defaults per segment.
--
-- An earlier iteration of this task added a single `default_elasticity`
-- column; we drop it in favour of the per-segment columns now that the
-- forecast model is segmented.

ALTER TABLE "tee_dynamic_pricing_config"
  ADD COLUMN IF NOT EXISTS "default_member_elasticity" numeric(4, 2) DEFAULT '-0.20' NOT NULL;

ALTER TABLE "tee_dynamic_pricing_config"
  ADD COLUMN IF NOT EXISTS "default_guest_elasticity" numeric(4, 2) DEFAULT '-0.70' NOT NULL;

ALTER TABLE "tee_dynamic_pricing_config"
  DROP COLUMN IF EXISTS "default_elasticity";
