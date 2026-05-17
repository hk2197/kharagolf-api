-- Task #95: Golf Trip & Away Day Planner

DO $$ BEGIN
  CREATE TYPE "trip_status" AS ENUM ('draft', 'open', 'confirmed', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "itinerary_item_type" AS ENUM ('travel', 'golf_round', 'dinner', 'accommodation', 'activity', 'free_time');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "trip_participant_status" AS ENUM ('invited', 'confirmed', 'waitlisted', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "golf_trips" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "destination" text NOT NULL,
  "external_course_name" text NOT NULL,
  "description" text,
  "start_date" timestamp with time zone NOT NULL,
  "end_date" timestamp with time zone NOT NULL,
  "status" "trip_status" NOT NULL DEFAULT 'draft',
  "max_participants" integer,
  "deposit_amount" numeric(10, 2),
  "currency" text NOT NULL DEFAULT 'INR',
  "estimated_total_cost" numeric(10, 2),
  "notes" text,
  "created_by" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "trip_itinerary_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "trip_id" integer NOT NULL REFERENCES "golf_trips"("id") ON DELETE CASCADE,
  "day_number" integer NOT NULL,
  "start_time" text,
  "end_time" text,
  "type" "itinerary_item_type" NOT NULL DEFAULT 'activity',
  "title" text NOT NULL,
  "location" text,
  "description" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "trip_participants" (
  "id" serial PRIMARY KEY NOT NULL,
  "trip_id" integer NOT NULL REFERENCES "golf_trips"("id") ON DELETE CASCADE,
  "user_id" integer REFERENCES "app_users"("id") ON DELETE SET NULL,
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "email" text,
  "phone" text,
  "handicap_index" numeric(4, 1),
  "status" "trip_participant_status" NOT NULL DEFAULT 'invited',
  "deposit_status" "payment_status" NOT NULL DEFAULT 'unpaid',
  "razorpay_order_id" text,
  "razorpay_payment_id" text,
  "notes" text,
  "signed_up_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "trip_rooms" (
  "id" serial PRIMARY KEY NOT NULL,
  "trip_id" integer NOT NULL REFERENCES "golf_trips"("id") ON DELETE CASCADE,
  "room_name" text NOT NULL,
  "room_type" text,
  "cost_per_night" numeric(10, 2),
  "nights" integer,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "trip_cars" (
  "id" serial PRIMARY KEY NOT NULL,
  "trip_id" integer NOT NULL REFERENCES "golf_trips"("id") ON DELETE CASCADE,
  "car_label" text NOT NULL,
  "driver_participant_id" integer REFERENCES "trip_participants"("id") ON DELETE SET NULL,
  "total_cost" numeric(10, 2),
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "trip_room_assignments" (
  "id" serial PRIMARY KEY NOT NULL,
  "room_id" integer NOT NULL REFERENCES "trip_rooms"("id") ON DELETE CASCADE,
  "participant_id" integer NOT NULL REFERENCES "trip_participants"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "trip_car_assignments" (
  "id" serial PRIMARY KEY NOT NULL,
  "car_id" integer NOT NULL REFERENCES "trip_cars"("id") ON DELETE CASCADE,
  "participant_id" integer NOT NULL REFERENCES "trip_participants"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "trip_tee_slots" (
  "id" serial PRIMARY KEY NOT NULL,
  "trip_id" integer NOT NULL REFERENCES "golf_trips"("id") ON DELETE CASCADE,
  "round_day" integer NOT NULL,
  "tee_time" text NOT NULL,
  "hole_start" integer NOT NULL DEFAULT 1,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "trip_tee_slot_assignments" (
  "id" serial PRIMARY KEY NOT NULL,
  "slot_id" integer NOT NULL REFERENCES "trip_tee_slots"("id") ON DELETE CASCADE,
  "participant_id" integer NOT NULL REFERENCES "trip_participants"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "trip_expenses" (
  "id" serial PRIMARY KEY NOT NULL,
  "trip_id" integer NOT NULL REFERENCES "golf_trips"("id") ON DELETE CASCADE,
  "category" text NOT NULL,
  "description" text NOT NULL,
  "amount" numeric(10, 2) NOT NULL,
  "paid_by" integer REFERENCES "trip_participants"("id") ON DELETE SET NULL,
  "split_between" jsonb DEFAULT '[]',
  "receipt_url" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS "golf_trips_org_idx" ON "golf_trips"("organization_id");
CREATE INDEX IF NOT EXISTS "golf_trips_status_idx" ON "golf_trips"("status");
CREATE INDEX IF NOT EXISTS "trip_itinerary_trip_idx" ON "trip_itinerary_items"("trip_id");
CREATE INDEX IF NOT EXISTS "trip_participants_trip_idx" ON "trip_participants"("trip_id");
CREATE UNIQUE INDEX IF NOT EXISTS "trip_participants_trip_user_unique" ON "trip_participants"("trip_id", "user_id") WHERE "user_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "trip_rooms_trip_idx" ON "trip_rooms"("trip_id");
CREATE INDEX IF NOT EXISTS "trip_cars_trip_idx" ON "trip_cars"("trip_id");
CREATE UNIQUE INDEX IF NOT EXISTS "trip_room_assignment_unique" ON "trip_room_assignments"("room_id", "participant_id");
CREATE INDEX IF NOT EXISTS "trip_room_assign_participant_idx" ON "trip_room_assignments"("participant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "trip_car_assignment_unique" ON "trip_car_assignments"("car_id", "participant_id");
CREATE INDEX IF NOT EXISTS "trip_car_assign_participant_idx" ON "trip_car_assignments"("participant_id");
CREATE INDEX IF NOT EXISTS "trip_tee_slots_trip_idx" ON "trip_tee_slots"("trip_id");
CREATE UNIQUE INDEX IF NOT EXISTS "trip_tee_slot_assignment_unique" ON "trip_tee_slot_assignments"("slot_id", "participant_id");
CREATE INDEX IF NOT EXISTS "trip_expenses_trip_idx" ON "trip_expenses"("trip_id");
