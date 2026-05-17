#!/usr/bin/env -S tsx
/**
 * Non-interactive schema sync.
 *
 * Replaces the legacy `drizzle-kit push --force` invocation that was driven
 * through a PTY (`script -qfc`) with a stream of newlines. That hack worked
 * only as long as every prompt happened to want the default answer; any new
 * prompt (rename vs. drop, destructive change, etc.) would be silently
 * mis-answered.
 *
 * Strategy:
 *   1. Replace `process.stdin` with a synthetic Readable BEFORE importing
 *      `drizzle-kit/api`. The fake stdin auto-emits a `return` keypress
 *      whenever drizzle-kit's bundled `hanji` Terminal attaches a keypress
 *      listener, which deterministically selects the first option of every
 *      `Select` / `ResolveSelect` prompt:
 *
 *        - "rename vs. create new" prompts default to "create new"
 *          (the new table/column is created; the missing one stays in
 *          `deleted` and surfaces as a DROP in the diff, which our
 *          destructive-gate refuses unless ALLOW_SCHEMA_DATA_LOSS=1).
 *        - "truncate this table to add a unique constraint?" defaults to
 *          "No, add the constraint without truncating" (safe — no data
 *          deleted; if existing rows violate the constraint, the apply
 *          fails loudly at SQL exec time).
 *
 *   2. FAST PATH — diff cached snapshot vs. current schema:
 *        - On a successful sync we record the schema snapshot we just
 *          converged the DB to (`SYNC_SNAPSHOT_FILE`) plus a guard hash
 *          of every numbered migration filename in `lib/db/drizzle/`
 *          (`SYNC_SNAPSHOT_GUARD_FILE`). Numbered SQL migrations apply
 *          before this script runs (see `scripts/post-merge.sh`) and can
 *          mutate the DB out-of-band, so a guard mismatch invalidates
 *          the cache and forces the slow path.
 *        - When the cache is valid we skip drizzle's multi-minute
 *          introspect entirely and run `generateMigration(prev, cur)` —
 *          a pure JSON diff of two snapshots — to compute the SQL
 *          statements. This brings a typical post-merge sync from
 *          ~80 s to ~2 s on the current 300+ table schema.
 *
 *   3. SLOW PATH — `pushSchema` (introspects the live DB) is used when:
 *        - the cache file is missing (cold container / first run), or
 *        - the migration-filenames guard does not match (a new numbered
 *          migration landed and may have done DDL we cannot model from
 *          the schema files alone).
 *
 *   4. Refuse to apply the diff if it contains any DROP / RENAME /
 *      DROP CONSTRAINT / TRUNCATE statement (or, on the slow path,
 *      drizzle reports `hasDataLoss`), unless `ALLOW_SCHEMA_DATA_LOSS=1`
 *      is set. This makes the bullet "Running the sync gives a clear
 *      error if a destructive or ambiguous change is detected"
 *      load-bearing on both paths.
 *
 * Usage:
 *   pnpm --filter @workspace/db sync
 *   ALLOW_SCHEMA_DATA_LOSS=1 pnpm --filter @workspace/db sync   # opt-in
 *   DRY_RUN=1 pnpm --filter @workspace/db sync                   # print only
 *   POST_MERGE_FORCE_INTROSPECT=1 pnpm --filter @workspace/db sync
 *                                  # bypass the snapshot cache
 */

import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The destructive-statement classifier and its cosmetic-churn
// exceptions live in `./sync-schema-classify.ts` so a focused unit
// test (`sync-schema-classify.test.ts`) can import and exercise the
// SAME symbols this script uses. Keeping a second copy in the test
// would let a regression here ship silently — the test would pass
// against its own private patterns. See task #2062.
import {
  classify,
  DESTRUCTIVE_PATTERNS,
  isCosmeticDropConstraint,
  isCosmeticSetDefault,
  POSTGRES_IDENTIFIER_LIMIT,
} from "./sync-schema-classify.ts";

// --- 1. Install the fake stdin BEFORE drizzle-kit/api is imported. ---------
//
// drizzle-kit's bundled `hanji` calls `readline.createInterface({input:
// process.stdin})` and then attaches a 'keypress' listener via the Terminal
// class. We swap process.stdin out for a Readable that:
//   - reports `isTTY === false` (no setRawMode side effects),
//   - whenever a 'keypress' listener is registered, schedules a synthetic
//     `\r` keypress on the next tick (deferred so Terminal's own
//     `this.resolve` is bound first), and then keeps emitting one every
//     short interval until the listener is removed (covers prompts that
//     re-render in a loop).
//
// The synthetic keypress submits the default (first) option of every
// drizzle prompt, which is always the safe answer (create new / don't
// truncate). We do not need a real TTY, real newlines, or `script -qfc`.

class AutoEnterStdin extends Readable {
  isTTY = false;
  setRawMode(_state: boolean): this {
    return this;
  }
  override resume(): this {
    return this;
  }
  override pause(): this {
    return this;
  }
  override _read(): void {
    // No real input; we synthesize keypress events directly.
  }
}

const fakeStdin = new AutoEnterStdin();
const KEYPRESS_INTERVAL_MS = 25;
const activeKeypressTimers = new Set<NodeJS.Timeout>();

const realOn = fakeStdin.on.bind(fakeStdin);
const realRemoveListener = fakeStdin.removeListener.bind(fakeStdin);

function fireReturn(cb: (...args: unknown[]) => void): void {
  try {
    cb("\r", { name: "return", ctrl: false, sequence: "\r" });
  } catch {
    /* drizzle's handler already detached — ignore. */
  }
}

(fakeStdin as Readable).on = function patchedOn(
  this: Readable,
  event: string | symbol,
  listener: (...args: unknown[]) => void,
) {
  realOn(event, listener);
  if (event === "keypress") {
    // Defer the first press so the Terminal constructor finishes binding
    // its `resolve` callback, then keep tapping Enter until the listener
    // is detached. This handles both single Select prompts and the
    // rename-resolution loop in `promptNamedWithSchemasConflict`.
    setImmediate(() => fireReturn(listener));
    const timer = setInterval(() => fireReturn(listener), KEYPRESS_INTERVAL_MS);
    activeKeypressTimers.add(timer);
  }
  return this;
};

(fakeStdin as Readable).removeListener = function patchedRemoveListener(
  this: Readable,
  event: string | symbol,
  listener: (...args: unknown[]) => void,
) {
  realRemoveListener(event, listener);
  if (event === "keypress") {
    for (const timer of activeKeypressTimers) {
      clearInterval(timer);
    }
    activeKeypressTimers.clear();
  }
  return this;
};

Object.defineProperty(process, "stdin", {
  value: fakeStdin,
  writable: true,
  configurable: true,
});

// --- 2. Now load drizzle-kit & friends. ------------------------------------
const { Pool } = await import("pg");
const { drizzle } = await import("drizzle-orm/node-postgres");
const { sql } = await import("drizzle-orm");
const drizzleApi = (await import("drizzle-kit/api")) as {
  pushSchema: (
    imports: Record<string, unknown>,
    db: unknown,
  ) => Promise<{
    hasDataLoss: boolean;
    warnings: string[];
    statementsToExecute: string[];
    apply: () => Promise<void>;
  }>;
  generateDrizzleJson: (imports: Record<string, unknown>) => unknown;
  generateMigration: (prev: unknown, cur: unknown) => Promise<string[]>;
};
const schema = await import("../src/schema/index.ts");

// --- 2a. FK auto-name length preflight (Task #805) -------------------------
// Postgres clips identifiers at 63 chars. Drizzle's default FK name
// `<table>_<col>_<reftable>_<refcol>_fk` can exceed that on long-named
// tables / columns; the live DB then stores a clipped name while
// drizzle re-emits the canonical one on every introspect, producing
// endless DROP/ADD CONSTRAINT churn (the bug class that landed
// migration 0059 and the broadcast-overlay catch-up 0062). Fail the
// sync BEFORE touching the DB so a long-named FK is fixed at the
// schema level (`foreignKey({ name: "<table>_<col>_fk", ... })`)
// instead of being silently truncated.
const { findOversizedAutoFkNames } = await import("./check-fk-names.ts");
const fkViolations = findOversizedAutoFkNames(
  schema as Record<string, unknown>,
);
if (fkViolations.length > 0) {
  console.error(
    `\nsync-schema: ${fkViolations.length} foreign key(s) would generate a ` +
      "constraint name longer than Postgres's 63-char identifier limit:\n",
  );
  for (const v of fkViolations) {
    console.error(
      `  ✗ ${v.table}.(${v.columns.join(",")}) → ` +
        `${v.foreignTable}.(${v.foreignColumns.join(",")})\n` +
        `      auto-name (${v.length} chars): "${v.autoName}"`,
    );
  }
  console.error(
    "\nGive each flagged FK an explicit short name via\n" +
      "  foreignKey({ name: \"<table>_<col>_fk\", columns: [...], foreignColumns: [...] })\n" +
      "as is done elsewhere in lib/db/src/schema/golf.ts. See task #805.\n",
  );
  process.exit(1);
}

// Preflight 2: foreign-key NAME drift between schema and migrations.
//
// Sibling guard to `findOversizedAutoFkNames`. The length check above
// catches FKs whose drizzle auto-name would exceed 63 chars (the
// truncation churn). This second check catches the strictly narrower
// case the post-merge queue actually got stuck on FIVE+ times in a row
// (Tasks #2219, #2221, #2192, #2225, #2215, #2222, #2223, #2224): a
// numbered migration creates the FK with one in-bounds name (e.g.
// `portal_digest_mute_confirmation_sends_user_id_fk`, 49 chars), but
// the schema still uses inline `.references(...)`, so drizzle
// auto-names it differently (`..._user_id_app_users_id_fk`, 61 chars).
// The live DB stores the migration's name, drizzle's introspect sees
// the auto-name as the "intended" one, and every cold-container sync
// emits a real DROP+ADD pair the data-loss gate refuses to apply.
//
// We run this BEFORE introspect for the same reason the length check
// runs first: a name-drift FK produces a destructive diff that would
// stop the whole apply, so we'd rather fail loud at the schema level
// with the exact actionable fix than print "refused to drop" twenty
// lines down.
const { buildMigrationFkMap, findNameDriftViolations } = await import(
  "./check-fk-names-match-migrations.ts"
);
const migrationFkMap = buildMigrationFkMap();
const fkNameDrift = findNameDriftViolations(
  schema as Record<string, unknown>,
  migrationFkMap,
);
if (fkNameDrift.length > 0) {
  console.error(
    `\nsync-schema: ${fkNameDrift.length} foreign key(s) would generate a ` +
      `constraint name DIFFERENT from the one a numbered migration in ` +
      `lib/db/drizzle/ already created. This is the bug class that broke ` +
      `5+ consecutive merges in the post-merge queue (Tasks #2219, #2221, ` +
      `#2192, #2225): every introspect emits a real DROP+ADD pair the ` +
      `data-loss gate refuses to apply.\n`,
  );
  for (const v of fkNameDrift) {
    const sig = v.signature;
    const explicitNote = v.schemaUsedExplicitName
      ? `      schema   foreignKey({ name: "${v.schemaName}", ... })\n` +
        `      migration CONSTRAINT "${v.migrationName}"\n`
      : `      schema (inline .references) auto-generates "${v.schemaName}"\n` +
        `      migration created the FK as "${v.migrationName}"\n`;
    console.error(
      `  ✗ ${sig.table}.(${sig.columns.join(",")}) → ` +
        `${sig.refTable}.(${sig.refColumns.join(",")})\n` +
        explicitNote,
    );
  }
  console.error(
    "Give each flagged FK an explicit name in the schema that matches the\n" +
      "migration's name. The pattern lives next to the existing fixes in\n" +
      "lib/db/src/schema/golf.ts: bouncedDigestScheduleOptOutsTable,\n" +
      "bouncedDigestScheduleSendsTable, portalDigestMuteConfirmationSendsTable.\n",
  );
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("sync-schema: DATABASE_URL is not set");
  process.exit(1);
}

const ALLOW_DATA_LOSS = process.env.ALLOW_SCHEMA_DATA_LOSS === "1";
const DRY_RUN = process.env.DRY_RUN === "1";
const FORCE_INTROSPECT =
  process.env.POST_MERGE_FORCE_INTROSPECT === "1" ||
  process.env.POST_MERGE_FORCE_SYNC === "1";

// `classify`, `DESTRUCTIVE_PATTERNS`, `isCosmeticDropConstraint`,
// `isCosmeticSetDefault` and `POSTGRES_IDENTIFIER_LIMIT` are imported
// from `./sync-schema-classify.ts` (top of file). See that module for
// the patterns themselves and the rationale behind each cosmetic-churn
// exception.

// --- 3. Snapshot cache ------------------------------------------------------
//
// Keyed by the set of numbered migration filenames in `lib/db/drizzle/`.
// Numbered migrations apply BEFORE this script (see post-merge.sh) and can
// do arbitrary DDL we can't model from schema files alone, so we treat
// "any change to the migration filename set" as a cache-invalidating event.
//
// Schema-file changes do NOT invalidate the cache: they're exactly the
// thing the diff path computes from `prev` → `cur`.

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DB_PKG_DIR = dirname(SCRIPT_DIR);
const MIGRATIONS_DIR = join(DB_PKG_DIR, "drizzle");
// Persist the cache INSIDE the repo (committed) so fresh, isolated
// containers — CI runners, task-agent sandboxes, anyone whose `/tmp` was
// just wiped — hit the fast path immediately instead of spending 5+
// minutes re-introspecting the live DB. The previous `/tmp/...` defaults
// effectively guaranteed a slow path on every cold container.
const DEFAULT_CACHE_DIR = join(DB_PKG_DIR, ".sync-cache");
const SYNC_SNAPSHOT_FILE =
  process.env.SYNC_SNAPSHOT_FILE ?? join(DEFAULT_CACHE_DIR, "snapshot.json");
const SYNC_SNAPSHOT_GUARD_FILE =
  process.env.SYNC_SNAPSHOT_GUARD_FILE ??
  join(DEFAULT_CACHE_DIR, "snapshot.guard");

function migrationsGuard(): string {
  let names: string[] = [];
  try {
    names = readdirSync(MIGRATIONS_DIR)
      .filter((n) => /^\d{4}_.*\.sql$/i.test(n))
      .sort();
  } catch {
    names = [];
  }
  return createHash("sha256").update(names.join("\n")).digest("hex");
}

function readCachedSnapshot(): unknown | null {
  if (FORCE_INTROSPECT) return null;
  if (!existsSync(SYNC_SNAPSHOT_FILE) || !existsSync(SYNC_SNAPSHOT_GUARD_FILE)) {
    return null;
  }
  try {
    const guard = readFileSync(SYNC_SNAPSHOT_GUARD_FILE, "utf8").trim();
    if (guard !== migrationsGuard()) return null;
    return JSON.parse(readFileSync(SYNC_SNAPSHOT_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeCachedSnapshot(snapshot: unknown): void {
  try {
    mkdirSync(dirname(SYNC_SNAPSHOT_FILE), { recursive: true });
    writeFileSync(SYNC_SNAPSHOT_FILE, JSON.stringify(snapshot));
    writeFileSync(SYNC_SNAPSHOT_GUARD_FILE, migrationsGuard());
  } catch (err) {
    console.warn(
      `sync-schema: failed to update snapshot cache (${(err as Error).message}); ` +
        "next run will fall back to introspect.",
    );
  }
}

// Extract the raw SQL text from a drizzle `sql.raw(text)` value.
// drizzle-kit's `pgPushIntrospect` only ever passes us `sql.raw(...)`
// (a single StringChunk), so a structural read is sufficient and avoids
// the cost of drizzle's parameter-binding pipeline.
function extractRawSql(sqlObj: unknown): string | null {
  const chunks = (sqlObj as { queryChunks?: Array<{ value?: unknown }> })
    ?.queryChunks;
  if (!Array.isArray(chunks) || chunks.length !== 1) return null;
  const v = chunks[0]?.value;
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === "string") {
    return v[0];
  }
  return null;
}

async function main(): Promise<void> {
  // Bump the pool size for the slow introspection path. drizzle-kit's
  // `pgPushIntrospect` fires per-table queries (columns, constraints,
  // checks, FKs, indexes — ~5 queries per table) in parallel via
  // Promise.all over `allTables.map(...)`. With ~390 tables that is
  // ~2000 queries; the default `pg` Pool max of 10 serialises them into
  // ~200 round-trip stages.
  //
  // 32 connections is well below typical Postgres `max_connections`
  // (100). Combined with the `bypassDrizzle` execute wrapper below,
  // this brings introspection from ~100 s to ~25 s on the current dev
  // DB.
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: Number(process.env.SYNC_POOL_MAX ?? 32),
  });
  const realDb = drizzle(pool);

  // pushSchema's internal `db` wrapper goes through
  // `drizzleInstance.execute(sql.raw(query))`. drizzle-orm's
  // node-postgres `.execute` serialises through a single client even
  // when concurrent callers Promise.all() it (measured: 100 parallel
  // `db.execute` ≈ 4.3 s vs 100 parallel `pool.query` ≈ 1.0 s on the
  // dev DB). Override `.execute` with a direct `pool.query` for raw
  // SQL strings so the per-table introspection actually uses the
  // pool's parallel slots. Anything not coming from `sql.raw(...)`
  // (none in the introspect path today, but cheap insurance) falls
  // through to the real drizzle execute.
  // ── Bulk-fetch shim for the two queries that dominate cold introspect ──
  //
  // Profiling the slow path on the dev DB shows that `pgPushIntrospect`'s
  // per-table queries against `information_schema.table_constraints` (and
  // its join with `constraint_column_usage`) cost ~50 s each at the 391-
  // table mark. They run 397 times — once per table — and contribute
  // ~95 % of the total wall time. The cost is intrinsic to
  // `information_schema` views on a large catalog; per-call WHERE filters
  // do not help.
  //
  // The two queries are deterministic per (schema, table). We fan-in
  // by running a SINGLE bulk variant (without the table-name predicate)
  // the first time we see each shape, group the rows by table_name in
  // memory, and answer every subsequent per-table call from the cache.
  // 397 queries × ~50 s collapses to 2 queries × ~5–15 s.
  type Row = Record<string, unknown>;
  const bulkCache = new Map<string, Map<string, Row[]>>();
  const bulkPromises = new Map<string, Promise<Map<string, Row[]>>>();

  // Drizzle interpolates the table/schema names directly; match the
  // exact string template so we don't accidentally rewrite an unrelated
  // query.
  const TABLE_CONSTRAINTS_RE =
    /^\s*SELECT c\.column_name, c\.data_type, constraint_type, constraint_name, constraint_schema\s+FROM information_schema\.table_constraints tc\s+JOIN information_schema\.constraint_column_usage AS ccu USING \(constraint_schema, constraint_name\)\s+JOIN information_schema\.columns AS c ON c\.table_schema = tc\.constraint_schema\s+AND tc\.table_name = c\.table_name AND ccu\.column_name = c\.column_name\s+WHERE tc\.table_name = '([^']+)' and constraint_schema = '([^']+)';\s*$/;

  const TABLE_CHECKS_RE =
    /WHERE\s+tc\.table_name = '([^']+)'\s+AND tc\.constraint_schema = '([^']+)'\s+AND tc\.constraint_type = 'CHECK'\s+AND con\.contype = 'c';\s*$/;

  async function bulkFetch(
    key: string,
    bulkSql: string,
  ): Promise<Map<string, Row[]>> {
    const cached = bulkCache.get(key);
    if (cached) return cached;
    let p = bulkPromises.get(key);
    if (!p) {
      p = (async () => {
        const res = await pool.query(bulkSql);
        const grouped = new Map<string, Row[]>();
        for (const row of res.rows as Row[]) {
          const tn = row.__table_name as string;
          let arr = grouped.get(tn);
          if (!arr) {
            arr = [];
            grouped.set(tn, arr);
          }
          arr.push(row);
        }
        bulkCache.set(key, grouped);
        return grouped;
      })();
      bulkPromises.set(key, p);
    }
    return p;
  }

  const realExecute = realDb.execute.bind(realDb);
  (realDb as unknown as {
    execute: (q: unknown) => Promise<{ rows: unknown[] }>;
  }).execute = async (q: unknown) => {
    const text = extractRawSql(q);
    if (text === null) {
      return realExecute(q as Parameters<typeof realExecute>[0]) as unknown as {
        rows: unknown[];
      };
    }

    const m1 = TABLE_CONSTRAINTS_RE.exec(text);
    if (m1) {
      const [, tableName, tableSchema] = m1;
      const key = `tc1:${tableSchema}`;
      // Equivalent pg_catalog query — `information_schema.table_constraints`
      // joined with `constraint_column_usage` and `columns` is intrinsically
      // O(constraints × tables) on this catalog and takes ~50 s per call.
      // Going through `pg_constraint`/`pg_attribute` directly returns the
      // same UNIQUE/PRIMARY-KEY rows drizzle filters for in <100 ms total.
      // FOREIGN-KEY rows are intentionally omitted — drizzle only filters
      // this result set for UNIQUE and PRIMARY KEY (FKs are fetched via a
      // dedicated query upstream).
      const bulkSql =
        `SELECT cl.relname AS __table_name, c.conname AS constraint_name, ` +
        `CASE c.contype WHEN 'p' THEN 'PRIMARY KEY' ` +
        `WHEN 'u' THEN 'UNIQUE' END AS constraint_type, ` +
        `a.attname AS column_name, ` +
        `pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type ` +
        `FROM pg_constraint c ` +
        `JOIN pg_class cl ON cl.oid = c.conrelid ` +
        `JOIN pg_namespace n ON n.oid = cl.relnamespace ` +
        `JOIN unnest(c.conkey) WITH ORDINALITY u(attnum, ord) ON true ` +
        `JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = u.attnum ` +
        `WHERE n.nspname = '${tableSchema}' AND c.contype IN ('p','u') ` +
        `ORDER BY cl.relname, c.conname, u.ord;`;
      const grouped = await bulkFetch(key, bulkSql);
      const rows = (grouped.get(tableName) ?? []).map((r) => {
        const { __table_name: _omit, ...rest } = r;
        return rest;
      });
      return { rows };
    }

    const m2 = TABLE_CHECKS_RE.exec(text);
    if (m2) {
      const [, tableName, tableSchema] = m2;
      const key = `tc2:${tableSchema}`;
      const bulkSql =
        `SELECT cl.relname AS __table_name, c.conname AS constraint_name, ` +
        `'CHECK' AS constraint_type, ` +
        `pg_get_constraintdef(c.oid) AS constraint_definition ` +
        `FROM pg_constraint c ` +
        `JOIN pg_class cl ON cl.oid = c.conrelid ` +
        `JOIN pg_namespace n ON n.oid = cl.relnamespace ` +
        `WHERE n.nspname = '${tableSchema}' AND c.contype = 'c';`;
      const grouped = await bulkFetch(key, bulkSql);
      const rows = (grouped.get(tableName) ?? []).map((r) => {
        const { __table_name: _omit, ...rest } = r;
        return rest;
      });
      return { rows };
    }

    try {
      const res = await pool.query(text);
      return { rows: res.rows };
    } catch (err) {
      console.error("[sync-schema] FAILING SQL:\n", text);
      throw err;
    }
  };
  const db = realDb;

  try {
    const cur = drizzleApi.generateDrizzleJson(
      schema as Record<string, unknown>,
    );
    const cachedPrev = readCachedSnapshot();

    let statementsToExecute: string[];
    let pushedHasDataLoss = false;
    let pushedWarnings: string[] = [];
    let pushedApply: (() => Promise<void>) | null = null;
    let usedFastPath = false;

    if (cachedPrev !== null) {
      console.log("sync-schema: using cached snapshot (fast diff path).");
      statementsToExecute = await drizzleApi.generateMigration(cachedPrev, cur);
      usedFastPath = true;
    } else {
      console.log(
        "sync-schema: snapshot cache miss — introspecting live DB " +
          "(this is slow on large schemas).",
      );
      const pushed = await drizzleApi.pushSchema(
        schema as Record<string, unknown>,
        db,
      );
      statementsToExecute = pushed.statementsToExecute;
      pushedHasDataLoss = pushed.hasDataLoss;
      pushedWarnings = pushed.warnings;
      pushedApply = pushed.apply;
    }

    if (pushedWarnings.length > 0) {
      console.warn("sync-schema: drizzle warnings:");
      for (const w of pushedWarnings) console.warn(`  - ${w}`);
    }

    if (statementsToExecute.length === 0) {
      console.log("sync-schema: database already matches schema. No-op.");
      writeCachedSnapshot(cur);
      return;
    }

    const { destructive, additive, cosmetic } = classify(statementsToExecute);

    // Cosmetic statements are introspection re-formatting churn (FK
    // rename truncation, jsonb / array default re-formatting). They
    // are no-ops against the live DB but drizzle re-emits them on every
    // introspect, so skip them entirely instead of applying-and-no-op.
    // This also lets DRY_RUN report a true no-op when nothing else is
    // pending — the requirement that gates Task #570.
    const applyable = [...additive.filter((s) => !cosmetic.includes(s)), ...destructive];

    if (cosmetic.length > 0) {
      console.log(
        `sync-schema: skipping ${cosmetic.length} cosmetic introspection ` +
          "re-formatting statement(s) (FK rename truncation / default " +
          "literal re-formatting); the live DB already matches the schema.",
      );
      for (const s of cosmetic) {
        console.log(`  [cosmetic] ${s.replace(/\s+/g, " ").trim()}`);
      }
    }

    if (applyable.length === 0) {
      console.log("sync-schema: database already matches schema. No-op.");
      writeCachedSnapshot(cur);
      return;
    }

    const realAdditive = additive.filter((s) => !cosmetic.includes(s));
    console.log(
      `sync-schema: ${applyable.length} statement(s) pending ` +
        `(${realAdditive.length} additive, ${destructive.length} destructive).`,
    );
    for (const s of applyable) {
      console.log(`  ${s.replace(/\s+/g, " ").trim()}`);
    }

    if (DRY_RUN) {
      // DRY_RUN is for inspection only — print the diff (already done
      // above) and exit 0 regardless of whether it is destructive.
      // Do not update the cache: nothing was applied, so the live DB
      // still matches the previous snapshot, not `cur`.
      console.log("sync-schema: DRY_RUN=1, not applying.");
      return;
    }

    if ((pushedHasDataLoss || destructive.length > 0) && !ALLOW_DATA_LOSS) {
      console.error(
        "\nsync-schema: REFUSING to apply — destructive or ambiguous " +
          "change detected. Author a numbered SQL migration in " +
          "lib/db/drizzle/ instead, or re-run with " +
          "ALLOW_SCHEMA_DATA_LOSS=1 if you have reviewed the diff above.",
      );
      process.exit(2);
    }

    if (usedFastPath) {
      // Fast path: apply each non-cosmetic statement via raw SQL.
      // drizzle's own apply() is only available on the slow
      // (pushSchema) path.
      for (const stmt of applyable) {
        await db.execute(sql.raw(stmt));
      }
    } else {
      // Slow path: drizzle's apply() runs every statement it
      // generated. We can't filter cosmetic ones out of its internal
      // list, but they are no-ops against Postgres so re-applying them
      // is harmless — the next introspect will simply re-emit them
      // and we'll skip them then too.
      await pushedApply!();
    }

    // Record the snapshot we just converged the DB to so the next sync
    // can take the fast path.
    writeCachedSnapshot(cur);
    console.log("sync-schema: applied successfully.");
  } finally {
    await pool.end();
    // Stop any leftover synthetic keypress timers so the process can exit
    // cleanly even if drizzle never detached its prompt listener.
    for (const timer of activeKeypressTimers) clearInterval(timer);
    activeKeypressTimers.clear();
  }
}

main().catch((err) => {
  console.error("sync-schema failed:", err);
  process.exit(1);
});
