-- Catch-up migration # (Task #1403): missing enum types and enum value additions.
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
  CREATE TYPE "public"."ai_caddie_mode" AS ENUM('open', 'distance_only', 'lockdown');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."badge_share_method" AS ENUM('copy', 'web_share', 'native_share');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."coach_payout_status" AS ENUM('pending', 'processing', 'paid', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."course_correction_status" AS ENUM('open', 'accepted', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."cross_club_ladder_format" AS ENUM('stroke', 'stableford', 'team_series', 'knockout_cup', 'national_ladder');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."cross_club_ladder_scope" AS ENUM('regional', 'national');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."cross_club_ladder_status" AS ENUM('draft', 'open', 'active', 'completed', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."fb_order_type" AS ENUM('counter', 'table', 'on_course');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."fb_tab_status" AS ENUM('open', 'closed', 'voided');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."hazard_type" AS ENUM('water', 'bunker', 'ob', 'tree_line');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."highlight_reel_status" AS ENUM('queued', 'rendering', 'ready', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."payment_processor" AS ENUM('razorpay', 'stripe', 'manual');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."promotion_scope" AS ENUM('all', 'category', 'product');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."promotion_type" AS ENUM('percentage', 'fixed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."reg_form_event_type" AS ENUM('tournament', 'league');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."reg_form_field_type" AS ENUM('short_text', 'long_text', 'dropdown', 'checkbox', 'file_upload', 'terms_acceptance');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."swing_review_status" AS ENUM('pending_payment', 'paid', 'in_review', 'delivered', 'refunded', 'expired');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."swing_view" AS ENUM('dtl', 'fo', 'side', 'behind', 'other');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tax_jurisdiction_kind" AS ENUM('gst', 'vat', 'sales_tax', 'none');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tee_waitlist_status" AS ENUM('waiting', 'promoted', 'expired', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ===== Catch-up enum types (added by post-merge fresh-DB hardening) =====
-- These types are originally created by earlier migrations that may be
-- skipped on a fresh DB by the post-merge guard. Recreating them here
-- (idempotently) ensures the 0115-0118 catch-up tables/columns/FKs apply.

DO $$ BEGIN
  CREATE TYPE "public"."caddie_assignment_status" AS ENUM('requested', 'assigned', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."caddie_fee_mode" AS ENUM('cash', 'account');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."commission_source" AS ENUM('pos', 'lesson');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."course_tee_slot_status" AS ENUM('open', 'blocked', 'booked', 'members_only');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."general_play_status" AS ENUM('draft', 'in_progress', 'pending_marker', 'confirmed', 'disputed', 'unverified', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."guest_fee_settlement" AS ENUM('member_account', 'guest_online', 'pay_at_desk');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."guest_pass_status" AS ENUM('pending', 'confirmed', 'checked_in', 'no_show', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."highlight_reel_engagement_type" AS ENUM('download', 'share');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."leaderboard_type" AS ENUM('gross', 'net', 'both');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."practice_session_type" AS ENUM('range', 'putting', 'short_game', 'on_course', 'simulator', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."rental_booking_status" AS ENUM('reserved', 'checked_out', 'returned', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."subscription_tier" AS ENUM('free', 'starter', 'pro', 'enterprise');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."swing_video_fps_probe_status" AS ENUM('queued', 'probing', 'done', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tee_booking_player_type" AS ENUM('member', 'guest');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tee_booking_status" AS ENUM('pending', 'confirmed', 'cancelled', 'forfeited', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tee_start_type" AS ENUM('normal', 'split_tee', 'shotgun');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tiebreaker_method" AS ENUM('countback', 'multi_round_countback', 'net_countback', 'lower_handicap', 'no_tiebreaker');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."tournament_format" AS ENUM('stroke_play', 'net_stroke', 'best_ball', 'scramble', 'skins', 'match_play', 'stableford', 'shamble', 'match_play_bracket', 'ryder_cup');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."whs_posting_status" AS ENUM('pending', 'posted', 'failed', 'no_ghin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


ALTER TYPE "public"."org_role" ADD VALUE IF NOT EXISTS 'membership_secretary' BEFORE 'tournament_director';

ALTER TYPE "public"."org_role" ADD VALUE IF NOT EXISTS 'treasurer' BEFORE 'tournament_director';

ALTER TYPE "public"."pos_payment_method" ADD VALUE IF NOT EXISTS 'gift_card';

ALTER TYPE "public"."pos_payment_method" ADD VALUE IF NOT EXISTS 'split_gift_card_cash';

ALTER TYPE "public"."tournament_status" ADD VALUE IF NOT EXISTS 'suspended';
