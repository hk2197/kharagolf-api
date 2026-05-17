DO $$ BEGIN CREATE TYPE "public"."league_format" AS ENUM('stableford', 'stroke_play', 'net_stroke', 'match_play', 'bogey', 'eclectic', 'foursomes', 'greensomes', 'texas_scramble', 'waltz', 'alliance', 'better_ball', 'order_of_merit', 'shamble'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."league_staff_role" AS ENUM('league_admin', 'competition_secretary'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."league_status" AS ENUM('draft', 'upcoming', 'active', 'completed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."league_type" AS ENUM('individual', 'team', 'pairs'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."member_subscription_status" AS ENUM('active', 'past_due', 'cancelled', 'expired', 'pending'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."org_role" AS ENUM('super_admin', 'org_admin', 'tournament_director', 'committee_member', 'competition_secretary', 'volunteer', 'player', 'spectator', 'pro_shop'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."payment_status" AS ENUM('unpaid', 'pending', 'paid', 'refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."shop_order_status" AS ENUM('pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."shot_type" AS ENUM('tee', 'fairway', 'approach', 'chip', 'sand', 'putt'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."subscription_tier" AS ENUM('free', 'starter', 'pro', 'enterprise'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."tee_box" AS ENUM('blue', 'white', 'red', 'gold', 'black'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."tournament_format" AS ENUM('stroke_play', 'net_stroke', 'best_ball', 'scramble', 'skins', 'match_play', 'stableford', 'shamble'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."tournament_staff_role" AS ENUM('tournament_admin', 'live_scorer', 'volunteer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."tournament_status" AS ENUM('draft', 'upcoming', 'active', 'completed', 'cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "achievements" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"organization_id" integer,
	"badge_type" text NOT NULL,
	"badge_label" text NOT NULL,
	"badge_icon" text NOT NULL,
	"badge_category" text DEFAULT 'milestone' NOT NULL,
	"tournament_id" integer,
	"league_id" integer,
	"metadata" jsonb,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "announcement_read_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"announcement_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"replit_user_id" text NOT NULL,
	"username" text NOT NULL,
	"email" text,
	"display_name" text,
	"profile_image" text,
	"role" "org_role" DEFAULT 'player' NOT NULL,
	"organization_id" integer,
	"password_hash" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_verification_token" text,
	"email_verification_expiry" timestamp with time zone,
	"password_reset_token" text,
	"password_reset_expiry" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_users_replit_user_id_unique" UNIQUE("replit_user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"room_id" integer NOT NULL,
	"user_id" integer,
	"display_name" text NOT NULL,
	"body" text NOT NULL,
	"message_type" text DEFAULT 'text' NOT NULL,
	"media_id" integer,
	"reactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_rooms" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"type" text NOT NULL,
	"entity_id" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"muted_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "club_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"tier_id" integer,
	"user_id" integer,
	"member_number" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"date_of_birth" timestamp with time zone,
	"handicap_index" numeric(4, 1),
	"whs_ghin_number" text,
	"join_date" timestamp with time zone DEFAULT now() NOT NULL,
	"renewal_date" timestamp with time zone,
	"show_in_directory" boolean DEFAULT true NOT NULL,
	"subscription_status" "member_subscription_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "courses" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"location" text,
	"holes" integer DEFAULT 18 NOT NULL,
	"par" integer DEFAULT 72 NOT NULL,
	"rating" numeric(4, 1),
	"slope" integer,
	"yardage" integer,
	"external_course_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token" text NOT NULL,
	"platform" text DEFAULT 'expo' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flights" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"handicap_min" numeric(4, 1),
	"handicap_max" numeric(4, 1),
	"tee_box" "tee_box",
	"max_players" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "handicap_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"tournament_id" integer,
	"handicap_index" numeric(4, 1) NOT NULL,
	"round_gross" integer,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hole_details" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"hole_number" integer NOT NULL,
	"par" integer DEFAULT 4 NOT NULL,
	"handicap" integer,
	"yardage_blue" integer,
	"yardage_white" integer,
	"yardage_red" integer,
	"description" text,
	"green_front_lat" numeric(10, 7),
	"green_front_lng" numeric(10, 7),
	"green_centre_lat" numeric(10, 7),
	"green_centre_lng" numeric(10, 7),
	"green_back_lat" numeric(10, 7),
	"green_back_lng" numeric(10, 7)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hole_sponsors" (
	"id" serial PRIMARY KEY NOT NULL,
	"sponsor_id" integer NOT NULL,
	"tournament_id" integer NOT NULL,
	"hole_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invitations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"tournament_id" integer,
	"league_id" integer,
	"token" text NOT NULL,
	"recipient_email" text,
	"recipient_phone" text,
	"recipient_name" text,
	"channels" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "league_fixtures" (
	"id" serial PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"league_round_id" integer,
	"round_number" integer DEFAULT 1 NOT NULL,
	"home_id" integer NOT NULL,
	"away_id" integer NOT NULL,
	"scheduled_date" timestamp with time zone,
	"home_score" integer,
	"away_score" integer,
	"result" text,
	"is_played" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "league_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"user_id" integer,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"handicap_index" numeric(4, 1),
	"team_name" text,
	"payment_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"razorpay_refund_id" text,
	"payment_link_id" text,
	"payment_link_url" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "league_round_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"round_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	"gross_score" integer,
	"net_score" integer,
	"stableford_points" integer,
	"match_result" text,
	"hole_scores" jsonb,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "league_rounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"tournament_id" integer,
	"round_number" integer NOT NULL,
	"name" text,
	"scheduled_date" timestamp with time zone,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"points_multiplier" numeric(3, 1) DEFAULT '1.0',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "league_staff" (
	"id" serial PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" "league_staff_role" DEFAULT 'league_admin' NOT NULL,
	"invited_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "league_standings" (
	"id" serial PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	"rounds_played" integer DEFAULT 0 NOT NULL,
	"won" integer DEFAULT 0 NOT NULL,
	"drawn" integer DEFAULT 0 NOT NULL,
	"lost" integer DEFAULT 0 NOT NULL,
	"total_points" integer DEFAULT 0 NOT NULL,
	"total_gross" integer DEFAULT 0 NOT NULL,
	"total_net" integer DEFAULT 0 NOT NULL,
	"total_stableford" integer DEFAULT 0 NOT NULL,
	"best_score" integer,
	"position" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leagues" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"course_id" integer,
	"name" text NOT NULL,
	"description" text,
	"format" "league_format" DEFAULT 'stableford' NOT NULL,
	"type" "league_type" DEFAULT 'individual' NOT NULL,
	"status" "league_status" DEFAULT 'draft' NOT NULL,
	"season_start" timestamp with time zone,
	"season_end" timestamp with time zone,
	"max_members" integer,
	"entry_fee" numeric(10, 2),
	"currency" text DEFAULT 'INR' NOT NULL,
	"handicap_allowance" integer DEFAULT 100,
	"points_per_win" integer DEFAULT 2,
	"points_per_draw" integer DEFAULT 1,
	"points_per_loss" integer DEFAULT 0,
	"rounds_count" integer DEFAULT 1,
	"is_public" boolean DEFAULT false NOT NULL,
	"oom_points_config" jsonb,
	"media_moderation_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "match_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"player1_id" integer NOT NULL,
	"player2_id" integer NOT NULL,
	"winner_id" integer,
	"result" text,
	"player1_holes" integer,
	"player2_holes" integer,
	"notes" text,
	"is_complete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"tournament_id" integer,
	"league_id" integer,
	"uploaded_by_user_id" integer,
	"uploader_name" text,
	"object_path" text NOT NULL,
	"thumbnail_path" text,
	"media_type" text DEFAULT 'image' NOT NULL,
	"caption" text,
	"approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"club_member_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"tier_id" integer,
	"razorpay_subscription_id" text,
	"razorpay_plan_id" text,
	"status" "member_subscription_status" DEFAULT 'pending' NOT NULL,
	"next_billing_date" timestamp with time zone,
	"last_payment_at" timestamp with time zone,
	"last_payment_id" text,
	"cancelled_at" timestamp with time zone,
	"failed_payment_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "membership_tiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"annual_fee" numeric(10, 2) DEFAULT '0' NOT NULL,
	"billing_period" text DEFAULT 'annual' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"grace_period_days" integer DEFAULT 14 NOT NULL,
	"razorpay_plan_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"tournament_id" integer,
	"league_id" integer,
	"subject" text,
	"body" text NOT NULL,
	"channels" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"template_key" text,
	"sent_by_user_id" integer,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"delivery_stats" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"type" text DEFAULT 'general' NOT NULL,
	"channels" jsonb DEFAULT '["email"]'::jsonb NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_memberships" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" "org_role" DEFAULT 'player' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"logo_url" text,
	"primary_color" text DEFAULT '#1e4d2b',
	"custom_domain" text,
	"subscription_tier" "subscription_tier" DEFAULT 'free' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"stripe_customer_id" text,
	"shop_review_moderation_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_flights" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_id" integer NOT NULL,
	"flight_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "players" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"user_id" integer,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"handicap_index" numeric(4, 1),
	"handicap_override" numeric(4, 1),
	"ghin_number" text,
	"flight" text,
	"tee_box" "tee_box" DEFAULT 'white',
	"payment_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"stripe_payment_id" text,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"razorpay_refund_id" text,
	"payment_link_id" text,
	"payment_link_url" text,
	"checked_in" boolean DEFAULT false NOT NULL,
	"checked_in_at" timestamp with time zone,
	"dns" boolean DEFAULT false NOT NULL,
	"team_name" text,
	"current_round" integer DEFAULT 1 NOT NULL,
	"current_hole" integer,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prize_awards" (
	"id" serial PRIMARY KEY NOT NULL,
	"prize_category_id" integer NOT NULL,
	"tournament_id" integer NOT NULL,
	"player_id" integer,
	"player_name" text NOT NULL,
	"notes" text,
	"certificate_url" text,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prize_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"prize_value" numeric(10, 2),
	"currency" text DEFAULT 'INR' NOT NULL,
	"sponsor_id" integer,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "round_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"player_id" integer NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"marker_player_id" integer,
	"marker_code" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_strokes" integer,
	"notes" text,
	"rejection_reason" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scorer_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"pin" text NOT NULL,
	"label" text,
	"created_by" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"player_id" integer NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"hole_number" integer NOT NULL,
	"strokes" integer NOT NULL,
	"putts" integer,
	"fairway_hit" boolean,
	"gir_hit" boolean,
	"is_verified" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"user_id" integer,
	"customer_name" text NOT NULL,
	"customer_email" text NOT NULL,
	"customer_phone" text,
	"size" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price" numeric(10, 2) NOT NULL,
	"total_amount" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"shipping_address" jsonb,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"printful_order_id" text,
	"tracking_number" text,
	"tracking_url" text,
	"status" "shop_order_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"printful_product_id" text,
	"printful_variant_id" text,
	"size_variant_map" jsonb,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"category" text DEFAULT 'apparel' NOT NULL,
	"fulfillment_type" text DEFAULT 'printful' NOT NULL,
	"affiliate_url" text,
	"base_price" numeric(10, 2) NOT NULL,
	"markup_price" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"sizes" jsonb DEFAULT '["XS","S","M","L","XL","XXL"]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"stock_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_review_prompts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"order_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"is_dismissed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"is_approved" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_wishlist" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shots" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"player_id" integer NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"hole_number" integer NOT NULL,
	"shot_number" integer DEFAULT 1 NOT NULL,
	"shot_type" "shot_type" DEFAULT 'fairway' NOT NULL,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"distance_to_pin" numeric(8, 1),
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "side_game_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"player_id" integer NOT NULL,
	"game_type" text NOT NULL,
	"hole_number" integer,
	"round" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"prize" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "side_games_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"skins_enabled" boolean DEFAULT false NOT NULL,
	"skins_prize" text,
	"ctp_enabled" boolean DEFAULT false NOT NULL,
	"ctp_holes" jsonb DEFAULT '[]'::jsonb,
	"ctp_prize" text,
	"ld_enabled" boolean DEFAULT false NOT NULL,
	"ld_holes" jsonb DEFAULT '[]'::jsonb,
	"ld_prize" text,
	"greenies_enabled" boolean DEFAULT false NOT NULL,
	"greenies_prize" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "side_games_config_tournament_id_unique" UNIQUE("tournament_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sponsors" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"tournament_id" integer,
	"name" text NOT NULL,
	"tier" text DEFAULT 'gold' NOT NULL,
	"logo_url" text,
	"website_url" text,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tee_time_players" (
	"id" serial PRIMARY KEY NOT NULL,
	"tee_time_id" integer NOT NULL,
	"player_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tee_times" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"tee_time" timestamp with time zone NOT NULL,
	"starting_hole" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tournament_announcements" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"body" text NOT NULL,
	"type" text DEFAULT 'general' NOT NULL,
	"author_name" text,
	"sent_by_user_id" integer,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tournament_staff" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" "tournament_staff_role" DEFAULT 'volunteer' NOT NULL,
	"invited_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tournaments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"course_id" integer,
	"name" text NOT NULL,
	"description" text,
	"format" "tournament_format" DEFAULT 'stroke_play' NOT NULL,
	"status" "tournament_status" DEFAULT 'draft' NOT NULL,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"rounds" integer DEFAULT 1 NOT NULL,
	"max_players" integer,
	"entry_fee" numeric(10, 2),
	"currency" text DEFAULT 'INR' NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"allow_spectators" boolean DEFAULT true NOT NULL,
	"registration_deadline" timestamp with time zone,
	"self_posting" boolean DEFAULT false NOT NULL,
	"marker_validation" boolean DEFAULT false NOT NULL,
	"handicap_allowance" integer DEFAULT 100 NOT NULL,
	"cut_line" integer,
	"check_in_cutoff_at" timestamp with time zone,
	"auto_welcome" boolean DEFAULT true NOT NULL,
	"auto_reminder" boolean DEFAULT true NOT NULL,
	"auto_results" boolean DEFAULT false NOT NULL,
	"reminder_days_before" integer,
	"media_moderation_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_notification_prefs" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"prefer_email" boolean DEFAULT true NOT NULL,
	"prefer_push" boolean DEFAULT true NOT NULL,
	"prefer_sms" boolean DEFAULT false NOT NULL,
	"prefer_whatsapp" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "waitlist" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"handicap_index" numeric(4, 1),
	"flight" text,
	"tee_box" "tee_box" DEFAULT 'white',
	"position" integer NOT NULL,
	"promoted_at" timestamp with time zone,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wearable_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"external_user_id" text,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "withdrawals" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"player_name" text NOT NULL,
	"player_email" text NOT NULL,
	"phone" text,
	"handicap_index" numeric(4, 1),
	"flight" text,
	"tee_box" text,
	"entry_fee" integer,
	"payment_status" text,
	"payment_reference" text,
	"refund_status" text DEFAULT 'pending' NOT NULL,
	"refund_reference" text,
	"refund_notes" text,
	"withdrawn_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_name" text
);
--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'achievements' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "achievements" ADD CONSTRAINT "achievements_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'achievements' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "achievements" ADD CONSTRAINT "achievements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'achievements' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "achievements" ADD CONSTRAINT "achievements_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'achievements' AND column_name = 'league_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'leagues') THEN ALTER TABLE "achievements" ADD CONSTRAINT "achievements_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'announcement_read_receipts' AND column_name = 'announcement_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournament_announcements') THEN ALTER TABLE "announcement_read_receipts" ADD CONSTRAINT "announcement_read_receipts_announcement_id_tournament_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."tournament_announcements"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'announcement_read_receipts' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "announcement_read_receipts" ADD CONSTRAINT "announcement_read_receipts_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'app_users' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "app_users" ADD CONSTRAINT "app_users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chat_messages' AND column_name = 'room_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'chat_rooms') THEN ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_room_id_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_rooms"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chat_messages' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chat_messages' AND column_name = 'media_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'media') THEN ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chat_rooms' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "chat_rooms" ADD CONSTRAINT "chat_rooms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'club_members' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "club_members" ADD CONSTRAINT "club_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'club_members' AND column_name = 'tier_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'membership_tiers') THEN ALTER TABLE "club_members" ADD CONSTRAINT "club_members_tier_id_membership_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'club_members' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "club_members" ADD CONSTRAINT "club_members_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'courses' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "courses" ADD CONSTRAINT "courses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'device_tokens' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'flights' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "flights" ADD CONSTRAINT "flights_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'handicap_history' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "handicap_history" ADD CONSTRAINT "handicap_history_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'handicap_history' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "handicap_history" ADD CONSTRAINT "handicap_history_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hole_details' AND column_name = 'course_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'courses') THEN ALTER TABLE "hole_details" ADD CONSTRAINT "hole_details_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hole_sponsors' AND column_name = 'sponsor_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sponsors') THEN ALTER TABLE "hole_sponsors" ADD CONSTRAINT "hole_sponsors_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hole_sponsors' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "hole_sponsors" ADD CONSTRAINT "hole_sponsors_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'league_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'leagues') THEN ALTER TABLE "invitations" ADD CONSTRAINT "invitations_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_fixtures' AND column_name = 'league_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'leagues') THEN ALTER TABLE "league_fixtures" ADD CONSTRAINT "league_fixtures_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_fixtures' AND column_name = 'league_round_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'league_rounds') THEN ALTER TABLE "league_fixtures" ADD CONSTRAINT "league_fixtures_league_round_id_league_rounds_id_fk" FOREIGN KEY ("league_round_id") REFERENCES "public"."league_rounds"("id") ON DELETE no action ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_fixtures' AND column_name = 'home_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'league_members') THEN ALTER TABLE "league_fixtures" ADD CONSTRAINT "league_fixtures_home_id_league_members_id_fk" FOREIGN KEY ("home_id") REFERENCES "public"."league_members"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_fixtures' AND column_name = 'away_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'league_members') THEN ALTER TABLE "league_fixtures" ADD CONSTRAINT "league_fixtures_away_id_league_members_id_fk" FOREIGN KEY ("away_id") REFERENCES "public"."league_members"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_members' AND column_name = 'league_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'leagues') THEN ALTER TABLE "league_members" ADD CONSTRAINT "league_members_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_members' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "league_members" ADD CONSTRAINT "league_members_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_round_results' AND column_name = 'league_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'leagues') THEN ALTER TABLE "league_round_results" ADD CONSTRAINT "league_round_results_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_round_results' AND column_name = 'round_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'league_rounds') THEN ALTER TABLE "league_round_results" ADD CONSTRAINT "league_round_results_round_id_league_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."league_rounds"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_round_results' AND column_name = 'member_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'league_members') THEN ALTER TABLE "league_round_results" ADD CONSTRAINT "league_round_results_member_id_league_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."league_members"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_rounds' AND column_name = 'league_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'leagues') THEN ALTER TABLE "league_rounds" ADD CONSTRAINT "league_rounds_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_rounds' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "league_rounds" ADD CONSTRAINT "league_rounds_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE no action ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_staff' AND column_name = 'league_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'leagues') THEN ALTER TABLE "league_staff" ADD CONSTRAINT "league_staff_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_staff' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "league_staff" ADD CONSTRAINT "league_staff_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_staff' AND column_name = 'invited_by') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "league_staff" ADD CONSTRAINT "league_staff_invited_by_app_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_standings' AND column_name = 'league_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'leagues') THEN ALTER TABLE "league_standings" ADD CONSTRAINT "league_standings_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'league_standings' AND column_name = 'member_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'league_members') THEN ALTER TABLE "league_standings" ADD CONSTRAINT "league_standings_member_id_league_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."league_members"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'leagues' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "leagues" ADD CONSTRAINT "leagues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'leagues' AND column_name = 'course_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'courses') THEN ALTER TABLE "leagues" ADD CONSTRAINT "leagues_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'match_results' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "match_results" ADD CONSTRAINT "match_results_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'match_results' AND column_name = 'player1_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN ALTER TABLE "match_results" ADD CONSTRAINT "match_results_player1_id_players_id_fk" FOREIGN KEY ("player1_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'match_results' AND column_name = 'player2_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN ALTER TABLE "match_results" ADD CONSTRAINT "match_results_player2_id_players_id_fk" FOREIGN KEY ("player2_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'match_results' AND column_name = 'winner_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN ALTER TABLE "match_results" ADD CONSTRAINT "match_results_winner_id_players_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'media' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "media" ADD CONSTRAINT "media_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'media' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "media" ADD CONSTRAINT "media_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'media' AND column_name = 'league_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'leagues') THEN ALTER TABLE "media" ADD CONSTRAINT "media_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'media' AND column_name = 'uploaded_by_user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_user_id_app_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'member_subscriptions' AND column_name = 'club_member_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'club_members') THEN ALTER TABLE "member_subscriptions" ADD CONSTRAINT "member_subscriptions_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'member_subscriptions' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "member_subscriptions" ADD CONSTRAINT "member_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'member_subscriptions' AND column_name = 'tier_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'membership_tiers') THEN ALTER TABLE "member_subscriptions" ADD CONSTRAINT "member_subscriptions_tier_id_membership_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'membership_tiers' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "membership_tiers" ADD CONSTRAINT "membership_tiers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_logs' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_logs' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_logs' AND column_name = 'league_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'leagues') THEN ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_logs' AND column_name = 'sent_by_user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_sent_by_user_id_app_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_templates' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'message_templates' AND column_name = 'created_by_user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'org_memberships' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'org_memberships' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'player_flights' AND column_name = 'player_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN ALTER TABLE "player_flights" ADD CONSTRAINT "player_flights_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'player_flights' AND column_name = 'flight_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'flights') THEN ALTER TABLE "player_flights" ADD CONSTRAINT "player_flights_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'players' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "players" ADD CONSTRAINT "players_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'players' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "players" ADD CONSTRAINT "players_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'prize_awards' AND column_name = 'prize_category_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'prize_categories') THEN ALTER TABLE "prize_awards" ADD CONSTRAINT "prize_awards_prize_category_id_prize_categories_id_fk" FOREIGN KEY ("prize_category_id") REFERENCES "public"."prize_categories"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'prize_awards' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "prize_awards" ADD CONSTRAINT "prize_awards_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'prize_awards' AND column_name = 'player_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN ALTER TABLE "prize_awards" ADD CONSTRAINT "prize_awards_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'prize_categories' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "prize_categories" ADD CONSTRAINT "prize_categories_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'prize_categories' AND column_name = 'sponsor_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sponsors') THEN ALTER TABLE "prize_categories" ADD CONSTRAINT "prize_categories_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'round_submissions' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "round_submissions" ADD CONSTRAINT "round_submissions_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'round_submissions' AND column_name = 'player_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN ALTER TABLE "round_submissions" ADD CONSTRAINT "round_submissions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'round_submissions' AND column_name = 'marker_player_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN ALTER TABLE "round_submissions" ADD CONSTRAINT "round_submissions_marker_player_id_players_id_fk" FOREIGN KEY ("marker_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'scorer_credentials' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "scorer_credentials" ADD CONSTRAINT "scorer_credentials_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'scorer_credentials' AND column_name = 'created_by') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "scorer_credentials" ADD CONSTRAINT "scorer_credentials_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'scores' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "scores" ADD CONSTRAINT "scores_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'scores' AND column_name = 'player_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN ALTER TABLE "scores" ADD CONSTRAINT "scores_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shop_orders' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shop_orders' AND column_name = 'product_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'shop_products') THEN ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_product_id_shop_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shop_products"("id") ON DELETE restrict ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shop_orders' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shop_products' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "shop_products" ADD CONSTRAINT "shop_products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shop_review_prompts' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "shop_review_prompts" ADD CONSTRAINT "shop_review_prompts_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shop_review_prompts' AND column_name = 'order_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'shop_orders') THEN ALTER TABLE "shop_review_prompts" ADD CONSTRAINT "shop_review_prompts_order_id_shop_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shop_orders"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shop_review_prompts' AND column_name = 'product_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'shop_products') THEN ALTER TABLE "shop_review_prompts" ADD CONSTRAINT "shop_review_prompts_product_id_shop_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shop_reviews' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "shop_reviews" ADD CONSTRAINT "shop_reviews_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shop_reviews' AND column_name = 'product_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'shop_products') THEN ALTER TABLE "shop_reviews" ADD CONSTRAINT "shop_reviews_product_id_shop_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shop_reviews' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "shop_reviews" ADD CONSTRAINT "shop_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shop_wishlist' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "shop_wishlist" ADD CONSTRAINT "shop_wishlist_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shop_wishlist' AND column_name = 'product_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'shop_products') THEN ALTER TABLE "shop_wishlist" ADD CONSTRAINT "shop_wishlist_product_id_shop_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shots' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "shots" ADD CONSTRAINT "shots_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'shots' AND column_name = 'player_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN ALTER TABLE "shots" ADD CONSTRAINT "shots_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'side_game_results' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "side_game_results" ADD CONSTRAINT "side_game_results_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'side_game_results' AND column_name = 'player_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN ALTER TABLE "side_game_results" ADD CONSTRAINT "side_game_results_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'side_games_config' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "side_games_config" ADD CONSTRAINT "side_games_config_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sponsors' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sponsors' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tee_time_players' AND column_name = 'tee_time_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tee_times') THEN ALTER TABLE "tee_time_players" ADD CONSTRAINT "tee_time_players_tee_time_id_tee_times_id_fk" FOREIGN KEY ("tee_time_id") REFERENCES "public"."tee_times"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tee_time_players' AND column_name = 'player_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN ALTER TABLE "tee_time_players" ADD CONSTRAINT "tee_time_players_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tee_times' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "tee_times" ADD CONSTRAINT "tee_times_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tournament_announcements' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "tournament_announcements" ADD CONSTRAINT "tournament_announcements_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tournament_announcements' AND column_name = 'sent_by_user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "tournament_announcements" ADD CONSTRAINT "tournament_announcements_sent_by_user_id_app_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tournament_staff' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "tournament_staff" ADD CONSTRAINT "tournament_staff_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tournament_staff' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "tournament_staff" ADD CONSTRAINT "tournament_staff_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tournament_staff' AND column_name = 'invited_by') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "tournament_staff" ADD CONSTRAINT "tournament_staff_invited_by_app_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tournaments' AND column_name = 'organization_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tournaments' AND column_name = 'course_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'courses') THEN ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_notification_prefs' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "user_notification_prefs" ADD CONSTRAINT "user_notification_prefs_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'waitlist' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'wearable_connections' AND column_name = 'user_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_users') THEN ALTER TABLE "wearable_connections" ADD CONSTRAINT "wearable_connections_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'withdrawals' AND column_name = 'tournament_id') AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tournaments') THEN ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "sessions" USING btree ("expire");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "achievements_user_idx" ON "achievements" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "achievement_user_badge_unique" ON "achievements" USING btree ("user_id","badge_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_receipt_unique" ON "announcement_read_receipts" USING btree ("announcement_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_receipt_ann_idx" ON "announcement_read_receipts" USING btree ("announcement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_users_email_idx" ON "app_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_room_idx" ON "chat_messages" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_room_entity_unique" ON "chat_rooms" USING btree ("organization_id","type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_room_org_idx" ON "chat_rooms" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "club_members_org_idx" ON "club_members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "club_members_email_idx" ON "club_members" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_token_user_unique" ON "device_tokens" USING btree ("user_id","token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "handicap_history_user_idx" ON "handicap_history" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "course_hole_unique" ON "hole_details" USING btree ("course_id","hole_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hole_sponsor_unique" ON "hole_sponsors" USING btree ("tournament_id","hole_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_org_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_token_idx" ON "invitations" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "league_member_unique" ON "league_members" USING btree ("league_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "league_round_member_unique" ON "league_round_results" USING btree ("round_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "league_staff_unique" ON "league_staff" USING btree ("league_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "league_member_standing_unique" ON "league_standings" USING btree ("league_id","member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_tournament_idx" ON "media" USING btree ("tournament_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_league_idx" ON "media" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_org_idx" ON "media" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_subscriptions_member_idx" ON "member_subscriptions" USING btree ("club_member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_tiers_org_idx" ON "membership_tiers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_logs_org_idx" ON "message_logs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "templates_org_idx" ON "message_templates" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_user_unique" ON "org_memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_flight_unique" ON "player_flights" USING btree ("player_id","flight_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prize_awards_tournament_idx" ON "prize_awards" USING btree ("tournament_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prize_categories_tournament_idx" ON "prize_categories" USING btree ("tournament_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_round_submission_unique" ON "round_submissions" USING btree ("player_id","round");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scorer_creds_tournament_idx" ON "scorer_credentials" USING btree ("tournament_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_round_hole_unique" ON "scores" USING btree ("player_id","round","hole_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_orders_org_idx" ON "shop_orders" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_products_org_idx" ON "shop_products" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_review_prompts_user_order_unique" ON "shop_review_prompts" USING btree ("user_id","order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_review_prompts_user_idx" ON "shop_review_prompts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_reviews_user_product_unique" ON "shop_reviews" USING btree ("user_id","product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_reviews_product_idx" ON "shop_reviews" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_reviews_org_idx" ON "shop_reviews" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_wishlist_user_product_unique" ON "shop_wishlist" USING btree ("user_id","product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_wishlist_user_idx" ON "shop_wishlist" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shots_player_tournament_round_hole_shot_unique" ON "shots" USING btree ("player_id","tournament_id","round","hole_number","shot_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sponsors_org_idx" ON "sponsors" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sponsors_tournament_idx" ON "sponsors" USING btree ("tournament_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tee_time_player_unique" ON "tee_time_players" USING btree ("tee_time_id","player_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcements_tournament_idx" ON "tournament_announcements" USING btree ("tournament_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tournament_staff_unique" ON "tournament_staff" USING btree ("tournament_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "waitlist_tournament_idx" ON "waitlist" USING btree ("tournament_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wearable_user_provider_unique" ON "wearable_connections" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wearable_user_idx" ON "wearable_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "withdrawals_tournament_idx" ON "withdrawals" USING btree ("tournament_id");--> statement-breakpoint
CREATE OR REPLACE VIEW "public"."eclectic_scores_view" AS (select "tournament_id", "player_id", "hole_number", MIN("strokes") as "best_strokes" from "scores" group by "scores"."tournament_id", "scores"."player_id", "scores"."hole_number");