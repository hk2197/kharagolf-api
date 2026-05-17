#!/usr/bin/env node
/**
 * Repository guard against missing or untranslated string entries in the
 * mobile app's i18n bundles (Task #1414).
 *
 * The mobile profile screen recently shipped 3 keys that were missing from
 * every non-English locale and ~110 keys per locale that silently held the
 * English fallback string. Members on those locales saw raw English copy on
 * an otherwise-localized screen and nothing in the build flagged it. This
 * script walks every bundle under
 *
 *   artifacts/kharagolf-mobile/i18n/locales/en/<file>.json
 *
 * and, for every other locale directory, asserts that:
 *
 *   1. The corresponding `<lang>/<file>.json` exists and contains every key
 *      defined in the English bundle (recursing into nested objects), and
 *   2. Each leaf value in the locale bundle is NOT byte-identical to the
 *      English source value, except when the English source is a documented
 *      loanword (FIR, GIR, Tee, Bunker, Rough, Handicap, Format, language
 *      autonyms, brand strings, placeholder-only values, etc.) — see the
 *      ALLOWED_IDENTICAL_VALUES allowlist below.
 *
 * Two escape hatches keep the check practical:
 *
 *   - ALLOWED_IDENTICAL_VALUES: English source strings that are universally
 *     acceptable across every locale (loanwords, brand, autonyms, …). Add
 *     to this list when introducing a new universally-untranslated term.
 *   - scripts/mobile-translations-baseline.json: a generated grandfather
 *     list capturing the missing-key / same-as-English entries that already
 *     existed when this guard was first introduced. Existing offenders are
 *     skipped so the build stays green, but the moment a NEW English key
 *     ships without translations or a NEW locale value falls back to
 *     English, the check fires. Translating a baselined entry shrinks the
 *     baseline on the next refresh — see `--update-baseline`.
 *
 * Always-fatal failure kinds (NEVER baselined): `type-mismatch` and
 * `missing-file`. Those indicate structural problems that are worth fixing
 * immediately rather than grandfathering.
 *
 * Flags:
 *   --self-test         exercise the detection logic with fixture cases
 *   --update-baseline   rewrite scripts/mobile-translations-baseline.json
 *                       from the current locale state and exit 0
 */
import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

const LOCALES_DIR = join(
  repoRoot,
  "artifacts",
  "kharagolf-mobile",
  "i18n",
  "locales",
);

const BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "mobile-translations-baseline.json",
);

const SOURCE_LANG = "en";

/** Failure kinds eligible for baselining (existing offenders may be
 * grandfathered). All other kinds always fail the build. */
const BASELINEABLE_KINDS = new Set(["missing-key", "same-as-english"]);

/**
 * Strict-translation prefixes (Task #1743).
 *
 * Some recently-added key namespaces are too important to ever fall
 * back to English: a missing or untranslated entry would silently
 * re-introduce the regression the originating task was meant to fix.
 * The lint refuses to baseline anything under these prefixes — even if
 * `--update-baseline` is run, the entries are filtered out and the
 * next plain lint pass fails loudly.
 *
 * Each entry matches a `<file>` (relative to a locale directory) and a
 * dotted-key prefix. Prefix match is left-anchored: an entry with
 * keyPrefix `"commPrefs.emailOptOuts."` matches any leaf under that
 * subtree but does NOT match `commPrefs.emailOptOutsLegacy.*`.
 */
export const STRICT_TRANSLATION_PREFIXES = [
  // Per-event email opt-out labels, descriptions, and section copy on
  // the mobile communications screen. Every per-event row would
  // otherwise re-render in English under non-English locales.
  { file: "profile.json", keyPrefix: "commPrefs.emailOptOuts." },
  // Per-notification row descriptions on the mobile notification
  // preferences screen (Task #2165). The companion lint
  // `check-notification-row-translations.mjs` ensures every digestable
  // key in `notificationRegistry.ts` has an English entry here; this
  // strict prefix then ensures the other 20 locales must translate it
  // — the entry can't be silently grandfathered via --update-baseline.
  { file: "profile.json", keyPrefix: "commPrefs.notificationKeys." },
];

/**
 * True when this `(file, key)` pair is governed by a strict-translation
 * prefix and therefore can never be grandfathered via the baseline.
 */
export function isStrictTranslationKey(file, key) {
  return STRICT_TRANSLATION_PREFIXES.some(
    (entry) => entry.file === file && key.startsWith(entry.keyPrefix),
  );
}

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

/**
 * English source values that are universally acceptable as the locale value
 * even when byte-identical. These are loanwords, acronyms, brand strings,
 * golf jargon, and language autonyms that travel unchanged across scripts.
 *
 * Match is exact after trimming surrounding whitespace and lowercasing —
 * extend the list rather than adding regexes so the intent stays auditable.
 */
const ALLOWED_IDENTICAL_VALUES_RAW = [
  // ----- brand & product -----
  "KHARAGOLF",
  "AI",
  "AI Caddie",
  // ----- generic acronyms / units -----
  "OK",
  "GPS",
  "WHS",
  "PIN",
  "API",
  "SMS",
  "URL",
  "ID",
  "QR",
  "PDF",
  "CSV",
  "yds",
  "m",
  "km",
  "kg",
  "ft",
  "mph",
  "kph",
  // ----- golf scoring acronyms / loanwords -----
  "FIR",
  "GIR",
  "Par",
  "Birdie",
  "Eagle",
  "Bogey",
  "Albatross",
  "Tee",
  "Bunker",
  "Rough",
  "Hazard",
  "Green",
  "Fairway",
  "Handicap",
  "Format",
  "R&A",
  "USGA",
  // ----- third-party brand names that stay untranslated -----
  "WhatsApp",
  "Apple",
  "Google",
  "iOS",
  "Android",
  "Wear OS",
  "watchOS",
  // ----- language autonyms -----
  "English",
  "Hindi",
  "Arabic",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Indonesian",
  "Malay",
  "Filipino",
  "Vietnamese",
  "Thai",
  "Korean",
  "Japanese",
  "Chinese",
  "Swahili",
  "Hausa",
  "Yoruba",
  "Zulu",
  "Afrikaans",
  "Amharic",
  // ----- additional golf scoring loanwords -----
  "Bogeys",
  "Birdies",
  "Eagles",
  "Pars",
  "Putts",
  "Pts",
  "pts",
  "HCP {{hcp}}",
  "Dbl+",
  "H2H",
  "Hole-in-One",
  "Snake",
  "Stableford",
  "Foursomes",
  "Four-Ball",
  "Singles",
  "Match Play",
  "Match {{n}}",
  "Hole {{n}}",
  "Round {{n}}",
  "Round {{count}}",
  "Round",
  "Ryder Cup",
  "Sudden-Death Playoff",
  "Top 3",
  "World Handicap System",
  "World Handicap Index",
  "Handicap Index",
  "WHS Index",
  "Driving Range",
  "Caddies",
  "Marker",
  "Coach",
  "Junior",
  "Bracket",
  "Tee Sheet",
  "Tee Times",
  "Tee off",
  "Tee group #{{id}}",
  "Scorecard",
  "Standings",
  "Golfer",
  "Flight",
  "Flight {{flight}}",
  "Bay {{num}}",
  "Bay {{number}}",
  "Fantasy",
  "Fantasy Golf",
  "Tracker",
  "Simul.",
  "(alt: {{club}})",
  "{{count}} yds",
  // ----- universal UI / commerce loanwords -----
  "Status",
  "LIVE",
  "Live",
  "SALE",
  "TIME",
  "HOLE",
  "PLAYERS",
  "Score",
  "Net",
  "Gross",
  "Subtotal",
  "Total",
  "Total: {{amount}}",
  "Cash on Delivery",
  "Sponsored",
  "Setup",
  "Refund",
  "Edit",
  "Email",
  "Draft",
  "Draft {{name}}?",
  "Chat",
  "Docs",
  "Menu",
  "Cart",
  "Cart ({{count}})",
  "Order",
  "Order #{{id}}",
  "Order #{{id}} \u2014 {{status}}",
  "Profile",
  "Account",
  "Wallet",
  "Checkout",
  "Feed",
  "Updates",
  "Details",
  "Error",
  "Name",
  "Date",
  "No",
  "Shop",
  "Color",
  "Club",
  "Peak",
  "Locker {{number}}",
  "Return: {{status}}",
  "{{n}} per roster",
  "{{count}} review",
  " ({{period}})",
  "min {{min}}",
  "max {{max}}",
  "R{{round}} \u00b7 {{time}}",
  "League \u00b7 {{format}}",
  "\u2014 CUT LINE \u2014",
  // ----- words shared identically by Romance languages -----
  "Documents",
  "Notifications",
  "Important",
  "General",
];

const ALLOWED_IDENTICAL_VALUES = new Set(
  ALLOWED_IDENTICAL_VALUES_RAW.map((s) => s.trim().toLowerCase()),
);

/**
 * True when the English source has no translatable letter content (e.g. a
 * pure placeholder like "{{count}}" or "%d", a numeric/symbolic string, or
 * a single emoji). Such values legitimately stay byte-identical in every
 * locale.
 */
function sourceHasTranslatableContent(source) {
  // strip i18next placeholders, format specifiers, escapes, XML entities.
  const stripped = source
    .replace(/\{\{[^}]+\}\}/g, " ")
    .replace(/%(?:\d+\$)?[+-]?\d*\.?\d*[a-zA-Z@]/g, " ")
    .replace(/%%/g, " ")
    .replace(/\\[nrt'"\\]/g, " ")
    .replace(/&(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, " ");
  const letters = stripped.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]+/g, "");
  return letters.length >= 2;
}

/** True when the source is a universally-acceptable loanword/brand/autonym. */
function isAllowlistedIdentical(source) {
  if (ALLOWED_IDENTICAL_VALUES.has(source.trim().toLowerCase())) return true;
  // Also accept when the only translatable content (after stripping i18next
  // placeholders and surrounding punctuation) is an allowlisted token. This
  // covers patterns like "SI {{si}}" or "Par {{par}}" where the label itself
  // is a universal golf acronym/loanword that travels unchanged across
  // locales but appears alongside a number.
  const placeholderless = source.replace(/\{\{[^}]+\}\}/g, " ");
  const lettersOnly = placeholderless
    .replace(/[^A-Za-zÀ-ÖØ-öø-ÿ\s]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (lettersOnly && ALLOWED_IDENTICAL_VALUES.has(lettersOnly)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// JSON traversal
// ---------------------------------------------------------------------------

/**
 * Flatten a nested object into an array of [dottedKey, leafValue] entries.
 * Anything that is not a plain object becomes a leaf — including arrays.
 */
export function flattenLeaves(obj, prefix = "") {
  /** @type {Array<[string, unknown]>} */
  const out = [];
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    if (prefix !== "") out.push([prefix, obj]);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix === "" ? k : `${prefix}.${k}`;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flattenLeaves(v, next));
    } else {
      out.push([next, v]);
    }
  }
  return out;
}

/**
 * Decide which failures fire for a single entry. Returns a list of
 * descriptors — empty when the entry is fine.
 */
export function inspectEntry({ lang, file, key, source, value }) {
  /** @type {Array<{ kind: string, detail: string }>} */
  const failures = [];
  if (lang === SOURCE_LANG) return failures;

  if (value === undefined) {
    failures.push({
      kind: "missing-key",
      detail: `key is missing (English source: ${JSON.stringify(source)})`,
    });
    return failures;
  }

  if (typeof source !== typeof value) {
    failures.push({
      kind: "type-mismatch",
      detail: `expected ${typeof source} but got ${typeof value} (${JSON.stringify(value)})`,
    });
    return failures;
  }

  if (typeof source === "string" && typeof value === "string") {
    if (source === value && sourceHasTranslatableContent(source)) {
      if (!isAllowlistedIdentical(source)) {
        failures.push({
          kind: "same-as-english",
          detail: `value is byte-identical to English source: ${JSON.stringify(value)}`,
        });
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// File loaders
// ---------------------------------------------------------------------------

function listLocaleDirs(localesDir) {
  return readdirSync(localesDir)
    .filter((entry) => {
      try {
        return statSync(join(localesDir, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function listJsonFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// Baseline I/O
// ---------------------------------------------------------------------------

/**
 * Load the baseline file into a Set of canonical keys
 * `${kind}::${lang}::${file}::${dottedKey}`. Returns an empty Set when the
 * baseline file does not exist.
 */
export function loadBaseline(path = BASELINE_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return new Set();
    throw err;
  }
  const data = JSON.parse(raw);
  const set = new Set();
  const sections = [
    ["missing-key", data.missingKeys],
    ["same-as-english", data.sameAsEnglish],
  ];
  for (const [kind, byLang] of sections) {
    if (!byLang) continue;
    for (const [lang, byFile] of Object.entries(byLang)) {
      for (const [file, keys] of Object.entries(byFile)) {
        for (const key of keys) {
          set.add(`${kind}::${lang}::${file}::${key}`);
        }
      }
    }
  }
  return set;
}

function buildBaselineDoc(failures) {
  /** @type {{missingKeys: Record<string,Record<string,string[]>>, sameAsEnglish: Record<string,Record<string,string[]>>}} */
  const doc = {
    $comment:
      "Generated by `pnpm run lint:mobile-translations:update-baseline`. " +
      "Entries here are grandfathered and not re-flagged. The lint still " +
      "fires on any NEW missing or untranslated key. Translate an entry to " +
      "shrink this file on the next refresh.",
    $generatedAt: new Date().toISOString(),
    missingKeys: {},
    sameAsEnglish: {},
  };
  for (const f of failures) {
    if (!BASELINEABLE_KINDS.has(f.kind)) continue;
    // Strict-translation keys (Task #1743) are never grandfathered, so
    // we also refuse to write them into a freshly-rebuilt baseline.
    // Otherwise `--update-baseline` would silently hide a regression
    // and the next plain lint run would not catch it.
    if (isStrictTranslationKey(f.file, f.key)) continue;
    const bucket = f.kind === "missing-key" ? doc.missingKeys : doc.sameAsEnglish;
    if (!bucket[f.lang]) bucket[f.lang] = {};
    if (!bucket[f.lang][f.file]) bucket[f.lang][f.file] = [];
    bucket[f.lang][f.file].push(f.key);
  }
  // Stable, sorted output so diffs stay tiny.
  for (const bucket of [doc.missingKeys, doc.sameAsEnglish]) {
    for (const lang of Object.keys(bucket)) {
      const files = bucket[lang];
      const sortedFiles = {};
      for (const file of Object.keys(files).sort()) {
        sortedFiles[file] = [...new Set(files[file])].sort();
      }
      bucket[lang] = sortedFiles;
    }
    const sortedLangs = {};
    for (const lang of Object.keys(bucket).sort()) sortedLangs[lang] = bucket[lang];
    if (bucket === doc.missingKeys) doc.missingKeys = sortedLangs;
    else doc.sameAsEnglish = sortedLangs;
  }
  return doc;
}

function writeBaseline(doc, path = BASELINE_PATH) {
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

function scanAllBundles(localesDir = LOCALES_DIR) {
  const allLangs = listLocaleDirs(localesDir);
  if (!allLangs.includes(SOURCE_LANG)) {
    throw new Error(
      `source locale "${SOURCE_LANG}" not found under ${relative(repoRoot, localesDir)}`,
    );
  }
  const enDir = join(localesDir, SOURCE_LANG);
  const enFiles = listJsonFiles(enDir);

  /** @type {Array<{ lang: string, file: string, key: string, kind: string, detail: string }>} */
  const failures = [];
  let scannedKeys = 0;
  let scannedLocales = 0;

  for (const file of enFiles) {
    let enLeaves;
    try {
      enLeaves = flattenLeaves(readJson(join(enDir, file)));
    } catch (err) {
      throw new Error(
        `failed to parse ${relative(repoRoot, join(enDir, file))}: ${err.message}`,
      );
    }
    const enMap = new Map(enLeaves);

    for (const lang of allLangs) {
      if (lang === SOURCE_LANG) continue;
      scannedLocales += 1;
      const langPath = join(localesDir, lang, file);
      let langLeaves;
      try {
        langLeaves = flattenLeaves(readJson(langPath));
      } catch (err) {
        for (const [key, source] of enMap) {
          failures.push({
            lang,
            file,
            key,
            kind: "missing-file",
            detail: `bundle is missing or unparseable (${err.code ?? err.message}); English source: ${JSON.stringify(source)}`,
          });
          scannedKeys += 1;
        }
        continue;
      }
      const langMap = new Map(langLeaves);
      for (const [key, source] of enMap) {
        scannedKeys += 1;
        const value = langMap.get(key);
        for (const f of inspectEntry({ lang, file, key, source, value })) {
          failures.push({ lang, file, key, kind: f.kind, detail: f.detail });
        }
      }
    }
  }

  return { failures, scannedKeys, scannedLocales, enFiles, allLangs };
}

/**
 * Partition failures against a baseline. Returns:
 *   - `active`: failures NOT in the baseline (these fail the build).
 *   - `grandfathered`: failures in the baseline (silently allowed).
 *   - `staleBaselineEntries`: baseline entries no longer matched by any
 *     live failure (informational — clean them up via --update-baseline).
 */
export function applyBaseline(failures, baseline) {
  const active = [];
  const grandfathered = [];
  const seen = new Set();
  for (const f of failures) {
    // Strict-translation keys (Task #1743) bypass the baseline entirely
    // — even if a stale baseline still lists them, the failure is
    // re-promoted to active so the build catches the regression.
    if (
      BASELINEABLE_KINDS.has(f.kind) &&
      !isStrictTranslationKey(f.file, f.key)
    ) {
      const id = `${f.kind}::${f.lang}::${f.file}::${f.key}`;
      if (baseline.has(id)) {
        grandfathered.push(f);
        seen.add(id);
        continue;
      }
    }
    active.push(f);
  }
  const staleBaselineEntries = [...baseline].filter((id) => !seen.has(id));
  return { active, grandfathered, staleBaselineEntries };
}

// ---------------------------------------------------------------------------
// Self-test fixtures
// ---------------------------------------------------------------------------

function runSelfTest() {
  const cases = [
    // ---- missing-key ----
    {
      name: "missing key in non-English locale fails",
      args: { lang: "hi", file: "profile.json", key: "loyalty.empty", source: "Empty", value: undefined },
      expectKinds: ["missing-key"],
    },
    {
      name: "missing key in English locale is ignored",
      args: { lang: "en", file: "profile.json", key: "loyalty.empty", source: "Empty", value: undefined },
      expectKinds: [],
    },
    // ---- same-as-english ----
    {
      name: "byte-identical English copy fails",
      args: { lang: "de", file: "profile.json", key: "loyalty.section", source: "Loyalty & Rewards", value: "Loyalty & Rewards" },
      expectKinds: ["same-as-english"],
    },
    {
      name: "FIR loanword stays untranslated and passes",
      args: { lang: "de", file: "profile.json", key: "roundTable.fir", source: "FIR", value: "FIR" },
      expectKinds: [],
    },
    {
      name: "Bunker loanword stays untranslated and passes",
      args: { lang: "de", file: "profile.json", key: "caddieLie.bunker", source: "Bunker", value: "Bunker" },
      expectKinds: [],
    },
    {
      name: "Format loanword stays untranslated and passes",
      args: { lang: "de", file: "profile.json", key: "scoringHistory.format", source: "Format", value: "Format" },
      expectKinds: [],
    },
    {
      name: "language autonym 'English' stays untranslated and passes",
      args: { lang: "de", file: "common.json", key: "languages.en", source: "English", value: "English" },
      expectKinds: [],
    },
    {
      name: "Brand string KHARAGOLF stays untranslated and passes",
      args: { lang: "ja", file: "common.json", key: "brand", source: "KHARAGOLF", value: "KHARAGOLF" },
      expectKinds: [],
    },
    {
      name: "Pure placeholder source stays identical and passes",
      args: { lang: "de", file: "common.json", key: "count", source: "{{count}}", value: "{{count}}" },
      expectKinds: [],
    },
    {
      name: "Format-specifier-only source stays identical and passes",
      args: { lang: "de", file: "common.json", key: "raw_pct", source: "%d%%", value: "%d%%" },
      expectKinds: [],
    },
    {
      name: "Translated value differing from source passes",
      args: { lang: "hi", file: "profile.json", key: "myProfile", source: "My Profile", value: "मेरी प्रोफ़ाइल" },
      expectKinds: [],
    },
    {
      name: "English source identical to English value is not flagged",
      args: { lang: "en", file: "common.json", key: "save", source: "Save", value: "Save" },
      expectKinds: [],
    },
    // ---- type-mismatch ----
    {
      name: "Type mismatch fails",
      args: { lang: "de", file: "profile.json", key: "statsLabels", source: "Stats", value: { tournaments: "Turniere" } },
      expectKinds: ["type-mismatch"],
    },
    // ---- regression scenarios ----
    {
      name: "Regression: 'Save' falling back to English in a translated locale fails",
      args: { lang: "ja", file: "common.json", key: "save", source: "Save", value: "Save" },
      expectKinds: ["same-as-english"],
    },
    {
      name: "Regression: a newly-added English key without a translation fails",
      args: { lang: "ja", file: "profile.json", key: "newSectionTitle", source: "Brand New Section", value: undefined },
      expectKinds: ["missing-key"],
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = inspectEntry(c.args).map((f) => f.kind).sort();
    const want = [...c.expectKinds].sort();
    const ok = got.length === want.length && got.every((k, i) => k === want[i]);
    if (!ok) {
      failed += 1;
      console.error(
        `  ✗ ${c.name}\n      expected kinds: [${want.join(", ")}]\n      got kinds:      [${got.join(", ")}]`,
      );
    } else {
      console.log(`  ✓ ${c.name}`);
    }
  }

  // Sanity-check the flatten helper.
  const flat = flattenLeaves({ a: 1, b: { c: "x", d: { e: "y" } } });
  const flatExpected = [
    ["a", 1],
    ["b.c", "x"],
    ["b.d.e", "y"],
  ];
  const flatOk =
    flat.length === flatExpected.length &&
    flat.every(([k, v], i) => k === flatExpected[i][0] && v === flatExpected[i][1]);
  if (!flatOk) {
    failed += 1;
    console.error(
      `  ✗ flattenLeaves produced ${JSON.stringify(flat)}, expected ${JSON.stringify(flatExpected)}`,
    );
  } else {
    console.log(`  ✓ flattenLeaves recurses nested objects into dotted keys`);
  }

  // Baseline behaviour.
  const fakeFailures = [
    { lang: "de", file: "profile.json", key: "old.key", kind: "same-as-english", detail: "..." },
    { lang: "de", file: "profile.json", key: "new.key", kind: "same-as-english", detail: "..." },
    { lang: "fr", file: "common.json", key: "missingOldOne", kind: "missing-key", detail: "..." },
    { lang: "de", file: "profile.json", key: "structuralBug", kind: "type-mismatch", detail: "..." },
    // Strict-translation key (Task #1743) that is *also* listed in the
    // baseline below — applyBaseline should refuse to grandfather it.
    { lang: "ja", file: "profile.json", key: "commPrefs.emailOptOuts.manualEntryLabel", kind: "same-as-english", detail: "..." },
  ];
  const baseline = new Set([
    "same-as-english::de::profile.json::old.key",
    "missing-key::fr::common.json::missingOldOne",
    "same-as-english::de::profile.json::alreadyFixed",
    "same-as-english::ja::profile.json::commPrefs.emailOptOuts.manualEntryLabel",
  ]);
  const part = applyBaseline(fakeFailures, baseline);
  const wantActive = [
    "same-as-english::de::profile.json::new.key",
    "type-mismatch::de::profile.json::structuralBug",
    // Strict-translation key bypasses the baseline (Task #1743).
    "same-as-english::ja::profile.json::commPrefs.emailOptOuts.manualEntryLabel",
  ];
  const gotActive = part.active.map((f) => `${f.kind}::${f.lang}::${f.file}::${f.key}`).sort();
  if (JSON.stringify(gotActive) !== JSON.stringify(wantActive.sort())) {
    failed += 1;
    console.error(
      `  ✗ applyBaseline grandfathers known entries; got active=${JSON.stringify(gotActive)}, want=${JSON.stringify(wantActive.sort())}`,
    );
  } else {
    console.log(`  ✓ applyBaseline grandfathers known entries`);
  }
  if (part.grandfathered.length !== 2) {
    failed += 1;
    console.error(`  ✗ applyBaseline counts grandfathered entries (got ${part.grandfathered.length}, want 2)`);
  } else {
    console.log(`  ✓ applyBaseline counts grandfathered entries`);
  }
  const staleWant = [
    "same-as-english::de::profile.json::alreadyFixed",
    // Strict-translation keys are never grandfathered, so any baseline
    // entry that names one is also reported as stale on the next run —
    // prompting `--update-baseline` to drop it from the file.
    "same-as-english::ja::profile.json::commPrefs.emailOptOuts.manualEntryLabel",
  ].sort();
  if (JSON.stringify(part.staleBaselineEntries.sort()) !== JSON.stringify(staleWant)) {
    failed += 1;
    console.error(
      `  ✗ applyBaseline reports stale entries; got ${JSON.stringify(part.staleBaselineEntries)}, want ${JSON.stringify(staleWant)}`,
    );
  } else {
    console.log(`  ✓ applyBaseline reports stale baseline entries`);
  }
  if (!part.active.some((f) => f.kind === "type-mismatch")) {
    failed += 1;
    console.error(`  ✗ applyBaseline never grandfathers type-mismatch failures`);
  } else {
    console.log(`  ✓ applyBaseline never grandfathers type-mismatch failures`);
  }

  // ----- strict-translation prefix behaviour (Task #1743) -----
  if (
    !isStrictTranslationKey(
      "profile.json",
      "commPrefs.emailOptOuts.manualEntryLabel",
    )
  ) {
    failed += 1;
    console.error(
      `  ✗ isStrictTranslationKey matches commPrefs.emailOptOuts.* in profile.json`,
    );
  } else {
    console.log(
      `  ✓ isStrictTranslationKey matches commPrefs.emailOptOuts.* in profile.json`,
    );
  }
  if (
    isStrictTranslationKey(
      "common.json",
      "commPrefs.emailOptOuts.manualEntryLabel",
    )
  ) {
    failed += 1;
    console.error(
      `  ✗ isStrictTranslationKey is scoped to the matching file (profile.json only)`,
    );
  } else {
    console.log(
      `  ✓ isStrictTranslationKey is scoped to the matching file (profile.json only)`,
    );
  }
  if (
    isStrictTranslationKey(
      "profile.json",
      "commPrefs.emailOptOutsLegacy.foo",
    )
  ) {
    failed += 1;
    console.error(
      `  ✗ isStrictTranslationKey prefix match is left-anchored at a dot (rejects emailOptOutsLegacy)`,
    );
  } else {
    console.log(
      `  ✓ isStrictTranslationKey prefix match is left-anchored at a dot`,
    );
  }
  if (
    !part.active.some(
      (f) =>
        f.lang === "ja" &&
        f.key === "commPrefs.emailOptOuts.manualEntryLabel",
    )
  ) {
    failed += 1;
    console.error(
      `  ✗ applyBaseline re-promotes strict-translation failures even when the baseline lists them`,
    );
  } else {
    console.log(
      `  ✓ applyBaseline re-promotes strict-translation failures even when the baseline lists them`,
    );
  }
  // buildBaselineDoc must drop strict failures so `--update-baseline`
  // cannot silently hide them.
  const fakeBaselineDoc = buildBaselineDoc([
    {
      lang: "ja",
      file: "profile.json",
      key: "commPrefs.emailOptOuts.manualEntryLabel",
      kind: "same-as-english",
      detail: "...",
    },
    {
      lang: "ja",
      file: "profile.json",
      key: "someOther.legitimate.key",
      kind: "same-as-english",
      detail: "...",
    },
  ]);
  const jaProfileBucket = fakeBaselineDoc.sameAsEnglish.ja?.["profile.json"] ?? [];
  if (jaProfileBucket.includes("commPrefs.emailOptOuts.manualEntryLabel")) {
    failed += 1;
    console.error(
      `  ✗ buildBaselineDoc drops strict-translation keys (commPrefs.emailOptOuts.* must never be baselined)`,
    );
  } else {
    console.log(
      `  ✓ buildBaselineDoc drops strict-translation keys (commPrefs.emailOptOuts.* never baselined)`,
    );
  }
  if (!jaProfileBucket.includes("someOther.legitimate.key")) {
    failed += 1;
    console.error(
      `  ✗ buildBaselineDoc still records non-strict failures alongside strict-skipped ones`,
    );
  } else {
    console.log(
      `  ✓ buildBaselineDoc still records non-strict failures alongside strict-skipped ones`,
    );
  }

  const totalCases = cases.length + 10;
  if (failed > 0) {
    console.error(`\nself-test: ${failed} case(s) failed`);
    process.exit(1);
  }
  console.log(`\nself-test: all ${totalCases} cases passed`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const updateBaseline = process.argv.includes("--update-baseline");

  let result;
  try {
    result = scanAllBundles();
  } catch (err) {
    console.error(`check-mobile-translations: ${err.message}`);
    process.exit(2);
  }
  const { failures, scannedKeys, scannedLocales, enFiles, allLangs } = result;

  if (updateBaseline) {
    const doc = buildBaselineDoc(failures);
    writeBaseline(doc);
    const missingCount = Object.values(doc.missingKeys).reduce(
      (acc, byFile) => acc + Object.values(byFile).reduce((a, list) => a + list.length, 0),
      0,
    );
    const sameCount = Object.values(doc.sameAsEnglish).reduce(
      (acc, byFile) => acc + Object.values(byFile).reduce((a, list) => a + list.length, 0),
      0,
    );
    console.log(
      `check-mobile-translations: baseline written to ${relative(repoRoot, BASELINE_PATH)} (${missingCount} missing keys + ${sameCount} same-as-English entries grandfathered).`,
    );
    return;
  }

  /** @type {Set<string>} */
  let baseline;
  try {
    baseline = loadBaseline();
  } catch (err) {
    console.error(
      `check-mobile-translations: failed to read baseline at ${relative(repoRoot, BASELINE_PATH)}: ${err.message}`,
    );
    process.exit(2);
  }

  const { active, grandfathered, staleBaselineEntries } = applyBaseline(
    failures,
    baseline,
  );

  if (active.length > 0) {
    /** @type {Map<string, typeof active>} */
    const grouped = new Map();
    for (const f of active) {
      const bucket = `${f.lang}/${f.file}`;
      if (!grouped.has(bucket)) grouped.set(bucket, []);
      grouped.get(bucket).push(f);
    }
    const buckets = [...grouped.keys()].sort();

    console.error(
      `\ncheck-mobile-translations: found ${active.length} new issue${active.length === 1 ? "" : "s"} across ${grouped.size} locale bundle${grouped.size === 1 ? "" : "s"}:\n`,
    );
    for (const bucket of buckets) {
      const items = grouped.get(bucket);
      const counts = items.reduce((acc, item) => {
        acc[item.kind] = (acc[item.kind] ?? 0) + 1;
        return acc;
      }, /** @type {Record<string, number>} */ ({}));
      const summary = Object.entries(counts)
        .map(([k, n]) => `${n} ${k}`)
        .join(", ");
      console.error(
        `  artifacts/kharagolf-mobile/i18n/locales/${bucket}  (${summary})`,
      );
      for (const item of items) {
        console.error(`    [${item.kind}] ${item.key}: ${item.detail}`);
      }
    }
    console.error(
      "\nFix the translations above, or — if a value is a legitimate loanword / brand / autonym — extend ALLOWED_IDENTICAL_VALUES in scripts/check-mobile-translations.mjs.",
    );
    console.error(
      `${grandfathered.length} pre-existing issue${grandfathered.length === 1 ? "" : "s"} are grandfathered via ${relative(repoRoot, BASELINE_PATH)}. Translate them and run \`pnpm run lint:mobile-translations:update-baseline\` to shrink the baseline.\n`,
    );
    process.exit(1);
  }

  if (staleBaselineEntries.length > 0) {
    console.log(
      `check-mobile-translations: ${staleBaselineEntries.length} baseline entr${staleBaselineEntries.length === 1 ? "y is" : "ies are"} no longer needed. Run \`pnpm run lint:mobile-translations:update-baseline\` to clean up.`,
    );
  }

  console.log(
    `check-mobile-translations: scanned ${scannedKeys} key checks across ${scannedLocales} locale bundles (${enFiles.length} English source files, ${allLangs.length - 1} non-English locales) — no NEW missing keys or untranslated fallbacks. ${grandfathered.length} pre-existing issue${grandfathered.length === 1 ? "" : "s"} grandfathered via ${relative(repoRoot, BASELINE_PATH)}.`,
  );
}

main();
