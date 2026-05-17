-- Task #2143 — Replace the off-the-books `shop_products` rebuild with a
-- proper, idempotent migration.
--
-- BACKGROUND
-- ----------
-- While completing Task #1715 (strict ON_ERROR_STOP migrations) the dev
-- DB tripped over a corrupted `shop_products` table whose
-- `pg_class.relnatts` had grown to 1600 (PostgreSQL's hard ceiling for
-- per-relation column slots — 1600 = `MaxHeapAttributeNumber`). Every
-- ADD/DROP COLUMN ever issued against the table — including the ones
-- drizzle-kit's introspect-and-push flow re-runs whenever the schema
-- file disagrees with the live DB — leaves a tombstoned `pg_attribute`
-- row behind (`attisdropped = true`). Once the slot count hits 1600
-- the next ALTER TABLE fails with `tables can have at most 1600
-- columns`, and there is no in-place way to compact the column slots:
-- the only fix is to rebuild the table.
--
-- The fix on dev was applied by hand (CREATE TABLE AS … + DROP TABLE
-- shop_products CASCADE + RENAME + sequence/seq-default fix-ups) but
-- never committed as a migration, so production may still be a single
-- schema-sync away from the same wedge and there is no version-
-- controlled record of how to recover.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. Looks at `pg_class.relnatts` for `public.shop_products`. Healthy
--    state is ~22 columns; we trigger a rebuild only when the slot
--    count crosses the `SLOT_REBUILD_THRESHOLD` (200). That gives 9x
--    headroom over the live schema while still leaving 8x headroom
--    before the 1600 ceiling — far enough away from "normal churn"
--    that we won't false-trigger and far enough below the ceiling
--    that we still have runway to ALTER TABLE in the meantime.
-- 2. Captures every incoming foreign-key constraint that references
--    `shop_products` from `pg_constraint` / `pg_get_constraintdef` so
--    we can rebuild them verbatim afterwards.
-- 3. Records the current `MAX(id)` so the rebuilt sequence picks up
--    exactly where the corrupted one left off.
-- 4. Drops the captured FKs by name (so we don't have to use DROP
--    TABLE CASCADE — CASCADE would also nuke any view/rule we don't
--    know about, and we want a hard failure in that case rather than
--    silent breakage).
-- 5. CREATE TABLE shop_products_rebuilt with the canonical schema
--    matching `lib/db/src/schema/golf.ts shopProductsTable`.
-- 6. INSERT INTO shop_products_rebuilt SELECT … FROM shop_products
--    so every row survives the rebuild with its existing id.
-- 7. DROP TABLE shop_products (no CASCADE; FKs are already gone).
--    The auto-owned `shop_products_id_seq` goes with it.
-- 8. RENAME shop_products_rebuilt → shop_products, the new sequence
--    `shop_products_rebuilt_id_seq` → `shop_products_id_seq`, and the
--    PK index → `shop_products_pkey`. Stable names matter so that any
--    code that hard-codes `nextval('shop_products_id_seq'::regclass)`
--    or grants on those objects keeps working.
-- 9. setval() the rebuilt sequence to MAX(id) so subsequent inserts
--    don't collide with preserved ids.
-- 10. Recreate `shop_products_org_idx` and the FK to organizations
--     (matching the names drizzle / 0000_initial.sql produce so we
--     don't drift from the schema source of truth).
-- 11. Recreate every captured incoming FK by name + definition.
--
-- IDEMPOTENCY / RE-RUN SAFETY
-- ---------------------------
-- The wrapping DO block exits early when relnatts is at or below the
-- threshold, so on a healthy DB (or after a successful first run, or
-- on a fresh DB where 0000_initial.sql just minted the table) this
-- migration is a no-op. It also returns cleanly when shop_products
-- doesn't exist yet (psql replays the migration list against
-- `migration_coverage_*` throw-away DBs that build the schema from
-- scratch — the table is not there until 0000_initial.sql runs first,
-- which is fine because the file numbering already orders us after
-- 0000). The whole rebuild runs inside the implicit DO transaction so
-- a mid-rebuild failure rolls back to the corrupted-but-intact state
-- instead of leaving a half-rebuilt table behind. Survives ON_ERROR_STOP=1.
--
-- See `replit.md → Operational Runbooks → shop_products column-slot
-- exhaustion` for the operator-facing notes.

DO $$
DECLARE
  SLOT_REBUILD_THRESHOLD CONSTANT smallint := 200;
  v_relnatts smallint;
  v_max_id   bigint;
  v_fk       record;
BEGIN
  SELECT c.relnatts
    INTO v_relnatts
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'shop_products'
     AND c.relkind = 'r';

  IF v_relnatts IS NULL THEN
    RAISE NOTICE
      'shop_products table not present yet; nothing to rebuild.';
    RETURN;
  END IF;

  IF v_relnatts <= SLOT_REBUILD_THRESHOLD THEN
    RAISE NOTICE
      'shop_products has only % attribute slot(s); rebuild not needed (threshold=%).',
      v_relnatts, SLOT_REBUILD_THRESHOLD;
    RETURN;
  END IF;

  RAISE NOTICE
    'shop_products column-slot exhaustion detected (relnatts=%, threshold=%); rebuilding.',
    v_relnatts, SLOT_REBUILD_THRESHOLD;

  -- Snapshot incoming FKs so we can rebuild them verbatim.
  CREATE TEMP TABLE _shop_products_incoming_fks ON COMMIT DROP AS
  SELECT
    nsp.nspname              AS schema_name,
    cls.relname              AS table_name,
    con.conname              AS constraint_name,
    pg_get_constraintdef(con.oid) AS constraint_def
  FROM pg_constraint con
  JOIN pg_class cls   ON cls.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
  WHERE con.contype  = 'f'
    AND con.confrelid = 'public.shop_products'::regclass;

  -- Preserve sequence high-water mark.
  SELECT COALESCE(MAX(id), 0) INTO v_max_id FROM public.shop_products;

  -- Drop incoming FK constraints so the subsequent DROP TABLE doesn't
  -- need CASCADE.
  FOR v_fk IN SELECT * FROM _shop_products_incoming_fks LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I',
      v_fk.schema_name, v_fk.table_name, v_fk.constraint_name
    );
  END LOOP;

  -- Build the rebuilt table with the canonical schema (matches
  -- lib/db/src/schema/golf.ts shopProductsTable). Using `serial`
  -- mints a fresh sequence (`shop_products_rebuilt_id_seq`) we'll
  -- rename below.
  CREATE TABLE public.shop_products_rebuilt (
    id                   serial PRIMARY KEY,
    organization_id      integer NOT NULL,
    size_variant_map     jsonb,
    name                 text NOT NULL,
    description          text,
    image_url            text,
    category             text NOT NULL DEFAULT 'apparel',
    vendor_facility_type text,
    base_price           numeric(10,2) NOT NULL,
    markup_price         numeric(10,2) NOT NULL,
    currency             text NOT NULL DEFAULT 'INR',
    sizes                jsonb NOT NULL
                           DEFAULT '["XS", "S", "M", "L", "XL", "XXL"]'::jsonb,
    is_active            boolean NOT NULL DEFAULT true,
    stock_count          integer,
    hsn_code             text,
    gst_rate             numeric(4,2) DEFAULT 18,
    sale_price           numeric(10,2),
    sale_start           timestamp with time zone,
    sale_end             timestamp with time zone,
    tier_pricing         jsonb,
    created_at           timestamp with time zone NOT NULL DEFAULT now(),
    updated_at           timestamp with time zone NOT NULL DEFAULT now()
  );

  -- Copy every row, preserving ids.
  INSERT INTO public.shop_products_rebuilt (
    id, organization_id, size_variant_map, name, description, image_url,
    category, vendor_facility_type, base_price, markup_price, currency,
    sizes, is_active, stock_count, hsn_code, gst_rate, sale_price,
    sale_start, sale_end, tier_pricing, created_at, updated_at
  )
  SELECT
    id, organization_id, size_variant_map, name, description, image_url,
    category, vendor_facility_type, base_price, markup_price, currency,
    sizes, is_active, stock_count, hsn_code, gst_rate, sale_price,
    sale_start, sale_end, tier_pricing, created_at, updated_at
  FROM public.shop_products;

  -- Drop the corrupted table. Its auto-owned `shop_products_id_seq`
  -- goes with it (no CASCADE needed; FKs are already gone).
  DROP TABLE public.shop_products;

  -- Promote the rebuilt table + sequence + PK index to the canonical
  -- names so anything referencing them by string identifier
  -- (`nextval('shop_products_id_seq'::regclass)`, GRANTs, etc.)
  -- keeps working.
  ALTER TABLE public.shop_products_rebuilt
    RENAME TO shop_products;
  ALTER SEQUENCE public.shop_products_rebuilt_id_seq
    RENAME TO shop_products_id_seq;
  ALTER INDEX public.shop_products_rebuilt_pkey
    RENAME TO shop_products_pkey;

  -- Re-seed the sequence so future inserts skip past preserved ids.
  PERFORM setval(
    'public.shop_products_id_seq',
    GREATEST(v_max_id, 1),
    v_max_id > 0
  );

  -- Recreate the org index drizzle expects to find on this table.
  CREATE INDEX IF NOT EXISTS shop_products_org_idx
    ON public.shop_products (organization_id);

  -- Recreate the org FK with the canonical name drizzle / 0000 produce.
  ALTER TABLE public.shop_products
    ADD CONSTRAINT shop_products_organization_id_organizations_id_fk
    FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id)
    ON DELETE CASCADE;

  -- Recreate every incoming FK from the snapshot.
  FOR v_fk IN SELECT * FROM _shop_products_incoming_fks LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
      v_fk.schema_name, v_fk.table_name,
      v_fk.constraint_name, v_fk.constraint_def
    );
  END LOOP;

  RAISE NOTICE
    'shop_products rebuilt successfully (% row(s), sequence reset to %).',
    (SELECT COUNT(*) FROM public.shop_products), v_max_id;
END $$;
