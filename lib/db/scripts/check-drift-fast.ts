#!/usr/bin/env -S tsx
/**
 * Fast pre-test drift check.
 *
 * Pairs with `sync-schema.ts`: when sync converges the live DB to the
 * current schema it writes a JSON snapshot + migration-filenames guard
 * into `lib/db/.sync-cache/`. On the next drift check we can diff that
 * cached snapshot against `generateDrizzleJson(schema)` in pure JS via
 * `generateMigration(prev, cur)` — no `pg_dump`, no throwaway DB, no
 * `drizzle-kit push --verbose` reintrospection — and report drift in a
 * couple of seconds instead of ~90 s.
 *
 * Exit codes:
 *   0 = clean (cache hit, diff is empty or only cosmetic re-formatting).
 *   1 = drift detected (cache hit, diff contains substantive DDL).
 *       The shell wrapper prints the standard catch-up pointer.
 *   3 = cache miss (cold container, missing snapshot, or a new numbered
 *       migration landed). The shell wrapper falls back to the existing
 *       slow path so we never miss out-of-band DDL after a migration.
 *   2 = misconfiguration (e.g. DATABASE_URL missing — kept consistent
 *       with the shell script's exit codes).
 *
 * The cosmetic-suppression rules mirror `sync-schema.ts` and
 * `scripts/check-db-drift.sh` exactly so all three agree on what counts
 * as real drift.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const drizzleApi = (await import("drizzle-kit/api")) as {
  generateDrizzleJson: (imports: Record<string, unknown>) => unknown;
  generateMigration: (prev: unknown, cur: unknown) => Promise<string[]>;
};
const schema = await import("../src/schema/index.ts");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DB_PKG_DIR = dirname(SCRIPT_DIR);
const MIGRATIONS_DIR = join(DB_PKG_DIR, "drizzle");
const DEFAULT_CACHE_DIR = join(DB_PKG_DIR, ".sync-cache");
const SYNC_SNAPSHOT_FILE =
  process.env.SYNC_SNAPSHOT_FILE ?? join(DEFAULT_CACHE_DIR, "snapshot.json");
const SYNC_SNAPSHOT_GUARD_FILE =
  process.env.SYNC_SNAPSHOT_GUARD_FILE ??
  join(DEFAULT_CACHE_DIR, "snapshot.guard");
const FORCE_INTROSPECT =
  process.env.POST_MERGE_FORCE_INTROSPECT === "1" ||
  process.env.POST_MERGE_FORCE_SYNC === "1" ||
  process.env.DRIFT_CHECK_FORCE_SLOW === "1";

const DOCS_REF = "docs/db-test-sync.md";

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set.");
  process.exit(2);
}

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

// Strict parity with the slow path in `scripts/check-db-drift.sh`:
// the shell filter only suppresses `SET DEFAULT` re-formatting churn
// (jsonb / ARRAY[...] / text[] literal shapes drizzle re-emits on every
// introspect). It does NOT suppress cosmetic `DROP CONSTRAINT` rename
// churn, because Task #570's `0059_canonicalize_fk_names.sql` already
// cleans those up at the schema level — any new long-name FK reaching
// here should surface as real drift to be fixed in a numbered
// migration. Keep the same posture on the fast path so a brand-new
// long-named constraint cannot slip past pretest just because the cache
// was warm.
const COSMETIC_SET_DEFAULT =
  /\bALTER\s+COLUMN\s+"[^"]+"\s+SET\s+DEFAULT\s+(?:ARRAY\[[^\]]*\](?:\s*::\s*[a-zA-Z_]+(?:\[\])?)?|'[^']*'::(?:jsonb|text\[\]|[a-zA-Z_]+\[\]))\s*;?\s*$/i;

function isCosmetic(s: string): boolean {
  return COSMETIC_SET_DEFAULT.test(s);
}

const cachedPrev = readCachedSnapshot();
if (cachedPrev === null) {
  if (FORCE_INTROSPECT) {
    console.log(
      "check-drift-fast: forced slow path (DRIFT_CHECK_FORCE_SLOW / POST_MERGE_FORCE_INTROSPECT).",
    );
  } else {
    console.log(
      "check-drift-fast: snapshot cache miss — falling back to slow introspect.",
    );
  }
  process.exit(3);
}

const cur = drizzleApi.generateDrizzleJson(schema as Record<string, unknown>);
const statements = await drizzleApi.generateMigration(cachedPrev, cur);
const real = statements.filter((s) => !isCosmetic(s));

if (real.length === 0) {
  if (statements.length > 0) {
    console.log(
      `✓ DB schema matches lib/db/src/schema/golf.ts ` +
        `(only ${statements.length} cosmetic SET DEFAULT / FK rename ` +
        `re-formatting statement(s); ignored).`,
    );
  } else {
    console.log(
      "✓ DB schema matches lib/db/src/schema/golf.ts (no drift, fast path).",
    );
  }
  process.exit(0);
}

console.error(`
==================================================================
✗ Database schema drift detected (fast diff path)
==================================================================
The current schema differs from the snapshot the DB was last synced
to. drizzle would have to run the following DDL to bring it back in
sync:

${real.map((s) => s.replace(/\s+/g, " ").trim()).join("\n")}

To resolve, follow the catch-up flow documented in:
  ${DOCS_REF}

In short:
  pnpm --filter @workspace/db sync
  # or, if a destructive change is intended:
  ALLOW_SCHEMA_DATA_LOSS=1 pnpm --filter @workspace/db sync

Re-run this check after the catch-up to confirm a clean state.
==================================================================`);
process.exit(1);
