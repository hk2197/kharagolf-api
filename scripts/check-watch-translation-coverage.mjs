#!/usr/bin/env node
/**
 * Repository guard against missing translations in the Wear OS
 * `values-XX/strings.xml` siblings (Task #1751).
 *
 * The duplicate-name guard added in Task #1447 catches a key declared
 * twice inside the same file. The mirror-image silent failure is when
 * an engineer adds a *new* English key to
 *   artifacts/kharagolf-mobile/wear-os-module/src/main/res/values/strings.xml
 * but forgets to add a corresponding `<string name="...">` to one (or
 * more) of the 21 `values-XX/strings.xml` siblings. Android happily
 * falls back to the English `values/` resource at runtime in that
 * locale, so nothing fails to build — players in the affected locale
 * just see English with no signal to anyone.
 *
 * The existing watch-translation guard
 * (`scripts/check-watch-translations.mjs`) only inspects translations
 * that *are* present (it flags ones that look like leftover English).
 * It does not enumerate the English keyset and assert each locale
 * covers it. This script does.
 *
 * For each English key it checks every `values-XX/strings.xml` and
 * fails if the key is missing there. A small per-key allowlist with
 * documented reasons is supported for keys that are intentionally
 * English-only (e.g. the `KHARAGOLF` brand string).
 *
 * Pass --self-test to verify the detection logic with a built-in
 * fixture suite.
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

// Keys that are intentionally NOT translated and therefore legitimately
// absent from every `values-XX/strings.xml`. Each entry must carry a
// written reason so the allowlist stays auditable. If you're adding to
// this list because a translation is "coming later", add the
// translation instead — that's the failure mode this guard exists to
// prevent.
const UNTRANSLATED_ALLOWLIST = {
  app_name:
    "brand name 'KHARAGOLF' is identical in every locale; no translation",
  complication_label:
    "watch-face complication label is the brand 'KHARAGOLF Score'; not localised",
  tile_label:
    "single-word tile label 'Score' rendered in the system tile chrome; intentionally English-only",
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Strip XML comments so a commented-out <string> doesn't count as
 *  "declared". */
function stripXmlComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Return the set of `<string name="...">` keys declared in `xml`.
 * Duplicate names collapse to a single entry — that's what
 * `check-watch-string-duplicates.mjs` exists to flag, and we don't
 * want to double-report here.
 */
export function declaredStringKeys(xml) {
  const cleaned = stripXmlComments(xml);
  const re = /<string\b[^>]*\bname="([^"]+)"/g;
  /** @type {Set<string>} */
  const out = new Set();
  let m;
  while ((m = re.exec(cleaned)) !== null) out.add(m[1]);
  return out;
}

/**
 * Given the English keyset, the localised keyset, and the allowlist,
 * return the keys missing from the locale (sorted) that aren't excused
 * by the allowlist.
 */
export function findMissingKeys(englishKeys, localisedKeys, allowlist) {
  const allowed = new Set(Object.keys(allowlist));
  const missing = [];
  for (const key of englishKeys) {
    if (localisedKeys.has(key)) continue;
    if (allowed.has(key)) continue;
    missing.push(key);
  }
  missing.sort();
  return missing;
}

// ---------------------------------------------------------------------------
// Self-test fixtures
// ---------------------------------------------------------------------------

function runSelfTest() {
  const cases = [
    {
      name: "declaredStringKeys: collects every distinct name",
      run: () =>
        [...declaredStringKeys(`<?xml version="1.0"?>
<resources>
  <string name="a">A</string>
  <string name="b">B</string>
  <string name="c" formatted="true">%d</string>
</resources>`)].sort(),
      expect: ["a", "b", "c"],
    },
    {
      name: "declaredStringKeys: ignores commented-out declarations",
      run: () =>
        [...declaredStringKeys(`<?xml version="1.0"?>
<resources>
  <string name="kept">x</string>
  <!-- <string name="dropped">y</string> -->
</resources>`)].sort(),
      expect: ["kept"],
    },
    {
      name: "declaredStringKeys: duplicates collapse to one entry",
      run: () =>
        [...declaredStringKeys(`<?xml version="1.0"?>
<resources>
  <string name="dup">1</string>
  <string name="dup">2</string>
</resources>`)].sort(),
      expect: ["dup"],
    },
    {
      name: "findMissingKeys: locale missing one key is flagged",
      run: () =>
        findMissingKeys(
          new Set(["a", "b", "c"]),
          new Set(["a", "c"]),
          {},
        ),
      expect: ["b"],
    },
    {
      name: "findMissingKeys: complete locale returns empty",
      run: () =>
        findMissingKeys(
          new Set(["a", "b"]),
          new Set(["a", "b"]),
          {},
        ),
      expect: [],
    },
    {
      name: "findMissingKeys: allowlisted missing key is excused",
      run: () =>
        findMissingKeys(
          new Set(["app_name", "go"]),
          new Set(["go"]),
          { app_name: "brand" },
        ),
      expect: [],
    },
    {
      name: "findMissingKeys: non-allowlisted key is still flagged when allowlist is non-empty",
      run: () =>
        findMissingKeys(
          new Set(["app_name", "go", "stop"]),
          new Set(["go"]),
          { app_name: "brand" },
        ),
      expect: ["stop"],
    },
    {
      name: "findMissingKeys: extra keys in locale beyond English are not flagged here",
      run: () =>
        findMissingKeys(
          new Set(["a"]),
          new Set(["a", "b"]),
          {},
        ),
      expect: [],
    },
    {
      name: "findMissingKeys: result is sorted alphabetically",
      run: () =>
        findMissingKeys(
          new Set(["zebra", "apple", "mango"]),
          new Set([]),
          {},
        ),
      expect: ["apple", "mango", "zebra"],
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = c.run();
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

function listLocaleStringsXml(resDir) {
  const out = [];
  let dirs;
  try {
    dirs = readdirSync(resDir).sort();
  } catch (err) {
    throw new Error(
      `failed to read ${relative(repoRoot, resDir)}: ${err.message}`,
    );
  }
  for (const dir of dirs) {
    if (!dir.startsWith("values-")) continue;
    const filePath = join(resDir, dir, "strings.xml");
    try {
      readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    out.push({ lang: dir.slice("values-".length), filePath });
  }
  return out;
}

function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const englishPath = join(WEAR_RES_DIR, "values", "strings.xml");
  let englishXml;
  try {
    englishXml = readFileSync(englishPath, "utf8");
  } catch (err) {
    console.error(
      `failed to read ${relative(repoRoot, englishPath)}: ${err.message}`,
    );
    process.exit(2);
  }
  const englishKeys = declaredStringKeys(englishXml);

  let locales;
  try {
    locales = listLocaleStringsXml(WEAR_RES_DIR);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  /** @type {string[]} */
  const failures = [];
  for (const { lang, filePath } of locales) {
    const localisedKeys = declaredStringKeys(readFileSync(filePath, "utf8"));
    const missing = findMissingKeys(
      englishKeys,
      localisedKeys,
      UNTRANSLATED_ALLOWLIST,
    );
    for (const key of missing) {
      failures.push(
        `${relative(repoRoot, filePath)}  [${lang}] missing <string name="${key}"> (declared in ${relative(repoRoot, englishPath)})`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(
      `\ncheck-watch-translation-coverage: found ${failures.length} missing translation${failures.length === 1 ? "" : "s"}:\n`,
    );
    for (const line of failures) console.error(`  - ${line}`);
    console.error(
      `\nWithout a per-locale <string> entry, Android falls back to the English values/ resource at runtime — so players in the affected locale silently see English. Add the missing <string> to the file(s) above, or — if the key is genuinely meant to stay English in every locale (e.g. a brand label) — extend UNTRANSLATED_ALLOWLIST in scripts/check-watch-translation-coverage.mjs with a written reason.\n`,
    );
    process.exit(1);
  }

  console.log(
    `check-watch-translation-coverage: scanned ${englishKeys.size} English key${englishKeys.size === 1 ? "" : "s"} across ${locales.length} locale${locales.length === 1 ? "" : "s"} — every key is translated (or explicitly allowlisted).`,
  );
}

main();
