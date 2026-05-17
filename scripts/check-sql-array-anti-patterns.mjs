#!/usr/bin/env node
/**
 * Repository guard against the SQL list-lookup anti-patterns audited under
 * Task #815 and locked in by Task #949.
 *
 * The previous patterns either crashed routes outright or opened a SQL-
 * injection seam:
 *
 *   1. `ANY(${arr}::int[])`
 *      Drizzle expanded `${arr}` to a tuple `($1,$2,$3)`, producing invalid
 *      Postgres syntax and 500ing the route as soon as the array had more
 *      than one element. (See Task #658 / GET /api/portal/highlights.)
 *
 *   2. `ARRAY[${arr}]` / `ARRAY[${arr.join(",")}]`
 *      Same shape as (1) when `${arr}` was bound, and a plain string-concat
 *      injection seam when `arr.join(",")` was used.
 *
 *   3. `sql.raw(...arr.join(",")...)`
 *      Bypassed parameter binding entirely — every element became part of
 *      the raw SQL text.
 *
 * The fix is to bind each id as its own parameter, e.g. via drizzle's
 * typed `inArray()` helper, or:
 *
 *   sql`... ANY(ARRAY[${sql.join(arr.map(id => sql`${id}`), sql`, `)}]::int[])`
 *
 * This script greps the api-server source for the bad shapes and exits
 * non-zero if any are found, so the next copy-paste of the legacy style is
 * caught at build / CI time instead of at production page load.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const scanRoots = [
  join(repoRoot, "artifacts", "api-server", "src"),
];

// The regression test deliberately documents the bad shapes in its
// docstring so reviewers know what the audit was about; skip it here so
// the documentation doesn't trip the guard.
const skipFiles = new Set([
  join(
    repoRoot,
    "artifacts",
    "api-server",
    "src",
    "tests",
    "sql-array-anti-pattern-regression.test.ts",
  ),
  // This script itself documents the patterns.
  fileURLToPath(import.meta.url),
]);

// Whitespace-tolerant regexes (the `s` flag lets `\s` match newlines so
// the pattern keeps firing when the call is broken across multiple lines —
// e.g. `ANY(\n  ${ids}\n  ::int[]\n)`).
/** @type {Array<{ name: string; pattern: RegExp; explain: string }>} */
const rules = [
  {
    name: "ANY(${jsArray}) — bind each id, e.g. inArray() or sql.join()",
    // ANY( ... ${ <bare identifier / member access / index> } — explicitly
    // disallow `(` inside the ${...} so the safe `sql.join(...)` form
    // (which contains a function call) does NOT match.
    // Examples this matches (bad):
    //   ANY(${ids}::int[])
    //   ANY (${user.ids})
    //   ANY(\n  ${arr}\n)
    // Examples this does NOT match (safe):
    //   ANY(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::int[])
    pattern: /\bANY\s*\(\s*\$\{\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*\[[^\]()]*\])?\s*(?:::[A-Za-z0-9_\[\]]+)?\s*\}/s,
    explain:
      "Direct `${array}` interpolation inside ANY(...) — Drizzle expands it to a row-tuple ($1,$2,...) and Postgres rejects the syntax. Use `inArray(col, arr)` or bind each id with sql.join(arr.map(id => sql`${id}`), sql`, `).",
  },
  {
    name: "ARRAY[${jsArray}] — bind each id explicitly",
    // ARRAY[ ... ${ <bare identifier / member access> } ... ]. Disallow
    // `(` inside ${...} so the safe `ARRAY[${sql.join(...)}]` form (which
    // has a function call inside ${...}) does not match.
    pattern: /\bARRAY\s*\[\s*\$\{\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\}\s*\]/s,
    explain:
      "Direct `${array}` interpolation inside ARRAY[...] — same row-tuple expansion bug as the ANY() form. Use sql.join(arr.map(id => sql`${id}`), sql`, `) inside the brackets.",
  },
  // Note: the sql.raw + .join() rule is handled by a balanced-paren
  // scan in `findSqlRawJoin` below rather than a regex, because the
  // call argument may contain other balanced calls like
  // `arr.map(String).join(",")` that a naive `[^)]*` regex would miss.
];

const sqlRawJoinRule = {
  name: "sql.raw(... .join(...) ...) — bypasses parameter binding",
  explain:
    "sql.raw() concatenates the joined string straight into the SQL text — every element becomes part of the query, opening a SQL-injection seam. Use the typed sql tag with sql.join() so each value is bound as its own parameter.",
};

/**
 * Find every `sql.raw(...)` call whose (balanced) argument list contains
 * a `.join(` token. Operates on the comment/string-scrubbed source so
 * documentation strings don't trigger.
 *
 * @returns {Array<{ index: number }>} character offsets of each match
 *   (pointing at the `s` of `sql.raw`).
 */
function findSqlRawJoin(scrubbed) {
  /** @type {Array<{ index: number }>} */
  const hits = [];
  const open = /\bsql\s*\.\s*raw\s*\(/gs;
  let m;
  while ((m = open.exec(scrubbed)) !== null) {
    const argStart = open.lastIndex; // first char inside the (
    let depth = 1;
    let i = argStart;
    while (i < scrubbed.length && depth > 0) {
      const ch = scrubbed[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      // Skip backtick template literals so `sql\`foo(${x})\`` inside the
      // argument doesn't confuse the depth counter. Plain quoted strings
      // were already scrubbed before this function ran, so they read as
      // whitespace and are safe.
      else if (ch === "`") {
        i += 1;
        while (i < scrubbed.length && scrubbed[i] !== "`") {
          if (scrubbed[i] === "\\") { i += 2; continue; }
          i += 1;
        }
      }
      i += 1;
    }
    const argEnd = depth === 0 ? i - 1 : scrubbed.length;
    const arg = scrubbed.slice(argStart, argEnd);
    if (/\.\s*join\s*\(/s.test(arg)) {
      hits.push({ index: m.index });
    }
  }
  return hits;
}

/** Recursively collect *.ts / *.tsx files under a directory. */
function collectTsFiles(root) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      out.push(...collectTsFiles(full));
    } else if (st.isFile() && (name.endsWith(".ts") || name.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip block comments (`/* ... *\/`), per-line `//` comments, and the
 * contents of single/double-quoted string literals from a TypeScript
 * source. Template literals (`` `...` ``) are PRESERVED — that is where
 * the bad sql tag patterns live, and is exactly what we need to scan.
 * Newlines are preserved verbatim so character offsets in the returned
 * string map back to the original file via a line-start index.
 *
 * Stripping plain strings prevents harmless documentation strings like
 *   const help = "Use ANY(${ids}) in a sql tag";
 * from tripping the guard.
 *
 * @returns {string} Same length-class as the input (newlines preserved),
 *   with comments and quoted-string bodies replaced by spaces so byte
 *   offsets remain valid for line-number lookup.
 */
function scrubCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  let inBlock = false;
  let inLineComment = false;
  let stringQuote = null; // '"' or "'" or null
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (inBlock) {
      if (c === "*" && n === "/") { out += "  "; i += 2; inBlock = false; continue; }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (inLineComment) {
      if (c === "\n") { out += "\n"; inLineComment = false; i += 1; continue; }
      out += " ";
      i += 1;
      continue;
    }
    if (stringQuote !== null) {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === stringQuote) { out += " "; stringQuote = null; i += 1; continue; }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (c === "/" && n === "*") { out += "  "; inBlock = true; i += 2; continue; }
    if (c === "/" && n === "/") { out += "  "; inLineComment = true; i += 2; continue; }
    if (c === '"' || c === "'") { out += " "; stringQuote = c; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

/** Build an array where buf[k] = character offset of the start of line (k+1). */
function buildLineIndex(source) {
  const idx = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") idx.push(i + 1);
  }
  return idx;
}

/** Map a 0-based character offset to a 1-based line number. */
function offsetToLine(lineIndex, offset) {
  // Binary search for the largest line-start <= offset.
  let lo = 0, hi = lineIndex.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineIndex[mid] <= offset) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans + 1;
}

/**
 * Scan one source string for all rule violations. Returns a list of
 * { lineNo, rule, snippet } for every match. Pure: takes the source as
 * input and never touches the filesystem so it can be exercised by the
 * --self-test mode below.
 */
export function scanSource(source) {
  const scrubbed = scrubCommentsAndStrings(source);
  const lineIndex = buildLineIndex(source);
  /** @type {Array<{ lineNo: number; rule: typeof rules[number]; snippet: string }>} */
  const hits = [];
  const recordHit = (rule, index) => {
    const lineNo = offsetToLine(lineIndex, index);
    // Pull a single-line snippet from the ORIGINAL source for the
    // diagnostic — the scrubbed text would be unreadable.
    const start = lineIndex[lineNo - 1];
    const endNl = source.indexOf("\n", start);
    const end = endNl === -1 ? source.length : endNl;
    hits.push({ lineNo, rule, snippet: source.slice(start, end).trim() });
  };
  for (const rule of rules) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
    let m;
    while ((m = re.exec(scrubbed)) !== null) {
      recordHit(rule, m.index);
      if (m.index === re.lastIndex) re.lastIndex += 1; // guard against zero-width
    }
  }
  for (const h of findSqlRawJoin(scrubbed)) {
    recordHit(sqlRawJoinRule, h.index);
  }
  return hits;
}

// --self-test mode: exercise scanSource() against fixtures so any future
// regex tweak that breaks expected behaviour fails loudly. Run with
//   node scripts/check-sql-array-anti-patterns.mjs --self-test
if (process.argv.includes("--self-test")) {
  const cases = [
    // [label, source, expectedRuleNames]
    ["bare ANY interpolation",
      "const q = sql`WHERE id = ANY(${ids}::int[])`;",
      ["ANY(${jsArray}) — bind each id, e.g. inArray() or sql.join()"]],
    ["ANY with whitespace and member access",
      "const q = sql`WHERE x = ANY ( ${user.ids} )`;",
      ["ANY(${jsArray}) — bind each id, e.g. inArray() or sql.join()"]],
    ["ANY split across lines",
      "const q = sql`\n  WHERE id = ANY(\n    ${ids}\n    ::int[]\n  )\n`;",
      ["ANY(${jsArray}) — bind each id, e.g. inArray() or sql.join()"]],
    ["bare ARRAY interpolation",
      "const q = sql`SELECT * FROM t WHERE id IN ARRAY[${ids}]`;",
      ["ARRAY[${jsArray}] — bind each id explicitly"]],
    ["ARRAY with whitespace",
      "const q = sql`ARRAY [ ${ids} ]`;",
      ["ARRAY[${jsArray}] — bind each id explicitly"]],
    ["sql.raw with .join",
      "db.execute(sql.raw('IN (' + ids.join(',') + ')'));",
      ["sql.raw(... .join(...) ...) — bypasses parameter binding"]],
    ["sql.raw with whitespace and chain",
      "db.execute( sql . raw ( 'IN (' + arr.map(String) . join ( ',' ) + ')' ));",
      ["sql.raw(... .join(...) ...) — bypasses parameter binding"]],
    ["safe sql.join inside ANY/ARRAY — must NOT match",
      "const q = sql`WHERE id = ANY(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::int[])`;",
      []],
    ["safe inArray — must NOT match",
      "const q = inArray(t.id, ids);",
      []],
    ["pattern in // comment — must NOT match",
      "// example: ANY(${ids}::int[]) is bad, also sql.raw(arr.join(','))",
      []],
    ["pattern in /* */ comment — must NOT match",
      "/* example: ANY(${ids}) and ARRAY[${ids}] are bad */",
      []],
    ["pattern in double-quoted string — must NOT match",
      "const help = \"Avoid ANY(${ids}) and sql.raw(a.join(','))\";",
      []],
    ["pattern in single-quoted string — must NOT match",
      "const help = 'Avoid ANY(${ids}) here';",
      []],
    ["sql.raw with no .join — must NOT match",
      "db.execute(sql.raw(precomputedDdl));",
      []],
  ];
  let failed = 0;
  for (const [label, src, expected] of cases) {
    const got = scanSource(src).map(h => h.rule.name).sort();
    const want = [...expected].sort();
    const ok = got.length === want.length && got.every((g, i) => g === want[i]);
    if (!ok) {
      failed += 1;
      console.error(`✗ ${label}`);
      console.error(`    expected: ${JSON.stringify(want)}`);
      console.error(`    got     : ${JSON.stringify(got)}`);
    } else {
      console.log(`✓ ${label}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll self-tests passed.");
  process.exit(0);
}

const findings = [];
for (const root of scanRoots) {
  const files = collectTsFiles(root);
  for (const file of files) {
    if (skipFiles.has(file)) continue;
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const hit of scanSource(src)) {
      findings.push({ file, ...hit });
    }
  }
}

if (findings.length > 0) {
  console.error("");
  console.error("✗ SQL list-lookup anti-pattern check FAILED");
  console.error("  (guard introduced by Task #949; background in Task #815 / #658)");
  console.error("");
  for (const f of findings) {
    const rel = relative(repoRoot, f.file);
    console.error(`  ${rel}:${f.lineNo}`);
    console.error(`    rule: ${f.rule.name}`);
    console.error(`    why : ${f.rule.explain}`);
    console.error(`    code: ${f.snippet}`);
    console.error("");
  }
  console.error(`Total: ${findings.length} occurrence(s).`);
  process.exit(1);
}

console.log("✓ SQL list-lookup anti-pattern check passed.");
