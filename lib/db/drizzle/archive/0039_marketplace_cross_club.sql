-- Task 359: Cross-club tee-time marketplace
--
-- Extends the per-org tee-time marketplace into a true cross-club discovery
-- platform (à la GolfNow / Supreme Golf / Chronogolf). Each club opts in,
-- selects which slots it exposes, and may apply a markup or commission.
-- Players search slots across all participating clubs by date, location,
-- price, and group size, and may save searches that emit notifications
-- when matching slots open.

-- ── Per-slot exposure + pricing intel ──────────────────────────────────────

-- post-merge-guard: fresh-DB guard (table:marketplace_slots)
-- This migration's parent object is created by a later catch-up
-- migration (0114-0118). On a fresh DB the guard skips this file
-- so post-merge.sh can run with ON_ERROR_STOP=1.
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'marketplace_slots') AS post_merge_dep_present \gset
\if :post_merge_dep_present

ALTER TABLE marketplace_slots
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS base_price_paise INTEGER,           -- price before markup; null = use price_paise
  ADD COLUMN IF NOT EXISTS surge_indicator TEXT NOT NULL DEFAULT 'normal'; -- 'off_peak'|'normal'|'surge'

CREATE INDEX IF NOT EXISTS mkt_slots_public_idx ON marketplace_slots(is_public, slot_date);

-- ── Per-club marketplace exposure & commercials ────────────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS marketplace_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS marketplace_default_public BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS marketplace_commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0,  -- platform cut, %
  ADD COLUMN IF NOT EXISTS marketplace_markup_pct NUMERIC(5,2) NOT NULL DEFAULT 0,      -- club markup applied to listed price, %
  ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7);

-- ── Saved searches (with optional alert notifications) ─────────────────────
CREATE TABLE IF NOT EXISTS marketplace_saved_searches (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  filters         JSONB NOT NULL,             -- { fromDate, toDate, daysOfWeek, courseIds, orgIds, lat, lng, radiusKm, minSpots, maxPricePaise }
  notify_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  last_notified_at TIMESTAMPTZ,
  last_match_count INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mkt_saved_user_idx ON marketplace_saved_searches(user_id);
CREATE INDEX IF NOT EXISTS mkt_saved_notify_idx ON marketplace_saved_searches(notify_enabled);

-- ── Track which saved-search slots have already been alerted for, so a
-- ── re-opening slot doesn't spam the user. (slot_id, search_id) pair.
CREATE TABLE IF NOT EXISTS marketplace_saved_search_alerts (
  id           SERIAL PRIMARY KEY,
  search_id    INTEGER NOT NULL REFERENCES marketplace_saved_searches(id) ON DELETE CASCADE,
  slot_id      INTEGER NOT NULL REFERENCES marketplace_slots(id) ON DELETE CASCADE,
  alerted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (search_id, slot_id)
);

\else
\echo 'parent table marketplace_slots not yet present; skipping (will be applied by 0114-0118 catch-up migrations)'
\endif

