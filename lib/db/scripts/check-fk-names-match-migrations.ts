#!/usr/bin/env -S tsx
/**
 * Lint-style check that fails when a foreign key in `lib/db/src/schema/`
 * would generate a constraint name that DOES NOT match the explicit name
 * a numbered SQL migration in `lib/db/drizzle/` already used for the
 * same (table, columns, foreign-table, foreign-columns) tuple.
 *
 * Background — Tasks #2219, #2221, #2192, #2225, #2215, #2222, #2223,
 * #2224 (the "post-merge keeps refusing to apply" outage)
 * --------------------------------------------------------------------
 * Migration 0156 created the foreign key as
 *   `portal_digest_mute_confirmation_sends_user_id_fk`            (49 chars)
 * but the schema declared it via inline `.references(() =>
 * appUsersTable.id)`, so drizzle auto-named it
 *   `portal_digest_mute_confirmation_sends_user_id_app_users_id_fk` (61 chars)
 * Each post-merge introspect therefore emitted a real DROP+ADD pair
 * with two different names. The DROP was correctly classified
 * destructive by `sync-schema-classify.ts` (49 chars < 63, suffix `_fk`
 * not `_fkey` / `_key`), and the apply gate refused — five+ consecutive
 * merges sat broken in the queue until the schema FK was given an
 * explicit `foreignKey({ name: "<the migration name>", ... })`.
 *
 * `check-fk-names.ts` already catches the related class where drizzle's
 * auto-name would EXCEED 63 chars (Postgres clips it). This guard
 * catches the strictly narrower class: the migration author chose a
 * deliberate, in-bounds name that does NOT match what drizzle would
 * generate for the same FK signature. Both situations cause perpetual
 * post-merge drift; only this one slipped through the existing checks.
 *
 * What this script does
 * ---------------------
 *   1. Walks every numbered SQL file in `lib/db/drizzle/` (NOT the
 *      `archive/` directory — those files are not in the apply loop;
 *      see `scripts/post-merge.sh`).
 *   2. Parses two FK shapes:
 *        - inline in CREATE TABLE:
 *            CONSTRAINT "name" FOREIGN KEY ("c1","c2")
 *              REFERENCES "ref_t"("r1","r2")
 *        - top-level ALTER TABLE:
 *            ALTER TABLE [ONLY] [<schema>.]"table"
 *              ADD CONSTRAINT "name" FOREIGN KEY ("c1","c2")
 *              REFERENCES [<schema>.]"ref_t"("r1","r2")
 *      and any matching `DROP CONSTRAINT "name"` so a later migration
 *      can legitimately rename an FK; the most recent named entry for a
 *      given (table, cols, ref_t, ref_cols) tuple wins.
 *   3. Walks every PgTable exported from `lib/db/src/schema/index.ts`
 *      and, for each FK, computes the name drizzle WOULD apply
 *      (explicit `foreignKey({ name })` or the same auto-name formula
 *      `<table>_<col>...<reftable>_<refcol>..._fk` that
 *      `check-fk-names.ts` uses).
 *   4. Compares: if the signature appears in BOTH the migration map
 *      and the schema, and the names differ, fail with the actionable
 *      fix message.
 *
 * Out of scope (handled by sibling guards):
 *   - FKs that exist in the schema but no migration creates → caught by
 *     `check-migrations-cover-schema.ts` (missing migration drift).
 *   - FKs whose schema auto-name would exceed 63 chars → caught by
 *     `check-fk-names.ts` (Postgres truncation).
 *
 * Usage
 * -----
 *   pnpm --filter @workspace/db exec tsx ./scripts/check-fk-names-match-migrations.ts
 *
 * Exit codes:
 *   0  — every (table, cols, ref_t, ref_cols) tuple in BOTH the
 *        migration map and the schema agrees on the constraint name.
 *   1  — at least one tuple disagrees; the schema would generate a
 *        different name than the migration set, which produces the
 *        post-merge DROP+ADD churn the data-loss gate refuses to apply.
 *
 * Wired into:
 *   - `lib/db/scripts/sync-schema.ts` runs this as a preflight,
 *     immediately after the existing `check-fk-names.ts` length check,
 *     so a name-drift FK fails the post-merge BEFORE drizzle's
 *     introspect produces the unapplyable diff.
 *   - `lib/db/scripts/check-fk-names-match-migrations.test.ts`
 *     exercises the underlying pure functions against synthetic inputs.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import {
  POSTGRES_DEFAULT_SUFFIXES,
  POSTGRES_IDENTIFIER_LIMIT,
} from "./sync-schema-classify.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DB_PKG_DIR = dirname(SCRIPT_DIR);
const MIGRATIONS_DIR = join(DB_PKG_DIR, "drizzle");

// ── SQL parsing helpers ───────────────────────────────────────────────────
//
// We deliberately keep this regex-based and narrow rather than pulling
// in a full SQL parser. The `lib/db/drizzle/*.sql` files are written by
// `drizzle-kit generate` and by hand under tight conventions
// (double-quoted identifiers, optional `ONLY` and schema qualifiers) —
// the surface area is small and stable. Three shapes are recognised:
//
//   (A) Inline in CREATE TABLE:
//         CREATE TABLE [IF NOT EXISTS] [schema.]"<table>" ( ...
//           ... CONSTRAINT "<name>" FOREIGN KEY (<cols>)
//             REFERENCES [schema.]"<ref_t>" (<ref_cols>) ...
//         );
//
//   (B) Top-level ALTER TABLE:
//         ALTER TABLE [ONLY] [schema.]"<table>"
//           ADD CONSTRAINT "<name>" FOREIGN KEY (<cols>)
//           REFERENCES [schema.]"<ref_t>" (<ref_cols>) ...;
//
//   (C) DROP CONSTRAINT (so a deliberate rename in a later migration
//       wins over the original create):
//         ALTER TABLE [schema.]"<table>" DROP CONSTRAINT [IF EXISTS] "<name>";
//
// Anything else (DO blocks, EXECUTE FORMAT %I plumbing, multi-statement
// PL/pgSQL) is conservatively ignored — it cannot introduce drift the
// destructive-statement gate would block, because anything wrapped in a
// DO block is invisible to drizzle's introspect anyway.

export interface FkSignature {
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export function signatureKey(sig: FkSignature): string {
  // Column order matters for FKs in Postgres (the constraint references
  // ordered (cols) → (ref_cols)) so we MUST NOT sort.
  return (
    `${sig.table}(${sig.columns.join(",")})` +
    `→${sig.refTable}(${sig.refColumns.join(",")})`
  );
}

function stripSchemaPrefix(qname: string): string {
  // Match four shapes the migrations actually use, in priority order:
  //   "schema"."table"          → "table"
  //   schema."table"            → "table"
  //   "schema".table            → table
  //   schema.table              → table  (the dominant pg_dump baseline form)
  // and the fallback shapes:
  //   "table"                   → table
  //   table                     → table
  // Drizzle's schema declarations use bare unqualified names, so we
  // strip ANY schema qualifier here so the signature key compares
  // apples-to-apples against `getTableConfig(table).name`.
  const trimmed = qname.trim();
  const dotted = trimmed.match(
    /^(?:"[^"]+"|[a-zA-Z_][\w$]*)\s*\.\s*(?:"([^"]+)"|([a-zA-Z_][\w$]*))$/,
  );
  if (dotted) return dotted[1] ?? dotted[2];
  const quoted = trimmed.match(/^"([^"]+)"$/);
  if (quoted) return quoted[1];
  return trimmed;
}

function parseColumnList(raw: string): string[] {
  // `("a", "b", "c")` or `(a, b, c)` — split on commas, strip
  // surrounding quotes/whitespace. The `pg_dump` baseline migration
  // (0000_initial.sql, generated by `pg_dump --schema-only`) uses bare
  // unquoted identifiers in REFERENCES clauses; the per-PR migrations
  // generated by `drizzle-kit generate` use double-quoted identifiers.
  // We accept both.
  return raw
    .split(",")
    .map((c) => c.trim())
    .map((c) => c.replace(/^"(.+)"$/, "$1"))
    .filter((c) => c.length > 0);
}

// A bare or double-quoted identifier (one segment, no schema dot).
const ID = `(?:"[^"]+"|[a-zA-Z_][\\w$]*)`;
// A schema-qualified identifier: optional `<schema>.` prefix in front
// of an ID. Both halves can be quoted or bare independently.
const QUALIFIED_ID = `(?:${ID}\\s*\\.\\s*)?${ID}`;

interface ParsedMigrationFk {
  signature: FkSignature;
  name: string;
  // Byte-offset within the migration file where the declaration
  // begins (the start of the matched ALTER TABLE / CREATE TABLE
  // statement). Used by `buildMigrationFkMap` to interleave with
  // DROP CONSTRAINT events in true source order so that a same-file
  // `DROP CONSTRAINT x; ... ADD CONSTRAINT x` pair correctly ends
  // up with the freshly-added entry in the map.
  position: number;
}

// A DROP CONSTRAINT event surfaced for source-order replay alongside
// `ParsedMigrationFk` ADD events. We only need the table+name pair to
// identify the targeted constraint plus the byte-offset for ordering.
interface ParsedMigrationFkDrop {
  table: string;
  name: string;
  position: number;
}

// Strip SQL comments so a constraint name that appears inside a
// `--` line comment or a SQL block comment (slash-star ... star-slash)
// doesn't get mistaken for a real declaration.
function stripSqlComments(sql: string): string {
  // Block comments first (greedy across lines).
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Then single-line comments (-- to end of line). Keep the newline so
  // the regexes that key off the start of a line still work.
  out = out.replace(/--[^\n]*/g, "");
  return out;
}

/**
 * Extract every named foreign key declaration from a single migration
 * file's contents. Both inline CREATE TABLE constraints and top-level
 * ALTER TABLE ADD CONSTRAINT are covered.
 *
 * The returned list is in source order so a later DROP+RECREATE in the
 * same file (rare but legal) lets the recreate win when the parent
 * caller folds duplicates by signature.
 */
export function parseMigrationFile(sql: string): ParsedMigrationFk[] {
  const cleaned = stripSqlComments(sql);
  const out: ParsedMigrationFk[] = [];

  // (B) Top-level ALTER TABLE ... ADD CONSTRAINT "<name>" FOREIGN KEY ...
  // Accepts both `drizzle-kit generate` shape (quoted identifiers) and
  // the `pg_dump --schema-only` baseline shape (unquoted identifiers,
  // `ALTER TABLE ONLY public.x ADD CONSTRAINT name FOREIGN KEY (col)
  // REFERENCES public.r(id)`). The constraint NAME is also accepted as
  // bare or quoted because pg_dump emits bare identifiers there too.
  const alterRe = new RegExp(
    `\\bALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${QUALIFIED_ID})` +
      `\\s+ADD\\s+CONSTRAINT\\s+(${ID})` +
      `\\s+FOREIGN\\s+KEY\\s*\\(([^)]+)\\)` +
      `\\s+REFERENCES\\s+(${QUALIFIED_ID})\\s*\\(([^)]+)\\)`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = alterRe.exec(cleaned)) !== null) {
    out.push({
      signature: {
        table: stripSchemaPrefix(m[1]),
        columns: parseColumnList(m[3]),
        refTable: stripSchemaPrefix(m[4]),
        refColumns: parseColumnList(m[5]),
      },
      // The constraint name itself can be quoted or bare — strip the
      // surrounding quotes if present.
      name: m[2].replace(/^"(.+)"$/, "$1"),
      position: m.index,
    });
  }

  // (A) Inline CREATE TABLE constraints.
  // First find every CREATE TABLE block, then scan its body for
  // `CONSTRAINT "<name>" FOREIGN KEY (<cols>) REFERENCES ...`.
  // Postgres's `CREATE TABLE` body is balanced parens — for the
  // shapes drizzle-kit / our hand-written migrations use, the OUTER
  // body is a single `( ... )` immediately after the table name,
  // and the closing `)` is at column 0 followed by `;` or
  // `WITHOUT/WITH`. We track depth so a column type like
  // `numeric(10,2)` does not prematurely close the body.
  const createHeaderRe = new RegExp(
    `\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED_ID})\\s*\\(`,
    "gi",
  );
  let h: RegExpExecArray | null;
  while ((h = createHeaderRe.exec(cleaned)) !== null) {
    const tableName = stripSchemaPrefix(h[1]);
    const bodyStart = h.index + h[0].length;
    let depth = 1;
    let i = bodyStart;
    for (; i < cleaned.length; i += 1) {
      const ch = cleaned[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      } else if (ch === "'") {
        // Skip string literal — single-quoted, with `''` escapes.
        i += 1;
        while (i < cleaned.length) {
          if (cleaned[i] === "'") {
            if (cleaned[i + 1] === "'") {
              i += 2;
              continue;
            }
            break;
          }
          i += 1;
        }
      }
    }
    const body = cleaned.slice(bodyStart, i);

    // Now scan the balanced body for inline FK constraints. Same
    // dual-shape acceptance as (B): quoted (drizzle-kit) or bare
    // (pg_dump) identifiers for the constraint name and the REFERENCES
    // target.
    const inlineRe = new RegExp(
      `\\bCONSTRAINT\\s+(${ID})` +
        `\\s+FOREIGN\\s+KEY\\s*\\(([^)]+)\\)` +
        `\\s+REFERENCES\\s+(${QUALIFIED_ID})\\s*\\(([^)]+)\\)`,
      "gi",
    );
    let f: RegExpExecArray | null;
    while ((f = inlineRe.exec(body)) !== null) {
      out.push({
        signature: {
          table: tableName,
          columns: parseColumnList(f[2]),
          refTable: stripSchemaPrefix(f[3]),
          refColumns: parseColumnList(f[4]),
        },
        name: f[1].replace(/^"(.+)"$/, "$1"),
        // Position is the byte-offset of the inline declaration WITHIN
        // the original cleaned source — `bodyStart + f.index` translates
        // the body-relative offset back to source coordinates.
        position: bodyStart + f.index,
      });
    }
  }

  return out;
}

/**
 * Parallel parser for top-level `ALTER TABLE ... DROP CONSTRAINT name`
 * statements, returning the table+name pair plus the byte-offset of
 * each match. Source positions are required so `buildMigrationFkMap`
 * can interleave ADD and DROP events in true source order — without
 * this, a same-file `DROP CONSTRAINT x; ... ADD CONSTRAINT x;` pair
 * would be folded as "ADD then DROP" and the freshly-recreated FK
 * would silently disappear from the map.
 *
 * Same dual-shape acceptance as `parseMigrationFile`: quoted (drizzle-
 * kit) or bare (pg_dump baseline) identifiers, with optional `ONLY`
 * keyword and optional schema qualifier.
 */
export function parseMigrationFileDrops(sql: string): ParsedMigrationFkDrop[] {
  const cleaned = stripSqlComments(sql);
  const out: ParsedMigrationFkDrop[] = [];
  const dropRe = new RegExp(
    `\\bALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${QUALIFIED_ID})` +
      `\\s+DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?(${ID})`,
    "gi",
  );
  let d: RegExpExecArray | null;
  while ((d = dropRe.exec(cleaned)) !== null) {
    out.push({
      table: stripSchemaPrefix(d[1]),
      name: d[2].replace(/^"(.+)"$/, "$1"),
      position: d.index,
    });
  }
  return out;
}

/**
 * Top-level driver: walk `lib/db/drizzle/` (NOT archive/) in filename
 * order, parse each file, fold by signature so the most recently
 * declared name wins. DROP CONSTRAINT entries that don't have a
 * matching ADD afterwards are removed from the map (someone genuinely
 * dropped the FK; the schema-side check will then notice it's gone too
 * via the missing-migration guard, not this one).
 */
export function buildMigrationFkMap(): Map<string, string> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((n) => /^\d{4}_.*\.sql$/i.test(n))
    .sort();

  // Track BOTH the latest name per signature AND the set of currently-
  // dropped names per (table, name) so a later RECREATE can re-add.
  // Pure-DROP-without-recreate is observable: we remove the signature
  // from the map below.
  const bySignature = new Map<string, string>();
  // (table, name) → signature, so a DROP can find what to remove.
  const nameToSignature = new Map<string, string>();

  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");

    // Merge ADDs and DROPs into a single source-ordered event stream
    // and replay in order. The naive "apply all ADDs, then all DROPs"
    // approach silently corrupts the map for a same-file
    // `DROP CONSTRAINT x; ... ADD CONSTRAINT x` (drop-then-recreate)
    // pair: the post-pass DROP would wipe the freshly-added entry. By
    // replaying in true source order, the recreate's ADD lands AFTER
    // the DROP, so the map ends up with the recreate's name as
    // intended.
    type Event =
      | { kind: "add"; fk: ParsedMigrationFk }
      | { kind: "drop"; drop: ParsedMigrationFkDrop };
    const events: Event[] = [
      ...parseMigrationFile(sql).map<Event>((fk) => ({ kind: "add", fk })),
      ...parseMigrationFileDrops(sql).map<Event>((drop) => ({
        kind: "drop",
        drop,
      })),
    ];
    events.sort((a, b) => {
      const ap = a.kind === "add" ? a.fk.position : a.drop.position;
      const bp = b.kind === "add" ? b.fk.position : b.drop.position;
      return ap - bp;
    });

    for (const ev of events) {
      if (ev.kind === "add") {
        const key = signatureKey(ev.fk.signature);
        bySignature.set(key, ev.fk.name);
        nameToSignature.set(`${ev.fk.signature.table}.${ev.fk.name}`, key);
      } else {
        // DROP CONSTRAINT: remove the FK from the map IF the latest
        // declaration for that signature still points at the dropped
        // name (a later ADD in this file with a different name would
        // have already replaced it via `bySignature.set` above).
        const { table, name } = ev.drop;
        const key = nameToSignature.get(`${table}.${name}`);
        if (key === undefined) continue;
        if (bySignature.get(key) === name) {
          bySignature.delete(key);
        }
        nameToSignature.delete(`${table}.${name}`);
      }
    }
  }

  return bySignature;
}

// ── Schema FK extraction ──────────────────────────────────────────────────
// Mirrors `check-fk-names.ts` — same auto-name formula, same explicit-
// name handling — just additionally records the signature so we can
// look it up against the migration map.

function autoFkName(
  tableName: string,
  columns: string[],
  foreignTableName: string,
  foreignColumns: string[],
): string {
  return (
    [tableName, ...columns, foreignTableName, ...foreignColumns].join("_") +
    "_fk"
  );
}

export interface SchemaFk {
  signature: FkSignature;
  name: string;
  isExplicit: boolean;
}

export function extractSchemaFks(schema: Record<string, unknown>): SchemaFk[] {
  const out: SchemaFk[] = [];
  const seen = new Set<PgTable>();

  for (const exported of Object.values(schema)) {
    if (!is(exported, PgTable)) continue;
    const table = exported as PgTable;
    if (seen.has(table)) continue;
    seen.add(table);

    const cfg = getTableConfig(table);
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      const columns = ref.columns.map((c) => c.name);
      const refTable = getTableConfig(ref.foreignTable).name;
      const refColumns = ref.foreignColumns.map((c) => c.name);
      const name =
        ref.name !== undefined
          ? ref.name
          : autoFkName(cfg.name, columns, refTable, refColumns);
      out.push({
        signature: { table: cfg.name, columns, refTable, refColumns },
        name,
        isExplicit: ref.name !== undefined,
      });
    }
  }

  return out;
}

// ── Comparator ────────────────────────────────────────────────────────────

export interface NameDriftViolation {
  signature: FkSignature;
  schemaName: string;
  migrationName: string;
  schemaUsedExplicitName: boolean;
}

// Pre-existing baseline drift the lint must NOT flag.
//
// Background: the squashed `0000_initial.sql` baseline was produced by
// `pg_dump --schema-only`, which serialises every FK whose original
// migration didn't supply a name using Postgres's auto-generated
// `<table>_<col>_fkey` form (also `_key` for unique constraints).
// drizzle's auto-name formula is different
// (`<table>_<col>_<reftable>_<refcol>_fk`), so ~175 baseline FKs
// disagree by name. They DON'T break post-merge because the existing
// `isCosmeticDropConstraint` exemption in `sync-schema-classify.ts`
// classifies the DROP as cosmetic for any name matching
// `POSTGRES_DEFAULT_SUFFIXES` (`_fkey` / `_key`) OR for any name that
// hit the 63-char identifier truncation limit.
//
// `_pkey` is deliberately NOT in this list — the classifier treats
// `_pkey` (and `_pk`, `_check`, `_excl`) as REAL drops via
// `REAL_DROP_CONSTRAINT_SUFFIXES`. So if a migration ever uses a
// `_pkey` name for an FK and the schema disagrees, this lint MUST
// fire (parity with the classifier).
//
// The bug class #2820 was filed for is the strictly NARROWER one: a
// migration deliberately chose a custom in-bounds name (e.g.
// `portal_digest_mute_confirmation_sends_user_id_fk`, 49 chars,
// suffix `_fk`, NOT in `POSTGRES_DEFAULT_SUFFIXES`), the schema's
// auto-name doesn't match it, and so the DROP gets classified
// destructive — that's what stopped 5+ consecutive merges.
//
// Filtering on the migration NAME is the right knob (not the schema
// name): it's the migration's name that the live DB stores, so it's
// the migration's name that drizzle introspect emits in the DROP
// statement that has to clear the cosmetic gate.
//
// We import the suppression constants from `sync-schema-classify.ts`
// (the single source of truth for the cosmetic gate) so a future
// widening / narrowing of the exemption automatically propagates here.
// The classifier's regex anchors on `"<name>"` boundaries (it scans
// raw SQL); strip that anchor for the bare-name comparison done here.
function isHandledByExistingCosmeticDropExemption(name: string): boolean {
  // Re-run the classifier's suffix regex against a synthetic
  // `"<name>";` fragment so we use the EXACT matcher the classifier
  // uses — no chance of the two suffix lists drifting.
  if (POSTGRES_DEFAULT_SUFFIXES.test(`"${name}";`)) return true;
  if (name.length >= POSTGRES_IDENTIFIER_LIMIT) return true;
  return false;
}

export function findNameDriftViolations(
  schema: Record<string, unknown>,
  migrationFks: Map<string, string>,
): NameDriftViolation[] {
  const violations: NameDriftViolation[] = [];
  for (const fk of extractSchemaFks(schema)) {
    const key = signatureKey(fk.signature);
    const migrationName = migrationFks.get(key);
    if (migrationName === undefined) continue;
    if (migrationName === fk.name) continue;
    // Skip cases the existing cosmetic-DROP-CONSTRAINT exception
    // already neutralises — they don't block any merge.
    if (isHandledByExistingCosmeticDropExemption(migrationName)) continue;
    violations.push({
      signature: fk.signature,
      schemaName: fk.name,
      migrationName,
      schemaUsedExplicitName: fk.isExplicit,
    });
  }
  return violations;
}

function formatViolation(v: NameDriftViolation): string {
  const sig = v.signature;
  const explicitNote = v.schemaUsedExplicitName
    ? `      The schema declared an explicit name that does not match the migration:\n` +
      `        schema   foreignKey({ name: "${v.schemaName}", ... })\n` +
      `        migration CONSTRAINT "${v.migrationName}"\n`
    : `      The schema uses inline .references(...) which auto-generates "${v.schemaName}"\n` +
      `      but the migration created the FK with the explicit name "${v.migrationName}".\n`;
  return (
    `  ✗ ${sig.table}.(${sig.columns.join(",")}) → ` +
    `${sig.refTable}.(${sig.refColumns.join(",")})\n` +
    explicitNote +
    `      Fix in lib/db/src/schema/: replace the inline .references(...) with\n` +
    `        foreignKey({\n` +
    `          name: "${v.migrationName}",\n` +
    `          columns: [t.${sig.columns.join(", t.")}],\n` +
    `          foreignColumns: [<refTable>.${sig.refColumns.join(", <refTable>.")}],\n` +
    `        })`
  );
}

async function main(): Promise<void> {
  const schema = (await import("../src/schema/index.ts")) as Record<
    string,
    unknown
  >;
  const migrationFks = buildMigrationFkMap();
  const violations = findNameDriftViolations(schema, migrationFks);
  if (violations.length === 0) {
    console.log(
      `✓ check-fk-names-match-migrations: every FK with a name set by a ` +
        `numbered migration matches what the schema would generate ` +
        `(checked ${migrationFks.size} migration FK(s)).`,
    );
    return;
  }
  console.error(
    `\n✗ check-fk-names-match-migrations: ${violations.length} foreign key(s) ` +
      `would generate a constraint name DIFFERENT from the one a numbered ` +
      `migration in lib/db/drizzle/ already created. This is the bug class ` +
      `that broke 5+ consecutive merges in the post-merge queue (Tasks #2219, ` +
      `#2221, #2192, #2225, #2215, #2222, #2223, #2224): every introspect ` +
      `emits a real DROP+ADD pair the data-loss gate refuses to apply.\n`,
  );
  for (const v of violations) console.error(formatViolation(v));
  console.error(
    "\nGive each flagged FK an explicit name in the schema that matches the " +
      "migration's name. The pattern lives next to the existing fixes:\n" +
      "  - lib/db/src/schema/golf.ts: bouncedDigestScheduleOptOutsTable,\n" +
      "    bouncedDigestScheduleSendsTable, portalDigestMuteConfirmationSendsTable.\n",
  );
  process.exit(1);
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error("check-fk-names-match-migrations: unexpected error:", err);
    process.exit(1);
  });
}
