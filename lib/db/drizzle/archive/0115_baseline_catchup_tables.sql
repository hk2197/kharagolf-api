-- Catch-up migration # (Task #1403): missing tables.
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
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "ad_campaigns" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "sponsor_id" integer NOT NULL, "slot_id" integer NOT NULL, "creative_id" integer NOT NULL, "tournament_id" integer, "name" text NOT NULL, "start_date" timestamp with time zone NOT NULL, "end_date" timestamp with time zone NOT NULL, "weight" integer DEFAULT 10 NOT NULL, "frequency_cap_per_session" integer DEFAULT 0 NOT NULL, "is_active" boolean DEFAULT true NOT NULL, "notes" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "ad_creatives" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "sponsor_id" integer NOT NULL, "name" text NOT NULL, "media_type" text DEFAULT 'image' NOT NULL, "media_url" text NOT NULL, "click_through_url" text, "headline" text, "subheadline" text, "is_active" boolean DEFAULT true NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "ad_slots" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "slot_key" text NOT NULL, "name" text NOT NULL, "description" text, "surface" text DEFAULT 'web' NOT NULL, "media_types" jsonb DEFAULT '["image"]'::jsonb NOT NULL, "rotation_seconds" integer DEFAULT 8 NOT NULL, "is_active" boolean DEFAULT true NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "affiliate_codes" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "code" text NOT NULL, "description" text, "owner_user_id" integer, "owner_name" text, "owner_email" text, "commission_type" "promotion_type" DEFAULT 'percentage' NOT NULL, "commission_value" numeric(10, 2) DEFAULT '0' NOT NULL, "buyer_discount_type" "promotion_type" DEFAULT 'percentage' NOT NULL, "buyer_discount_value" numeric(10, 2) DEFAULT '0' NOT NULL, "total_orders" integer DEFAULT 0 NOT NULL, "total_discount_given" numeric(12, 2) DEFAULT '0' NOT NULL, "total_commission_earned" numeric(12, 2) DEFAULT '0' NOT NULL, "is_active" boolean DEFAULT true NOT NULL, "valid_from" timestamp with time zone, "valid_to" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "affiliate_redemptions" ( "id" serial PRIMARY KEY NOT NULL, "affiliate_code_id" integer NOT NULL, "organization_id" integer NOT NULL, "order_id" integer, "user_id" integer, "order_amount" numeric(10, 2) NOT NULL, "discount_amount" numeric(10, 2) NOT NULL, "commission_amount" numeric(10, 2) NOT NULL, "redeemed_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "ai_caddie_mode_blocks" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer, "user_id" integer, "tournament_id" integer, "league_id" integer, "round_id" integer, "mode" "ai_caddie_mode" NOT NULL, "surface" text NOT NULL, "action" text NOT NULL, "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL, "occurred_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "badge_share_daily_aggregates" ( "handle" text NOT NULL, "badge_type" text NOT NULL, "method" "badge_share_method" NOT NULL, "day" timestamp with time zone NOT NULL, "count" integer DEFAULT 0 NOT NULL, CONSTRAINT "badge_share_daily_aggregates_handle_badge_type_method_day_pk" PRIMARY KEY("handle","badge_type","method","day") );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "badge_share_events" ( "id" serial PRIMARY KEY NOT NULL, "handle" text NOT NULL, "badge_type" text NOT NULL, "method" "badge_share_method" NOT NULL, "source" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "ball_token_credits" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "user_id" integer NOT NULL, "booking_id" integer, "buckets_count" integer DEFAULT 0 NOT NULL, "balls_per_bucket" integer DEFAULT 50 NOT NULL, "used_at" timestamp with time zone, "notes" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "bounced_digest_schedule_opt_outs" ( "organization_id" integer NOT NULL, "user_id" integer NOT NULL, "opted_out_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "bundle_deals" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "name" text NOT NULL, "description" text, "deal_type" text DEFAULT 'multi_product' NOT NULL, "required_product_ids" jsonb, "target_category" text, "min_quantity" integer DEFAULT 2 NOT NULL, "discount_type" "promotion_type" DEFAULT 'percentage' NOT NULL, "discount_value" numeric(10, 2) DEFAULT '0' NOT NULL, "cheapest_item_free" boolean DEFAULT false NOT NULL, "is_active" boolean DEFAULT true NOT NULL, "valid_from" timestamp with time zone, "valid_to" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "caddie_assignments" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "tee_booking_id" integer NOT NULL, "caddie_id" integer NOT NULL, "member_id" integer, "status" "caddie_assignment_status" DEFAULT 'assigned' NOT NULL, "fee_charged" numeric(10, 2), "currency" text DEFAULT 'INR' NOT NULL, "fee_added_to_booking" boolean DEFAULT false NOT NULL, "tip_amount" numeric(10, 2), "tip_recorded_at" timestamp with time zone, "notes" text, "assigned_by_user_id" integer, "completed_at" timestamp with time zone, "cancelled_at" timestamp with time zone, "cancellation_reason" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "caddie_event_assignments" ( "id" serial PRIMARY KEY NOT NULL, "caddie_id" integer NOT NULL, "tournament_id" integer NOT NULL, "organization_id" integer NOT NULL, "player_id" integer, "player_name" text, "tee_time_id" integer, "agreed_fee" numeric(10, 2), "fee_mode" "caddie_fee_mode" DEFAULT 'cash' NOT NULL, "fee_paid" boolean DEFAULT false NOT NULL, "fee_paid_at" timestamp with time zone, "notes" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "caddie_ratings" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "assignment_id" integer NOT NULL, "caddie_id" integer NOT NULL, "rated_by_user_id" integer NOT NULL, "rating" integer NOT NULL, "comment" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "caddie_recommendations" ( "id" serial PRIMARY KEY NOT NULL, "user_id" integer, "player_id" integer, "tournament_id" integer, "general_play_round_id" integer, "round" integer DEFAULT 1 NOT NULL, "hole_number" integer NOT NULL, "distance_yards" numeric(8, 1) NOT NULL, "effective_yards" numeric(8, 1), "wind_speed" numeric(6, 2), "wind_direction" numeric(6, 2), "wind_bearing" numeric(6, 2), "temperature" numeric(5, 2), "recommended_club" text, "alternate_club" text, "ranked_clubs" jsonb, "rationale" jsonb, "aim_lat_offset" numeric(12, 9), "aim_lng_offset" numeric(12, 9), "lateral_stddev_yards" numeric(6, 2), "using_fallback" boolean DEFAULT false NOT NULL, "elevation_delta_yards" numeric(6, 1), "lie_type" text, "chosen_club" text, "accepted" boolean, "outcome_strokes" integer, "outcome_distance_to_pin" numeric(8, 1), "recorded_at" timestamp with time zone DEFAULT now() NOT NULL, "decided_at" timestamp with time zone );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "club_carry_distances" ( "id" serial PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "club" text NOT NULL, "carry_yards" integer NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "club_currency_profiles" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "base_currency" text DEFAULT 'INR' NOT NULL, "display_currencies" jsonb DEFAULT '["INR"]'::jsonb NOT NULL, "allow_player_preferred_currency" boolean DEFAULT false NOT NULL, "default_tax_profile_id" integer, "fx_markup_pct" numeric(6, 3) DEFAULT '0' NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "club_currency_profiles_organization_id_unique" UNIQUE("organization_id") );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "coach_marketplace_profiles" ( "id" serial PRIMARY KEY NOT NULL, "pro_id" integer NOT NULL, "organization_id" integer NOT NULL, "is_listed" boolean DEFAULT false NOT NULL, "certifications" jsonb DEFAULT '[]'::jsonb NOT NULL, "years_experience" integer DEFAULT 0 NOT NULL, "languages" jsonb DEFAULT '["en"]'::jsonb NOT NULL, "hourly_rate_paise" integer DEFAULT 0 NOT NULL, "async_review_price_paise" integer DEFAULT 0 NOT NULL, "accepts_in_person" boolean DEFAULT true NOT NULL, "accepts_async" boolean DEFAULT true NOT NULL, "async_turnaround_hours" integer DEFAULT 48 NOT NULL, "revenue_share_pct" numeric(5, 2) DEFAULT '70' NOT NULL, "payout_account_id" text, "payout_method" text, "payout_vpa" text, "payout_bank_account_number" text, "payout_bank_ifsc" text, "payout_account_holder_name" text, "razorpay_contact_id" text, "payout_verified_at" timestamp with time zone, "payout_verification_status" text, "payout_verification_failure_reason" text, "ratings_avg" numeric(3, 2) DEFAULT '0' NOT NULL, "ratings_count" integer DEFAULT 0 NOT NULL, "intro_video_url" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "coach_payout_account_history" ( "id" serial PRIMARY KEY NOT NULL, "pro_id" integer NOT NULL, "organization_id" integer NOT NULL, "changed_by_user_id" integer, "changed_by_role" text DEFAULT 'coach' NOT NULL, "change_kind" text DEFAULT 'updated' NOT NULL, "method" text NOT NULL, "account_holder_name" text, "upi_vpa_masked" text, "bank_account_last4" text, "bank_ifsc" text, "razorpay_contact_id" text, "payout_account_id" text, "ip_address" text, "user_agent" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "coach_payout_notification_attempts" ( "id" serial PRIMARY KEY NOT NULL, "payout_id" integer NOT NULL, "pro_id" integer NOT NULL, "organization_id" integer NOT NULL, "coach_user_id" integer, "amount_paise" integer DEFAULT 0 NOT NULL, "reference" text NOT NULL, "notes" text, "org_name" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "push_status" text, "push_attempts" integer DEFAULT 0 NOT NULL, "last_push_at" timestamp with time zone, "last_push_error" text, "last_push_retry_at" timestamp with time zone, "push_retry_exhausted_at" timestamp with time zone, "sms_status" text, "sms_attempts" integer DEFAULT 0 NOT NULL, "last_sms_at" timestamp with time zone, "last_sms_error" text, "last_sms_retry_at" timestamp with time zone, "sms_retry_exhausted_at" timestamp with time zone );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "coach_payout_notifications" ( "id" serial PRIMARY KEY NOT NULL, "coach_user_id" integer NOT NULL, "payout_id" integer NOT NULL, "organization_id" integer NOT NULL, "title" text NOT NULL, "body" text NOT NULL, "amount_paise" integer DEFAULT 0 NOT NULL, "reference" text, "notes" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "read_at" timestamp with time zone );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "coach_payouts" ( "id" serial PRIMARY KEY NOT NULL, "pro_id" integer NOT NULL, "organization_id" integer NOT NULL, "period_start" timestamp with time zone NOT NULL, "period_end" timestamp with time zone NOT NULL, "gross_paise" integer DEFAULT 0 NOT NULL, "platform_fee_paise" integer DEFAULT 0 NOT NULL, "net_payout_paise" integer DEFAULT 0 NOT NULL, "status" "coach_payout_status" DEFAULT 'pending' NOT NULL, "payout_reference" text, "notes" text, "paid_at" timestamp with time zone, "attempted_at" timestamp with time zone, "failure_reason" text, "payout_mode" text, "paid_notified_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "course_data_corrections" ( "id" serial PRIMARY KEY NOT NULL, "course_id" integer NOT NULL, "organization_id" integer NOT NULL, "hole_number" integer, "field_name" text NOT NULL, "current_value" text, "proposed_value" text NOT NULL, "reason" text, "reported_by_user_id" integer, "status" "course_correction_status" DEFAULT 'open' NOT NULL, "reviewed_by_user_id" integer, "reviewed_at" timestamp with time zone, "review_notes" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "course_tee_slots" ( "id" serial PRIMARY KEY NOT NULL, "course_id" integer NOT NULL, "organization_id" integer NOT NULL, "slot_date" timestamp with time zone NOT NULL, "slot_time" text NOT NULL, "capacity" integer DEFAULT 4 NOT NULL, "status" "course_tee_slot_status" DEFAULT 'open' NOT NULL, "is_members_only" boolean DEFAULT false NOT NULL, "starting_hole" integer DEFAULT 1 NOT NULL, "start_type" "tee_start_type" DEFAULT 'normal' NOT NULL, "template_id" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "cross_club_ladder_clubs" ( "id" serial PRIMARY KEY NOT NULL, "ladder_id" integer NOT NULL, "organization_id" integer NOT NULL, "joined_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "cross_club_ladder_entries" ( "id" serial PRIMARY KEY NOT NULL, "ladder_id" integer NOT NULL, "user_id" integer, "home_organization_id" integer, "player_name" text NOT NULL, "player_email" text, "handicap_at_registration" numeric(4, 1), "membership_type" text, "region" text, "division" integer DEFAULT 1 NOT NULL, "total_points" integer DEFAULT 0 NOT NULL, "rounds_counted" integer DEFAULT 0 NOT NULL, "position" integer, "previous_position" integer, "registered_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "cross_club_ladder_events" ( "id" serial PRIMARY KEY NOT NULL, "ladder_id" integer NOT NULL, "entry_id" integer, "event_type" text NOT NULL, "from_division" integer, "to_division" integer, "final_position" integer, "message" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "cross_club_ladder_results" ( "id" serial PRIMARY KEY NOT NULL, "ladder_id" integer NOT NULL, "entry_id" integer NOT NULL, "organization_id" integer, "general_play_round_id" integer, "tournament_id" integer, "round_date" timestamp with time zone NOT NULL, "gross_score" integer, "net_score" integer, "stableford_points" integer, "points_awarded" integer DEFAULT 0 NOT NULL, "counted_toward_total" boolean DEFAULT true NOT NULL, "notes" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "cross_club_ladders" ( "id" serial PRIMARY KEY NOT NULL, "name" text NOT NULL, "description" text, "scope" "cross_club_ladder_scope" DEFAULT 'national' NOT NULL, "format" "cross_club_ladder_format" DEFAULT 'stableford' NOT NULL, "status" "cross_club_ladder_status" DEFAULT 'draft' NOT NULL, "region" text, "season_start" timestamp with time zone NOT NULL, "season_end" timestamp with time zone NOT NULL, "min_handicap" numeric(4, 1), "max_handicap" numeric(4, 1), "allowed_membership_types" jsonb DEFAULT '[]'::jsonb NOT NULL, "allowed_regions" jsonb DEFAULT '[]'::jsonb NOT NULL, "best_of_rounds" integer, "min_rounds_required" integer DEFAULT 1 NOT NULL, "promotion_relegation_enabled" boolean DEFAULT false NOT NULL, "division_count" integer DEFAULT 1 NOT NULL, "promote_per_division" integer DEFAULT 0 NOT NULL, "relegate_per_division" integer DEFAULT 0 NOT NULL, "is_public" boolean DEFAULT true NOT NULL, "share_slug" text NOT NULL, "created_by" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "cross_club_ladders_share_slug_unique" UNIQUE("share_slug") );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "event_survey_fields" ( "id" serial PRIMARY KEY NOT NULL, "survey_id" integer NOT NULL, "field_type" "reg_form_field_type" NOT NULL, "label" text NOT NULL, "placeholder" text, "help_text" text, "options" jsonb, "required" boolean DEFAULT false NOT NULL, "terms_text" text, "sort_order" integer DEFAULT 0 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "event_survey_forms" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "event_id" integer NOT NULL, "event_type" "reg_form_event_type" NOT NULL, "title" text DEFAULT 'Post-Event Survey' NOT NULL, "description" text, "send_delay_hours" integer DEFAULT 0 NOT NULL, "is_active" boolean DEFAULT true NOT NULL, "sent_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "event_survey_respondents" ( "id" serial PRIMARY KEY NOT NULL, "survey_id" integer NOT NULL, "entry_id" integer NOT NULL, "event_type" "reg_form_event_type" NOT NULL, "respondent_name" text, "respondent_email" text, "token" text NOT NULL, "email_sent_at" timestamp with time zone, "responded_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "event_survey_response_items" ( "id" serial PRIMARY KEY NOT NULL, "respondent_id" integer NOT NULL, "field_id" integer NOT NULL, "value" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "event_team_members" ( "id" serial PRIMARY KEY NOT NULL, "team_id" integer NOT NULL, "player_id" integer, "league_member_id" integer );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "event_teams" ( "id" serial PRIMARY KEY NOT NULL, "tournament_id" integer, "league_id" integer, "name" text NOT NULL, "colour" text DEFAULT '#22c55e', "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "exceptional_score_flags" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "player_id" integer NOT NULL, "tournament_id" integer, "round" integer, "posting_id" integer, "score_differential" numeric(5, 1) NOT NULL, "previous_handicap_index" numeric(5, 1), "projected_handicap_index" numeric(5, 1), "adjusted_handicap_index" numeric(5, 1), "status" text DEFAULT 'pending' NOT NULL, "reviewed_by_user_id" integer, "reviewed_at" timestamp with time zone, "notes" text, "flagged_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "fb_menu_item_modifier_groups" ( "id" serial PRIMARY KEY NOT NULL, "menu_item_id" integer NOT NULL, "group_id" integer NOT NULL, "sort_order" integer DEFAULT 0 NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "fb_menu_item_service_periods" ( "id" serial PRIMARY KEY NOT NULL, "menu_item_id" integer NOT NULL, "service_period_id" integer NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "fb_modifier_groups" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "name" text NOT NULL, "description" text, "selection_type" text DEFAULT 'single' NOT NULL, "is_required" boolean DEFAULT false NOT NULL, "min_selections" integer DEFAULT 0 NOT NULL, "max_selections" integer, "sort_order" integer DEFAULT 0 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "fb_modifier_options" ( "id" serial PRIMARY KEY NOT NULL, "group_id" integer NOT NULL, "name" text NOT NULL, "price_delta" numeric(10, 2) DEFAULT '0' NOT NULL, "is_available" boolean DEFAULT true NOT NULL, "is_default" boolean DEFAULT false NOT NULL, "sort_order" integer DEFAULT 0 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "fb_service_periods" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "name" text NOT NULL, "start_time" text NOT NULL, "end_time" text NOT NULL, "days_of_week" jsonb DEFAULT '[0,1,2,3,4,5,6]'::jsonb NOT NULL, "is_active" boolean DEFAULT true NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "fb_tabs" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "table_label" text NOT NULL, "guest_name" text, "party_size" integer DEFAULT 1 NOT NULL, "status" "fb_tab_status" DEFAULT 'open' NOT NULL, "server_user_id" integer, "club_member_id" integer, "notes" text, "closed_at" timestamp with time zone, "closed_by_user_id" integer, "closed_payment_method" text, "closed_total" numeric(10, 2), "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "fx_ledger_entries" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "booked_currency" text NOT NULL, "booked_amount" numeric(14, 2) NOT NULL, "settled_currency" text NOT NULL, "settled_amount" numeric(14, 2) NOT NULL, "fx_rate" numeric(20, 10) NOT NULL, "gain_loss" numeric(14, 2) NOT NULL, "source_type" text NOT NULL, "source_id" text, "processor" "payment_processor", "notes" text, "settled_at" timestamp with time zone DEFAULT now() NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "fx_rates" ( "id" serial PRIMARY KEY NOT NULL, "base_currency" text NOT NULL, "quote_currency" text NOT NULL, "rate" numeric(20, 10) NOT NULL, "source" text DEFAULT 'manual' NOT NULL, "fetched_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "general_play_hole_scores" ( "id" serial PRIMARY KEY NOT NULL, "round_id" integer NOT NULL, "hole_number" integer NOT NULL, "par" integer, "stroke_index" integer, "strokes" integer NOT NULL, "putts" integer, "capped_strokes" integer, "fairway_hit" text, "gir" boolean, "sand_save" boolean, "up_and_down" boolean, "penalties" integer, "penalty_reason" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "general_play_markers" ( "id" serial PRIMARY KEY NOT NULL, "round_id" integer NOT NULL, "marker_user_id" integer, "marker_name" text NOT NULL, "marker_email" text, "marker_ghin_number" text, "confirmation_status" text DEFAULT 'pending' NOT NULL, "dispute_note" text, "responded_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "general_play_rounds" ( "id" serial PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "organization_id" integer NOT NULL, "course_id" integer NOT NULL, "tee_box_name" text, "course_rating" numeric(4, 1), "slope_rating" integer, "holes_played" integer DEFAULT 18 NOT NULL, "status" "general_play_status" DEFAULT 'draft' NOT NULL, "gross_score" integer, "adjusted_gross_score" integer, "score_differential" numeric(5, 1), "pcc_used" numeric(3, 1) DEFAULT '0' NOT NULL, "tee_booking_id" integer, "submitted_at" timestamp with time zone, "marker_deadline_at" timestamp with time zone, "confirmed_at" timestamp with time zone, "unverified_at" timestamp with time zone, "notes" text, "played_at" timestamp with time zone DEFAULT now() NOT NULL, "ai_caddie_mode" "ai_caddie_mode", "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "guest_passes" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "tee_booking_id" integer, "tee_booking_player_id" integer, "invited_by_user_id" integer NOT NULL, "guest_name" text NOT NULL, "guest_email" text, "guest_phone" text, "play_date" timestamp with time zone NOT NULL, "green_fee" numeric(10, 2) DEFAULT '0' NOT NULL, "fee_settlement" "guest_fee_settlement" DEFAULT 'pay_at_desk' NOT NULL, "status" "guest_pass_status" DEFAULT 'pending' NOT NULL, "qr_token" text NOT NULL, "razorpay_order_id" text, "razorpay_payment_id" text, "paid_at" timestamp with time zone, "checked_in_at" timestamp with time zone, "checked_in_by_user_id" integer, "notes" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "guest_passes_qr_token_unique" UNIQUE("qr_token") );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "handicap_adjustments" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "player_id" integer NOT NULL, "adjusted_by_user_id" integer, "previous_handicap_index" numeric(5, 1), "new_handicap_index" numeric(5, 1) NOT NULL, "adjustment_strokes" numeric(4, 1), "adjustment_reason" text NOT NULL, "committee_notes" text, "tournament_id" integer, "flag_id" integer, "adjusted_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "highlight_reel_engagements" ( "id" serial PRIMARY KEY NOT NULL, "reel_id" integer NOT NULL, "organization_id" integer NOT NULL, "user_id" integer, "event_type" "highlight_reel_engagement_type" NOT NULL, "source" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "highlight_reels" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "user_id" integer NOT NULL, "tournament_id" integer, "player_id" integer, "template_id" text DEFAULT 'classic' NOT NULL, "title" text DEFAULT 'Round Highlights' NOT NULL, "options" jsonb DEFAULT '{}'::jsonb NOT NULL, "summary" jsonb DEFAULT '{}'::jsonb NOT NULL, "status" "highlight_reel_status" DEFAULT 'queued' NOT NULL, "error_message" text, "output_object_path" text, "thumbnail_path" text, "duration_seconds" integer, "feed_post_id" integer, "posted_at" timestamp with time zone, "render_started_at" timestamp with time zone, "render_completed_at" timestamp with time zone, "attempts" integer DEFAULT 0 NOT NULL, "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "highlight_render_events" ( "id" serial PRIMARY KEY NOT NULL, "reel_id" integer NOT NULL, "organization_id" integer NOT NULL, "user_id" integer NOT NULL, "trigger" text DEFAULT 'create' NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "hole_hazards" ( "id" serial PRIMARY KEY NOT NULL, "course_id" integer NOT NULL, "hole_number" integer NOT NULL, "hazard_type" "hazard_type" NOT NULL, "lat" numeric(10, 7) NOT NULL, "lng" numeric(10, 7) NOT NULL, "radius_meters" integer DEFAULT 10, "name" text );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "hole_pin_positions" ( "id" serial PRIMARY KEY NOT NULL, "general_play_round_id" integer, "tournament_id" integer, "player_id" integer, "round_number" integer, "hole_number" integer NOT NULL, "lat_offset" numeric(10, 8) DEFAULT '0' NOT NULL, "lng_offset" numeric(10, 8) DEFAULT '0' NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "hr_samples" ( "id" serial PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "tournament_id" integer, "general_play_round_id" integer, "player_id" integer, "round" integer DEFAULT 1 NOT NULL, "hole_number" integer, "shot_number" integer, "hr_bpm" integer NOT NULL, "hrv_ms" numeric(6, 2), "stress_score" integer, "source" text DEFAULT 'apple_watch' NOT NULL, "recorded_at" timestamp with time zone NOT NULL, "ingested_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "interclub_fixtures" ( "id" serial PRIMARY KEY NOT NULL, "league_id" integer NOT NULL, "opponent_name" text NOT NULL, "fixture_date" timestamp with time zone, "venue" text, "format" text, "home_score" numeric(6, 1), "away_score" numeric(6, 1), "status" text DEFAULT 'scheduled' NOT NULL, "notes" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "league_divisions" ( "id" serial PRIMARY KEY NOT NULL, "league_id" integer NOT NULL, "name" text NOT NULL, "level" integer DEFAULT 1 NOT NULL, "promote_count" integer DEFAULT 0 NOT NULL, "relegate_count" integer DEFAULT 0 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "manual_entry_alerts" ( "id" serial PRIMARY KEY NOT NULL, "submission_id" integer NOT NULL, "tournament_id" integer NOT NULL, "player_id" integer NOT NULL, "round" integer NOT NULL, "manual_pct" numeric(5, 2) NOT NULL, "manual_shots" integer NOT NULL, "total_shots" integer NOT NULL, "recipient_count" integer DEFAULT 0 NOT NULL, "push_attempted" integer DEFAULT 0 NOT NULL, "push_sent" integer DEFAULT 0 NOT NULL, "email_attempted" integer DEFAULT 0 NOT NULL, "email_sent" integer DEFAULT 0 NOT NULL, "sent_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "marketplace_bookings" ( "id" serial PRIMARY KEY NOT NULL, "slot_id" integer NOT NULL, "organization_id" integer NOT NULL, "user_id" integer, "player_name" text NOT NULL, "player_email" text, "players" integer DEFAULT 1 NOT NULL, "amount_paise" integer DEFAULT 0 NOT NULL, "payment_status" text DEFAULT 'pending' NOT NULL, "razorpay_order_id" text, "razorpay_payment_id" text, "notes" text, "booked_at" timestamp with time zone DEFAULT now() NOT NULL, "cancelled_at" timestamp with time zone );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "marketplace_saved_search_alerts" ( "id" serial PRIMARY KEY NOT NULL, "search_id" integer NOT NULL, "slot_id" integer NOT NULL, "alerted_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "marketplace_slots" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "course_id" integer, "slot_date" timestamp with time zone NOT NULL, "starting_hole" integer DEFAULT 1 NOT NULL, "max_players" integer DEFAULT 4 NOT NULL, "booked_players" integer DEFAULT 0 NOT NULL, "price_paise" integer DEFAULT 0 NOT NULL, "base_price_paise" integer, "is_public" boolean DEFAULT false NOT NULL, "surge_indicator" text DEFAULT 'normal' NOT NULL, "notes" text, "status" text DEFAULT 'open' NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "notification_audit_log" ( "id" serial PRIMARY KEY NOT NULL, "notification_key" text NOT NULL, "user_id" integer, "channel" text NOT NULL, "status" text NOT NULL, "reason" text, "payload" jsonb DEFAULT '{}'::jsonb NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "notification_digest_queue" ( "id" serial PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "notification_key" text NOT NULL, "title" text NOT NULL, "body" text NOT NULL, "data" jsonb DEFAULT '{}'::jsonb NOT NULL, "enqueued_at" timestamp with time zone DEFAULT now() NOT NULL, "delivered_at" timestamp with time zone );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "notification_type_registry" ( "id" serial PRIMARY KEY NOT NULL, "key" text NOT NULL, "category" text NOT NULL, "description" text NOT NULL, "default_channels" jsonb DEFAULT '["email","push"]'::jsonb NOT NULL, "transactional" boolean DEFAULT true NOT NULL, "digestable" boolean DEFAULT false NOT NULL, "audit_required" boolean DEFAULT false NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "notification_type_registry_key_unique" UNIQUE("key") );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "odds_telemetry" ( "id" serial PRIMARY KEY NOT NULL, "tournament_id" integer NOT NULL, "user_id" integer, "event_type" text NOT NULL, "widget" text NOT NULL, "surface" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "org_ghin_credentials" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "ghin_api_key" text NOT NULL, "ghin_api_username" text NOT NULL, "ghin_api_password" text NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "org_ghin_credentials_organization_id_unique" UNIQUE("organization_id") );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "org_plan_overrides" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "override_max_tournaments" integer, "override_max_members" integer, "override_max_leagues" integer, "override_sponsor_logos" boolean, "override_advanced_analytics" boolean, "override_priority_support" boolean, "override_mobile_app" boolean, "override_marketplace" boolean, "override_ai_rules_assistant" boolean, "override_whs_scoring" boolean, "override_dues_billing" boolean, "override_shop_locker_access" boolean, "override_white_label" boolean, "override_custom_domain" boolean, "override_reason" text, "override_set_by_user_id" integer, "override_expires_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "payment_processor_configs" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "currency" text NOT NULL, "processor" "payment_processor" NOT NULL, "is_active" boolean DEFAULT true NOT NULL, "account_ref" text, "public_key_hint" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "post_event_survey_responses" ( "id" serial PRIMARY KEY NOT NULL, "survey_id" integer NOT NULL, "user_id" integer, "answers" jsonb DEFAULT '{}'::jsonb NOT NULL, "submitted_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "post_event_surveys" ( "id" serial PRIMARY KEY NOT NULL, "tournament_id" integer NOT NULL, "organization_id" integer NOT NULL, "questions" jsonb DEFAULT '[]'::jsonb NOT NULL, "sent_at" timestamp with time zone, "reminder_sent_at" timestamp with time zone, "closes_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "post_event_surveys_tournament_id_unique" UNIQUE("tournament_id") );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "practice_sessions" ( "id" serial PRIMARY KEY NOT NULL, "player_id" integer, "user_id" integer, "organization_id" integer, "session_type" "practice_session_type" DEFAULT 'range' NOT NULL, "duration_minutes" integer, "notes" text, "club_focus" text, "session_date" timestamp with time zone DEFAULT now() NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "product_waitlist" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "product_id" integer NOT NULL, "variant_id" integer, "user_id" integer, "email" text NOT NULL, "name" text, "notified_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "promotion_redemptions" ( "id" serial PRIMARY KEY NOT NULL, "promotion_id" integer NOT NULL, "organization_id" integer NOT NULL, "order_id" integer, "user_id" integer, "discount_amount" numeric(10, 2) NOT NULL, "redeemed_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "promotions" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "code" text NOT NULL, "description" text, "discount_type" "promotion_type" DEFAULT 'percentage' NOT NULL, "discount_value" numeric(10, 2) NOT NULL, "min_order_value" numeric(10, 2) DEFAULT '0' NOT NULL, "usage_limit" integer, "used_count" integer DEFAULT 0 NOT NULL, "scope" "promotion_scope" DEFAULT 'all' NOT NULL, "scope_values" jsonb, "valid_from" timestamp with time zone, "valid_to" timestamp with time zone, "is_active" boolean DEFAULT true NOT NULL, "single_use_per_user" boolean DEFAULT false NOT NULL, "created_by_user_id" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "range_bays" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "bay_number" integer NOT NULL, "label" text, "is_active" boolean DEFAULT true NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "range_blackouts" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "start_at" timestamp with time zone NOT NULL, "end_at" timestamp with time zone NOT NULL, "reason" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "range_config" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "slot_duration_minutes" integer DEFAULT 30 NOT NULL, "first_slot_time" text DEFAULT '06:00' NOT NULL, "last_slot_time" text DEFAULT '21:00' NOT NULL, "member_rate" numeric(10, 2) DEFAULT '0' NOT NULL, "visitor_rate" numeric(10, 2) DEFAULT '0' NOT NULL, "peak_member_rate" numeric(10, 2), "peak_visitor_rate" numeric(10, 2), "peak_start_time" text, "peak_end_time" text, "balls_per_bucket" integer DEFAULT 50 NOT NULL, "buckets_included" integer DEFAULT 1 NOT NULL, "cancellation_cutoff_hours" integer DEFAULT 2 NOT NULL, "payment_model" text DEFAULT 'pay_at_checkin' NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "range_config_organization_id_unique" UNIQUE("organization_id") );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "registration_form_fields" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "event_id" integer NOT NULL, "event_type" "reg_form_event_type" NOT NULL, "field_type" "reg_form_field_type" NOT NULL, "label" text NOT NULL, "placeholder" text, "help_text" text, "options" jsonb, "required" boolean DEFAULT false NOT NULL, "conditional_on_field_id" integer, "conditional_on_value" text, "terms_text" text, "sort_order" integer DEFAULT 0 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "registration_form_responses" ( "id" serial PRIMARY KEY NOT NULL, "field_id" integer NOT NULL, "entry_id" integer NOT NULL, "event_type" "reg_form_event_type" NOT NULL, "value" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "rental_bookings" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "asset_id" integer NOT NULL, "tee_booking_id" integer, "member_id" integer, "booked_by_user_id" integer, "member_name" text, "status" "rental_booking_status" DEFAULT 'reserved' NOT NULL, "rental_date" timestamp with time zone NOT NULL, "expected_return_at" timestamp with time zone, "checked_out_at" timestamp with time zone, "checked_out_by_user_id" integer, "returned_at" timestamp with time zone, "returned_by_user_id" integer, "rate_charged" numeric(10, 2), "currency" text DEFAULT 'USD' NOT NULL, "damage_reported" boolean DEFAULT false NOT NULL, "damage_notes" text, "damage_photo_urls" jsonb DEFAULT '[]'::jsonb NOT NULL, "notes" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "sales_attributions" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "staff_user_id" integer NOT NULL, "source" "commission_source" NOT NULL, "pos_transaction_id" integer, "lesson_booking_id" integer, "sale_amount" numeric(10, 2) NOT NULL, "category" text, "commission_rule_id" integer, "commission_amount" numeric(10, 2) DEFAULT '0' NOT NULL, "currency" text DEFAULT 'INR' NOT NULL, "payout_id" integer, "attributed_at" timestamp with time zone DEFAULT now() NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "saved_reports" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "name" text NOT NULL, "description" text, "data_source" text NOT NULL, "columns" jsonb DEFAULT '[]'::jsonb NOT NULL, "filters" jsonb DEFAULT '{}'::jsonb NOT NULL, "sort_config" jsonb, "is_template" boolean DEFAULT false NOT NULL, "created_by_user_id" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "scorer_pins" ( "id" serial PRIMARY KEY NOT NULL, "tournament_id" integer NOT NULL, "organization_id" integer NOT NULL, "pin" text NOT NULL, "label" text NOT NULL, "expires_at" timestamp with time zone, "is_revoked" boolean DEFAULT false NOT NULL, "created_by_user_id" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "shop_bundle_components" ( "id" serial PRIMARY KEY NOT NULL, "bundle_id" integer NOT NULL, "product_id" integer NOT NULL, "variant_id" integer, "quantity" integer DEFAULT 1 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "shop_bundles" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "name" text NOT NULL, "description" text, "sku" text, "image_url" text, "price" numeric(10, 2) NOT NULL, "currency" text DEFAULT 'INR' NOT NULL, "is_active" boolean DEFAULT true NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "shop_category_flash_sales" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "category" text NOT NULL, "label" text, "discount_pct" numeric(5, 2) NOT NULL, "sale_start" timestamp with time zone NOT NULL, "sale_end" timestamp with time zone NOT NULL, "is_active" boolean DEFAULT true NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "shop_locations" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "name" text NOT NULL, "type" text DEFAULT 'pro_shop' NOT NULL, "is_default" boolean DEFAULT false NOT NULL, "is_active" boolean DEFAULT true NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "shop_stock_adjustments" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "variant_id" integer NOT NULL, "location_id" integer, "qty_delta" integer NOT NULL, "type" text NOT NULL, "reason" text, "reference_id" text, "created_by_user_id" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "shop_stock_transfers" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "from_location_id" integer NOT NULL, "to_location_id" integer NOT NULL, "variant_id" integer NOT NULL, "quantity" integer NOT NULL, "notes" text, "created_by_user_id" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "shop_stocktake_items" ( "id" serial PRIMARY KEY NOT NULL, "session_id" integer NOT NULL, "variant_id" integer NOT NULL, "expected_qty" integer DEFAULT 0 NOT NULL, "counted_qty" integer DEFAULT 0 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "shop_stocktake_sessions" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "location_id" integer NOT NULL, "status" text DEFAULT 'open' NOT NULL, "notes" text, "started_by_user_id" integer, "completed_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "shop_variant_stock" ( "id" serial PRIMARY KEY NOT NULL, "variant_id" integer NOT NULL, "location_id" integer NOT NULL, "quantity" integer DEFAULT 0 NOT NULL, "reorder_point" integer, "reorder_qty" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "side_game_instances" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "tournament_id" integer, "league_round_id" integer, "general_play_round_id" integer, "round" integer DEFAULT 1 NOT NULL, "game_type" text NOT NULL, "name" text, "rules" jsonb DEFAULT '{}'::jsonb NOT NULL, "events" jsonb DEFAULT '{}'::jsonb NOT NULL, "stake" numeric(10, 2), "currency" text DEFAULT 'INR', "participant_player_ids" jsonb DEFAULT '[]'::jsonb NOT NULL, "participant_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL, "participant_names" jsonb DEFAULT '{}'::jsonb NOT NULL, "status" text DEFAULT 'active' NOT NULL, "created_by_user_id" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "side_game_settlement_receipt_attempts" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "settlement_id" integer NOT NULL, "recipient_user_id" integer NOT NULL, "payer_name" text NOT NULL, "recipient_name" text, "recipient_email" text, "game_label" text NOT NULL, "currency" text NOT NULL, "amount" numeric(14, 2) NOT NULL, "payment_method" text, "payment_ref" text, "paid_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "email_status" text, "email_attempts" integer DEFAULT 0 NOT NULL, "last_email_at" timestamp with time zone, "last_email_error" text, "last_email_retry_at" timestamp with time zone, "next_email_retry_at" timestamp with time zone, "email_retry_exhausted_at" timestamp with time zone, "push_status" text, "push_attempts" integer DEFAULT 0 NOT NULL, "last_push_at" timestamp with time zone, "last_push_error" text, "last_push_retry_at" timestamp with time zone, "next_push_retry_at" timestamp with time zone, "push_retry_exhausted_at" timestamp with time zone );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "side_game_settlements" ( "id" serial PRIMARY KEY NOT NULL, "instance_id" integer NOT NULL, "from_player_id" integer, "from_user_id" integer, "from_name" text, "to_player_id" integer, "to_user_id" integer, "to_name" text, "amount" numeric(10, 2) NOT NULL, "currency" text DEFAULT 'INR', "status" text DEFAULT 'pending' NOT NULL, "payment_method" text, "payment_ref" text, "razorpay_order_id" text, "paid_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "side_game_templates" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "league_id" integer, "name" text NOT NULL, "game_type" text NOT NULL, "rules" jsonb DEFAULT '{}'::jsonb NOT NULL, "stake" numeric(10, 2), "currency" text DEFAULT 'INR', "created_by_user_id" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "sponsor_events" ( "id" serial PRIMARY KEY NOT NULL, "sponsor_id" integer NOT NULL, "organization_id" integer NOT NULL, "tournament_id" integer, "event_type" text NOT NULL, "source" text NOT NULL, "session_id" text NOT NULL, "slot_key" text, "campaign_id" integer, "creative_id" integer, "recorded_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "subscription_plan_configs" ( "tier" "subscription_tier" PRIMARY KEY NOT NULL, "price_monthly" integer DEFAULT 0 NOT NULL, "max_active_tournaments" integer, "max_members" integer, "max_leagues" integer, "sponsor_logos" boolean DEFAULT false NOT NULL, "advanced_analytics" boolean DEFAULT false NOT NULL, "priority_support" boolean DEFAULT false NOT NULL, "mobile_app" boolean DEFAULT true NOT NULL, "marketplace" boolean DEFAULT false NOT NULL, "ai_rules_assistant" boolean DEFAULT false NOT NULL, "whs_scoring" boolean DEFAULT false NOT NULL, "dues_billing" boolean DEFAULT false NOT NULL, "shop_locker_access" boolean DEFAULT false NOT NULL, "white_label" boolean DEFAULT false NOT NULL, "custom_domain" boolean DEFAULT false NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "swing_annotations" ( "id" serial PRIMARY KEY NOT NULL, "swing_video_id" integer NOT NULL, "review_request_id" integer, "author_user_id" integer NOT NULL, "pro_id" integer, "drawings" jsonb DEFAULT '[]'::jsonb NOT NULL, "voice_over_url" text, "voice_over_duration_seconds" numeric(8, 2), "text_notes" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "swing_comparisons" ( "id" serial PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "left_video_id" integer NOT NULL, "right_video_id" integer NOT NULL, "label" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "swing_review_requests" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "pro_id" integer NOT NULL, "user_id" integer NOT NULL, "swing_video_id" integer NOT NULL, "member_prompt" text, "price_paise" integer NOT NULL, "status" "swing_review_status" DEFAULT 'pending_payment' NOT NULL, "razorpay_order_id" text, "razorpay_payment_id" text, "escrow_held" boolean DEFAULT false NOT NULL, "due_at" timestamp with time zone, "delivered_at" timestamp with time zone, "refunded_at" timestamp with time zone, "annotation_id" integer, "rating" integer, "rating_comment" text, "rated_at" timestamp with time zone, "payout_id" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "swing_videos" ( "id" serial PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "organization_id" integer, "title" text, "video_url" text NOT NULL, "thumbnail_url" text, "duration_seconds" numeric(8, 2), "fps" numeric(6, 3), "club" text, "view" "swing_view" DEFAULT 'dtl' NOT NULL, "notes" text, "captured_at" timestamp with time zone DEFAULT now() NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "tax_profiles" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "name" text NOT NULL, "jurisdiction_kind" "tax_jurisdiction_kind" DEFAULT 'none' NOT NULL, "country" text DEFAULT 'IN' NOT NULL, "region" text, "invoice_label" text, "is_default" boolean DEFAULT false NOT NULL, "is_active" boolean DEFAULT true NOT NULL, "exemption_rules" jsonb DEFAULT '{}'::jsonb NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "tax_rates" ( "id" serial PRIMARY KEY NOT NULL, "tax_profile_id" integer NOT NULL, "component_name" text NOT NULL, "rate_pct" numeric(7, 4) DEFAULT '0' NOT NULL, "product_class" text, "customer_class" text, "min_taxable_amount" numeric(14, 2), "max_taxable_amount" numeric(14, 2), "sort_order" integer DEFAULT 0 NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "teaching_pros" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "user_id" integer, "display_name" text NOT NULL, "email" text, "phone" text, "bio" text, "photo_url" text, "specialisms" jsonb DEFAULT '[]'::jsonb NOT NULL, "is_active" boolean DEFAULT true NOT NULL, "cancellation_window_hours" integer DEFAULT 24 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "tee_booking_players" ( "id" serial PRIMARY KEY NOT NULL, "booking_id" integer NOT NULL, "player_type" "tee_booking_player_type" DEFAULT 'member' NOT NULL, "user_id" integer, "guest_name" text, "guest_email" text, "fee" numeric(10, 2), "confirmation_status" text DEFAULT 'pending' NOT NULL, "confirmed_at" timestamp with time zone, "declined_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "tee_booking_waitlist" ( "id" serial PRIMARY KEY NOT NULL, "slot_id" integer NOT NULL, "organization_id" integer NOT NULL, "user_id" integer NOT NULL, "party_size" integer DEFAULT 1 NOT NULL, "status" "tee_waitlist_status" DEFAULT 'waiting' NOT NULL, "promoted_booking_id" integer, "promoted_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "tee_bookings" ( "id" serial PRIMARY KEY NOT NULL, "slot_id" integer NOT NULL, "organization_id" integer NOT NULL, "lead_user_id" integer NOT NULL, "party_size" integer DEFAULT 1 NOT NULL, "status" "tee_booking_status" DEFAULT 'pending' NOT NULL, "payment_model" text DEFAULT 'pay_at_checkin' NOT NULL, "razorpay_order_id" text, "razorpay_payment_id" text, "total_amount" numeric(10, 2), "currency" text DEFAULT 'INR' NOT NULL, "cancellation_reason" text, "cancelled_at" timestamp with time zone, "cart_requested" boolean DEFAULT false NOT NULL, "reminder_24h_sent_at" timestamp with time zone, "reminder_2h_sent_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "tee_dynamic_pricing_rules" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "name" text NOT NULL, "conditions" jsonb DEFAULT '{}'::jsonb NOT NULL, "price_delta_pct" numeric(5, 2) DEFAULT '0' NOT NULL, "active" boolean DEFAULT true NOT NULL, "priority" integer DEFAULT 0 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "tee_pricing_rules" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "member_rate" numeric(10, 2) DEFAULT '0' NOT NULL, "guest_rate" numeric(10, 2) DEFAULT '0' NOT NULL, "twilight_start_time" text, "twilight_member_rate" numeric(10, 2), "twilight_guest_rate" numeric(10, 2), "max_guests_per_booking" integer DEFAULT 3 NOT NULL, "payment_model" text DEFAULT 'pay_at_checkin' NOT NULL, "cancellation_cutoff_hours" integer DEFAULT 24 NOT NULL, "cancellation_policy_type" text DEFAULT 'forfeit' NOT NULL, "cancellation_fee_flat" numeric(10, 2), "members_only_start_time" text, "members_only_end_time" text, "slot_interval_minutes" integer DEFAULT 10 NOT NULL, "first_tee_time" text DEFAULT '06:00' NOT NULL, "last_tee_time" text DEFAULT '18:00' NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL, CONSTRAINT "tee_pricing_rules_organization_id_unique" UNIQUE("organization_id") );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "tournament_merchandise" ( "id" serial PRIMARY KEY NOT NULL, "tournament_id" integer NOT NULL, "product_id" integer NOT NULL, "display_order" integer DEFAULT 0 NOT NULL, "note" text, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "tournament_predictions" ( "id" serial PRIMARY KEY NOT NULL, "tournament_id" integer NOT NULL, "user_id" integer NOT NULL, "predicted_winner_player_id" integer, "predicted_top5" jsonb DEFAULT '[]'::jsonb NOT NULL, "predicted_low_round" integer, "display_name" text, "score" integer, "score_breakdown" jsonb, "submitted_at" timestamp with time zone DEFAULT now() NOT NULL, "scored_at" timestamp with time zone, "results_email_sent_at" timestamp with time zone );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "tournament_rounds" ( "id" serial PRIMARY KEY NOT NULL, "tournament_id" integer NOT NULL, "round_number" integer NOT NULL, "course_id" integer, "scheduled_date" timestamp with time zone, "notes" text );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "tournament_rulings" ( "id" serial PRIMARY KEY NOT NULL, "tournament_id" integer NOT NULL, "player_id" integer, "hole_number" integer, "round" integer DEFAULT 1 NOT NULL, "rule_ref" text, "decision" text NOT NULL, "penalty_strokes" integer DEFAULT 0 NOT NULL, "official_name" text, "logged_by_user_id" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "tournament_templates" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "name" text NOT NULL, "description" text, "format" "tournament_format" DEFAULT 'stroke_play' NOT NULL, "rounds" integer DEFAULT 1 NOT NULL, "handicap_allowance" integer DEFAULT 100 NOT NULL, "max_players" integer, "entry_fee" numeric(10, 2), "currency" text DEFAULT 'INR' NOT NULL, "self_posting" boolean DEFAULT false NOT NULL, "allow_self_scoring" boolean DEFAULT false NOT NULL, "marker_validation" boolean DEFAULT false NOT NULL, "tiebreaker_method" "tiebreaker_method" DEFAULT 'countback' NOT NULL, "leaderboard_type" "leaderboard_type" DEFAULT 'both' NOT NULL, "auto_welcome" boolean DEFAULT true NOT NULL, "auto_reminder" boolean DEFAULT true NOT NULL, "auto_results" boolean DEFAULT false NOT NULL, "local_rules" text, "config" jsonb, "created_by_user_id" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "user_currency_preferences" ( "user_id" integer PRIMARY KEY NOT NULL, "preferred_currency" text NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "watch_motion_buffer" ( "id" serial PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "event_timestamp_ms" numeric(16, 0) NOT NULL, "peak_g" numeric(6, 3) NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "watch_pairing_challenges" ( "id" serial PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "code" text NOT NULL, "platform" text DEFAULT 'apple_watch' NOT NULL, "expires_at" timestamp with time zone NOT NULL, "used_at" timestamp with time zone, "attempt_count" integer DEFAULT 0 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "whs_pcc_entries" ( "id" serial PRIMARY KEY NOT NULL, "organization_id" integer NOT NULL, "course_id" integer NOT NULL, "competition_date" timestamp with time zone NOT NULL, "pcc_value" numeric(3, 1) DEFAULT '0' NOT NULL, "notes" text, "entered_by_user_id" integer, "created_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "whs_player_state" ( "id" serial PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "organization_id" integer NOT NULL, "total_holes_posted" integer DEFAULT 0 NOT NULL, "establishment_phase" integer DEFAULT 1 NOT NULL, "current_handicap_index" numeric(4, 1), "low_handicap_index" numeric(4, 1), "low_handicap_index_date" timestamp with time zone, "opening_handicap_index" numeric(4, 1), "is_provisional" boolean DEFAULT true NOT NULL, "last_recalc_at" timestamp with time zone, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "whs_postings" ( "id" serial PRIMARY KEY NOT NULL, "tournament_id" integer NOT NULL, "player_id" integer NOT NULL, "round" integer DEFAULT 1 NOT NULL, "gross_score" integer, "adjusted_gross_score" integer, "ghin_number" text, "course_rating" numeric(4, 1), "slope" integer, "status" "whs_posting_status" DEFAULT 'pending' NOT NULL, "ghin_response" jsonb, "error_message" text, "posted_at" timestamp with time zone, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "whs_score_records" ( "id" serial PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "organization_id" integer NOT NULL, "course_id" integer, "source_type" text NOT NULL, "source_tournament_id" integer, "source_general_play_id" integer, "holes_played" integer NOT NULL, "gross_score" integer, "adjusted_gross_score" integer, "course_rating" numeric(4, 1), "slope_rating" integer, "pcc_adjustment" numeric(3, 1) DEFAULT '0' NOT NULL, "raw_differential" numeric(5, 1), "esr_adjustment" numeric(3, 1) DEFAULT '0' NOT NULL, "final_differential" numeric(5, 1), "is_9_hole" boolean DEFAULT false NOT NULL, "marker_name" text, "marker_ghin_number" text, "handicap_index_after" numeric(4, 1), "played_at" timestamp with time zone NOT NULL, "posted_at" timestamp with time zone DEFAULT now() NOT NULL );$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
