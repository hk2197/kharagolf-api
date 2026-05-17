#!/usr/bin/env node
/**
 * Repository guard against missing per-key language entries in the iOS
 * watch extension's `Localizable.xcstrings` (Task #2169).
 *
 * `scripts/check-watch-translation-coverage.mjs` is the Wear OS sibling:
 * it walks every `values-XX/strings.xml` and fails when an English key
 * is not declared in a locale, because Android silently falls back to
 * the English `values/` resource at runtime in that locale.
 *
 * iOS has the same silent-fallback hazard in a different file format.
 * `Localizable.xcstrings` is a single JSON file where each key carries
 * a `localizations` map keyed by language code:
 *
 *   "verified_by_marker": {
 *     "localizations": {
 *       "en": { "stringUnit": { "state": "translated", "value": "..." } },
 *       "ja": { "stringUnit": { "state": "translated", "value": "..." } },
 *       ...
 *     }
 *   }
 *
 * When an engineer adds a new key but forgets to add an entry for one
 * of the localized languages, iOS falls back to the `sourceLanguage`
 * (English) at runtime in that locale with no build-time signal.
 *
 * The existing `scripts/check-watch-translations.mjs` only inspects
 * translations that *are* present (it flags ones that look like leftover
 * English). It does not enumerate the per-key language coverage. This
 * script does.
 *
 * The required language list is derived from the Wear OS module's
 * `values-XX/strings.xml` siblings — i.e. the Android side is the
 * source of truth for "which languages does the watch UI support".
 * That keeps iOS and Wear OS in lockstep: adding a new language to one
 * platform forces it onto the other (or onto the per-key allowlist
 * with a written reason).
 *
 * Pass --self-test to verify the detection logic with a built-in
 * fixture suite.
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

// Per-(key, lang) pairs that are intentionally absent from the
// `localizations` map and therefore legitimately fall back to the
// English source value at runtime. Each entry must carry a written
// reason so the allowlist stays auditable. If you're adding to this
// list because a translation is "coming later", add the translation
// instead — that's the failure mode this guard exists to prevent.
//
// Shape: { [key]: { [lang]: "reason" } }. A "*" lang wildcard excuses
// the key in *every* required locale (use sparingly, e.g. for a brand
// label that is intentionally identical in every language).
/** @type {Record<string, Record<string, string>>} */
const UNTRANSLATED_ALLOWLIST = {};

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Pull the per-key set of localized languages out of a parsed xcstrings
 * document. The `sourceLanguage` (typically "en") is excluded from each
 * set because it isn't part of the "translation coverage" question — a
 * source-language entry is what we'd be falling back *to*.
 *
 * Returns `{ sourceLanguage, keys: Map<string, Set<string>> }`.
 */
export function summariseXcstrings(parsed) {
  const sourceLanguage =
    typeof parsed?.sourceLanguage === "string" ? parsed.sourceLanguage : "en";
  /** @type {Map<string, Set<string>>} */
  const keys = new Map();
  for (const [key, def] of Object.entries(parsed?.strings ?? {})) {
    /** @type {Set<string>} */
    const langs = new Set();
    const localizations = def?.localizations ?? {};
    for (const [lang, locDef] of Object.entries(localizations)) {
      if (lang === sourceLanguage) continue;
      const unit = locDef?.stringUnit;
      // An entry with no `stringUnit.value` (or an empty string) is
      // not actually carrying a translation — iOS would still fall
      // back to the source — so treat it the same as "missing".
      if (!unit || typeof unit.value !== "string" || unit.value === "") {
        continue;
      }
      langs.add(lang);
    }
    keys.set(key, langs);
  }
  return { sourceLanguage, keys };
}

/**
 * Discover the language list the Wear OS module supports by listing
 * `values-XX/` siblings under its `res/` directory. We don't read the
 * XML — only the directory names matter for the language-list question.
 * Returns a sorted array of BCP-47-ish lang codes (e.g. ["af", "am",
 * "ar", ...]).
 */
export function listWearSupportedLangs(resDir) {
  /** @type {string[]} */
  const out = [];
  for (const dir of readdirSync(resDir).sort()) {
    if (!dir.startsWith("values-")) continue;
    const lang = dir.slice("values-".length);
    if (lang.length === 0) continue;
    out.push(lang);
  }
  return out;
}

/**
 * Check whether `(key, lang)` is excused by the allowlist. A "*"
 * wildcard under a key excuses every language for that key.
 */
function isAllowlisted(allowlist, key, lang) {
  const entry = allowlist[key];
  if (!entry) return false;
  if (typeof entry["*"] === "string") return true;
  return typeof entry[lang] === "string";
}

/**
 * Compare the xcstrings coverage against the required language list
 * and return a sorted list of `{ key, lang }` pairs that are missing
 * (and not excused by the allowlist).
 */
export function findMissingLocalizations({
  xcstringsKeys,
  requiredLangs,
  allowlist,
}) {
  /** @type {{ key: string, lang: string }[]} */
  const missing = [];
  const sortedKeys = [...xcstringsKeys.keys()].sort();
  for (const key of sortedKeys) {
    const present = xcstringsKeys.get(key) ?? new Set();
    for (const lang of requiredLangs) {
      if (present.has(lang)) continue;
      if (isAllowlisted(allowlist, key, lang)) continue;
      missing.push({ key, lang });
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Self-test fixtures
// ---------------------------------------------------------------------------

function runSelfTest() {
  const cases = [
    {
      name: "summariseXcstrings: collects translated languages, excluding source",
      run: () => {
        const { keys, sourceLanguage } = summariseXcstrings({
          sourceLanguage: "en",
          strings: {
            verified_by_marker: {
              localizations: {
                en: { stringUnit: { state: "translated", value: "Verified" } },
                ja: { stringUnit: { state: "translated", value: "確認済み" } },
                fr: { stringUnit: { state: "translated", value: "Vérifié" } },
              },
            },
          },
        });
        return [
          sourceLanguage,
          [...(keys.get("verified_by_marker") ?? [])].sort(),
        ];
      },
      expect: ["en", ["fr", "ja"]],
    },
    {
      name: "summariseXcstrings: entry without stringUnit.value is treated as missing",
      run: () => {
        const { keys } = summariseXcstrings({
          sourceLanguage: "en",
          strings: {
            k: {
              localizations: {
                ja: { stringUnit: { state: "translated", value: "OK" } },
                fr: { stringUnit: { state: "new" } },
                de: { stringUnit: { state: "translated", value: "" } },
              },
            },
          },
        });
        return [...(keys.get("k") ?? [])].sort();
      },
      expect: ["ja"],
    },
    {
      name: "summariseXcstrings: defaults sourceLanguage to 'en' when absent",
      run: () => {
        const { sourceLanguage } = summariseXcstrings({ strings: {} });
        return sourceLanguage;
      },
      expect: "en",
    },
    {
      name: "summariseXcstrings: key with no localizations has empty lang set",
      run: () => {
        const { keys } = summariseXcstrings({
          sourceLanguage: "en",
          strings: { lonely: {} },
        });
        return [...(keys.get("lonely") ?? [])];
      },
      expect: [],
    },
    {
      name: "findMissingLocalizations: every required language reported per key, sorted",
      run: () =>
        findMissingLocalizations({
          xcstringsKeys: new Map([
            ["a", new Set(["ja"])],
            ["b", new Set(["ja", "fr"])],
          ]),
          requiredLangs: ["fr", "ja", "zh"],
          allowlist: {},
        }),
      expect: [
        { key: "a", lang: "fr" },
        { key: "a", lang: "zh" },
        { key: "b", lang: "zh" },
      ],
    },
    {
      name: "findMissingLocalizations: complete coverage returns empty",
      run: () =>
        findMissingLocalizations({
          xcstringsKeys: new Map([["a", new Set(["fr", "ja"])]]),
          requiredLangs: ["fr", "ja"],
          allowlist: {},
        }),
      expect: [],
    },
    {
      name: "findMissingLocalizations: per-language allowlist entry excuses just that pair",
      run: () =>
        findMissingLocalizations({
          xcstringsKeys: new Map([["a", new Set([])]]),
          requiredLangs: ["fr", "ja"],
          allowlist: { a: { fr: "fr-only opt-out reason" } },
        }),
      expect: [{ key: "a", lang: "ja" }],
    },
    {
      name: "findMissingLocalizations: '*' wildcard allowlist excuses every language for a key",
      run: () =>
        findMissingLocalizations({
          xcstringsKeys: new Map([
            ["brand", new Set([])],
            ["other", new Set(["fr"])],
          ]),
          requiredLangs: ["fr", "ja"],
          allowlist: { brand: { "*": "brand name identical in every locale" } },
        }),
      expect: [{ key: "other", lang: "ja" }],
    },
    {
      name: "findMissingLocalizations: extra languages beyond required list are ignored",
      run: () =>
        findMissingLocalizations({
          xcstringsKeys: new Map([["a", new Set(["fr", "ja", "xx"])]]),
          requiredLangs: ["fr", "ja"],
          allowlist: {},
        }),
      expect: [],
    },
    {
      name: "isAllowlisted (via findMissing): allowlist with non-string value does NOT excuse",
      run: () =>
        findMissingLocalizations({
          xcstringsKeys: new Map([["a", new Set([])]]),
          requiredLangs: ["fr"],
          // @ts-expect-error: deliberately bad shape
          allowlist: { a: { fr: true } },
        }),
      expect: [{ key: "a", lang: "fr" }],
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

function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(XCSTRINGS_PATH, "utf8"));
  } catch (err) {
    console.error(
      `failed to read ${relative(repoRoot, XCSTRINGS_PATH)}: ${err.message}`,
    );
    process.exit(2);
  }

  let requiredLangs;
  try {
    requiredLangs = listWearSupportedLangs(WEAR_RES_DIR);
  } catch (err) {
    console.error(
      `failed to list ${relative(repoRoot, WEAR_RES_DIR)}: ${err.message}`,
    );
    process.exit(2);
  }
  if (requiredLangs.length === 0) {
    console.error(
      `no values-XX/ directories found under ${relative(repoRoot, WEAR_RES_DIR)} — nothing to check against`,
    );
    process.exit(2);
  }

  const { sourceLanguage, keys } = summariseXcstrings(parsed);
  // The xcstrings source language ("en") shouldn't appear in the
  // required list — the wear-os module mirrors the same choice with a
  // separate `values/` directory (no language suffix), so it isn't in
  // `requiredLangs` to begin with. Defensive filter in case that ever
  // changes.
  const required = requiredLangs.filter((l) => l !== sourceLanguage);

  const missing = findMissingLocalizations({
    xcstringsKeys: keys,
    requiredLangs: required,
    allowlist: UNTRANSLATED_ALLOWLIST,
  });

  if (missing.length > 0) {
    console.error(
      `\ncheck-watch-xcstrings-coverage: found ${missing.length} missing per-key localization${missing.length === 1 ? "" : "s"} in ${relative(repoRoot, XCSTRINGS_PATH)}:\n`,
    );
    for (const { key, lang } of missing) {
      console.error(
        `  - [${lang}] key "${key}" has no localizations entry (iOS would silently fall back to the ${sourceLanguage} source value at runtime)`,
      );
    }
    console.error(
      `\nAdd the missing per-language entries to ${relative(repoRoot, XCSTRINGS_PATH)}, or — if a key is genuinely meant to stay in the source language in every locale (e.g. a brand label) — extend UNTRANSLATED_ALLOWLIST in scripts/check-watch-xcstrings-coverage.mjs with a written reason.\n`,
    );
    process.exit(1);
  }

  console.log(
    `check-watch-xcstrings-coverage: scanned ${keys.size} key${keys.size === 1 ? "" : "s"} across ${required.length} required language${required.length === 1 ? "" : "s"} (derived from ${relative(repoRoot, WEAR_RES_DIR)}/values-XX/) — every key has a localizations entry (or is explicitly allowlisted).`,
  );
}

main();
