-- Task #1697 — back the per-user "mute this author" relationship that the
-- feed-post push fan-out (and any future feed-author-scoped notification
-- pipeline) consults to suppress notifications from a specific author for a
-- specific recipient. Intentionally distinct from `user_follows`: a follow is
-- opt-in subscription, while a mute is opt-out suppression — a member can
-- follow an author and still mute their pushes if they only want in-app
-- visibility.
--
-- One row per (muter, mutedUser); cascades on either side so deleting either
-- account drops the row without leaving a dangling reference. The reverse
-- index on `muted_user_id` lets the fan-out resolve "who has muted me" in a
-- single index scan when the author is the larger cardinality.

CREATE TABLE IF NOT EXISTS "user_feed_author_mutes" (
  "muter_id" integer NOT NULL,
  "muted_user_id" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_feed_author_mutes_pkey" PRIMARY KEY("muter_id","muted_user_id")
);

DO $$ BEGIN
  ALTER TABLE "user_feed_author_mutes"
    ADD CONSTRAINT "user_feed_author_mutes_muter_id_app_users_id_fk"
    FOREIGN KEY ("muter_id") REFERENCES "public"."app_users"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "user_feed_author_mutes"
    ADD CONSTRAINT "user_feed_author_mutes_muted_user_id_app_users_id_fk"
    FOREIGN KEY ("muted_user_id") REFERENCES "public"."app_users"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "user_feed_author_mutes_muted_user_idx"
  ON "user_feed_author_mutes" USING btree ("muted_user_id");
