#!/usr/bin/env -S tsx
/**
 * CI guard — every table/column in `lib/db/src/schema/*.ts` must have a
 * matching numbered migration in `lib/db/drizzle/`.
 *
 * Why this exists (Task #1199): production only ever applies the
 * numbered SQL files in `lib/db/drizzle/` (see `scripts/post-merge.sh`'s
 * apply loop). The dev / test post-merge then runs
 * `pnpm --filter @workspace/db sync` to close any gap between those
 * files and `lib/db/src/schema/*.ts`. That sync NEVER runs in
 * production, so a schema change without a numbered migration silently
 * works everywhere except production — which is exactly how Task #579
 * shipped `club_marketing_site_images` to staging fine and missed the
 * table in production until Task #1034's backfill failed.
 *
 * What this script does:
 *   1. Pick a workspace database (see "Where the workspace DB comes
 *      from" below).
 *   2. Apply every numbered SQL file in `lib/db/drizzle/` exactly the
 *      way `scripts/post-merge.sh` does (sorted, with
 *      `ON_ERROR_STOP=1` so any per-file failure aborts the run loudly
 *      instead of being silently tolerated as "re-run noise" — Task
 *      #1715).
 *   3. Drop the legacy `scorer_credentials` table the same way
 *      `post-merge.sh` does, so a stale rename-vs-drop diff against
 *      `affiliate_codes` doesn't masquerade as missing-migration drift.
 *   4. Call drizzle-kit's `pushSchema(schema, db)` against the now
 *      fully-migrated DB to compute the DDL drizzle WOULD have to run
 *      to make the DB match `lib/db/src/schema/*.ts`. We never call
 *      `.apply()` — `pushSchema` only computes the diff.
 *   5. Filter the cosmetic re-formatting churn drizzle is known to
 *      re-emit on every introspect (FK rename truncation, jsonb /
 *      ARRAY[...] / text[] default literal re-formatting), exactly the
 *      same way `sync-schema.ts` and `scripts/check-db-drift.sh` do —
 *      so all four checks (sync, drift, drift-fast, this guard) agree
 *      on what counts as real drift.
 *   6. If any substantive statement remains, exit 1 with the list and a
 *      pointer telling the author to run
 *      `pnpm --filter @workspace/db generate`.
 *
 * Where the workspace DB comes from:
 *   - In CI (FRESH_DB=1) we use $DATABASE_URL directly. The workflow
 *     in `.github/workflows/db-migration-coverage.yml` provisions an
 *     empty Postgres service for exactly this — wiping it is fine.
 *   - Locally (no FRESH_DB) we DERIVE a temp DB name from $DATABASE_URL
 *     and CREATE / DROP it ourselves so we never touch the dev DB the
 *     workspace's tests are running against. This matches the safety
 *     posture of `scripts/check-db-drift.sh`.
 *
 * Running it:
 *   # Local — derives migration_coverage_<pid>_<epoch> from DATABASE_URL.
 *   pnpm --filter @workspace/db check:migrations-cover-schema
 *
 *   # CI — DATABASE_URL points at an empty postgres service:
 *   FRESH_DB=1 pnpm --filter @workspace/db check:migrations-cover-schema
 *
 * Exit codes:
 *   0 = every table/column in the schema is created by a numbered
 *       migration (or the only diff is cosmetic re-formatting churn).
 *   1 = drift detected — schema has tables/columns/types not produced
 *       by any numbered migration. Author must run
 *       `pnpm --filter @workspace/db generate` and commit the new SQL.
 *   2 = misconfiguration (DATABASE_URL missing, can't reach Postgres).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installAutoEnterStdin } from "./auto-enter-stdin.ts";
import { installBulkIntrospectShim } from "./bulk-introspect.ts";
// Re-use the cosmetic-paired-index detection from the classifier
// module so the migration-coverage gate and the destructive-statement
// gate stay EXACTLY in sync (see comment block above `classifyDrift`
// below for why divergence is the failure mode this whole script
// exists to avoid).
import {
  indexNameOf,
  pairedDropCreateIndexNames,
} from "./sync-schema-classify.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DB_PKG_DIR = dirname(SCRIPT_DIR);
const MIGRATIONS_DIR = join(DB_PKG_DIR, "drizzle");
// Baseline of historical drift the team has knowingly accepted.
// The guard fails only when statements appear that are NOT in this file —
// i.e. drift introduced by the PR under review. To clean up historical
// drift, write a real migration AND refresh this baseline:
//
//   UPDATE_BASELINE=1 FRESH_DB=1 DATABASE_URL=… \
//     pnpm --filter @workspace/db check:migrations-cover-schema
//
// Refreshing the baseline is a privileged action — review the diff
// carefully (statements LEAVING the baseline are good; statements
// ENTERING it are new historical drift you're papering over).
const BASELINE_FILE = join(DB_PKG_DIR, ".migration-coverage-baseline.json");

// ── Cosmetic-suppression ──────────────────────────────────────────────────
// Same patterns sync-schema.ts and the slow drift check use. drizzle
// re-emits these on every introspect even when the schema is unchanged,
// so they cannot indicate a missing migration.
const COSMETIC_SET_DEFAULT =
  /\bALTER\s+COLUMN\s+"[^"]+"\s+SET\s+DEFAULT\s+(?:ARRAY\[[^\]]*\](?:\s*::\s*[a-zA-Z_]+(?:\[\])?)?|'[^']*'::(?:jsonb|text\[\]|[a-zA-Z_]+\[\]))\s*;?\s*$/i;

const POSTGRES_IDENTIFIER_LIMIT = 63;
const REAL_DROP_CONSTRAINT_SUFFIXES = /_(?:check|pkey|pk|excl)"\s*;?\s*$/i;
const POSTGRES_DEFAULT_SUFFIXES = /_(?:fkey|key)"\s*;?\s*$/i;

function isCosmeticSetDefault(s: string): boolean {
  return COSMETIC_SET_DEFAULT.test(s);
}

function isCosmeticDropConstraint(s: string): boolean {
  const m = s.match(/\bDROP\s+CONSTRAINT\s+"([^"]+)"/i);
  if (!m) return false;
  if (REAL_DROP_CONSTRAINT_SUFFIXES.test(s)) return false;
  if (POSTGRES_DEFAULT_SUFFIXES.test(s)) return true;
  return m[1].length >= POSTGRES_IDENTIFIER_LIMIT;
}

export function isCosmetic(s: string): boolean {
  return isCosmeticSetDefault(s) || isCosmeticDropConstraint(s);
}

// Same paired DROP INDEX + CREATE INDEX cosmetic exception that
// `sync-schema-classify.ts` applies. Partial / expression indexes get
// canonicalised by Postgres on storage (`payload->>'messageId'` becomes
// `(payload ->> 'messageId'::text)` in `pg_indexes.indexdef`); drizzle's
// per-introspect string compare sees the canonical form as different
// from the schema's `sql\`(...)\`` template and re-emits both
// statements every time. Apply the same suppression here so this guard
// doesn't accuse the author of forgetting a migration when the only
// "drift" is an introspect-formatting round-trip.
//
// We re-use the function from the classifier module (imported at the
// top of this file) to keep the two suppressions EXACTLY in sync —
// divergence between the cosmetic gate and the migration-coverage gate
// is what produced the "post-merge applies but the migration-coverage
// check screams" failure mode this whole script was written to avoid.
// A future widening / narrowing of the suppression happens in one
// place (`sync-schema-classify.ts`) and is picked up automatically
// here.

export function classifyDrift(statements: string[]): {
  real: string[];
  cosmetic: string[];
} {
  const real: string[] = [];
  const cosmetic: string[] = [];
  const pairedIndexes = pairedDropCreateIndexNames(statements);
  for (const s of statements) {
    const ixName = indexNameOf(s);
    if (ixName !== null && pairedIndexes.has(ixName)) {
      cosmetic.push(s);
      continue;
    }
    if (isCosmetic(s)) cosmetic.push(s);
    else real.push(s);
  }
  return { real, cosmetic };
}

export function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((n) => /^\d{4}_.*\.sql$/i.test(n))
    .sort();
}

// ── Workspace-DB selection ────────────────────────────────────────────────
// In CI (FRESH_DB=1) we use $DATABASE_URL directly — the workflow
// provisions an empty postgres service. Locally we derive a temp DB
// name and CREATE / DROP it ourselves so the dev DB is never touched.
function parseDatabaseUrl(url: string): { base: string; tail: string } {
  const m = url.match(/^(postgres(?:ql)?:\/\/[^/]+\/)([^?]+)(\?.*)?$/);
  if (!m) {
    throw new Error(
      `check-migrations-cover-schema: cannot parse DATABASE_URL ` +
        `(expected postgres://[user[:pwd]@]host[:port]/dbname[?params]).`,
    );
  }
  return { base: m[1], tail: m[3] ?? "" };
}

function tempDbName(): string {
  return `migration_coverage_${process.pid}_${Date.now()}`;
}

function applyMigrationsViaPsql(workspaceUrl: string): void {
  const files = listMigrations();
  if (files.length === 0) {
    throw new Error(
      `check-migrations-cover-schema: no numbered migrations found in ${MIGRATIONS_DIR}.`,
    );
  }
  console.log(
    `check-migrations-cover-schema: applying ${files.length} numbered ` +
      `migration(s) to ${workspaceUrl.replace(/:\/\/[^@]+@/, "://***@")} ` +
      `via psql (mirrors scripts/post-merge.sh) ...`,
  );

  // Use a SINGLE psql session with `\i` directives to apply every
  // migration. Spawning one psql per file (the previous loop) cost
  // ~150–300 ms of process / connection overhead per file — on a 247-
  // file migration set that adds 30–60 s of pure spawn cost before
  // any DDL runs. Streaming a single script keeps the same
  // ON_ERROR_STOP=1 strictness (any real ERROR aborts the loop with
  // the offending file's name in the diagnostic) while collapsing
  // those 247 spawns to one.
  //
  // We tag each file with `\echo MIGRATION_BEGIN ...` before its `\i`
  // so a failure can be attributed to the most recently begun file
  // even though psql streams stderr without an `\i` filename prefix.
  // `\set ON_ERROR_STOP 1` mirrors the loop's `-v ON_ERROR_STOP=1`,
  // and `\set ECHO none` keeps the streamed file contents off
  // stdout / stderr (matches `-q`). Same legacy-table cleanup
  // (`DROP TABLE IF EXISTS scorer_credentials`) runs at the end of
  // the same script so it does not need a second spawn either.
  const beginTag = "MIGRATION_BEGIN ";
  const scriptParts: string[] = [
    "\\set ON_ERROR_STOP 1",
    "\\set ECHO none",
  ];
  for (const f of files) {
    scriptParts.push(`\\echo ${beginTag}${f}`);
    // psql `\i` resolves relative to the current directory of the
    // psql process; pass an absolute path to avoid surprises.
    scriptParts.push(`\\i ${join(MIGRATIONS_DIR, f)}`);
  }
  // Same legacy-table cleanup post-merge.sh does so the diff doesn't
  // contain a rename-vs-drop against affiliate_codes (the schema source
  // of truth dropped scorer_credentials but migration 0000 still
  // creates it).
  scriptParts.push("DROP TABLE IF EXISTS scorer_credentials CASCADE;");

  const result = spawnSync("psql", [workspaceUrl, "-q"], {
    input: scriptParts.join("\n") + "\n",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Suppress the chatty NOTICE stream from idempotent re-runs so
      // the only stderr we see is a real ERROR. Matches the per-file
      // loop's PGOPTIONS posture exactly.
      PGOPTIONS: `${process.env.PGOPTIONS ?? ""} -c client_min_messages=warning`.trim(),
    },
  });
  if (result.error) {
    throw new Error(
      `check-migrations-cover-schema: cannot exec psql — ` +
        `${result.error.message}. Install postgres-client or set ` +
        `PSQL on PATH.`,
    );
  }
  const stderr = result.stderr?.toString() ?? "";
  if (result.status !== 0 || stderr.trim().length > 0) {
    // Identify which file we were on when the error fired by scanning
    // the streamed `MIGRATION_BEGIN <file>` echoes on stdout. The last
    // one printed is the file that was being applied when psql aborted.
    const stdout = result.stdout?.toString() ?? "";
    let lastBegun: string | null = null;
    for (const line of stdout.split("\n")) {
      const idx = line.indexOf(beginTag);
      if (idx >= 0) lastBegun = line.slice(idx + beginTag.length).trim();
    }
    const firstStderrLine = stderr
      .split("\n")
      .find((l) => l.trim().length > 0);
    throw new Error(
      `check-migrations-cover-schema: ${lastBegun ?? "<unknown migration>"} ` +
        `failed (psql exit ${result.status ?? "n/a"}): ` +
        `${firstStderrLine?.trim() ?? "(no message)"}. ` +
        `Every numbered migration must apply cleanly under ` +
        `ON_ERROR_STOP=1 (use IF NOT EXISTS / DO ... EXCEPTION blocks ` +
        `or wrap in \\if :post_merge_dep_present so the file no-ops on ` +
        `a fresh DB).`,
    );
  }
}

interface PoolLike {
  query: (s: string) => Promise<unknown>;
  end: () => Promise<void>;
}

/**
 * Collapse all whitespace runs to a single space and trim. drizzle-kit's
 * pushSchema sometimes re-formats DDL across runs (newlines vs. spaces,
 * trailing whitespace) without changing meaning; comparing normalised
 * strings makes the baseline comparison stable.
 */
export function normaliseStatement(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

interface BaselineFile {
  description?: string;
  generatedAt?: string;
  statements: string[];
}

function loadBaseline(): string[] {
  if (!existsSync(BASELINE_FILE)) return [];
  try {
    const raw = readFileSync(BASELINE_FILE, "utf8");
    const parsed = JSON.parse(raw) as BaselineFile;
    if (!Array.isArray(parsed.statements)) {
      throw new Error("`statements` is not an array.");
    }
    return parsed.statements.map(normaliseStatement);
  } catch (err) {
    throw new Error(
      `check-migrations-cover-schema: ${BASELINE_FILE} exists but is ` +
        `unreadable — ${(err as Error).message}.`,
    );
  }
}

export async function runCheck(opts: {
  /**
   * If true, $DATABASE_URL is treated as a fresh empty database we may
   * wipe (CI mode). The script first DROPs and re-creates the public
   * schema for reproducibility, then applies migrations.
   *
   * If false, the script DERIVES a temp DB name from $DATABASE_URL,
   * CREATEs it, applies migrations there, and DROPs it on exit. The
   * dev DB the workspace's tests use is never touched.
   */
  freshDb: boolean;
  databaseUrl: string;
  /**
   * Snapshot the currently-detected drift to BASELINE_FILE and exit 0.
   * Manual-only — never set by CI.
   */
  updateBaseline?: boolean;
}): Promise<{ exitCode: 0 | 1 | 2 }> {
  // Replace process.stdin BEFORE drizzle-kit/api is imported so any
  // Select / ResolveSelect prompt drizzle issues during pushSchema
  // (rename vs. create new, truncate vs. add constraint) gets the safe
  // default — same posture as sync-schema.ts.
  installAutoEnterStdin();

  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
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
  };
  const schema = await import("../src/schema/index.ts");

  let workspaceUrl = opts.databaseUrl;
  let adminPool: PoolLike | null = null;
  let tempDb: string | null = null;

  if (!opts.freshDb) {
    const { base, tail } = parseDatabaseUrl(opts.databaseUrl);
    tempDb = tempDbName();
    workspaceUrl = `${base}${tempDb}${tail}`;
    adminPool = new Pool({ connectionString: opts.databaseUrl, max: 1 });
    try {
      await adminPool.query(`CREATE DATABASE "${tempDb}";`);
    } catch (err) {
      console.error(
        `check-migrations-cover-schema: could not CREATE DATABASE ` +
          `"${tempDb}" against $DATABASE_URL — does the role have ` +
          `CREATEDB?\n  ${(err as Error).message}`,
      );
      await adminPool.end().catch(() => undefined);
      return { exitCode: 2 };
    }
    console.log(
      `check-migrations-cover-schema: created throwaway DB "${tempDb}" ` +
        `(will be dropped on exit).`,
    );
  }

  const pool: PoolLike = new Pool({
    connectionString: workspaceUrl,
    // pushSchema's introspect issues hundreds of per-table queries; a
    // larger pool keeps the wall time on a freshly-migrated 300-table
    // schema in the seconds-not-minutes range. Match sync-schema.ts.
    max: Number(process.env.SYNC_POOL_MAX ?? 32),
  }) as PoolLike;
  const db = drizzle(pool as unknown as InstanceType<typeof Pool>);

  // Wrap drizzle's per-table introspect queries with a bulk-fetch
  // shim. Without it the `Pulling schema from database ...` step in
  // `pushSchema` runs ~400 per-table information_schema joins that
  // each cost ~50 s on the current 300+ table catalog and pushed the
  // total CI wall time well past 90 s — far too slow to gate every
  // PR. The shim collapses those into 2 single bulk queries (per
  // schema), bringing this step from ~70 s to a few seconds. The
  // exact same shim is what `sync-schema.ts` uses for its own slow
  // path; see `bulk-introspect.ts` for the rationale and parity
  // notes.
  installBulkIntrospectShim(
    db as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> },
    pool as unknown as { query: (s: string) => Promise<{ rows: unknown[] }> },
  );

  let exitCode: 0 | 1 | 2 = 0;
  try {
    if (opts.freshDb) {
      // Wipe the public schema so the run is reproducible regardless
      // of what the runner left over from a previous job.
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE;");
      await pool.query("CREATE SCHEMA public;");
      await pool.query("GRANT ALL ON SCHEMA public TO public;");
    }

    applyMigrationsViaPsql(workspaceUrl);

    console.log(
      "check-migrations-cover-schema: introspecting the migrated DB " +
        "and diffing against lib/db/src/schema/ ...",
    );
    const pushed = await drizzleApi.pushSchema(
      schema as Record<string, unknown>,
      db,
    );

    const { real, cosmetic } = classifyDrift(pushed.statementsToExecute);

    if (cosmetic.length > 0) {
      console.log(
        `check-migrations-cover-schema: ignored ${cosmetic.length} ` +
          "cosmetic introspect re-formatting statement(s) (FK rename " +
          "truncation / default literal re-formatting).",
      );
    }

    const realNormalised = real.map(normaliseStatement);

    // Refresh-baseline mode: snapshot whatever drift exists right now and
    // exit 0. Only invoked manually by a maintainer who has either just
    // landed migrations that closed historical drift, or has reviewed and
    // accepted a new chunk of historical drift.
    if (opts.updateBaseline) {
      writeFileSync(
        BASELINE_FILE,
        JSON.stringify(
          {
            description:
              "Auto-generated by lib/db/scripts/check-migrations-cover-schema.ts. " +
              "Each entry is a normalised SQL statement that drizzle-kit's pushSchema " +
              "wants to run against a freshly-migrated DB to make it match " +
              "lib/db/src/schema/. The CI guard fails when statements outside this " +
              "list appear; refresh via UPDATE_BASELINE=1 only after writing real " +
              "migrations to close the gap.",
            generatedAt: new Date().toISOString().split("T")[0],
            statements: realNormalised.slice().sort(),
          },
          null,
          2,
        ) + "\n",
      );
      console.log(
        `check-migrations-cover-schema: wrote baseline of ${realNormalised.length} ` +
          `statement(s) to ${BASELINE_FILE.replace(DB_PKG_DIR + "/", "")}.`,
      );
      exitCode = 0;
      return { exitCode };
    }

    const baseline = loadBaseline();
    const baselineSet = new Set(baseline);
    const newDrift: string[] = [];
    for (const stmt of realNormalised) {
      if (!baselineSet.has(stmt)) newDrift.push(stmt);
    }

    if (baseline.length > 0) {
      const stillCovered = realNormalised.length - newDrift.length;
      console.log(
        `check-migrations-cover-schema: baseline contains ${baseline.length} ` +
          `historical drift statement(s); ${stillCovered} of them still appear in ` +
          `the current diff.`,
      );
    }

    if (newDrift.length === 0) {
      console.log(
        "✓ No new schema drift: every new table/column/type in " +
          "lib/db/src/schema/ is produced by a numbered migration in " +
          "lib/db/drizzle/ (or already accepted via the baseline).",
      );
      exitCode = 0;
    } else {
      const MAX = 50;
      const shown = newDrift.slice(0, MAX);
      const overflow = newDrift.length - shown.length;

      console.error(`
==================================================================
✗ Schema drift: missing numbered migration(s)
==================================================================
lib/db/src/schema/ defines tables/columns/types that no numbered
migration in lib/db/drizzle/ creates. Production only applies the
numbered files, so without a migration these objects will be missing
in production (the same drift that hid Task #579's
\`club_marketing_site_images\` table until Task #1034 caught it).

drizzle would have to run the following DDL on a freshly-migrated
DB to make it match lib/db/src/schema/ — and these statements are
NOT in lib/db/.migration-coverage-baseline.json, so they were
introduced by your change:

${shown.join("\n")}${overflow > 0 ? `\n  … and ${overflow} more.` : ""}

To fix:
  1. Run:    pnpm --filter @workspace/db generate
  2. Review the new file in lib/db/drizzle/ — make sure it is
     idempotent (IF NOT EXISTS, DO blocks for enums) so post-merge
     can replay it safely.
  3. Commit the new SQL file alongside the schema change.

==================================================================`);
      exitCode = 1;
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.error(
      `check-migrations-cover-schema: aborted while talking to Postgres.\n  ${msg}`,
    );
    exitCode = 2;
  } finally {
    await pool.end().catch(() => undefined);
    if (adminPool && tempDb) {
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS "${tempDb}";`);
        console.log(
          `check-migrations-cover-schema: dropped throwaway DB "${tempDb}".`,
        );
      } catch (err) {
        console.warn(
          `check-migrations-cover-schema: could not drop throwaway DB ` +
            `"${tempDb}" — drop it manually.\n  ${(err as Error).message}`,
        );
      } finally {
        await adminPool.end().catch(() => undefined);
      }
    }
  }

  return { exitCode };
}

// Only run main when invoked directly via tsx, not when imported by
// the unit test (or any other module). Comparing the resolved file URL
// of process.argv[1] against import.meta.url is the standard Node 20+
// idiom for "am I the entry point".
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    const entryUrl = new URL(`file://${process.argv[1]}`).href;
    return entryUrl === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  if (!process.env.DATABASE_URL) {
    console.error(
      "check-migrations-cover-schema: DATABASE_URL is not set.\n" +
        "  CI: FRESH_DB=1 DATABASE_URL=postgres://... pnpm --filter @workspace/db check:migrations-cover-schema\n" +
        "  Local: DATABASE_URL=postgres://... pnpm --filter @workspace/db check:migrations-cover-schema",
    );
    process.exit(2);
  }
  const result = await runCheck({
    freshDb: process.env.FRESH_DB === "1",
    databaseUrl: process.env.DATABASE_URL,
    updateBaseline: process.env.UPDATE_BASELINE === "1",
  });
  process.exit(result.exitCode);
}
