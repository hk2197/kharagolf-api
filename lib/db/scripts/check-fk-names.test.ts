#!/usr/bin/env -S tsx
/**
 * Focused unit test for `findOversizedAutoFkNames` in `check-fk-names.ts`.
 *
 * Builds a synthetic in-memory drizzle schema with three foreign keys:
 *   1. A short `.references(...)` FK that fits well under 63 chars.
 *   2. A long `.references(...)` FK whose auto-generated name would
 *      exceed 63 chars (the bug class from tasks #570, #640, #805).
 *   3. A long `foreignKey({ name: "..." })` FK that already carries an
 *      explicit short name — must NOT be flagged.
 *
 * The check must flag exactly case (2). Case (3) demonstrates the
 * supported schema-level fix.
 *
 * Run with: pnpm --filter @workspace/db exec tsx ./scripts/check-fk-names.test.ts
 */

import {
  pgTable,
  serial,
  integer,
  foreignKey,
} from "drizzle-orm/pg-core";

import {
  findOversizedAutoFkNames,
  POSTGRES_IDENTIFIER_LIMIT,
} from "./check-fk-names.ts";

// --- 1. Reference target with a long name. ---------------------------------
// 50-char table name + `_id` PK column → any FK pointing at this table
// from another long-named table guarantees an over-limit auto name.
const longRefTable = pgTable(
  "this_is_a_deliberately_long_reference_table_name_x",
  {
    id: serial("id").primaryKey(),
  },
);

// A small reference target for the short-FK case below.
const shortRefTable = pgTable("short_ref", {
  id: serial("id").primaryKey(),
});

// --- 2. Short FK case (passes). --------------------------------------------
const shortTable = pgTable("short_t", {
  id: serial("id").primaryKey(),
  refId: integer("ref_id").references(() => shortRefTable.id),
});

// --- 3. Long FK without an explicit name (must FAIL the check). -----------
// table name (44) + col (8) + reftable (50) + refcol (2) + 4 underscores +
// "_fk" = far over 63.
const longAutoTable = pgTable(
  "another_quite_long_table_name_for_test_caseA",
  {
    id: serial("id").primaryKey(),
    refLong: integer("ref_long").references(() => longRefTable.id),
  },
);

// --- 4. Long FK WITH an explicit short name (must PASS the check). --------
const longExplicitTable = pgTable(
  "another_quite_long_table_name_for_test_caseB",
  {
    id: serial("id").primaryKey(),
    refLong: integer("ref_long").notNull(),
  },
  (t) => [
    foreignKey({
      name: "long_explicit_ref_fk",
      columns: [t.refLong],
      foreignColumns: [longRefTable.id],
    }),
  ],
);

const synthetic: Record<string, unknown> = {
  longRefTable,
  shortTable,
  longAutoTable,
  longExplicitTable,
};

let failed = 0;
const violations = findOversizedAutoFkNames(synthetic);

if (violations.length !== 1) {
  failed += 1;
  console.error(
    `FAIL: expected exactly 1 over-limit FK, got ${violations.length}: ` +
      JSON.stringify(violations.map((v) => v.autoName)),
  );
} else {
  const v = violations[0];
  if (v.table !== "another_quite_long_table_name_for_test_caseA") {
    failed += 1;
    console.error(`FAIL: wrong offending table: ${v.table}`);
  }
  if (v.length <= POSTGRES_IDENTIFIER_LIMIT) {
    failed += 1;
    console.error(
      `FAIL: violation length ${v.length} should exceed ${POSTGRES_IDENTIFIER_LIMIT}`,
    );
  }
  if (!v.autoName.endsWith("_fk")) {
    failed += 1;
    console.error(`FAIL: auto-name should end with _fk: ${v.autoName}`);
  }
  if (!v.autoName.startsWith(v.table + "_")) {
    failed += 1;
    console.error(
      `FAIL: auto-name should start with table name: ${v.autoName}`,
    );
  }
}

// Sanity check: a schema with only short / explicitly-named FKs is clean.
const cleanOnly = findOversizedAutoFkNames({
  longRefTable,
  shortTable,
  longExplicitTable,
});
if (cleanOnly.length !== 0) {
  failed += 1;
  console.error(
    `FAIL: clean-only schema produced ${cleanOnly.length} violation(s): ` +
      JSON.stringify(cleanOnly.map((v) => v.autoName)),
  );
}

if (failed > 0) {
  console.error(`\ncheck-fk-names: ${failed} case(s) failed`);
  process.exit(1);
}
console.log("OK: findOversizedAutoFkNames flags long auto-names only.");
