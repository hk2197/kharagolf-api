#!/usr/bin/env node
/**
 * Repository guard against untranslated English fragments sneaking into the
 * watch-app language files (Task #1247).
 *
 * The native-speaker review of the v2 watch translations found leftovers
 * like Hausa `Auto-on <%d%%` that had not been localized. Nothing in the
 * build flagged them because the entries were marked "translated" — they
 * just happened to still contain raw English. This script scans both:
 *
 *   - artifacts/kharagolf-mobile/ios-watch-extension/KHARAGOLFWatch/Localizable.xcstrings
 *   - artifacts/kharagolf-mobile/wear-os-module/src/main/res/values-XX/strings.xml
 *
 * and flags any non-English entry that is either:
 *
 *   1. Byte-identical to the English source value (after normalising line
 *      endings and skipping placeholder-only sources), OR
 *   2. (For non-Latin-script locales only) contains a run of >= 4
 *      consecutive ASCII letters after stripping placeholders, the
 *      app/brand name, and the documented voice-command examples.
 *
 * The script exits non-zero so CI / the validation step fails on any
 * regression. Pass --self-test to verify the detection logic with a
 * built-in fixture suite.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

const XCSTRINGS_PATH = join(
  repoRoot,
  "artifacts",
  "kharagolf-mobile",
  "ios-watch-extension",
  "KHARAGOLFWatch",
  "Localizable.xcstrings",
);

const WEAR_RES_DIR = join(
  repoRoot,
  "artifacts",
  "kharagolf-mobile",
  "wear-os-module",
  "src",
  "main",
  "res",
);

// Languages whose script is primarily Latin. For these the "long ASCII
// run" heuristic produces only false positives (the whole string is
// ASCII), so we restrict that check to non-Latin locales below. The
// byte-identical check still applies to every non-English locale.
const LATIN_SCRIPT_LANGS = new Set([
  "af", // Afrikaans
  "de", // German
  "en", // English (source)
  "es", // Spanish
  "fil", // Filipino
  "fr", // French
  "ha", // Hausa
  "id", // Indonesian
  "ms", // Malay
  "pt", // Portuguese
  "sw", // Swahili
  "vi", // Vietnamese
  "yo", // Yoruba
  "zu", // Zulu
]);

// Minimum length of an ASCII-letter run that is considered "suspiciously
// long" inside a non-Latin-script translation. 4 catches "Auto" (the run
// from the regression example "Auto-on <%d%%") while leaving room for the
// allowlisted 3-letter terms below ("GPS", "yds", "Par", "log", "two",
// "on") to slip through naturally.
const ASCII_RUN_THRESHOLD = 4;

// Substrings that are legitimately English/Latin even inside a non-Latin
// translation. They are stripped before the ASCII-run scan. Match is
// case-insensitive.
const ALLOWED_LATIN_SUBSTRINGS = [
  "KHARAGOLF", // brand
  "birdie", // voice-command example token
  "two putts", // voice-command example phrase
  "log par on", // voice-command example phrase
];

// Regexes used to strip non-content tokens (placeholders, escapes, XML
// entities) before the ASCII-run scan and before the byte-identical
// "is the source actually translatable?" check.
const PLACEHOLDER_RES = [
  /%%/g, // literal percent
  /%(?:\d+\$)?[+-]?\d*\.?\d*[a-zA-Z@]/g, // %d, %s, %@, %1$d, %.2f, %lld …
  /\\[nrt'"\\]/g, // \n \t \\ \" \' escapes
  /&(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, // XML entities
];

/** Strip placeholders / XML entities / explicit allowlist tokens. */
function stripAllowedTokens(value) {
  let out = value;
  for (const re of PLACEHOLDER_RES) out = out.replace(re, " ");
  for (const literal of ALLOWED_LATIN_SUBSTRINGS) {
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), " ");
  }
  return out;
}

/**
 * Find runs of consecutive ASCII letters (a-z / A-Z) of length >= the
 * threshold inside `value` after stripping the allowlist. Returns the
 * matched runs (deduplicated, in order) for use in the failure message.
 */
function findSuspiciousAsciiRuns(value) {
  const stripped = stripAllowedTokens(value);
  const runs = stripped.match(/[A-Za-z]{4,}/g) ?? [];
  const filtered = runs.filter((r) => r.length >= ASCII_RUN_THRESHOLD);
  return [...new Set(filtered)];
}

/**
 * True when the source string carries enough actual letter content that a
 * byte-identical translation is meaningful evidence of an oversight. A
 * source like "%d" or "%1$d / %2$d" should NOT trip the byte-identical
 * check because the only sensible "translation" IS the same string.
 */
function sourceHasTranslatableContent(source) {
  const stripped = stripAllowedTokens(source).replace(/[^A-Za-z]+/g, "");
  return stripped.length >= 3;
}

/**
 * Normalise a value for the byte-identical comparison: trim outer
 * whitespace and collapse \r\n / \r to \n so an incidental line-ending
 * difference doesn't mask a real copy-paste.
 */
function normalise(value) {
  return value.replace(/\r\n?/g, "\n").trim();
}

/**
 * Decide which checks should fire for a given (lang, key, source, value)
 * tuple and return a list of human-readable failure descriptions.
 */
export function inspectEntry({ lang, key, source, value }) {
  const failures = [];
  if (lang === "en") return failures;
  if (typeof source !== "string" || typeof value !== "string") return failures;

  if (
    sourceHasTranslatableContent(source) &&
    normalise(source) === normalise(value)
  ) {
    failures.push({
      kind: "byte-identical",
      detail: `value is byte-identical to the English source: ${JSON.stringify(value)}`,
    });
  }

  if (!LATIN_SCRIPT_LANGS.has(lang)) {
    const runs = findSuspiciousAsciiRuns(value);
    if (runs.length > 0) {
      failures.push({
        kind: "ascii-run",
        detail: `contains untranslated ASCII run(s) ${runs
          .map((r) => JSON.stringify(r))
          .join(", ")} in ${JSON.stringify(value)}`,
      });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// File loaders
// ---------------------------------------------------------------------------

function loadXcstrings(path) {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  const sourceLang = parsed.sourceLanguage ?? "en";
  /** @type {{ key: string, source: string, lang: string, value: string }[]} */
  const entries = [];
  for (const [key, def] of Object.entries(parsed.strings ?? {})) {
    const localizations = def?.localizations ?? {};
    const sourceUnit = localizations[sourceLang]?.stringUnit;
    const source =
      typeof sourceUnit?.value === "string" ? sourceUnit.value : key;
    for (const [lang, locDef] of Object.entries(localizations)) {
      const unit = locDef?.stringUnit;
      if (!unit || unit.state !== "translated") continue;
      if (typeof unit.value !== "string") continue;
      entries.push({ key, source, lang, value: unit.value });
    }
  }
  return entries;
}

/**
 * Minimal Android <string> parser. Captures the `name` attribute and the
 * raw text between the opening and closing tag. Comments and <plurals>
 * are ignored (the watch module only uses <string>).
 */
function parseStringsXml(xml) {
  const out = new Map();
  const re =
    /<string\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.set(m[1], m[2]);
  }
  return out;
}

function loadWearOsTranslations(resDir) {
  const englishPath = join(resDir, "values", "strings.xml");
  const englishMap = parseStringsXml(readFileSync(englishPath, "utf8"));
  /** @type {{ key: string, source: string, lang: string, value: string, file: string }[]} */
  const entries = [];
  for (const dir of readdirSync(resDir).sort()) {
    if (!dir.startsWith("values-")) continue;
    const lang = dir.slice("values-".length);
    const filePath = join(resDir, dir, "strings.xml");
    let xml;
    try {
      xml = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const localised = parseStringsXml(xml);
    for (const [key, value] of localised) {
      const source = englishMap.get(key);
      if (typeof source !== "string") continue; // key removed from English
      entries.push({
        key,
        source,
        lang,
        value,
        file: relative(repoRoot, filePath),
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Self-test fixtures
// ---------------------------------------------------------------------------

function runSelfTest() {
  const cases = [
    // ---- byte-identical ----
    {
      name: "byte-identical English copy in non-Latin locale fails",
      args: { lang: "ja", key: "auto_on", source: "Auto-on <%d%%", value: "Auto-on <%d%%" },
      expectKinds: ["byte-identical", "ascii-run"],
    },
    {
      name: "byte-identical English copy in Latin-script locale fails",
      args: { lang: "ha", key: "auto_on", source: "Auto-on <%d%%", value: "Auto-on <%d%%" },
      expectKinds: ["byte-identical"],
    },
    {
      name: "placeholder-only source isn't flagged when copied",
      args: { lang: "ja", key: "raw_pct", source: "%d%%", value: "%d%%" },
      expectKinds: [],
    },
    // ---- ascii-run heuristic ----
    {
      name: "Hausa-style English leak in Japanese fails (ascii run)",
      args: { lang: "ja", key: "auto_on", source: "Auto-on <%d%%", value: "Auto-on <%d%%" },
      expectKinds: ["byte-identical", "ascii-run"],
    },
    {
      name: "Japanese with KHARAGOLF brand passes",
      args: {
        lang: "ja",
        key: "complication_label",
        source: "KHARAGOLF Score",
        value: "KHARAGOLF スコア",
      },
      expectKinds: [],
    },
    {
      name: "Japanese with embedded English 'Score' fails",
      args: {
        lang: "ja",
        key: "complication_label",
        source: "KHARAGOLF Score",
        value: "KHARAGOLF Score モード",
      },
      expectKinds: ["ascii-run"],
    },
    {
      name: "Voice-command example phrase is allowlisted",
      args: {
        lang: "ja",
        key: "voice_score_hint",
        source: "Tap mic, then say:\\nlog par on 7 · birdie · two putts",
        value: "マイクをタップして話す：\\nlog par on 7 · birdie · two putts",
      },
      expectKinds: [],
    },
    {
      name: "GPS acronym + Par golf term + %d don't trip the run scan",
      args: {
        lang: "ar",
        key: "hole_par_header",
        source: "Hole %1$d  Par %2$d",
        value: "حفرة %1$d  Par %2$d",
      },
      expectKinds: [],
    },
    {
      name: "ascii-run scan is skipped for Latin-script locales",
      args: {
        lang: "fr",
        key: "verified_by_marker",
        source: "Verified by marker",
        value: "Vérifié par le marqueur",
      },
      expectKinds: [],
    },
    {
      name: "English source identical to English value is not flagged",
      args: { lang: "en", key: "submit", source: "Submit", value: "Submit" },
      expectKinds: [],
    },
    {
      name: "Translated values different from source pass on non-Latin",
      args: {
        lang: "zh",
        key: "wind_direction",
        source: "Wind direction",
        value: "风向",
      },
      expectKinds: [],
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = inspectEntry(c.args).map((f) => f.kind).sort();
    const want = [...c.expectKinds].sort();
    const ok =
      got.length === want.length && got.every((k, i) => k === want[i]);
    if (!ok) {
      failed += 1;
      console.error(
        `  ✗ ${c.name}\n      expected kinds: [${want.join(", ")}]\n      got kinds:      [${got.join(", ")}]`,
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

function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  /** @type {string[]} */
  const failures = [];

  // iOS xcstrings ----------------------------------------------------------
  let iosEntries = [];
  try {
    iosEntries = loadXcstrings(XCSTRINGS_PATH);
  } catch (err) {
    console.error(
      `failed to read ${relative(repoRoot, XCSTRINGS_PATH)}: ${err.message}`,
    );
    process.exit(2);
  }
  for (const e of iosEntries) {
    for (const f of inspectEntry(e)) {
      failures.push(
        `${relative(repoRoot, XCSTRINGS_PATH)}  [${e.lang}] ${e.key}: ${f.detail}`,
      );
    }
  }

  // Wear OS strings.xml ----------------------------------------------------
  let wearEntries = [];
  try {
    wearEntries = loadWearOsTranslations(WEAR_RES_DIR);
  } catch (err) {
    console.error(
      `failed to read ${relative(repoRoot, WEAR_RES_DIR)}: ${err.message}`,
    );
    process.exit(2);
  }
  for (const e of wearEntries) {
    for (const f of inspectEntry(e)) {
      failures.push(`${e.file}  [${e.lang}] ${e.key}: ${f.detail}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `\ncheck-watch-translations: found ${failures.length} suspected untranslated entr${failures.length === 1 ? "y" : "ies"}:\n`,
    );
    for (const line of failures) console.error(`  - ${line}`);
    console.error(
      "\nFix the translations above, or — if the leftover Latin text is intentional — extend the allowlist in scripts/check-watch-translations.mjs.\n",
    );
    process.exit(1);
  }

  const langs = new Set([
    ...iosEntries.map((e) => e.lang),
    ...wearEntries.map((e) => e.lang),
  ]);
  console.log(
    `check-watch-translations: scanned ${iosEntries.length + wearEntries.length} translated entries across ${langs.size} languages — no untranslated leftovers found.`,
  );
}

main();
