-- Catch-up migration # (Task #1403): missing columns, indexes and column adjustments.
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
  EXECUTE $POST_MERGE$ALTER TABLE "app_users" ADD COLUMN IF NOT EXISTS "erased_at" timestamp with time zone;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "club_members" ADD COLUMN IF NOT EXISTS "invite_token" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "club_members" ADD COLUMN IF NOT EXISTS "invite_token_expiry" timestamp with time zone;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "club_members" ADD COLUMN IF NOT EXISTS "pending_member_link" boolean DEFAULT false NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "fb_menu_items" ADD COLUMN IF NOT EXISTS "inventory_deduct_qty" integer DEFAULT 1 NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "fb_menu_items" ADD COLUMN IF NOT EXISTS "inventory_variant_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "fb_order_items" ADD COLUMN IF NOT EXISTS "item_notes" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "fb_order_items" ADD COLUMN IF NOT EXISTS "modifier_total" numeric(10, 2) DEFAULT '0' NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "fb_order_items" ADD COLUMN IF NOT EXISTS "modifiers" jsonb DEFAULT '[]'::jsonb;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "fb_orders" ADD COLUMN IF NOT EXISTS "bumped_at" timestamp with time zone;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "fb_orders" ADD COLUMN IF NOT EXISTS "order_type" "fb_order_type" DEFAULT 'on_course' NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "fb_orders" ADD COLUMN IF NOT EXISTS "recalled_at" timestamp with time zone;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "fb_orders" ADD COLUMN IF NOT EXISTS "server_user_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "fb_orders" ADD COLUMN IF NOT EXISTS "tab_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "fb_orders" ADD COLUMN IF NOT EXISTS "table_label" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "flights" ADD COLUMN IF NOT EXISTS "tiebreaker_method" "tiebreaker_method";$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "league_members" ADD COLUMN IF NOT EXISTS "division_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "league_staff" ADD COLUMN IF NOT EXISTS "display_name" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

-- email / organization_id are NOT NULL in schema.ts but the column may be added
-- to a non-empty production table, so add nullable, backfill deterministically
-- from app_users / leagues, then promote to NOT NULL only if the backfill is
-- complete. The DO/EXCEPTION wrapper keeps post-merge.sh tolerant on a fresh DB
-- where the parent tables don't exist yet (their migrations may have failed).
DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "league_staff" ADD COLUMN IF NOT EXISTS "email" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE "league_staff" ls
     SET "email" = COALESCE(au."email", '')
    FROM "app_users" au
   WHERE ls."user_id" = au."id" AND ls."email" IS NULL;
  UPDATE "league_staff" SET "email" = '' WHERE "email" IS NULL;
  IF NOT EXISTS (SELECT 1 FROM "league_staff" WHERE "email" IS NULL) THEN
    ALTER TABLE "league_staff" ALTER COLUMN "email" SET NOT NULL;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "league_staff" ADD COLUMN IF NOT EXISTS "invited_by_user_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "league_staff" ADD COLUMN IF NOT EXISTS "organization_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE "league_staff" ls
     SET "organization_id" = l."organization_id"
    FROM "leagues" l
   WHERE ls."league_id" = l."id" AND ls."organization_id" IS NULL;
  IF NOT EXISTS (SELECT 1 FROM "league_staff" WHERE "organization_id" IS NULL) THEN
    ALTER TABLE "league_staff" ALTER COLUMN "organization_id" SET NOT NULL;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "ai_caddie_mode" "ai_caddie_mode" DEFAULT 'open' NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "member_entry_fee" numeric(10, 2);$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "members_only" boolean DEFAULT false NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "tiebreaker_method" "tiebreaker_method" DEFAULT 'countback' NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "membership_tiers" ADD COLUMN IF NOT EXISTS "shop_category_discounts" jsonb;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "membership_tiers" ADD COLUMN IF NOT EXISTS "shop_discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "org_memberships" ADD COLUMN IF NOT EXISTS "vendor_operator_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "players" ADD COLUMN IF NOT EXISTS "share_token" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "pos_transactions" ADD COLUMN IF NOT EXISTS "gift_card_amount_applied" numeric(10, 2);$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "pos_transactions" ADD COLUMN IF NOT EXISTS "gift_card_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "pos_transactions" ADD COLUMN IF NOT EXISTS "offline_synced" boolean DEFAULT false NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "pos_transactions" ADD COLUMN IF NOT EXISTS "vendor_operator_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "purchase_order_lines" ADD COLUMN IF NOT EXISTS "variant_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "affiliate_code" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "discount_breakdown" jsonb;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "discount_total" numeric(10, 2) DEFAULT '0' NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "loyalty_points_redeemed" integer DEFAULT 0 NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "promo_code" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "stacking_policy_applied" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_orders" ADD COLUMN IF NOT EXISTS "tournament_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_product_variants" ADD COLUMN IF NOT EXISTS "barcode" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_product_variants" ADD COLUMN IF NOT EXISTS "cost_price" numeric(10, 2);$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_product_variants" ADD COLUMN IF NOT EXISTS "sale_end" timestamp with time zone;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_product_variants" ADD COLUMN IF NOT EXISTS "sale_price" numeric(10, 2);$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_product_variants" ADD COLUMN IF NOT EXISTS "sale_start" timestamp with time zone;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_product_variants" ADD COLUMN IF NOT EXISTS "sku" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_product_variants" ADD COLUMN IF NOT EXISTS "supplier_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_product_variants" ADD COLUMN IF NOT EXISTS "tier_pricing" jsonb;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "sale_end" timestamp with time zone;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "sale_price" numeric(10, 2);$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "sale_start" timestamp with time zone;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "tier_pricing" jsonb;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "vendor_facility_type" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_store_settings" ADD COLUMN IF NOT EXISTS "discount_stacking_policy" text DEFAULT 'promo_member' NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_store_settings" ADD COLUMN IF NOT EXISTS "loyalty_max_redemption_pct" integer DEFAULT 20 NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_store_settings" ADD COLUMN IF NOT EXISTS "loyalty_points_per_currency_unit" integer DEFAULT 100 NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_store_settings" ADD COLUMN IF NOT EXISTS "stacking_max_layers" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shop_store_settings" ADD COLUMN IF NOT EXISTS "stacking_priority" jsonb;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shots" ADD COLUMN IF NOT EXISTS "club" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shots" ADD COLUMN IF NOT EXISTS "distance_carried" numeric(8, 1);$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shots" ADD COLUMN IF NOT EXISTS "general_play_round_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shots" ADD COLUMN IF NOT EXISTS "lie_type" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shots" ADD COLUMN IF NOT EXISTS "miss_direction" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shots" ADD COLUMN IF NOT EXISTS "penalty_reason" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shots" ADD COLUMN IF NOT EXISTS "shot_shape" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "shots" ADD COLUMN IF NOT EXISTS "user_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "side_games_config" ADD COLUMN IF NOT EXISTS "ctp_sponsor_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "side_games_config" ADD COLUMN IF NOT EXISTS "ld_sponsor_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tee_times" ADD COLUMN IF NOT EXISTS "is_manual" boolean DEFAULT false NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournament_staff" ADD COLUMN IF NOT EXISTS "display_name" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

-- Same safe pattern as league_staff above: schema.ts requires NOT NULL but the
-- column may be added to a non-empty production table, so add nullable,
-- backfill from app_users / tournaments, then promote to NOT NULL only if the
-- backfill is complete.
DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournament_staff" ADD COLUMN IF NOT EXISTS "email" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE "tournament_staff" ts
     SET "email" = COALESCE(au."email", '')
    FROM "app_users" au
   WHERE ts."user_id" = au."id" AND ts."email" IS NULL;
  UPDATE "tournament_staff" SET "email" = '' WHERE "email" IS NULL;
  IF NOT EXISTS (SELECT 1 FROM "tournament_staff" WHERE "email" IS NULL) THEN
    ALTER TABLE "tournament_staff" ALTER COLUMN "email" SET NOT NULL;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournament_staff" ADD COLUMN IF NOT EXISTS "invited_by_user_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournament_staff" ADD COLUMN IF NOT EXISTS "organization_id" integer;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE "tournament_staff" ts
     SET "organization_id" = t."organization_id"
    FROM "tournaments" t
   WHERE ts."tournament_id" = t."id" AND ts."organization_id" IS NULL;
  IF NOT EXISTS (SELECT 1 FROM "tournament_staff" WHERE "organization_id" IS NULL) THEN
    ALTER TABLE "tournament_staff" ALTER COLUMN "organization_id" SET NOT NULL;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "ai_caddie_mode" "ai_caddie_mode" DEFAULT 'open' NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "auto_post_whs" boolean DEFAULT false NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "course_conditions" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "leaderboard_type" "leaderboard_type" DEFAULT 'both' NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "local_rules" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "odds_widgets_enabled" boolean DEFAULT true NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "predictions_enabled" boolean DEFAULT true NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "tiebreaker_method" "tiebreaker_method" DEFAULT 'countback' NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "user_notification_prefs" ADD COLUMN IF NOT EXISTS "digest_mode" boolean DEFAULT false NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'league_staff'
      AND column_name = 'role'
  ) THEN
    ALTER TABLE "league_staff" ALTER COLUMN "role" SET DEFAULT 'competition_secretary';
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'league_staff'
      AND column_name = 'user_id'
  ) THEN
    ALTER TABLE "league_staff" ALTER COLUMN "user_id" DROP NOT NULL;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'match_play_brackets'
      AND column_name = 'completed_at'
  ) THEN
    ALTER TABLE "match_play_brackets" ALTER COLUMN "completed_at" SET DATA TYPE timestamp with time zone;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sponsors'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE "sponsors" ALTER COLUMN "updated_at" SET NOT NULL;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_block_rules'
      AND column_name = 'block_date'
  ) THEN
    ALTER TABLE "tee_block_rules" ALTER COLUMN "block_date" SET DATA TYPE timestamp with time zone;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_block_rules'
      AND column_name = 'created_at'
  ) THEN
    ALTER TABLE "tee_block_rules" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_block_rules'
      AND column_name = 'created_at'
  ) THEN
    ALTER TABLE "tee_block_rules" ALTER COLUMN "created_at" SET DEFAULT now();
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_block_rules'
      AND column_name = 'end_time'
  ) THEN
    ALTER TABLE "tee_block_rules" ALTER COLUMN "end_time" SET DATA TYPE text;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_block_rules'
      AND column_name = 'name'
  ) THEN
    ALTER TABLE "tee_block_rules" ALTER COLUMN "name" SET DATA TYPE text;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_block_rules'
      AND column_name = 'start_time'
  ) THEN
    ALTER TABLE "tee_block_rules" ALTER COLUMN "start_time" SET DATA TYPE text;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_block_rules'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE "tee_block_rules" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_block_rules'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE "tee_block_rules" ALTER COLUMN "updated_at" SET DEFAULT now();
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_booking_windows'
      AND column_name = 'created_at'
  ) THEN
    ALTER TABLE "tee_booking_windows" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_booking_windows'
      AND column_name = 'created_at'
  ) THEN
    ALTER TABLE "tee_booking_windows" ALTER COLUMN "created_at" SET DEFAULT now();
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_booking_windows'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE "tee_booking_windows" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_booking_windows'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE "tee_booking_windows" ALTER COLUMN "updated_at" SET DEFAULT now();
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_player_count_rules'
      AND column_name = 'created_at'
  ) THEN
    ALTER TABLE "tee_player_count_rules" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_player_count_rules'
      AND column_name = 'created_at'
  ) THEN
    ALTER TABLE "tee_player_count_rules" ALTER COLUMN "created_at" SET DEFAULT now();
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_player_count_rules'
      AND column_name = 'end_time'
  ) THEN
    ALTER TABLE "tee_player_count_rules" ALTER COLUMN "end_time" SET DATA TYPE text;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_player_count_rules'
      AND column_name = 'name'
  ) THEN
    ALTER TABLE "tee_player_count_rules" ALTER COLUMN "name" SET DATA TYPE text;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_player_count_rules'
      AND column_name = 'start_time'
  ) THEN
    ALTER TABLE "tee_player_count_rules" ALTER COLUMN "start_time" SET DATA TYPE text;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_player_count_rules'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE "tee_player_count_rules" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_player_count_rules'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE "tee_player_count_rules" ALTER COLUMN "updated_at" SET DEFAULT now();
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_schedule_templates'
      AND column_name = 'created_at'
  ) THEN
    ALTER TABLE "tee_schedule_templates" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_schedule_templates'
      AND column_name = 'created_at'
  ) THEN
    ALTER TABLE "tee_schedule_templates" ALTER COLUMN "created_at" SET DEFAULT now();
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_schedule_templates'
      AND column_name = 'first_tee_time'
  ) THEN
    ALTER TABLE "tee_schedule_templates" ALTER COLUMN "first_tee_time" SET DATA TYPE text;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_schedule_templates'
      AND column_name = 'first_tee_time'
  ) THEN
    ALTER TABLE "tee_schedule_templates" ALTER COLUMN "first_tee_time" SET DEFAULT '06:00';
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_schedule_templates'
      AND column_name = 'last_tee_time'
  ) THEN
    ALTER TABLE "tee_schedule_templates" ALTER COLUMN "last_tee_time" SET DATA TYPE text;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_schedule_templates'
      AND column_name = 'last_tee_time'
  ) THEN
    ALTER TABLE "tee_schedule_templates" ALTER COLUMN "last_tee_time" SET DEFAULT '18:00';
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_schedule_templates'
      AND column_name = 'name'
  ) THEN
    ALTER TABLE "tee_schedule_templates" ALTER COLUMN "name" SET DATA TYPE text;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_schedule_templates'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE "tee_schedule_templates" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_schedule_templates'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE "tee_schedule_templates" ALTER COLUMN "updated_at" SET DEFAULT now();
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_schedule_templates'
      AND column_name = 'valid_from'
  ) THEN
    ALTER TABLE "tee_schedule_templates" ALTER COLUMN "valid_from" SET DATA TYPE timestamp with time zone;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tee_schedule_templates'
      AND column_name = 'valid_until'
  ) THEN
    ALTER TABLE "tee_schedule_templates" ALTER COLUMN "valid_until" SET DATA TYPE timestamp with time zone;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tournament_staff'
      AND column_name = 'user_id'
  ) THEN
    ALTER TABLE "tournament_staff" ALTER COLUMN "user_id" DROP NOT NULL;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "group_pace_records" DROP CONSTRAINT IF EXISTS "group_pace_record_unique";$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "hole_par_times" DROP CONSTRAINT IF EXISTS "hole_par_time_unique";$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "junior_pathway_progress" DROP CONSTRAINT IF EXISTS "junior_pathway_unique";$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "league_staff" DROP CONSTRAINT IF EXISTS "league_staff_invited_by_app_users_id_fk";$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "program_attendance" DROP CONSTRAINT IF EXISTS "program_attendance_unique";$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "program_participants" DROP CONSTRAINT IF EXISTS "program_participant_unique";$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournament_staff" DROP CONSTRAINT IF EXISTS "tournament_staff_invited_by_app_users_id_fk";$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$DROP INDEX IF EXISTS "levy_ledger_email_org_runs_schedule_idx";$POST_MERGE$;
EXCEPTION
  WHEN dependent_objects_still_exist THEN NULL;
  WHEN feature_not_supported THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$DROP INDEX IF EXISTS "match_play_brackets_share_token_unique";$POST_MERGE$;
EXCEPTION
  WHEN dependent_objects_still_exist THEN NULL;
  WHEN feature_not_supported THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$DROP INDEX IF EXISTS "players_tournament_cut_at_idx";$POST_MERGE$;
EXCEPTION
  WHEN dependent_objects_still_exist THEN NULL;
  WHEN feature_not_supported THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$DROP INDEX IF EXISTS "revenue_by_currency_email_runs_schedule_idx";$POST_MERGE$;
EXCEPTION
  WHEN dependent_objects_still_exist THEN NULL;
  WHEN feature_not_supported THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$DROP INDEX IF EXISTS "ryder_cup_config_share_token_unique";$POST_MERGE$;
EXCEPTION
  WHEN dependent_objects_still_exist THEN NULL;
  WHEN feature_not_supported THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "league_staff" DROP COLUMN IF EXISTS "invited_by";$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "tournament_staff" DROP COLUMN IF EXISTS "invited_by";$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'match_play_brackets'
      AND c.conname = 'match_play_brackets_share_token_unique'
  ) THEN
    ALTER TABLE "match_play_brackets" ADD CONSTRAINT "match_play_brackets_share_token_unique" UNIQUE("share_token");
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
      AND c.conname = 'match_play_brackets_tournament_id_unique'
  ) THEN
    ALTER TABLE "match_play_brackets" ADD CONSTRAINT "match_play_brackets_tournament_id_unique" UNIQUE("tournament_id");
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'pace_alert_settings'
      AND c.conname = 'pace_alert_settings_tournament_id_unique'
  ) THEN
    ALTER TABLE "pace_alert_settings" ADD CONSTRAINT "pace_alert_settings_tournament_id_unique" UNIQUE("tournament_id");
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
      AND c.conname = 'round_submission_ext_submission_id_unique'
  ) THEN
    ALTER TABLE "round_submission_ext" ADD CONSTRAINT "round_submission_ext_submission_id_unique" UNIQUE("submission_id");
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
      AND c.conname = 'ryder_cup_config_share_token_unique'
  ) THEN
    ALTER TABLE "ryder_cup_config" ADD CONSTRAINT "ryder_cup_config_share_token_unique" UNIQUE("share_token");
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
      AND c.conname = 'ryder_cup_config_tournament_id_unique'
  ) THEN
    ALTER TABLE "ryder_cup_config" ADD CONSTRAINT "ryder_cup_config_tournament_id_unique" UNIQUE("tournament_id");
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'shop_store_settings'
      AND c.conname = 'shop_store_settings_organization_id_unique'
  ) THEN
    ALTER TABLE "shop_store_settings" ADD CONSTRAINT "shop_store_settings_organization_id_unique" UNIQUE("organization_id");
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
      AND c.conname = 'visitor_passes_qr_token_unique'
  ) THEN
    ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_qr_token_unique" UNIQUE("qr_token");
  END IF;
EXCEPTION
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ad_campaigns_org_idx" ON "ad_campaigns" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ad_campaigns_slot_window_idx" ON "ad_campaigns" USING btree ("slot_id","start_date","end_date");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ad_campaigns_sponsor_idx" ON "ad_campaigns" USING btree ("sponsor_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ad_creatives_org_idx" ON "ad_creatives" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ad_creatives_sponsor_idx" ON "ad_creatives" USING btree ("sponsor_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "affiliate_codes_org_idx" ON "affiliate_codes" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "affiliate_codes_owner_idx" ON "affiliate_codes" USING btree ("owner_user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "affiliate_redemptions_code_idx" ON "affiliate_redemptions" USING btree ("affiliate_code_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "affiliate_redemptions_org_idx" ON "affiliate_redemptions" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ai_caddie_mode_blocks_org_idx" ON "ai_caddie_mode_blocks" USING btree ("organization_id","occurred_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ai_caddie_mode_blocks_user_idx" ON "ai_caddie_mode_blocks" USING btree ("user_id","occurred_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "badge_share_daily_aggregates_day_idx" ON "badge_share_daily_aggregates" USING btree ("day");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "badge_share_daily_aggregates_handle_idx" ON "badge_share_daily_aggregates" USING btree ("handle");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "badge_share_events_badge_idx" ON "badge_share_events" USING btree ("badge_type");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "badge_share_events_created_idx" ON "badge_share_events" USING btree ("created_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "badge_share_events_handle_badge_idx" ON "badge_share_events" USING btree ("handle","badge_type");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "badge_share_events_handle_idx" ON "badge_share_events" USING btree ("handle");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ball_token_credits_org_idx" ON "ball_token_credits" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ball_token_credits_user_idx" ON "ball_token_credits" USING btree ("user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "bundle_deals_org_idx" ON "bundle_deals" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "caddie_assignments_booking_idx" ON "caddie_assignments" USING btree ("tee_booking_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "caddie_assignments_caddie_idx" ON "caddie_assignments" USING btree ("caddie_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "caddie_assignments_org_idx" ON "caddie_assignments" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "caddie_event_assignments_caddie_idx" ON "caddie_event_assignments" USING btree ("caddie_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "caddie_event_assignments_org_idx" ON "caddie_event_assignments" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "caddie_event_assignments_tournament_idx" ON "caddie_event_assignments" USING btree ("tournament_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "caddie_ratings_caddie_idx" ON "caddie_ratings" USING btree ("caddie_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "caddie_recommendations_gp_idx" ON "caddie_recommendations" USING btree ("user_id","general_play_round_id","hole_number");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "caddie_recommendations_player_idx" ON "caddie_recommendations" USING btree ("player_id","tournament_id","round","hole_number");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "caddie_recommendations_user_idx" ON "caddie_recommendations" USING btree ("user_id","recorded_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ccl_clubs_ladder_idx" ON "cross_club_ladder_clubs" USING btree ("ladder_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ccl_entries_division_idx" ON "cross_club_ladder_entries" USING btree ("ladder_id","division");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ccl_entries_ladder_idx" ON "cross_club_ladder_entries" USING btree ("ladder_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ccl_events_entry_idx" ON "cross_club_ladder_events" USING btree ("entry_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ccl_events_ladder_idx" ON "cross_club_ladder_events" USING btree ("ladder_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ccl_results_entry_idx" ON "cross_club_ladder_results" USING btree ("entry_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ccl_results_ladder_idx" ON "cross_club_ladder_results" USING btree ("ladder_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ccl_results_org_idx" ON "cross_club_ladder_results" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ccl_scope_idx" ON "cross_club_ladders" USING btree ("scope");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "ccl_status_idx" ON "cross_club_ladders" USING btree ("status");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "coach_marketplace_listed_idx" ON "coach_marketplace_profiles" USING btree ("is_listed");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "coach_marketplace_org_idx" ON "coach_marketplace_profiles" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "coach_marketplace_payout_verified_idx" ON "coach_marketplace_profiles" USING btree ("payout_verified_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "coach_payout_acct_hist_org_idx" ON "coach_payout_account_history" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "coach_payout_acct_hist_pro_idx" ON "coach_payout_account_history" USING btree ("pro_id","created_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "coach_payout_notif_attempts_push_failed_idx" ON "coach_payout_notification_attempts" USING btree ("push_status","push_attempts");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "coach_payout_notif_attempts_sms_failed_idx" ON "coach_payout_notification_attempts" USING btree ("sms_status","sms_attempts");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "coach_payout_notif_unread_idx" ON "coach_payout_notifications" USING btree ("coach_user_id","read_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "coach_payout_notif_user_idx" ON "coach_payout_notifications" USING btree ("coach_user_id","created_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "coach_payouts_pro_idx" ON "coach_payouts" USING btree ("pro_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "coach_payouts_status_idx" ON "coach_payouts" USING btree ("status");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "course_data_corrections_course_idx" ON "course_data_corrections" USING btree ("course_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "course_data_corrections_org_status_idx" ON "course_data_corrections" USING btree ("organization_id","status");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "esr_flags_org_idx" ON "exceptional_score_flags" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "esr_flags_player_idx" ON "exceptional_score_flags" USING btree ("player_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "esr_flags_status_idx" ON "exceptional_score_flags" USING btree ("status");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "event_survey_fields_survey_idx" ON "event_survey_fields" USING btree ("survey_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "event_survey_forms_org_idx" ON "event_survey_forms" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "event_survey_respondents_survey_idx" ON "event_survey_respondents" USING btree ("survey_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "event_survey_response_items_respondent_idx" ON "event_survey_response_items" USING btree ("respondent_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "event_team_members_lm_idx" ON "event_team_members" USING btree ("league_member_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "event_team_members_player_idx" ON "event_team_members" USING btree ("player_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "event_team_members_team_idx" ON "event_team_members" USING btree ("team_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "event_teams_league_idx" ON "event_teams" USING btree ("league_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "event_teams_tournament_idx" ON "event_teams" USING btree ("tournament_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "fb_mod_groups_org_idx" ON "fb_modifier_groups" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "fb_mod_options_group_idx" ON "fb_modifier_options" USING btree ("group_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "fb_orders_server_idx" ON "fb_orders" USING btree ("server_user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "fb_orders_tab_idx" ON "fb_orders" USING btree ("tab_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "fb_service_periods_org_idx" ON "fb_service_periods" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "fb_tabs_org_idx" ON "fb_tabs" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "fb_tabs_status_idx" ON "fb_tabs" USING btree ("status");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "fx_ledger_org_idx" ON "fx_ledger_entries" USING btree ("organization_id","created_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "fx_rates_pair_idx" ON "fx_rates" USING btree ("base_currency","quote_currency","fetched_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "general_play_markers_round_idx" ON "general_play_markers" USING btree ("round_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "general_play_org_idx" ON "general_play_rounds" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "general_play_played_idx" ON "general_play_rounds" USING btree ("played_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "general_play_user_idx" ON "general_play_rounds" USING btree ("user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "guest_passes_booking_idx" ON "guest_passes" USING btree ("tee_booking_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "guest_passes_invited_by_idx" ON "guest_passes" USING btree ("invited_by_user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "guest_passes_org_idx" ON "guest_passes" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "guest_passes_play_date_idx" ON "guest_passes" USING btree ("play_date");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "hcp_adj_date_idx" ON "handicap_adjustments" USING btree ("adjusted_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "hcp_adj_org_idx" ON "handicap_adjustments" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "hcp_adj_player_idx" ON "handicap_adjustments" USING btree ("player_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "highlight_reel_engagements_org_created_idx" ON "highlight_reel_engagements" USING btree ("organization_id","created_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "highlight_reel_engagements_reel_idx" ON "highlight_reel_engagements" USING btree ("reel_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "highlight_reel_engagements_reel_type_idx" ON "highlight_reel_engagements" USING btree ("reel_id","event_type");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "highlight_reels_created_idx" ON "highlight_reels" USING btree ("created_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "highlight_reels_org_idx" ON "highlight_reels" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "highlight_reels_queue_idx" ON "highlight_reels" USING btree ("status","next_attempt_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "highlight_reels_status_idx" ON "highlight_reels" USING btree ("status");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "highlight_reels_user_idx" ON "highlight_reels" USING btree ("user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "highlight_render_events_reel_idx" ON "highlight_render_events" USING btree ("reel_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "highlight_render_events_user_org_idx" ON "highlight_render_events" USING btree ("user_id","organization_id","created_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "hole_hazards_course_hole_idx" ON "hole_hazards" USING btree ("course_id","hole_number");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "hr_samples_user_gp_idx" ON "hr_samples" USING btree ("user_id","general_play_round_id","round");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "hr_samples_user_recorded_idx" ON "hr_samples" USING btree ("user_id","recorded_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "hr_samples_user_round_idx" ON "hr_samples" USING btree ("user_id","tournament_id","round");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "interclub_league_idx" ON "interclub_fixtures" USING btree ("league_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "league_divisions_league_idx" ON "league_divisions" USING btree ("league_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "league_staff_league_idx" ON "league_staff" USING btree ("league_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "levy_ledger_email_org_runs_schedule_idx" ON "levy_ledger_email_org_runs" USING btree ("schedule_id","sent_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "manual_entry_alerts_player_round_idx" ON "manual_entry_alerts" USING btree ("player_id","round");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "manual_entry_alerts_submission_idx" ON "manual_entry_alerts" USING btree ("submission_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "manual_entry_alerts_tournament_idx" ON "manual_entry_alerts" USING btree ("tournament_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "mkt_bookings_org_idx" ON "marketplace_bookings" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "mkt_bookings_slot_idx" ON "marketplace_bookings" USING btree ("slot_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "mkt_bookings_user_idx" ON "marketplace_bookings" USING btree ("user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "mkt_slots_date_idx" ON "marketplace_slots" USING btree ("slot_date");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "mkt_slots_org_idx" ON "marketplace_slots" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "mkt_slots_public_idx" ON "marketplace_slots" USING btree ("is_public","slot_date");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "mkt_slots_status_idx" ON "marketplace_slots" USING btree ("status");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "notification_audit_log_key_created_idx" ON "notification_audit_log" USING btree ("notification_key","created_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "notification_audit_log_user_idx" ON "notification_audit_log" USING btree ("user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "notification_digest_queue_user_undelivered_idx" ON "notification_digest_queue" USING btree ("user_id","delivered_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "notification_type_registry_category_idx" ON "notification_type_registry" USING btree ("category");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "odds_telemetry_event_idx" ON "odds_telemetry" USING btree ("event_type","widget");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "odds_telemetry_tournament_idx" ON "odds_telemetry" USING btree ("tournament_id","created_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "org_memberships_vendor_idx" ON "org_memberships" USING btree ("vendor_operator_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "pos_transactions_vendor_idx" ON "pos_transactions" USING btree ("vendor_operator_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "post_event_survey_responses_survey_idx" ON "post_event_survey_responses" USING btree ("survey_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "practice_sessions_date_idx" ON "practice_sessions" USING btree ("session_date");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "practice_sessions_org_idx" ON "practice_sessions" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "practice_sessions_user_idx" ON "practice_sessions" USING btree ("user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "product_waitlist_product_idx" ON "product_waitlist" USING btree ("product_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "product_waitlist_variant_idx" ON "product_waitlist" USING btree ("variant_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "promo_redemptions_org_idx" ON "promotion_redemptions" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "promo_redemptions_promo_idx" ON "promotion_redemptions" USING btree ("promotion_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "promotions_org_idx" ON "promotions" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "range_bay_org_idx" ON "range_bays" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "range_blackout_org_idx" ON "range_blackouts" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "reg_form_fields_event_idx" ON "registration_form_fields" USING btree ("event_id","event_type");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "reg_form_fields_org_idx" ON "registration_form_fields" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "reg_form_responses_entry_idx" ON "registration_form_responses" USING btree ("entry_id","event_type");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "reg_form_responses_field_idx" ON "registration_form_responses" USING btree ("field_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "rental_bookings_asset_idx" ON "rental_bookings" USING btree ("asset_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "rental_bookings_member_idx" ON "rental_bookings" USING btree ("member_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "rental_bookings_org_idx" ON "rental_bookings" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "rental_bookings_tee_booking_idx" ON "rental_bookings" USING btree ("tee_booking_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "revenue_by_currency_email_runs_schedule_idx" ON "revenue_by_currency_email_runs" USING btree ("schedule_id","sent_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "rulings_player_idx" ON "tournament_rulings" USING btree ("player_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "rulings_tournament_idx" ON "tournament_rulings" USING btree ("tournament_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "sales_attributions_date_idx" ON "sales_attributions" USING btree ("attributed_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "sales_attributions_org_idx" ON "sales_attributions" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "sales_attributions_payout_idx" ON "sales_attributions" USING btree ("payout_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "sales_attributions_staff_idx" ON "sales_attributions" USING btree ("staff_user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "saved_reports_org_idx" ON "saved_reports" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "scorer_pins_tournament_idx" ON "scorer_pins" USING btree ("tournament_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "shop_bundle_components_bundle_idx" ON "shop_bundle_components" USING btree ("bundle_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "shop_bundles_org_idx" ON "shop_bundles" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "shop_category_flash_org_idx" ON "shop_category_flash_sales" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "shop_locations_org_idx" ON "shop_locations" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "shop_stock_adj_org_idx" ON "shop_stock_adjustments" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "shop_stock_adj_variant_idx" ON "shop_stock_adjustments" USING btree ("variant_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "shop_stock_transfers_org_idx" ON "shop_stock_transfers" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "shop_stocktake_items_session_idx" ON "shop_stocktake_items" USING btree ("session_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "shop_stocktake_sessions_org_idx" ON "shop_stocktake_sessions" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "shop_variant_stock_location_idx" ON "shop_variant_stock" USING btree ("location_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "shop_variants_barcode_idx" ON "shop_product_variants" USING btree ("barcode");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "shots_user_gp_idx" ON "shots" USING btree ("user_id","general_play_round_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "side_game_instances_gp_round_idx" ON "side_game_instances" USING btree ("general_play_round_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "side_game_instances_league_round_idx" ON "side_game_instances" USING btree ("league_round_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "side_game_instances_org_idx" ON "side_game_instances" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "side_game_instances_tournament_idx" ON "side_game_instances" USING btree ("tournament_id","round");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "side_game_settlement_receipt_attempts_org_idx" ON "side_game_settlement_receipt_attempts" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "side_game_settlement_receipt_attempts_settlement_idx" ON "side_game_settlement_receipt_attempts" USING btree ("settlement_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "side_game_settlements_instance_idx" ON "side_game_settlements" USING btree ("instance_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "side_game_templates_league_idx" ON "side_game_templates" USING btree ("league_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "side_game_templates_org_idx" ON "side_game_templates" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "sponsor_events_campaign_idx" ON "sponsor_events" USING btree ("campaign_id","recorded_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "sponsor_events_org_idx" ON "sponsor_events" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "sponsor_events_slot_idx" ON "sponsor_events" USING btree ("organization_id","slot_key","recorded_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "sponsor_events_sponsor_rec_idx" ON "sponsor_events" USING btree ("sponsor_id","recorded_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "swing_annotations_review_idx" ON "swing_annotations" USING btree ("review_request_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "swing_annotations_video_idx" ON "swing_annotations" USING btree ("swing_video_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "swing_comparisons_user_idx" ON "swing_comparisons" USING btree ("user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "swing_review_org_idx" ON "swing_review_requests" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "swing_review_pro_idx" ON "swing_review_requests" USING btree ("pro_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "swing_review_status_idx" ON "swing_review_requests" USING btree ("status");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "swing_review_user_idx" ON "swing_review_requests" USING btree ("user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "swing_videos_user_captured_idx" ON "swing_videos" USING btree ("user_id","captured_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "swing_videos_user_idx" ON "swing_videos" USING btree ("user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tax_profiles_org_idx" ON "tax_profiles" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tax_rates_profile_idx" ON "tax_rates" USING btree ("tax_profile_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "teaching_pros_org_idx" ON "teaching_pros" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "teaching_pros_user_idx" ON "teaching_pros" USING btree ("user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tee_block_rules_date_idx" ON "tee_block_rules" USING btree ("block_date");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tee_booking_players_booking_idx" ON "tee_booking_players" USING btree ("booking_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tee_booking_waitlist_slot_status_idx" ON "tee_booking_waitlist" USING btree ("slot_id","status","created_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tee_bookings_lead_idx" ON "tee_bookings" USING btree ("lead_user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tee_bookings_org_idx" ON "tee_bookings" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tee_bookings_slot_idx" ON "tee_bookings" USING btree ("slot_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tee_dynamic_pricing_rules_org_active_idx" ON "tee_dynamic_pricing_rules" USING btree ("organization_id","active");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tee_schedule_templates_course_idx" ON "tee_schedule_templates" USING btree ("course_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tee_schedule_templates_org_idx" ON "tee_schedule_templates" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tee_slot_course_date_idx" ON "course_tee_slots" USING btree ("course_id","slot_date");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tee_slot_org_idx" ON "course_tee_slots" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tournament_merchandise_tournament_idx" ON "tournament_merchandise" USING btree ("tournament_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tournament_predictions_tournament_idx" ON "tournament_predictions" USING btree ("tournament_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tournament_rounds_tournament_idx" ON "tournament_rounds" USING btree ("tournament_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tournament_staff_tournament_idx" ON "tournament_staff" USING btree ("tournament_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "tournament_templates_org_idx" ON "tournament_templates" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "watch_motion_buffer_created_idx" ON "watch_motion_buffer" USING btree ("created_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "watch_motion_buffer_user_ts_idx" ON "watch_motion_buffer" USING btree ("user_id","event_timestamp_ms");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "watch_pair_code_idx" ON "watch_pairing_challenges" USING btree ("code");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "watch_pair_user_idx" ON "watch_pairing_challenges" USING btree ("user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "whs_pcc_org_idx" ON "whs_pcc_entries" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "whs_player_state_org_idx" ON "whs_player_state" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "whs_postings_player_idx" ON "whs_postings" USING btree ("player_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "whs_postings_tournament_idx" ON "whs_postings" USING btree ("tournament_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "whs_score_records_org_idx" ON "whs_score_records" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "whs_score_records_played_idx" ON "whs_score_records" USING btree ("played_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "whs_score_records_user_idx" ON "whs_score_records" USING btree ("user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "ad_slot_org_key_unique" ON "ad_slots" USING btree ("organization_id","slot_key");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_codes_org_code_unique" ON "affiliate_codes" USING btree ("organization_id","code");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_redemptions_code_order_unique" ON "affiliate_redemptions" USING btree ("affiliate_code_id","order_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "bounced_digest_schedule_opt_out_unique" ON "bounced_digest_schedule_opt_outs" USING btree ("organization_id","user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "caddie_assignments_booking_caddie_unique" ON "caddie_assignments" USING btree ("tee_booking_id","caddie_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "caddie_event_assignments_caddie_tournament_unique" ON "caddie_event_assignments" USING btree ("caddie_id","tournament_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "caddie_ratings_assignment_user_unique" ON "caddie_ratings" USING btree ("assignment_id","rated_by_user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "ccl_clubs_unique" ON "cross_club_ladder_clubs" USING btree ("ladder_id","organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "ccl_entries_user_unique" ON "cross_club_ladder_entries" USING btree ("ladder_id","user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "club_carry_distances_user_club_unique" ON "club_carry_distances" USING btree ("user_id","club");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "coach_marketplace_pro_unique" ON "coach_marketplace_profiles" USING btree ("pro_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "coach_payout_notif_attempts_payout_unique" ON "coach_payout_notification_attempts" USING btree ("payout_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "coach_payout_notif_payout_unique" ON "coach_payout_notifications" USING btree ("payout_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "esr_player_round_unique" ON "exceptional_score_flags" USING btree ("organization_id","player_id","tournament_id","round");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "esr_posting_unique" ON "exceptional_score_flags" USING btree ("posting_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "event_survey_forms_event_unique" ON "event_survey_forms" USING btree ("event_id","event_type");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "event_survey_respondents_token_unique" ON "event_survey_respondents" USING btree ("token");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "event_survey_respondents_unique" ON "event_survey_respondents" USING btree ("survey_id","entry_id","event_type");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "event_survey_response_items_unique" ON "event_survey_response_items" USING btree ("respondent_id","field_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "fb_item_mod_group_unique" ON "fb_menu_item_modifier_groups" USING btree ("menu_item_id","group_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "fb_item_period_unique" ON "fb_menu_item_service_periods" USING btree ("menu_item_id","service_period_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "general_play_hole_unique" ON "general_play_hole_scores" USING btree ("round_id","hole_number");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "group_pace_record_unique" ON "group_pace_records" USING btree ("tee_time_id","round");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "hole_par_time_unique" ON "hole_par_times" USING btree ("course_id","hole_number");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "junior_pathway_unique" ON "junior_pathway_progress" USING btree ("junior_profile_id","pathway_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "league_staff_email_unique" ON "league_staff" USING btree ("league_id","email");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "mkt_saved_alert_pair_unq" ON "marketplace_saved_search_alerts" USING btree ("search_id","slot_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "org_plan_overrides_org_unique" ON "org_plan_overrides" USING btree ("organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "payment_processor_configs_org_currency_unique" ON "payment_processor_configs" USING btree ("organization_id","currency");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "pin_pos_gp_hole_unique" ON "hole_pin_positions" USING btree ("general_play_round_id","hole_number");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "pin_pos_tournament_unique" ON "hole_pin_positions" USING btree ("tournament_id","player_id","round_number","hole_number");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "players_share_token_unique" ON "players" USING btree ("share_token");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "product_waitlist_variant_user_unique" ON "product_waitlist" USING btree ("organization_id","variant_id","user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "program_attendance_unique" ON "program_attendance" USING btree ("session_id","junior_profile_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "program_participant_unique" ON "program_participants" USING btree ("program_id","junior_profile_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "promo_redemptions_promo_order_unique" ON "promotion_redemptions" USING btree ("promotion_id","order_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "promotions_org_code_unique" ON "promotions" USING btree ("organization_id","code");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "range_bay_org_number_unique" ON "range_bays" USING btree ("organization_id","bay_number");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "reg_form_responses_unique" ON "registration_form_responses" USING btree ("field_id","entry_id","event_type");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "rental_bookings_asset_active_unique" ON "rental_bookings" USING btree ("asset_id") WHERE "rental_bookings"."status" IN ('reserved', 'checked_out');$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "round_submission_share_token_unique" ON "round_submissions" USING btree ("marker_share_token");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "scorer_pins_pin_unique" ON "scorer_pins" USING btree ("tournament_id","pin");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "shop_stocktake_items_unique" ON "shop_stocktake_items" USING btree ("session_id","variant_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "shop_variant_stock_unique" ON "shop_variant_stock" USING btree ("variant_id","location_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "shots_player_tournament_round_hole_shot_unique" ON "shots" USING btree ("player_id","tournament_id","round","hole_number","shot_number");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "shots_user_gp_round_hole_shot_unique" ON "shots" USING btree ("user_id","general_play_round_id","round","hole_number","shot_number");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "tee_booking_windows_org_tier_unique" ON "tee_booking_windows" USING btree ("organization_id","membership_tier");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "tee_slot_unique_identity_idx" ON "course_tee_slots" USING btree ("organization_id","course_id","slot_date","slot_time","starting_hole");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "tournament_merchandise_tournament_product_unique" ON "tournament_merchandise" USING btree ("tournament_id","product_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "tournament_predictions_user_tournament_unique" ON "tournament_predictions" USING btree ("tournament_id","user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "tournament_rounds_unique" ON "tournament_rounds" USING btree ("tournament_id","round_number");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "tournament_staff_email_unique" ON "tournament_staff" USING btree ("tournament_id","email");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "whs_pcc_course_date_unique" ON "whs_pcc_entries" USING btree ("course_id","competition_date");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "whs_player_state_user_org_unique" ON "whs_player_state" USING btree ("user_id","organization_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "whs_posting_player_round_unique" ON "whs_postings" USING btree ("tournament_id","player_id","round");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
