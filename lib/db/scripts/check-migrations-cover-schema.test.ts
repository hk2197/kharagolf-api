#!/usr/bin/env -S tsx
/**
 * Focused unit test for the cosmetic-suppression / classification used
 * by `check-migrations-cover-schema.ts`. We do not stand up Postgres
 * here — the integration path (apply migrations + pushSchema diff) is
 * exercised end-to-end by `.github/workflows/db-migration-coverage.yml`
 * on every PR. This test pins the in-process classification so the
 * exit-code intent of the script can be reasoned about without a DB:
 *
 *   - additive DDL (CREATE TABLE / ADD COLUMN) → reported as drift
 *     (script would exit 1 → CI fails → author runs
 *     `pnpm --filter @workspace/db generate`).
 *   - destructive DDL drizzle would emit (DROP COLUMN, ALTER COLUMN
 *     TYPE) → also reported as drift, because either direction means
 *     the schema has diverged from what the migrations produce.
 *   - cosmetic re-formatting drizzle re-emits on every introspect
 *     (SET DEFAULT array/jsonb literals, FK-name truncation rename
 *     pairs) → suppressed, mirroring `sync-schema.ts` and
 *     `scripts/check-db-drift.sh` exactly so all four checks (sync,
 *     drift slow, drift fast, this guard) agree on what counts as
 *     real drift.
 *
 * Run with:
 *   pnpm --filter @workspace/db exec tsx ./scripts/check-migrations-cover-schema.test.ts
 */

import { isCosmetic, normaliseStatement } from "./check-migrations-cover-schema.ts";

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (!ok) {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- Cosmetic SET DEFAULT re-formatting (suppressed) --------------------
{
  const cases = [
    `ALTER TABLE "members" ALTER COLUMN "channels" SET DEFAULT ARRAY['email']::text[];`,
    `ALTER TABLE "tournaments" ALTER COLUMN "tags" SET DEFAULT '{}'::text[];`,
    `ALTER TABLE "config" ALTER COLUMN "settings" SET DEFAULT '{}'::jsonb;`,
    `ALTER TABLE "members" ALTER COLUMN "channels" SET DEFAULT ARRAY[]::text[];`,
  ];
  for (const s of cases) {
    check(`cosmetic SET DEFAULT suppressed: ${s.slice(0, 60)}…`, isCosmetic(s));
  }
}

// --- Substantive SET DEFAULT (NOT suppressed) ---------------------------
{
  const cases = [
    // Numeric default change — intentional, must surface.
    `ALTER TABLE "tournaments" ALTER COLUMN "max_players" SET DEFAULT 144;`,
    // Plain string default — intentional, must surface.
    `ALTER TABLE "members" ALTER COLUMN "status" SET DEFAULT 'active';`,
    // Boolean / timestamp — intentional, must surface.
    `ALTER TABLE "members" ALTER COLUMN "is_admin" SET DEFAULT false;`,
    `ALTER TABLE "events" ALTER COLUMN "starts_at" SET DEFAULT now();`,
  ];
  for (const s of cases) {
    check(
      `substantive SET DEFAULT NOT suppressed: ${s.slice(0, 60)}…`,
      !isCosmetic(s),
    );
  }
}

// --- Cosmetic DROP CONSTRAINT (Postgres-default suffixes / clipped) -----
{
  // `_fkey` and `_key` are Postgres-default suffixes that drizzle re-emits
  // under its canonical `_fk` / `_unique` naming; pure rename churn.
  const fkey = `ALTER TABLE "members" DROP CONSTRAINT "members_org_id_fkey";`;
  const ukey = `ALTER TABLE "members" DROP CONSTRAINT "members_email_key";`;
  check(`cosmetic DROP CONSTRAINT _fkey suppressed`, isCosmetic(fkey));
  check(`cosmetic DROP CONSTRAINT _key suppressed`, isCosmetic(ukey));

  // Constraint name that hit Postgres' 63-char limit — re-emitted with
  // a different truncation by every introspect; suppressed.
  const longName = "really_long_table_name_that_keeps_going_forever_member_id_fk";
  // Pad to ≥ 63 chars so the limit branch fires.
  const padded = longName.padEnd(63, "x");
  const clipped = `ALTER TABLE "x" DROP CONSTRAINT "${padded}";`;
  check(
    `cosmetic DROP CONSTRAINT clipped (≥63 char) suppressed`,
    isCosmetic(clipped),
    `name length=${padded.length}`,
  );
}

// --- Substantive DROP CONSTRAINT (NOT suppressed) -----------------------
{
  // Real intent changes regardless of name length: _check, _pkey, _pk,
  // _excl. The script must report these as drift so a CHECK / PK / EXCL
  // change without a numbered migration cannot slip through.
  const cases = [
    `ALTER TABLE "members" DROP CONSTRAINT "members_status_check";`,
    `ALTER TABLE "members" DROP CONSTRAINT "members_pkey";`,
    `ALTER TABLE "members" DROP CONSTRAINT "members_pk";`,
    `ALTER TABLE "rooms" DROP CONSTRAINT "rooms_overlap_excl";`,
    // Short `_fk` rename — real intent change (Task #570 cleaned up
    // every clipped one in 0059, so any short `_fk` reaching here is
    // a real schema diff).
    `ALTER TABLE "members" DROP CONSTRAINT "members_org_fk";`,
  ];
  for (const s of cases) {
    check(
      `substantive DROP CONSTRAINT NOT suppressed: ${s.slice(0, 60)}…`,
      !isCosmetic(s),
    );
  }
}

// --- Plain additive / destructive DDL (NOT suppressed) ------------------
{
  const cases = [
    // The exact shape Task #579 / #1199 cares about: a missing migration
    // for a brand-new table. Must surface as drift.
    `CREATE TABLE "club_marketing_site_images" ("id" serial PRIMARY KEY NOT NULL);`,
    `ALTER TABLE "members" ADD COLUMN "nickname" varchar(64);`,
    `CREATE INDEX "idx_members_email" ON "members" USING btree ("email");`,
    `CREATE TYPE "public"."loyalty_tier" AS ENUM('silver','gold');`,
    `ALTER TABLE "members" DROP COLUMN "legacy_field";`,
    `ALTER TABLE "members" ALTER COLUMN "name" TYPE varchar(128);`,
  ];
  for (const s of cases) {
    check(`substantive DDL NOT suppressed: ${s.slice(0, 60)}…`, !isCosmetic(s));
  }
}

// --- normaliseStatement: stable identity for baseline matching ---------
{
  const a = `CREATE TABLE "x" (\n  "id" serial PRIMARY KEY NOT NULL\n);`;
  const b = `CREATE TABLE "x" ( "id" serial PRIMARY KEY NOT NULL );`;
  check("normaliseStatement collapses whitespace", normaliseStatement(a) === normaliseStatement(b));
  check(
    "normaliseStatement trims and single-spaces",
    normaliseStatement("   foo   bar\n\tbaz  ") === "foo bar baz",
  );
  check(
    "normaliseStatement leaves quoted-identifier punctuation intact",
    normaliseStatement(`ALTER TABLE "x" ADD COLUMN "y" int;`) ===
      `ALTER TABLE "x" ADD COLUMN "y" int;`,
  );
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("✓ check-migrations-cover-schema cosmetic-classifier matches sync-schema parity rules.");
