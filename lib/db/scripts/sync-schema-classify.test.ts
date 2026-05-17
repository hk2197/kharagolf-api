#!/usr/bin/env -S tsx
/**
 * Focused unit test for the destructive-statement classifier in
 * `sync-schema.ts`.
 *
 * The classifier and its cosmetic-churn exceptions live in the
 * sibling `./sync-schema-classify.ts` module — both `sync-schema.ts`
 * and this test import the SAME exported symbols. Editing a pattern
 * in `sync-schema-classify.ts` without updating this test will fail
 * the cases below; there is no second copy to drift against. See
 * task #2062.
 *
 * (Importing `sync-schema.ts` directly would patch `process.stdin`,
 * pull in `drizzle-kit/api`, run the FK preflight, require
 * `DATABASE_URL`, and kick off `main()` against the live DB — none
 * of which the unit test wants. Sharing only the pure classifier
 * gives us a single source of truth without those side effects.)
 *
 * Run with: pnpm --filter @workspace/db exec tsx ./scripts/sync-schema-classify.test.ts
 */

import {
  classify,
  DESTRUCTIVE_PATTERNS,
  indexNameOf,
  isCosmeticDropConstraint,
  isCosmeticSetDefault,
  isExpressionOrPartialIndex,
  pairedDropCreateIndexNames,
  POSTGRES_DEFAULT_SUFFIXES,
  POSTGRES_IDENTIFIER_LIMIT,
  REAL_DROP_CONSTRAINT_SUFFIXES,
} from "./sync-schema-classify.ts";

const cases: Array<{ stmt: string; destructive: boolean }> = [
  // --- destructive ---------------------------------------------------------
  { stmt: 'DROP TABLE "old_table"', destructive: true },
  { stmt: 'drop table if exists "old_table"', destructive: true },
  { stmt: 'DROP SCHEMA "private" CASCADE', destructive: true },
  { stmt: 'DROP VIEW "v_users"', destructive: true },
  { stmt: 'DROP MATERIALIZED VIEW "mv_stats"', destructive: true },
  { stmt: 'ALTER TABLE "members" DROP COLUMN "old_col"', destructive: true },
  { stmt: 'ALTER TABLE "members" RENAME TO "people"', destructive: true },
  {
    stmt: 'ALTER TABLE "members" RENAME COLUMN "x" TO "y"',
    destructive: true,
  },
  // CHECK / PRIMARY KEY / EXCLUSION constraint drops remain destructive.
  {
    stmt: 'ALTER TABLE "scores" DROP CONSTRAINT "scores_value_positive_check"',
    destructive: true,
  },
  {
    stmt: 'ALTER TABLE "scores" DROP CONSTRAINT "scores_pkey"',
    destructive: true,
  },
  {
    stmt: 'ALTER TABLE "rooms" DROP CONSTRAINT "rooms_no_overlap_excl"',
    destructive: true,
  },
  { stmt: "TRUNCATE TABLE members", destructive: true },
  { stmt: "  truncate  members", destructive: true },
  // --- additive ------------------------------------------------------------
  { stmt: 'CREATE TABLE "members" ("id" serial PRIMARY KEY)', destructive: false },
  {
    stmt: 'ALTER TABLE "members" ADD COLUMN "nickname" varchar(64)',
    destructive: false,
  },
  {
    stmt: 'CREATE INDEX "members_email_idx" ON "members" ("email")',
    destructive: false,
  },
  {
    stmt: 'ALTER TABLE "members" ADD CONSTRAINT "members_email_unique" UNIQUE ("email")',
    destructive: false,
  },
  // Cosmetic FK / UNIQUE rename churn — drizzle re-emits these under
  // canonical names; the DROP is paired with an ADD in the same diff.
  {
    stmt: 'ALTER TABLE "teaching_pros" DROP CONSTRAINT "teaching_pros_organization_id_fkey"',
    destructive: false,
  },
  {
    stmt: 'ALTER TABLE "tee_pricing_rules" DROP CONSTRAINT "tee_pricing_rules_organization_id_key"',
    destructive: false,
  },
  // Short `_fk` / `_unique` names without a Postgres-default suffix
  // and without truncation are real intent changes (the schema removed
  // the constraint). They surface as destructive so the data-loss gate
  // catches accidental removals; explicit migrations in
  // `lib/db/drizzle/` are the supported path.
  {
    stmt: 'ALTER TABLE "course_reviews" DROP CONSTRAINT "course_reviews_org_fk"',
    destructive: true,
  },
  {
    stmt: 'ALTER TABLE "members" DROP CONSTRAINT "members_email_unique"',
    destructive: true,
  },
  // Truncated drizzle FK names (Postgres clips at 63 chars).
  {
    stmt: 'ALTER TABLE "delivery_receipt_lines" DROP CONSTRAINT "delivery_receipt_lines_purchase_order_line_id_purchase_order_li"',
    destructive: false,
  },
  {
    stmt: 'ALTER TABLE "store_credit_transactions" DROP CONSTRAINT "store_credit_transactions_account_id_store_credit_accounts_id_f"',
    destructive: false,
  },
  // Safe statements that mention the keywords inside identifiers/strings.
  {
    stmt: 'CREATE TABLE "drop_log" ("id" serial PRIMARY KEY)',
    destructive: false,
  },
  {
    stmt: 'COMMENT ON TABLE "members" IS \'rename to people next quarter\'',
    destructive: true, // Conservative: regex catches "rename to" inside comment.
  },
];

let failed = 0;
for (const { stmt, destructive: expected } of cases) {
  const { destructive } = classify([stmt]);
  const actual = destructive.length === 1;
  if (actual !== expected) {
    failed += 1;
    console.error(
      `FAIL: expected destructive=${expected} for: ${stmt} (got ${actual})`,
    );
  }
}

// --- Sanity-check the imported regex set itself --------------------------
//
// The cases above exercise `classify(...)` end-to-end, which is the
// real contract. Pin the imported pattern set explicitly too so a
// regression that *removes* one of the destructive patterns from the
// shared module fails here even before any cases run — i.e. the test
// catches "someone deleted the DROP COLUMN regex" not just "someone
// broke the DROP COLUMN behaviour".
const REQUIRED_DESTRUCTIVE_KEYWORDS = [
  "DROP\\s+TABLE",
  "DROP\\s+SCHEMA",
  "DROP\\s+VIEW",
  "DROP\\s+MATERIALIZED\\s+VIEW",
  "DROP\\s+COLUMN",
  "RENAME\\s+TO",
  "RENAME\\s+COLUMN",
  "DROP\\s+CONSTRAINT",
  "TRUNCATE",
];
for (const keyword of REQUIRED_DESTRUCTIVE_KEYWORDS) {
  const present = DESTRUCTIVE_PATTERNS.some((p) => p.source.includes(keyword));
  if (!present) {
    failed += 1;
    console.error(
      `FAIL: DESTRUCTIVE_PATTERNS is missing a regex matching ${keyword}`,
    );
  }
}

if (POSTGRES_IDENTIFIER_LIMIT !== 63) {
  failed += 1;
  console.error(
    `FAIL: POSTGRES_IDENTIFIER_LIMIT must be 63, got ${POSTGRES_IDENTIFIER_LIMIT}`,
  );
}

// REAL_DROP_CONSTRAINT_SUFFIXES must keep CHECK / PRIMARY KEY / EXCLUSION
// drops on the destructive list regardless of name length.
for (const suffix of ["check", "pkey", "pk", "excl"]) {
  const sample = `ALTER TABLE "t" DROP CONSTRAINT "t_x_${suffix}"`;
  if (!REAL_DROP_CONSTRAINT_SUFFIXES.test(sample)) {
    failed += 1;
    console.error(
      `FAIL: REAL_DROP_CONSTRAINT_SUFFIXES must match _${suffix} drops`,
    );
  }
  if (isCosmeticDropConstraint(sample)) {
    failed += 1;
    console.error(`FAIL: ${sample} must NOT be classified cosmetic`);
  }
}

// POSTGRES_DEFAULT_SUFFIXES (`_fkey`, `_key`) must always classify as
// cosmetic so drizzle's per-introspect rename churn does not block.
for (const suffix of ["fkey", "key"]) {
  const sample = `ALTER TABLE "t" DROP CONSTRAINT "t_org_id_${suffix}"`;
  if (!POSTGRES_DEFAULT_SUFFIXES.test(sample)) {
    failed += 1;
    console.error(
      `FAIL: POSTGRES_DEFAULT_SUFFIXES must match _${suffix} drops`,
    );
  }
  if (!isCosmeticDropConstraint(sample)) {
    failed += 1;
    console.error(`FAIL: ${sample} must be classified cosmetic`);
  }
}

// `isCosmeticSetDefault` must accept the known re-formatting shapes and
// reject plain literals — pin the contract directly so weakening
// `COSMETIC_SET_DEFAULT` (e.g. dropping the jsonb branch) is caught.
const cosmeticSetDefaultSamples = [
  'ALTER TABLE "x" ALTER COLUMN "c" SET DEFAULT ARRAY[]::text[]',
  'ALTER TABLE "x" ALTER COLUMN "c" SET DEFAULT ARRAY[\'a\']::text[]',
  'ALTER TABLE "x" ALTER COLUMN "c" SET DEFAULT \'{}\'::text[]',
  'ALTER TABLE "x" ALTER COLUMN "c" SET DEFAULT \'{"k":1}\'::jsonb',
];
for (const sample of cosmeticSetDefaultSamples) {
  if (!isCosmeticSetDefault(sample)) {
    failed += 1;
    console.error(`FAIL: isCosmeticSetDefault should accept ${sample}`);
  }
}
const realSetDefaultSamples = [
  'ALTER TABLE "x" ALTER COLUMN "c" SET DEFAULT 0',
  'ALTER TABLE "x" ALTER COLUMN "c" SET DEFAULT \'hello\'',
  'ALTER TABLE "x" ALTER COLUMN "c" SET DEFAULT now()',
];
for (const sample of realSetDefaultSamples) {
  if (isCosmeticSetDefault(sample)) {
    failed += 1;
    console.error(`FAIL: isCosmeticSetDefault should reject ${sample}`);
  }
}

// Mixed batch.
const batch = classify([
  'CREATE TABLE "x" ("id" serial PRIMARY KEY)',
  'DROP TABLE "y"',
  'ALTER TABLE "x" ADD COLUMN "n" int',
  'ALTER TABLE "x" RENAME TO "z"',
]);
if (batch.destructive.length !== 2 || batch.additive.length !== 2) {
  failed += 1;
  console.error(
    `FAIL: mixed batch — expected 2/2, got destructive=${batch.destructive.length}, additive=${batch.additive.length}`,
  );
}

// Paired ADD+DROP CONSTRAINT for the same constraint name = drizzle
// introspection round-trip churn (e.g. UNIQUE NULLS NOT DISTINCT on
// `email_cta_send_stats_key_org_unique`). Both statements must classify
// as cosmetic so the destructive-data-loss gate doesn't block the merge.
const pairedConstraintChurn = [
  'ALTER TABLE "email_cta_send_stats" ADD CONSTRAINT "email_cta_send_stats_key_org_unique" UNIQUE NULLS NOT DISTINCT("notification_key","organization_id")',
  'ALTER TABLE "email_cta_send_stats" DROP CONSTRAINT "email_cta_send_stats_key_org_unique"',
];
const pairedBatch = classify(pairedConstraintChurn);
if (
  pairedBatch.cosmetic.length !== pairedConstraintChurn.length ||
  pairedBatch.additive.length !== 0 ||
  pairedBatch.destructive.length !== 0
) {
  failed += 1;
  console.error(
    `FAIL: paired ADD+DROP CONSTRAINT churn — expected ${pairedConstraintChurn.length}/0/0, ` +
      `got cosmetic=${pairedBatch.cosmetic.length}, ` +
      `additive=${pairedBatch.additive.length}, ` +
      `destructive=${pairedBatch.destructive.length}`,
  );
}

// An UNPAIRED DROP CONSTRAINT (no matching ADD in the same diff) for a
// short non-Postgres-default-suffix name must STILL classify as
// destructive — paired-detection should not weaken the existing gate.
const unpairedDrop = [
  'ALTER TABLE "members" DROP CONSTRAINT "members_email_unique"',
];
const unpairedBatch = classify(unpairedDrop);
if (
  unpairedBatch.destructive.length !== 1 ||
  unpairedBatch.cosmetic.length !== 0
) {
  failed += 1;
  console.error(
    `FAIL: unpaired short DROP CONSTRAINT must remain destructive — ` +
      `got cosmetic=${unpairedBatch.cosmetic.length}, ` +
      `destructive=${unpairedBatch.destructive.length}`,
  );
}

// A REAL constraint redefinition where the names differ (not paired) must
// still let the DROP fall through to its existing classification. ADD of
// the new name is additive; DROP of the old short name is destructive.
const renamed = [
  'ALTER TABLE "members" ADD CONSTRAINT "members_email_unique_new" UNIQUE ("email")',
  'ALTER TABLE "members" DROP CONSTRAINT "members_email_unique_old"',
];
const renamedBatch = classify(renamed);
if (
  renamedBatch.additive.length !== 1 ||
  renamedBatch.destructive.length !== 1 ||
  renamedBatch.cosmetic.length !== 0
) {
  failed += 1;
  console.error(
    `FAIL: differently-named ADD/DROP must not be treated as paired churn — ` +
      `got additive=${renamedBatch.additive.length}, ` +
      `destructive=${renamedBatch.destructive.length}, ` +
      `cosmetic=${renamedBatch.cosmetic.length}`,
  );
}

// Same constraint name on two DIFFERENT tables must NOT pair. Constraint
// names are per-table in Postgres, so an unrelated ADD on table A and a
// real DROP on table B share a name only by coincidence — the DROP must
// remain destructive (its short non-Postgres-default suffix would
// already classify it destructive). Pairing by name alone would silently
// mask this.
const crossTable = [
  'ALTER TABLE "table_a" ADD CONSTRAINT "shared_unique" UNIQUE ("col")',
  'ALTER TABLE "table_b" DROP CONSTRAINT "shared_unique"',
];
const crossTableBatch = classify(crossTable);
if (
  crossTableBatch.additive.length !== 1 ||
  crossTableBatch.destructive.length !== 1 ||
  crossTableBatch.cosmetic.length !== 0
) {
  failed += 1;
  console.error(
    `FAIL: same constraint name on different tables must NOT pair — ` +
      `got additive=${crossTableBatch.additive.length}, ` +
      `destructive=${crossTableBatch.destructive.length}, ` +
      `cosmetic=${crossTableBatch.cosmetic.length}`,
  );
}

// Multiplicity edge case: two DROPs (e.g., table A and table B drop the
// same-named constraint) plus one ADD on table A. The (table_a, X) pair
// is cosmetic; the (table_b, X) DROP has no matching ADD and must
// remain destructive.
const mixedMultiplicity = [
  'ALTER TABLE "table_a" ADD CONSTRAINT "shared_unique" UNIQUE ("col")',
  'ALTER TABLE "table_a" DROP CONSTRAINT "shared_unique"',
  'ALTER TABLE "table_b" DROP CONSTRAINT "shared_unique"',
];
const mixedBatch = classify(mixedMultiplicity);
if (
  mixedBatch.cosmetic.length !== 2 ||
  mixedBatch.destructive.length !== 1 ||
  mixedBatch.additive.length !== 0
) {
  failed += 1;
  console.error(
    `FAIL: per-(table,name) pairing must not absorb unrelated DROPs — ` +
      `got cosmetic=${mixedBatch.cosmetic.length}, ` +
      `destructive=${mixedBatch.destructive.length}, ` +
      `additive=${mixedBatch.additive.length}`,
  );
}

// Cosmetic SET DEFAULT churn (Task #570): drizzle re-formats Postgres-
// stored defaults on every introspect; these must classify as cosmetic
// (skipped, not applied) so DRY_RUN can report a true no-op.
const cosmeticDefaults = [
  'ALTER TABLE "invitations" ALTER COLUMN "channels" SET DEFAULT ARRAY[]::text[]',
  'ALTER TABLE "marketing_campaigns" ALTER COLUMN "channels" SET DEFAULT ARRAY[\'email\']::text[]',
  'ALTER TABLE "webhook_endpoints" ALTER COLUMN "subscribed_events" SET DEFAULT \'{}\'::text[]',
  'ALTER TABLE "club_marketing_sites" ALTER COLUMN "enabled_sections" SET DEFAULT \'{"hero":true}\'::jsonb',
];
const cosmeticBatch = classify(cosmeticDefaults);
if (
  cosmeticBatch.cosmetic.length !== cosmeticDefaults.length ||
  cosmeticBatch.additive.length !== 0 ||
  cosmeticBatch.destructive.length !== 0
) {
  failed += 1;
  console.error(
    `FAIL: cosmetic SET DEFAULT batch — expected ${cosmeticDefaults.length}/0/0, ` +
      `got cosmetic=${cosmeticBatch.cosmetic.length}, ` +
      `additive=${cosmeticBatch.additive.length}, ` +
      `destructive=${cosmeticBatch.destructive.length}`,
  );
}

// Real SET DEFAULT changes (numbers / strings / enums / timestamps)
// must NOT be classified as cosmetic — those are intent changes that
// the operator should see in the diff.
const realDefaults = [
  'ALTER TABLE "x" ALTER COLUMN "n" SET DEFAULT 42',
  'ALTER TABLE "x" ALTER COLUMN "s" SET DEFAULT \'hello\'',
  'ALTER TABLE "x" ALTER COLUMN "e" SET DEFAULT \'pending\'::status_enum',
  'ALTER TABLE "x" ALTER COLUMN "t" SET DEFAULT now()',
];
const realBatch = classify(realDefaults);
if (
  realBatch.cosmetic.length !== 0 ||
  realBatch.additive.length !== realDefaults.length
) {
  failed += 1;
  console.error(
    `FAIL: real SET DEFAULT batch — expected 0/${realDefaults.length}/0, ` +
      `got cosmetic=${realBatch.cosmetic.length}, ` +
      `additive=${realBatch.additive.length}, ` +
      `destructive=${realBatch.destructive.length}`,
  );
}

// Paired DROP INDEX + CREATE INDEX for the same index name = drizzle
// introspection round-trip churn for partial / expression indexes whose
// definition Postgres canonicalises with explicit casts (e.g. the
// `analytics_events_notif_open_msg_idx` index whose `payload->>'messageId'`
// expression Postgres stores as `(payload ->> 'messageId'::text)`). Both
// statements must classify as cosmetic so the post-merge log doesn't
// re-print the pair on every cold-container introspect.
const pairedIndexChurn = [
  'DROP INDEX "analytics_events_notif_open_msg_idx";',
  'CREATE INDEX "analytics_events_notif_open_msg_idx" ON "analytics_events" USING btree ("user_id",("payload"->>\'messageId\')) WHERE "analytics_events"."event_name" = \'notification_opened\';',
];
const pairedIndexBatch = classify(pairedIndexChurn);
if (
  pairedIndexBatch.cosmetic.length !== pairedIndexChurn.length ||
  pairedIndexBatch.additive.length !== 0 ||
  pairedIndexBatch.destructive.length !== 0
) {
  failed += 1;
  console.error(
    `FAIL: paired DROP+CREATE INDEX churn — expected ${pairedIndexChurn.length}/0/0, ` +
      `got cosmetic=${pairedIndexBatch.cosmetic.length}, ` +
      `additive=${pairedIndexBatch.additive.length}, ` +
      `destructive=${pairedIndexBatch.destructive.length}`,
  );
}

// Same flow with the IF EXISTS / IF NOT EXISTS / UNIQUE / CONCURRENTLY
// optional keywords drizzle's introspector also emits — pin each
// surface form so a future drizzle-kit upgrade that adds (or removes)
// one of these doesn't silently leak past the cosmetic gate. All four
// variants use either a `WHERE` clause (partial) or a `(expr)` column
// (expression), because the suppression now (correctly) only fires for
// those shapes — see the rationale block above
// `pairedDropCreateIndexNames` in sync-schema-classify.ts.
const pairedIndexVariants = [
  // Partial — `WHERE` clause.
  [
    'DROP INDEX "x_idx"',
    'CREATE INDEX "x_idx" ON "x" ("a") WHERE "x"."a" IS NOT NULL',
  ],
  // Expression column. Drizzle's introspect output always wraps
  // expressions in an extra paren: `((lower("a")))`, so the column
  // list opens with `(` then immediately the expression's own `(`.
  [
    'DROP INDEX IF EXISTS "x_idx"',
    'CREATE INDEX IF NOT EXISTS "x_idx" ON "x" ((lower("a")))',
  ],
  // Schema-qualified DROP + UNIQUE partial CREATE.
  [
    'DROP INDEX "public"."x_idx"',
    'CREATE UNIQUE INDEX "x_idx" ON "x" ("a") WHERE "x"."a" > 0',
  ],
  // CONCURRENTLY + expression column with JSON arrow operator (the
  // exact analytics_events_notif_open_msg_idx case).
  [
    'DROP INDEX CONCURRENTLY "x_idx"',
    'CREATE INDEX CONCURRENTLY "x_idx" ON "x" ("a", ("payload"->>\'k\'))',
  ],
];
for (const [drop, create] of pairedIndexVariants) {
  const batch = classify([drop, create]);
  if (batch.cosmetic.length !== 2 || batch.additive.length !== 0) {
    failed += 1;
    console.error(
      `FAIL: paired expression/partial index variant not classified cosmetic — ` +
        `drop=${drop}, create=${create} ` +
        `(cosmetic=${batch.cosmetic.length}, additive=${batch.additive.length})`,
    );
  }
}

// An UNPAIRED CREATE INDEX (a real new index) must remain additive —
// pair-detection should not weaken the existing classification.
const unpairedCreate = classify([
  'CREATE INDEX "brand_new_idx" ON "members" ("email")',
]);
if (
  unpairedCreate.additive.length !== 1 ||
  unpairedCreate.cosmetic.length !== 0
) {
  failed += 1;
  console.error(
    `FAIL: unpaired CREATE INDEX must remain additive — ` +
      `got cosmetic=${unpairedCreate.cosmetic.length}, ` +
      `additive=${unpairedCreate.additive.length}`,
  );
}

// Two indexes with different names must not pair via the index-name
// suppression path.
const renamedIndexes = classify([
  'DROP INDEX "old_name_idx"',
  'CREATE INDEX "new_name_idx" ON "x" ("a")',
]);
if (
  renamedIndexes.cosmetic.length !== 0 ||
  renamedIndexes.additive.length !== 2
) {
  failed += 1;
  console.error(
    `FAIL: differently-named DROP/CREATE INDEX must NOT be classified cosmetic — ` +
      `got cosmetic=${renamedIndexes.cosmetic.length}, ` +
      `additive=${renamedIndexes.additive.length}`,
  );
}

// Same-name DROP + CREATE for a PLAIN-COLUMN index (no WHERE, no
// expression column) must NOT be classified cosmetic — that's a real
// intent change (someone changed the columns / uniqueness / storage
// method) which the author should have written as a numbered
// migration. This is the architect's "narrow the heuristic" guard.
const sameNamePlainColumnRedefine = classify([
  'DROP INDEX "members_email_idx"',
  'CREATE UNIQUE INDEX "members_email_idx" ON "members" ("email", "tenant_id")',
]);
// The critical assertion is that NEITHER statement gets classified
// cosmetic — leaving them visible to the operator (additive on the
// CREATE, and either additive or destructive on the DROP, depending
// on whether DROP INDEX is in DESTRUCTIVE_PATTERNS in the future) is
// what keeps a real intent change from being silently auto-applied.
if (sameNamePlainColumnRedefine.cosmetic.length !== 0) {
  failed += 1;
  console.error(
    `FAIL: same-name DROP+CREATE for a PLAIN-COLUMN index must NOT be ` +
      `classified cosmetic (real intent change) — ` +
      `got cosmetic=${sameNamePlainColumnRedefine.cosmetic.length}, ` +
      `additive=${sameNamePlainColumnRedefine.additive.length}, ` +
      `destructive=${sameNamePlainColumnRedefine.destructive.length}`,
  );
}

// indexNameOf must extract the same name from both surface forms so
// pair-detection actually pairs them. Pin a couple of surface forms.
const indexNameSamples: Array<[string, string | null]> = [
  ['DROP INDEX "abc_idx"', "abc_idx"],
  ['DROP INDEX IF EXISTS "abc_idx"', "abc_idx"],
  ['DROP INDEX "public"."abc_idx"', "abc_idx"],
  ['CREATE INDEX "abc_idx" ON "t" ("a")', "abc_idx"],
  ['CREATE UNIQUE INDEX IF NOT EXISTS "abc_idx" ON "t" ("a")', "abc_idx"],
  ['CREATE INDEX CONCURRENTLY "abc_idx" ON "t" ("a")', "abc_idx"],
  ['ALTER TABLE "t" ADD CONSTRAINT "x_pk" PRIMARY KEY ("id")', null],
];
for (const [stmt, expected] of indexNameSamples) {
  const got = indexNameOf(stmt);
  if (got !== expected) {
    failed += 1;
    console.error(
      `FAIL: indexNameOf(${JSON.stringify(stmt)}) — expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
    );
  }
}

// pairedDropCreateIndexNames: two unrelated indexes (one DROP, one
// CREATE with a different name) must not pair.
const noPair = pairedDropCreateIndexNames([
  'DROP INDEX "a_idx"',
  'CREATE INDEX "b_idx" ON "t" ("c") WHERE "t"."c" IS NOT NULL',
]);
if (noPair.size !== 0) {
  failed += 1;
  console.error(
    `FAIL: pairedDropCreateIndexNames falsely paired unrelated names: ${JSON.stringify([...noPair])}`,
  );
}

// isExpressionOrPartialIndex: pin the surface forms so the suppression
// stays scoped to ONLY the index shapes Postgres canonicalises
// differently. Plain-column indexes (any number of columns, UNIQUE or
// not) must return false.
const indexShapeSamples: Array<[string, boolean]> = [
  // partial — WHERE clause
  [
    'CREATE INDEX "i" ON "t" USING btree ("a") WHERE "t"."a" IS NOT NULL',
    true,
  ],
  // expression column at start
  ['CREATE INDEX "i" ON "t" USING btree ((lower("a")))', true],
  // expression column not first
  [
    `CREATE INDEX "i" ON "t" USING btree ("a", ("payload"->>'k'))`,
    true,
  ],
  // unique partial
  [
    'CREATE UNIQUE INDEX "i" ON "t" USING btree ("a") WHERE "t"."b" > 0',
    true,
  ],
  // plain single column
  ['CREATE INDEX "i" ON "t" USING btree ("a")', false],
  // plain multi-column
  ['CREATE INDEX "i" ON "t" USING btree ("a", "b", "c")', false],
  // unique plain
  ['CREATE UNIQUE INDEX "i" ON "t" USING btree ("a")', false],
];
for (const [stmt, expected] of indexShapeSamples) {
  const got = isExpressionOrPartialIndex(stmt);
  if (got !== expected) {
    failed += 1;
    console.error(
      `FAIL: isExpressionOrPartialIndex(${JSON.stringify(stmt)}) — ` +
        `expected ${expected}, got ${got}`,
    );
  }
}

if (failed > 0) {
  console.error(`\nclassify: ${failed} case(s) failed`);
  process.exit(1);
}
console.log("OK: destructive-statement classifier behaves as specified.");
