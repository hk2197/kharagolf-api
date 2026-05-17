-- Catch-up migration # (Task #1403): missing foreign-key constraints.
--
-- Generated from lib/db/.migration-coverage-baseline.json — these
-- statements describe schema objects that exist in lib/db/src/schema/
-- but were never captured in a numbered migration. Production only
-- applies numbered migrations, so until this file lands they only
-- reach prod by accident.
--
-- Every statement here is wrapped to be IDEMPOTENT so post-merge.sh
-- can replay it safely on dev/test DBs that already have the object.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ad_campaigns'
      AND c.conname = 'ad_campaigns_creative_id_ad_creatives_id_fk'
  ) THEN
    ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_creative_id_ad_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."ad_creatives"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ad_campaigns'
      AND c.conname = 'ad_campaigns_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ad_campaigns'
      AND c.conname = 'ad_campaigns_slot_id_ad_slots_id_fk'
  ) THEN
    ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_slot_id_ad_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."ad_slots"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ad_campaigns'
      AND c.conname = 'ad_campaigns_sponsor_id_sponsors_id_fk'
  ) THEN
    ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ad_campaigns'
      AND c.conname = 'ad_campaigns_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ad_creatives'
      AND c.conname = 'ad_creatives_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ad_creatives'
      AND c.conname = 'ad_creatives_sponsor_id_sponsors_id_fk'
  ) THEN
    ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ad_slots'
      AND c.conname = 'ad_slots_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "ad_slots" ADD CONSTRAINT "ad_slots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'affiliate_codes'
      AND c.conname = 'affiliate_codes_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "affiliate_codes" ADD CONSTRAINT "affiliate_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'affiliate_codes'
      AND c.conname = 'affiliate_codes_owner_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "affiliate_codes" ADD CONSTRAINT "affiliate_codes_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'affiliate_redemptions'
      AND c.conname = 'affiliate_redemptions_affiliate_code_id_affiliate_codes_id_fk'
  ) THEN
    ALTER TABLE "affiliate_redemptions" ADD CONSTRAINT "affiliate_redemptions_affiliate_code_id_affiliate_codes_id_fk" FOREIGN KEY ("affiliate_code_id") REFERENCES "public"."affiliate_codes"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'affiliate_redemptions'
      AND c.conname = 'affiliate_redemptions_order_id_shop_orders_id_fk'
  ) THEN
    ALTER TABLE "affiliate_redemptions" ADD CONSTRAINT "affiliate_redemptions_order_id_shop_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shop_orders"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'affiliate_redemptions'
      AND c.conname = 'affiliate_redemptions_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "affiliate_redemptions" ADD CONSTRAINT "affiliate_redemptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'affiliate_redemptions'
      AND c.conname = 'affiliate_redemptions_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "affiliate_redemptions" ADD CONSTRAINT "affiliate_redemptions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ai_caddie_mode_blocks'
      AND c.conname = 'ai_caddie_mode_blocks_league_id_leagues_id_fk'
  ) THEN
    ALTER TABLE "ai_caddie_mode_blocks" ADD CONSTRAINT "ai_caddie_mode_blocks_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ai_caddie_mode_blocks'
      AND c.conname = 'ai_caddie_mode_blocks_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "ai_caddie_mode_blocks" ADD CONSTRAINT "ai_caddie_mode_blocks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ai_caddie_mode_blocks'
      AND c.conname = 'ai_caddie_mode_blocks_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "ai_caddie_mode_blocks" ADD CONSTRAINT "ai_caddie_mode_blocks_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ai_caddie_mode_blocks'
      AND c.conname = 'ai_caddie_mode_blocks_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "ai_caddie_mode_blocks" ADD CONSTRAINT "ai_caddie_mode_blocks_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'automation_rule_logs'
      AND c.conname = 'automation_rule_logs_rule_id_automation_rules_id_fk'
  ) THEN
    ALTER TABLE "automation_rule_logs" ADD CONSTRAINT "automation_rule_logs_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'automation_rules'
      AND c.conname = 'automation_rules_league_id_leagues_id_fk'
  ) THEN
    ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'automation_rules'
      AND c.conname = 'automation_rules_org_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'automation_rules'
      AND c.conname = 'automation_rules_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ball_token_credits'
      AND c.conname = 'ball_token_credits_booking_id_range_bookings_id_fk'
  ) THEN
    ALTER TABLE "ball_token_credits" ADD CONSTRAINT "ball_token_credits_booking_id_range_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."range_bookings"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ball_token_credits'
      AND c.conname = 'ball_token_credits_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "ball_token_credits" ADD CONSTRAINT "ball_token_credits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ball_token_credits'
      AND c.conname = 'ball_token_credits_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "ball_token_credits" ADD CONSTRAINT "ball_token_credits_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'bounced_digest_schedule_opt_outs'
      AND c.conname = 'bounced_digest_schedule_opt_outs_organization_id_fk'
  ) THEN
    ALTER TABLE "bounced_digest_schedule_opt_outs" ADD CONSTRAINT "bounced_digest_schedule_opt_outs_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'bounced_digest_schedule_opt_outs'
      AND c.conname = 'bounced_digest_schedule_opt_outs_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "bounced_digest_schedule_opt_outs" ADD CONSTRAINT "bounced_digest_schedule_opt_outs_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'bounced_digest_schedule_sends'
      AND c.conname = 'bounced_digest_schedule_sends_org_fk'
  ) THEN
    ALTER TABLE "bounced_digest_schedule_sends" ADD CONSTRAINT "bounced_digest_schedule_sends_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'bounced_digest_schedule_sends'
      AND c.conname = 'bounced_digest_schedule_sends_user_fk'
  ) THEN
    ALTER TABLE "bounced_digest_schedule_sends" ADD CONSTRAINT "bounced_digest_schedule_sends_user_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'bracket_matches'
      AND c.conname = 'bracket_matches_bracket_id_match_play_brackets_id_fk'
  ) THEN
    ALTER TABLE "bracket_matches" ADD CONSTRAINT "bracket_matches_bracket_id_match_play_brackets_id_fk" FOREIGN KEY ("bracket_id") REFERENCES "public"."match_play_brackets"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'bracket_matches'
      AND c.conname = 'bracket_matches_conceded_by_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "bracket_matches" ADD CONSTRAINT "bracket_matches_conceded_by_player_id_players_id_fk" FOREIGN KEY ("conceded_by_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'bracket_matches'
      AND c.conname = 'bracket_matches_player1_id_players_id_fk'
  ) THEN
    ALTER TABLE "bracket_matches" ADD CONSTRAINT "bracket_matches_player1_id_players_id_fk" FOREIGN KEY ("player1_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'bracket_matches'
      AND c.conname = 'bracket_matches_player2_id_players_id_fk'
  ) THEN
    ALTER TABLE "bracket_matches" ADD CONSTRAINT "bracket_matches_player2_id_players_id_fk" FOREIGN KEY ("player2_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'bracket_matches'
      AND c.conname = 'bracket_matches_round_id_bracket_rounds_id_fk'
  ) THEN
    ALTER TABLE "bracket_matches" ADD CONSTRAINT "bracket_matches_round_id_bracket_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."bracket_rounds"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'bracket_matches'
      AND c.conname = 'bracket_matches_winner_id_players_id_fk'
  ) THEN
    ALTER TABLE "bracket_matches" ADD CONSTRAINT "bracket_matches_winner_id_players_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'bracket_rounds'
      AND c.conname = 'bracket_rounds_bracket_id_match_play_brackets_id_fk'
  ) THEN
    ALTER TABLE "bracket_rounds" ADD CONSTRAINT "bracket_rounds_bracket_id_match_play_brackets_id_fk" FOREIGN KEY ("bracket_id") REFERENCES "public"."match_play_brackets"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'bundle_deals'
      AND c.conname = 'bundle_deals_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "bundle_deals" ADD CONSTRAINT "bundle_deals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_assignments'
      AND c.conname = 'caddie_assignments_assigned_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "caddie_assignments" ADD CONSTRAINT "caddie_assignments_assigned_by_user_id_app_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_assignments'
      AND c.conname = 'caddie_assignments_caddie_id_caddie_profiles_id_fk'
  ) THEN
    ALTER TABLE "caddie_assignments" ADD CONSTRAINT "caddie_assignments_caddie_id_caddie_profiles_id_fk" FOREIGN KEY ("caddie_id") REFERENCES "public"."caddie_profiles"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_assignments'
      AND c.conname = 'caddie_assignments_member_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "caddie_assignments" ADD CONSTRAINT "caddie_assignments_member_id_app_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_assignments'
      AND c.conname = 'caddie_assignments_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "caddie_assignments" ADD CONSTRAINT "caddie_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_assignments'
      AND c.conname = 'caddie_assignments_tee_booking_id_tee_bookings_id_fk'
  ) THEN
    ALTER TABLE "caddie_assignments" ADD CONSTRAINT "caddie_assignments_tee_booking_id_tee_bookings_id_fk" FOREIGN KEY ("tee_booking_id") REFERENCES "public"."tee_bookings"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_availability'
      AND c.conname = 'caddie_availability_caddie_id_caddie_profiles_id_fk'
  ) THEN
    ALTER TABLE "caddie_availability" ADD CONSTRAINT "caddie_availability_caddie_id_caddie_profiles_id_fk" FOREIGN KEY ("caddie_id") REFERENCES "public"."caddie_profiles"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_availability'
      AND c.conname = 'caddie_availability_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "caddie_availability" ADD CONSTRAINT "caddie_availability_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_chat_history'
      AND c.conname = 'caddie_chat_history_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "caddie_chat_history" ADD CONSTRAINT "caddie_chat_history_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_event_assignments'
      AND c.conname = 'caddie_event_assignments_caddie_id_caddies_id_fk'
  ) THEN
    ALTER TABLE "caddie_event_assignments" ADD CONSTRAINT "caddie_event_assignments_caddie_id_caddies_id_fk" FOREIGN KEY ("caddie_id") REFERENCES "public"."caddies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_event_assignments'
      AND c.conname = 'caddie_event_assignments_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "caddie_event_assignments" ADD CONSTRAINT "caddie_event_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_event_assignments'
      AND c.conname = 'caddie_event_assignments_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "caddie_event_assignments" ADD CONSTRAINT "caddie_event_assignments_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_event_assignments'
      AND c.conname = 'caddie_event_assignments_tee_time_id_tee_times_id_fk'
  ) THEN
    ALTER TABLE "caddie_event_assignments" ADD CONSTRAINT "caddie_event_assignments_tee_time_id_tee_times_id_fk" FOREIGN KEY ("tee_time_id") REFERENCES "public"."tee_times"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_event_assignments'
      AND c.conname = 'caddie_event_assignments_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "caddie_event_assignments" ADD CONSTRAINT "caddie_event_assignments_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_profiles'
      AND c.conname = 'caddie_profiles_created_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "caddie_profiles" ADD CONSTRAINT "caddie_profiles_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_profiles'
      AND c.conname = 'caddie_profiles_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "caddie_profiles" ADD CONSTRAINT "caddie_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_profiles'
      AND c.conname = 'caddie_profiles_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "caddie_profiles" ADD CONSTRAINT "caddie_profiles_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_ratings'
      AND c.conname = 'caddie_ratings_assignment_id_caddie_assignments_id_fk'
  ) THEN
    ALTER TABLE "caddie_ratings" ADD CONSTRAINT "caddie_ratings_assignment_id_caddie_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."caddie_assignments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_ratings'
      AND c.conname = 'caddie_ratings_caddie_id_caddie_profiles_id_fk'
  ) THEN
    ALTER TABLE "caddie_ratings" ADD CONSTRAINT "caddie_ratings_caddie_id_caddie_profiles_id_fk" FOREIGN KEY ("caddie_id") REFERENCES "public"."caddie_profiles"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_ratings'
      AND c.conname = 'caddie_ratings_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "caddie_ratings" ADD CONSTRAINT "caddie_ratings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_ratings'
      AND c.conname = 'caddie_ratings_rated_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "caddie_ratings" ADD CONSTRAINT "caddie_ratings_rated_by_user_id_app_users_id_fk" FOREIGN KEY ("rated_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_recommendations'
      AND c.conname = 'caddie_recommendations_general_play_round_id_fk'
  ) THEN
    ALTER TABLE "caddie_recommendations" ADD CONSTRAINT "caddie_recommendations_general_play_round_id_fk" FOREIGN KEY ("general_play_round_id") REFERENCES "public"."general_play_rounds"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_recommendations'
      AND c.conname = 'caddie_recommendations_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "caddie_recommendations" ADD CONSTRAINT "caddie_recommendations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_recommendations'
      AND c.conname = 'caddie_recommendations_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "caddie_recommendations" ADD CONSTRAINT "caddie_recommendations_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'caddie_recommendations'
      AND c.conname = 'caddie_recommendations_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "caddie_recommendations" ADD CONSTRAINT "caddie_recommendations_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cart_assignments'
      AND c.conname = 'cart_assignments_booking_id_tee_bookings_id_fk'
  ) THEN
    ALTER TABLE "cart_assignments" ADD CONSTRAINT "cart_assignments_booking_id_tee_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."tee_bookings"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'club_carry_distances'
      AND c.conname = 'club_carry_distances_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "club_carry_distances" ADD CONSTRAINT "club_carry_distances_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'club_currency_profiles'
      AND c.conname = 'club_currency_profiles_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "club_currency_profiles" ADD CONSTRAINT "club_currency_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'club_theming'
      AND c.conname = 'club_theming_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "club_theming" ADD CONSTRAINT "club_theming_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'club_wallet_txns'
      AND c.conname = 'club_wallet_txns_wallet_id_club_wallets_id_fk'
  ) THEN
    ALTER TABLE "club_wallet_txns" ADD CONSTRAINT "club_wallet_txns_wallet_id_club_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."club_wallets"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'club_wallet_withdrawals'
      AND c.conname = 'club_wallet_withdrawals_payout_account_fk'
  ) THEN
    ALTER TABLE "club_wallet_withdrawals" ADD CONSTRAINT "club_wallet_withdrawals_payout_account_fk" FOREIGN KEY ("payout_account_id") REFERENCES "public"."wallet_payout_accounts"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'club_wallets'
      AND c.conname = 'club_wallets_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "club_wallets" ADD CONSTRAINT "club_wallets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'club_wallets'
      AND c.conname = 'club_wallets_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "club_wallets" ADD CONSTRAINT "club_wallets_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coach_marketplace_profiles'
      AND c.conname = 'coach_marketplace_profiles_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "coach_marketplace_profiles" ADD CONSTRAINT "coach_marketplace_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coach_marketplace_profiles'
      AND c.conname = 'coach_marketplace_profiles_pro_id_teaching_pros_id_fk'
  ) THEN
    ALTER TABLE "coach_marketplace_profiles" ADD CONSTRAINT "coach_marketplace_profiles_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coach_payout_account_history'
      AND c.conname = 'coach_payout_account_history_changed_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "coach_payout_account_history" ADD CONSTRAINT "coach_payout_account_history_changed_by_user_id_app_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coach_payout_account_history'
      AND c.conname = 'coach_payout_account_history_pro_id_teaching_pros_id_fk'
  ) THEN
    ALTER TABLE "coach_payout_account_history" ADD CONSTRAINT "coach_payout_account_history_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coach_payout_account_history'
      AND c.conname = 'coach_payout_acct_hist_org_fk'
  ) THEN
    ALTER TABLE "coach_payout_account_history" ADD CONSTRAINT "coach_payout_acct_hist_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coach_payout_notification_attempts'
      AND c.conname = 'coach_payout_notif_attempts_org_id_fk'
  ) THEN
    ALTER TABLE "coach_payout_notification_attempts" ADD CONSTRAINT "coach_payout_notif_attempts_org_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coach_payout_notification_attempts'
      AND c.conname = 'coach_payout_notif_attempts_payout_id_fk'
  ) THEN
    ALTER TABLE "coach_payout_notification_attempts" ADD CONSTRAINT "coach_payout_notif_attempts_payout_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."coach_payouts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coach_payout_notification_attempts'
      AND c.conname = 'coach_payout_notification_attempts_pro_id_teaching_pros_id_fk'
  ) THEN
    ALTER TABLE "coach_payout_notification_attempts" ADD CONSTRAINT "coach_payout_notification_attempts_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coach_payout_notifications'
      AND c.conname = 'coach_payout_notifications_coach_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "coach_payout_notifications" ADD CONSTRAINT "coach_payout_notifications_coach_user_id_app_users_id_fk" FOREIGN KEY ("coach_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coach_payout_notifications'
      AND c.conname = 'coach_payout_notifications_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "coach_payout_notifications" ADD CONSTRAINT "coach_payout_notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coach_payout_notifications'
      AND c.conname = 'coach_payout_notifications_payout_id_coach_payouts_id_fk'
  ) THEN
    ALTER TABLE "coach_payout_notifications" ADD CONSTRAINT "coach_payout_notifications_payout_id_coach_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."coach_payouts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coach_payouts'
      AND c.conname = 'coach_payouts_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "coach_payouts" ADD CONSTRAINT "coach_payouts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coach_payouts'
      AND c.conname = 'coach_payouts_pro_id_teaching_pros_id_fk'
  ) THEN
    ALTER TABLE "coach_payouts" ADD CONSTRAINT "coach_payouts_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'coaching_notes'
      AND c.conname = 'coaching_notes_pro_id_teaching_pros_id_fk'
  ) THEN
    ALTER TABLE "coaching_notes" ADD CONSTRAINT "coaching_notes_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'commission_adjustments'
      AND c.conname = 'commission_adjustments_adjusted_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_adjusted_by_user_id_app_users_id_fk" FOREIGN KEY ("adjusted_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'commission_adjustments'
      AND c.conname = 'commission_adjustments_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'commission_adjustments'
      AND c.conname = 'commission_adjustments_staff_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_staff_user_id_app_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'commission_payouts'
      AND c.conname = 'commission_payouts_approved_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_approved_by_user_id_app_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'commission_payouts'
      AND c.conname = 'commission_payouts_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'commission_payouts'
      AND c.conname = 'commission_payouts_staff_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "commission_payouts" ADD CONSTRAINT "commission_payouts_staff_user_id_app_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'commission_rules'
      AND c.conname = 'commission_rules_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'commission_rules'
      AND c.conname = 'commission_rules_staff_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_staff_user_id_app_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'course_condition_reports'
      AND c.conname = 'course_condition_reports_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "course_condition_reports" ADD CONSTRAINT "course_condition_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'course_condition_reports'
      AND c.conname = 'course_condition_reports_reported_by_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "course_condition_reports" ADD CONSTRAINT "course_condition_reports_reported_by_id_app_users_id_fk" FOREIGN KEY ("reported_by_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'course_data_corrections'
      AND c.conname = 'course_data_corrections_course_id_courses_id_fk'
  ) THEN
    ALTER TABLE "course_data_corrections" ADD CONSTRAINT "course_data_corrections_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'course_data_corrections'
      AND c.conname = 'course_data_corrections_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "course_data_corrections" ADD CONSTRAINT "course_data_corrections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'course_data_corrections'
      AND c.conname = 'course_data_corrections_reported_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "course_data_corrections" ADD CONSTRAINT "course_data_corrections_reported_by_user_id_app_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'course_data_corrections'
      AND c.conname = 'course_data_corrections_reviewed_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "course_data_corrections" ADD CONSTRAINT "course_data_corrections_reviewed_by_user_id_app_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'course_notices'
      AND c.conname = 'course_notices_created_by_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "course_notices" ADD CONSTRAINT "course_notices_created_by_id_app_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'course_notices'
      AND c.conname = 'course_notices_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "course_notices" ADD CONSTRAINT "course_notices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'course_tee_slots'
      AND c.conname = 'course_tee_slots_course_id_courses_id_fk'
  ) THEN
    ALTER TABLE "course_tee_slots" ADD CONSTRAINT "course_tee_slots_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'course_tee_slots'
      AND c.conname = 'course_tee_slots_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "course_tee_slots" ADD CONSTRAINT "course_tee_slots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladder_clubs'
      AND c.conname = 'cross_club_ladder_clubs_ladder_id_cross_club_ladders_id_fk'
  ) THEN
    ALTER TABLE "cross_club_ladder_clubs" ADD CONSTRAINT "cross_club_ladder_clubs_ladder_id_cross_club_ladders_id_fk" FOREIGN KEY ("ladder_id") REFERENCES "public"."cross_club_ladders"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladder_clubs'
      AND c.conname = 'cross_club_ladder_clubs_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "cross_club_ladder_clubs" ADD CONSTRAINT "cross_club_ladder_clubs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladder_entries'
      AND c.conname = 'cross_club_ladder_entries_home_organization_id_fk'
  ) THEN
    ALTER TABLE "cross_club_ladder_entries" ADD CONSTRAINT "cross_club_ladder_entries_home_organization_id_fk" FOREIGN KEY ("home_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladder_entries'
      AND c.conname = 'cross_club_ladder_entries_ladder_id_cross_club_ladders_id_fk'
  ) THEN
    ALTER TABLE "cross_club_ladder_entries" ADD CONSTRAINT "cross_club_ladder_entries_ladder_id_cross_club_ladders_id_fk" FOREIGN KEY ("ladder_id") REFERENCES "public"."cross_club_ladders"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladder_entries'
      AND c.conname = 'cross_club_ladder_entries_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "cross_club_ladder_entries" ADD CONSTRAINT "cross_club_ladder_entries_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladder_events'
      AND c.conname = 'cross_club_ladder_events_entry_id_fk'
  ) THEN
    ALTER TABLE "cross_club_ladder_events" ADD CONSTRAINT "cross_club_ladder_events_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."cross_club_ladder_entries"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladder_events'
      AND c.conname = 'cross_club_ladder_events_ladder_id_cross_club_ladders_id_fk'
  ) THEN
    ALTER TABLE "cross_club_ladder_events" ADD CONSTRAINT "cross_club_ladder_events_ladder_id_cross_club_ladders_id_fk" FOREIGN KEY ("ladder_id") REFERENCES "public"."cross_club_ladders"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladder_result_audits'
      AND c.conname = 'ccl_result_audits_ladder_fk'
  ) THEN
    ALTER TABLE "cross_club_ladder_result_audits" ADD CONSTRAINT "ccl_result_audits_ladder_fk" FOREIGN KEY ("ladder_id") REFERENCES "public"."cross_club_ladders"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladder_results'
      AND c.conname = 'cross_club_ladder_results_entry_id_fk'
  ) THEN
    ALTER TABLE "cross_club_ladder_results" ADD CONSTRAINT "cross_club_ladder_results_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."cross_club_ladder_entries"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladder_results'
      AND c.conname = 'cross_club_ladder_results_general_play_round_id_fk'
  ) THEN
    ALTER TABLE "cross_club_ladder_results" ADD CONSTRAINT "cross_club_ladder_results_general_play_round_id_fk" FOREIGN KEY ("general_play_round_id") REFERENCES "public"."general_play_rounds"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladder_results'
      AND c.conname = 'cross_club_ladder_results_ladder_id_cross_club_ladders_id_fk'
  ) THEN
    ALTER TABLE "cross_club_ladder_results" ADD CONSTRAINT "cross_club_ladder_results_ladder_id_cross_club_ladders_id_fk" FOREIGN KEY ("ladder_id") REFERENCES "public"."cross_club_ladders"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladder_results'
      AND c.conname = 'cross_club_ladder_results_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "cross_club_ladder_results" ADD CONSTRAINT "cross_club_ladder_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladder_results'
      AND c.conname = 'cross_club_ladder_results_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "cross_club_ladder_results" ADD CONSTRAINT "cross_club_ladder_results_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'cross_club_ladders'
      AND c.conname = 'cross_club_ladders_created_by_app_users_id_fk'
  ) THEN
    ALTER TABLE "cross_club_ladders" ADD CONSTRAINT "cross_club_ladders_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'equipment_records'
      AND c.conname = 'equipment_records_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "equipment_records" ADD CONSTRAINT "equipment_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'equipment_service_logs'
      AND c.conname = 'equipment_service_logs_equipment_id_equipment_records_id_fk'
  ) THEN
    ALTER TABLE "equipment_service_logs" ADD CONSTRAINT "equipment_service_logs_equipment_id_equipment_records_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment_records"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'equipment_service_logs'
      AND c.conname = 'equipment_service_logs_logged_by_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "equipment_service_logs" ADD CONSTRAINT "equipment_service_logs_logged_by_id_app_users_id_fk" FOREIGN KEY ("logged_by_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'equipment_service_logs'
      AND c.conname = 'equipment_service_logs_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "equipment_service_logs" ADD CONSTRAINT "equipment_service_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_bookings'
      AND c.conname = 'event_bookings_assigned_to_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_assigned_to_user_id_app_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_bookings'
      AND c.conname = 'event_bookings_catering_package_id_fk'
  ) THEN
    ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_catering_package_id_fk" FOREIGN KEY ("catering_package_id") REFERENCES "public"."event_catering_packages"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_bookings'
      AND c.conname = 'event_bookings_function_space_id_function_spaces_id_fk'
  ) THEN
    ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_function_space_id_function_spaces_id_fk" FOREIGN KEY ("function_space_id") REFERENCES "public"."function_spaces"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_bookings'
      AND c.conname = 'event_bookings_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_catering_packages'
      AND c.conname = 'event_catering_packages_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "event_catering_packages" ADD CONSTRAINT "event_catering_packages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_documents'
      AND c.conname = 'event_documents_document_id_operational_documents_id_fk'
  ) THEN
    ALTER TABLE "event_documents" ADD CONSTRAINT "event_documents_document_id_operational_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."operational_documents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_invoices'
      AND c.conname = 'event_invoices_booking_id_event_bookings_id_fk'
  ) THEN
    ALTER TABLE "event_invoices" ADD CONSTRAINT "event_invoices_booking_id_event_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."event_bookings"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_invoices'
      AND c.conname = 'event_invoices_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "event_invoices" ADD CONSTRAINT "event_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_survey_fields'
      AND c.conname = 'event_survey_fields_survey_id_event_survey_forms_id_fk'
  ) THEN
    ALTER TABLE "event_survey_fields" ADD CONSTRAINT "event_survey_fields_survey_id_event_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."event_survey_forms"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_survey_forms'
      AND c.conname = 'event_survey_forms_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "event_survey_forms" ADD CONSTRAINT "event_survey_forms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_survey_respondents'
      AND c.conname = 'event_survey_respondents_survey_id_event_survey_forms_id_fk'
  ) THEN
    ALTER TABLE "event_survey_respondents" ADD CONSTRAINT "event_survey_respondents_survey_id_event_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."event_survey_forms"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_survey_response_items'
      AND c.conname = 'event_survey_response_items_field_id_event_survey_fields_id_fk'
  ) THEN
    ALTER TABLE "event_survey_response_items" ADD CONSTRAINT "event_survey_response_items_field_id_event_survey_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."event_survey_fields"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_survey_response_items'
      AND c.conname = 'event_survey_response_items_respondent_id_fk'
  ) THEN
    ALTER TABLE "event_survey_response_items" ADD CONSTRAINT "event_survey_response_items_respondent_id_fk" FOREIGN KEY ("respondent_id") REFERENCES "public"."event_survey_respondents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_team_members'
      AND c.conname = 'event_team_members_league_member_id_league_members_id_fk'
  ) THEN
    ALTER TABLE "event_team_members" ADD CONSTRAINT "event_team_members_league_member_id_league_members_id_fk" FOREIGN KEY ("league_member_id") REFERENCES "public"."league_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_team_members'
      AND c.conname = 'event_team_members_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "event_team_members" ADD CONSTRAINT "event_team_members_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_team_members'
      AND c.conname = 'event_team_members_team_id_event_teams_id_fk'
  ) THEN
    ALTER TABLE "event_team_members" ADD CONSTRAINT "event_team_members_team_id_event_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."event_teams"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_teams'
      AND c.conname = 'event_teams_league_id_leagues_id_fk'
  ) THEN
    ALTER TABLE "event_teams" ADD CONSTRAINT "event_teams_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'event_teams'
      AND c.conname = 'event_teams_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "event_teams" ADD CONSTRAINT "event_teams_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'exceptional_score_flags'
      AND c.conname = 'exceptional_score_flags_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "exceptional_score_flags" ADD CONSTRAINT "exceptional_score_flags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'exceptional_score_flags'
      AND c.conname = 'exceptional_score_flags_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "exceptional_score_flags" ADD CONSTRAINT "exceptional_score_flags_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'exceptional_score_flags'
      AND c.conname = 'exceptional_score_flags_reviewed_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "exceptional_score_flags" ADD CONSTRAINT "exceptional_score_flags_reviewed_by_user_id_app_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'exceptional_score_flags'
      AND c.conname = 'exceptional_score_flags_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "exceptional_score_flags" ADD CONSTRAINT "exceptional_score_flags_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_fulfillment_stations'
      AND c.conname = 'fb_fulfillment_stations_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "fb_fulfillment_stations" ADD CONSTRAINT "fb_fulfillment_stations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_menu_categories'
      AND c.conname = 'fb_menu_categories_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "fb_menu_categories" ADD CONSTRAINT "fb_menu_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_menu_item_modifier_groups'
      AND c.conname = 'fb_menu_item_modifier_groups_group_id_fb_modifier_groups_id_fk'
  ) THEN
    ALTER TABLE "fb_menu_item_modifier_groups" ADD CONSTRAINT "fb_menu_item_modifier_groups_group_id_fb_modifier_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."fb_modifier_groups"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_menu_item_modifier_groups'
      AND c.conname = 'fb_menu_item_modifier_groups_menu_item_id_fb_menu_items_id_fk'
  ) THEN
    ALTER TABLE "fb_menu_item_modifier_groups" ADD CONSTRAINT "fb_menu_item_modifier_groups_menu_item_id_fb_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."fb_menu_items"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_menu_item_service_periods'
      AND c.conname = 'fb_menu_item_service_periods_menu_item_id_fb_menu_items_id_fk'
  ) THEN
    ALTER TABLE "fb_menu_item_service_periods" ADD CONSTRAINT "fb_menu_item_service_periods_menu_item_id_fb_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."fb_menu_items"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_menu_item_service_periods'
      AND c.conname = 'fb_menu_item_service_periods_service_period_id_fk'
  ) THEN
    ALTER TABLE "fb_menu_item_service_periods" ADD CONSTRAINT "fb_menu_item_service_periods_service_period_id_fk" FOREIGN KEY ("service_period_id") REFERENCES "public"."fb_service_periods"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_menu_items'
      AND c.conname = 'fb_menu_items_category_id_fb_menu_categories_id_fk'
  ) THEN
    ALTER TABLE "fb_menu_items" ADD CONSTRAINT "fb_menu_items_category_id_fb_menu_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."fb_menu_categories"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_menu_items'
      AND c.conname = 'fb_menu_items_inventory_variant_id_shop_product_variants_id_fk'
  ) THEN
    ALTER TABLE "fb_menu_items" ADD CONSTRAINT "fb_menu_items_inventory_variant_id_shop_product_variants_id_fk" FOREIGN KEY ("inventory_variant_id") REFERENCES "public"."shop_product_variants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_menu_items'
      AND c.conname = 'fb_menu_items_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "fb_menu_items" ADD CONSTRAINT "fb_menu_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_menu_items'
      AND c.conname = 'fb_menu_items_station_id_fb_fulfillment_stations_id_fk'
  ) THEN
    ALTER TABLE "fb_menu_items" ADD CONSTRAINT "fb_menu_items_station_id_fb_fulfillment_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."fb_fulfillment_stations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_modifier_groups'
      AND c.conname = 'fb_modifier_groups_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "fb_modifier_groups" ADD CONSTRAINT "fb_modifier_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_modifier_options'
      AND c.conname = 'fb_modifier_options_group_id_fb_modifier_groups_id_fk'
  ) THEN
    ALTER TABLE "fb_modifier_options" ADD CONSTRAINT "fb_modifier_options_group_id_fb_modifier_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."fb_modifier_groups"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_order_items'
      AND c.conname = 'fb_order_items_menu_item_id_fb_menu_items_id_fk'
  ) THEN
    ALTER TABLE "fb_order_items" ADD CONSTRAINT "fb_order_items_menu_item_id_fb_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."fb_menu_items"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_order_items'
      AND c.conname = 'fb_order_items_order_id_fb_orders_id_fk'
  ) THEN
    ALTER TABLE "fb_order_items" ADD CONSTRAINT "fb_order_items_order_id_fb_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."fb_orders"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_orders'
      AND c.conname = 'fb_orders_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "fb_orders" ADD CONSTRAINT "fb_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_orders'
      AND c.conname = 'fb_orders_server_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "fb_orders" ADD CONSTRAINT "fb_orders_server_user_id_app_users_id_fk" FOREIGN KEY ("server_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_orders'
      AND c.conname = 'fb_orders_station_id_fb_fulfillment_stations_id_fk'
  ) THEN
    ALTER TABLE "fb_orders" ADD CONSTRAINT "fb_orders_station_id_fb_fulfillment_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."fb_fulfillment_stations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_orders'
      AND c.conname = 'fb_orders_tab_id_fb_tabs_id_fk'
  ) THEN
    ALTER TABLE "fb_orders" ADD CONSTRAINT "fb_orders_tab_id_fb_tabs_id_fk" FOREIGN KEY ("tab_id") REFERENCES "public"."fb_tabs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_orders'
      AND c.conname = 'fb_orders_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "fb_orders" ADD CONSTRAINT "fb_orders_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_service_periods'
      AND c.conname = 'fb_service_periods_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "fb_service_periods" ADD CONSTRAINT "fb_service_periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_tabs'
      AND c.conname = 'fb_tabs_closed_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "fb_tabs" ADD CONSTRAINT "fb_tabs_closed_by_user_id_app_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_tabs'
      AND c.conname = 'fb_tabs_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "fb_tabs" ADD CONSTRAINT "fb_tabs_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_tabs'
      AND c.conname = 'fb_tabs_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "fb_tabs" ADD CONSTRAINT "fb_tabs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fb_tabs'
      AND c.conname = 'fb_tabs_server_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "fb_tabs" ADD CONSTRAINT "fb_tabs_server_user_id_app_users_id_fk" FOREIGN KEY ("server_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_comments'
      AND c.conname = 'feed_comments_author_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "feed_comments" ADD CONSTRAINT "feed_comments_author_user_id_app_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_comments'
      AND c.conname = 'feed_comments_post_id_feed_posts_id_fk'
  ) THEN
    ALTER TABLE "feed_comments" ADD CONSTRAINT "feed_comments_post_id_feed_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."feed_posts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_post_media'
      AND c.conname = 'feed_post_media_post_id_feed_posts_id_fk'
  ) THEN
    ALTER TABLE "feed_post_media" ADD CONSTRAINT "feed_post_media_post_id_feed_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."feed_posts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_post_mentions'
      AND c.conname = 'feed_post_mentions_mentioned_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "feed_post_mentions" ADD CONSTRAINT "feed_post_mentions_mentioned_user_id_app_users_id_fk" FOREIGN KEY ("mentioned_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_post_mentions'
      AND c.conname = 'feed_post_mentions_post_id_feed_posts_id_fk'
  ) THEN
    ALTER TABLE "feed_post_mentions" ADD CONSTRAINT "feed_post_mentions_post_id_feed_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."feed_posts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_posts'
      AND c.conname = 'feed_posts_author_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "feed_posts" ADD CONSTRAINT "feed_posts_author_user_id_app_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_posts'
      AND c.conname = 'feed_posts_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "feed_posts" ADD CONSTRAINT "feed_posts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_posts'
      AND c.conname = 'feed_posts_tagged_course_id_courses_id_fk'
  ) THEN
    ALTER TABLE "feed_posts" ADD CONSTRAINT "feed_posts_tagged_course_id_courses_id_fk" FOREIGN KEY ("tagged_course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_reactions'
      AND c.conname = 'feed_reactions_post_id_feed_posts_id_fk'
  ) THEN
    ALTER TABLE "feed_reactions" ADD CONSTRAINT "feed_reactions_post_id_feed_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."feed_posts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_reactions'
      AND c.conname = 'feed_reactions_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "feed_reactions" ADD CONSTRAINT "feed_reactions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_reports'
      AND c.conname = 'feed_reports_comment_id_feed_comments_id_fk'
  ) THEN
    ALTER TABLE "feed_reports" ADD CONSTRAINT "feed_reports_comment_id_feed_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."feed_comments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_reports'
      AND c.conname = 'feed_reports_post_id_feed_posts_id_fk'
  ) THEN
    ALTER TABLE "feed_reports" ADD CONSTRAINT "feed_reports_post_id_feed_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."feed_posts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_reports'
      AND c.conname = 'feed_reports_reporter_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "feed_reports" ADD CONSTRAINT "feed_reports_reporter_user_id_app_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'feed_reports'
      AND c.conname = 'feed_reports_resolved_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "feed_reports" ADD CONSTRAINT "feed_reports_resolved_by_user_id_app_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fitting_sessions'
      AND c.conname = 'fitting_sessions_created_by_app_users_id_fk'
  ) THEN
    ALTER TABLE "fitting_sessions" ADD CONSTRAINT "fitting_sessions_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fitting_sessions'
      AND c.conname = 'fitting_sessions_member_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "fitting_sessions" ADD CONSTRAINT "fitting_sessions_member_id_app_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fitting_sessions'
      AND c.conname = 'fitting_sessions_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "fitting_sessions" ADD CONSTRAINT "fitting_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fitting_sessions'
      AND c.conname = 'fitting_sessions_technician_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "fitting_sessions" ADD CONSTRAINT "fitting_sessions_technician_id_app_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'function_spaces'
      AND c.conname = 'function_spaces_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "function_spaces" ADD CONSTRAINT "function_spaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'fx_ledger_entries'
      AND c.conname = 'fx_ledger_entries_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "fx_ledger_entries" ADD CONSTRAINT "fx_ledger_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'general_play_hole_scores'
      AND c.conname = 'general_play_hole_scores_round_id_general_play_rounds_id_fk'
  ) THEN
    ALTER TABLE "general_play_hole_scores" ADD CONSTRAINT "general_play_hole_scores_round_id_general_play_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."general_play_rounds"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'general_play_markers'
      AND c.conname = 'general_play_markers_marker_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "general_play_markers" ADD CONSTRAINT "general_play_markers_marker_user_id_app_users_id_fk" FOREIGN KEY ("marker_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'general_play_markers'
      AND c.conname = 'general_play_markers_round_id_general_play_rounds_id_fk'
  ) THEN
    ALTER TABLE "general_play_markers" ADD CONSTRAINT "general_play_markers_round_id_general_play_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."general_play_rounds"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'general_play_rounds'
      AND c.conname = 'general_play_rounds_course_id_courses_id_fk'
  ) THEN
    ALTER TABLE "general_play_rounds" ADD CONSTRAINT "general_play_rounds_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'general_play_rounds'
      AND c.conname = 'general_play_rounds_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "general_play_rounds" ADD CONSTRAINT "general_play_rounds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'general_play_rounds'
      AND c.conname = 'general_play_rounds_tee_booking_id_tee_bookings_id_fk'
  ) THEN
    ALTER TABLE "general_play_rounds" ADD CONSTRAINT "general_play_rounds_tee_booking_id_tee_bookings_id_fk" FOREIGN KEY ("tee_booking_id") REFERENCES "public"."tee_bookings"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'general_play_rounds'
      AND c.conname = 'general_play_rounds_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "general_play_rounds" ADD CONSTRAINT "general_play_rounds_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'golf_trips'
      AND c.conname = 'golf_trips_created_by_app_users_id_fk'
  ) THEN
    ALTER TABLE "golf_trips" ADD CONSTRAINT "golf_trips_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'golf_trips'
      AND c.conname = 'golf_trips_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "golf_trips" ADD CONSTRAINT "golf_trips_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'gps_chunk_buffer'
      AND c.conname = 'gps_chunk_buffer_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "gps_chunk_buffer" ADD CONSTRAINT "gps_chunk_buffer_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'group_checkpoints'
      AND c.conname = 'group_checkpoints_recorded_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "group_checkpoints" ADD CONSTRAINT "group_checkpoints_recorded_by_user_id_app_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'group_checkpoints'
      AND c.conname = 'group_checkpoints_tee_time_id_tee_times_id_fk'
  ) THEN
    ALTER TABLE "group_checkpoints" ADD CONSTRAINT "group_checkpoints_tee_time_id_tee_times_id_fk" FOREIGN KEY ("tee_time_id") REFERENCES "public"."tee_times"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'group_checkpoints'
      AND c.conname = 'group_checkpoints_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "group_checkpoints" ADD CONSTRAINT "group_checkpoints_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'gst_invoices'
      AND c.conname = 'gst_invoices_league_member_id_league_members_id_fk'
  ) THEN
    ALTER TABLE "gst_invoices" ADD CONSTRAINT "gst_invoices_league_member_id_league_members_id_fk" FOREIGN KEY ("league_member_id") REFERENCES "public"."league_members"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'gst_invoices'
      AND c.conname = 'gst_invoices_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "gst_invoices" ADD CONSTRAINT "gst_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'gst_invoices'
      AND c.conname = 'gst_invoices_pos_transaction_id_pos_transactions_id_fk'
  ) THEN
    ALTER TABLE "gst_invoices" ADD CONSTRAINT "gst_invoices_pos_transaction_id_pos_transactions_id_fk" FOREIGN KEY ("pos_transaction_id") REFERENCES "public"."pos_transactions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'gst_invoices'
      AND c.conname = 'gst_invoices_shop_order_id_shop_orders_id_fk'
  ) THEN
    ALTER TABLE "gst_invoices" ADD CONSTRAINT "gst_invoices_shop_order_id_shop_orders_id_fk" FOREIGN KEY ("shop_order_id") REFERENCES "public"."shop_orders"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'gst_invoices'
      AND c.conname = 'gst_invoices_tournament_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "gst_invoices" ADD CONSTRAINT "gst_invoices_tournament_player_id_players_id_fk" FOREIGN KEY ("tournament_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'guest_passes'
      AND c.conname = 'guest_passes_checked_in_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "guest_passes" ADD CONSTRAINT "guest_passes_checked_in_by_user_id_app_users_id_fk" FOREIGN KEY ("checked_in_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'guest_passes'
      AND c.conname = 'guest_passes_invited_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "guest_passes" ADD CONSTRAINT "guest_passes_invited_by_user_id_app_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'guest_passes'
      AND c.conname = 'guest_passes_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "guest_passes" ADD CONSTRAINT "guest_passes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'guest_passes'
      AND c.conname = 'guest_passes_tee_booking_id_tee_bookings_id_fk'
  ) THEN
    ALTER TABLE "guest_passes" ADD CONSTRAINT "guest_passes_tee_booking_id_tee_bookings_id_fk" FOREIGN KEY ("tee_booking_id") REFERENCES "public"."tee_bookings"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'guest_passes'
      AND c.conname = 'guest_passes_tee_booking_player_id_tee_booking_players_id_fk'
  ) THEN
    ALTER TABLE "guest_passes" ADD CONSTRAINT "guest_passes_tee_booking_player_id_tee_booking_players_id_fk" FOREIGN KEY ("tee_booking_player_id") REFERENCES "public"."tee_booking_players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'guest_policy'
      AND c.conname = 'guest_policy_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "guest_policy" ADD CONSTRAINT "guest_policy_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'handicap_adjustments'
      AND c.conname = 'handicap_adjustments_adjusted_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "handicap_adjustments" ADD CONSTRAINT "handicap_adjustments_adjusted_by_user_id_app_users_id_fk" FOREIGN KEY ("adjusted_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'handicap_adjustments'
      AND c.conname = 'handicap_adjustments_flag_id_exceptional_score_flags_id_fk'
  ) THEN
    ALTER TABLE "handicap_adjustments" ADD CONSTRAINT "handicap_adjustments_flag_id_exceptional_score_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."exceptional_score_flags"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'handicap_adjustments'
      AND c.conname = 'handicap_adjustments_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "handicap_adjustments" ADD CONSTRAINT "handicap_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'handicap_adjustments'
      AND c.conname = 'handicap_adjustments_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "handicap_adjustments" ADD CONSTRAINT "handicap_adjustments_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'handicap_adjustments'
      AND c.conname = 'handicap_adjustments_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "handicap_adjustments" ADD CONSTRAINT "handicap_adjustments_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'handicap_review_cases'
      AND c.conname = 'handicap_review_cases_adjustment_id_handicap_adjustments_id_fk'
  ) THEN
    ALTER TABLE "handicap_review_cases" ADD CONSTRAINT "handicap_review_cases_adjustment_id_handicap_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."handicap_adjustments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'handicap_review_cases'
      AND c.conname = 'handicap_review_cases_flag_id_exceptional_score_flags_id_fk'
  ) THEN
    ALTER TABLE "handicap_review_cases" ADD CONSTRAINT "handicap_review_cases_flag_id_exceptional_score_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."exceptional_score_flags"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'highlight_caption_templates'
      AND c.conname = 'highlight_caption_templates_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "highlight_caption_templates" ADD CONSTRAINT "highlight_caption_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'highlight_caption_templates'
      AND c.conname = 'highlight_caption_templates_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "highlight_caption_templates" ADD CONSTRAINT "highlight_caption_templates_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'highlight_reel_engagements'
      AND c.conname = 'highlight_reel_engagements_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "highlight_reel_engagements" ADD CONSTRAINT "highlight_reel_engagements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'highlight_reel_engagements'
      AND c.conname = 'highlight_reel_engagements_reel_id_highlight_reels_id_fk'
  ) THEN
    ALTER TABLE "highlight_reel_engagements" ADD CONSTRAINT "highlight_reel_engagements_reel_id_highlight_reels_id_fk" FOREIGN KEY ("reel_id") REFERENCES "public"."highlight_reels"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'highlight_reel_engagements'
      AND c.conname = 'highlight_reel_engagements_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "highlight_reel_engagements" ADD CONSTRAINT "highlight_reel_engagements_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'highlight_reels'
      AND c.conname = 'highlight_reels_feed_post_id_feed_posts_id_fk'
  ) THEN
    ALTER TABLE "highlight_reels" ADD CONSTRAINT "highlight_reels_feed_post_id_feed_posts_id_fk" FOREIGN KEY ("feed_post_id") REFERENCES "public"."feed_posts"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'highlight_reels'
      AND c.conname = 'highlight_reels_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "highlight_reels" ADD CONSTRAINT "highlight_reels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'highlight_reels'
      AND c.conname = 'highlight_reels_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "highlight_reels" ADD CONSTRAINT "highlight_reels_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'highlight_reels'
      AND c.conname = 'highlight_reels_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "highlight_reels" ADD CONSTRAINT "highlight_reels_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'highlight_reels'
      AND c.conname = 'highlight_reels_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "highlight_reels" ADD CONSTRAINT "highlight_reels_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'highlight_render_events'
      AND c.conname = 'highlight_render_events_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "highlight_render_events" ADD CONSTRAINT "highlight_render_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'highlight_render_events'
      AND c.conname = 'highlight_render_events_reel_id_highlight_reels_id_fk'
  ) THEN
    ALTER TABLE "highlight_render_events" ADD CONSTRAINT "highlight_render_events_reel_id_highlight_reels_id_fk" FOREIGN KEY ("reel_id") REFERENCES "public"."highlight_reels"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'highlight_render_events'
      AND c.conname = 'highlight_render_events_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "highlight_render_events" ADD CONSTRAINT "highlight_render_events_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'hole_hazards'
      AND c.conname = 'hole_hazards_course_id_courses_id_fk'
  ) THEN
    ALTER TABLE "hole_hazards" ADD CONSTRAINT "hole_hazards_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'hole_pin_positions'
      AND c.conname = 'hole_pin_positions_general_play_round_id_fk'
  ) THEN
    ALTER TABLE "hole_pin_positions" ADD CONSTRAINT "hole_pin_positions_general_play_round_id_fk" FOREIGN KEY ("general_play_round_id") REFERENCES "public"."general_play_rounds"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'hole_pin_positions'
      AND c.conname = 'hole_pin_positions_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "hole_pin_positions" ADD CONSTRAINT "hole_pin_positions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'hole_pin_positions'
      AND c.conname = 'hole_pin_positions_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "hole_pin_positions" ADD CONSTRAINT "hole_pin_positions_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'hr_active_sessions'
      AND c.conname = 'hr_active_sessions_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "hr_active_sessions" ADD CONSTRAINT "hr_active_sessions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'hr_samples'
      AND c.conname = 'hr_samples_general_play_round_id_general_play_rounds_id_fk'
  ) THEN
    ALTER TABLE "hr_samples" ADD CONSTRAINT "hr_samples_general_play_round_id_general_play_rounds_id_fk" FOREIGN KEY ("general_play_round_id") REFERENCES "public"."general_play_rounds"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'hr_samples'
      AND c.conname = 'hr_samples_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "hr_samples" ADD CONSTRAINT "hr_samples_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'hr_samples'
      AND c.conname = 'hr_samples_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "hr_samples" ADD CONSTRAINT "hr_samples_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'hr_samples'
      AND c.conname = 'hr_samples_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "hr_samples" ADD CONSTRAINT "hr_samples_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'interclub_fixtures'
      AND c.conname = 'interclub_fixtures_league_id_leagues_id_fk'
  ) THEN
    ALTER TABLE "interclub_fixtures" ADD CONSTRAINT "interclub_fixtures_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'invoice_sequences'
      AND c.conname = 'invoice_sequences_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'league_divisions'
      AND c.conname = 'league_divisions_league_id_leagues_id_fk'
  ) THEN
    ALTER TABLE "league_divisions" ADD CONSTRAINT "league_divisions_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'league_members'
      AND c.conname = 'league_members_division_id_league_divisions_id_fk'
  ) THEN
    ALTER TABLE "league_members" ADD CONSTRAINT "league_members_division_id_league_divisions_id_fk" FOREIGN KEY ("division_id") REFERENCES "public"."league_divisions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'league_staff'
      AND c.conname = 'league_staff_invited_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "league_staff" ADD CONSTRAINT "league_staff_invited_by_user_id_app_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'league_staff'
      AND c.conname = 'league_staff_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "league_staff" ADD CONSTRAINT "league_staff_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'lesson_bookings'
      AND c.conname = 'lesson_bookings_pro_id_teaching_pros_id_fk'
  ) THEN
    ALTER TABLE "lesson_bookings" ADD CONSTRAINT "lesson_bookings_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'lesson_types'
      AND c.conname = 'lesson_types_pro_id_teaching_pros_id_fk'
  ) THEN
    ALTER TABLE "lesson_types" ADD CONSTRAINT "lesson_types_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'levy_ledger_email_org_runs'
      AND c.conname = 'levy_ledger_email_org_runs_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "levy_ledger_email_org_runs" ADD CONSTRAINT "levy_ledger_email_org_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'levy_ledger_email_org_runs'
      AND c.conname = 'levy_ledger_email_org_runs_schedule_id_fk'
  ) THEN
    ALTER TABLE "levy_ledger_email_org_runs" ADD CONSTRAINT "levy_ledger_email_org_runs_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."levy_ledger_email_org_schedules"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'levy_ledger_email_org_schedules'
      AND c.conname = 'levy_ledger_email_org_schedules_created_by_user_id_fk'
  ) THEN
    ALTER TABLE "levy_ledger_email_org_schedules" ADD CONSTRAINT "levy_ledger_email_org_schedules_created_by_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'levy_ledger_email_org_schedules'
      AND c.conname = 'levy_ledger_email_org_schedules_organization_id_fk'
  ) THEN
    ALTER TABLE "levy_ledger_email_org_schedules" ADD CONSTRAINT "levy_ledger_email_org_schedules_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'levy_ledger_email_runs'
      AND c.conname = 'levy_ledger_email_runs_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "levy_ledger_email_runs" ADD CONSTRAINT "levy_ledger_email_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'levy_ledger_email_runs'
      AND c.conname = 'levy_ledger_email_runs_schedule_id_fk'
  ) THEN
    ALTER TABLE "levy_ledger_email_runs" ADD CONSTRAINT "levy_ledger_email_runs_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."levy_ledger_email_schedules"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'levy_ledger_email_schedules'
      AND c.conname = 'levy_ledger_email_schedules_created_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "levy_ledger_email_schedules" ADD CONSTRAINT "levy_ledger_email_schedules_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'levy_ledger_email_schedules'
      AND c.conname = 'levy_ledger_email_schedules_levy_id_member_levies_id_fk'
  ) THEN
    ALTER TABLE "levy_ledger_email_schedules" ADD CONSTRAINT "levy_ledger_email_schedules_levy_id_member_levies_id_fk" FOREIGN KEY ("levy_id") REFERENCES "public"."member_levies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'levy_ledger_email_schedules'
      AND c.conname = 'levy_ledger_email_schedules_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "levy_ledger_email_schedules" ADD CONSTRAINT "levy_ledger_email_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'locker_assignments'
      AND c.conname = 'locker_assignments_assigned_by_app_users_id_fk'
  ) THEN
    ALTER TABLE "locker_assignments" ADD CONSTRAINT "locker_assignments_assigned_by_app_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'locker_assignments'
      AND c.conname = 'locker_assignments_locker_id_lockers_id_fk'
  ) THEN
    ALTER TABLE "locker_assignments" ADD CONSTRAINT "locker_assignments_locker_id_lockers_id_fk" FOREIGN KEY ("locker_id") REFERENCES "public"."lockers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'locker_assignments'
      AND c.conname = 'locker_assignments_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "locker_assignments" ADD CONSTRAINT "locker_assignments_member_id_club_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."club_members"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'locker_assignments'
      AND c.conname = 'locker_assignments_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "locker_assignments" ADD CONSTRAINT "locker_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'locker_audit'
      AND c.conname = 'locker_audit_locker_id_lockers_id_fk'
  ) THEN
    ALTER TABLE "locker_audit" ADD CONSTRAINT "locker_audit_locker_id_lockers_id_fk" FOREIGN KEY ("locker_id") REFERENCES "public"."lockers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'locker_audit'
      AND c.conname = 'locker_audit_new_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "locker_audit" ADD CONSTRAINT "locker_audit_new_member_id_club_members_id_fk" FOREIGN KEY ("new_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'locker_audit'
      AND c.conname = 'locker_audit_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "locker_audit" ADD CONSTRAINT "locker_audit_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'locker_audit'
      AND c.conname = 'locker_audit_performed_by_app_users_id_fk'
  ) THEN
    ALTER TABLE "locker_audit" ADD CONSTRAINT "locker_audit_performed_by_app_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'locker_audit'
      AND c.conname = 'locker_audit_previous_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "locker_audit" ADD CONSTRAINT "locker_audit_previous_member_id_club_members_id_fk" FOREIGN KEY ("previous_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'locker_waitlist'
      AND c.conname = 'locker_waitlist_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "locker_waitlist" ADD CONSTRAINT "locker_waitlist_member_id_club_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'locker_waitlist'
      AND c.conname = 'locker_waitlist_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "locker_waitlist" ADD CONSTRAINT "locker_waitlist_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'lockers'
      AND c.conname = 'lockers_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "lockers" ADD CONSTRAINT "lockers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'maintenance_tasks'
      AND c.conname = 'maintenance_tasks_assigned_to_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "maintenance_tasks" ADD CONSTRAINT "maintenance_tasks_assigned_to_id_app_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'maintenance_tasks'
      AND c.conname = 'maintenance_tasks_created_by_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "maintenance_tasks" ADD CONSTRAINT "maintenance_tasks_created_by_id_app_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'maintenance_tasks'
      AND c.conname = 'maintenance_tasks_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "maintenance_tasks" ADD CONSTRAINT "maintenance_tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'manual_entry_alerts'
      AND c.conname = 'manual_entry_alerts_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "manual_entry_alerts" ADD CONSTRAINT "manual_entry_alerts_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'manual_entry_alerts'
      AND c.conname = 'manual_entry_alerts_submission_id_round_submissions_id_fk'
  ) THEN
    ALTER TABLE "manual_entry_alerts" ADD CONSTRAINT "manual_entry_alerts_submission_id_round_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."round_submissions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'manual_entry_alerts'
      AND c.conname = 'manual_entry_alerts_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "manual_entry_alerts" ADD CONSTRAINT "manual_entry_alerts_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'marketplace_bookings'
      AND c.conname = 'marketplace_bookings_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "marketplace_bookings" ADD CONSTRAINT "marketplace_bookings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'marketplace_bookings'
      AND c.conname = 'marketplace_bookings_slot_id_marketplace_slots_id_fk'
  ) THEN
    ALTER TABLE "marketplace_bookings" ADD CONSTRAINT "marketplace_bookings_slot_id_marketplace_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."marketplace_slots"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'marketplace_bookings'
      AND c.conname = 'marketplace_bookings_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "marketplace_bookings" ADD CONSTRAINT "marketplace_bookings_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'marketplace_saved_search_alerts'
      AND c.conname = 'marketplace_saved_search_alerts_search_id_fk'
  ) THEN
    ALTER TABLE "marketplace_saved_search_alerts" ADD CONSTRAINT "marketplace_saved_search_alerts_search_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."marketplace_saved_searches"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'marketplace_saved_search_alerts'
      AND c.conname = 'marketplace_saved_search_alerts_slot_id_marketplace_slots_id_fk'
  ) THEN
    ALTER TABLE "marketplace_saved_search_alerts" ADD CONSTRAINT "marketplace_saved_search_alerts_slot_id_marketplace_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."marketplace_slots"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'marketplace_saved_searches'
      AND c.conname = 'marketplace_saved_searches_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "marketplace_saved_searches" ADD CONSTRAINT "marketplace_saved_searches_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'marketplace_slots'
      AND c.conname = 'marketplace_slots_course_id_courses_id_fk'
  ) THEN
    ALTER TABLE "marketplace_slots" ADD CONSTRAINT "marketplace_slots_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'marketplace_slots'
      AND c.conname = 'marketplace_slots_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "marketplace_slots" ADD CONSTRAINT "marketplace_slots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'marshal_pace_alerts'
      AND c.conname = 'marshal_pace_alerts_acknowledged_by_app_users_id_fk'
  ) THEN
    ALTER TABLE "marshal_pace_alerts" ADD CONSTRAINT "marshal_pace_alerts_acknowledged_by_app_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'marshal_pace_alerts'
      AND c.conname = 'marshal_pace_alerts_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "marshal_pace_alerts" ADD CONSTRAINT "marshal_pace_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'marshal_pace_alerts'
      AND c.conname = 'marshal_pace_alerts_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "marshal_pace_alerts" ADD CONSTRAINT "marshal_pace_alerts_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'match_play_brackets'
      AND c.conname = 'match_play_brackets_champion_id_players_id_fk'
  ) THEN
    ALTER TABLE "match_play_brackets" ADD CONSTRAINT "match_play_brackets_champion_id_players_id_fk" FOREIGN KEY ("champion_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'match_play_brackets'
      AND c.conname = 'match_play_brackets_runner_up_id_players_id_fk'
  ) THEN
    ALTER TABLE "match_play_brackets" ADD CONSTRAINT "match_play_brackets_runner_up_id_players_id_fk" FOREIGN KEY ("runner_up_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'match_play_brackets'
      AND c.conname = 'match_play_brackets_seeded_from_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "match_play_brackets" ADD CONSTRAINT "match_play_brackets_seeded_from_tournament_id_tournaments_id_fk" FOREIGN KEY ("seeded_from_tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'match_play_brackets'
      AND c.conname = 'match_play_brackets_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "match_play_brackets" ADD CONSTRAINT "match_play_brackets_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_access_cards'
      AND c.conname = 'member_access_cards_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_access_cards" ADD CONSTRAINT "member_access_cards_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_access_cards'
      AND c.conname = 'member_access_cards_issued_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_access_cards" ADD CONSTRAINT "member_access_cards_issued_by_user_id_app_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_access_cards'
      AND c.conname = 'member_access_cards_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_access_cards" ADD CONSTRAINT "member_access_cards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_access_log'
      AND c.conname = 'member_access_log_card_id_member_access_cards_id_fk'
  ) THEN
    ALTER TABLE "member_access_log" ADD CONSTRAINT "member_access_log_card_id_member_access_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."member_access_cards"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_access_log'
      AND c.conname = 'member_access_log_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_access_log" ADD CONSTRAINT "member_access_log_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_access_log'
      AND c.conname = 'member_access_log_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_access_log" ADD CONSTRAINT "member_access_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_audit_log'
      AND c.conname = 'member_audit_log_actor_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_audit_log" ADD CONSTRAINT "member_audit_log_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_audit_log'
      AND c.conname = 'member_audit_log_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_audit_log" ADD CONSTRAINT "member_audit_log_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_audit_log'
      AND c.conname = 'member_audit_log_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_audit_log" ADD CONSTRAINT "member_audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_comm_prefs'
      AND c.conname = 'member_comm_prefs_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_comm_prefs" ADD CONSTRAINT "member_comm_prefs_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_comm_prefs'
      AND c.conname = 'member_comm_prefs_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_comm_prefs" ADD CONSTRAINT "member_comm_prefs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_committee_roles'
      AND c.conname = 'member_committee_roles_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_committee_roles" ADD CONSTRAINT "member_committee_roles_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_committee_roles'
      AND c.conname = 'member_committee_roles_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_committee_roles" ADD CONSTRAINT "member_committee_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_consents'
      AND c.conname = 'member_consents_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_consents" ADD CONSTRAINT "member_consents_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_consents'
      AND c.conname = 'member_consents_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_consents" ADD CONSTRAINT "member_consents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_consents'
      AND c.conname = 'member_consents_recorded_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_consents" ADD CONSTRAINT "member_consents_recorded_by_user_id_app_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_data_requests'
      AND c.conname = 'member_data_requests_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_data_requests" ADD CONSTRAINT "member_data_requests_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_data_requests'
      AND c.conname = 'member_data_requests_handler_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_data_requests" ADD CONSTRAINT "member_data_requests_handler_user_id_app_users_id_fk" FOREIGN KEY ("handler_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_data_requests'
      AND c.conname = 'member_data_requests_last_in_app_message_id_fk'
  ) THEN
    ALTER TABLE "member_data_requests" ADD CONSTRAINT "member_data_requests_last_in_app_message_id_fk" FOREIGN KEY ("last_in_app_message_id") REFERENCES "public"."member_messages"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_data_requests'
      AND c.conname = 'member_data_requests_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_data_requests" ADD CONSTRAINT "member_data_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_disciplinary'
      AND c.conname = 'member_disciplinary_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_disciplinary" ADD CONSTRAINT "member_disciplinary_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_disciplinary'
      AND c.conname = 'member_disciplinary_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_disciplinary" ADD CONSTRAINT "member_disciplinary_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_disciplinary'
      AND c.conname = 'member_disciplinary_recorded_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_disciplinary" ADD CONSTRAINT "member_disciplinary_recorded_by_user_id_app_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_document_versions'
      AND c.conname = 'member_document_versions_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_document_versions" ADD CONSTRAINT "member_document_versions_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_document_versions'
      AND c.conname = 'member_document_versions_member_document_id_fk'
  ) THEN
    ALTER TABLE "member_document_versions" ADD CONSTRAINT "member_document_versions_member_document_id_fk" FOREIGN KEY ("member_document_id") REFERENCES "public"."member_documents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_document_versions'
      AND c.conname = 'member_document_versions_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_document_versions" ADD CONSTRAINT "member_document_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_document_versions'
      AND c.conname = 'member_document_versions_replaced_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_document_versions" ADD CONSTRAINT "member_document_versions_replaced_by_user_id_app_users_id_fk" FOREIGN KEY ("replaced_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_documents'
      AND c.conname = 'member_documents_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_documents" ADD CONSTRAINT "member_documents_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_documents'
      AND c.conname = 'member_documents_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_documents" ADD CONSTRAINT "member_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_documents'
      AND c.conname = 'member_documents_rejected_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_documents" ADD CONSTRAINT "member_documents_rejected_by_user_id_app_users_id_fk" FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_documents'
      AND c.conname = 'member_documents_uploaded_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_documents" ADD CONSTRAINT "member_documents_uploaded_by_user_id_app_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_documents'
      AND c.conname = 'member_documents_verified_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_documents" ADD CONSTRAINT "member_documents_verified_by_user_id_app_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_family_links'
      AND c.conname = 'member_family_links_created_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_family_links" ADD CONSTRAINT "member_family_links_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_family_links'
      AND c.conname = 'member_family_links_linked_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_family_links" ADD CONSTRAINT "member_family_links_linked_member_id_club_members_id_fk" FOREIGN KEY ("linked_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_family_links'
      AND c.conname = 'member_family_links_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_family_links" ADD CONSTRAINT "member_family_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_family_links'
      AND c.conname = 'member_family_links_primary_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_family_links" ADD CONSTRAINT "member_family_links_primary_member_id_club_members_id_fk" FOREIGN KEY ("primary_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_internal_notes'
      AND c.conname = 'member_internal_notes_author_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_internal_notes" ADD CONSTRAINT "member_internal_notes_author_id_app_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_internal_notes'
      AND c.conname = 'member_internal_notes_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_internal_notes" ADD CONSTRAINT "member_internal_notes_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_internal_notes'
      AND c.conname = 'member_internal_notes_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_internal_notes" ADD CONSTRAINT "member_internal_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levies'
      AND c.conname = 'member_levies_applied_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_levies" ADD CONSTRAINT "member_levies_applied_by_user_id_app_users_id_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levies'
      AND c.conname = 'member_levies_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_levies" ADD CONSTRAINT "member_levies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levy_charge_events'
      AND c.conname = 'member_levy_charge_events_actor_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_levy_charge_events" ADD CONSTRAINT "member_levy_charge_events_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levy_charge_events'
      AND c.conname = 'member_levy_charge_events_charge_id_member_levy_charges_id_fk'
  ) THEN
    ALTER TABLE "member_levy_charge_events" ADD CONSTRAINT "member_levy_charge_events_charge_id_member_levy_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."member_levy_charges"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levy_charge_events'
      AND c.conname = 'member_levy_charge_events_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_levy_charge_events" ADD CONSTRAINT "member_levy_charge_events_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levy_charge_events'
      AND c.conname = 'member_levy_charge_events_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_levy_charge_events" ADD CONSTRAINT "member_levy_charge_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levy_charge_events'
      AND c.conname = 'member_levy_charge_events_reverses_fk'
  ) THEN
    ALTER TABLE "member_levy_charge_events" ADD CONSTRAINT "member_levy_charge_events_reverses_fk" FOREIGN KEY ("reverses_event_id") REFERENCES "public"."member_levy_charge_events"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levy_charge_payments'
      AND c.conname = 'member_levy_charge_payments_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_levy_charge_payments" ADD CONSTRAINT "member_levy_charge_payments_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levy_charge_payments'
      AND c.conname = 'member_levy_charge_payments_levy_charge_id_fk'
  ) THEN
    ALTER TABLE "member_levy_charge_payments" ADD CONSTRAINT "member_levy_charge_payments_levy_charge_id_fk" FOREIGN KEY ("levy_charge_id") REFERENCES "public"."member_levy_charges"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levy_charge_payments'
      AND c.conname = 'member_levy_charge_payments_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_levy_charge_payments" ADD CONSTRAINT "member_levy_charge_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levy_charges'
      AND c.conname = 'member_levy_charges_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_levy_charges" ADD CONSTRAINT "member_levy_charges_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levy_charges'
      AND c.conname = 'member_levy_charges_levy_id_member_levies_id_fk'
  ) THEN
    ALTER TABLE "member_levy_charges" ADD CONSTRAINT "member_levy_charges_levy_id_member_levies_id_fk" FOREIGN KEY ("levy_id") REFERENCES "public"."member_levies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levy_receipt_attempts'
      AND c.conname = 'member_levy_receipt_attempts_charge_id_fk'
  ) THEN
    ALTER TABLE "member_levy_receipt_attempts" ADD CONSTRAINT "member_levy_receipt_attempts_charge_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."member_levy_charges"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levy_receipt_attempts'
      AND c.conname = 'member_levy_receipt_attempts_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_levy_receipt_attempts" ADD CONSTRAINT "member_levy_receipt_attempts_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_levy_receipt_attempts'
      AND c.conname = 'member_levy_receipt_attempts_organization_id_fk'
  ) THEN
    ALTER TABLE "member_levy_receipt_attempts" ADD CONSTRAINT "member_levy_receipt_attempts_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_lifecycle_events'
      AND c.conname = 'member_lifecycle_events_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_lifecycle_events" ADD CONSTRAINT "member_lifecycle_events_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_lifecycle_events'
      AND c.conname = 'member_lifecycle_events_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_lifecycle_events" ADD CONSTRAINT "member_lifecycle_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_lifecycle_events'
      AND c.conname = 'member_lifecycle_events_performed_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_lifecycle_events" ADD CONSTRAINT "member_lifecycle_events_performed_by_user_id_app_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_messages'
      AND c.conname = 'member_messages_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_messages" ADD CONSTRAINT "member_messages_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_messages'
      AND c.conname = 'member_messages_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_messages" ADD CONSTRAINT "member_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_messages'
      AND c.conname = 'member_messages_sender_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_messages" ADD CONSTRAINT "member_messages_sender_user_id_app_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_milestones'
      AND c.conname = 'member_milestones_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_milestones" ADD CONSTRAINT "member_milestones_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_milestones'
      AND c.conname = 'member_milestones_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_milestones" ADD CONSTRAINT "member_milestones_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_milestones'
      AND c.conname = 'member_milestones_verified_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_milestones" ADD CONSTRAINT "member_milestones_verified_by_user_id_app_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_profile_ext'
      AND c.conname = 'member_profile_ext_club_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "member_profile_ext" ADD CONSTRAINT "member_profile_ext_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_profile_ext'
      AND c.conname = 'member_profile_ext_kyc_verified_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_profile_ext" ADD CONSTRAINT "member_profile_ext_kyc_verified_by_user_id_app_users_id_fk" FOREIGN KEY ("kyc_verified_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_profile_ext'
      AND c.conname = 'member_profile_ext_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_profile_ext" ADD CONSTRAINT "member_profile_ext_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_saved_segments'
      AND c.conname = 'member_saved_segments_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "member_saved_segments" ADD CONSTRAINT "member_saved_segments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'member_saved_segments'
      AND c.conname = 'member_saved_segments_owner_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "member_saved_segments" ADD CONSTRAINT "member_saved_segments_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'moderation_inbox'
      AND c.conname = 'moderation_inbox_assigned_to_app_users_id_fk'
  ) THEN
    ALTER TABLE "moderation_inbox" ADD CONSTRAINT "moderation_inbox_assigned_to_app_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'moderation_inbox'
      AND c.conname = 'moderation_inbox_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "moderation_inbox" ADD CONSTRAINT "moderation_inbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'moderation_inbox'
      AND c.conname = 'moderation_inbox_resolved_by_app_users_id_fk'
  ) THEN
    ALTER TABLE "moderation_inbox" ADD CONSTRAINT "moderation_inbox_resolved_by_app_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'near_miss_prompts'
      AND c.conname = 'near_miss_prompts_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "near_miss_prompts" ADD CONSTRAINT "near_miss_prompts_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'notice_board_articles'
      AND c.conname = 'notice_board_articles_author_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "notice_board_articles" ADD CONSTRAINT "notice_board_articles_author_user_id_app_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'notice_board_articles'
      AND c.conname = 'notice_board_articles_category_id_notice_board_categories_id_fk'
  ) THEN
    ALTER TABLE "notice_board_articles" ADD CONSTRAINT "notice_board_articles_category_id_notice_board_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."notice_board_categories"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'notice_board_articles'
      AND c.conname = 'notice_board_articles_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "notice_board_articles" ADD CONSTRAINT "notice_board_articles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'notice_board_categories'
      AND c.conname = 'notice_board_categories_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "notice_board_categories" ADD CONSTRAINT "notice_board_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'notice_board_reads'
      AND c.conname = 'notice_board_reads_article_id_notice_board_articles_id_fk'
  ) THEN
    ALTER TABLE "notice_board_reads" ADD CONSTRAINT "notice_board_reads_article_id_notice_board_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."notice_board_articles"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'notice_board_reads'
      AND c.conname = 'notice_board_reads_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "notice_board_reads" ADD CONSTRAINT "notice_board_reads_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'notification_audit_log'
      AND c.conname = 'notification_audit_log_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "notification_audit_log" ADD CONSTRAINT "notification_audit_log_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'notification_digest_queue'
      AND c.conname = 'notification_digest_queue_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "notification_digest_queue" ADD CONSTRAINT "notification_digest_queue_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'odds_telemetry'
      AND c.conname = 'odds_telemetry_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "odds_telemetry" ADD CONSTRAINT "odds_telemetry_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'odds_telemetry'
      AND c.conname = 'odds_telemetry_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "odds_telemetry" ADD CONSTRAINT "odds_telemetry_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'operational_documents'
      AND c.conname = 'operational_documents_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "operational_documents" ADD CONSTRAINT "operational_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'operational_documents'
      AND c.conname = 'operational_documents_uploaded_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "operational_documents" ADD CONSTRAINT "operational_documents_uploaded_by_user_id_app_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'org_ghin_credentials'
      AND c.conname = 'org_ghin_credentials_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "org_ghin_credentials" ADD CONSTRAINT "org_ghin_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'org_memberships'
      AND c.conname = 'org_memberships_vendor_operator_id_vendor_operators_id_fk'
  ) THEN
    ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_vendor_operator_id_vendor_operators_id_fk" FOREIGN KEY ("vendor_operator_id") REFERENCES "public"."vendor_operators"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'org_plan_overrides'
      AND c.conname = 'org_plan_overrides_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "org_plan_overrides" ADD CONSTRAINT "org_plan_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'org_plan_overrides'
      AND c.conname = 'org_plan_overrides_override_set_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "org_plan_overrides" ADD CONSTRAINT "org_plan_overrides_override_set_by_user_id_app_users_id_fk" FOREIGN KEY ("override_set_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'payment_processor_configs'
      AND c.conname = 'payment_processor_configs_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "payment_processor_configs" ADD CONSTRAINT "payment_processor_configs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'pending_storage_deletions'
      AND c.conname = 'pending_storage_deletions_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "pending_storage_deletions" ADD CONSTRAINT "pending_storage_deletions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'pos_transactions'
      AND c.conname = 'pos_transactions_gift_card_id_gift_cards_id_fk'
  ) THEN
    ALTER TABLE "pos_transactions" ADD CONSTRAINT "pos_transactions_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'pos_transactions'
      AND c.conname = 'pos_transactions_vendor_operator_id_vendor_operators_id_fk'
  ) THEN
    ALTER TABLE "pos_transactions" ADD CONSTRAINT "pos_transactions_vendor_operator_id_vendor_operators_id_fk" FOREIGN KEY ("vendor_operator_id") REFERENCES "public"."vendor_operators"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'post_event_survey_responses'
      AND c.conname = 'post_event_survey_responses_survey_id_post_event_surveys_id_fk'
  ) THEN
    ALTER TABLE "post_event_survey_responses" ADD CONSTRAINT "post_event_survey_responses_survey_id_post_event_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."post_event_surveys"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'post_event_survey_responses'
      AND c.conname = 'post_event_survey_responses_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "post_event_survey_responses" ADD CONSTRAINT "post_event_survey_responses_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'post_event_surveys'
      AND c.conname = 'post_event_surveys_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "post_event_surveys" ADD CONSTRAINT "post_event_surveys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'post_event_surveys'
      AND c.conname = 'post_event_surveys_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "post_event_surveys" ADD CONSTRAINT "post_event_surveys_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'practice_sessions'
      AND c.conname = 'practice_sessions_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'practice_sessions'
      AND c.conname = 'practice_sessions_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'practice_sessions'
      AND c.conname = 'practice_sessions_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'pro_availability'
      AND c.conname = 'pro_availability_pro_id_teaching_pros_id_fk'
  ) THEN
    ALTER TABLE "pro_availability" ADD CONSTRAINT "pro_availability_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'product_waitlist'
      AND c.conname = 'product_waitlist_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "product_waitlist" ADD CONSTRAINT "product_waitlist_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'product_waitlist'
      AND c.conname = 'product_waitlist_product_id_shop_products_id_fk'
  ) THEN
    ALTER TABLE "product_waitlist" ADD CONSTRAINT "product_waitlist_product_id_shop_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'product_waitlist'
      AND c.conname = 'product_waitlist_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "product_waitlist" ADD CONSTRAINT "product_waitlist_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'product_waitlist'
      AND c.conname = 'product_waitlist_variant_id_shop_product_variants_id_fk'
  ) THEN
    ALTER TABLE "product_waitlist" ADD CONSTRAINT "product_waitlist_variant_id_shop_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."shop_product_variants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'profile_share_events'
      AND c.conname = 'profile_share_events_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "profile_share_events" ADD CONSTRAINT "profile_share_events_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'promotion_redemptions'
      AND c.conname = 'promotion_redemptions_order_id_shop_orders_id_fk'
  ) THEN
    ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_order_id_shop_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shop_orders"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'promotion_redemptions'
      AND c.conname = 'promotion_redemptions_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'promotion_redemptions'
      AND c.conname = 'promotion_redemptions_promotion_id_promotions_id_fk'
  ) THEN
    ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'promotion_redemptions'
      AND c.conname = 'promotion_redemptions_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'promotions'
      AND c.conname = 'promotions_created_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "promotions" ADD CONSTRAINT "promotions_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'promotions'
      AND c.conname = 'promotions_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "promotions" ADD CONSTRAINT "promotions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'purchase_order_lines'
      AND c.conname = 'purchase_order_lines_variant_id_shop_product_variants_id_fk'
  ) THEN
    ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_variant_id_shop_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."shop_product_variants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'range_bays'
      AND c.conname = 'range_bays_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "range_bays" ADD CONSTRAINT "range_bays_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'range_blackouts'
      AND c.conname = 'range_blackouts_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "range_blackouts" ADD CONSTRAINT "range_blackouts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'range_bookings'
      AND c.conname = 'range_bookings_bay_id_range_bays_id_fk'
  ) THEN
    ALTER TABLE "range_bookings" ADD CONSTRAINT "range_bookings_bay_id_range_bays_id_fk" FOREIGN KEY ("bay_id") REFERENCES "public"."range_bays"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'range_config'
      AND c.conname = 'range_config_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "range_config" ADD CONSTRAINT "range_config_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'range_slots'
      AND c.conname = 'range_slots_bay_id_range_bays_id_fk'
  ) THEN
    ALTER TABLE "range_slots" ADD CONSTRAINT "range_slots_bay_id_range_bays_id_fk" FOREIGN KEY ("bay_id") REFERENCES "public"."range_bays"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'registration_form_fields'
      AND c.conname = 'registration_form_fields_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "registration_form_fields" ADD CONSTRAINT "registration_form_fields_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'registration_form_responses'
      AND c.conname = 'registration_form_responses_field_id_fk'
  ) THEN
    ALTER TABLE "registration_form_responses" ADD CONSTRAINT "registration_form_responses_field_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."registration_form_fields"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'rental_assets'
      AND c.conname = 'rental_assets_category_id_rental_categories_id_fk'
  ) THEN
    ALTER TABLE "rental_assets" ADD CONSTRAINT "rental_assets_category_id_rental_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."rental_categories"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'rental_assets'
      AND c.conname = 'rental_assets_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "rental_assets" ADD CONSTRAINT "rental_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'rental_bookings'
      AND c.conname = 'rental_bookings_asset_id_rental_assets_id_fk'
  ) THEN
    ALTER TABLE "rental_bookings" ADD CONSTRAINT "rental_bookings_asset_id_rental_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."rental_assets"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'rental_bookings'
      AND c.conname = 'rental_bookings_booked_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "rental_bookings" ADD CONSTRAINT "rental_bookings_booked_by_user_id_app_users_id_fk" FOREIGN KEY ("booked_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'rental_bookings'
      AND c.conname = 'rental_bookings_checked_out_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "rental_bookings" ADD CONSTRAINT "rental_bookings_checked_out_by_user_id_app_users_id_fk" FOREIGN KEY ("checked_out_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'rental_bookings'
      AND c.conname = 'rental_bookings_member_id_club_members_id_fk'
  ) THEN
    ALTER TABLE "rental_bookings" ADD CONSTRAINT "rental_bookings_member_id_club_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'rental_bookings'
      AND c.conname = 'rental_bookings_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "rental_bookings" ADD CONSTRAINT "rental_bookings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'rental_bookings'
      AND c.conname = 'rental_bookings_returned_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "rental_bookings" ADD CONSTRAINT "rental_bookings_returned_by_user_id_app_users_id_fk" FOREIGN KEY ("returned_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'rental_bookings'
      AND c.conname = 'rental_bookings_tee_booking_id_tee_bookings_id_fk'
  ) THEN
    ALTER TABLE "rental_bookings" ADD CONSTRAINT "rental_bookings_tee_booking_id_tee_bookings_id_fk" FOREIGN KEY ("tee_booking_id") REFERENCES "public"."tee_bookings"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'rental_categories'
      AND c.conname = 'rental_categories_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "rental_categories" ADD CONSTRAINT "rental_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'repair_jobs'
      AND c.conname = 'repair_jobs_created_by_app_users_id_fk'
  ) THEN
    ALTER TABLE "repair_jobs" ADD CONSTRAINT "repair_jobs_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'repair_jobs'
      AND c.conname = 'repair_jobs_member_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "repair_jobs" ADD CONSTRAINT "repair_jobs_member_id_app_users_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'repair_jobs'
      AND c.conname = 'repair_jobs_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "repair_jobs" ADD CONSTRAINT "repair_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'repair_jobs'
      AND c.conname = 'repair_jobs_technician_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "repair_jobs" ADD CONSTRAINT "repair_jobs_technician_id_app_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'revenue_by_currency_email_runs'
      AND c.conname = 'revenue_by_currency_email_runs_org_fk'
  ) THEN
    ALTER TABLE "revenue_by_currency_email_runs" ADD CONSTRAINT "revenue_by_currency_email_runs_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'revenue_by_currency_email_runs'
      AND c.conname = 'revenue_by_currency_email_runs_schedule_id_fk'
  ) THEN
    ALTER TABLE "revenue_by_currency_email_runs" ADD CONSTRAINT "revenue_by_currency_email_runs_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."revenue_by_currency_email_schedules"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'revenue_by_currency_email_schedules'
      AND c.conname = 'revenue_by_currency_email_schedules_created_by_user_id_fk'
  ) THEN
    ALTER TABLE "revenue_by_currency_email_schedules" ADD CONSTRAINT "revenue_by_currency_email_schedules_created_by_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'revenue_by_currency_email_schedules'
      AND c.conname = 'revenue_by_currency_email_schedules_organization_id_fk'
  ) THEN
    ALTER TABLE "revenue_by_currency_email_schedules" ADD CONSTRAINT "revenue_by_currency_email_schedules_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'round_submission_ext'
      AND c.conname = 'round_submission_ext_committee_override_by_user_id_fk'
  ) THEN
    ALTER TABLE "round_submission_ext" ADD CONSTRAINT "round_submission_ext_committee_override_by_user_id_fk" FOREIGN KEY ("committee_override_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'round_submission_ext'
      AND c.conname = 'round_submission_ext_marker_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "round_submission_ext" ADD CONSTRAINT "round_submission_ext_marker_user_id_app_users_id_fk" FOREIGN KEY ("marker_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'round_submission_ext'
      AND c.conname = 'round_submission_ext_submission_id_round_submissions_id_fk'
  ) THEN
    ALTER TABLE "round_submission_ext" ADD CONSTRAINT "round_submission_ext_submission_id_round_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."round_submissions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ryder_cup_config'
      AND c.conname = 'ryder_cup_config_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "ryder_cup_config" ADD CONSTRAINT "ryder_cup_config_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ryder_cup_matches'
      AND c.conname = 'ryder_cup_matches_session_id_ryder_cup_sessions_id_fk'
  ) THEN
    ALTER TABLE "ryder_cup_matches" ADD CONSTRAINT "ryder_cup_matches_session_id_ryder_cup_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ryder_cup_sessions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ryder_cup_matches'
      AND c.conname = 'ryder_cup_matches_team1_player1_id_players_id_fk'
  ) THEN
    ALTER TABLE "ryder_cup_matches" ADD CONSTRAINT "ryder_cup_matches_team1_player1_id_players_id_fk" FOREIGN KEY ("team1_player1_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ryder_cup_matches'
      AND c.conname = 'ryder_cup_matches_team1_player2_id_players_id_fk'
  ) THEN
    ALTER TABLE "ryder_cup_matches" ADD CONSTRAINT "ryder_cup_matches_team1_player2_id_players_id_fk" FOREIGN KEY ("team1_player2_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ryder_cup_matches'
      AND c.conname = 'ryder_cup_matches_team2_player1_id_players_id_fk'
  ) THEN
    ALTER TABLE "ryder_cup_matches" ADD CONSTRAINT "ryder_cup_matches_team2_player1_id_players_id_fk" FOREIGN KEY ("team2_player1_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ryder_cup_matches'
      AND c.conname = 'ryder_cup_matches_team2_player2_id_players_id_fk'
  ) THEN
    ALTER TABLE "ryder_cup_matches" ADD CONSTRAINT "ryder_cup_matches_team2_player2_id_players_id_fk" FOREIGN KEY ("team2_player2_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ryder_cup_matches'
      AND c.conname = 'ryder_cup_matches_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "ryder_cup_matches" ADD CONSTRAINT "ryder_cup_matches_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'ryder_cup_sessions'
      AND c.conname = 'ryder_cup_sessions_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "ryder_cup_sessions" ADD CONSTRAINT "ryder_cup_sessions_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sales_attributions'
      AND c.conname = 'sales_attributions_commission_rule_id_commission_rules_id_fk'
  ) THEN
    ALTER TABLE "sales_attributions" ADD CONSTRAINT "sales_attributions_commission_rule_id_commission_rules_id_fk" FOREIGN KEY ("commission_rule_id") REFERENCES "public"."commission_rules"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sales_attributions'
      AND c.conname = 'sales_attributions_lesson_booking_id_lesson_bookings_id_fk'
  ) THEN
    ALTER TABLE "sales_attributions" ADD CONSTRAINT "sales_attributions_lesson_booking_id_lesson_bookings_id_fk" FOREIGN KEY ("lesson_booking_id") REFERENCES "public"."lesson_bookings"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sales_attributions'
      AND c.conname = 'sales_attributions_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "sales_attributions" ADD CONSTRAINT "sales_attributions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sales_attributions'
      AND c.conname = 'sales_attributions_payout_fk'
  ) THEN
    ALTER TABLE "sales_attributions" ADD CONSTRAINT "sales_attributions_payout_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."commission_payouts"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sales_attributions'
      AND c.conname = 'sales_attributions_pos_transaction_id_pos_transactions_id_fk'
  ) THEN
    ALTER TABLE "sales_attributions" ADD CONSTRAINT "sales_attributions_pos_transaction_id_pos_transactions_id_fk" FOREIGN KEY ("pos_transaction_id") REFERENCES "public"."pos_transactions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sales_attributions'
      AND c.conname = 'sales_attributions_staff_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "sales_attributions" ADD CONSTRAINT "sales_attributions_staff_user_id_app_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'saved_reports'
      AND c.conname = 'saved_reports_created_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'saved_reports'
      AND c.conname = 'saved_reports_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'scorecard_corrections'
      AND c.conname = 'scorecard_corrections_submission_id_round_submissions_id_fk'
  ) THEN
    ALTER TABLE "scorecard_corrections" ADD CONSTRAINT "scorecard_corrections_submission_id_round_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."round_submissions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'scorecard_flags'
      AND c.conname = 'scorecard_flags_submission_id_round_submissions_id_fk'
  ) THEN
    ALTER TABLE "scorecard_flags" ADD CONSTRAINT "scorecard_flags_submission_id_round_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."round_submissions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'scorer_pins'
      AND c.conname = 'scorer_pins_created_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "scorer_pins" ADD CONSTRAINT "scorer_pins_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'scorer_pins'
      AND c.conname = 'scorer_pins_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "scorer_pins" ADD CONSTRAINT "scorer_pins_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'scorer_pins'
      AND c.conname = 'scorer_pins_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "scorer_pins" ADD CONSTRAINT "scorer_pins_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_bundle_components'
      AND c.conname = 'shop_bundle_components_bundle_id_shop_bundles_id_fk'
  ) THEN
    ALTER TABLE "shop_bundle_components" ADD CONSTRAINT "shop_bundle_components_bundle_id_shop_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."shop_bundles"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_bundle_components'
      AND c.conname = 'shop_bundle_components_product_id_shop_products_id_fk'
  ) THEN
    ALTER TABLE "shop_bundle_components" ADD CONSTRAINT "shop_bundle_components_product_id_shop_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_bundle_components'
      AND c.conname = 'shop_bundle_components_variant_id_shop_product_variants_id_fk'
  ) THEN
    ALTER TABLE "shop_bundle_components" ADD CONSTRAINT "shop_bundle_components_variant_id_shop_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."shop_product_variants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_bundles'
      AND c.conname = 'shop_bundles_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "shop_bundles" ADD CONSTRAINT "shop_bundles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_category_flash_sales'
      AND c.conname = 'shop_category_flash_sales_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "shop_category_flash_sales" ADD CONSTRAINT "shop_category_flash_sales_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_locations'
      AND c.conname = 'shop_locations_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "shop_locations" ADD CONSTRAINT "shop_locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_order_events'
      AND c.conname = 'shop_order_events_order_id_shop_orders_id_fk'
  ) THEN
    ALTER TABLE "shop_order_events" ADD CONSTRAINT "shop_order_events_order_id_shop_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shop_orders"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_order_events'
      AND c.conname = 'shop_order_events_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "shop_order_events" ADD CONSTRAINT "shop_order_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_order_events'
      AND c.conname = 'shop_order_events_return_id_shop_returns_id_fk'
  ) THEN
    ALTER TABLE "shop_order_events" ADD CONSTRAINT "shop_order_events_return_id_shop_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."shop_returns"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_order_events'
      AND c.conname = 'shop_order_events_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "shop_order_events" ADD CONSTRAINT "shop_order_events_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_orders'
      AND c.conname = 'shop_orders_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_orders'
      AND c.conname = 'shop_orders_variant_id_shop_product_variants_id_fk'
  ) THEN
    ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_variant_id_shop_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."shop_product_variants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_product_variants'
      AND c.conname = 'shop_product_variants_supplier_id_suppliers_id_fk'
  ) THEN
    ALTER TABLE "shop_product_variants" ADD CONSTRAINT "shop_product_variants_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_return_blacklist'
      AND c.conname = 'shop_return_blacklist_blacklisted_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "shop_return_blacklist" ADD CONSTRAINT "shop_return_blacklist_blacklisted_by_user_id_app_users_id_fk" FOREIGN KEY ("blacklisted_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_return_blacklist'
      AND c.conname = 'shop_return_blacklist_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "shop_return_blacklist" ADD CONSTRAINT "shop_return_blacklist_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_return_blacklist'
      AND c.conname = 'shop_return_blacklist_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "shop_return_blacklist" ADD CONSTRAINT "shop_return_blacklist_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_return_items'
      AND c.conname = 'shop_return_items_exchange_variant_id_fk'
  ) THEN
    ALTER TABLE "shop_return_items" ADD CONSTRAINT "shop_return_items_exchange_variant_id_fk" FOREIGN KEY ("exchange_variant_id") REFERENCES "public"."shop_product_variants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_return_items'
      AND c.conname = 'shop_return_items_order_id_shop_orders_id_fk'
  ) THEN
    ALTER TABLE "shop_return_items" ADD CONSTRAINT "shop_return_items_order_id_shop_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shop_orders"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_return_items'
      AND c.conname = 'shop_return_items_product_id_shop_products_id_fk'
  ) THEN
    ALTER TABLE "shop_return_items" ADD CONSTRAINT "shop_return_items_product_id_shop_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shop_products"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_return_items'
      AND c.conname = 'shop_return_items_return_id_shop_returns_id_fk'
  ) THEN
    ALTER TABLE "shop_return_items" ADD CONSTRAINT "shop_return_items_return_id_shop_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."shop_returns"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_return_items'
      AND c.conname = 'shop_return_items_variant_id_shop_product_variants_id_fk'
  ) THEN
    ALTER TABLE "shop_return_items" ADD CONSTRAINT "shop_return_items_variant_id_shop_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."shop_product_variants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_returns'
      AND c.conname = 'shop_returns_exchange_variant_id_shop_product_variants_id_fk'
  ) THEN
    ALTER TABLE "shop_returns" ADD CONSTRAINT "shop_returns_exchange_variant_id_shop_product_variants_id_fk" FOREIGN KEY ("exchange_variant_id") REFERENCES "public"."shop_product_variants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_returns'
      AND c.conname = 'shop_returns_fraud_overridden_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "shop_returns" ADD CONSTRAINT "shop_returns_fraud_overridden_by_user_id_app_users_id_fk" FOREIGN KEY ("fraud_overridden_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_returns'
      AND c.conname = 'shop_returns_order_id_shop_orders_id_fk'
  ) THEN
    ALTER TABLE "shop_returns" ADD CONSTRAINT "shop_returns_order_id_shop_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shop_orders"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_returns'
      AND c.conname = 'shop_returns_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "shop_returns" ADD CONSTRAINT "shop_returns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_returns'
      AND c.conname = 'shop_returns_resolved_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "shop_returns" ADD CONSTRAINT "shop_returns_resolved_by_user_id_app_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_returns'
      AND c.conname = 'shop_returns_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "shop_returns" ADD CONSTRAINT "shop_returns_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stock_adjustments'
      AND c.conname = 'shop_stock_adjustments_created_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "shop_stock_adjustments" ADD CONSTRAINT "shop_stock_adjustments_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stock_adjustments'
      AND c.conname = 'shop_stock_adjustments_location_id_shop_locations_id_fk'
  ) THEN
    ALTER TABLE "shop_stock_adjustments" ADD CONSTRAINT "shop_stock_adjustments_location_id_shop_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."shop_locations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stock_adjustments'
      AND c.conname = 'shop_stock_adjustments_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "shop_stock_adjustments" ADD CONSTRAINT "shop_stock_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stock_adjustments'
      AND c.conname = 'shop_stock_adjustments_variant_id_shop_product_variants_id_fk'
  ) THEN
    ALTER TABLE "shop_stock_adjustments" ADD CONSTRAINT "shop_stock_adjustments_variant_id_shop_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."shop_product_variants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stock_transfers'
      AND c.conname = 'shop_stock_transfers_created_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "shop_stock_transfers" ADD CONSTRAINT "shop_stock_transfers_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stock_transfers'
      AND c.conname = 'shop_stock_transfers_from_location_id_shop_locations_id_fk'
  ) THEN
    ALTER TABLE "shop_stock_transfers" ADD CONSTRAINT "shop_stock_transfers_from_location_id_shop_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."shop_locations"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stock_transfers'
      AND c.conname = 'shop_stock_transfers_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "shop_stock_transfers" ADD CONSTRAINT "shop_stock_transfers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stock_transfers'
      AND c.conname = 'shop_stock_transfers_to_location_id_shop_locations_id_fk'
  ) THEN
    ALTER TABLE "shop_stock_transfers" ADD CONSTRAINT "shop_stock_transfers_to_location_id_shop_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."shop_locations"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stock_transfers'
      AND c.conname = 'shop_stock_transfers_variant_id_shop_product_variants_id_fk'
  ) THEN
    ALTER TABLE "shop_stock_transfers" ADD CONSTRAINT "shop_stock_transfers_variant_id_shop_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."shop_product_variants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stocktake_items'
      AND c.conname = 'shop_stocktake_items_session_id_shop_stocktake_sessions_id_fk'
  ) THEN
    ALTER TABLE "shop_stocktake_items" ADD CONSTRAINT "shop_stocktake_items_session_id_shop_stocktake_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."shop_stocktake_sessions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stocktake_items'
      AND c.conname = 'shop_stocktake_items_variant_id_shop_product_variants_id_fk'
  ) THEN
    ALTER TABLE "shop_stocktake_items" ADD CONSTRAINT "shop_stocktake_items_variant_id_shop_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."shop_product_variants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stocktake_sessions'
      AND c.conname = 'shop_stocktake_sessions_location_id_shop_locations_id_fk'
  ) THEN
    ALTER TABLE "shop_stocktake_sessions" ADD CONSTRAINT "shop_stocktake_sessions_location_id_shop_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."shop_locations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stocktake_sessions'
      AND c.conname = 'shop_stocktake_sessions_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "shop_stocktake_sessions" ADD CONSTRAINT "shop_stocktake_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_stocktake_sessions'
      AND c.conname = 'shop_stocktake_sessions_started_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "shop_stocktake_sessions" ADD CONSTRAINT "shop_stocktake_sessions_started_by_user_id_app_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_variant_stock'
      AND c.conname = 'shop_variant_stock_location_id_shop_locations_id_fk'
  ) THEN
    ALTER TABLE "shop_variant_stock" ADD CONSTRAINT "shop_variant_stock_location_id_shop_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."shop_locations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_variant_stock'
      AND c.conname = 'shop_variant_stock_variant_id_shop_product_variants_id_fk'
  ) THEN
    ALTER TABLE "shop_variant_stock" ADD CONSTRAINT "shop_variant_stock_variant_id_shop_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."shop_product_variants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shots'
      AND c.conname = 'shots_general_play_round_id_general_play_rounds_id_fk'
  ) THEN
    ALTER TABLE "shots" ADD CONSTRAINT "shots_general_play_round_id_general_play_rounds_id_fk" FOREIGN KEY ("general_play_round_id") REFERENCES "public"."general_play_rounds"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shots'
      AND c.conname = 'shots_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "shots" ADD CONSTRAINT "shots_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'side_game_instances'
      AND c.conname = 'side_game_instances_created_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "side_game_instances" ADD CONSTRAINT "side_game_instances_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'side_game_instances'
      AND c.conname = 'side_game_instances_general_play_round_id_fk'
  ) THEN
    ALTER TABLE "side_game_instances" ADD CONSTRAINT "side_game_instances_general_play_round_id_fk" FOREIGN KEY ("general_play_round_id") REFERENCES "public"."general_play_rounds"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'side_game_instances'
      AND c.conname = 'side_game_instances_league_round_id_league_rounds_id_fk'
  ) THEN
    ALTER TABLE "side_game_instances" ADD CONSTRAINT "side_game_instances_league_round_id_league_rounds_id_fk" FOREIGN KEY ("league_round_id") REFERENCES "public"."league_rounds"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'side_game_instances'
      AND c.conname = 'side_game_instances_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "side_game_instances" ADD CONSTRAINT "side_game_instances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'side_game_instances'
      AND c.conname = 'side_game_instances_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "side_game_instances" ADD CONSTRAINT "side_game_instances_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'side_game_settlement_receipt_attempts'
      AND c.conname = 'side_game_settlement_receipt_attempts_org_fk'
  ) THEN
    ALTER TABLE "side_game_settlement_receipt_attempts" ADD CONSTRAINT "side_game_settlement_receipt_attempts_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'side_game_settlement_receipt_attempts'
      AND c.conname = 'side_game_settlement_receipt_attempts_settlement_fk'
  ) THEN
    ALTER TABLE "side_game_settlement_receipt_attempts" ADD CONSTRAINT "side_game_settlement_receipt_attempts_settlement_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."side_game_settlements"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'side_game_settlements'
      AND c.conname = 'side_game_settlements_instance_id_side_game_instances_id_fk'
  ) THEN
    ALTER TABLE "side_game_settlements" ADD CONSTRAINT "side_game_settlements_instance_id_side_game_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."side_game_instances"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'side_game_templates'
      AND c.conname = 'side_game_templates_created_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "side_game_templates" ADD CONSTRAINT "side_game_templates_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'side_game_templates'
      AND c.conname = 'side_game_templates_league_id_leagues_id_fk'
  ) THEN
    ALTER TABLE "side_game_templates" ADD CONSTRAINT "side_game_templates_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'side_game_templates'
      AND c.conname = 'side_game_templates_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "side_game_templates" ADD CONSTRAINT "side_game_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'side_games_config'
      AND c.conname = 'side_games_config_ctp_sponsor_id_sponsors_id_fk'
  ) THEN
    ALTER TABLE "side_games_config" ADD CONSTRAINT "side_games_config_ctp_sponsor_id_sponsors_id_fk" FOREIGN KEY ("ctp_sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'side_games_config'
      AND c.conname = 'side_games_config_ld_sponsor_id_sponsors_id_fk'
  ) THEN
    ALTER TABLE "side_games_config" ADD CONSTRAINT "side_games_config_ld_sponsor_id_sponsors_id_fk" FOREIGN KEY ("ld_sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'spectator_follows'
      AND c.conname = 'spectator_follows_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "spectator_follows" ADD CONSTRAINT "spectator_follows_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'spectator_follows'
      AND c.conname = 'spectator_follows_tee_time_id_tee_times_id_fk'
  ) THEN
    ALTER TABLE "spectator_follows" ADD CONSTRAINT "spectator_follows_tee_time_id_tee_times_id_fk" FOREIGN KEY ("tee_time_id") REFERENCES "public"."tee_times"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'spectator_follows'
      AND c.conname = 'spectator_follows_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "spectator_follows" ADD CONSTRAINT "spectator_follows_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'spectator_follows'
      AND c.conname = 'spectator_follows_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "spectator_follows" ADD CONSTRAINT "spectator_follows_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sponsor_assets'
      AND c.conname = 'sponsor_assets_reviewed_by_app_users_id_fk'
  ) THEN
    ALTER TABLE "sponsor_assets" ADD CONSTRAINT "sponsor_assets_reviewed_by_app_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sponsor_assets'
      AND c.conname = 'sponsor_assets_sponsor_id_sponsors_id_fk'
  ) THEN
    ALTER TABLE "sponsor_assets" ADD CONSTRAINT "sponsor_assets_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sponsor_assets'
      AND c.conname = 'sponsor_assets_uploaded_by_app_users_id_fk'
  ) THEN
    ALTER TABLE "sponsor_assets" ADD CONSTRAINT "sponsor_assets_uploaded_by_app_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sponsor_clicks'
      AND c.conname = 'sponsor_clicks_sponsor_id_sponsors_id_fk'
  ) THEN
    ALTER TABLE "sponsor_clicks" ADD CONSTRAINT "sponsor_clicks_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sponsor_clicks'
      AND c.conname = 'sponsor_clicks_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "sponsor_clicks" ADD CONSTRAINT "sponsor_clicks_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sponsor_events'
      AND c.conname = 'sponsor_events_sponsor_id_sponsors_id_fk'
  ) THEN
    ALTER TABLE "sponsor_events" ADD CONSTRAINT "sponsor_events_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'staff_checkins'
      AND c.conname = 'staff_checkins_caddie_assignment_id_fk'
  ) THEN
    ALTER TABLE "staff_checkins" ADD CONSTRAINT "staff_checkins_caddie_assignment_id_fk" FOREIGN KEY ("caddie_assignment_id") REFERENCES "public"."caddie_event_assignments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'subscription_skus'
      AND c.conname = 'subscription_skus_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "subscription_skus" ADD CONSTRAINT "subscription_skus_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'survey_questions'
      AND c.conname = 'survey_questions_survey_id_surveys_id_fk'
  ) THEN
    ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'survey_response_items'
      AND c.conname = 'survey_response_items_question_id_survey_questions_id_fk'
  ) THEN
    ALTER TABLE "survey_response_items" ADD CONSTRAINT "survey_response_items_question_id_survey_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."survey_questions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'survey_response_items'
      AND c.conname = 'survey_response_items_response_id_survey_responses_id_fk'
  ) THEN
    ALTER TABLE "survey_response_items" ADD CONSTRAINT "survey_response_items_response_id_survey_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."survey_responses"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'survey_responses'
      AND c.conname = 'survey_responses_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'survey_responses'
      AND c.conname = 'survey_responses_respondent_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_respondent_user_id_app_users_id_fk" FOREIGN KEY ("respondent_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'survey_responses'
      AND c.conname = 'survey_responses_survey_id_surveys_id_fk'
  ) THEN
    ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'surveys'
      AND c.conname = 'surveys_created_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "surveys" ADD CONSTRAINT "surveys_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'surveys'
      AND c.conname = 'surveys_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "surveys" ADD CONSTRAINT "surveys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'swing_annotations'
      AND c.conname = 'swing_annotations_author_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "swing_annotations" ADD CONSTRAINT "swing_annotations_author_user_id_app_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'swing_annotations'
      AND c.conname = 'swing_annotations_pro_id_teaching_pros_id_fk'
  ) THEN
    ALTER TABLE "swing_annotations" ADD CONSTRAINT "swing_annotations_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'swing_annotations'
      AND c.conname = 'swing_annotations_swing_video_id_swing_videos_id_fk'
  ) THEN
    ALTER TABLE "swing_annotations" ADD CONSTRAINT "swing_annotations_swing_video_id_swing_videos_id_fk" FOREIGN KEY ("swing_video_id") REFERENCES "public"."swing_videos"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'swing_comparisons'
      AND c.conname = 'swing_comparisons_left_video_id_swing_videos_id_fk'
  ) THEN
    ALTER TABLE "swing_comparisons" ADD CONSTRAINT "swing_comparisons_left_video_id_swing_videos_id_fk" FOREIGN KEY ("left_video_id") REFERENCES "public"."swing_videos"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'swing_comparisons'
      AND c.conname = 'swing_comparisons_right_video_id_swing_videos_id_fk'
  ) THEN
    ALTER TABLE "swing_comparisons" ADD CONSTRAINT "swing_comparisons_right_video_id_swing_videos_id_fk" FOREIGN KEY ("right_video_id") REFERENCES "public"."swing_videos"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'swing_comparisons'
      AND c.conname = 'swing_comparisons_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "swing_comparisons" ADD CONSTRAINT "swing_comparisons_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'swing_review_requests'
      AND c.conname = 'swing_review_requests_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "swing_review_requests" ADD CONSTRAINT "swing_review_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'swing_review_requests'
      AND c.conname = 'swing_review_requests_pro_id_teaching_pros_id_fk'
  ) THEN
    ALTER TABLE "swing_review_requests" ADD CONSTRAINT "swing_review_requests_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'swing_review_requests'
      AND c.conname = 'swing_review_requests_swing_video_id_swing_videos_id_fk'
  ) THEN
    ALTER TABLE "swing_review_requests" ADD CONSTRAINT "swing_review_requests_swing_video_id_swing_videos_id_fk" FOREIGN KEY ("swing_video_id") REFERENCES "public"."swing_videos"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'swing_review_requests'
      AND c.conname = 'swing_review_requests_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "swing_review_requests" ADD CONSTRAINT "swing_review_requests_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'swing_videos'
      AND c.conname = 'swing_videos_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "swing_videos" ADD CONSTRAINT "swing_videos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'swing_videos'
      AND c.conname = 'swing_videos_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "swing_videos" ADD CONSTRAINT "swing_videos_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tax_profiles'
      AND c.conname = 'tax_profiles_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "tax_profiles" ADD CONSTRAINT "tax_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tax_rates'
      AND c.conname = 'tax_rates_tax_profile_id_tax_profiles_id_fk'
  ) THEN
    ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tax_profile_id_tax_profiles_id_fk" FOREIGN KEY ("tax_profile_id") REFERENCES "public"."tax_profiles"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'teaching_pros'
      AND c.conname = 'teaching_pros_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "teaching_pros" ADD CONSTRAINT "teaching_pros_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'teaching_pros'
      AND c.conname = 'teaching_pros_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "teaching_pros" ADD CONSTRAINT "teaching_pros_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_block_rules'
      AND c.conname = 'tee_block_rules_course_id_courses_id_fk'
  ) THEN
    ALTER TABLE "tee_block_rules" ADD CONSTRAINT "tee_block_rules_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_block_rules'
      AND c.conname = 'tee_block_rules_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "tee_block_rules" ADD CONSTRAINT "tee_block_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_booking_players'
      AND c.conname = 'tee_booking_players_booking_id_tee_bookings_id_fk'
  ) THEN
    ALTER TABLE "tee_booking_players" ADD CONSTRAINT "tee_booking_players_booking_id_tee_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."tee_bookings"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_booking_players'
      AND c.conname = 'tee_booking_players_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "tee_booking_players" ADD CONSTRAINT "tee_booking_players_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_booking_waitlist'
      AND c.conname = 'tee_booking_waitlist_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "tee_booking_waitlist" ADD CONSTRAINT "tee_booking_waitlist_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_booking_waitlist'
      AND c.conname = 'tee_booking_waitlist_promoted_booking_id_tee_bookings_id_fk'
  ) THEN
    ALTER TABLE "tee_booking_waitlist" ADD CONSTRAINT "tee_booking_waitlist_promoted_booking_id_tee_bookings_id_fk" FOREIGN KEY ("promoted_booking_id") REFERENCES "public"."tee_bookings"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_booking_waitlist'
      AND c.conname = 'tee_booking_waitlist_slot_id_course_tee_slots_id_fk'
  ) THEN
    ALTER TABLE "tee_booking_waitlist" ADD CONSTRAINT "tee_booking_waitlist_slot_id_course_tee_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."course_tee_slots"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_booking_waitlist'
      AND c.conname = 'tee_booking_waitlist_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "tee_booking_waitlist" ADD CONSTRAINT "tee_booking_waitlist_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_booking_windows'
      AND c.conname = 'tee_booking_windows_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "tee_booking_windows" ADD CONSTRAINT "tee_booking_windows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_bookings'
      AND c.conname = 'tee_bookings_lead_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "tee_bookings" ADD CONSTRAINT "tee_bookings_lead_user_id_app_users_id_fk" FOREIGN KEY ("lead_user_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_bookings'
      AND c.conname = 'tee_bookings_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "tee_bookings" ADD CONSTRAINT "tee_bookings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_bookings'
      AND c.conname = 'tee_bookings_slot_id_course_tee_slots_id_fk'
  ) THEN
    ALTER TABLE "tee_bookings" ADD CONSTRAINT "tee_bookings_slot_id_course_tee_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."course_tee_slots"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_dynamic_pricing_rules'
      AND c.conname = 'tee_dynamic_pricing_rules_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "tee_dynamic_pricing_rules" ADD CONSTRAINT "tee_dynamic_pricing_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_player_count_rules'
      AND c.conname = 'tee_player_count_rules_course_id_courses_id_fk'
  ) THEN
    ALTER TABLE "tee_player_count_rules" ADD CONSTRAINT "tee_player_count_rules_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_player_count_rules'
      AND c.conname = 'tee_player_count_rules_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "tee_player_count_rules" ADD CONSTRAINT "tee_player_count_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_pricing_forecasts'
      AND c.conname = 'tee_pricing_forecasts_actor_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "tee_pricing_forecasts" ADD CONSTRAINT "tee_pricing_forecasts_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_pricing_forecasts'
      AND c.conname = 'tee_pricing_forecasts_course_id_courses_id_fk'
  ) THEN
    ALTER TABLE "tee_pricing_forecasts" ADD CONSTRAINT "tee_pricing_forecasts_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_pricing_forecasts'
      AND c.conname = 'tee_pricing_forecasts_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "tee_pricing_forecasts" ADD CONSTRAINT "tee_pricing_forecasts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_pricing_rules'
      AND c.conname = 'tee_pricing_rules_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "tee_pricing_rules" ADD CONSTRAINT "tee_pricing_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_schedule_templates'
      AND c.conname = 'tee_schedule_templates_course_id_courses_id_fk'
  ) THEN
    ALTER TABLE "tee_schedule_templates" ADD CONSTRAINT "tee_schedule_templates_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tee_schedule_templates'
      AND c.conname = 'tee_schedule_templates_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "tee_schedule_templates" ADD CONSTRAINT "tee_schedule_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_merchandise'
      AND c.conname = 'tournament_merchandise_product_id_shop_products_id_fk'
  ) THEN
    ALTER TABLE "tournament_merchandise" ADD CONSTRAINT "tournament_merchandise_product_id_shop_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_merchandise'
      AND c.conname = 'tournament_merchandise_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "tournament_merchandise" ADD CONSTRAINT "tournament_merchandise_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_predictions'
      AND c.conname = 'tournament_predictions_predicted_winner_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "tournament_predictions" ADD CONSTRAINT "tournament_predictions_predicted_winner_player_id_players_id_fk" FOREIGN KEY ("predicted_winner_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_predictions'
      AND c.conname = 'tournament_predictions_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "tournament_predictions" ADD CONSTRAINT "tournament_predictions_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_predictions'
      AND c.conname = 'tournament_predictions_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "tournament_predictions" ADD CONSTRAINT "tournament_predictions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_rounds'
      AND c.conname = 'tournament_rounds_course_id_courses_id_fk'
  ) THEN
    ALTER TABLE "tournament_rounds" ADD CONSTRAINT "tournament_rounds_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_rounds'
      AND c.conname = 'tournament_rounds_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "tournament_rounds" ADD CONSTRAINT "tournament_rounds_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_rulings'
      AND c.conname = 'tournament_rulings_logged_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "tournament_rulings" ADD CONSTRAINT "tournament_rulings_logged_by_user_id_app_users_id_fk" FOREIGN KEY ("logged_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_rulings'
      AND c.conname = 'tournament_rulings_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "tournament_rulings" ADD CONSTRAINT "tournament_rulings_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_rulings'
      AND c.conname = 'tournament_rulings_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "tournament_rulings" ADD CONSTRAINT "tournament_rulings_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_staff'
      AND c.conname = 'tournament_staff_invited_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "tournament_staff" ADD CONSTRAINT "tournament_staff_invited_by_user_id_app_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_staff'
      AND c.conname = 'tournament_staff_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "tournament_staff" ADD CONSTRAINT "tournament_staff_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_templates'
      AND c.conname = 'tournament_templates_created_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "tournament_templates" ADD CONSTRAINT "tournament_templates_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tournament_templates'
      AND c.conname = 'tournament_templates_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "tournament_templates" ADD CONSTRAINT "tournament_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_car_assignments'
      AND c.conname = 'trip_car_assignments_car_id_trip_cars_id_fk'
  ) THEN
    ALTER TABLE "trip_car_assignments" ADD CONSTRAINT "trip_car_assignments_car_id_trip_cars_id_fk" FOREIGN KEY ("car_id") REFERENCES "public"."trip_cars"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_car_assignments'
      AND c.conname = 'trip_car_assignments_participant_id_trip_participants_id_fk'
  ) THEN
    ALTER TABLE "trip_car_assignments" ADD CONSTRAINT "trip_car_assignments_participant_id_trip_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."trip_participants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_cars'
      AND c.conname = 'trip_cars_driver_participant_id_trip_participants_id_fk'
  ) THEN
    ALTER TABLE "trip_cars" ADD CONSTRAINT "trip_cars_driver_participant_id_trip_participants_id_fk" FOREIGN KEY ("driver_participant_id") REFERENCES "public"."trip_participants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_cars'
      AND c.conname = 'trip_cars_trip_id_golf_trips_id_fk'
  ) THEN
    ALTER TABLE "trip_cars" ADD CONSTRAINT "trip_cars_trip_id_golf_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."golf_trips"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_expenses'
      AND c.conname = 'trip_expenses_paid_by_trip_participants_id_fk'
  ) THEN
    ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_paid_by_trip_participants_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."trip_participants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_expenses'
      AND c.conname = 'trip_expenses_trip_id_golf_trips_id_fk'
  ) THEN
    ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_trip_id_golf_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."golf_trips"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_itinerary_items'
      AND c.conname = 'trip_itinerary_items_trip_id_golf_trips_id_fk'
  ) THEN
    ALTER TABLE "trip_itinerary_items" ADD CONSTRAINT "trip_itinerary_items_trip_id_golf_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."golf_trips"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_participants'
      AND c.conname = 'trip_participants_trip_id_golf_trips_id_fk'
  ) THEN
    ALTER TABLE "trip_participants" ADD CONSTRAINT "trip_participants_trip_id_golf_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."golf_trips"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_participants'
      AND c.conname = 'trip_participants_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "trip_participants" ADD CONSTRAINT "trip_participants_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_room_assignments'
      AND c.conname = 'trip_room_assignments_participant_id_trip_participants_id_fk'
  ) THEN
    ALTER TABLE "trip_room_assignments" ADD CONSTRAINT "trip_room_assignments_participant_id_trip_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."trip_participants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_room_assignments'
      AND c.conname = 'trip_room_assignments_room_id_trip_rooms_id_fk'
  ) THEN
    ALTER TABLE "trip_room_assignments" ADD CONSTRAINT "trip_room_assignments_room_id_trip_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."trip_rooms"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_rooms'
      AND c.conname = 'trip_rooms_trip_id_golf_trips_id_fk'
  ) THEN
    ALTER TABLE "trip_rooms" ADD CONSTRAINT "trip_rooms_trip_id_golf_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."golf_trips"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_tee_slot_assignments'
      AND c.conname = 'trip_tee_slot_assignments_participant_id_fk'
  ) THEN
    ALTER TABLE "trip_tee_slot_assignments" ADD CONSTRAINT "trip_tee_slot_assignments_participant_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."trip_participants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_tee_slot_assignments'
      AND c.conname = 'trip_tee_slot_assignments_slot_id_trip_tee_slots_id_fk'
  ) THEN
    ALTER TABLE "trip_tee_slot_assignments" ADD CONSTRAINT "trip_tee_slot_assignments_slot_id_trip_tee_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."trip_tee_slots"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'trip_tee_slots'
      AND c.conname = 'trip_tee_slots_trip_id_golf_trips_id_fk'
  ) THEN
    ALTER TABLE "trip_tee_slots" ADD CONSTRAINT "trip_tee_slots_trip_id_golf_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."golf_trips"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tv_motion_templates'
      AND c.conname = 'tv_motion_templates_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "tv_motion_templates" ADD CONSTRAINT "tv_motion_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'user_active_sessions'
      AND c.conname = 'user_active_sessions_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "user_active_sessions" ADD CONSTRAINT "user_active_sessions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'user_currency_preferences'
      AND c.conname = 'user_currency_preferences_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "user_currency_preferences" ADD CONSTRAINT "user_currency_preferences_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'user_follows'
      AND c.conname = 'user_follows_followee_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "user_follows" ADD CONSTRAINT "user_follows_followee_id_app_users_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'user_follows'
      AND c.conname = 'user_follows_follower_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "user_follows" ADD CONSTRAINT "user_follows_follower_id_app_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'user_health_prefs'
      AND c.conname = 'user_health_prefs_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "user_health_prefs" ADD CONSTRAINT "user_health_prefs_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'user_notification_key_prefs'
      AND c.conname = 'user_notification_key_prefs_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "user_notification_key_prefs" ADD CONSTRAINT "user_notification_key_prefs_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'user_streaks'
      AND c.conname = 'user_streaks_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "user_streaks" ADD CONSTRAINT "user_streaks_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'user_totp_secrets'
      AND c.conname = 'user_totp_secrets_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "user_totp_secrets" ADD CONSTRAINT "user_totp_secrets_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vendor_billing_cycles'
      AND c.conname = 'vendor_billing_cycles_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "vendor_billing_cycles" ADD CONSTRAINT "vendor_billing_cycles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vendor_billing_cycles'
      AND c.conname = 'vendor_billing_cycles_vendor_contract_id_vendor_contracts_id_fk'
  ) THEN
    ALTER TABLE "vendor_billing_cycles" ADD CONSTRAINT "vendor_billing_cycles_vendor_contract_id_vendor_contracts_id_fk" FOREIGN KEY ("vendor_contract_id") REFERENCES "public"."vendor_contracts"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vendor_billing_cycles'
      AND c.conname = 'vendor_billing_cycles_vendor_operator_id_vendor_operators_id_fk'
  ) THEN
    ALTER TABLE "vendor_billing_cycles" ADD CONSTRAINT "vendor_billing_cycles_vendor_operator_id_vendor_operators_id_fk" FOREIGN KEY ("vendor_operator_id") REFERENCES "public"."vendor_operators"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vendor_contract_alerts'
      AND c.conname = 'vendor_contract_alerts_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "vendor_contract_alerts" ADD CONSTRAINT "vendor_contract_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vendor_contract_alerts'
      AND c.conname = 'vendor_contract_alerts_vendor_contract_id_fk'
  ) THEN
    ALTER TABLE "vendor_contract_alerts" ADD CONSTRAINT "vendor_contract_alerts_vendor_contract_id_fk" FOREIGN KEY ("vendor_contract_id") REFERENCES "public"."vendor_contracts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vendor_contracts'
      AND c.conname = 'vendor_contracts_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vendor_contracts'
      AND c.conname = 'vendor_contracts_vendor_operator_id_vendor_operators_id_fk'
  ) THEN
    ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_vendor_operator_id_vendor_operators_id_fk" FOREIGN KEY ("vendor_operator_id") REFERENCES "public"."vendor_operators"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vendor_facility_assignments'
      AND c.conname = 'vendor_facility_assignments_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "vendor_facility_assignments" ADD CONSTRAINT "vendor_facility_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vendor_facility_assignments'
      AND c.conname = 'vendor_facility_assignments_vendor_operator_id_fk'
  ) THEN
    ALTER TABLE "vendor_facility_assignments" ADD CONSTRAINT "vendor_facility_assignments_vendor_operator_id_fk" FOREIGN KEY ("vendor_operator_id") REFERENCES "public"."vendor_operators"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vendor_invoices'
      AND c.conname = 'vendor_invoices_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vendor_invoices'
      AND c.conname = 'vendor_invoices_vendor_billing_cycle_id_fk'
  ) THEN
    ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_vendor_billing_cycle_id_fk" FOREIGN KEY ("vendor_billing_cycle_id") REFERENCES "public"."vendor_billing_cycles"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vendor_invoices'
      AND c.conname = 'vendor_invoices_vendor_operator_id_vendor_operators_id_fk'
  ) THEN
    ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_vendor_operator_id_vendor_operators_id_fk" FOREIGN KEY ("vendor_operator_id") REFERENCES "public"."vendor_operators"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'vendor_operators'
      AND c.conname = 'vendor_operators_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "vendor_operators" ADD CONSTRAINT "vendor_operators_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'verified_handicap_badges'
      AND c.conname = 'verified_handicap_badges_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "verified_handicap_badges" ADD CONSTRAINT "verified_handicap_badges_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'visitor_passes'
      AND c.conname = 'visitor_passes_checked_in_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_checked_in_by_user_id_app_users_id_fk" FOREIGN KEY ("checked_in_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'visitor_passes'
      AND c.conname = 'visitor_passes_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'visitor_pricing_rules'
      AND c.conname = 'visitor_pricing_rules_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "visitor_pricing_rules" ADD CONSTRAINT "visitor_pricing_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'watch_motion_buffer'
      AND c.conname = 'watch_motion_buffer_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "watch_motion_buffer" ADD CONSTRAINT "watch_motion_buffer_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'watch_pairing_challenges'
      AND c.conname = 'watch_pairing_challenges_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "watch_pairing_challenges" ADD CONSTRAINT "watch_pairing_challenges_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'webhook_delivery_log'
      AND c.conname = 'webhook_delivery_log_endpoint_id_webhook_endpoints_id_fk'
  ) THEN
    ALTER TABLE "webhook_delivery_log" ADD CONSTRAINT "webhook_delivery_log_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'webhook_endpoints'
      AND c.conname = 'webhook_endpoints_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'wellness_consents'
      AND c.conname = 'wellness_consents_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "wellness_consents" ADD CONSTRAINT "wellness_consents_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'wellness_daily_metrics'
      AND c.conname = 'wellness_daily_metrics_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "wellness_daily_metrics" ADD CONSTRAINT "wellness_daily_metrics_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'whs_pcc_entries'
      AND c.conname = 'whs_pcc_entries_course_id_courses_id_fk'
  ) THEN
    ALTER TABLE "whs_pcc_entries" ADD CONSTRAINT "whs_pcc_entries_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'whs_pcc_entries'
      AND c.conname = 'whs_pcc_entries_entered_by_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "whs_pcc_entries" ADD CONSTRAINT "whs_pcc_entries_entered_by_user_id_app_users_id_fk" FOREIGN KEY ("entered_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'whs_pcc_entries'
      AND c.conname = 'whs_pcc_entries_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "whs_pcc_entries" ADD CONSTRAINT "whs_pcc_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'whs_player_state'
      AND c.conname = 'whs_player_state_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "whs_player_state" ADD CONSTRAINT "whs_player_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'whs_player_state'
      AND c.conname = 'whs_player_state_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "whs_player_state" ADD CONSTRAINT "whs_player_state_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'whs_postings'
      AND c.conname = 'whs_postings_player_id_players_id_fk'
  ) THEN
    ALTER TABLE "whs_postings" ADD CONSTRAINT "whs_postings_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'whs_postings'
      AND c.conname = 'whs_postings_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "whs_postings" ADD CONSTRAINT "whs_postings_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'whs_score_records'
      AND c.conname = 'whs_score_records_course_id_courses_id_fk'
  ) THEN
    ALTER TABLE "whs_score_records" ADD CONSTRAINT "whs_score_records_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'whs_score_records'
      AND c.conname = 'whs_score_records_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "whs_score_records" ADD CONSTRAINT "whs_score_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'whs_score_records'
      AND c.conname = 'whs_score_records_source_tournament_id_tournaments_id_fk'
  ) THEN
    ALTER TABLE "whs_score_records" ADD CONSTRAINT "whs_score_records_source_tournament_id_tournaments_id_fk" FOREIGN KEY ("source_tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'whs_score_records'
      AND c.conname = 'whs_score_records_user_id_app_users_id_fk'
  ) THEN
    ALTER TABLE "whs_score_records" ADD CONSTRAINT "whs_score_records_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION
END $$;
