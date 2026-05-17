#!/usr/bin/env node
/**
 * Repository guard against raw English copy sneaking into the mobile
 * app screens (Tasks #1691 and #2104).
 *
 * `scripts/check-mobile-translations.mjs` already proves every locale
 * bundle has a translated value for every English key, but it is blind to
 * a screen that hard-codes English in JSX and never goes through `t(...)`
 * at all. That's how the regressions called out in Task #1397 happened —
 * a brand-new screen lands with `<Text>Upcoming Sessions</Text>` and the
 * non-English locales just see English copy with no warning.
 *
 * This script walks `artifacts/kharagolf-mobile/app/**\/*.tsx`, parses
 * each file with the TypeScript compiler API, and flags four shapes of
 * raw English text that sit OUTSIDE of `t(...)` calls:
 *
 *   1. `JsxText` children of an element  — e.g. `<Text>Hello world</Text>`.
 *   2. `JsxExpression` whose expression is a string / no-substitution
 *      template literal — e.g. `<Text>{"Hello"}</Text>` or
 *      `<Text>{`Hello`}</Text>`.
 *   3. Text-bearing JSX *attributes* whose value is a string / no-
 *      substitution template literal — e.g. `placeholder="Search…"`,
 *      `accessibilityLabel="Close"`, `title={`Save`}`. The set of
 *      attribute names we treat as user-facing copy is curated below
 *      (TEXT_BEARING_ATTRIBUTES). Other attributes (icon names,
 *      testIDs, style identifiers, …) remain ignored.
 *   4. String / no-substitution template literal arguments to React
 *      Native alert/toast helpers — e.g.
 *      `Alert.alert("Cannot save", "Try again later.")`,
 *      `Alert.prompt("Dispute", "Enter reason:", …)`,
 *      `Toast.show("Saved!")`. The set of recognised callees is curated
 *      below (ALERT_LIKE_CALLEES).
 *
 * To keep the noise down we only flag text that contains an alphabetic
 * "word" of length >= 2 after stripping i18next placeholders. A small
 * allowlist covers brand strings, golf loanwords, generic acronyms and
 * the typical handful of single-letter labels that appear in JSX
 * children. Icon names, testIDs and other non-text attributes are not
 * scanned (only the curated TEXT_BEARING_ATTRIBUTES set is).
 *
 * An accompanying baseline file
 * (`scripts/mobile-screen-translations-baseline.json`) grandfathers the
 * existing offenders so the build stays green today; the moment a NEW
 * raw English literal is added to a screen the check fails. Baseline
 * entries are keyed purely on `${file}::${snippet}` so the same shared
 * baseline transparently absorbs all four shapes above.
 *
 * Flags:
 *   --self-test         exercise the detection logic with fixture cases
 *   --update-baseline   rewrite the baseline from the current screen
 *                       state and exit 0
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

const APP_DIR = join(
  repoRoot,
  "artifacts",
  "kharagolf-mobile",
  "app",
);

const BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "mobile-screen-translations-baseline.json",
);

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

/**
 * After stripping placeholders + non-letter chars, a JSX text whose
 * remaining tokens are entirely covered by this set is treated as a
 * legitimate untranslated literal. Match is case-insensitive on each
 * whitespace-separated token.
 *
 * Brand names, generic acronyms, units, golf-jargon loanwords, and the
 * language autonyms that travel unchanged across locales — same spirit
 * as the allowlist in `check-mobile-translations.mjs`, just narrowed to
 * the kinds of single tokens that legitimately appear inside JSX
 * children (e.g. `<Text>KHARAGOLF</Text>` or `<Text>FIR</Text>`).
 */
const ALLOWED_TOKENS_RAW = [
  // brand & product
  "kharagolf",
  "ai",
  // generic acronyms / units
  "ok",
  "max",
  "gps",
  "whs",
  "pin",
  "api",
  "sms",
  "url",
  "id",
  "qr",
  "pdf",
  "csv",
  "yds",
  "km",
  "kg",
  "ft",
  "mph",
  "kph",
  // golf scoring acronyms / loanwords
  "fir",
  "gir",
  "hi",
  "si",
  "par",
  "birdie",
  "birdies",
  "eagle",
  "eagles",
  "bogey",
  "bogeys",
  "albatross",
  "tee",
  "bunker",
  "rough",
  "hazard",
  "green",
  "fairway",
  "handicap",
  "format",
  "hcp",
  "putts",
  "pts",
  // third-party brand names that stay untranslated
  "whatsapp",
  "apple",
  "google",
  "ios",
  "android",
  "watchos",
  // language autonyms
  "english",
  "hindi",
  "arabic",
  "spanish",
  "french",
  "german",
  "portuguese",
  "indonesian",
  "malay",
  "filipino",
  "vietnamese",
  "thai",
  "korean",
  "japanese",
  "chinese",
  "swahili",
  "hausa",
  "yoruba",
  "zulu",
  "afrikaans",
  "amharic",
];

const ALLOWED_TOKENS = new Set(ALLOWED_TOKENS_RAW.map((t) => t.toLowerCase()));

/**
 * JSX attribute names whose string-literal values are user-facing copy
 * and therefore should be wrapped in `t(...)` just like JSX children.
 * Anything outside this set (icon names, route names, testIDs, style
 * identifiers, URLs, …) is intentionally not scanned to keep noise low.
 */
const TEXT_BEARING_ATTRIBUTES = new Set([
  "placeholder",
  "title",
  "subtitle",
  "label",
  "helperText",
  "description",
  "accessibilityLabel",
  "accessibilityHint",
]);

/**
 * `<Object>.<method>` callees that take user-facing copy as string
 * arguments. We flag any string / no-substitution-template-literal
 * argument passed to one of these calls. Matched lexically on the
 * source text — we don't try to follow re-exports / aliases.
 */
const ALERT_LIKE_CALLEES = new Set([
  "Alert.alert",
  "Alert.prompt",
  "Toast.show",
  "Toast.showWithGravity",
  "Toast.showWithGravityAndOffset",
]);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Strip i18next-style placeholders and non-letter characters, return the
 * remaining alphabetic words (lowercased). Empty array means the value
 * has no translatable letter content.
 */
export function extractAlphabeticWords(text) {
  const stripped = text
    .replace(/\{\{[^}]+\}\}/g, " ") // {{count}}
    .replace(/\$\{[^}]+\}/g, " ") // ${expr} inside template literals
    .replace(/%(?:\d+\$)?[+-]?\d*\.?\d*[a-zA-Z@]/g, " ") // %d, %s, %@, %1$d…
    .replace(/%%/g, " ");
  const words = stripped.match(/[A-Za-z]{2,}/g);
  return (words ?? []).map((w) => w.toLowerCase());
}

/**
 * True when `text` looks like raw English copy that should be wrapped in
 * `t(...)`. We require at least one alphabetic word of length >= 2 (so
 * "OK" passes through but a single ":" or "—" does not), and we accept
 * the value when EVERY remaining word is in the allowlist (so
 * "<Text>KHARAGOLF</Text>" is fine but "<Text>KHARAGOLF Pro</Text>" is
 * flagged because "pro" is not allowlisted).
 */
export function isLikelyEnglishLiteral(text) {
  const words = extractAlphabeticWords(text);
  if (words.length === 0) return false;
  return words.some((w) => !ALLOWED_TOKENS.has(w));
}

/** Normalise a snippet for the baseline key — collapse runs of
 * whitespace and trim. Two literals that differ only by indentation /
 * line-breaks should hash to the same baseline entry. */
function normaliseSnippet(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Return the lexical `Object.method` form of a CallExpression's callee
 * when it is a simple property access like `Alert.alert` /
 * `Toast.show`. Returns `null` for anything more elaborate (chained
 * member access, computed access, plain identifiers, …) — we only want
 * to recognise the canonical React Native helpers, not accidentally
 * match user-defined `foo.alert("hi")` helpers that happen to share a
 * method name.
 *
 * @param {ts.Expression} expr
 * @returns {string | null}
 */
export function getMemberCalleeName(expr) {
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    ts.isIdentifier(expr.name)
  ) {
    return `${expr.expression.text}.${expr.name.text}`;
  }
  return null;
}

/**
 * Walk one TSX file and return all offenders as
 * `{ line, snippet, kind }` records. `kind` is one of:
 *
 *   - `"jsx-text"`        — raw English in `JsxText` children.
 *   - `"jsx-expr-string"` — `<Text>{"Hello"}</Text>` style children.
 *   - `"jsx-attribute"`   — `placeholder="Search…"` style attributes.
 *   - `"rn-alert-arg"`    — `Alert.alert("Save failed")` style call args.
 */
export function scanSource(source, filename = "input.tsx") {
  const sf = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TSX,
  );

  /** @type {Array<{ line: number, snippet: string, kind: string }>} */
  const offenders = [];

  /**
   * Push one offender after running the same `isLikelyEnglishLiteral`
   * gate used everywhere else. Centralised so all four shapes share
   * the exact same allowlist + placeholder-stripping behaviour.
   */
  function record(rawText, anchorNode, kind) {
    if (typeof rawText !== "string") return;
    if (!isLikelyEnglishLiteral(rawText)) return;
    const { line } = sf.getLineAndCharacterOfPosition(anchorNode.getStart(sf));
    offenders.push({
      line: line + 1,
      snippet: normaliseSnippet(rawText),
      kind,
    });
  }

  /** @param {ts.Node} node */
  function visit(node) {
    if (ts.isJsxText(node)) {
      record(node.text, node, "jsx-text");
    } else if (ts.isJsxExpression(node) && node.expression) {
      // JsxExpression nodes appear both as element children
      // (`<Text>{x}</Text>`) AND as attribute initializers
      // (`title={x}`). We only handle the *child* position here;
      // attribute-initializer JsxExpressions are handled below in the
      // JsxAttribute branch so that the curated TEXT_BEARING_ATTRIBUTES
      // gate is enforced and we don't double-flag the same literal.
      const parent = node.parent;
      if (
        parent &&
        (ts.isJsxElement(parent) || ts.isJsxFragment(parent))
      ) {
        const expr = node.expression;
        if (
          ts.isStringLiteral(expr) ||
          ts.isNoSubstitutionTemplateLiteral(expr)
        ) {
          record(expr.text, node, "jsx-expr-string");
        }
      }
    } else if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      const attrName = node.name.text;
      if (TEXT_BEARING_ATTRIBUTES.has(attrName) && node.initializer) {
        const init = node.initializer;
        if (ts.isStringLiteral(init)) {
          // attr="literal"
          record(init.text, node, "jsx-attribute");
        } else if (ts.isJsxExpression(init) && init.expression) {
          // attr={"literal"} or attr={`literal`}
          const expr = init.expression;
          if (
            ts.isStringLiteral(expr) ||
            ts.isNoSubstitutionTemplateLiteral(expr)
          ) {
            record(expr.text, node, "jsx-attribute");
          }
        }
      }
    } else if (ts.isCallExpression(node)) {
      const callee = getMemberCalleeName(node.expression);
      if (callee && ALERT_LIKE_CALLEES.has(callee)) {
        for (const arg of node.arguments) {
          if (
            ts.isStringLiteral(arg) ||
            ts.isNoSubstitutionTemplateLiteral(arg)
          ) {
            record(arg.text, arg, "rn-alert-arg");
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return offenders;
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

function walkTsxFiles(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTsxFiles(full, out);
    } else if (st.isFile() && full.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Baseline I/O
// ---------------------------------------------------------------------------

/**
 * Load the baseline as a Set of `${file}::${snippet}` keys. Missing file
 * → empty Set.
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
  for (const [file, snippets] of Object.entries(data.literals ?? {})) {
    for (const snippet of snippets) set.add(`${file}::${snippet}`);
  }
  return set;
}

function buildBaselineDoc(failures) {
  /** @type {Record<string, string[]>} */
  const literals = {};
  for (const f of failures) {
    if (!literals[f.file]) literals[f.file] = [];
    literals[f.file].push(f.snippet);
  }
  // dedup + sort for stable diffs
  for (const file of Object.keys(literals)) {
    literals[file] = [...new Set(literals[file])].sort();
  }
  const sortedLiterals = {};
  for (const file of Object.keys(literals).sort()) {
    sortedLiterals[file] = literals[file];
  }
  return {
    $comment:
      "Generated by `pnpm run lint:mobile-screen-translations:update-baseline`. " +
      "Entries here are grandfathered raw English JSX literals that already " +
      "existed on the day this guard shipped; they are NOT re-flagged. The " +
      "lint still fires on any NEW raw English literal added to a mobile " +
      "screen. Translating an entry — i.e. wrapping it in `t(...)` — shrinks " +
      "this file on the next refresh.",
    $generatedAt: new Date().toISOString(),
    literals: sortedLiterals,
  };
}

function writeBaseline(doc, path = BASELINE_PATH) {
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

/**
 * Partition `failures` against `baseline`. Returns `active` (NOT in
 * baseline → fail the build) and `grandfathered` (in baseline →
 * silently allowed) plus `staleBaselineEntries` (baseline keys that no
 * live failure matched, informational only).
 */
export function applyBaseline(failures, baseline) {
  const active = [];
  const grandfathered = [];
  const seen = new Set();
  for (const f of failures) {
    const id = `${f.file}::${f.snippet}`;
    if (baseline.has(id)) {
      grandfathered.push(f);
      seen.add(id);
    } else {
      active.push(f);
    }
  }
  const staleBaselineEntries = [...baseline].filter((id) => !seen.has(id));
  return { active, grandfathered, staleBaselineEntries };
}

// ---------------------------------------------------------------------------
// Self-test fixtures
// ---------------------------------------------------------------------------

function runSelfTest() {
  let failed = 0;

  // ---- isLikelyEnglishLiteral ----
  const literalCases = [
    { name: "simple english phrase fails", value: "Hello world", expect: true },
    { name: "trimmed english fails", value: "  Submit  ", expect: true },
    {
      name: "english fragment alongside placeholder fails",
      value: "Score: {{score}}",
      expect: true,
    },
    {
      name: "english fragment alongside template expr fails",
      value: "Hello ${name}",
      expect: true,
    },
    {
      name: "punctuation only is ignored",
      value: " — · → ",
      expect: false,
    },
    {
      name: "single non-letter character is ignored",
      value: ":",
      expect: false,
    },
    { name: "purely numeric is ignored", value: "42", expect: false },
    {
      name: "single-letter run is ignored",
      value: "a b c",
      expect: false,
    },
    {
      name: "placeholder-only value is ignored",
      value: "{{count}}",
      expect: false,
    },
    {
      name: "format-specifier-only value is ignored",
      value: "%d%%",
      expect: false,
    },
    {
      name: "brand-only value passes",
      value: "KHARAGOLF",
      expect: false,
    },
    {
      name: "FIR golf loanword passes",
      value: "FIR",
      expect: false,
    },
    {
      name: "Brand + extra english fails (Pro is not allowlisted)",
      value: "KHARAGOLF Pro",
      expect: true,
    },
    {
      name: "Whitespace + newlines are ignored",
      value: "\n   \n   \n",
      expect: false,
    },
  ];
  for (const c of literalCases) {
    const got = isLikelyEnglishLiteral(c.value);
    if (got !== c.expect) {
      failed += 1;
      console.error(
        `  ✗ ${c.name}\n      isLikelyEnglishLiteral(${JSON.stringify(c.value)}) = ${got}, want ${c.expect}`,
      );
    } else {
      console.log(`  ✓ ${c.name}`);
    }
  }

  // ---- scanSource ----
  const scanCases = [
    {
      name: "raw <Text>English</Text> is flagged",
      source: `export default () => <Text>Hello world</Text>;`,
      expectKinds: ["jsx-text"],
    },
    {
      name: "raw <Text>{\"English\"}</Text> is flagged",
      source: `export default () => <Text>{"Hello world"}</Text>;`,
      expectKinds: ["jsx-expr-string"],
    },
    {
      name: "no-substitution template literal is flagged",
      source: "export default () => <Text>{`Hello world`}</Text>;",
      expectKinds: ["jsx-expr-string"],
    },
    {
      name: "<Text>{t('key')}</Text> passes",
      source: `export default () => <Text>{t("greeting")}</Text>;`,
      expectKinds: [],
    },
    {
      name: "<Text>{variable}</Text> passes",
      source: `export default () => <Text>{name}</Text>;`,
      expectKinds: [],
    },
    {
      name: "Brand-only literal passes",
      source: `export default () => <Text>KHARAGOLF</Text>;`,
      expectKinds: [],
    },
    {
      name: "icon name attribute is NOT scanned",
      source: `export default () => <Icon name="arrow-back" />;`,
      expectKinds: [],
    },
    {
      name: "testID attribute is NOT scanned",
      source: `export default () => <View testID="my-juniors-tab" />;`,
      expectKinds: [],
    },
    {
      name: "Alert.alert string args are flagged (rn-alert-arg)",
      source: `Alert.alert("Cannot save", "Try again later.");`,
      expectKinds: ["rn-alert-arg", "rn-alert-arg"],
    },
    {
      name: "Alert.prompt string args are flagged",
      source: `Alert.prompt("Dispute", "Enter reason:", () => {});`,
      expectKinds: ["rn-alert-arg", "rn-alert-arg"],
    },
    {
      name: "Toast.show string arg is flagged",
      source: `Toast.show("Saved successfully");`,
      expectKinds: ["rn-alert-arg"],
    },
    {
      name: "Alert.alert wrapped in t() passes",
      source: `Alert.alert(t("err.title"), t("err.body"));`,
      expectKinds: [],
    },
    {
      name: "Alert.alert with brand-only literal passes",
      source: `Alert.alert("KHARAGOLF", "OK");`,
      expectKinds: [],
    },
    {
      name: "Alert.alert with template substitutions is NOT flagged",
      source: "Alert.alert(`Hello ${name}`, `code ${code}`);",
      expectKinds: [],
    },
    {
      name: "user-defined foo.alert helper is NOT scanned",
      source: `foo.alert("Hello world");`,
      expectKinds: [],
    },
    {
      name: "placeholder attribute literal is flagged",
      source: `export default () => <TextInput placeholder="Search players" />;`,
      expectKinds: ["jsx-attribute"],
    },
    {
      name: "accessibilityLabel attribute literal is flagged",
      source: `export default () => <Pressable accessibilityLabel="Close sheet" />;`,
      expectKinds: ["jsx-attribute"],
    },
    {
      name: "accessibilityHint attribute literal is flagged",
      source: `export default () => <Pressable accessibilityHint="Closes the sheet" />;`,
      expectKinds: ["jsx-attribute"],
    },
    {
      name: "title attribute literal is flagged",
      source: `export default () => <Button title="Save changes" />;`,
      expectKinds: ["jsx-attribute"],
    },
    {
      name: "label attribute literal is flagged",
      source: `export default () => <ToggleRow label="Public profile" />;`,
      expectKinds: ["jsx-attribute"],
    },
    {
      name: "helperText attribute literal is flagged",
      source: `export default () => <Field helperText="Must be at least 8 chars" />;`,
      expectKinds: ["jsx-attribute"],
    },
    {
      name: "description attribute literal is flagged",
      source: `export default () => <ToggleRow description="Display badges & milestones." />;`,
      expectKinds: ["jsx-attribute"],
    },
    {
      name: "subtitle attribute literal is flagged",
      source: `export default () => <Card subtitle="Featured today" />;`,
      expectKinds: ["jsx-attribute"],
    },
    {
      name: "title={`literal`} no-substitution template is flagged",
      source: "export default () => <Button title={`Save changes`} />;",
      expectKinds: ["jsx-attribute"],
    },
    {
      name: "title={\"literal\"} expression-wrapped string is flagged",
      source: `export default () => <Button title={"Save changes"} />;`,
      expectKinds: ["jsx-attribute"],
    },
    {
      name: "title attribute wrapped in t() passes",
      source: `export default () => <Button title={t("save")} />;`,
      expectKinds: [],
    },
    {
      name: "title attribute bound to a variable passes",
      source: `export default () => <Button title={label} />;`,
      expectKinds: [],
    },
    {
      name: "title attribute with template substitutions passes",
      source: "export default () => <Button title={`Hello ${name}`} />;",
      expectKinds: [],
    },
    {
      name: "title attribute with brand-only literal passes",
      source: `export default () => <Button title="KHARAGOLF" />;`,
      expectKinds: [],
    },
    {
      name: "non-text attribute (style identifier) is NOT scanned",
      source: `export default () => <View style="container-row" />;`,
      expectKinds: [],
    },
    {
      name: "non-text attribute (source URL) is NOT scanned",
      source: `export default () => <Image src="https://example.com/photo.png" />;`,
      expectKinds: [],
    },
    {
      name: "JsxExpression-as-attribute does NOT double-flag via children path",
      source: `export default () => <Icon name={"arrow-back-circle"} />;`,
      // `name` is not a text-bearing attribute, AND the children-path
      // handler now skips JsxExpressions whose parent is a JsxAttribute,
      // so this pattern produces zero offenders.
      expectKinds: [],
    },
    {
      name: "punctuation-only JsxText passes",
      source: `export default () => <Text>{name}—{score}</Text>;`,
      expectKinds: [],
    },
    {
      name: "mixed children: only the un-translated, non-allowlisted fragments are flagged",
      source: `
        export default () => (
          <View>
            <Text>Hello world</Text>
            <Text>{t("foo")}</Text>
            <Text>Putts</Text>
            <Text>Submit form</Text>
          </View>
        );
      `,
      expectKinds: ["jsx-text", "jsx-text"],
    },
    {
      name: "mixed shapes in one component are all flagged with their own kind",
      source: `
        export default () => {
          const onPress = () => Alert.alert("Cannot save", "Try again later.");
          return (
            <View>
              <Text>Hello world</Text>
              <TextInput placeholder="Search players" />
              <Pressable accessibilityLabel="Close" onPress={onPress} />
            </View>
          );
        };
      `,
      expectKinds: [
        "jsx-attribute",
        "jsx-attribute",
        "jsx-text",
        "rn-alert-arg",
        "rn-alert-arg",
      ],
    },
    {
      name: "placeholder-only fragment text passes",
      source: `export default () => <Text>{count} {{name}}</Text>;`,
      expectKinds: [],
    },
  ];
  for (const c of scanCases) {
    const got = scanSource(c.source).map((o) => o.kind).sort();
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

  // ---- baseline plumbing ----
  const fakeFailures = [
    { file: "a.tsx", snippet: "Old literal", line: 10, kind: "jsx-text" },
    { file: "a.tsx", snippet: "New literal", line: 20, kind: "jsx-text" },
    { file: "b.tsx", snippet: "Untracked one", line: 5, kind: "jsx-text" },
  ];
  const baseline = new Set([
    "a.tsx::Old literal",
    "a.tsx::Already-fixed literal",
  ]);
  const part = applyBaseline(fakeFailures, baseline);
  const wantActive = [
    "a.tsx::New literal",
    "b.tsx::Untracked one",
  ].sort();
  const gotActive = part.active.map((f) => `${f.file}::${f.snippet}`).sort();
  if (JSON.stringify(gotActive) !== JSON.stringify(wantActive)) {
    failed += 1;
    console.error(
      `  ✗ applyBaseline grandfathers known entries; got active=${JSON.stringify(gotActive)}, want=${JSON.stringify(wantActive)}`,
    );
  } else {
    console.log(`  ✓ applyBaseline grandfathers existing entries and surfaces the rest`);
  }
  const wantStale = ["a.tsx::Already-fixed literal"];
  const gotStale = [...part.staleBaselineEntries].sort();
  if (JSON.stringify(gotStale) !== JSON.stringify(wantStale)) {
    failed += 1;
    console.error(
      `  ✗ applyBaseline reports stale entries; got=${JSON.stringify(gotStale)}, want=${JSON.stringify(wantStale)}`,
    );
  } else {
    console.log(`  ✓ applyBaseline reports stale baseline entries`);
  }

  if (failed > 0) {
    console.error(`\nself-test: ${failed} case(s) failed`);
    process.exit(1);
  }
  console.log(
    `\nself-test: all ${literalCases.length + scanCases.length + 2} cases passed`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function collectFailures() {
  const tsxFiles = walkTsxFiles(APP_DIR);
  /** @type {Array<{ file: string, line: number, snippet: string, kind: string }>} */
  const failures = [];
  for (const filePath of tsxFiles) {
    let source;
    try {
      source = readFileSync(filePath, "utf8");
    } catch (err) {
      throw new Error(
        `failed to read ${relative(repoRoot, filePath)}: ${err.message}`,
      );
    }
    const fileRel = relative(repoRoot, filePath);
    for (const o of scanSource(source, filePath)) {
      failures.push({
        file: fileRel,
        line: o.line,
        snippet: o.snippet,
        kind: o.kind,
      });
    }
  }
  return { failures, scannedFiles: tsxFiles.length };
}

function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  let failures, scannedFiles;
  try {
    ({ failures, scannedFiles } = collectFailures());
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (process.argv.includes("--update-baseline")) {
    const doc = buildBaselineDoc(failures);
    writeBaseline(doc);
    const totalLiterals = Object.values(doc.literals).reduce(
      (n, arr) => n + arr.length,
      0,
    );
    console.log(
      `check-mobile-screen-translations: refreshed baseline with ${totalLiterals} literal(s) across ${Object.keys(doc.literals).length} file(s) (scanned ${scannedFiles} screen file(s)).`,
    );
    return;
  }

  const baseline = loadBaseline();
  const { active, grandfathered, staleBaselineEntries } = applyBaseline(
    failures,
    baseline,
  );

  if (active.length > 0) {
    console.error(
      `\ncheck-mobile-screen-translations: found ${active.length} new raw English literal${active.length === 1 ? "" : "s"} in mobile screens:\n`,
    );
    for (const f of active) {
      console.error(`  - ${f.file}:${f.line}  ${JSON.stringify(f.snippet)}`);
    }
    console.error(
      `\nWrap each value in \`t("…")\` (and add the matching key to artifacts/kharagolf-mobile/i18n/locales/en/<bundle>.json),\n` +
        `or — if the literal is intentional (brand, acronym, golf loanword) — extend the allowlist in scripts/check-mobile-screen-translations.mjs.\n` +
        `If the literal is genuinely legacy code that you don't want to fix in this PR, regenerate the baseline via\n` +
        `  pnpm run lint:mobile-screen-translations:update-baseline\n`,
    );
    process.exit(1);
  }

  console.log(
    `check-mobile-screen-translations: scanned ${scannedFiles} screen file(s); ${grandfathered.length} known literal(s) grandfathered, no new untranslated copy.`,
  );
  if (staleBaselineEntries.length > 0) {
    console.log(
      `note: ${staleBaselineEntries.length} baseline entr${staleBaselineEntries.length === 1 ? "y is" : "ies are"} no longer matched by any live failure — refresh the baseline at your convenience.`,
    );
  }
}

main();
