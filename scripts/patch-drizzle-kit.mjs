#!/usr/bin/env node
/**
 * Vendor patch for drizzle-kit v0.31.9.
 *
 * Bug: in api.mjs, the `pushSchema`/`pushMySQLSchema`/`pushSQLiteSchema`
 * exports build an internal `db` wrapper that drops the `params` argument
 * when forwarding to `drizzleInstance.execute(sql.raw(query))`. drizzle-kit's
 * own `pgPushIntrospect` calls `db.query(text, [schema, table])` with a
 * parameterised composite-PK lookup — so when ANY introspected table has a
 * composite PRIMARY KEY, Postgres errors out with `there is no parameter $1`
 * (code 42P02). This blocks every post-merge schema sync.
 *
 * Fix: interpolate `params` into `query` before calling execute. Numbers/
 * booleans inline directly; strings/dates go through single-quote escaping
 * (matches what node-postgres would do server-side, but rendered as a literal
 * SQL string so the protocol-level Bind step is bypassed entirely).
 *
 * Run by the root `postinstall` script so the patch survives every
 * `pnpm install --frozen-lockfile` (e.g. in post-merge.sh).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = [
  "node_modules/.pnpm/drizzle-kit@0.31.9/node_modules/drizzle-kit/api.mjs",
];

const OLD = `query: async (query, params) => {
      const res = await drizzleInstance.execute(sql.raw(query));
      return res.rows;
    }`;

const NEW = `query: async (query, params) => {
      const interp = (params && params.length)
        ? query.replace(/\\$([0-9]+)/g, (_, i) => {
            const v = params[Number(i) - 1];
            if (v === null || v === undefined) return "NULL";
            if (typeof v === "number" || typeof v === "boolean") return String(v);
            return "'" + String(v).replace(/'/g, "''") + "'";
          })
        : query;
      const res = await drizzleInstance.execute(sql.raw(interp));
      return res.rows;
    }`;

const MARKER = "const interp = (params && params.length)";

let patched = 0;
let skipped = 0;
for (const rel of TARGETS) {
  const path = resolve(ROOT, rel);
  if (!existsSync(path)) continue;
  let src = readFileSync(path, "utf8");
  if (src.includes(MARKER)) {
    skipped++;
    continue;
  }
  const matches = src.split(OLD).length - 1;
  if (matches === 0) {
    console.warn(
      `[patch-drizzle-kit] WARNING: pattern not found in ${rel}. ` +
        `drizzle-kit may have been upgraded — review and update this script.`,
    );
    continue;
  }
  src = src.split(OLD).join(NEW);
  writeFileSync(path, src);
  patched++;
  console.log(
    `[patch-drizzle-kit] Patched ${rel} (${matches} occurrences).`,
  );
}
if (patched === 0 && skipped > 0) {
  console.log("[patch-drizzle-kit] Already patched — nothing to do.");
}
