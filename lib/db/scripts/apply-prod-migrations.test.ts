#!/usr/bin/env -S tsx
/**
 * End-to-end test for `scripts/apply-prod-migrations.sh`
 * (Tasks #1198, #1389, #1669).
 *
 * The script decides — on every production deploy — whether to apply
 * or skip each numbered migration in `lib/db/drizzle/`. As of Task
 * #1389 it tracks already-applied filenames in a `__deploy_migrations`
 * ledger and runs each unapplied file with `psql -v ON_ERROR_STOP=1`.
 * As of Task #1669 there is no longer ANY tolerated error string —
 * every `psql` ERROR aborts the deploy with the offending file path
 * and the full psql output. A future regression (e.g. someone
 * re-introducing an "already exists" filter, accidentally swallowing a
 * fatal error, or running the apply path against the test DB) would
 * not surface until the next prod deploy.
 *
 * This test exercises the script end-to-end by:
 *   - Copying it into a throwaway REPO_ROOT (so its `dirname $0/..`
 *     based MIGRATIONS_DIR resolution points at our fixture tree
 *     instead of the real `lib/db/drizzle/`). No production code path
 *     needs a test seam — we just stage the script in a tmp tree.
 *   - Planting tiny fixture .sql files under `<tmp>/lib/db/drizzle/`
 *     and shelling out to the staged script with the test env.
 *   - For DB-touching cases, scoping every fixture to a fresh
 *     `apply_prod_migrations_test_<random>` Postgres schema and
 *     dropping it on the way out, so re-runs (and parallel jobs) do
 *     not collide and we never touch the rest of the test DB.
 *   - Seeding the shared `__deploy_migrations` ledger with a sentinel
 *     row before each apply-path scenario so the script's first-run
 *     "backfill every existing file as already-applied" branch is
 *     bypassed and the apply loop actually runs against our fixtures.
 *     The fixture filenames are then deleted from the ledger before
 *     and after each scenario so re-runs (and parallel jobs) start
 *     from a known-clean slate without disturbing anything else.
 *
 * Skip-path cases (no DB needed) cover:
 *   - SKIP_PROD_MIGRATIONS=1 → exit 0, "SKIP_PROD_MIGRATIONS set"
 *   - NODE_ENV unset (no FORCE) → exit 0, "skipping (not a production deploy"
 *   - NODE_ENV=production but DATABASE_URL unset → exit 2, "DATABASE_URL is not set"
 *
 * Apply-path cases require Postgres and run when DATABASE_URL is set
 * (the same env the script itself reads). The CI workflow
 * `.github/workflows/db-migration-coverage.yml` already provisions one;
 * locally this is the dev DB. They cover:
 *   - Clean apply against an empty schema → exit 0, applied=N, skipped=0
 *   - Re-apply (every file already in the ledger) → exit 0, applied=0,
 *     skipped=N — the regression test required by Task #1669 that a
 *     clean re-apply still passes after the tolerated-error branch
 *     was removed
 *   - "already exists" error on an UNAPPLIED file is NOT tolerated →
 *     exit 1, prints offending file (Task #1669 — pins the strict
 *     contract that nothing is silently swallowed any more)
 *   - Fatal SQL syntax error → exit 1, prints offending file path,
 *     failed file is NOT recorded in the ledger so the next deploy
 *     retries it
 *   - "does not exist" error (e.g. DROP TABLE without IF EXISTS) →
 *     exit 1 (every error shape fails the deploy now)
 *
 * Run with:
 *   pnpm --filter @workspace/db exec tsx ./scripts/apply-prod-migrations.test.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const REAL_SCRIPT = join(REPO_ROOT, "scripts/apply-prod-migrations.sh");

const LEDGER_TABLE = '"__deploy_migrations"';
// A sentinel filename used only by this test. Inserting it before
// each apply-path scenario guarantees the ledger is non-empty so the
// script's one-time "backfill every file as already-applied" branch
// (which would skip the test's actual apply path) is bypassed. It is
// namespaced so it cannot collide with any real migration filename.
const LEDGER_SENTINEL = "__apply_prod_migrations_test_sentinel__.sql";

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ FAIL: ${name}${detail ? `\n      ${detail.replace(/\n/g, "\n      ")}` : ""}`);
  }
}

interface StagedScript {
  root: string;
  script: string;
  migrationsDir: string;
  cleanup: () => void;
}

/**
 * Stage the real `apply-prod-migrations.sh` under a throwaway tree so
 * its REPO_ROOT (`dirname $0/..`) resolves to our tmp dir and its
 * MIGRATIONS_DIR resolves to `<tmp>/lib/db/drizzle/`. We copy rather
 * than symlink so the script's own `dirname` lookup is unambiguous.
 */
function stage(): StagedScript {
  const root = mkdtempSync(join(tmpdir(), "apply-prod-mig-test-"));
  const scriptsDir = join(root, "scripts");
  const migrationsDir = join(root, "lib/db/drizzle");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(migrationsDir, { recursive: true });
  const staged = join(scriptsDir, "apply-prod-migrations.sh");
  copyFileSync(REAL_SCRIPT, staged);
  chmodSync(staged, 0o755);
  return {
    root,
    script: staged,
    migrationsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function plant(dir: string, name: string, sql: string): void {
  writeFileSync(join(dir, name), sql);
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  combined: string;
}

function run(scriptPath: string, env: Record<string, string | undefined>): RunResult {
  // Start from a minimal, scrubbed env so a stray DATABASE_URL /
  // NODE_ENV from the calling shell can't leak into the script under
  // test. We only forward what the script genuinely needs (PATH for
  // `psql`, HOME so libpq can find `.pgpass`/`.psqlrc` if any).
  const baseEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete baseEnv[k];
    } else {
      baseEnv[k] = v;
    }
  }
  const r = spawnSync("bash", [scriptPath], {
    env: baseEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    combined: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

function freshSchemaName(): string {
  return `apply_prod_migrations_test_${randomBytes(4).toString("hex")}`;
}

function dropSchema(databaseUrl: string, schema: string): void {
  // Best-effort; never fail the test on cleanup.
  spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-X", "-q",
    "-c", `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

/**
 * Build a sibling URL that points at a different database on the same
 * Postgres server, by swapping the dbname segment of the DATABASE_URL.
 * Used by the empty-ledger gate cases (Task #1667) which need a truly
 * empty DB (no `public.users` table). Schema-level isolation is not
 * enough — the gate's probe is rooted at `public.users`.
 */
function swapDbName(databaseUrl: string, dbName: string): string {
  return databaseUrl.replace(/\/[^/?]+(\?.*)?$/, `/${dbName}$1`);
}

function freshDbName(): string {
  return `apply_prod_migrations_db_${randomBytes(4).toString("hex")}`;
}

/**
 * Returns true if the calling role on the test DB has CREATEDB (so the
 * empty-ledger gate cases can stand up a throwaway database). When
 * false, those cases are skipped with a clear message — local
 * dev DBs commonly grant CREATEDB but managed environments may not.
 */
function canCreateDatabase(databaseUrl: string): boolean {
  const r = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-X", "-q",
    "-t", "-A", "-c",
    "SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user;"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return (r.stdout ?? "").trim().toLowerCase() === "t";
}

function createDb(adminUrl: string, dbName: string): boolean {
  const r = spawnSync("psql", [adminUrl, "-v", "ON_ERROR_STOP=1", "-X", "-q",
    "-c", `CREATE DATABASE "${dbName}";`], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return (r.status ?? -1) === 0;
}

function dropDb(adminUrl: string, dbName: string): void {
  // Best-effort; never fail the test on cleanup.
  spawnSync("psql", [adminUrl, "-v", "ON_ERROR_STOP=1", "-X", "-q",
    "-c", `DROP DATABASE IF EXISTS "${dbName}";`], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

interface PsqlResult {
  status: number;
  output: string;
}

function psqlExec(databaseUrl: string, sql: string): PsqlResult {
  const r = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-c", sql], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function psqlQuery(databaseUrl: string, sql: string): string {
  const r = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-c", sql], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return (r.stdout ?? "").trim();
}

/**
 * Make sure the ledger exists and has at least one row (the sentinel)
 * so the script's one-time backfill branch is bypassed and the apply
 * loop is actually exercised. Idempotent — safe to call once per
 * scenario.
 */
function seedLedger(databaseUrl: string): void {
  psqlExec(databaseUrl, `
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO ${LEDGER_TABLE} (filename) VALUES ('${LEDGER_SENTINEL}')
      ON CONFLICT (filename) DO NOTHING;
  `);
}

/**
 * Remove the given fixture filenames from the ledger so the next
 * scenario starts from a clean "not yet applied" state. Called both
 * before (defensive — clears leftovers from a previous failed run)
 * and after each apply-path scenario.
 */
function clearLedger(databaseUrl: string, filenames: string[]): void {
  if (filenames.length === 0) return;
  const list = filenames.map((f) => `'${f.replace(/'/g, "''")}'`).join(", ");
  psqlExec(databaseUrl, `DELETE FROM ${LEDGER_TABLE} WHERE filename IN (${list});`);
}

function ledgerHas(databaseUrl: string, filename: string): boolean {
  const out = psqlQuery(
    databaseUrl,
    `SELECT 1 FROM ${LEDGER_TABLE} WHERE filename = '${filename.replace(/'/g, "''")}';`,
  );
  return out === "1";
}

// ============================================================================
// Skip-path cases (no DB needed).
// ============================================================================

console.log("\n[skip-path] cases (no DB):");

// Case: SKIP_PROD_MIGRATIONS=1 short-circuits even with NODE_ENV=production.
{
  const s = stage();
  try {
    plant(s.migrationsDir, "0001_would_break.sql", "this is not valid sql at all;");
    const r = run(s.script, {
      SKIP_PROD_MIGRATIONS: "1",
      NODE_ENV: "production",
      DATABASE_URL: "postgres://nobody@nowhere/no-such-db",
    });
    check(
      "SKIP_PROD_MIGRATIONS=1 → exit 0",
      r.status === 0,
      `status=${r.status}\n${r.combined}`,
    );
    check(
      "SKIP_PROD_MIGRATIONS=1 prints expected message",
      /SKIP_PROD_MIGRATIONS set/.test(r.combined),
      r.combined,
    );
  } finally {
    s.cleanup();
  }
}

// Case: NODE_ENV unset (and no FORCE) skips with a clear message.
{
  const s = stage();
  try {
    plant(s.migrationsDir, "0001_would_break.sql", "this is not valid sql at all;");
    const r = run(s.script, {
      NODE_ENV: undefined,
      SKIP_PROD_MIGRATIONS: undefined,
      FORCE_PROD_MIGRATIONS: undefined,
      DATABASE_URL: "postgres://nobody@nowhere/no-such-db",
    });
    check(
      "NODE_ENV unset (no FORCE) → exit 0",
      r.status === 0,
      `status=${r.status}\n${r.combined}`,
    );
    check(
      "NODE_ENV unset prints 'skipping (not a production deploy'",
      /skipping.*not a production deploy/.test(r.combined),
      r.combined,
    );
    check(
      "NODE_ENV unset reports the actual NODE_ENV value",
      /NODE_ENV=unset/.test(r.combined),
      r.combined,
    );
  } finally {
    s.cleanup();
  }
}

// Case: NODE_ENV=development (a common dev-rebuild value) also skips.
{
  const s = stage();
  try {
    plant(s.migrationsDir, "0001_would_break.sql", "this is not valid sql at all;");
    const r = run(s.script, {
      NODE_ENV: "development",
      SKIP_PROD_MIGRATIONS: undefined,
      FORCE_PROD_MIGRATIONS: undefined,
      DATABASE_URL: "postgres://nobody@nowhere/no-such-db",
    });
    check(
      "NODE_ENV=development → exit 0",
      r.status === 0,
      `status=${r.status}\n${r.combined}`,
    );
    check(
      "NODE_ENV=development reports 'NODE_ENV=development'",
      /NODE_ENV=development/.test(r.combined),
      r.combined,
    );
  } finally {
    s.cleanup();
  }
}

// Case: NODE_ENV=production but DATABASE_URL missing → exit 2 + clear error.
// The exit code (2, not 1) is part of the contract: it distinguishes a
// pre-flight config failure from a real migration failure (1) so the
// deploy log makes it obvious the script never even tried to apply.
{
  const s = stage();
  try {
    plant(s.migrationsDir, "0001_noop.sql", "SELECT 1;");
    const r = run(s.script, {
      NODE_ENV: "production",
      SKIP_PROD_MIGRATIONS: undefined,
      DATABASE_URL: undefined,
    });
    check(
      "NODE_ENV=production + DATABASE_URL unset → exit 2",
      r.status === 2,
      `status=${r.status}\n${r.combined}`,
    );
    check(
      "missing DATABASE_URL prints expected error",
      /DATABASE_URL is not set/.test(r.combined),
      r.combined,
    );
  } finally {
    s.cleanup();
  }
}

// Case: FORCE_PROD_MIGRATIONS=1 also requires DATABASE_URL and exits 2 if missing.
// (Same gate, different trigger — guards against a regression where
// the FORCE override accidentally bypasses the DATABASE_URL check.)
{
  const s = stage();
  try {
    plant(s.migrationsDir, "0001_noop.sql", "SELECT 1;");
    const r = run(s.script, {
      FORCE_PROD_MIGRATIONS: "1",
      NODE_ENV: undefined,
      SKIP_PROD_MIGRATIONS: undefined,
      DATABASE_URL: undefined,
    });
    check(
      "FORCE_PROD_MIGRATIONS=1 + DATABASE_URL unset → exit 2",
      r.status === 2,
      `status=${r.status}\n${r.combined}`,
    );
    check(
      "FORCE_PROD_MIGRATIONS=1 + missing DATABASE_URL prints expected error",
      /DATABASE_URL is not set/.test(r.combined),
      r.combined,
    );
  } finally {
    s.cleanup();
  }
}

// ============================================================================
// Apply-path cases (need a real Postgres). Skip with a loud message if
// DATABASE_URL is unset so the suite still passes locally without one.
// CI (db-migration-coverage.yml) provisions Postgres and DATABASE_URL.
// ============================================================================

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    "\n[apply-path] SKIPPED: DATABASE_URL not set. " +
      "CI provisions one via .github/workflows/db-migration-coverage.yml; " +
      "set DATABASE_URL locally to exercise these cases.",
  );
} else {
  console.log("\n[apply-path] cases (against $DATABASE_URL):");

  // Defensive pre-clean: drop any leftover ledger table from a prior
  // failed run so this run starts from a known-clean state. The
  // ledger is purely a test artifact on the dev DB — it is not part
  // of the application schema, so sync-schema (post-merge.sh) sees
  // it as drift and refuses to apply changes if we leave it behind.
  // We therefore also drop it again at the end of the apply-path
  // block (see finally{} below) so a clean run never leaks state.
  psqlExec(DATABASE_URL, `DROP TABLE IF EXISTS ${LEDGER_TABLE};`);

  // Case: clean apply on an empty schema, then a re-apply where every
  // file is in the ledger. This is the Task #1669 regression test —
  // after the tolerated-error branch was removed, a clean re-apply must
  // still pass (every file is skipped via the ledger; no psql ERROR
  // lines emitted at all).
  {
    const s = stage();
    const schema = freshSchemaName();
    const fixtures = ["0001_init.sql", "0002_add_index.sql"];
    seedLedger(DATABASE_URL);
    clearLedger(DATABASE_URL, fixtures);
    try {
      // 0001 creates the schema, 0002 creates a table inside it.
      // Both use IF NOT EXISTS so a second run is a clean no-op.
      plant(s.migrationsDir, "0001_init.sql",
        `CREATE SCHEMA IF NOT EXISTS "${schema}";\n` +
        `CREATE TABLE IF NOT EXISTS "${schema}"."foo" (id serial PRIMARY KEY, name text);\n`,
      );
      plant(s.migrationsDir, "0002_add_index.sql",
        `CREATE INDEX IF NOT EXISTS "${schema}_foo_name_idx" ON "${schema}"."foo" (name);\n`,
      );
      const r = run(s.script, {
        NODE_ENV: "production",
        DATABASE_URL,
      });
      check(
        "clean apply on empty schema → exit 0",
        r.status === 0,
        `status=${r.status}\n${r.combined}`,
      );
      check(
        "clean apply summary reports applied=2, skipped=0",
        /applied=2,\s*skipped \(already in ledger\)=0,\s*total=2/.test(r.combined),
        r.combined,
      );
      check(
        "clean apply records both fixtures in the ledger",
        ledgerHas(DATABASE_URL, "0001_init.sql") && ledgerHas(DATABASE_URL, "0002_add_index.sql"),
        `0001 in ledger=${ledgerHas(DATABASE_URL, "0001_init.sql")}, 0002 in ledger=${ledgerHas(DATABASE_URL, "0002_add_index.sql")}`,
      );

      // Re-apply (Task #1669 regression test): both files are in the
      // ledger so the script skips them outright. There are no psql
      // ERROR lines to "tolerate" — the apply loop never even invokes
      // psql for these files. Exit must still be 0.
      const r2 = run(s.script, {
        NODE_ENV: "production",
        DATABASE_URL,
      });
      check(
        "clean re-apply (every file in ledger) → exit 0",
        r2.status === 0,
        `status=${r2.status}\n${r2.combined}`,
      );
      check(
        "clean re-apply summary reports applied=0, skipped=2",
        /applied=0,\s*skipped \(already in ledger\)=2,\s*total=2/.test(r2.combined),
        r2.combined,
      );
    } finally {
      clearLedger(DATABASE_URL, fixtures);
      dropSchema(DATABASE_URL, schema);
      s.cleanup();
    }
  }

  // Case (Task #1669 — strict-error contract): an UNAPPLIED file that
  // raises "relation already exists" must FAIL the deploy. Pre-Task
  // #1669 the script tolerated that exact error string (a fragile
  // heuristic that would silently swallow a typo'd new migration);
  // every error is now fatal, regardless of shape. We force this by
  // pre-creating the table out-of-band, then running a CREATE TABLE
  // (no IF NOT EXISTS) on it through the script.
  {
    const s = stage();
    const schema = freshSchemaName();
    const fixtures = ["0001_setup.sql", "0002_create_existing.sql"];
    seedLedger(DATABASE_URL);
    clearLedger(DATABASE_URL, fixtures);
    try {
      plant(s.migrationsDir, "0001_setup.sql",
        `CREATE SCHEMA IF NOT EXISTS "${schema}";\n`,
      );
      plant(s.migrationsDir, "0002_create_existing.sql",
        `CREATE TABLE "${schema}"."already_here" (id serial PRIMARY KEY);\n`,
      );
      // Pre-create the schema and table so 0002 will hit
      // "relation ... already exists" when the script runs it.
      psqlExec(DATABASE_URL, `
        CREATE SCHEMA IF NOT EXISTS "${schema}";
        CREATE TABLE "${schema}"."already_here" (id serial PRIMARY KEY);
      `);
      const r = run(s.script, { NODE_ENV: "production", DATABASE_URL });
      check(
        "'already exists' on unapplied file → non-zero exit (NOT tolerated)",
        r.status !== 0,
        `status=${r.status}\n${r.combined}`,
      );
      check(
        "'already exists' failure prints the offending file path",
        /0002_create_existing\.sql/.test(r.combined),
        r.combined,
      );
      check(
        "'already exists' failure prints 'Production migration FAILED'",
        /Production migration FAILED/.test(r.combined),
        r.combined,
      );
      check(
        "'already exists' failure surfaces the underlying psql error",
        /already exists/i.test(r.combined),
        r.combined,
      );
      check(
        "failed file is NOT recorded in the ledger (next deploy retries)",
        !ledgerHas(DATABASE_URL, "0002_create_existing.sql"),
        "0002_create_existing.sql is in the ledger but should not be",
      );
    } finally {
      clearLedger(DATABASE_URL, fixtures);
      dropSchema(DATABASE_URL, schema);
      s.cleanup();
    }
  }

  // Case: a real syntax error fails the deploy loudly and names the
  // offending file. This is the regression we most want to catch — a
  // future change loosening the error filter must not hide a fatal
  // error.
  {
    const s = stage();
    const schema = freshSchemaName();
    const fixtures = ["0001_setup.sql", "0002_broken_syntax.sql"];
    seedLedger(DATABASE_URL);
    clearLedger(DATABASE_URL, fixtures);
    try {
      plant(s.migrationsDir, "0001_setup.sql",
        `CREATE SCHEMA IF NOT EXISTS "${schema}";\n`,
      );
      plant(s.migrationsDir, "0002_broken_syntax.sql",
        `CREATE TABLE "${schema}"."broken" (this is not valid sql at all);\n`,
      );
      const r = run(s.script, { NODE_ENV: "production", DATABASE_URL });
      check(
        "syntax error → non-zero exit",
        r.status !== 0,
        `status=${r.status}\n${r.combined}`,
      );
      check(
        "syntax-error failure prints the offending file path",
        /0002_broken_syntax\.sql/.test(r.combined),
        r.combined,
      );
      check(
        "syntax-error failure prints 'Production migration FAILED'",
        /Production migration FAILED/.test(r.combined),
        r.combined,
      );
      check(
        "successful prior file IS in the ledger",
        ledgerHas(DATABASE_URL, "0001_setup.sql"),
        "0001_setup.sql should be in the ledger after a successful apply",
      );
      check(
        "failed file is NOT in the ledger (next deploy retries)",
        !ledgerHas(DATABASE_URL, "0002_broken_syntax.sql"),
        "0002_broken_syntax.sql is in the ledger but should not be",
      );
    } finally {
      clearLedger(DATABASE_URL, fixtures);
      dropSchema(DATABASE_URL, schema);
      s.cleanup();
    }
  }

  // Case: a "does not exist" error must also fail the deploy. As of
  // Task #1669 every error shape is fatal — there are no tolerated
  // strings — so DROP TABLE without IF EXISTS against a missing
  // relation must abort, not silently skip.
  {
    const s = stage();
    const schema = freshSchemaName();
    const fixtures = ["0001_setup.sql", "0002_drop_missing.sql"];
    seedLedger(DATABASE_URL);
    clearLedger(DATABASE_URL, fixtures);
    try {
      plant(s.migrationsDir, "0001_setup.sql",
        `CREATE SCHEMA IF NOT EXISTS "${schema}";\n`,
      );
      plant(s.migrationsDir, "0002_drop_missing.sql",
        `DROP TABLE "${schema}"."does_not_exist_anywhere";\n`,
      );
      const r = run(s.script, { NODE_ENV: "production", DATABASE_URL });
      check(
        "'does not exist' error → non-zero exit",
        r.status !== 0,
        `status=${r.status}\n${r.combined}`,
      );
      check(
        "'does not exist' failure prints the offending file path",
        /0002_drop_missing\.sql/.test(r.combined),
        r.combined,
      );
    } finally {
      clearLedger(DATABASE_URL, fixtures);
      dropSchema(DATABASE_URL, schema);
      s.cleanup();
    }
  }

  // Final cleanup: drop the ledger table we created on the dev DB so
  // sync-schema (which doesn't know about __deploy_migrations and
  // shouldn't — it's runtime bookkeeping owned by
  // apply-prod-migrations.sh, not application schema) doesn't report
  // it as drift on the next post-merge run. The Task #1667 gate
  // cases below use scratch databases and clean themselves up.
  psqlExec(DATABASE_URL, `DROP TABLE IF EXISTS ${LEDGER_TABLE};`);

  // ==========================================================================
  // Empty-ledger backfill gate (Task #1667).
  //
  // Pre-#1667 the script auto-backfilled the ledger whenever
  // `count(*) = 0`, which is correct for the existing prod DB (schema
  // present, ledger never populated) but a footgun for any brand-new
  // or restored-from-backup DB the same script is later pointed at:
  // every migration would be silently marked as already-applied
  // without ever being executed, leaving an empty schema that thinks
  // it's fully migrated.
  //
  // The gate now requires evidence the schema is in fact present
  // (`public.users` exists) before backfilling, OR an explicit
  // `ALLOW_EMPTY_LEDGER_BACKFILL=1` operator override.
  //
  // These cases need a *different* database than the test DB (which
  // has a populated `public.users`), so we stand up a throwaway DB
  // alongside the test DB and tear it down on the way out. If the
  // test role lacks CREATEDB we skip with a clear message.
  // ==========================================================================
  if (!canCreateDatabase(DATABASE_URL)) {
    console.warn(
      "\n[empty-ledger-gate] SKIPPED: test role lacks CREATEDB. " +
        "Grant CREATEDB to exercise the Task #1667 gate cases.",
    );
  } else {
    console.log("\n[empty-ledger-gate] cases (Task #1667):");

    // Case: empty DB (no public.users), no override → exit 2 with the
    // documented refusal message. This is the headline regression
    // guard — if a future change loosens the gate, this case will
    // catch it before it reaches a real disaster-recovery deploy.
    {
      const s = stage();
      const dbName = freshDbName();
      const scratchUrl = swapDbName(DATABASE_URL, dbName);
      let created = false;
      try {
        created = createDb(DATABASE_URL, dbName);
        check(`scratch DB '${dbName}' created`, created);
        if (created) {
          plant(s.migrationsDir, "0001_widget.sql",
            `CREATE TABLE IF NOT EXISTS "widget" (id serial PRIMARY KEY);\n`,
          );
          const r = run(s.script, {
            NODE_ENV: "production",
            DATABASE_URL: scratchUrl,
          });
          check(
            "empty DB + no override → exit 2 (refuses to backfill)",
            r.status === 2,
            `status=${r.status}\n${r.combined}`,
          );
          check(
            "refusal names the missing baseline relation",
            /public\.users/.test(r.combined),
            r.combined,
          );
          check(
            "refusal points at ALLOW_EMPTY_LEDGER_BACKFILL override",
            /ALLOW_EMPTY_LEDGER_BACKFILL=1/.test(r.combined),
            r.combined,
          );
          check(
            "refusal points at the runbook (docs/db-test-sync.md)",
            /docs\/db-test-sync\.md/.test(r.combined),
            r.combined,
          );
          // The widget table must NOT have been created — the script
          // exited before any apply step ran.
          const probe = spawnSync("psql", [scratchUrl, "-X", "-q", "-t", "-A",
            "-c", "SELECT to_regclass('public.widget') IS NOT NULL;"],
            { encoding: "utf8", timeout: 10_000 });
          check(
            "no migration was actually applied during the refusal",
            (probe.stdout ?? "").trim() === "f",
            `widget exists=${(probe.stdout ?? "").trim()}`,
          );
        }
      } finally {
        if (created) dropDb(DATABASE_URL, dbName);
        s.cleanup();
      }
    }

    // Case: empty DB + ALLOW_EMPTY_LEDGER_BACKFILL=1 → backfill runs.
    // This is the documented operator override for the rare case
    // where the schema is genuinely present but `public.users` is
    // not the right probe (renamed / non-default search_path).
    {
      const s = stage();
      const dbName = freshDbName();
      const scratchUrl = swapDbName(DATABASE_URL, dbName);
      let created = false;
      try {
        created = createDb(DATABASE_URL, dbName);
        check(`scratch DB '${dbName}' created`, created);
        if (created) {
          plant(s.migrationsDir, "0001_widget.sql",
            `CREATE TABLE IF NOT EXISTS "widget" (id serial PRIMARY KEY);\n`,
          );
          const r = run(s.script, {
            NODE_ENV: "production",
            DATABASE_URL: scratchUrl,
            ALLOW_EMPTY_LEDGER_BACKFILL: "1",
          });
          check(
            "empty DB + ALLOW_EMPTY_LEDGER_BACKFILL=1 → exit 0",
            r.status === 0,
            `status=${r.status}\n${r.combined}`,
          );
          check(
            "override path logs the operator-override reason",
            /ALLOW_EMPTY_LEDGER_BACKFILL=1 set/.test(r.combined),
            r.combined,
          );
          check(
            "override backfilled, did not actually run the migration",
            /backfilled 1 entries/.test(r.combined),
            r.combined,
          );
        }
      } finally {
        if (created) dropDb(DATABASE_URL, dbName);
        s.cleanup();
      }
    }

    // Case (Task #2071): empty DB + BOOTSTRAP_FRESH_DB=1 → the script
    // self-bootstraps the schema by actually running every numbered
    // migration in `lib/db/drizzle/` from scratch (NOT a backfill)
    // inside a single transaction, then records each filename in the
    // ledger. Verifies (1) exit 0, (2) every planted table actually
    // exists afterwards (proves migrations executed, not just
    // recorded), (3) every fixture is in the ledger.
    {
      const s = stage();
      const dbName = freshDbName();
      const scratchUrl = swapDbName(DATABASE_URL, dbName);
      let created = false;
      try {
        created = createDb(DATABASE_URL, dbName);
        check(`scratch DB '${dbName}' created`, created);
        if (created) {
          // Three real-shaped DDL files: a CREATE TABLE, another
          // CREATE TABLE, and a CREATE INDEX on the first. Together
          // they prove the bootstrap actually executes each file
          // (not just records its name) AND that the script's
          // sorted apply order is honoured (the index in 0003
          // depends on the table from 0001).
          plant(s.migrationsDir, "0001_widgets.sql",
            `CREATE TABLE "widgets" (id serial PRIMARY KEY, name text NOT NULL);\n`,
          );
          plant(s.migrationsDir, "0002_gadgets.sql",
            `CREATE TABLE "gadgets" (id serial PRIMARY KEY, sku text NOT NULL UNIQUE);\n`,
          );
          plant(s.migrationsDir, "0003_widgets_index.sql",
            `CREATE INDEX "widgets_name_idx" ON "widgets" (name);\n`,
          );
          const r = run(s.script, {
            NODE_ENV: "production",
            DATABASE_URL: scratchUrl,
            BOOTSTRAP_FRESH_DB: "1",
          });
          check(
            "empty DB + BOOTSTRAP_FRESH_DB=1 → exit 0",
            r.status === 0,
            `status=${r.status}\n${r.combined}`,
          );
          check(
            "bootstrap path announces single-transaction apply",
            /BOOTSTRAP_FRESH_DB=1.*single transaction/s.test(r.combined),
            r.combined,
          );
          check(
            "bootstrap path emits per-file '\\echo Applying' markers",
            /Applying 0001_widgets\.sql/.test(r.combined)
              && /Applying 0002_gadgets\.sql/.test(r.combined)
              && /Applying 0003_widgets_index\.sql/.test(r.combined),
            r.combined,
          );
          check(
            "bootstrap path prints commit summary",
            /bootstrap committed 3 migration\(s\)/.test(r.combined),
            r.combined,
          );

          // Each fixture's table/index must actually exist. These
          // probes are the headline assertion — recording filenames
          // in the ledger without executing them was the whole
          // footgun the gate is designed to prevent.
          const widgetExists = (spawnSync("psql", [scratchUrl, "-X", "-q",
            "-t", "-A", "-c",
            "SELECT to_regclass('public.widgets') IS NOT NULL;"],
            { encoding: "utf8", timeout: 10_000 }).stdout ?? "").trim();
          check(
            "bootstrap actually CREATEd table 'widgets'",
            widgetExists === "t",
            `widgets exists=${widgetExists}`,
          );
          const gadgetExists = (spawnSync("psql", [scratchUrl, "-X", "-q",
            "-t", "-A", "-c",
            "SELECT to_regclass('public.gadgets') IS NOT NULL;"],
            { encoding: "utf8", timeout: 10_000 }).stdout ?? "").trim();
          check(
            "bootstrap actually CREATEd table 'gadgets'",
            gadgetExists === "t",
            `gadgets exists=${gadgetExists}`,
          );
          const idxExists = (spawnSync("psql", [scratchUrl, "-X", "-q",
            "-t", "-A", "-c",
            "SELECT to_regclass('public.widgets_name_idx') IS NOT NULL;"],
            { encoding: "utf8", timeout: 10_000 }).stdout ?? "").trim();
          check(
            "bootstrap actually CREATEd index 'widgets_name_idx'",
            idxExists === "t",
            `widgets_name_idx exists=${idxExists}`,
          );

          // And every fixture must be recorded in the ledger so a
          // re-run is a clean no-op (the apply loop will skip them
          // all).
          check(
            "bootstrap recorded every fixture in the ledger",
            ledgerHas(scratchUrl, "0001_widgets.sql")
              && ledgerHas(scratchUrl, "0002_gadgets.sql")
              && ledgerHas(scratchUrl, "0003_widgets_index.sql"),
            `0001=${ledgerHas(scratchUrl, "0001_widgets.sql")}, ` +
              `0002=${ledgerHas(scratchUrl, "0002_gadgets.sql")}, ` +
              `0003=${ledgerHas(scratchUrl, "0003_widgets_index.sql")}`,
          );

          // Re-run should be a clean no-op: schema is now populated
          // (auto-detected via baseline probe), ledger has every
          // file, apply loop skips everything.
          const r2 = run(s.script, {
            NODE_ENV: "production",
            DATABASE_URL: scratchUrl,
          });
          check(
            "post-bootstrap re-run → exit 0 (everything already in ledger)",
            r2.status === 0,
            `status=${r2.status}\n${r2.combined}`,
          );
          check(
            "post-bootstrap re-run reports applied=0, skipped=3",
            /applied=0,\s*skipped \(already in ledger\)=3,\s*total=3/.test(r2.combined),
            r2.combined,
          );
        }
      } finally {
        if (created) dropDb(DATABASE_URL, dbName);
        s.cleanup();
      }
    }

    // Case (Task #2071 — failure mode): a broken file mid-bootstrap
    // rolls the whole transaction back. Nothing planted from earlier
    // files persists, and the ledger remains empty.
    {
      const s = stage();
      const dbName = freshDbName();
      const scratchUrl = swapDbName(DATABASE_URL, dbName);
      let created = false;
      try {
        created = createDb(DATABASE_URL, dbName);
        check(`scratch DB '${dbName}' created`, created);
        if (created) {
          plant(s.migrationsDir, "0001_widgets.sql",
            `CREATE TABLE "widgets" (id serial PRIMARY KEY);\n`,
          );
          plant(s.migrationsDir, "0002_broken.sql",
            `CREATE TABLE "broken" (this is not valid sql at all);\n`,
          );
          plant(s.migrationsDir, "0003_gadgets.sql",
            `CREATE TABLE "gadgets" (id serial PRIMARY KEY);\n`,
          );
          const r = run(s.script, {
            NODE_ENV: "production",
            DATABASE_URL: scratchUrl,
            BOOTSTRAP_FRESH_DB: "1",
          });
          check(
            "bootstrap with a broken file → non-zero exit",
            r.status !== 0,
            `status=${r.status}\n${r.combined}`,
          );
          check(
            "bootstrap failure prints 'BOOTSTRAP_FRESH_DB' failure header",
            /BOOTSTRAP_FRESH_DB:\s*bootstrap apply FAILED/.test(r.combined),
            r.combined,
          );
          check(
            "bootstrap failure surfaces the failing file name",
            /Applying 0002_broken\.sql/.test(r.combined),
            r.combined,
          );
          check(
            "bootstrap failure says the transaction was rolled back",
            /rolled back/i.test(r.combined),
            r.combined,
          );

          // Transaction rollback is the headline guarantee: 'widgets'
          // was created in the same transaction as the failing file,
          // so it must NOT exist on the DB after the rollback.
          const widgetExists = (spawnSync("psql", [scratchUrl, "-X", "-q",
            "-t", "-A", "-c",
            "SELECT to_regclass('public.widgets') IS NOT NULL;"],
            { encoding: "utf8", timeout: 10_000 }).stdout ?? "").trim();
          check(
            "rollback: 'widgets' from earlier file does NOT persist",
            widgetExists === "f",
            `widgets exists=${widgetExists}`,
          );

          // And the ledger must be empty (the script's own CREATE
          // TABLE for the ledger happens BEFORE the bootstrap txn
          // and so does persist, but the rows do not).
          const ledgerCount = psqlQuery(scratchUrl,
            `SELECT count(*)::int FROM ${LEDGER_TABLE};`);
          check(
            "rollback: ledger has zero rows after a failed bootstrap",
            ledgerCount === "0",
            `ledger row count=${ledgerCount}`,
          );
        }
      } finally {
        if (created) dropDb(DATABASE_URL, dbName);
        s.cleanup();
      }
    }

    // Case (Task #2071 — refusal message advertises the new flag):
    // the greenfield refusal must mention BOOTSTRAP_FRESH_DB=1 as an
    // alternative to the manual post-merge.sh path. This is a
    // contract test — the docs reference it as the discoverable
    // entry point, so a regression that removes the mention would
    // strand operators on the runbook again.
    {
      const s = stage();
      const dbName = freshDbName();
      const scratchUrl = swapDbName(DATABASE_URL, dbName);
      let created = false;
      try {
        created = createDb(DATABASE_URL, dbName);
        check(`scratch DB '${dbName}' created`, created);
        if (created) {
          plant(s.migrationsDir, "0001_widget.sql",
            `CREATE TABLE IF NOT EXISTS "widget" (id serial PRIMARY KEY);\n`,
          );
          const r = run(s.script, {
            NODE_ENV: "production",
            DATABASE_URL: scratchUrl,
          });
          check(
            "refusal message mentions BOOTSTRAP_FRESH_DB=1",
            /BOOTSTRAP_FRESH_DB=1/.test(r.combined),
            r.combined,
          );
        }
      } finally {
        if (created) dropDb(DATABASE_URL, dbName);
        s.cleanup();
      }
    }

    // Case: empty DB but `public.users` exists → auto-detected as
    // pre-#1389 prod, backfill runs without override. Reproduces the
    // existing-prod first-deploy path that must keep working.
    {
      const s = stage();
      const dbName = freshDbName();
      const scratchUrl = swapDbName(DATABASE_URL, dbName);
      let created = false;
      try {
        created = createDb(DATABASE_URL, dbName);
        check(`scratch DB '${dbName}' created`, created);
        if (created) {
          // Plant a baseline `users` table — the gate's probe is
          // `to_regclass('public.users') IS NOT NULL`.
          spawnSync("psql", [scratchUrl, "-v", "ON_ERROR_STOP=1", "-X", "-q",
            "-c", "CREATE TABLE users (id serial PRIMARY KEY);"],
            { encoding: "utf8", timeout: 10_000 });

          plant(s.migrationsDir, "0001_widget.sql",
            `CREATE TABLE IF NOT EXISTS "widget" (id serial PRIMARY KEY);\n`,
          );
          const r = run(s.script, {
            NODE_ENV: "production",
            DATABASE_URL: scratchUrl,
          });
          check(
            "schema present (users exists) → exit 0, backfill auto-runs",
            r.status === 0,
            `status=${r.status}\n${r.combined}`,
          );
          check(
            "auto-detect path logs the baseline-present reason",
            /baseline 'public\.users' table is present/.test(r.combined),
            r.combined,
          );
        }
      } finally {
        if (created) dropDb(DATABASE_URL, dbName);
        s.cleanup();
      }
    }
  }
}

if (failed > 0) {
  console.error(`\napply-prod-migrations: ${failed} case(s) failed`);
  process.exit(1);
}
console.log(
  "\n✓ apply-prod-migrations: skip-path messages and exit codes hold; " +
    (DATABASE_URL
      ? "clean apply + clean re-apply succeed; every psql ERROR (including 'already exists' and 'does not exist') fails the deploy with the offending file."
      : "apply-path cases skipped (no DATABASE_URL)."),
);
