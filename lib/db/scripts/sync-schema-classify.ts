/**
 * Destructive-statement classifier for the schema sync.
 *
 * Pure, side-effect-free helpers extracted from `sync-schema.ts` so that
 * both the script and `sync-schema-classify.test.ts` exercise the SAME
 * symbols. Editing a pattern here is the only way to change the
 * classifier behaviour — the test cannot drift from the script because
 * there is no second copy of the regex set to drift against.
 *
 * Importing this module is cheap and has no side effects: it does not
 * touch `process.stdin`, does not hit the database, does not pull in
 * `drizzle-kit/api`, and does not validate `DATABASE_URL`. That is what
 * makes it safe for the focused unit test to import.
 *
 * See `sync-schema.ts` for the surrounding flow (snapshot cache, fast/
 * slow path, apply gate) and the rationale behind each pattern.
 */

export const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /^\s*DROP\s+TABLE\b/i,
  /^\s*DROP\s+SCHEMA\b/i,
  /^\s*DROP\s+VIEW\b/i,
  /^\s*DROP\s+MATERIALIZED\s+VIEW\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bRENAME\s+TO\b/i,
  /\bRENAME\s+COLUMN\b/i,
  /\bDROP\s+CONSTRAINT\b/i,
  /^\s*TRUNCATE\b/i,
];

// Cosmetic-churn exception (DROP CONSTRAINT): drizzle re-emits FK and
// UNIQUE constraints with its own naming convention, so any name that
// got clipped by Postgres' 63-char identifier limit on the original
// CREATE shows up on every introspect as a paired
// DROP CONSTRAINT (truncated name) + ADD CONSTRAINT (canonical name).
// `lib/db/drizzle/0059_canonicalize_fk_names.sql` (Task #570) renames
// or drops every such pair we knew about, so this exception now only
// fires when a brand-new long-named FK lands in the schema — it is
// kept as a belt-and-braces guard, narrowed to names that actually
// hit the 63-char limit.
//
// Constraint suffixes that always represent a real intent change (kept
// on the destructive list regardless of length):
//   * `_check`  — CHECK constraint
//   * `_pkey`   — PRIMARY KEY (Postgres-default)
//   * `_pk`     — PRIMARY KEY (drizzle convention)
//   * `_excl`   — EXCLUSION constraint (Postgres-default)
export const REAL_DROP_CONSTRAINT_SUFFIXES =
  /_(?:check|pkey|pk|excl)"\s*;?\s*$/i;
export const POSTGRES_IDENTIFIER_LIMIT = 63;

// Names ending in Postgres-default suffixes (`_fkey`, `_key`) always
// represent the same FK / UNIQUE re-emitted under drizzle's canonical
// `_fk` / `_unique` suffix in the same diff — pure rename churn that
// our destructive gate must not block.
export const POSTGRES_DEFAULT_SUFFIXES = /_(?:fkey|key)"\s*;?\s*$/i;

export function isCosmeticDropConstraint(s: string): boolean {
  const m = s.match(/\bDROP\s+CONSTRAINT\s+"([^"]+)"/i);
  if (!m) return false;
  if (REAL_DROP_CONSTRAINT_SUFFIXES.test(s)) return false;
  // Always cosmetic: Postgres-default suffixes (`_fkey`, `_key`).
  if (POSTGRES_DEFAULT_SUFFIXES.test(s)) return true;
  // Otherwise only treat as cosmetic if the constraint name was clipped
  // by Postgres' identifier limit — that is the one shape drizzle is
  // known to flip on every introspect even when the schema hasn't
  // changed. Shorter `_fk` / `_unique` names are a real intent change
  // and should surface as destructive (data-loss gate or explicit
  // migration in `lib/db/drizzle/`).
  return m[1].length >= POSTGRES_IDENTIFIER_LIMIT;
}

// Cosmetic-churn exception (ALTER COLUMN ... SET DEFAULT): drizzle
// re-formats Postgres-stored defaults on every introspect even when
// the schema has not changed. Examples:
//   * `ARRAY['email']::text[]` (drizzle) vs
//     `ARRAY['email'::text]`   (postgres)
//   * `'{}'::text[]`            ↔ `ARRAY[]::text[]`
//   * jsonb objects pretty-print with a different key order
//
// Mirror the narrow filter from `scripts/check-db-drift.sh`: only
// suppress SET DEFAULT statements whose right-hand side matches one of
// the known re-formatting shapes (ARRAY[...] literal with optional cast,
// or single-quoted literal cast to jsonb / text[] / *_array). All
// other SET DEFAULT changes — numbers, timestamps, enums, plain
// strings — still surface so an intentional default change cannot
// hide.
export const COSMETIC_SET_DEFAULT =
  /\bALTER\s+COLUMN\s+"[^"]+"\s+SET\s+DEFAULT\s+(?:ARRAY\[[^\]]*\](?:\s*::\s*[a-zA-Z_]+(?:\[\])?)?|'[^']*'::(?:jsonb|text\[\]|[a-zA-Z_]+\[\]))\s*;?\s*$/i;

export function isCosmeticSetDefault(s: string): boolean {
  return COSMETIC_SET_DEFAULT.test(s);
}

// Cosmetic-churn exception (paired ADD+DROP CONSTRAINT same table+name):
// drizzle's introspection occasionally emits BOTH an `ADD CONSTRAINT "X"`
// and a `DROP CONSTRAINT "X"` for the same constraint on the same table
// in the same diff. The known trigger is `UNIQUE ... NULLS NOT DISTINCT`
// constraints (e.g. `email_cta_send_stats_key_org_unique`) which round-
// trip through pg_catalog in a way that drizzle's introspector doesn't
// perfectly recognise as already matching the schema declaration. The
// diff is emitted in ADD-then-DROP order — which would fail outright if
// applied as real DDL (the constraint already exists) — so the only
// sensible interpretation is "no-op churn, skip both". Genuine
// constraint redefinitions should be authored as numbered SQL migrations
// under `lib/db/drizzle/`, the same way other intent changes go through
// the destructive-data-loss gate.
//
// Pairing is keyed on `(table, constraint-name)` rather than name alone,
// because constraint names are per-table in Postgres and two unrelated
// tables can legitimately share a constraint name. Pairing by name only
// would silently mask a real DROP on table B whenever an unrelated ADD
// happened on table A in the same diff.
export function constraintIdOf(s: string): string | null {
  const m = s.match(
    /\bALTER\s+TABLE\s+"([^"]+)"\s+(?:ADD|DROP)\s+CONSTRAINT\s+"([^"]+)"/i,
  );
  return m ? `${m[1]}.${m[2]}` : null;
}

export function pairedAddDropConstraintIds(statements: string[]): Set<string> {
  const adds = new Set<string>();
  const drops = new Set<string>();
  for (const s of statements) {
    const addMatch = s.match(
      /\bALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"/i,
    );
    if (addMatch) adds.add(`${addMatch[1]}.${addMatch[2]}`);
    const dropMatch = s.match(
      /\bALTER\s+TABLE\s+"([^"]+)"\s+DROP\s+CONSTRAINT\s+"([^"]+)"/i,
    );
    if (dropMatch) drops.add(`${dropMatch[1]}.${dropMatch[2]}`);
  }
  const paired = new Set<string>();
  for (const id of adds) {
    if (drops.has(id)) paired.add(id);
  }
  return paired;
}

// Cosmetic-churn exception (paired DROP INDEX + CREATE INDEX same name
// for an EXPRESSION or PARTIAL index):
//
// drizzle-kit's introspector occasionally emits BOTH a `DROP INDEX "X"`
// and a `CREATE INDEX "X" ON ...` for the same index name in the same
// diff. The known trigger is partial / expression indexes whose
// definition Postgres canonicalises with explicit `::text` casts and
// added whitespace (e.g. `payload->>'messageId'` becomes
// `(payload ->> 'messageId'::text)` in `pg_indexes.indexdef`), and
// drizzle's per-introspect string comparison sees the canonical form
// as different from what the schema's `sql\`(...)\`` template generates.
// Both statements would re-converge on the same shape after apply, so
// re-running them on every cold-container post-merge is pure log noise.
//
// Why we restrict the suppression to expression / partial indexes
// (`(expr)` column or `WHERE` clause), not all same-name pairs:
// a plain column index (`USING btree (col1, col2)`) does NOT round-trip
// through Postgres's canonicaliser differently — `pg_indexes.indexdef`
// preserves the exact column list. So if drizzle ever emits a same-name
// DROP + CREATE for a plain-column index, that is an actual intent
// change (different columns / different uniqueness / different storage
// method) that MUST stay visible — and the author should have written
// it as a numbered SQL migration. Restricting to the expression /
// partial shape neutralises only the well-understood pg-side
// canonicalisation noise without giving same-name plain-column index
// redefinitions a free pass.
//
// Index names are unique within a schema in Postgres (they are
// schema-scoped, not table-scoped), so pairing on name alone — once we
// have the expression-or-partial restriction in place — is safe
// (unlike constraints, where the same name can legitimately exist on
// two unrelated tables and pairing-by-name-only would mask a real
// DROP).
export function indexNameOf(s: string): string | null {
  // CREATE INDEX (optionally UNIQUE / IF NOT EXISTS) "<name>" ON ...
  const createMatch = s.match(
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i,
  );
  if (createMatch) return createMatch[1];
  // DROP INDEX (optionally IF EXISTS) "<name>"
  // Reject the table-qualified `DROP INDEX "schema"."name"` form: if a
  // schema prefix is present, take the part AFTER the dot as the name.
  const dropMatch = s.match(
    /\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:"[^"]+"\s*\.\s*)?"([^"]+)"/i,
  );
  if (dropMatch) return dropMatch[1];
  return null;
}

// Returns true for `CREATE INDEX ... ON ... USING <method> (... (expr) ...)`
// (an expression-as-column form) OR `... WHERE <predicate>` (partial).
// These are the ONLY index shapes Postgres canonicalises in a way that
// trips drizzle's introspect string-compare.
export function isExpressionOrPartialIndex(s: string): boolean {
  // Partial: a `WHERE` clause anywhere AFTER the column list.
  if (/\)\s+WHERE\b/i.test(s)) return true;
  // Expression: a parenthesised expression appearing as a column inside
  // the column list — i.e. `(...)` immediately preceded by `(` or by
  // `, ` (with optional whitespace). This matches `("payload"->>'x')`
  // and `(lower("col"))` etc., but NOT `numeric(10,2)`-style type
  // qualifiers (those don't appear in CREATE INDEX column lists).
  //
  // The column-list opens after the `ON <table>` clause and an
  // optional `USING <method>` (Postgres defaults to btree, and
  // drizzle-kit's introspect output sometimes omits the keyword).
  // We anchor on the `ON` keyword and take the first `(` after it as
  // the column-list opener — that's robust to BOTH the `USING btree`
  // form AND the bare `ON "t" (...)` form, while still rejecting any
  // `(...)` that appears INSIDE the table identifier (impossible in
  // valid SQL but worth being explicit about).
  const onMatch = s.match(/\bON\s+/i);
  if (!onMatch || onMatch.index === undefined) return false;
  const openIdx = s.indexOf("(", onMatch.index + onMatch[0].length);
  if (openIdx === -1) return false;
  // Walk the balanced column list; flag if any column begins with `(`.
  // `atColumnStart` is true at the start of each column slot — i.e.
  // immediately after the column-list opener `(` and immediately after
  // each top-level `,`. If we encounter another `(` while in that
  // state, the current column starts with a parenthesised expression
  // (drizzle's introspect output for expression columns is always
  // `((expr))`), so this is an expression column.
  let depth = 0;
  let atColumnStart = false;
  for (let i = openIdx; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "(") {
      if (depth === 1 && atColumnStart) return true;
      depth += 1;
      // Entering the column list (depth 0 → 1): the next thing is the
      // first column slot, so we ARE at column start.
      atColumnStart = depth === 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return false;
      atColumnStart = false;
    } else if (ch === ",") {
      if (depth === 1) atColumnStart = true;
    } else if (!/\s/.test(ch)) {
      atColumnStart = false;
    }
  }
  return false;
}

export function pairedDropCreateIndexNames(statements: string[]): Set<string> {
  // Only pair DROP INDEX ↔ CREATE INDEX where the CREATE is for an
  // expression / partial index. A plain-column-index same-name pair
  // remains visible (and stays classified destructive on the DROP).
  const creates = new Map<string, string>();
  const drops = new Set<string>();
  for (const s of statements) {
    const createMatch = s.match(
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i,
    );
    if (createMatch) creates.set(createMatch[1], s);
    const dropMatch = s.match(
      /\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:"[^"]+"\s*\.\s*)?"([^"]+)"/i,
    );
    if (dropMatch) drops.add(dropMatch[1]);
  }
  const paired = new Set<string>();
  for (const [name, createStmt] of creates) {
    if (!drops.has(name)) continue;
    if (!isExpressionOrPartialIndex(createStmt)) continue;
    paired.add(name);
  }
  return paired;
}

export interface ClassifiedStatements {
  destructive: string[];
  additive: string[];
  cosmetic: string[];
}

export function classify(statements: string[]): ClassifiedStatements {
  const destructive: string[] = [];
  const additive: string[] = [];
  const cosmetic: string[] = [];
  const pairedConstraints = pairedAddDropConstraintIds(statements);
  const pairedIndexes = pairedDropCreateIndexNames(statements);
  for (const s of statements) {
    const cid = constraintIdOf(s);
    if (cid !== null && pairedConstraints.has(cid)) {
      cosmetic.push(s);
      continue;
    }
    const ixName = indexNameOf(s);
    if (ixName !== null && pairedIndexes.has(ixName)) {
      cosmetic.push(s);
      continue;
    }
    if (isCosmeticDropConstraint(s) || isCosmeticSetDefault(s)) {
      cosmetic.push(s);
      continue;
    }
    if (DESTRUCTIVE_PATTERNS.some((p) => p.test(s))) {
      destructive.push(s);
    } else {
      additive.push(s);
    }
  }
  return { destructive, additive, cosmetic };
}
