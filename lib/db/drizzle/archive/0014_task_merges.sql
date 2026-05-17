-- Migration 0014: Apply all tables from merged tasks


DO $$ BEGIN
  CREATE TYPE "public"."bracket_type" AS ENUM('main', 'consolation');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."cart_status" AS ENUM('available', 'in_use', 'maintenance', 'retired');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."cart_type" AS ENUM('single', 'double');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."commission_payout_status" AS ENUM('pending', 'approved', 'paid', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."commission_source" AS ENUM('pos', 'lesson');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."commission_type" AS ENUM('percentage', 'flat_per_sale');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."consignment_payout_method" AS ENUM('cash', 'bank_transfer', 'cheque', 'account_credit', 'other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."consignment_status" AS ENUM('unsold', 'sold', 'payout_pending', 'paid', 'returned');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."course_tee_slot_status" AS ENUM('open', 'blocked', 'booked', 'members_only');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."document_access" AS ENUM('public', 'all_members', 'committee_only');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."document_category" AS ENUM('constitution', 'handicap_policy', 'course_rules', 'committee_minutes', 'agm_documents', 'financial_reports', 'bylaws', 'other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."event_type" AS ENUM('standard', 'corporate', 'charity');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."fantasy_draft_type" AS ENUM('snake', 'simultaneous');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."fantasy_league_format" AS ENUM('overall_standings', 'head_to_head');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."fantasy_league_status" AS ENUM('setup', 'drafting', 'active', 'completed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."fantasy_score_event" AS ENUM('hole_in_one', 'eagle', 'birdie', 'par', 'bogey', 'double_bogey', 'triple_bogey_plus', 'finish_1st', 'finish_2nd', 'finish_3rd', 'finish_top5', 'finish_top10', 'under_par_round', 'par_round');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."fb_order_status" AS ENUM('received', 'preparing', 'ready', 'delivered', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."fb_payment_method" AS ENUM('account_charge', 'card_on_delivery');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."feed_post_type" AS ENUM('member_post', 'achievement', 'club_announcement');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."feed_privacy" AS ENUM('all_members', 'followers_only');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."feed_report_reason" AS ENUM('inappropriate', 'spam', 'offensive', 'other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."fitting_session_status" AS ENUM('booked', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."general_play_status" AS ENUM('draft', 'in_progress', 'pending_marker', 'confirmed', 'disputed', 'unverified', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."gift_card_status" AS ENUM('active', 'redeemed', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."gift_card_type" AS ENUM('physical', 'digital');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."itinerary_item_type" AS ENUM('travel', 'golf_round', 'dinner', 'accommodation', 'activity', 'free_time');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."leaderboard_type" AS ENUM('gross', 'net', 'both');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."league_format" AS ENUM('stableford', 'stroke_play', 'net_stroke', 'match_play', 'bogey', 'eclectic', 'foursomes', 'greensomes', 'texas_scramble', 'waltz', 'alliance', 'better_ball', 'order_of_merit', 'shamble');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."league_staff_role" AS ENUM('league_admin', 'competition_secretary');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."league_status" AS ENUM('draft', 'upcoming', 'active', 'completed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."league_type" AS ENUM('individual', 'team', 'pairs');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."lesson_booking_status" AS ENUM('pending', 'confirmed', 'cancelled', 'completed', 'no_show');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."lesson_payment_status" AS ENUM('unpaid', 'pending', 'paid', 'refunded');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."locker_assignment_status" AS ENUM('active', 'expired', 'cancelled', 'pending_payment');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."locker_payment_method" AS ENUM('account_charge', 'razorpay');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."locker_status" AS ENUM('available', 'occupied', 'reserved', 'maintenance');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."loyalty_service_category" AS ENUM('pos', 'fb', 'lesson', 'tee_booking', 'tee_time', 'general');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."loyalty_tier" AS ENUM('none', 'silver', 'gold', 'platinum');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."loyalty_transaction_type" AS ENUM('earn', 'redeem', 'expire', 'adjust');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."match_result" AS ENUM('player1_wins', 'player2_wins', 'halved', 'conceded', 'pending');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."meeting_status" AS ENUM('scheduled', 'in_progress', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."member_subscription_status" AS ENUM('active', 'past_due', 'cancelled', 'expired', 'pending');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."notice_board_article_status" AS ENUM('draft', 'scheduled', 'published', 'archived');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."org_role" AS ENUM('super_admin', 'org_admin', 'tournament_director', 'committee_member', 'competition_secretary', 'volunteer', 'player', 'spectator', 'pro_shop');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."org_subscription_status" AS ENUM('free', 'active', 'past_due', 'cancelled', 'pending_payment');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."payment_status" AS ENUM('unpaid', 'pending', 'paid', 'refunded');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."po_status" AS ENUM('draft', 'sent', 'partially_received', 'fully_received', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."pos_payment_method" AS ENUM('cash', 'razorpay_pos', 'member_account');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."pos_transaction_status" AS ENUM('pending', 'completed', 'voided', 'refunded');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."practice_session_type" AS ENUM('range', 'putting', 'short_game', 'on_course', 'simulator', 'other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."ranking_category" AS ENUM('open', 'men', 'ladies', 'seniors', 'juniors');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."ranking_series_level" AS ENUM('club', 'regional', 'national');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."ranking_series_status" AS ENUM('draft', 'active', 'archived');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."ranking_tiebreaker" AS ENUM('most_wins', 'most_runner_up', 'most_top3', 'head_to_head', 'none');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."rental_asset_condition" AS ENUM('excellent', 'good', 'fair', 'poor', 'damaged', 'retired');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."rental_booking_status" AS ENUM('reserved', 'checked_out', 'returned', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."repair_job_status" AS ENUM('received', 'in_progress', 'ready_for_pickup', 'collected');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."repair_job_type" AS ENUM('regrip', 'reshaft', 'loft_lie_adjustment', 'cleaning', 'other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."loyalty_reward_type" AS ENUM('discount_percent', 'discount_fixed', 'free_round', 'voucher', 'product', 'other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."ryder_cup_session_type" AS ENUM('foursomes', 'four_ball', 'singles');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."shop_order_status" AS ENUM('pending', 'cod_pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."shot_type" AS ENUM('tee', 'fairway', 'approach', 'chip', 'sand', 'putt');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."store_credit_transaction_type" AS ENUM('issue', 'redeem', 'expire', 'adjustment');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."subscription_tier" AS ENUM('free', 'starter', 'pro', 'enterprise');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tee_booking_player_type" AS ENUM('member', 'guest');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tee_booking_status" AS ENUM('pending', 'confirmed', 'cancelled', 'forfeited', 'completed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tee_box" AS ENUM('blue', 'white', 'red', 'gold', 'black');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tiebreaker_method" AS ENUM('countback', 'multi_round_countback', 'net_countback', 'lower_handicap', 'no_tiebreaker');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tournament_format" AS ENUM('stroke_play', 'net_stroke', 'best_ball', 'scramble', 'skins', 'match_play', 'stableford', 'shamble', 'match_play_bracket', 'ryder_cup');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tournament_staff_role" AS ENUM('tournament_admin', 'live_scorer', 'volunteer');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tournament_status" AS ENUM('draft', 'upcoming', 'active', 'completed', 'cancelled', 'suspended');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."trip_participant_status" AS ENUM('invited', 'confirmed', 'waitlisted', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."trip_status" AS ENUM('draft', 'open', 'confirmed', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."vote_status" AS ENUM('draft', 'open', 'closed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."whs_posting_status" AS ENUM('pending', 'posted', 'failed', 'no_ghin');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "cart_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"cart_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"booking_id" integer,
	"assigned_by_user_id" integer,
	"player_name" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expected_return_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"overdue_alert_sent_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "cart_maintenance_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"cart_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"service_date" timestamp with time zone NOT NULL,
	"next_service_due" timestamp with time zone,
	"notes" text NOT NULL,
	"logged_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "carts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"identifier" text NOT NULL,
	"type" "cart_type" DEFAULT 'double' NOT NULL,
	"status" "cart_status" DEFAULT 'available' NOT NULL,
	"notes" text,
	"next_service_due" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "charity_challenge_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"challenge_id" integer NOT NULL,
	"tournament_id" integer NOT NULL,
	"winner_player_id" integer,
	"winner_name" text,
	"achieved_value" numeric(10, 2),
	"donation_amount" numeric(10, 2),
	"notes" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "charity_challenges" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"challenge_type" text DEFAULT 'longest_drive' NOT NULL,
	"hole_number" integer,
	"unit" text DEFAULT 'metres',
	"donation_per_unit" numeric(10, 2),
	"currency" text DEFAULT 'GBP' NOT NULL,
	"fixed_donation" numeric(10, 2),
	"target_amount" numeric(10, 2),
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "charity_fundraising_totals" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"charity_name" text NOT NULL,
	"charity_logo_url" text,
	"target_amount" numeric(10, 2),
	"raised_amount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"justgiving_url" text,
	"gofundme_url" text,
	"donation_page_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charity_fundraising_totals_tournament_id_unique" UNIQUE("tournament_id")
);

CREATE TABLE IF NOT EXISTS "club_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" "document_category" DEFAULT 'other' NOT NULL,
	"access" "document_access" DEFAULT 'all_members' NOT NULL,
	"current_version_id" integer,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"uploaded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "coaching_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_id" integer NOT NULL,
	"pro_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "committee_meetings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "meeting_status" DEFAULT 'scheduled' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"location" text,
	"chairperson_id" integer,
	"minutes_published" boolean DEFAULT false NOT NULL,
	"minutes_published_at" timestamp with time zone,
	"access" "document_access" DEFAULT 'committee_only' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "committee_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"meeting_id" integer,
	"title" text NOT NULL,
	"description" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "vote_status" DEFAULT 'draft' NOT NULL,
	"access" "document_access" DEFAULT 'committee_only' NOT NULL,
	"deadline" timestamp with time zone,
	"results_visible" boolean DEFAULT false NOT NULL,
	"allow_abstain" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "consignment_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"consignor_user_id" integer,
	"consignor_name" text NOT NULL,
	"consignor_email" text,
	"consignor_phone" text,
	"title" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'equipment' NOT NULL,
	"brand" text,
	"condition" text DEFAULT 'good' NOT NULL,
	"asking_price" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"commission_rate" numeric(5, 2) DEFAULT '20' NOT NULL,
	"image_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "consignment_status" DEFAULT 'unsold' NOT NULL,
	"sale_price" numeric(10, 2),
	"sold_at" timestamp with time zone,
	"shop_product_id" integer,
	"listed_in_shop" boolean DEFAULT false NOT NULL,
	"commission_amount" numeric(10, 2),
	"payout_amount" numeric(10, 2),
	"payout_method" "consignment_payout_method",
	"payout_reference" text,
	"paid_at" timestamp with time zone,
	"paid_by_user_id" integer,
	"returned_at" timestamp with time zone,
	"notes" text,
	"lookup_token" text NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consignment_items_lookup_token_unique" UNIQUE("lookup_token")
);

CREATE TABLE IF NOT EXISTS "corporate_event_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"company_name" text NOT NULL,
	"contact_name" text,
	"contact_email" text,
	"contact_phone" text,
	"logo_url" text,
	"primary_color" text DEFAULT '#1e4d2b',
	"secondary_color" text DEFAULT '#ffffff',
	"invoice_address" text,
	"vat_number" text,
	"purchase_order_ref" text,
	"invoice_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corporate_event_profiles_tournament_id_unique" UNIQUE("tournament_id")
);

CREATE TABLE IF NOT EXISTS "corporate_team_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"player_id" integer NOT NULL
);

CREATE TABLE IF NOT EXISTS "corporate_teams" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"company_name" text NOT NULL,
	"team_name" text NOT NULL,
	"contact_name" text,
	"contact_email" text,
	"logo_url" text,
	"colour" text DEFAULT '#22c55e',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "delivery_receipt_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_receipt_id" integer NOT NULL,
	"purchase_order_line_id" integer NOT NULL,
	"received_qty" integer NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "delivery_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_order_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"received_by_user_id" integer,
	"notes" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "display_board_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"active_tournament_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rotation_sequence" jsonb DEFAULT '["leaderboard","tracker","sidegames","sponsor"]'::jsonb NOT NULL,
	"rotation_interval_seconds" integer DEFAULT 20 NOT NULL,
	"sponsor_slide_duration_seconds" integer DEFAULT 10 NOT NULL,
	"show_sponsor_slides" boolean DEFAULT true NOT NULL,
	"show_side_games" boolean DEFAULT true NOT NULL,
	"show_tracker" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "display_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"organization_id" integer NOT NULL,
	"tournament_id" integer,
	"label" text,
	"expires_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "display_codes_code_unique" UNIQUE("code")
);

CREATE TABLE IF NOT EXISTS "document_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"version_number" integer DEFAULT 1 NOT NULL,
	"file_url" text NOT NULL,
	"file_name" text NOT NULL,
	"file_size_bytes" integer,
	"mime_type" text,
	"change_notes" text,
	"uploaded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "fantasy_draft_picks" (
	"id" serial PRIMARY KEY NOT NULL,
	"fantasy_league_id" integer NOT NULL,
	"fantasy_team_id" integer NOT NULL,
	"player_id" integer NOT NULL,
	"pick_number" integer NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"picked_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "fantasy_leagues" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer,
	"tournament_id" integer,
	"name" text NOT NULL,
	"description" text,
	"status" "fantasy_league_status" DEFAULT 'setup' NOT NULL,
	"format" "fantasy_league_format" DEFAULT 'overall_standings' NOT NULL,
	"draft_type" "fantasy_draft_type" DEFAULT 'snake' NOT NULL,
	"roster_size" integer DEFAULT 5 NOT NULL,
	"max_teams" integer,
	"draft_deadline_at" timestamp with time zone,
	"roster_lock_at" timestamp with time zone,
	"invite_code" text,
	"commissioner_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fantasy_leagues_invite_code_unique" UNIQUE("invite_code")
);

CREATE TABLE IF NOT EXISTS "fantasy_matchups" (
	"id" serial PRIMARY KEY NOT NULL,
	"fantasy_league_id" integer NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"home_team_id" integer NOT NULL,
	"away_team_id" integer NOT NULL,
	"home_points" integer DEFAULT 0 NOT NULL,
	"away_points" integer DEFAULT 0 NOT NULL,
	"winner_id" integer,
	"is_completed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "fantasy_scoring_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"fantasy_league_id" integer NOT NULL,
	"event" "fantasy_score_event" NOT NULL,
	"points" integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "fantasy_standings" (
	"id" serial PRIMARY KEY NOT NULL,
	"fantasy_league_id" integer NOT NULL,
	"fantasy_team_id" integer NOT NULL,
	"player_id" integer NOT NULL,
	"fantasy_points" integer DEFAULT 0 NOT NULL,
	"points_breakdown" jsonb DEFAULT '{}'::jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "fantasy_teams" (
	"id" serial PRIMARY KEY NOT NULL,
	"fantasy_league_id" integer NOT NULL,
	"user_id" integer,
	"name" text NOT NULL,
	"draft_order" integer,
	"total_fantasy_points" integer DEFAULT 0 NOT NULL,
	"position" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "gift_card_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"gift_card_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"amount_paise" integer NOT NULL,
	"balance_before_paise" integer NOT NULL,
	"balance_after_paise" integer NOT NULL,
	"redeemed_by_user_id" integer,
	"pos_transaction_id" integer,
	"shop_order_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "gift_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"code" text NOT NULL,
	"type" "gift_card_type" DEFAULT 'digital' NOT NULL,
	"status" "gift_card_status" DEFAULT 'active' NOT NULL,
	"initial_balance_paise" integer NOT NULL,
	"current_balance_paise" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"purchaser_name" text,
	"purchaser_email" text,
	"recipient_name" text,
	"recipient_email" text,
	"recipient_phone" text,
	"message" text,
	"issued_by_user_id" integer,
	"linked_member_id" integer,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"is_purchased_online" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"email_sent_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "governance_notices" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"access" "document_access" DEFAULT 'all_members' NOT NULL,
	"expires_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"is_published" boolean DEFAULT false NOT NULL,
	"posted_by" integer,
	"attachment_url" text,
	"attachment_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "group_pace_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"tee_time_id" integer NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"current_hole" integer DEFAULT 0 NOT NULL,
	"actual_elapsed_minutes" integer DEFAULT 0 NOT NULL,
	"target_elapsed_minutes" integer DEFAULT 0 NOT NULL,
	"deviation_minutes" integer DEFAULT 0 NOT NULL,
	"pace_status" text DEFAULT 'on_pace' NOT NULL,
	"last_hole_completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "hole_par_times" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"hole_number" integer NOT NULL,
	"par_minutes" integer DEFAULT 14 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "lesson_bookings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"pro_id" integer NOT NULL,
	"lesson_type_id" integer NOT NULL,
	"user_id" integer,
	"member_name" text NOT NULL,
	"member_email" text,
	"member_phone" text,
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"status" "lesson_booking_status" DEFAULT 'pending' NOT NULL,
	"payment_status" "lesson_payment_status" DEFAULT 'unpaid' NOT NULL,
	"amount_paise" integer DEFAULT 0 NOT NULL,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"notes" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "lesson_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"pro_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"price_paise" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "loyalty_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"current_tier" "loyalty_tier" DEFAULT 'none' NOT NULL,
	"points_balance" integer DEFAULT 0 NOT NULL,
	"lifetime_points" integer DEFAULT 0 NOT NULL,
	"rolling_year_points" integer DEFAULT 0 NOT NULL,
	"last_tier_calculated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "loyalty_program" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"points_name" text DEFAULT 'Points' NOT NULL,
	"base_earn_rate" numeric(8, 4) DEFAULT '1' NOT NULL,
	"category_rates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"min_spend_to_earn" numeric(10, 2) DEFAULT '0' NOT NULL,
	"points_expire_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_program_organization_id_unique" UNIQUE("organization_id")
);

CREATE TABLE IF NOT EXISTS "loyalty_rewards" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"reward_type" "loyalty_reward_type" DEFAULT 'other' NOT NULL,
	"points_cost" integer NOT NULL,
	"discount_value" numeric(10, 2),
	"min_tier" "loyalty_tier" DEFAULT 'none' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"stock" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "loyalty_tiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"tier" "loyalty_tier" NOT NULL,
	"label" text NOT NULL,
	"min_points" integer NOT NULL,
	"multiplier" numeric(4, 2) DEFAULT '1' NOT NULL,
	"perks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"badge_icon" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "loyalty_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"type" "loyalty_transaction_type" NOT NULL,
	"points" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"service_category" "loyalty_service_category",
	"reference_id" text,
	"description" text,
	"reward_id" integer,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "meeting_agenda_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"duration" integer,
	"document_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "meeting_minutes" (
	"id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"content" text NOT NULL,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attachment_url" text,
	"attachment_name" text,
	"recorded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "member_account_charges" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"club_member_id" integer NOT NULL,
	"pos_transaction_id" integer,
	"amount" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"description" text,
	"is_settled" boolean DEFAULT false NOT NULL,
	"settled_at" timestamp with time zone,
	"settled_by_user_id" integer,
	"settlement_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "pace_alert_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"warning_threshold_minutes" integer DEFAULT 10 NOT NULL,
	"critical_threshold_minutes" integer DEFAULT 20 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pace_alert_settings_tournament_id_unique" UNIQUE("tournament_id")
);

CREATE TABLE IF NOT EXISTS "pace_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"tee_time_id" integer NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"alert_type" text DEFAULT 'warning' NOT NULL,
	"deviation_minutes" integer NOT NULL,
	"current_hole" integer NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "points_table" (
	"id" serial PRIMARY KEY NOT NULL,
	"series_id" integer NOT NULL,
	"position" integer NOT NULL,
	"points" integer NOT NULL
);

CREATE TABLE IF NOT EXISTS "pos_transaction_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"transaction_id" integer NOT NULL,
	"product_id" integer,
	"variant_id" integer,
	"product_name" text NOT NULL,
	"sku" text,
	"category" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price" numeric(10, 2) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(10, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "pos_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"receipt_number" text NOT NULL,
	"staff_user_id" integer,
	"club_member_id" integer,
	"member_name" text,
	"customer_name" text,
	"customer_email" text,
	"payment_method" "pos_payment_method" NOT NULL,
	"subtotal" numeric(10, 2) NOT NULL,
	"discount_amount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"total_amount" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" "pos_transaction_status" DEFAULT 'completed' NOT NULL,
	"razorpay_payment_id" text,
	"notes" text,
	"receipt_emailed" boolean DEFAULT false NOT NULL,
	"transacted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "pro_availability" (
	"id" serial PRIMARY KEY NOT NULL,
	"pro_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"day_of_week" integer,
	"start_time" text,
	"end_time" text,
	"specific_date" timestamp with time zone,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"slot_interval_minutes" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "purchase_order_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_order_id" integer NOT NULL,
	"product_id" integer,
	"product_name" text NOT NULL,
	"sku" text,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(10, 2) NOT NULL,
	"line_total" numeric(10, 2) NOT NULL,
	"received_qty" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "purchase_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"supplier_id" integer NOT NULL,
	"po_number" text NOT NULL,
	"status" "po_status" DEFAULT 'draft' NOT NULL,
	"expected_delivery_date" timestamp with time zone,
	"notes" text,
	"total_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"sent_at" timestamp with time zone,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "ranking_entry" (
	"id" serial PRIMARY KEY NOT NULL,
	"series_id" integer NOT NULL,
	"user_id" integer,
	"player_name" text NOT NULL,
	"player_email" text,
	"category" "ranking_category" DEFAULT 'open' NOT NULL,
	"total_points" integer DEFAULT 0 NOT NULL,
	"events_played" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"runner_ups" integer DEFAULT 0 NOT NULL,
	"top3" integer DEFAULT 0 NOT NULL,
	"position" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "ranking_points_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"series_id" integer NOT NULL,
	"ranking_entry_id" integer NOT NULL,
	"tournament_id" integer NOT NULL,
	"position" integer NOT NULL,
	"base_points" integer NOT NULL,
	"multiplier" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"points_awarded" integer NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "ranking_series" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"name" text NOT NULL,
	"description" text,
	"level" "ranking_series_level" DEFAULT 'club' NOT NULL,
	"status" "ranking_series_status" DEFAULT 'draft' NOT NULL,
	"season_start" timestamp with time zone NOT NULL,
	"season_end" timestamp with time zone NOT NULL,
	"tiebreaker" "ranking_tiebreaker" DEFAULT 'most_wins' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "ranking_snapshot" (
	"id" serial PRIMARY KEY NOT NULL,
	"series_id" integer NOT NULL,
	"snapshot_data" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_by" integer
);

CREATE TABLE IF NOT EXISTS "series_event_enrollment" (
	"id" serial PRIMARY KEY NOT NULL,
	"series_id" integer NOT NULL,
	"tournament_id" integer NOT NULL,
	"category" "ranking_category" DEFAULT 'open' NOT NULL,
	"points_multiplier" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "shop_product_variants" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"color" text,
	"size" text,
	"stock_qty" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "shop_store_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"gstin" text,
	"seller_name" text,
	"seller_address" text,
	"seller_state" text,
	"seller_state_code" text,
	"shiprocket_email" text,
	"shiprocket_password" text,
	"shiprocket_token" text,
	"shiprocket_token_expiry" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_store_settings_organization_id_unique" UNIQUE("organization_id")
);

CREATE TABLE IF NOT EXISTS "sponsor_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"sponsor_id" integer NOT NULL,
	"assignment_id" integer,
	"package_id" integer,
	"invoice_number" text NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"payment_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"razorpay_payment_link_id" text,
	"razorpay_payment_link_url" text,
	"razorpay_payment_id" text,
	"due_date" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "sponsorship_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"sponsor_id" integer NOT NULL,
	"package_id" integer,
	"tournament_id" integer,
	"hole_number" integer,
	"assignment_type" text DEFAULT 'event' NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "sponsorship_packages" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"deliverables" jsonb DEFAULT '[]'::jsonb,
	"package_type" text DEFAULT 'event' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "store_credit_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	"balance_paise" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "store_credit_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"type" "store_credit_transaction_type" NOT NULL,
	"amount_paise" integer NOT NULL,
	"balance_before_paise" integer NOT NULL,
	"balance_after_paise" integer NOT NULL,
	"performed_by_user_id" integer,
	"pos_transaction_id" integer,
	"shop_order_id" integer,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"email" text,
	"phone" text,
	"address" text,
	"payment_terms" text,
	"lead_time_days" integer,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "teaching_pros" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"user_id" integer,
	"display_name" text NOT NULL,
	"email" text,
	"phone" text,
	"bio" text,
	"photo_url" text,
	"specialisms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"cancellation_window_hours" integer DEFAULT 24 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "vote_ballots" (
	"id" serial PRIMARY KEY NOT NULL,
	"vote_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"choice" text,
	"abstained" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "cart_assignments" ADD CONSTRAINT "cart_assignments_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "cart_assignments" ADD CONSTRAINT "cart_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "cart_assignments" ADD CONSTRAINT "cart_assignments_booking_id_tee_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."tee_bookings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "cart_assignments" ADD CONSTRAINT "cart_assignments_assigned_by_user_id_app_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "cart_maintenance_logs" ADD CONSTRAINT "cart_maintenance_logs_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "cart_maintenance_logs" ADD CONSTRAINT "cart_maintenance_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "cart_maintenance_logs" ADD CONSTRAINT "cart_maintenance_logs_logged_by_user_id_app_users_id_fk" FOREIGN KEY ("logged_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "carts" ADD CONSTRAINT "carts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "charity_challenge_results" ADD CONSTRAINT "charity_challenge_results_challenge_id_charity_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."charity_challenges"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "charity_challenge_results" ADD CONSTRAINT "charity_challenge_results_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "charity_challenge_results" ADD CONSTRAINT "charity_challenge_results_winner_player_id_players_id_fk" FOREIGN KEY ("winner_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "charity_challenges" ADD CONSTRAINT "charity_challenges_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "charity_fundraising_totals" ADD CONSTRAINT "charity_fundraising_totals_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "club_documents" ADD CONSTRAINT "club_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "club_documents" ADD CONSTRAINT "club_documents_uploaded_by_app_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "coaching_notes" ADD CONSTRAINT "coaching_notes_booking_id_lesson_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."lesson_bookings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "coaching_notes" ADD CONSTRAINT "coaching_notes_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "coaching_notes" ADD CONSTRAINT "coaching_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "committee_meetings" ADD CONSTRAINT "committee_meetings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "committee_meetings" ADD CONSTRAINT "committee_meetings_chairperson_id_app_users_id_fk" FOREIGN KEY ("chairperson_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "committee_meetings" ADD CONSTRAINT "committee_meetings_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "committee_votes" ADD CONSTRAINT "committee_votes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "committee_votes" ADD CONSTRAINT "committee_votes_meeting_id_committee_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."committee_meetings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "committee_votes" ADD CONSTRAINT "committee_votes_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "consignment_items" ADD CONSTRAINT "consignment_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "consignment_items" ADD CONSTRAINT "consignment_items_consignor_user_id_app_users_id_fk" FOREIGN KEY ("consignor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "consignment_items" ADD CONSTRAINT "consignment_items_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "consignment_items" ADD CONSTRAINT "consignment_items_paid_by_user_id_app_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "consignment_items" ADD CONSTRAINT "consignment_items_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "corporate_event_profiles" ADD CONSTRAINT "corporate_event_profiles_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "corporate_team_members" ADD CONSTRAINT "corporate_team_members_team_id_corporate_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."corporate_teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "corporate_team_members" ADD CONSTRAINT "corporate_team_members_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "corporate_teams" ADD CONSTRAINT "corporate_teams_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "delivery_receipt_lines" ADD CONSTRAINT "delivery_receipt_lines_delivery_receipt_id_delivery_receipts_id_fk" FOREIGN KEY ("delivery_receipt_id") REFERENCES "public"."delivery_receipts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "delivery_receipt_lines" ADD CONSTRAINT "delivery_receipt_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "delivery_receipts" ADD CONSTRAINT "delivery_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "delivery_receipts" ADD CONSTRAINT "delivery_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "delivery_receipts" ADD CONSTRAINT "delivery_receipts_received_by_user_id_app_users_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "display_board_settings" ADD CONSTRAINT "display_board_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "display_codes" ADD CONSTRAINT "display_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "display_codes" ADD CONSTRAINT "display_codes_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "display_codes" ADD CONSTRAINT "display_codes_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_club_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."club_documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_uploaded_by_app_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_draft_picks" ADD CONSTRAINT "fantasy_draft_picks_fantasy_league_id_fantasy_leagues_id_fk" FOREIGN KEY ("fantasy_league_id") REFERENCES "public"."fantasy_leagues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_draft_picks" ADD CONSTRAINT "fantasy_draft_picks_fantasy_team_id_fantasy_teams_id_fk" FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_draft_picks" ADD CONSTRAINT "fantasy_draft_picks_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_leagues" ADD CONSTRAINT "fantasy_leagues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_leagues" ADD CONSTRAINT "fantasy_leagues_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_leagues" ADD CONSTRAINT "fantasy_leagues_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_leagues" ADD CONSTRAINT "fantasy_leagues_commissioner_user_id_app_users_id_fk" FOREIGN KEY ("commissioner_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_matchups" ADD CONSTRAINT "fantasy_matchups_fantasy_league_id_fantasy_leagues_id_fk" FOREIGN KEY ("fantasy_league_id") REFERENCES "public"."fantasy_leagues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_matchups" ADD CONSTRAINT "fantasy_matchups_home_team_id_fantasy_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_matchups" ADD CONSTRAINT "fantasy_matchups_away_team_id_fantasy_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_matchups" ADD CONSTRAINT "fantasy_matchups_winner_id_fantasy_teams_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_scoring_rules" ADD CONSTRAINT "fantasy_scoring_rules_fantasy_league_id_fantasy_leagues_id_fk" FOREIGN KEY ("fantasy_league_id") REFERENCES "public"."fantasy_leagues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_standings" ADD CONSTRAINT "fantasy_standings_fantasy_league_id_fantasy_leagues_id_fk" FOREIGN KEY ("fantasy_league_id") REFERENCES "public"."fantasy_leagues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_standings" ADD CONSTRAINT "fantasy_standings_fantasy_team_id_fantasy_teams_id_fk" FOREIGN KEY ("fantasy_team_id") REFERENCES "public"."fantasy_teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_standings" ADD CONSTRAINT "fantasy_standings_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_teams" ADD CONSTRAINT "fantasy_teams_fantasy_league_id_fantasy_leagues_id_fk" FOREIGN KEY ("fantasy_league_id") REFERENCES "public"."fantasy_leagues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "fantasy_teams" ADD CONSTRAINT "fantasy_teams_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "gift_card_redemptions" ADD CONSTRAINT "gift_card_redemptions_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "gift_card_redemptions" ADD CONSTRAINT "gift_card_redemptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "gift_card_redemptions" ADD CONSTRAINT "gift_card_redemptions_redeemed_by_user_id_app_users_id_fk" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_issued_by_user_id_app_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_linked_member_id_club_members_id_fk" FOREIGN KEY ("linked_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "governance_notices" ADD CONSTRAINT "governance_notices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "governance_notices" ADD CONSTRAINT "governance_notices_posted_by_app_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "group_pace_records" ADD CONSTRAINT "group_pace_records_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "group_pace_records" ADD CONSTRAINT "group_pace_records_tee_time_id_tee_times_id_fk" FOREIGN KEY ("tee_time_id") REFERENCES "public"."tee_times"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "hole_par_times" ADD CONSTRAINT "hole_par_times_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lesson_bookings" ADD CONSTRAINT "lesson_bookings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lesson_bookings" ADD CONSTRAINT "lesson_bookings_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lesson_bookings" ADD CONSTRAINT "lesson_bookings_lesson_type_id_lesson_types_id_fk" FOREIGN KEY ("lesson_type_id") REFERENCES "public"."lesson_types"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lesson_bookings" ADD CONSTRAINT "lesson_bookings_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lesson_bookings" ADD CONSTRAINT "lesson_bookings_cancelled_by_user_id_app_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lesson_types" ADD CONSTRAINT "lesson_types_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "lesson_types" ADD CONSTRAINT "lesson_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "loyalty_program" ADD CONSTRAINT "loyalty_program_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "loyalty_tiers" ADD CONSTRAINT "loyalty_tiers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_account_id_loyalty_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."loyalty_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "meeting_agenda_items" ADD CONSTRAINT "meeting_agenda_items_meeting_id_committee_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."committee_meetings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "meeting_agenda_items" ADD CONSTRAINT "meeting_agenda_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "meeting_agenda_items" ADD CONSTRAINT "meeting_agenda_items_document_id_club_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."club_documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_meeting_id_committee_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."committee_meetings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_recorded_by_app_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "member_account_charges" ADD CONSTRAINT "member_account_charges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "member_account_charges" ADD CONSTRAINT "member_account_charges_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "member_account_charges" ADD CONSTRAINT "member_account_charges_pos_transaction_id_pos_transactions_id_fk" FOREIGN KEY ("pos_transaction_id") REFERENCES "public"."pos_transactions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "member_account_charges" ADD CONSTRAINT "member_account_charges_settled_by_user_id_app_users_id_fk" FOREIGN KEY ("settled_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "pace_alert_settings" ADD CONSTRAINT "pace_alert_settings_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "pace_alerts" ADD CONSTRAINT "pace_alerts_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "pace_alerts" ADD CONSTRAINT "pace_alerts_tee_time_id_tee_times_id_fk" FOREIGN KEY ("tee_time_id") REFERENCES "public"."tee_times"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "pace_alerts" ADD CONSTRAINT "pace_alerts_acknowledged_by_user_id_app_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "points_table" ADD CONSTRAINT "points_table_series_id_ranking_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."ranking_series"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "pos_transaction_items" ADD CONSTRAINT "pos_transaction_items_transaction_id_pos_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."pos_transactions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "pos_transaction_items" ADD CONSTRAINT "pos_transaction_items_product_id_shop_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shop_products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "pos_transactions" ADD CONSTRAINT "pos_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "pos_transactions" ADD CONSTRAINT "pos_transactions_staff_user_id_app_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "pos_transactions" ADD CONSTRAINT "pos_transactions_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "pro_availability" ADD CONSTRAINT "pro_availability_pro_id_teaching_pros_id_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "pro_availability" ADD CONSTRAINT "pro_availability_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_shop_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shop_products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ranking_entry" ADD CONSTRAINT "ranking_entry_series_id_ranking_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."ranking_series"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ranking_entry" ADD CONSTRAINT "ranking_entry_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ranking_points_history" ADD CONSTRAINT "ranking_points_history_series_id_ranking_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."ranking_series"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ranking_points_history" ADD CONSTRAINT "ranking_points_history_ranking_entry_id_ranking_entry_id_fk" FOREIGN KEY ("ranking_entry_id") REFERENCES "public"."ranking_entry"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ranking_points_history" ADD CONSTRAINT "ranking_points_history_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ranking_series" ADD CONSTRAINT "ranking_series_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ranking_series" ADD CONSTRAINT "ranking_series_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ranking_snapshot" ADD CONSTRAINT "ranking_snapshot_series_id_ranking_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."ranking_series"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ranking_snapshot" ADD CONSTRAINT "ranking_snapshot_archived_by_app_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "series_event_enrollment" ADD CONSTRAINT "series_event_enrollment_series_id_ranking_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."ranking_series"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "series_event_enrollment" ADD CONSTRAINT "series_event_enrollment_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "shop_product_variants" ADD CONSTRAINT "shop_product_variants_product_id_shop_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "shop_store_settings" ADD CONSTRAINT "shop_store_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "sponsor_invoices" ADD CONSTRAINT "sponsor_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "sponsor_invoices" ADD CONSTRAINT "sponsor_invoices_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "sponsor_invoices" ADD CONSTRAINT "sponsor_invoices_assignment_id_sponsorship_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."sponsorship_assignments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "sponsor_invoices" ADD CONSTRAINT "sponsor_invoices_package_id_sponsorship_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."sponsorship_packages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "sponsorship_assignments" ADD CONSTRAINT "sponsorship_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "sponsorship_assignments" ADD CONSTRAINT "sponsorship_assignments_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "sponsorship_assignments" ADD CONSTRAINT "sponsorship_assignments_package_id_sponsorship_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."sponsorship_packages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "sponsorship_assignments" ADD CONSTRAINT "sponsorship_assignments_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "sponsorship_packages" ADD CONSTRAINT "sponsorship_packages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_credit_accounts" ADD CONSTRAINT "store_credit_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_credit_accounts" ADD CONSTRAINT "store_credit_accounts_member_id_club_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_credit_transactions" ADD CONSTRAINT "store_credit_transactions_account_id_store_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."store_credit_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_credit_transactions" ADD CONSTRAINT "store_credit_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_credit_transactions" ADD CONSTRAINT "store_credit_transactions_performed_by_user_id_app_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "teaching_pros" ADD CONSTRAINT "teaching_pros_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "teaching_pros" ADD CONSTRAINT "teaching_pros_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "vote_ballots" ADD CONSTRAINT "vote_ballots_vote_id_committee_votes_id_fk" FOREIGN KEY ("vote_id") REFERENCES "public"."committee_votes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "vote_ballots" ADD CONSTRAINT "vote_ballots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "vote_ballots" ADD CONSTRAINT "vote_ballots_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "cart_assignments_cart_idx" ON "cart_assignments" USING btree ("cart_id");

CREATE INDEX IF NOT EXISTS "cart_assignments_org_idx" ON "cart_assignments" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "cart_assignments_booking_idx" ON "cart_assignments" USING btree ("booking_id");

CREATE UNIQUE INDEX IF NOT EXISTS "cart_assignments_active_unique" ON "cart_assignments" USING btree ("cart_id") WHERE "cart_assignments"."returned_at" IS NULL;

CREATE INDEX IF NOT EXISTS "cart_maintenance_logs_cart_idx" ON "cart_maintenance_logs" USING btree ("cart_id");

CREATE INDEX IF NOT EXISTS "cart_maintenance_logs_org_idx" ON "cart_maintenance_logs" USING btree ("organization_id");

CREATE UNIQUE INDEX IF NOT EXISTS "carts_org_identifier_unique" ON "carts" USING btree ("organization_id","identifier");

CREATE INDEX IF NOT EXISTS "carts_org_idx" ON "carts" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "charity_results_challenge_idx" ON "charity_challenge_results" USING btree ("challenge_id");

CREATE INDEX IF NOT EXISTS "charity_results_tournament_idx" ON "charity_challenge_results" USING btree ("tournament_id");

CREATE INDEX IF NOT EXISTS "charity_challenges_tournament_idx" ON "charity_challenges" USING btree ("tournament_id");

CREATE INDEX IF NOT EXISTS "charity_totals_tournament_idx" ON "charity_fundraising_totals" USING btree ("tournament_id");

CREATE INDEX IF NOT EXISTS "club_documents_org_idx" ON "club_documents" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "club_documents_category_idx" ON "club_documents" USING btree ("category");

CREATE UNIQUE INDEX IF NOT EXISTS "coaching_note_booking_unique" ON "coaching_notes" USING btree ("booking_id");

CREATE INDEX IF NOT EXISTS "coaching_notes_pro_idx" ON "coaching_notes" USING btree ("pro_id");

CREATE INDEX IF NOT EXISTS "committee_meetings_org_idx" ON "committee_meetings" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "committee_meetings_status_idx" ON "committee_meetings" USING btree ("status");

CREATE INDEX IF NOT EXISTS "committee_votes_org_idx" ON "committee_votes" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "committee_votes_status_idx" ON "committee_votes" USING btree ("status");

CREATE INDEX IF NOT EXISTS "consignment_items_org_idx" ON "consignment_items" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "consignment_items_status_idx" ON "consignment_items" USING btree ("status");

CREATE INDEX IF NOT EXISTS "consignment_items_consignor_user_idx" ON "consignment_items" USING btree ("consignor_user_id");

CREATE INDEX IF NOT EXISTS "corp_profiles_tournament_idx" ON "corporate_event_profiles" USING btree ("tournament_id");

CREATE UNIQUE INDEX IF NOT EXISTS "corp_team_member_unique" ON "corporate_team_members" USING btree ("team_id","player_id");

CREATE INDEX IF NOT EXISTS "corp_team_members_player_idx" ON "corporate_team_members" USING btree ("player_id");

CREATE INDEX IF NOT EXISTS "corp_teams_tournament_idx" ON "corporate_teams" USING btree ("tournament_id");

CREATE INDEX IF NOT EXISTS "delivery_receipt_lines_receipt_idx" ON "delivery_receipt_lines" USING btree ("delivery_receipt_id");

CREATE INDEX IF NOT EXISTS "delivery_receipts_po_idx" ON "delivery_receipts" USING btree ("purchase_order_id");

CREATE UNIQUE INDEX IF NOT EXISTS "display_board_settings_org_unique" ON "display_board_settings" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "display_codes_code_idx" ON "display_codes" USING btree ("code");

CREATE INDEX IF NOT EXISTS "document_versions_doc_idx" ON "document_versions" USING btree ("document_id");

CREATE UNIQUE INDEX IF NOT EXISTS "document_version_unique" ON "document_versions" USING btree ("document_id","version_number");

CREATE UNIQUE INDEX IF NOT EXISTS "fantasy_pick_league_player_unique" ON "fantasy_draft_picks" USING btree ("fantasy_league_id","player_id");

CREATE UNIQUE INDEX IF NOT EXISTS "fantasy_pick_number_unique" ON "fantasy_draft_picks" USING btree ("fantasy_league_id","pick_number");

CREATE INDEX IF NOT EXISTS "fantasy_picks_team_idx" ON "fantasy_draft_picks" USING btree ("fantasy_team_id");

CREATE INDEX IF NOT EXISTS "fantasy_leagues_org_idx" ON "fantasy_leagues" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "fantasy_leagues_league_idx" ON "fantasy_leagues" USING btree ("league_id");

CREATE INDEX IF NOT EXISTS "fantasy_leagues_tournament_idx" ON "fantasy_leagues" USING btree ("tournament_id");

CREATE INDEX IF NOT EXISTS "fantasy_matchups_league_idx" ON "fantasy_matchups" USING btree ("fantasy_league_id");

CREATE UNIQUE INDEX IF NOT EXISTS "fantasy_scoring_rule_unique" ON "fantasy_scoring_rules" USING btree ("fantasy_league_id","event");

CREATE UNIQUE INDEX IF NOT EXISTS "fantasy_standing_unique" ON "fantasy_standings" USING btree ("fantasy_team_id","player_id");

CREATE INDEX IF NOT EXISTS "fantasy_standings_league_idx" ON "fantasy_standings" USING btree ("fantasy_league_id");

CREATE UNIQUE INDEX IF NOT EXISTS "fantasy_team_user_league_unique" ON "fantasy_teams" USING btree ("fantasy_league_id","user_id");

CREATE INDEX IF NOT EXISTS "fantasy_teams_league_idx" ON "fantasy_teams" USING btree ("fantasy_league_id");

CREATE INDEX IF NOT EXISTS "gift_card_redemptions_card_idx" ON "gift_card_redemptions" USING btree ("gift_card_id");

CREATE INDEX IF NOT EXISTS "gift_card_redemptions_org_idx" ON "gift_card_redemptions" USING btree ("organization_id");

CREATE UNIQUE INDEX IF NOT EXISTS "gift_cards_org_code_unique" ON "gift_cards" USING btree ("organization_id","code");

CREATE INDEX IF NOT EXISTS "gift_cards_org_idx" ON "gift_cards" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "gift_cards_code_idx" ON "gift_cards" USING btree ("code");

CREATE INDEX IF NOT EXISTS "gift_cards_status_idx" ON "gift_cards" USING btree ("status");

CREATE INDEX IF NOT EXISTS "gift_cards_recipient_email_idx" ON "gift_cards" USING btree ("recipient_email");

CREATE INDEX IF NOT EXISTS "governance_notices_org_idx" ON "governance_notices" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "governance_notices_pinned_idx" ON "governance_notices" USING btree ("is_pinned");

CREATE UNIQUE INDEX IF NOT EXISTS "group_pace_record_unique" ON "group_pace_records" USING btree ("tee_time_id","round");

CREATE INDEX IF NOT EXISTS "group_pace_records_tournament_idx" ON "group_pace_records" USING btree ("tournament_id");

CREATE UNIQUE INDEX IF NOT EXISTS "hole_par_time_unique" ON "hole_par_times" USING btree ("course_id","hole_number");

CREATE INDEX IF NOT EXISTS "hole_par_times_course_idx" ON "hole_par_times" USING btree ("course_id");

CREATE INDEX IF NOT EXISTS "lesson_bookings_pro_idx" ON "lesson_bookings" USING btree ("pro_id");

CREATE INDEX IF NOT EXISTS "lesson_bookings_user_idx" ON "lesson_bookings" USING btree ("user_id");

CREATE INDEX IF NOT EXISTS "lesson_bookings_org_idx" ON "lesson_bookings" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "lesson_bookings_scheduled_idx" ON "lesson_bookings" USING btree ("scheduled_at");

CREATE INDEX IF NOT EXISTS "lesson_types_pro_idx" ON "lesson_types" USING btree ("pro_id");

CREATE INDEX IF NOT EXISTS "lesson_types_org_idx" ON "lesson_types" USING btree ("organization_id");

CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_accounts_org_user_unique" ON "loyalty_accounts" USING btree ("organization_id","user_id");

CREATE INDEX IF NOT EXISTS "loyalty_accounts_org_idx" ON "loyalty_accounts" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "loyalty_accounts_user_idx" ON "loyalty_accounts" USING btree ("user_id");

CREATE INDEX IF NOT EXISTS "loyalty_program_org_idx" ON "loyalty_program" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "loyalty_rewards_org_idx" ON "loyalty_rewards" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "loyalty_rewards_active_idx" ON "loyalty_rewards" USING btree ("organization_id","is_active");

CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_tiers_org_tier_unique" ON "loyalty_tiers" USING btree ("organization_id","tier");

CREATE INDEX IF NOT EXISTS "loyalty_tiers_org_idx" ON "loyalty_tiers" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "loyalty_txn_account_idx" ON "loyalty_transactions" USING btree ("account_id");

CREATE INDEX IF NOT EXISTS "loyalty_txn_org_idx" ON "loyalty_transactions" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "loyalty_txn_user_idx" ON "loyalty_transactions" USING btree ("user_id");

CREATE INDEX IF NOT EXISTS "loyalty_txn_created_idx" ON "loyalty_transactions" USING btree ("created_at");

CREATE INDEX IF NOT EXISTS "agenda_items_meeting_idx" ON "meeting_agenda_items" USING btree ("meeting_id");

CREATE UNIQUE INDEX IF NOT EXISTS "meeting_minutes_meeting_unique" ON "meeting_minutes" USING btree ("meeting_id");

CREATE INDEX IF NOT EXISTS "member_account_charges_member_idx" ON "member_account_charges" USING btree ("club_member_id");

CREATE INDEX IF NOT EXISTS "member_account_charges_org_idx" ON "member_account_charges" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "member_account_charges_settled_idx" ON "member_account_charges" USING btree ("is_settled");

CREATE INDEX IF NOT EXISTS "pace_alerts_tournament_idx" ON "pace_alerts" USING btree ("tournament_id");

CREATE INDEX IF NOT EXISTS "pace_alerts_tee_time_idx" ON "pace_alerts" USING btree ("tee_time_id");

CREATE UNIQUE INDEX IF NOT EXISTS "points_table_series_position_unique" ON "points_table" USING btree ("series_id","position");

CREATE INDEX IF NOT EXISTS "points_table_series_idx" ON "points_table" USING btree ("series_id");

CREATE INDEX IF NOT EXISTS "pos_transaction_items_txn_idx" ON "pos_transaction_items" USING btree ("transaction_id");

CREATE INDEX IF NOT EXISTS "pos_transactions_org_idx" ON "pos_transactions" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "pos_transactions_member_idx" ON "pos_transactions" USING btree ("club_member_id");

CREATE INDEX IF NOT EXISTS "pos_transactions_date_idx" ON "pos_transactions" USING btree ("transacted_at");

CREATE UNIQUE INDEX IF NOT EXISTS "pos_transactions_receipt_org_unique" ON "pos_transactions" USING btree ("organization_id","receipt_number");

CREATE INDEX IF NOT EXISTS "pro_availability_pro_idx" ON "pro_availability" USING btree ("pro_id");

CREATE INDEX IF NOT EXISTS "po_lines_po_idx" ON "purchase_order_lines" USING btree ("purchase_order_id");

CREATE INDEX IF NOT EXISTS "purchase_orders_org_idx" ON "purchase_orders" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("supplier_id");

CREATE UNIQUE INDEX IF NOT EXISTS "purchase_orders_po_number_org_unique" ON "purchase_orders" USING btree ("organization_id","po_number");

CREATE UNIQUE INDEX IF NOT EXISTS "ranking_entry_series_user_cat_unique" ON "ranking_entry" USING btree ("series_id","user_id","category");

CREATE INDEX IF NOT EXISTS "ranking_entry_series_idx" ON "ranking_entry" USING btree ("series_id");

CREATE INDEX IF NOT EXISTS "ranking_entry_user_idx" ON "ranking_entry" USING btree ("user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "ranking_history_entry_tournament_unique" ON "ranking_points_history" USING btree ("ranking_entry_id","tournament_id");

CREATE INDEX IF NOT EXISTS "ranking_history_series_idx" ON "ranking_points_history" USING btree ("series_id");

CREATE INDEX IF NOT EXISTS "ranking_history_entry_idx" ON "ranking_points_history" USING btree ("ranking_entry_id");

CREATE INDEX IF NOT EXISTS "ranking_series_org_idx" ON "ranking_series" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "ranking_series_status_idx" ON "ranking_series" USING btree ("status");

CREATE INDEX IF NOT EXISTS "ranking_snapshot_series_idx" ON "ranking_snapshot" USING btree ("series_id");

CREATE UNIQUE INDEX IF NOT EXISTS "series_event_unique" ON "series_event_enrollment" USING btree ("series_id","tournament_id");

CREATE INDEX IF NOT EXISTS "series_enrollment_series_idx" ON "series_event_enrollment" USING btree ("series_id");

CREATE INDEX IF NOT EXISTS "series_enrollment_tournament_idx" ON "series_event_enrollment" USING btree ("tournament_id");

CREATE INDEX IF NOT EXISTS "shop_variants_product_idx" ON "shop_product_variants" USING btree ("product_id");

CREATE INDEX IF NOT EXISTS "shop_store_settings_org_idx" ON "shop_store_settings" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "sponsor_invoices_org_idx" ON "sponsor_invoices" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "sponsor_invoices_sponsor_idx" ON "sponsor_invoices" USING btree ("sponsor_id");

CREATE UNIQUE INDEX IF NOT EXISTS "sponsor_invoice_number_org_unique" ON "sponsor_invoices" USING btree ("organization_id","invoice_number");

CREATE INDEX IF NOT EXISTS "sponsorship_assignments_org_idx" ON "sponsorship_assignments" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "sponsorship_assignments_sponsor_idx" ON "sponsorship_assignments" USING btree ("sponsor_id");

CREATE INDEX IF NOT EXISTS "sponsorship_assignments_tournament_idx" ON "sponsorship_assignments" USING btree ("tournament_id");

CREATE INDEX IF NOT EXISTS "sponsorship_packages_org_idx" ON "sponsorship_packages" USING btree ("organization_id");

CREATE UNIQUE INDEX IF NOT EXISTS "store_credit_org_member_unique" ON "store_credit_accounts" USING btree ("organization_id","member_id");

CREATE INDEX IF NOT EXISTS "store_credit_org_idx" ON "store_credit_accounts" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "store_credit_member_idx" ON "store_credit_accounts" USING btree ("member_id");

CREATE INDEX IF NOT EXISTS "store_credit_tx_account_idx" ON "store_credit_transactions" USING btree ("account_id");

CREATE INDEX IF NOT EXISTS "store_credit_tx_org_idx" ON "store_credit_transactions" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "suppliers_org_idx" ON "suppliers" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "teaching_pros_org_idx" ON "teaching_pros" USING btree ("organization_id");

CREATE INDEX IF NOT EXISTS "teaching_pros_user_idx" ON "teaching_pros" USING btree ("user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "vote_ballot_user_unique" ON "vote_ballots" USING btree ("vote_id","user_id");

CREATE INDEX IF NOT EXISTS "vote_ballots_vote_idx" ON "vote_ballots" USING btree ("vote_id");
