#!/usr/bin/env -S tsx
/**
 * Focused unit test for the diff/classify pipeline used by
 * `check-drift-fast.ts`. We synthesise two pairs of drizzle snapshots
 * (one substantive, one cosmetic-only) and run them through the same
 * `generateMigration` + cosmetic-suppression filter the fast script
 * uses, asserting the resulting exit-code intent:
 *
 *   substantive drift  → real.length > 0  → script would exit 1.
 *   cosmetic-only diff → real.length === 0 → script would exit 0.
 *
 * No DB connection; runs in seconds.
 *
 * Run with:
 *   pnpm --filter @workspace/db exec tsx ./scripts/check-drift-fast.test.ts
 */

import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  varchar,
} from "drizzle-orm/pg-core";

const drizzleApi = (await import("drizzle-kit/api")) as {
  generateDrizzleJson: (imports: Record<string, unknown>) => unknown;
  generateMigration: (prev: unknown, cur: unknown) => Promise<string[]>;
};

// Mirror the cosmetic suppression in `check-drift-fast.ts` byte-for-byte.
const COSMETIC_SET_DEFAULT =
  /\bALTER\s+COLUMN\s+"[^"]+"\s+SET\s+DEFAULT\s+(?:ARRAY\[[^\]]*\](?:\s*::\s*[a-zA-Z_]+(?:\[\])?)?|'[^']*'::(?:jsonb|text\[\]|[a-zA-Z_]+\[\]))\s*;?\s*$/i;

function isCosmetic(s: string): boolean {
  return COSMETIC_SET_DEFAULT.test(s);
}

async function diff(
  prev: Record<string, unknown>,
  cur: Record<string, unknown>,
): Promise<{ statements: string[]; real: string[] }> {
  const prevSnap = drizzleApi.generateDrizzleJson(prev);
  const curSnap = drizzleApi.generateDrizzleJson(cur);
  const statements = await drizzleApi.generateMigration(prevSnap, curSnap);
  const real = statements.filter((s) => !isCosmetic(s));
  return { statements, real };
}

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (!ok) {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- Case 1: substantive drift — ADD COLUMN ------------------------------
{
  const prev = {
    members: pgTable("members", {
      id: serial("id").primaryKey(),
      name: varchar("name", { length: 64 }).notNull(),
    }),
  };
  const cur = {
    members: pgTable("members", {
      id: serial("id").primaryKey(),
      name: varchar("name", { length: 64 }).notNull(),
      nickname: varchar("nickname", { length: 64 }),
    }),
  };
  const { statements, real } = await diff(prev, cur);
  check(
    "ADD COLUMN is substantive (fast script would exit 1)",
    real.length > 0 && real.some((s) => /\bADD\s+COLUMN\b/i.test(s)),
    `statements=${JSON.stringify(statements)} real=${JSON.stringify(real)}`,
  );
}

// --- Case 2: substantive drift — NEW TABLE -------------------------------
{
  const prev = {
    members: pgTable("members", {
      id: serial("id").primaryKey(),
    }),
  };
  const cur = {
    members: pgTable("members", {
      id: serial("id").primaryKey(),
    }),
    audit_log: pgTable("audit_log", {
      id: serial("id").primaryKey(),
      action: text("action").notNull(),
    }),
  };
  const { statements, real } = await diff(prev, cur);
  check(
    "NEW TABLE is substantive (fast script would exit 1)",
    real.length > 0 && real.some((s) => /^\s*CREATE\s+TABLE\b/i.test(s)),
    `statements=${JSON.stringify(statements)} real=${JSON.stringify(real)}`,
  );
}

// --- Case 3: substantive drift — DROP COLUMN -----------------------------
{
  const prev = {
    members: pgTable("members", {
      id: serial("id").primaryKey(),
      legacy_flag: boolean("legacy_flag").default(false),
    }),
  };
  const cur = {
    members: pgTable("members", {
      id: serial("id").primaryKey(),
    }),
  };
  const { statements, real } = await diff(prev, cur);
  check(
    "DROP COLUMN is substantive (fast script would exit 1)",
    real.length > 0 && real.some((s) => /\bDROP\s+COLUMN\b/i.test(s)),
    `statements=${JSON.stringify(statements)} real=${JSON.stringify(real)}`,
  );
}

// --- Case 4: cosmetic-only drift — SET DEFAULT re-formatting -------------
// This exercises the exact branch that distinguishes the fast path from
// the slow path: drizzle re-emits Postgres-stored array/jsonb defaults
// in canonical literal form on every introspect (ARRAY[]::text[],
// '{}'::text[], etc.) even when the column hasn't actually changed.
// Those statements MUST be filtered out so a warm cache + clean DB
// exits 0.
//
// We provoke the real `generateMigration` to emit each cosmetic shape
// by taking a schema-derived snapshot and mutating the `prev` copy's
// stored default literal to a different-but-equivalent encoding. This
// is exactly the situation a warm cache hits when the cached snapshot
// (post-introspect) and the fresh schema-derived snapshot disagree
// only on default formatting.
{
  const tbl = {
    t: pgTable("t", {
      id: serial("id").primaryKey(),
      tags: text("tags").array().default([]),
    }),
  };
  const baseline = drizzleApi.generateDrizzleJson(tbl) as {
    tables: Record<string, { columns: Record<string, { default?: string }> }>;
  };

  // Each scenario: prev's stored literal differs from cur's by encoding
  // only. generateMigration emits a SET DEFAULT in one of the canonical
  // cosmetic shapes; the fast script's isCosmetic must suppress it.
  const cosmeticShapes: Array<{ prev: string; cur: string }> = [
    { prev: "'{}'", cur: "ARRAY[]::text[]" },
    { prev: "'{}'", cur: "'{}'::text[]" },
  ];

  for (const { prev: prevDefault, cur: curDefault } of cosmeticShapes) {
    const prev = JSON.parse(JSON.stringify(baseline));
    const cur = JSON.parse(JSON.stringify(baseline));
    prev.tables["public.t"].columns.tags.default = prevDefault;
    cur.tables["public.t"].columns.tags.default = curDefault;
    const statements = await drizzleApi.generateMigration(prev, cur);
    const real = statements.filter((s) => !isCosmetic(s));
    check(
      `cosmetic SET DEFAULT re-format suppressed (${prevDefault} → ${curDefault}, fast script would exit 0)`,
      statements.length > 0 && real.length === 0,
      `statements=${JSON.stringify(statements)} real=${JSON.stringify(real)}`,
    );
  }
}

// --- Case 5: real SET DEFAULT changes are NOT suppressed -----------------
// Guards against the cosmetic regex over-matching: scalar / enum / now()
// defaults are intent changes that must surface as drift.
{
  const realDefaults = [
    'ALTER TABLE "x" ALTER COLUMN "n" SET DEFAULT 42;',
    `ALTER TABLE "x" ALTER COLUMN "s" SET DEFAULT 'hello';`,
    `ALTER TABLE "x" ALTER COLUMN "e" SET DEFAULT 'pending'::status_enum;`,
    'ALTER TABLE "x" ALTER COLUMN "t" SET DEFAULT now();',
  ];
  const real = realDefaults.filter((s) => !isCosmetic(s));
  check(
    "real SET DEFAULT changes are NOT suppressed (fast script would exit 1)",
    real.length === realDefaults.length,
    `wrongly suppressed: ${JSON.stringify(
      realDefaults.filter((s) => isCosmetic(s)),
    )}`,
  );
}

// --- Case 6: substantive drift mixed with cosmetic re-format -------------
// If a real change rides alongside cosmetic churn the fast script must
// still surface drift (exit 1), not let it pass.
{
  const prev = {
    members: pgTable("members", {
      id: serial("id").primaryKey(),
    }),
  };
  const cur = {
    members: pgTable("members", {
      id: serial("id").primaryKey(),
      score: integer("score").notNull().default(0),
    }),
  };
  const { statements, real } = await diff(prev, cur);
  // Inject a cosmetic statement to simulate mixed drift; it must be
  // filtered out, leaving the substantive ADD COLUMN behind.
  const mixed = [
    ...statements,
    'ALTER TABLE "members" ALTER COLUMN "tags" SET DEFAULT ARRAY[]::text[];',
  ];
  const mixedReal = mixed.filter((s) => !isCosmetic(s));
  check(
    "mixed substantive+cosmetic still surfaces drift (fast script would exit 1)",
    mixedReal.length > 0 &&
      mixedReal.some((s) => /\bADD\s+COLUMN\b/i.test(s)) &&
      mixedReal.length === real.length,
    `statements=${JSON.stringify(mixed)} real=${JSON.stringify(mixedReal)}`,
  );
}

if (failed > 0) {
  console.error(`\ncheck-drift-fast: ${failed} case(s) failed`);
  process.exit(1);
}
console.log(
  "OK: check-drift-fast diff/classify pipeline catches substantive drift " +
    "and suppresses cosmetic re-formatting.",
);
