-- Task #1131 — Editable mapping from non-standard legacy plan slugs
-- (e.g. "basic", "premium") to a canonical SubscriptionTier. Read by the
-- super-admin Plan Migration audit panel to suggest a restore tier;
-- managed by super admins via the super-admin UI so support staff can
-- add/edit entries themselves without an engineer or code deploy.
--
-- Replaces the previously hardcoded LEGACY_SLUG_TIER_GUESSES constant
-- in artifacts/kharagolf-web/src/pages/super-admin.tsx.

CREATE TABLE IF NOT EXISTS "legacy_plan_slug_mappings" (
  "slug" text PRIMARY KEY NOT NULL,
  "tier" "subscription_tier" NOT NULL,
  "notes" text,
  "created_by_user_id" integer,
  "updated_by_user_id" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "legacy_plan_slug_mappings_created_by_user_id_app_users_id_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "app_users" ("id") ON DELETE SET NULL,
  CONSTRAINT "legacy_plan_slug_mappings_updated_by_user_id_app_users_id_fk"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "app_users" ("id") ON DELETE SET NULL
);

-- Seed the canonical defaults the hardcoded constant used to provide so
-- the audit panel keeps suggesting the same tier on first deploy. Only
-- inserted if the row doesn't already exist — never overwrites
-- support-edited rows. After this initial seed the API helper does NOT
-- re-insert defaults on subsequent boots, so any row a support agent
-- deletes stays deleted.
INSERT INTO "legacy_plan_slug_mappings" ("slug", "tier", "notes")
VALUES
  ('basic',          'starter',    'Seeded default (Task #977 hardcoded mapping)'),
  ('trial',          'starter',    'Seeded default (Task #977 hardcoded mapping)'),
  ('starter_v2',     'starter',    'Seeded default (Task #977 hardcoded mapping)'),
  ('premium',        'pro',        'Seeded default (Task #977 hardcoded mapping)'),
  ('pro_v2',         'pro',        'Seeded default (Task #977 hardcoded mapping)'),
  ('pro_plus',       'pro',        'Seeded default (Task #977 hardcoded mapping)'),
  ('business',       'pro',        'Seeded default (Task #977 hardcoded mapping)'),
  ('team',           'pro',        'Seeded default (Task #977 hardcoded mapping)'),
  ('ent',            'enterprise', 'Seeded default (Task #977 hardcoded mapping)'),
  ('enterprise_v2',  'enterprise', 'Seeded default (Task #977 hardcoded mapping)'),
  ('unlimited',      'enterprise', 'Seeded default (Task #977 hardcoded mapping)')
ON CONFLICT ("slug") DO NOTHING;
