-- Migration 0017: Create missing tables from recent task merges
  -- Applied: Staff Scheduling, Dues Billing, Accounting, Marketing, Waitlist,
  --          Event Staffing, Range Bookings, Championship, Interclub, Junior Golf
  
-- Step 1: Create enum types (safe IF NOT EXISTS)

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'accounting_platform') THEN
    CREATE TYPE "public"."accounting_platform" AS ENUM('xero', 'quickbooks');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'accounting_sync_status') THEN
    CREATE TYPE "public"."accounting_sync_status" AS ENUM('pending', 'synced', 'failed', 'skipped');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'application_stage') THEN
    CREATE TYPE "public"."application_stage" AS ENUM('applied', 'under_review', 'pending_committee', 'approved', 'rejected');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_cycle') THEN
    CREATE TYPE "public"."billing_cycle" AS ENUM('annual', 'semi_annual', 'quarterly', 'monthly');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bracket_type') THEN
    CREATE TYPE "public"."bracket_type" AS ENUM('main', 'consolation');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'caddie_assignment_status') THEN
    CREATE TYPE "public"."caddie_assignment_status" AS ENUM('requested', 'assigned', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'caddie_experience_level') THEN
    CREATE TYPE "public"."caddie_experience_level" AS ENUM('trainee', 'junior', 'standard', 'senior', 'master');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'caddie_fee_mode') THEN
    CREATE TYPE "public"."caddie_fee_mode" AS ENUM('cash', 'account');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'campaign_channel') THEN
    CREATE TYPE "public"."campaign_channel" AS ENUM('email', 'push');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'campaign_status') THEN
    CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'paused');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'campaign_type') THEN
    CREATE TYPE "public"."campaign_type" AS ENUM('one_off', 'drip');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cart_status') THEN
    CREATE TYPE "public"."cart_status" AS ENUM('available', 'in_use', 'maintenance', 'retired');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cart_type') THEN
    CREATE TYPE "public"."cart_type" AS ENUM('single', 'double');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'commission_payout_status') THEN
    CREATE TYPE "public"."commission_payout_status" AS ENUM('pending', 'approved', 'paid', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'commission_source') THEN
    CREATE TYPE "public"."commission_source" AS ENUM('pos', 'lesson');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'commission_type') THEN
    CREATE TYPE "public"."commission_type" AS ENUM('percentage', 'flat_per_sale');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'condition_rating') THEN
    CREATE TYPE "public"."condition_rating" AS ENUM('excellent', 'good', 'fair', 'poor', 'closed');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'consignment_payout_method') THEN
    CREATE TYPE "public"."consignment_payout_method" AS ENUM('cash', 'bank_transfer', 'cheque', 'account_credit', 'other');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'consignment_status') THEN
    CREATE TYPE "public"."consignment_status" AS ENUM('unsold', 'sold', 'payout_pending', 'paid', 'returned');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'course_area') THEN
    CREATE TYPE "public"."course_area" AS ENUM('hole_1', 'hole_2', 'hole_3', 'hole_4', 'hole_5', 'hole_6', 'hole_7', 'hole_8', 'hole_9', 'hole_10', 'hole_11', 'hole_12', 'hole_13', 'hole_14', 'hole_15', 'hole_16', 'hole_17', 'hole_18', 'driving_range', 'practice_green', 'clubhouse_surrounds', 'car_park', 'general');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'course_tee_slot_status') THEN
    CREATE TYPE "public"."course_tee_slot_status" AS ENUM('open', 'blocked', 'booked', 'members_only');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'document_access') THEN
    CREATE TYPE "public"."document_access" AS ENUM('public', 'all_members', 'committee_only');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'document_category') THEN
    CREATE TYPE "public"."document_category" AS ENUM('constitution', 'handicap_policy', 'course_rules', 'committee_minutes', 'agm_documents', 'financial_reports', 'bylaws', 'other');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dues_invoice_status') THEN
    CREATE TYPE "public"."dues_invoice_status" AS ENUM('draft', 'sent', 'paid', 'overdue', 'cancelled', 'void');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dues_payment_method') THEN
    CREATE TYPE "public"."dues_payment_method" AS ENUM('online', 'bank_transfer', 'account_credit', 'cash', 'cheque');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'equipment_type') THEN
    CREATE TYPE "public"."equipment_type" AS ENUM('mower_fairway', 'mower_green', 'mower_rough', 'mower_tee', 'irrigation_pump', 'irrigation_controller', 'aerator', 'scarifier', 'topdresser', 'sprayer', 'tractor', 'utility_vehicle', 'other');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_enquiry_status') THEN
    CREATE TYPE "public"."event_enquiry_status" AS ENUM('enquiry', 'quote_sent', 'confirmed', 'invoiced', 'paid', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_invoice_status') THEN
    CREATE TYPE "public"."event_invoice_status" AS ENUM('draft', 'sent', 'paid', 'overdue', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_type') THEN
    CREATE TYPE "public"."event_type" AS ENUM('standard', 'corporate', 'charity');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fantasy_draft_type') THEN
    CREATE TYPE "public"."fantasy_draft_type" AS ENUM('snake', 'simultaneous');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fantasy_league_format') THEN
    CREATE TYPE "public"."fantasy_league_format" AS ENUM('overall_standings', 'head_to_head');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fantasy_league_status') THEN
    CREATE TYPE "public"."fantasy_league_status" AS ENUM('setup', 'drafting', 'active', 'completed');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fantasy_score_event') THEN
    CREATE TYPE "public"."fantasy_score_event" AS ENUM('hole_in_one', 'eagle', 'birdie', 'par', 'bogey', 'double_bogey', 'triple_bogey_plus', 'finish_1st', 'finish_2nd', 'finish_3rd', 'finish_top5', 'finish_top10', 'under_par_round', 'par_round');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fb_order_status') THEN
    CREATE TYPE "public"."fb_order_status" AS ENUM('received', 'preparing', 'ready', 'delivered', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fb_payment_method') THEN
    CREATE TYPE "public"."fb_payment_method" AS ENUM('account_charge', 'card_on_delivery');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'feed_post_type') THEN
    CREATE TYPE "public"."feed_post_type" AS ENUM('member_post', 'achievement', 'club_announcement');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'feed_privacy') THEN
    CREATE TYPE "public"."feed_privacy" AS ENUM('all_members', 'followers_only');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'feed_report_reason') THEN
    CREATE TYPE "public"."feed_report_reason" AS ENUM('inappropriate', 'spam', 'offensive', 'other');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fitting_session_status') THEN
    CREATE TYPE "public"."fitting_session_status" AS ENUM('booked', 'completed', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'function_space_layout') THEN
    CREATE TYPE "public"."function_space_layout" AS ENUM('theatre', 'classroom', 'banquet', 'cabaret', 'boardroom', 'cocktail', 'u_shape', 'hollow_square');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'general_play_status') THEN
    CREATE TYPE "public"."general_play_status" AS ENUM('draft', 'in_progress', 'pending_marker', 'confirmed', 'disputed', 'unverified', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gift_card_status') THEN
    CREATE TYPE "public"."gift_card_status" AS ENUM('active', 'redeemed', 'expired', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gift_card_type') THEN
    CREATE TYPE "public"."gift_card_type" AS ENUM('physical', 'digital');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'guest_fee_settlement') THEN
    CREATE TYPE "public"."guest_fee_settlement" AS ENUM('member_account', 'guest_online', 'pay_at_desk');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'guest_pass_status') THEN
    CREATE TYPE "public"."guest_pass_status" AS ENUM('pending', 'confirmed', 'checked_in', 'no_show', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'itinerary_item_type') THEN
    CREATE TYPE "public"."itinerary_item_type" AS ENUM('travel', 'golf_round', 'dinner', 'accommodation', 'activity', 'free_time');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'junior_age_category') THEN
    CREATE TYPE "public"."junior_age_category" AS ENUM('under_8', 'under_10', 'under_12', 'under_14', 'under_16', 'under_18');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'junior_award_type') THEN
    CREATE TYPE "public"."junior_award_type" AS ENUM('monthly_winner', 'most_improved', 'best_attendance', 'spirit_award', 'custom');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'junior_pathway_level') THEN
    CREATE TYPE "public"."junior_pathway_level" AS ENUM('beginner', 'intermediate', 'advanced', 'elite');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'leaderboard_type') THEN
    CREATE TYPE "public"."leaderboard_type" AS ENUM('gross', 'net', 'both');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'league_format') THEN
    CREATE TYPE "public"."league_format" AS ENUM('stableford', 'stroke_play', 'net_stroke', 'match_play', 'bogey', 'eclectic', 'foursomes', 'greensomes', 'texas_scramble', 'waltz', 'alliance', 'better_ball', 'order_of_merit', 'shamble');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'league_staff_role') THEN
    CREATE TYPE "public"."league_staff_role" AS ENUM('league_admin', 'competition_secretary');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'league_status') THEN
    CREATE TYPE "public"."league_status" AS ENUM('draft', 'upcoming', 'active', 'completed');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'league_type') THEN
    CREATE TYPE "public"."league_type" AS ENUM('individual', 'team', 'pairs');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'leave_status') THEN
    CREATE TYPE "public"."leave_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'leave_type') THEN
    CREATE TYPE "public"."leave_type" AS ENUM('annual', 'sick', 'unpaid', 'personal', 'bereavement', 'public_holiday');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ledger_event_type') THEN
    CREATE TYPE "public"."ledger_event_type" AS ENUM('pos_sale', 'booking_fee', 'membership_due', 'lesson_fee', 'fb_order', 'event_fee', 'rental_fee', 'commission', 'gift_card_sale', 'gift_card_redemption', 'refund', 'other');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lesson_booking_status') THEN
    CREATE TYPE "public"."lesson_booking_status" AS ENUM('pending', 'confirmed', 'cancelled', 'completed', 'no_show');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lesson_payment_status') THEN
    CREATE TYPE "public"."lesson_payment_status" AS ENUM('unpaid', 'pending', 'paid', 'refunded');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'locker_assignment_status') THEN
    CREATE TYPE "public"."locker_assignment_status" AS ENUM('active', 'expired', 'cancelled', 'pending_payment');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'locker_payment_method') THEN
    CREATE TYPE "public"."locker_payment_method" AS ENUM('account_charge', 'razorpay');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'locker_status') THEN
    CREATE TYPE "public"."locker_status" AS ENUM('available', 'occupied', 'reserved', 'maintenance');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'loyalty_service_category') THEN
    CREATE TYPE "public"."loyalty_service_category" AS ENUM('pos', 'fb', 'lesson', 'tee_booking', 'tee_time', 'general');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'loyalty_tier') THEN
    CREATE TYPE "public"."loyalty_tier" AS ENUM('none', 'silver', 'gold', 'platinum');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'loyalty_transaction_type') THEN
    CREATE TYPE "public"."loyalty_transaction_type" AS ENUM('earn', 'redeem', 'expire', 'adjust');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maintenance_task_priority') THEN
    CREATE TYPE "public"."maintenance_task_priority" AS ENUM('low', 'medium', 'high', 'urgent');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maintenance_task_status') THEN
    CREATE TYPE "public"."maintenance_task_status" AS ENUM('pending', 'in_progress', 'completed', 'overdue', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'match_result') THEN
    CREATE TYPE "public"."match_result" AS ENUM('player1_wins', 'player2_wins', 'halved', 'conceded', 'pending');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'meeting_status') THEN
    CREATE TYPE "public"."meeting_status" AS ENUM('scheduled', 'in_progress', 'completed', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_subscription_status') THEN
    CREATE TYPE "public"."member_subscription_status" AS ENUM('active', 'past_due', 'cancelled', 'expired', 'pending');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notice_board_article_status') THEN
    CREATE TYPE "public"."notice_board_article_status" AS ENUM('draft', 'scheduled', 'published', 'archived');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'course_notice_type') THEN
    CREATE TYPE "public"."course_notice_type" AS ENUM('closure', 'gur', 'preferred_lies', 'temporary_green', 'hazard', 'general');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'org_role') THEN
    CREATE TYPE "public"."org_role" AS ENUM('super_admin', 'org_admin', 'tournament_director', 'committee_member', 'competition_secretary', 'volunteer', 'player', 'spectator', 'pro_shop');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'org_subscription_status') THEN
    CREATE TYPE "public"."org_subscription_status" AS ENUM('free', 'active', 'past_due', 'cancelled', 'pending_payment');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status') THEN
    CREATE TYPE "public"."payment_status" AS ENUM('unpaid', 'pending', 'paid', 'refunded');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'po_status') THEN
    CREATE TYPE "public"."po_status" AS ENUM('draft', 'sent', 'partially_received', 'fully_received', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pos_payment_method') THEN
    CREATE TYPE "public"."pos_payment_method" AS ENUM('cash', 'razorpay_pos', 'member_account');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pos_transaction_status') THEN
    CREATE TYPE "public"."pos_transaction_status" AS ENUM('pending', 'completed', 'voided', 'refunded');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'practice_session_type') THEN
    CREATE TYPE "public"."practice_session_type" AS ENUM('range', 'putting', 'short_game', 'on_course', 'simulator', 'other');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'question_type') THEN
    CREATE TYPE "public"."question_type" AS ENUM('rating', 'multiple_choice', 'free_text', 'nps');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'range_booking_status') THEN
    CREATE TYPE "public"."range_booking_status" AS ENUM('pending', 'confirmed', 'cancelled', 'completed', 'no_show');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'range_player_type') THEN
    CREATE TYPE "public"."range_player_type" AS ENUM('member', 'visitor');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'range_slot_status') THEN
    CREATE TYPE "public"."range_slot_status" AS ENUM('open', 'blocked', 'booked');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ranking_category') THEN
    CREATE TYPE "public"."ranking_category" AS ENUM('open', 'men', 'ladies', 'seniors', 'juniors');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ranking_series_level') THEN
    CREATE TYPE "public"."ranking_series_level" AS ENUM('club', 'regional', 'national');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ranking_series_status') THEN
    CREATE TYPE "public"."ranking_series_status" AS ENUM('draft', 'active', 'archived');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ranking_tiebreaker') THEN
    CREATE TYPE "public"."ranking_tiebreaker" AS ENUM('most_wins', 'most_runner_up', 'most_top3', 'head_to_head', 'none');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rental_asset_condition') THEN
    CREATE TYPE "public"."rental_asset_condition" AS ENUM('excellent', 'good', 'fair', 'poor', 'damaged', 'retired');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rental_booking_status') THEN
    CREATE TYPE "public"."rental_booking_status" AS ENUM('reserved', 'checked_out', 'returned', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'repair_job_status') THEN
    CREATE TYPE "public"."repair_job_status" AS ENUM('received', 'in_progress', 'ready_for_pickup', 'collected');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'repair_job_type') THEN
    CREATE TYPE "public"."repair_job_type" AS ENUM('regrip', 'reshaft', 'loft_lie_adjustment', 'cleaning', 'other');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'loyalty_reward_type') THEN
    CREATE TYPE "public"."loyalty_reward_type" AS ENUM('discount_percent', 'discount_fixed', 'free_round', 'voucher', 'product', 'other');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'roster_period') THEN
    CREATE TYPE "public"."roster_period" AS ENUM('weekly', 'fortnightly');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ryder_cup_session_type') THEN
    CREATE TYPE "public"."ryder_cup_session_type" AS ENUM('foursomes', 'four_ball', 'singles');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'segment_rule_operator') THEN
    CREATE TYPE "public"."segment_rule_operator" AS ENUM('eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'not_contains', 'in', 'not_in');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shift_status') THEN
    CREATE TYPE "public"."shift_status" AS ENUM('draft', 'published', 'confirmed', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shop_order_status') THEN
    CREATE TYPE "public"."shop_order_status" AS ENUM('pending', 'cod_pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shot_type') THEN
    CREATE TYPE "public"."shot_type" AS ENUM('tee', 'fairway', 'approach', 'chip', 'sand', 'putt');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'staff_checkin_type') THEN
    CREATE TYPE "public"."staff_checkin_type" AS ENUM('caddie', 'volunteer');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'staff_department') THEN
    CREATE TYPE "public"."staff_department" AS ENUM('pro_shop', 'food_and_beverage', 'grounds', 'reception', 'administration', 'security', 'maintenance', 'other');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'store_credit_transaction_type') THEN
    CREATE TYPE "public"."store_credit_transaction_type" AS ENUM('issue', 'redeem', 'expire', 'adjustment');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_tier') THEN
    CREATE TYPE "public"."subscription_tier" AS ENUM('free', 'starter', 'pro', 'enterprise');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'survey_status') THEN
    CREATE TYPE "public"."survey_status" AS ENUM('draft', 'active', 'closed');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'survey_trigger') THEN
    CREATE TYPE "public"."survey_trigger" AS ENUM('manual', 'post_round', 'post_event', 'post_tournament');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tee_booking_player_type') THEN
    CREATE TYPE "public"."tee_booking_player_type" AS ENUM('member', 'guest');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tee_booking_status') THEN
    CREATE TYPE "public"."tee_booking_status" AS ENUM('pending', 'confirmed', 'cancelled', 'forfeited', 'completed');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tee_box') THEN
    CREATE TYPE "public"."tee_box" AS ENUM('blue', 'white', 'red', 'gold', 'black');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tiebreaker_method') THEN
    CREATE TYPE "public"."tiebreaker_method" AS ENUM('countback', 'multi_round_countback', 'net_countback', 'lower_handicap', 'no_tiebreaker');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tournament_format') THEN
    CREATE TYPE "public"."tournament_format" AS ENUM('stroke_play', 'net_stroke', 'best_ball', 'scramble', 'skins', 'match_play', 'stableford', 'shamble', 'match_play_bracket', 'ryder_cup');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tournament_staff_role') THEN
    CREATE TYPE "public"."tournament_staff_role" AS ENUM('tournament_admin', 'live_scorer', 'volunteer');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tournament_status') THEN
    CREATE TYPE "public"."tournament_status" AS ENUM('draft', 'upcoming', 'active', 'completed', 'cancelled', 'suspended');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trip_participant_status') THEN
    CREATE TYPE "public"."trip_participant_status" AS ENUM('invited', 'confirmed', 'waitlisted', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trip_status') THEN
    CREATE TYPE "public"."trip_status" AS ENUM('draft', 'open', 'confirmed', 'completed', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'visitor_pass_status') THEN
    CREATE TYPE "public"."visitor_pass_status" AS ENUM('pending_payment', 'paid', 'checked_in', 'no_show', 'cancelled', 'refunded');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'volunteer_role_type') THEN
    CREATE TYPE "public"."volunteer_role_type" AS ENUM('starter', 'marshal', 'scorer', 'registration', 'first_aid', 'transport', 'other');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vote_status') THEN
    CREATE TYPE "public"."vote_status" AS ENUM('draft', 'open', 'closed', 'cancelled');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'whs_posting_status') THEN
    CREATE TYPE "public"."whs_posting_status" AS ENUM('pending', 'posted', 'failed', 'no_ghin');
  END IF;
END $$;

-- Step 2: Create tables

CREATE TABLE IF NOT EXISTS "staff_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"user_id" integer,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"department" "staff_department" DEFAULT 'pro_shop' NOT NULL,
	"position" text,
	"employment_type" text DEFAULT 'full_time' NOT NULL,
	"pin" text,
	"hourly_rate" numeric(10, 2),
	"currency" text DEFAULT 'INR' NOT NULL,
	"annual_leave_balance" numeric(6, 2) DEFAULT '0' NOT NULL,
	"sick_leave_balance" numeric(6, 2) DEFAULT '0' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "rosters" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"department" "staff_department",
	"period" "roster_period" DEFAULT 'weekly' NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_user_id" integer,
	"notes" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "shifts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"roster_id" integer,
	"staff_profile_id" integer NOT NULL,
	"date" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"department" "staff_department" DEFAULT 'pro_shop' NOT NULL,
	"role" text,
	"status" "shift_status" DEFAULT 'draft' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"notes" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "leave_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"staff_profile_id" integer NOT NULL,
	"leave_type" "leave_type" NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"total_days" numeric(4, 1) NOT NULL,
	"reason" text,
	"status" "leave_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by_user_id" integer,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "timesheet_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"staff_profile_id" integer NOT NULL,
	"shift_id" integer,
	"date" text NOT NULL,
	"clock_in" text,
	"clock_out" text,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"total_minutes" integer,
	"regular_minutes" integer,
	"overtime_minutes" integer,
	"is_manual_entry" boolean DEFAULT false NOT NULL,
	"is_approved" boolean DEFAULT false NOT NULL,
	"approved_by_user_id" integer,
	"approved_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "overtime_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"regular_hours_per_day" numeric(4, 2) DEFAULT '8' NOT NULL,
	"regular_hours_per_week" numeric(5, 2) DEFAULT '40' NOT NULL,
	"overtime_multiplier" numeric(4, 2) DEFAULT '1.5' NOT NULL,
	"double_time_multiplier" numeric(4, 2) DEFAULT '2.0' NOT NULL,
	"weekend_penalty_multiplier" numeric(4, 2) DEFAULT '1.25' NOT NULL,
	"public_holiday_multiplier" numeric(4, 2) DEFAULT '2.5' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "billing_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"tier_id" integer,
	"name" text NOT NULL,
	"billing_cycle" "billing_cycle" DEFAULT 'annual' NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"grace_period_days" integer DEFAULT 14 NOT NULL,
	"suspend_after_days" integer DEFAULT 30 NOT NULL,
	"reminder_days_before" jsonb DEFAULT '[7,1]'::jsonb,
	"auto_generate" boolean DEFAULT true NOT NULL,
	"next_run_date" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "member_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"club_member_id" integer NOT NULL,
	"schedule_id" integer,
	"invoice_number" text NOT NULL,
	"status" "dues_invoice_status" DEFAULT 'draft' NOT NULL,
	"total_amount" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"due_date" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"paid_amount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"payment_method" "dues_payment_method",
	"razorpay_payment_link_id" text,
	"razorpay_payment_link_url" text,
	"razorpay_payment_id" text,
	"reminders_sent_at" jsonb DEFAULT '[]'::jsonb,
	"sent_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "invoice_line_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(8, 2) DEFAULT '1' NOT NULL,
	"unit_amount" numeric(10, 2) NOT NULL,
	"total_amount" numeric(10, 2) NOT NULL,
	"line_type" text DEFAULT 'dues' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "dues_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"method" "dues_payment_method" DEFAULT 'online' NOT NULL,
	"reference" text,
	"razorpay_payment_id" text,
	"notes" text,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "accounting_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"platform" "accounting_platform" NOT NULL,
	"tenant_id" text,
	"tenant_name" text,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_connections_org_platform" UNIQUE("organization_id","platform")
);

CREATE TABLE IF NOT EXISTS "accounting_coa_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"event_type" "ledger_event_type" NOT NULL,
	"account_code" text NOT NULL,
	"account_name" text,
	"tax_code" text,
	"tax_rate" numeric(5, 4) DEFAULT '0',
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_coa_map_org_type" UNIQUE("organization_id","event_type")
);

CREATE TABLE IF NOT EXISTS "financial_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"event_type" "ledger_event_type" NOT NULL,
	"source_module" text NOT NULL,
	"source_id" integer,
	"source_ref" text,
	"member_id" integer,
	"member_name" text,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"tax_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"tax_code" text,
	"account_code" text,
	"transaction_date" text NOT NULL,
	"sync_status" "accounting_sync_status" DEFAULT 'pending' NOT NULL,
	"synced_at" timestamp with time zone,
	"external_ref" text,
	"sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "marketing_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"subject" text,
	"subject_variant_b" text,
	"preview_text" text,
	"body_html" text DEFAULT '' NOT NULL,
	"body_text" text,
	"channels" text[] DEFAULT ARRAY['email']::text[] NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"type" "campaign_type" DEFAULT 'one_off' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"segment_id" integer,
	"drip_series_id" integer,
	"drip_delay_days" integer DEFAULT 0 NOT NULL,
	"drip_order" integer DEFAULT 0 NOT NULL,
	"ab_winner" text,
	"total_sent" integer DEFAULT 0 NOT NULL,
	"total_opened" integer DEFAULT 0 NOT NULL,
	"total_clicked" integer DEFAULT 0 NOT NULL,
	"total_unsubscribed" integer DEFAULT 0 NOT NULL,
	"total_bounced" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "drip_series" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger" text DEFAULT 'new_member' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "member_segments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimated_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "campaign_recipients" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"user_id" integer,
	"email" text,
	"name" text,
	"ab_variant" text DEFAULT 'a' NOT NULL,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"tracking_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_recipients_tracking_token_unique" UNIQUE("tracking_token")
);

CREATE TABLE IF NOT EXISTS "email_suppressions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"email" text NOT NULL,
	"reason" text DEFAULT 'unsubscribed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "email_templates_marketing" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"name" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"body_html" text NOT NULL,
	"body_text" text,
	"is_global" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "membership_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"tier_id" integer,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"date_of_birth" timestamp with time zone,
	"address" text,
	"golf_background" text,
	"current_handicap" numeric(4, 1),
	"previous_club" text,
	"years_playing" integer,
	"proposer_name" text,
	"proposer_member_number" text,
	"seconder_name" text,
	"seconder_member_number" text,
	"stage" "application_stage" DEFAULT 'applied' NOT NULL,
	"stage_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_member_id" integer,
	"admin_notes" text,
	"rejection_reason" text,
	"attachments" jsonb DEFAULT '[]'::jsonb,
	"reference_code" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "application_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL,
	"author_id" integer NOT NULL,
	"body" text NOT NULL,
	"is_internal" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "caddies" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"phone" text,
	"email" text,
	"experience_level" "caddie_experience_level" DEFAULT 'junior' NOT NULL,
	"notes" text
);

CREATE TABLE IF NOT EXISTS "volunteer_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"tournament_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"role_type" "volunteer_role_type" DEFAULT 'marshal' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"max_volunteers" integer DEFAULT 1 NOT NULL,
	"qr_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "volunteer_roles_qr_token_unique" UNIQUE("qr_token")
);

CREATE TABLE IF NOT EXISTS "volunteer_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"role_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"tournament_id" integer NOT NULL,
	"user_id" integer,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "staff_checkins" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"tournament_id" integer NOT NULL,
	"checkin_type" "staff_checkin_type" NOT NULL,
	"caddie_assignment_id" integer,
	"volunteer_assignment_id" integer,
	"checked_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_in_by_user_id" integer,
	"method" text DEFAULT 'qr' NOT NULL,
	"no_show" boolean DEFAULT false NOT NULL,
	"no_show_marked_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "range_slots" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"bay_id" integer NOT NULL,
	"slot_date" timestamp with time zone NOT NULL,
	"slot_time" text NOT NULL,
	"status" "range_slot_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "range_bookings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"bay_id" integer NOT NULL,
	"user_id" integer,
	"player_type" "range_player_type" DEFAULT 'member' NOT NULL,
	"guest_name" text,
	"guest_email" text,
	"slot_date" timestamp with time zone NOT NULL,
	"slot_time" text NOT NULL,
	"duration_minutes" integer DEFAULT 30 NOT NULL,
	"status" "range_booking_status" DEFAULT 'confirmed' NOT NULL,
	"total_amount" numeric(10, 2),
	"currency" text DEFAULT 'INR' NOT NULL,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"qr_token" text,
	"checked_in_at" timestamp with time zone,
	"checked_in_by_user_id" integer,
	"cancellation_reason" text,
	"cancelled_at" timestamp with time zone,
	"rescheduled_from_id" integer,
	"email_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "range_bookings_qr_token_unique" UNIQUE("qr_token")
);

CREATE TABLE IF NOT EXISTS "club_championship" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"tournament_id" integer NOT NULL,
	"year" integer NOT NULL,
	"title" text DEFAULT 'Club Championship' NOT NULL,
	"notes" text,
	"is_published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "championship_flight" (
	"id" serial PRIMARY KEY NOT NULL,
	"championship_id" integer NOT NULL,
	"flight_id" integer,
	"name" text NOT NULL,
	"description" text,
	"score_type" text DEFAULT 'net' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "championship_winner" (
	"id" serial PRIMARY KEY NOT NULL,
	"championship_id" integer NOT NULL,
	"flight_id" integer,
	"player_id" integer,
	"player_name" text NOT NULL,
	"score" text,
	"notes" text,
	"position" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "interclub_season" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"year" integer NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "interclub_fixture_full" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"season_id" integer,
	"opponent_name" text NOT NULL,
	"opponent_club" text,
	"fixture_date" timestamp with time zone,
	"venue" text,
	"is_home" boolean DEFAULT true NOT NULL,
	"format" text DEFAULT 'matchplay' NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"home_points" numeric(6, 1),
	"away_points" numeric(6, 1),
	"result" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "interclub_roster" (
	"id" serial PRIMARY KEY NOT NULL,
	"fixture_id" integer NOT NULL,
	"side" text DEFAULT 'home' NOT NULL,
	"player_name" text NOT NULL,
	"player_id" integer,
	"user_id" integer,
	"handicap_index" numeric(4, 1),
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "interclub_match" (
	"id" serial PRIMARY KEY NOT NULL,
	"fixture_id" integer NOT NULL,
	"match_number" integer DEFAULT 1 NOT NULL,
	"home_player_name" text NOT NULL,
	"home_player_id" integer,
	"away_player_name" text NOT NULL,
	"away_player_id" integer,
	"result" text DEFAULT 'pending' NOT NULL,
	"home_points" numeric(4, 1),
	"away_points" numeric(4, 1),
	"holes_played" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "junior_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"user_id" integer,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"date_of_birth" timestamp with time zone NOT NULL,
	"age_category" "junior_age_category" NOT NULL,
	"pathway_level" "junior_pathway_level" DEFAULT 'beginner' NOT NULL,
	"handicap_index" numeric(4, 1),
	"preferred_tee_box" "tee_box" DEFAULT 'red',
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "guardian_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"junior_profile_id" integer NOT NULL,
	"guardian_user_id" integer,
	"guardian_name" text NOT NULL,
	"guardian_email" text,
	"guardian_phone" text,
	"relationship" text DEFAULT 'parent' NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "development_pathways" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "pathway_levels" (
	"id" serial PRIMARY KEY NOT NULL,
	"pathway_id" integer NOT NULL,
	"name" text NOT NULL,
	"level" "junior_pathway_level" DEFAULT 'beginner' NOT NULL,
	"description" text,
	"criteria" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "junior_pathway_progress" (
	"id" serial PRIMARY KEY NOT NULL,
	"junior_profile_id" integer NOT NULL,
	"pathway_id" integer NOT NULL,
	"current_level_id" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_progressed_at" timestamp with time zone,
	"notes" text
);

CREATE TABLE IF NOT EXISTS "junior_programs" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"max_participants" integer,
	"age_categories" jsonb DEFAULT '[]'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "program_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"program_id" integer NOT NULL,
	"junior_profile_id" integer NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);

CREATE TABLE IF NOT EXISTS "program_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"program_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"location" text,
	"coach_name" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "program_attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"junior_profile_id" integer NOT NULL,
	"attended" boolean DEFAULT false NOT NULL,
	"notes" text,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "junior_awards" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"program_id" integer,
	"junior_profile_id" integer NOT NULL,
	"award_type" "junior_award_type" NOT NULL,
	"age_category" "junior_age_category",
	"award_label" text NOT NULL,
	"description" text,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"awarded_by_user_id" integer
);

-- Step 3: Foreign key constraints (safe with duplicate guard)
DO $$ BEGIN BEGIN
  ALTER TABLE "accounting_coa_map" ADD CONSTRAINT "accounting_coa_map_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "accounting_connections" ADD CONSTRAINT "accounting_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "application_notes" ADD CONSTRAINT "application_notes_application_id_membership_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."membership_applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "application_notes" ADD CONSTRAINT "application_notes_author_id_app_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "ball_token_credits" ADD CONSTRAINT "ball_token_credits_booking_id_range_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."range_bookings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "billing_schedules" ADD CONSTRAINT "billing_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "billing_schedules" ADD CONSTRAINT "billing_schedules_tier_id_membership_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "caddie_event_assignments" ADD CONSTRAINT "caddie_event_assignments_caddie_id_caddies_id_fk" FOREIGN KEY ("caddie_id") REFERENCES "public"."caddies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "caddies" ADD CONSTRAINT "caddies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_marketing_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."marketing_campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "championship_flight" ADD CONSTRAINT "championship_flight_championship_id_club_championship_id_fk" FOREIGN KEY ("championship_id") REFERENCES "public"."club_championship"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "championship_flight" ADD CONSTRAINT "championship_flight_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "championship_winner" ADD CONSTRAINT "championship_winner_championship_id_club_championship_id_fk" FOREIGN KEY ("championship_id") REFERENCES "public"."club_championship"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "championship_winner" ADD CONSTRAINT "championship_winner_flight_id_championship_flight_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."championship_flight"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "championship_winner" ADD CONSTRAINT "championship_winner_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "club_championship" ADD CONSTRAINT "club_championship_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "club_championship" ADD CONSTRAINT "club_championship_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "development_pathways" ADD CONSTRAINT "development_pathways_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "drip_series" ADD CONSTRAINT "drip_series_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "dues_payments" ADD CONSTRAINT "dues_payments_invoice_id_member_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."member_invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "dues_payments" ADD CONSTRAINT "dues_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "email_templates_marketing" ADD CONSTRAINT "email_templates_marketing_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "financial_ledger" ADD CONSTRAINT "financial_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "guardian_links" ADD CONSTRAINT "guardian_links_junior_profile_id_junior_profiles_id_fk" FOREIGN KEY ("junior_profile_id") REFERENCES "public"."junior_profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "guardian_links" ADD CONSTRAINT "guardian_links_guardian_user_id_app_users_id_fk" FOREIGN KEY ("guardian_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "interclub_fixture_full" ADD CONSTRAINT "interclub_fixture_full_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "interclub_fixture_full" ADD CONSTRAINT "interclub_fixture_full_season_id_interclub_season_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."interclub_season"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "interclub_match" ADD CONSTRAINT "interclub_match_fixture_id_interclub_fixture_full_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."interclub_fixture_full"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "interclub_match" ADD CONSTRAINT "interclub_match_home_player_id_interclub_roster_id_fk" FOREIGN KEY ("home_player_id") REFERENCES "public"."interclub_roster"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "interclub_match" ADD CONSTRAINT "interclub_match_away_player_id_interclub_roster_id_fk" FOREIGN KEY ("away_player_id") REFERENCES "public"."interclub_roster"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "interclub_roster" ADD CONSTRAINT "interclub_roster_fixture_id_interclub_fixture_full_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."interclub_fixture_full"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "interclub_roster" ADD CONSTRAINT "interclub_roster_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "interclub_roster" ADD CONSTRAINT "interclub_roster_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "interclub_season" ADD CONSTRAINT "interclub_season_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_member_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."member_invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "junior_awards" ADD CONSTRAINT "junior_awards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "junior_awards" ADD CONSTRAINT "junior_awards_program_id_junior_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."junior_programs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "junior_awards" ADD CONSTRAINT "junior_awards_junior_profile_id_junior_profiles_id_fk" FOREIGN KEY ("junior_profile_id") REFERENCES "public"."junior_profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "junior_awards" ADD CONSTRAINT "junior_awards_awarded_by_user_id_app_users_id_fk" FOREIGN KEY ("awarded_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "junior_pathway_progress" ADD CONSTRAINT "junior_pathway_progress_junior_profile_id_junior_profiles_id_fk" FOREIGN KEY ("junior_profile_id") REFERENCES "public"."junior_profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "junior_pathway_progress" ADD CONSTRAINT "junior_pathway_progress_pathway_id_development_pathways_id_fk" FOREIGN KEY ("pathway_id") REFERENCES "public"."development_pathways"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "junior_pathway_progress" ADD CONSTRAINT "junior_pathway_progress_current_level_id_pathway_levels_id_fk" FOREIGN KEY ("current_level_id") REFERENCES "public"."pathway_levels"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "junior_profiles" ADD CONSTRAINT "junior_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "junior_profiles" ADD CONSTRAINT "junior_profiles_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "junior_programs" ADD CONSTRAINT "junior_programs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_staff_profile_id_staff_profiles_id_fk" FOREIGN KEY ("staff_profile_id") REFERENCES "public"."staff_profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reviewed_by_user_id_app_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "member_invoices" ADD CONSTRAINT "member_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "member_invoices" ADD CONSTRAINT "member_invoices_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "member_invoices" ADD CONSTRAINT "member_invoices_schedule_id_billing_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."billing_schedules"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "member_segments" ADD CONSTRAINT "member_segments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "membership_applications" ADD CONSTRAINT "membership_applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "membership_applications" ADD CONSTRAINT "membership_applications_tier_id_membership_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "membership_applications" ADD CONSTRAINT "membership_applications_created_member_id_club_members_id_fk" FOREIGN KEY ("created_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "overtime_rules" ADD CONSTRAINT "overtime_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "pathway_levels" ADD CONSTRAINT "pathway_levels_pathway_id_development_pathways_id_fk" FOREIGN KEY ("pathway_id") REFERENCES "public"."development_pathways"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "program_attendance" ADD CONSTRAINT "program_attendance_session_id_program_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."program_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "program_attendance" ADD CONSTRAINT "program_attendance_junior_profile_id_junior_profiles_id_fk" FOREIGN KEY ("junior_profile_id") REFERENCES "public"."junior_profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "program_participants" ADD CONSTRAINT "program_participants_program_id_junior_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."junior_programs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "program_participants" ADD CONSTRAINT "program_participants_junior_profile_id_junior_profiles_id_fk" FOREIGN KEY ("junior_profile_id") REFERENCES "public"."junior_profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "program_sessions" ADD CONSTRAINT "program_sessions_program_id_junior_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."junior_programs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "range_bookings" ADD CONSTRAINT "range_bookings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "range_bookings" ADD CONSTRAINT "range_bookings_bay_id_range_bays_id_fk" FOREIGN KEY ("bay_id") REFERENCES "public"."range_bays"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "range_bookings" ADD CONSTRAINT "range_bookings_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "range_bookings" ADD CONSTRAINT "range_bookings_checked_in_by_user_id_app_users_id_fk" FOREIGN KEY ("checked_in_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "range_slots" ADD CONSTRAINT "range_slots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "range_slots" ADD CONSTRAINT "range_slots_bay_id_range_bays_id_fk" FOREIGN KEY ("bay_id") REFERENCES "public"."range_bays"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "rosters" ADD CONSTRAINT "rosters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "rosters" ADD CONSTRAINT "rosters_published_by_user_id_app_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "rosters" ADD CONSTRAINT "rosters_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "shifts" ADD CONSTRAINT "shifts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "shifts" ADD CONSTRAINT "shifts_roster_id_rosters_id_fk" FOREIGN KEY ("roster_id") REFERENCES "public"."rosters"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "shifts" ADD CONSTRAINT "shifts_staff_profile_id_staff_profiles_id_fk" FOREIGN KEY ("staff_profile_id") REFERENCES "public"."staff_profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "shifts" ADD CONSTRAINT "shifts_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "staff_checkins" ADD CONSTRAINT "staff_checkins_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "staff_checkins" ADD CONSTRAINT "staff_checkins_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "staff_checkins" ADD CONSTRAINT "staff_checkins_caddie_assignment_id_caddie_event_assignments_id_fk" FOREIGN KEY ("caddie_assignment_id") REFERENCES "public"."caddie_event_assignments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "staff_checkins" ADD CONSTRAINT "staff_checkins_volunteer_assignment_id_volunteer_assignments_id_fk" FOREIGN KEY ("volunteer_assignment_id") REFERENCES "public"."volunteer_assignments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "staff_checkins" ADD CONSTRAINT "staff_checkins_checked_in_by_user_id_app_users_id_fk" FOREIGN KEY ("checked_in_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_created_by_user_id_app_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_staff_profile_id_staff_profiles_id_fk" FOREIGN KEY ("staff_profile_id") REFERENCES "public"."staff_profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_approved_by_user_id_app_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "volunteer_assignments" ADD CONSTRAINT "volunteer_assignments_role_id_volunteer_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."volunteer_roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "volunteer_assignments" ADD CONSTRAINT "volunteer_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "volunteer_assignments" ADD CONSTRAINT "volunteer_assignments_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "volunteer_assignments" ADD CONSTRAINT "volunteer_assignments_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "volunteer_roles" ADD CONSTRAINT "volunteer_roles_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;
DO $$ BEGIN BEGIN
  ALTER TABLE "volunteer_roles" ADD CONSTRAINT "volunteer_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END; END $$;

-- Step 4: Indexes
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "accounting_coa_map_org_idx" ON "accounting_coa_map" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "accounting_connections_org_idx" ON "accounting_connections" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "app_notes_application_idx" ON "application_notes" USING btree ("application_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "billing_schedules_org_idx" ON "billing_schedules" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "campaign_recipients_campaign_idx" ON "campaign_recipients" USING btree ("campaign_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "campaign_recipients_user_idx" ON "campaign_recipients" USING btree ("user_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "campaign_recipients_token_idx" ON "campaign_recipients" USING btree ("tracking_token");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "champ_flight_championship_idx" ON "championship_flight" USING btree ("championship_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "champ_winner_championship_idx" ON "championship_winner" USING btree ("championship_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "champ_winner_flight_idx" ON "championship_winner" USING btree ("flight_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "club_championship_org_year_unique" ON "club_championship" USING btree ("organization_id","year");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "club_championship_org_idx" ON "club_championship" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "club_championship_tournament_unique" ON "club_championship" USING btree ("tournament_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "dev_pathways_org_idx" ON "development_pathways" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "caddies_org_idx" ON "drip_series" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "drip_series_org_idx" ON "drip_series" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "dues_payments_invoice_idx" ON "dues_payments" USING btree ("invoice_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "email_suppressions_org_email_idx" ON "email_suppressions" USING btree ("organization_id","email");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "email_suppressions_unique" ON "email_suppressions" USING btree ("organization_id","email");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "email_templates_mktg_org_idx" ON "email_templates_marketing" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "financial_ledger_org_idx" ON "financial_ledger" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "financial_ledger_date_idx" ON "financial_ledger" USING btree ("transaction_date");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "financial_ledger_sync_idx" ON "financial_ledger" USING btree ("sync_status");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "financial_ledger_event_type_idx" ON "financial_ledger" USING btree ("event_type");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "guardian_links_junior_idx" ON "guardian_links" USING btree ("junior_profile_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "guardian_links_user_idx" ON "guardian_links" USING btree ("guardian_user_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "interclub_fixture_full_org_idx" ON "interclub_fixture_full" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "interclub_fixture_full_season_idx" ON "interclub_fixture_full" USING btree ("season_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "interclub_match_fixture_idx" ON "interclub_match" USING btree ("fixture_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "interclub_roster_fixture_idx" ON "interclub_roster" USING btree ("fixture_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "interclub_season_org_idx" ON "interclub_season" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "invoice_line_items_invoice_idx" ON "invoice_line_items" USING btree ("invoice_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "junior_awards_org_idx" ON "junior_awards" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "junior_awards_junior_idx" ON "junior_awards" USING btree ("junior_profile_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "junior_awards_program_idx" ON "junior_awards" USING btree ("program_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "junior_pathway_unique" ON "junior_pathway_progress" USING btree ("junior_profile_id","pathway_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "junior_pathway_progress_junior_idx" ON "junior_pathway_progress" USING btree ("junior_profile_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "junior_profiles_org_idx" ON "junior_profiles" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "junior_profiles_user_idx" ON "junior_profiles" USING btree ("user_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "junior_programs_org_idx" ON "junior_programs" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "leave_requests_org_idx" ON "leave_requests" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "leave_requests_staff_idx" ON "leave_requests" USING btree ("staff_profile_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "mktg_campaigns_org_idx" ON "marketing_campaigns" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "mktg_campaigns_status_idx" ON "marketing_campaigns" USING btree ("status");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "mktg_campaigns_drip_series_idx" ON "marketing_campaigns" USING btree ("drip_series_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "member_invoices_org_idx" ON "member_invoices" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "member_invoices_member_idx" ON "member_invoices" USING btree ("club_member_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "member_invoice_number_org_uidx" ON "member_invoices" USING btree ("organization_id","invoice_number");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "member_segments_org_idx" ON "member_segments" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "membership_apps_org_idx" ON "membership_applications" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "membership_apps_stage_idx" ON "membership_applications" USING btree ("organization_id","stage");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "membership_apps_email_idx" ON "membership_applications" USING btree ("email");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "membership_apps_ref_unique" ON "membership_applications" USING btree ("reference_code");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "overtime_rules_org_idx" ON "overtime_rules" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "pathway_levels_pathway_idx" ON "pathway_levels" USING btree ("pathway_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "program_attendance_unique" ON "program_attendance" USING btree ("session_id","junior_profile_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "program_attendance_session_idx" ON "program_attendance" USING btree ("session_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "program_attendance_junior_idx" ON "program_attendance" USING btree ("junior_profile_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "program_participant_unique" ON "program_participants" USING btree ("program_id","junior_profile_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "program_participants_program_idx" ON "program_participants" USING btree ("program_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "program_participants_junior_idx" ON "program_participants" USING btree ("junior_profile_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "program_sessions_program_idx" ON "program_sessions" USING btree ("program_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "program_sessions_date_idx" ON "program_sessions" USING btree ("scheduled_at");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "range_booking_bay_slot_unique" ON "range_bookings" USING btree ("bay_id","slot_date","slot_time");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "range_booking_org_idx" ON "range_bookings" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "range_booking_user_idx" ON "range_bookings" USING btree ("user_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "range_booking_date_idx" ON "range_bookings" USING btree ("slot_date");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "range_slot_bay_date_time_unique" ON "range_slots" USING btree ("bay_id","slot_date","slot_time");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "range_slot_org_date_idx" ON "range_slots" USING btree ("organization_id","slot_date");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "rosters_org_idx" ON "rosters" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "rosters_dates_idx" ON "rosters" USING btree ("start_date","end_date");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "shifts_org_idx" ON "shifts" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "shifts_roster_idx" ON "shifts" USING btree ("roster_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "shifts_staff_idx" ON "shifts" USING btree ("staff_profile_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "shifts_date_idx" ON "shifts" USING btree ("date");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "staff_checkins_tournament_idx" ON "staff_checkins" USING btree ("tournament_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "staff_checkins_org_idx" ON "staff_checkins" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "staff_profiles_org_idx" ON "staff_profiles" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "staff_profiles_user_idx" ON "staff_profiles" USING btree ("user_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "timesheet_entries_org_idx" ON "timesheet_entries" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "timesheet_entries_staff_idx" ON "timesheet_entries" USING btree ("staff_profile_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "timesheet_entries_date_idx" ON "timesheet_entries" USING btree ("date");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "volunteer_assignments_role_idx" ON "volunteer_assignments" USING btree ("role_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "volunteer_assignments_tournament_idx" ON "volunteer_assignments" USING btree ("tournament_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "volunteer_assignments_org_idx" ON "volunteer_assignments" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "volunteer_roles_tournament_idx" ON "volunteer_roles" USING btree ("tournament_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "volunteer_roles_org_idx" ON "volunteer_roles" USING btree ("organization_id");
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;
