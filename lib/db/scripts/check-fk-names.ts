#!/usr/bin/env -S tsx
/**
 * Lint-style check that fails when any foreign key in the Drizzle schema
 * would be assigned an auto-generated constraint name longer than
 * Postgres's 63-character identifier limit.
 *
 * Background — Tasks #570, #640
 * -----------------------------
 * Drizzle's default FK name is
 *   `<table>_<col>_<reftable>_<refcol>_fk`
 * Postgres silently truncates any identifier past 63 chars on CREATE,
 * so a long auto-name lands in the live DB under a different (clipped)
 * name than the one drizzle re-emits on every introspect. Each
 * subsequent `drizzle-kit push` then sees a phantom diff
 *   DROP CONSTRAINT "<truncated>"; ADD CONSTRAINT "<canonical>";
 * and the destructive-statement gate (see `sync-schema.ts`) refuses to
 * apply it. The fix at the schema level is to give the FK an explicit
 * short name, e.g.
 *   foreignKey({
 *     name: "<table>_<col>_fk",
 *     columns: [t.colId],
 *     foreignColumns: [otherTable.id],
 *   })
 *
 * What this script does
 * ---------------------
 *   1. Walks every PgTable exported from `lib/db/src/schema/index.ts`.
 *   2. Collects each table's foreign keys via `getTableConfig`.
 *   3. For any FK that does NOT carry an explicit `name` in its
 *      reference config, computes the auto-name drizzle would generate
 *      (`<table>_<col>...<reftable>_<refcol>..._fk`) and flags it when
 *      its length exceeds `POSTGRES_IDENTIFIER_LIMIT`.
 *
 * The check ignores FKs that already pass an explicit `name`: those are
 * exactly the schema-level fix the task asks for, and they keep
 * working unchanged once Postgres accepts the shorter name verbatim.
 *
 * Usage
 * -----
 *   pnpm --filter @workspace/db exec tsx ./scripts/check-fk-names.ts
 *
 * Exit codes:
 *   0  — every FK auto-name fits in 63 chars (or has an explicit name).
 *   1  — at least one FK would generate an over-limit auto-name.
 *
 * Wired into:
 *   - `lib/db/scripts/sync-schema.ts` runs this as a preflight so a new
 *     long-named FK fails the post-merge BEFORE drizzle truncates it
 *     into the live DB.
 *   - `lib/db/scripts/check-fk-names.test.ts` exercises the underlying
 *     pure function against synthetic schemas.
 */

import { getTableConfig } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

export const POSTGRES_IDENTIFIER_LIMIT = 63;

export interface OversizedFkViolation {
  table: string;
  autoName: string;
  length: number;
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
}

/**
 * Compute the constraint name drizzle would auto-generate for an FK
 * (mirrors `ForeignKey.getName()` in
 * `drizzle-orm/pg-core/foreign-keys.js`).
 */
function autoFkName(
  tableName: string,
  columns: string[],
  foreignTableName: string,
  foreignColumns: string[],
): string {
  return [
    tableName,
    ...columns,
    foreignTableName,
    ...foreignColumns,
  ].join("_") + "_fk";
}

/**
 * Walk every PgTable in `schema` and return any FK whose default
 * (auto-generated) constraint name would exceed Postgres's identifier
 * limit. FKs that carry an explicit `name` are skipped — they ARE the
 * supported schema-level fix.
 */
export function findOversizedAutoFkNames(
  schema: Record<string, unknown>,
): OversizedFkViolation[] {
  const violations: OversizedFkViolation[] = [];
  const seen = new Set<PgTable>();

  for (const exported of Object.values(schema)) {
    if (!is(exported, PgTable)) continue;
    const table = exported as PgTable;
    if (seen.has(table)) continue;
    seen.add(table);

    const cfg = getTableConfig(table);
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      // Explicit name set in `foreignKey({ name: "...", ... })` — out
      // of scope: that is the documented fix and the user has already
      // chosen a short identifier.
      if (ref.name !== undefined) continue;

      const columnNames = ref.columns.map((c) => c.name);
      const foreignTableName = getTableConfig(ref.foreignTable).name;
      const foreignColumnNames = ref.foreignColumns.map((c) => c.name);
      const name = autoFkName(
        cfg.name,
        columnNames,
        foreignTableName,
        foreignColumnNames,
      );
      if (name.length > POSTGRES_IDENTIFIER_LIMIT) {
        violations.push({
          table: cfg.name,
          autoName: name,
          length: name.length,
          columns: columnNames,
          foreignTable: foreignTableName,
          foreignColumns: foreignColumnNames,
        });
      }
    }
  }

  return violations;
}

function formatViolation(v: OversizedFkViolation): string {
  return (
    `  ✗ ${v.table}.(${v.columns.join(",")}) → ` +
    `${v.foreignTable}.(${v.foreignColumns.join(",")})\n` +
    `      auto-name (${v.length} chars): "${v.autoName}"\n` +
    `      Postgres will silently truncate to 63 chars on CREATE.\n` +
    `      Fix: foreignKey({ name: "${v.table}_${v.columns.join("_")}_fk",\n` +
    `                       columns: [...], foreignColumns: [...] })`
  );
}

async function main(): Promise<void> {
  const schema = (await import("../src/schema/index.ts")) as Record<
    string,
    unknown
  >;
  const violations = findOversizedAutoFkNames(schema);
  if (violations.length === 0) {
    console.log(
      "✓ check-fk-names: every FK auto-name fits in " +
        `${POSTGRES_IDENTIFIER_LIMIT} chars.`,
    );
    return;
  }
  console.error(
    `\n✗ check-fk-names: ${violations.length} foreign key(s) would generate a ` +
      `constraint name longer than Postgres's ${POSTGRES_IDENTIFIER_LIMIT}-char ` +
      `identifier limit:\n`,
  );
  for (const v of violations) console.error(formatViolation(v));
  console.error(
    "\nGive each flagged FK an explicit short name via\n" +
      "  foreignKey({ name: \"<table>_<col>_fk\", columns: [...], foreignColumns: [...] })\n" +
      "as is done elsewhere in lib/db/src/schema/golf.ts. See task #805.",
  );
  process.exit(1);
}

// Run as CLI when invoked directly (tsx sets import.meta.url to the
// entry file). Importers (sync-schema.ts, the test) pull in
// `findOversizedAutoFkNames` without triggering this branch.
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error("check-fk-names: unexpected error:", err);
    process.exit(1);
  });
}
