-- Catch-up migration #4 (Task #1403): residual schema drift mop-up.
--
-- Generated from the residual lib/db/.migration-coverage-baseline.json
-- after 0114-0117 closed the original 1192-statement gap. These items
-- cover tables/columns/indexes/FKs whose original numbered migrations
-- (e.g. 0107/0111/0112/0113) failed because parent tables hadn't been
-- created yet (chicken/egg with earlier broken migrations).
--
-- Every statement is wrapped to be IDEMPOTENT so post-merge.sh can
-- replay it on dev/test DBs that already have the object.

-- == Tables ==
DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "manual_entry_alert_recipients" (
  "id" serial PRIMARY KEY NOT NULL,
  "alert_id" integer NOT NULL,
  "user_id" integer,
  "channel" text NOT NULL,
  "status" text NOT NULL,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "manual_entry_alert_recipients_channel_chk" CHECK ("manual_entry_alert_recipients"."channel" in ('push','email')),
  CONSTRAINT "manual_entry_alert_recipients_status_chk" CHECK ("manual_entry_alert_recipients"."status" in ('sent','failed','no_address','no_email','opted_out'))
);$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "round_weather_cache" (
  "id" serial PRIMARY KEY NOT NULL,
  "tournament_id" integer,
  "general_play_round_id" integer,
  "round" integer DEFAULT 1 NOT NULL,
  "course_id" integer,
  "observed_date" text NOT NULL,
  "temperature_mean" numeric(5, 2),
  "wind_speed_max" numeric(6, 2),
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE TABLE IF NOT EXISTS "swing_video_fps_probes" (
  "id" serial PRIMARY KEY NOT NULL,
  "swing_video_id" integer NOT NULL,
  "object_path" text NOT NULL,
  "status" "swing_video_fps_probe_status" DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

-- == Columns ==

DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "caddie_recommendations" ADD COLUMN IF NOT EXISTS "humidity" numeric(5, 2);$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "caddie_recommendations" ADD COLUMN IF NOT EXISTS "precipitation" numeric(6, 2);$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "coach_marketplace_profiles" ADD COLUMN IF NOT EXISTS "coaches_handicap_max" numeric(4, 1);$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "coach_marketplace_profiles" ADD COLUMN IF NOT EXISTS "coaches_handicap_min" numeric(4, 1);$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "coach_payout_account_history" ADD COLUMN IF NOT EXISTS "verification_outcome" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE $POST_MERGE$ALTER TABLE "coach_payout_account_history" ADD COLUMN IF NOT EXISTS "verification_reason" text;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

-- == Indexes (drop the stale single-col version of the schedule idx first
-- so the (schedule_id, sent_at) form below replaces it cleanly) ==

DROP INDEX IF EXISTS "forecast_accuracy_email_runs_schedule_idx";

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "coach_marketplace_handicap_idx" ON "coach_marketplace_profiles" USING btree ("coaches_handicap_min","coaches_handicap_max");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "forecast_accuracy_email_runs_schedule_idx" ON "forecast_accuracy_email_runs" USING btree ("schedule_id","sent_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "manual_entry_alert_recipients_alert_idx" ON "manual_entry_alert_recipients" USING btree ("alert_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "manual_entry_alert_recipients_user_idx" ON "manual_entry_alert_recipients" USING btree ("user_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "round_weather_cache_observed_date_idx" ON "round_weather_cache" USING btree ("observed_date");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE INDEX IF NOT EXISTS "swing_video_fps_probes_queue_idx" ON "swing_video_fps_probes" USING btree ("status","next_attempt_at");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "round_weather_cache_gp_unique" ON "round_weather_cache" USING btree ("general_play_round_id","round") WHERE "round_weather_cache"."general_play_round_id" IS NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "round_weather_cache_tournament_unique" ON "round_weather_cache" USING btree ("tournament_id","round") WHERE "round_weather_cache"."tournament_id" IS NOT NULL;$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  EXECUTE $POST_MERGE$CREATE UNIQUE INDEX IF NOT EXISTS "swing_video_fps_probes_video_uniq" ON "swing_video_fps_probes" USING btree ("swing_video_id");$POST_MERGE$;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_column THEN NULL;
END $$;

-- == Foreign keys (idempotent via pg_constraint existence check) ==

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_social_links_user_id_app_users_id_fk') THEN
    ALTER TABLE "app_user_social_links" ADD CONSTRAINT "app_user_social_links_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coach_payout_acct_chg_notify_attempts_history_fk') THEN
    ALTER TABLE "coach_payout_account_change_notify_attempts" ADD CONSTRAINT "coach_payout_acct_chg_notify_attempts_history_fk" FOREIGN KEY ("history_id") REFERENCES "public"."coach_payout_account_history"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coach_payout_acct_chg_notify_attempts_pro_fk') THEN
    ALTER TABLE "coach_payout_account_change_notify_attempts" ADD CONSTRAINT "coach_payout_acct_chg_notify_attempts_pro_fk" FOREIGN KEY ("pro_id") REFERENCES "public"."teaching_pros"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_accuracy_email_runs_org_fk') THEN
    ALTER TABLE "forecast_accuracy_email_runs" ADD CONSTRAINT "forecast_accuracy_email_runs_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_accuracy_email_runs_schedule_fk') THEN
    ALTER TABLE "forecast_accuracy_email_runs" ADD CONSTRAINT "forecast_accuracy_email_runs_schedule_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."forecast_accuracy_email_schedules"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_accuracy_email_schedules_created_by_user_id_fk') THEN
    ALTER TABLE "forecast_accuracy_email_schedules" ADD CONSTRAINT "forecast_accuracy_email_schedules_created_by_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_accuracy_email_schedules_organization_id_fk') THEN
    ALTER TABLE "forecast_accuracy_email_schedules" ADD CONSTRAINT "forecast_accuracy_email_schedules_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'manual_entry_alert_recipients_alert_fk') THEN
    ALTER TABLE "manual_entry_alert_recipients" ADD CONSTRAINT "manual_entry_alert_recipients_alert_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."manual_entry_alerts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'manual_entry_alert_recipients_user_fk') THEN
    ALTER TABLE "manual_entry_alert_recipients" ADD CONSTRAINT "manual_entry_alert_recipients_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_share_daily_aggregates_user_id_app_users_id_fk') THEN
    ALTER TABLE "profile_share_daily_aggregates" ADD CONSTRAINT "profile_share_daily_aggregates_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recap_share_daily_aggregates_user_id_app_users_id_fk') THEN
    ALTER TABLE "recap_share_daily_aggregates" ADD CONSTRAINT "recap_share_daily_aggregates_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recap_share_events_user_id_app_users_id_fk') THEN
    ALTER TABLE "recap_share_events" ADD CONSTRAINT "recap_share_events_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'round_weather_cache_course_id_courses_id_fk') THEN
    ALTER TABLE "round_weather_cache" ADD CONSTRAINT "round_weather_cache_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'round_weather_cache_gp_round_id_fk') THEN
    ALTER TABLE "round_weather_cache" ADD CONSTRAINT "round_weather_cache_gp_round_id_fk" FOREIGN KEY ("general_play_round_id") REFERENCES "public"."general_play_rounds"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'round_weather_cache_tournament_id_tournaments_id_fk') THEN
    ALTER TABLE "round_weather_cache" ADD CONSTRAINT "round_weather_cache_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'swing_video_fps_probes_swing_video_id_swing_videos_id_fk') THEN
    ALTER TABLE "swing_video_fps_probes" ADD CONSTRAINT "swing_video_fps_probes_swing_video_id_swing_videos_id_fk" FOREIGN KEY ("swing_video_id") REFERENCES "public"."swing_videos"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;
