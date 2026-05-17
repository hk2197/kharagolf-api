#!/usr/bin/env node
/**
 * Repository guard against duplicate <string name="..."> declarations in
 * any Wear OS strings.xml file (Task #1447).
 *
 * The `pair_hint` resource was silently declared twice in every Wear OS
 * `values<lang>/strings.xml` for months because Android's resource
 * compiler happily accepts duplicates — it just keeps the last
 * occurrence and drops the earlier one. That meant later edits to the
 * *first* copy of the key were no-ops at runtime, and the bug was
 * invisible to the existing translation guards.
 *
 * This script scans every
 *   artifacts/kharagolf-mobile/wear-os-module/src/main/res/values<lang>/strings.xml
 * file and fails on any `name` attribute that appears more than once
 * inside the same file. The failure message points at the file and the
 * offending name so the fix is obvious.
 *
 * Pass --self-test to verify the detection logic with a built-in fixture
 * suite.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

const WEAR_RES_DIR = join(
  repoRoot,
  "artifacts",
  "kharagolf-mobile",
  "wear-os-module",
  "src",
  "main",
  "res",
);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Strip XML comments before scanning so a commented-out duplicate
 * doesn't trigger a false positive.
 */
function stripXmlComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Find every `<string name="...">` declaration in `xml` and report the
 * line number for each occurrence so error messages can point users
 * straight at the offending lines.
 *
 * Returns an array of { name, line } in source order.
 */
export function findStringDeclarations(xml) {
  const cleaned = stripXmlComments(xml);
  const re = /<string\b[^>]*\bname="([^"]+)"/g;
  /** @type {{ name: string, line: number }[]} */
  const out = [];
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const upTo = cleaned.slice(0, m.index);
    const line = upTo.split("\n").length;
    out.push({ name: m[1], line });
  }
  return out;
}

/**
 * Group declarations by `name` and return only the names that appear
 * more than once, along with the lines they appear on.
 *
 * Returns an array of { name, lines } sorted by first-occurrence line.
 */
export function findDuplicateNames(xml) {
  const decls = findStringDeclarations(xml);
  /** @type {Map<string, number[]>} */
  const byName = new Map();
  for (const { name, line } of decls) {
    const bucket = byName.get(name);
    if (bucket) bucket.push(line);
    else byName.set(name, [line]);
  }
  const dups = [];
  for (const [name, lines] of byName) {
    if (lines.length > 1) dups.push({ name, lines });
  }
  dups.sort((a, b) => a.lines[0] - b.lines[0]);
  return dups;
}

// ---------------------------------------------------------------------------
// Self-test fixtures
// ---------------------------------------------------------------------------

function runSelfTest() {
  const cases = [
    {
      name: "no duplicates → empty result",
      xml: `<?xml version="1.0"?>
<resources>
  <string name="a">A</string>
  <string name="b">B</string>
</resources>`,
      expect: [],
    },
    {
      name: "duplicate name in same file is flagged with line numbers",
      xml: `<?xml version="1.0"?>
<resources>
  <string name="pair_hint">Enter the 6-digit code.</string>
  <string name="other">Other</string>
  <string name="pair_hint">Enter the 6-digit pairing code.</string>
</resources>`,
      expect: [{ name: "pair_hint", lines: [3, 5] }],
    },
    {
      name: "triple-declared name reports all occurrences",
      xml: `<?xml version="1.0"?>
<resources>
  <string name="x">1</string>
  <string name="x">2</string>
  <string name="x">3</string>
</resources>`,
      expect: [{ name: "x", lines: [3, 4, 5] }],
    },
    {
      name: "commented-out duplicate is ignored",
      xml: `<?xml version="1.0"?>
<resources>
  <string name="a">A</string>
  <!-- <string name="a">old copy</string> -->
</resources>`,
      expect: [],
    },
    {
      name: "extra attributes (formatted, translatable) don't break parsing",
      xml: `<?xml version="1.0"?>
<resources>
  <string name="dup" formatted="true">%d</string>
  <string name="dup" translatable="false">%d</string>
</resources>`,
      expect: [{ name: "dup", lines: [3, 4] }],
    },
    {
      name: "two distinct duplicates are both reported, ordered by first line",
      xml: `<?xml version="1.0"?>
<resources>
  <string name="b">first b</string>
  <string name="a">first a</string>
  <string name="a">second a</string>
  <string name="b">second b</string>
</resources>`,
      expect: [
        { name: "b", lines: [3, 6] },
        { name: "a", lines: [4, 5] },
      ],
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = findDuplicateNames(c.xml);
    const a = JSON.stringify(got);
    const b = JSON.stringify(c.expect);
    if (a !== b) {
      failed += 1;
      console.error(
        `  ✗ ${c.name}\n      expected: ${b}\n      got:      ${a}`,
      );
    } else {
      console.log(`  ✓ ${c.name}`);
    }
  }
  if (failed > 0) {
    console.error(`\nself-test: ${failed} case(s) failed`);
    process.exit(1);
  }
  console.log(`\nself-test: all ${cases.length} cases passed`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function listStringsXmlFiles(resDir) {
  const files = [];
  let dirs;
  try {
    dirs = readdirSync(resDir).sort();
  } catch (err) {
    throw new Error(
      `failed to read ${relative(repoRoot, resDir)}: ${err.message}`,
    );
  }
  for (const dir of dirs) {
    if (dir !== "values" && !dir.startsWith("values-")) continue;
    const filePath = join(resDir, dir, "strings.xml");
    try {
      readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    files.push(filePath);
  }
  return files;
}

function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  let files;
  try {
    files = listStringsXmlFiles(WEAR_RES_DIR);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  /** @type {string[]} */
  const failures = [];
  for (const filePath of files) {
    const xml = readFileSync(filePath, "utf8");
    const dups = findDuplicateNames(xml);
    for (const { name, lines } of dups) {
      failures.push(
        `${relative(repoRoot, filePath)}  duplicate <string name="${name}"> on lines ${lines.join(", ")}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(
      `\ncheck-watch-string-duplicates: found ${failures.length} duplicate <string name="..."> declaration${failures.length === 1 ? "" : "s"}:\n`,
    );
    for (const line of failures) console.error(`  - ${line}`);
    console.error(
      `\nAndroid's resource compiler keeps only the last occurrence and silently drops the rest, so any earlier duplicate is dead at runtime. Remove the redundant declaration(s) above so every key resolves to exactly one value.\n`,
    );
    process.exit(1);
  }

  console.log(
    `check-watch-string-duplicates: scanned ${files.length} Wear OS strings.xml file${files.length === 1 ? "" : "s"} — no duplicate <string name="..."> declarations found.`,
  );
}

main();
