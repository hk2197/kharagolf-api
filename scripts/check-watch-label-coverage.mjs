#!/usr/bin/env node
/**
 * Coverage guard for the watch-face overflow snapshot tests (Task #1245).
 *
 * The three overflow guards
 *   - artifacts/kharagolf-mobile/ios-watch-extension/OverflowTests/
 *       WatchFaceOverflowSnapshotTests.swift
 *   - artifacts/kharagolf-mobile/wear-os-module/src/test/java/com/kharagolf/
 *       wearos/WatchFaceOverflowSnapshotTest.kt
 *   - scripts/check-garmin-watch-overflow.mjs (the `SPECS` table)
 * carry hand-curated `Spec` lists that pin a budget per visible Text. The
 * lists are great for catching truncation/wrap regressions on labels we
 * already know about, but they cannot — by themselves — catch the
 * structural regression a designer creates by adding a NEW visible label
 * and forgetting to extend the spec list. That label would render
 * untracked, possibly clip on a 41 mm face (or a 240×240 round Garmin
 * face), and ship.
 *
 * This script closes that gap. It walks the player-facing screen
 * sources, extracts every visible localised Text key, and asserts in
 * BOTH directions:
 *
 *   1. Every visible screen key is either covered by a spec entry in
 *      the matching test file, or explicitly listed in `ALLOWLIST`
 *      below with a reason. (The "added a new label, forgot to spec
 *      it" guard from Task #1456.)
 *   2. Every key in the spec list is still referenced by at least one
 *      configured screen file (or listed in `STALE_SPEC_ALLOWLIST` —
 *      reserved for keys that intentionally appear only in
 *      concatenated/compound specs or format strings whose individual
 *      tokens never surface as a standalone screen key). The reverse
 *      direction — Task #1778 — catches dead measurements left behind
 *      when a designer removes a label from a screen but forgets to
 *      drop the matching Spec entry, and reports them with a clear
 *      "remove from spec" message so the guard list does not slowly
 *      accrete confusing measurements.
 *
 * It exits non-zero on any uncovered label or stale spec entry so CI
 * fails. Pass --self-test to verify the extraction and reverse-check
 * logic against built-in fixtures.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

// ── Inputs ────────────────────────────────────────────────────────────
//
// Per-platform screen sources are auto-discovered by globbing the
// screen directory and filtering by a naming convention (Task #2225).
// Hand-maintained lists used to invite a class of regression where a
// designer adds a new player-facing view and forgets to register it
// here, so every label inside the new view escapes the coverage check
// entirely. Auto-discovery removes that footgun: any new file that
// matches the naming pattern is automatically scanned, and the only
// way to opt out of the guard is to add the file to the platform's
// `SCREEN_FILE_DENYLIST` entry below — which has to carry a reason
// so reviewers can audit the exclusion.

const IOS_SCREEN_DIR =
  "artifacts/kharagolf-mobile/ios-watch-extension/KHARAGOLFWatch";
// Player-facing SwiftUI screens follow the `*View.swift` convention.
const IOS_SCREEN_PATTERN = /View\.swift$/;
const IOS_TEST =
  "artifacts/kharagolf-mobile/ios-watch-extension/OverflowTests/WatchFaceOverflowSnapshotTests.swift";

const WEAR_SCREEN_DIR =
  "artifacts/kharagolf-mobile/wear-os-module/src/main/java/com/kharagolf/wearos/ui";
// Wear OS screens follow the `*Screen.kt` convention; the sibling
// `theme/` directory is naturally skipped because `readdirSync` only
// yields its directory name, which doesn't match the pattern.
const WEAR_SCREEN_PATTERN = /Screen\.kt$/;
const WEAR_TEST =
  "artifacts/kharagolf-mobile/wear-os-module/src/test/java/com/kharagolf/wearos/WatchFaceOverflowSnapshotTest.kt";

// Garmin (Connect IQ) — player-facing MonkeyC views. Each
// `dc.drawText(...)` resource id must appear in the SPECS table inside
// `scripts/check-garmin-watch-overflow.mjs` (the "test file" for the
// Garmin guard) so a NEW label cannot ship without a budget. The
// Garmin SPECS table is the source of truth for the 240×240 round
// face just like the iOS / Wear test files are for their platforms.
//
// We glob the entire `Kharagolf*.mc` family rather than the narrower
// `Kharagolf*View*.mc` pattern so non-`View`-suffixed siblings such as
// `KharagolfPairing.mc` and `KharagolfDataField.mc` are auto-included,
// and a future `KharagolfStatsView.mc` is auto-included on the next
// CI run with no edits to this script (Task #2225). Files that hold
// no `drawText` calls (`KharagolfApp.mc` / `KharagolfBackend.mc`) are
// opted out via `SCREEN_FILE_DENYLIST.garmin` below.
const GARMIN_SCREEN_DIR =
  "artifacts/kharagolf-mobile/garmin-connectiq/source";
const GARMIN_SCREEN_PATTERN = /^Kharagolf.+\.mc$/;
const GARMIN_TEST = "scripts/check-garmin-watch-overflow.mjs";

// Files that match a platform's discovery pattern but are NOT
// player-facing screens — typically app entry points, background
// services, or container shells with no localised labels of their own.
// Each entry needs a reason so the denylist stays auditable, and the
// list is intentionally kept small: anything beyond a couple of
// entries probably means the discovery pattern is wrong, not that
// more files need to be excluded.
const SCREEN_FILE_DENYLIST = {
  ios: {
    // Root container that hosts the navigation stack — every visible
    // label is rendered by the child *View screens, which the
    // discovery pattern picks up directly.
    "ContentView.swift":
      "navigation container — no Text/NSLocalizedString of its own; child *View files own all labels",
    // Sync queue surface that lives under the round flow but is
    // intentionally NOT part of the smallest-face overflow budgets:
    // its labels are dominated by the matching `pending_sync*` keys
    // already covered by HoleView / LiveScoreView Specs, and the
    // standalone screen surfaces only when the watch is offline (a
    // long-form, scroll-friendly state outside the at-a-glance
    // overflow guard's scope).
    "PendingSyncView.swift":
      "offline-only sync queue — labels ship via HoleView / LiveScoreView Specs; standalone screen is scroll-friendly, out of overflow scope",
    // Voice score-entry screen. Its in-screen labels are all
    // transient toasts / button affordances that surface elsewhere
    // (allowlisted via the Wear ALLOWLIST entries for the matching
    // toast keys); the persistent header is owned by HoleView.
    "VoiceScoreView.swift":
      "voice entry — transient toasts and button affordances; persistent labels covered by HoleView Spec",
  },
  wear: {
    // Wear analogue of iOS PendingSyncView — same reasoning. The
    // standalone Wear sync screen is scroll-friendly and outside the
    // smallest-face overflow guard's scope; its inline labels are
    // covered by HoleEntryScreen / LiveScoreScreen Specs.
    "PendingSyncScreen.kt":
      "offline-only sync queue — labels ship via HoleEntryScreen / LiveScoreScreen Specs; standalone screen is scroll-friendly, out of overflow scope",
  },
  garmin: {
    // Connect IQ application entry point — wires up the View/Delegate
    // pair and contains no `dc.drawText` calls of its own.
    "KharagolfApp.mc":
      "Connect IQ app entry — no drawText calls, just View/Delegate wiring",
    // Background service that streams shot/score events to the
    // companion phone; never renders to the watch canvas.
    "KharagolfBackend.mc":
      "background service — no drawText calls, runs headless on the watch",
  },
};

// Keys that legitimately appear in screen source but are NOT visible
// player-facing labels — they're either accessibility metadata, system
// chrome rendered by watchOS / Wear with its own autoshrink, or toast
// strings that surface elsewhere. Each entry needs a reason so the
// allowlist stays auditable.
const ALLOWLIST = {
  ios: {
    // accessibilityLabel doesn't render visible text; VoiceOver reads
    // it. Layout is irrelevant.
    wind_direction: "accessibilityLabel — VoiceOver only, no visible glyphs",
    // navigationTitle is rendered by watchOS in the chrome bar with
    // its own auto-truncation behaviour, not the in-screen budgets.
    my_round: "navigationTitle — watchOS chrome handles truncation",
  },
  wear: {
    // Voice-toast strings shown via a transient surface, not part of
    // the screen layout we guard. They live in their own short-lived
    // composable and are out of scope for the smallest-face overflow
    // budgets.
    voice_unrecognized: "voice toast — transient surface, not laid out",
    last_score_reverted_toast: "voice toast — transient surface",
    hole_strokes_toast: "voice toast — transient surface",
    putts_logged: "voice toast — transient surface",
  },
  garmin: {
    // Single-character ('E') runtime value spliced into the
    // ScoreStrokesFooter line when _toPar is null or zero. The
    // ScoreStrokesFooter Spec already covers that drawText with the
    // literal " -2   " separator standing in for the toPar position;
    // "-2" is strictly wider than "E" under every shipped script /
    // font, so the footer's chord budget already bounds this label
    // and it does not need its own Spec.
    ToParEven:
      "1-char ('E') runtime substitute; ScoreStrokesFooter Spec's literal '-2' separator is strictly wider, so its budget already bounds this label",
  },
};

// Spec-list keys that are allowed to remain even when no configured
// screen file references them directly. Reserved for keys that only
// surface through concatenation (e.g. a compound chip whose halves are
// pulled from sibling resources via a separator) or via format strings
// whose token itself is never spoken as a standalone resource lookup.
// Each entry needs a reason so the allowlist stays auditable.
//
// The goal of the reverse check is to keep the spec list lean, so this
// slot should stay small. Keys that appear in a configured screen file
// only inside a conditional argument (Swift ternary inside `Text(...)`,
// Kotlin `if`-expression inside `stringResource(...)`) do NOT need an
// entry here — the extractors walk those shapes directly (Task #2216).
const STALE_SPEC_ALLOWLIST = {
  ios: {},
  wear: {},
  garmin: {},
};

// ── Extractors ────────────────────────────────────────────────────────

/**
 * Find the index just past the closing `)` that matches the opening `(`
 * positioned at `source[start - 1]`. The scanner is string-aware so
 * parens that appear inside string literals (including Swift `\(...)`
 * interpolations and Kotlin `${...}` interpolations, which start INSIDE
 * a "..." literal) do not throw off the depth counter.
 *
 * `start` is the index immediately AFTER the opening `(` — i.e. the
 * caller has already consumed `Foo(` and points at the first byte of
 * the argument list. Returns the index of the byte just past the
 * matching `)`.
 */
function findMatchingClose(source, start) {
  let i = start;
  let depth = 1;
  let inString = false;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") { i += 2; continue; } // skip the escape + next byte
      if (ch === '"') inString = false;
    } else {
      if (ch === '"') inString = true;
      else if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
    }
    i += 1;
  }
  return i;
}

/** All localised keys referenced from an iOS screen source. We match:
 *    Text("foo", comment: ...)
 *    Text("foo")
 *    NSLocalizedString("foo", comment: ...)
 *    LocalizedStringKey("foo")
 *  And — to catch labels added by a designer inside a Swift ternary
 *  (Task #2216) — also:
 *    Text(cond ? "stop_aim" : "start_aim", comment: ...)
 *    NSLocalizedString(cond ? "a" : "b", comment: ...)
 *    LocalizedStringKey(cond ? "a" : "b")
 *  We skip computed strings like `Text("(+\(diff))")` (the `[a-z]…`
 *  shape on the literal rejects them), and we deliberately do NOT
 *  scan every string literal inside the call (which would falsely
 *  catch `comment: "y"` on NSLocalizedString) — only the first
 *  argument (literal-prefix form) and the two arms of a top-level
 *  `? "a" : "b"` ternary.
 */
function extractIosKeys(source) {
  const out = new Set();
  const opener = /(?:Text|NSLocalizedString|LocalizedStringKey)\(/g;
  let m;
  while ((m = opener.exec(source)) !== null) {
    const argStart = m.index + m[0].length;
    const argEnd = findMatchingClose(source, argStart);
    const args = source.substring(argStart, argEnd - 1);
    // Direct form: leading whitespace then a string literal that
    // looks like a localisation key.
    const direct = args.match(/^\s*"([a-z][a-z0-9_]*)"/);
    if (direct) out.add(direct[1]);
    // Ternary-of-literals form: `... ? "a" : "b" ...`. The literal
    // pair shape (lowercase ASCII identifier on both arms separated
    // by `?`/`:`) is highly specific and won't collide with
    // named-parameter `:` in Swift call sites because those never
    // sit between two ternary-style arms.
    for (const sm of args.matchAll(
      /\?\s*"([a-z][a-z0-9_]*)"\s*:\s*"([a-z][a-z0-9_]*)"/g,
    )) {
      out.add(sm[1]);
      out.add(sm[2]);
    }
  }
  return out;
}

/** All R.string.* keys referenced from a Wear screen source. We match:
 *    stringResource(R.string.foo)
 *    stringResource(R.string.foo, ...args)
 *  And — to catch labels added by a designer inside a Kotlin
 *  if-expression (Task #2216) — also any `R.string.<id>` token that
 *  appears inside the argument list of a `stringResource(...)` call,
 *  which covers:
 *    stringResource(if (cond) R.string.stop_aim else R.string.start_aim)
 *    stringResource(when (x) { 1 -> R.string.a; else -> R.string.b })
 *  Toast-only ctx.getString(...) calls are *not* matched here — those
 *  surface in transient toasts, not in the persistent screen layout
 *  this guard protects, and several would otherwise need broad
 *  allowlist entries. The allowlist still covers any toast keys that
 *  do leak through stringResource by accident.
 */
function extractWearKeys(source) {
  const out = new Set();
  const opener = /stringResource\(/g;
  let m;
  while ((m = opener.exec(source)) !== null) {
    const argStart = m.index + m[0].length;
    const argEnd = findMatchingClose(source, argStart);
    const args = source.substring(argStart, argEnd - 1);
    for (const sm of args.matchAll(/R\.string\.([a-z][a-z0-9_]*)/g)) {
      out.add(sm[1]);
    }
  }
  return out;
}

/** All keys covered by the iOS test spec list — match the literal
 *  `keys: ["foo"]` / `keys: ["foo", "bar"]` form used by the Spec init.
 */
function extractIosSpecKeys(source) {
  const re = /keys:\s*\[([^\]]+)\]/g;
  const out = new Set();
  let m;
  while ((m = re.exec(source)) !== null) {
    for (const lit of m[1].matchAll(/"([a-z][a-z0-9_]*)"/g)) out.add(lit[1]);
  }
  return out;
}

/** All keys covered by the Wear test spec list — match `R.string.foo`
 *  references inside the spec list (the file's only other R.string.*
 *  references are inside the spec list since this is a test file).
 */
function extractWearSpecKeys(source) {
  const re = /R\.string\.([a-z][a-z0-9_]*)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return out;
}

/** All Garmin string-resource keys referenced from a MonkeyC screen
 *  source. We match `Rez.Strings.Foo` references — every visible
 *  drawText call resolves its text via `Ui.loadResource(Rez.Strings.X)`
 *  (either inline or via a local variable). Keys assigned to a local
 *  variable that is then handed to `dc.drawText` look identical to
 *  inline ones from a regex perspective, so a file-wide scan catches
 *  both the direct cases and the hoisted-into-a-status-string cases
 *  (e.g. `_statusText` in KharagolfPairing.mc, which can hold any of
 *  PairPrompt / PairingInProgress / PairOk / PairFailed).
 */
function extractGarminKeys(source) {
  const re = /Rez\.Strings\.([A-Za-z][A-Za-z0-9_]*)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return out;
}

/** All keys covered by the Garmin SPECS table — match the literal
 *  `ids: ["Foo"]` / `ids: ["Foo", "Bar"]` form used by each Spec
 *  entry inside `scripts/check-garmin-watch-overflow.mjs`. Garmin
 *  resource ids are PascalCase so we accept any ASCII identifier.
 */
function extractGarminSpecKeys(source) {
  const re = /ids:\s*\[([^\]]+)\]/g;
  const out = new Set();
  let m;
  while ((m = re.exec(source)) !== null) {
    for (const lit of m[1].matchAll(/"([A-Za-z][A-Za-z0-9_]*)"/g)) {
      out.add(lit[1]);
    }
  }
  return out;
}

// ── Self-test ─────────────────────────────────────────────────────────

function selfTest() {
  let failures = 0;
  function expect(name, got, want) {
    const a = JSON.stringify([...got].sort());
    const b = JSON.stringify([...want].sort());
    if (a !== b) {
      console.error(`SELF-TEST FAIL: ${name}\n  got:  ${a}\n  want: ${b}`);
      failures += 1;
    }
  }
  expect(
    "extractIosKeys: simple Text + NSLocalizedString",
    extractIosKeys(`
      Text("pair_hint", comment: "x")
      Text(String(format: NSLocalizedString("auto_on_threshold", comment: "y"), 30))
      Text("(+\\(d))")            // computed → skipped
      Text("disable")              // bare Text is matched
    `),
    new Set(["pair_hint", "auto_on_threshold", "disable"]),
  );
  // Task #2216 — Swift ternary inside Text/NSLocalizedString/
  // LocalizedStringKey arguments. Both arms must surface so a NEW
  // label added inside a ternary cannot slip past the spec list.
  expect(
    "extractIosKeys: ternary inside Text/NSLS/LSK",
    extractIosKeys(`
      // Two-arm ternary on Text — both branches captured.
      Text(aim.isActive ? "stop_aim" : "start_aim", comment: "Toggle")
      // Whitespace and a more complex condition (with parens / dots)
      // around the ternary — still captured.
      Text((state.flag && state.other()) ? "alpha_label" : "beta_label")
      // NSLocalizedString and LocalizedStringKey ternary forms.
      Text(NSLocalizedString(cond ? "ns_a" : "ns_b", comment: "z"))
      Text(LocalizedStringKey(cond ? "lsk_a" : "lsk_b"))
      // Sibling Text(...) call with a comment that contains a colon
      // and quoted lowercase identifier — must NOT be misread as a
      // ternary arm because there is no '?' separator.
      Text("solo_label", comment: "field: value")
    `),
    new Set([
      "stop_aim", "start_aim",
      "alpha_label", "beta_label",
      "ns_a", "ns_b",
      "lsk_a", "lsk_b",
      "solo_label",
    ]),
  );
  // Defence-in-depth: `comment: "y"` next to a ternary on a sibling
  // call must not be captured as a ternary arm. The named-parameter
  // colon is preceded by an identifier, not by `? "literal"`.
  expect(
    "extractIosKeys: ternary regex does not eat named-parameter colons",
    extractIosKeys(`
      NSLocalizedString("k", comment: "y")
      Text(cond ? "a" : "b", comment: "y")
    `),
    new Set(["k", "a", "b"]),
  );
  expect(
    "extractWearKeys: stringResource only, ignore ctx.getString",
    extractWearKeys(`
      Text(stringResource(R.string.pair_watch))
      stringResource(R.string.auto_on_threshold, pct)
      ctx.getString(R.string.toast_only, x)   // not matched
    `),
    new Set(["pair_watch", "auto_on_threshold"]),
  );
  // Task #2216 — Kotlin if-expression inside stringResource(...)
  // arguments. Both branches must surface, including the parens
  // around the condition (which the balanced-paren scanner walks
  // through without losing track of the call boundary).
  expect(
    "extractWearKeys: if-expression and when inside stringResource",
    extractWearKeys(`
      Text(stringResource(if (state.active) R.string.stop_aim else R.string.start_aim))
      // Three-way if/else-if chain.
      stringResource(if (state.a) R.string.first else if (state.b) R.string.middle else R.string.last)
      // Kotlin 'when' expression — also covered by the within-args scan.
      stringResource(when (kind) { 1 -> R.string.alpha; else -> R.string.beta })
      // Sibling ctx.getString call must remain ignored.
      ctx.getString(R.string.toast_ignored, x)
    `),
    new Set([
      "stop_aim", "start_aim",
      "first", "middle", "last",
      "alpha", "beta",
    ]),
  );
  expect(
    "extractIosSpecKeys: single + concat",
    extractIosSpecKeys(`
      Spec(screen: "X", keys: ["a"], fontSize: 9, widthBudget: 1)
      Spec(screen: "X", keys: ["b", "c"], separator: " — ", widthBudget: 1)
    `),
    new Set(["a", "b", "c"]),
  );
  expect(
    "extractWearSpecKeys",
    extractWearSpecKeys(`
      spec("X", "k", R.string.foo, fontSp = 9f, widthBudgetDp = 1f)
      Spec(..., resIds = listOf(R.string.bar, R.string.baz), ...)
    `),
    new Set(["foo", "bar", "baz"]),
  );
  expect(
    "extractGarminKeys: inline + variable-hoisted resource refs",
    extractGarminKeys(`
      dc.drawText(w/2, h/2, Gfx.FONT_TINY,
          Ui.loadResource(Rez.Strings.PairTitle), Gfx.TEXT_JUSTIFY_CENTER);
      // The hoisted form below still surfaces under the file-wide
      // regex, just like the inline form above.
      var lbl = Ui.loadResource(Rez.Strings.HoleLabel);
      dc.drawText(w/2, headerY, Gfx.FONT_SMALL, lbl + " 7", ...);
      // Non-resource literals are not matched.
      dc.drawText(w/2, h/2, Gfx.FONT_TINY, "qa_screen=" + _screen, ...);
    `),
    new Set(["PairTitle", "HoleLabel"]),
  );
  expect(
    "extractGarminSpecKeys: single + multi-id + multi-line",
    extractGarminSpecKeys(`
      { screen: "X", label: "L1", ids: ["PairTitle"], font: "MEDIUM" },
      { screen: "X", label: "L2", ids: ["HoleLabel", "ParLabel"],
        separator: " 18   ", font: "SMALL" },
      { screen: "X", label: "L3",
        ids: ["DfHolePrefix", "DistUnitYards", "DfPlaysLikePrefix",
              "DfWindPrefix", "DfElevPrefix"],
        font: "MEDIUM" },
    `),
    new Set([
      "PairTitle", "HoleLabel", "ParLabel",
      "DfHolePrefix", "DistUnitYards", "DfPlaysLikePrefix",
      "DfWindPrefix", "DfElevPrefix",
    ]),
  );

  // ── Reverse-direction (stale-spec) checks. We exercise the real
  // `check()` driver against in-memory fixtures by stubbing readUtf8
  // for the duration of each scenario, so the exact code paths CI
  // hits are the same paths the self-test verifies.
  const realRead = readUtf8Impl.fn;
  function withFakeFs(map, fn) {
    readUtf8Impl.fn = (rel) => {
      if (!(rel in map)) throw new Error(`unstubbed read: ${rel}`);
      return map[rel];
    };
    try { return fn(); } finally { readUtf8Impl.fn = realRead; }
  }

  // Scenario A — happy path: the spec key is still referenced by the
  // screen, so neither direction fires.
  withFakeFs(
    {
      "screen.swift": `Text("pair_watch")`,
      "test.swift": `Spec(screen: "X", keys: ["pair_watch"], widthBudget: 1)`,
    },
    () => {
      const r = check(
        "ios", ["screen.swift"], "test.swift",
        extractIosKeys, extractIosSpecKeys,
      );
      expect("reverse[A] no uncovered when key in both", r.uncovered.map(x => x.key), []);
      expect("reverse[A] no stale when key in both",     r.stale.map(x => x.key),     []);
    },
  );

  // Scenario B — designer removed the label from the screen file but
  // forgot to drop the matching spec entry. Reverse check must fire.
  withFakeFs(
    {
      "screen.swift": `Text("pair_watch")`, // pairing_code removed
      "test.swift": `
        Spec(screen: "X", keys: ["pair_watch"], widthBudget: 1)
        Spec(screen: "X", keys: ["pairing_code"], widthBudget: 1)
      `,
    },
    () => {
      const r = check(
        "ios", ["screen.swift"], "test.swift",
        extractIosKeys, extractIosSpecKeys,
      );
      expect("reverse[B] no uncovered when extra spec",  r.uncovered.map(x => x.key), []);
      expect("reverse[B] flags removed key as stale",    r.stale.map(x => x.key),     ["pairing_code"]);
    },
  );

  // Scenario C — same designer also dropped the spec entry. Both
  // directions are clean.
  withFakeFs(
    {
      "screen.swift": `Text("pair_watch")`,
      "test.swift": `Spec(screen: "X", keys: ["pair_watch"], widthBudget: 1)`,
    },
    () => {
      const r = check(
        "ios", ["screen.swift"], "test.swift",
        extractIosKeys, extractIosSpecKeys,
      );
      expect("reverse[C] clean after spec also removed", [...r.uncovered, ...r.stale], []);
    },
  );

  // Scenario D — Wear: stale spec key whose stringResource lookup
  // was deleted from the screen.
  withFakeFs(
    {
      "screen.kt": `Text(stringResource(R.string.disable))`,
      "test.kt": `
        spec("X", "disable", R.string.disable, fontSp = 9f, widthBudgetDp = 1f)
        spec("X", "auto_on_threshold", R.string.auto_on_threshold, fontSp = 9f, widthBudgetDp = 1f)
      `,
    },
    () => {
      const r = check(
        "wear", ["screen.kt"], "test.kt",
        extractWearKeys, extractWearSpecKeys,
      );
      expect("reverse[D] flags removed Wear key as stale",
        r.stale.map(x => x.key), ["auto_on_threshold"]);
    },
  );

  // Scenario E.garmin — Garmin happy path: every Rez.Strings.X in the
  // screen is covered by a Spec entry (`ids: [...]`) in the script.
  withFakeFs(
    {
      "screen.mc": `
        dc.drawText(w/2, h/2, Gfx.FONT_TINY,
            Ui.loadResource(Rez.Strings.PairTitle), Gfx.TEXT_JUSTIFY_CENTER);
        var lbl = Ui.loadResource(Rez.Strings.HoleLabel);
        dc.drawText(w/2, headerY, Gfx.FONT_SMALL, lbl + " 7", ...);
      `,
      "test.mjs": `
        { screen: "X", label: "L1", ids: ["PairTitle"], font: "MEDIUM" },
        { screen: "X", label: "L2", ids: ["HoleLabel"], font: "SMALL" },
      `,
    },
    () => {
      const r = check(
        "garmin", ["screen.mc"], "test.mjs",
        extractGarminKeys, extractGarminSpecKeys,
      );
      expect("garmin[happy] no uncovered when all keys in SPECS",
        r.uncovered.map(x => x.key), []);
      expect("garmin[happy] no stale when all keys referenced",
        r.stale.map(x => x.key), []);
    },
  );

  // Scenario F.garmin — designer adds a NEW drawText resource id but
  // forgets to extend the SPECS table. The forward check must fire so
  // the untracked label cannot ship past the overflow guard. This is
  // the synthetic "untracked-label PR" the CI label-coverage job
  // catches end-to-end.
  withFakeFs(
    {
      "screen.mc": `
        dc.drawText(w/2, h/2, Gfx.FONT_TINY,
            Ui.loadResource(Rez.Strings.PairTitle), Gfx.TEXT_JUSTIFY_CENTER);
        // ↓ NEW label added by a designer, no Spec entry yet.
        dc.drawText(w/2, h * 0.85, Gfx.FONT_TINY,
            Ui.loadResource(Rez.Strings.NewBadgeLabel),
            Gfx.TEXT_JUSTIFY_CENTER);
      `,
      "test.mjs": `
        { screen: "X", label: "L1", ids: ["PairTitle"], font: "MEDIUM" },
      `,
    },
    () => {
      const r = check(
        "garmin", ["screen.mc"], "test.mjs",
        extractGarminKeys, extractGarminSpecKeys,
      );
      expect("garmin[uncovered] new untracked label flagged",
        r.uncovered.map(x => x.key), ["NewBadgeLabel"]);
      expect("garmin[uncovered] no stale when SPECS still covered",
        r.stale.map(x => x.key), []);
    },
  );

  // Scenario G.garmin — Spec entry left behind after the designer
  // removed the corresponding drawText from the source. Reverse check
  // must fire so the SPECS table doesn't accrete dead measurements.
  withFakeFs(
    {
      "screen.mc": `
        dc.drawText(w/2, h/2, Gfx.FONT_TINY,
            Ui.loadResource(Rez.Strings.PairTitle), Gfx.TEXT_JUSTIFY_CENTER);
      `,
      "test.mjs": `
        { screen: "X", label: "L1", ids: ["PairTitle"], font: "MEDIUM" },
        { screen: "X", label: "L2", ids: ["RemovedLabel"], font: "TINY" },
      `,
    },
    () => {
      const r = check(
        "garmin", ["screen.mc"], "test.mjs",
        extractGarminKeys, extractGarminSpecKeys,
      );
      expect("garmin[stale] removed label flagged for cleanup",
        r.stale.map(x => x.key), ["RemovedLabel"]);
    },
  );

  // Scenario H.garmin — ToParEven (the production allowlist entry)
  // is referenced from the screen but absent from SPECS, and the
  // ALLOWLIST.garmin entry must suppress the forward check.
  withFakeFs(
    {
      "screen.mc": `
        dc.drawText(w/2, h * 0.85, Gfx.FONT_TINY,
            Ui.loadResource(Rez.Strings.ScoreLabel) + " " +
            Ui.loadResource(Rez.Strings.ToParEven),
            Gfx.TEXT_JUSTIFY_CENTER);
      `,
      "test.mjs": `
        { screen: "X", label: "ScoreStrokesFooter",
          ids: ["ScoreLabel"], font: "TINY" },
      `,
    },
    () => {
      const r = check(
        "garmin", ["screen.mc"], "test.mjs",
        extractGarminKeys, extractGarminSpecKeys,
      );
      expect("garmin[allowlist] ToParEven suppressed by ALLOWLIST.garmin",
        r.uncovered.map(x => x.key), []);
    },
  );

  // Scenario I.ios (Task #2216) — designer adds a NEW iOS label
  // INSIDE a Swift ternary. The forward check must still fire for
  // both arms even though neither sits at the head of the Text(...)
  // argument list. This is the synthetic "untracked-label PR" the
  // CI label-coverage job catches end-to-end for the conditional
  // shape — without the conditional-aware extractor, the regex
  // would walk past `state.active ? "new_a" : "new_b"` and the new
  // labels would ship un-budgeted.
  withFakeFs(
    {
      "screen.swift": `
        Text(state.active ? "new_a" : "new_b", comment: "Toggle")
      `,
      "test.swift": `
        // Spec list is empty for the new keys.
      `,
    },
    () => {
      const r = check(
        "ios", ["screen.swift"], "test.swift",
        extractIosKeys, extractIosSpecKeys,
      );
      expect("ios[ternary] both ternary arms flagged when un-spec'd",
        r.uncovered.map(x => x.key).sort(), ["new_a", "new_b"]);
    },
  );

  // Scenario I.ios.covered (Task #2216) — same shape but the spec
  // list now covers both arms. The forward check stays clean and the
  // reverse check does NOT report stale entries (proving the
  // extractor surfaces both branches into `allScreenKeys`, which is
  // why the STALE_SPEC_ALLOWLIST entries for stop_aim/start_aim are
  // no longer needed).
  withFakeFs(
    {
      "screen.swift": `
        Text(state.active ? "new_a" : "new_b", comment: "Toggle")
      `,
      "test.swift": `
        Spec(screen: "X", keys: ["new_a"], widthBudget: 1)
        Spec(screen: "X", keys: ["new_b"], widthBudget: 1)
      `,
    },
    () => {
      const r = check(
        "ios", ["screen.swift"], "test.swift",
        extractIosKeys, extractIosSpecKeys,
      );
      expect("ios[ternary,covered] no uncovered when both arms specced",
        r.uncovered.map(x => x.key), []);
      expect("ios[ternary,covered] no stale either",
        r.stale.map(x => x.key), []);
    },
  );

  // Scenario I.wear (Task #2216) — designer adds a NEW Wear label
  // INSIDE a Kotlin if-expression. The forward check must still
  // fire for both branches.
  withFakeFs(
    {
      "screen.kt": `
        Text(stringResource(if (x) R.string.new_a else R.string.new_b))
      `,
      "test.kt": `
        // Spec list is empty for the new keys.
      `,
    },
    () => {
      const r = check(
        "wear", ["screen.kt"], "test.kt",
        extractWearKeys, extractWearSpecKeys,
      );
      expect("wear[if-expr] both branches flagged when un-spec'd",
        r.uncovered.map(x => x.key).sort(), ["new_a", "new_b"]);
    },
  );

  // Scenario I.wear.covered — both branches in spec → all clean,
  // including the reverse check. This is the analogue of
  // I.ios.covered for Wear and proves the if-expression branches
  // are surfaced into `allScreenKeys` so the prior
  // STALE_SPEC_ALLOWLIST entries for stop_aim/start_aim can be
  // removed.
  withFakeFs(
    {
      "screen.kt": `
        Text(stringResource(if (x) R.string.new_a else R.string.new_b))
      `,
      "test.kt": `
        spec("X", "new_a", R.string.new_a, fontSp = 9f, widthBudgetDp = 1f)
        spec("X", "new_b", R.string.new_b, fontSp = 9f, widthBudgetDp = 1f)
      `,
    },
    () => {
      const r = check(
        "wear", ["screen.kt"], "test.kt",
        extractWearKeys, extractWearSpecKeys,
      );
      expect("wear[if-expr,covered] no uncovered when both branches specced",
        r.uncovered.map(x => x.key), []);
      expect("wear[if-expr,covered] no stale either",
        r.stale.map(x => x.key), []);
    },
  );

  // Scenario E — STALE_SPEC_ALLOWLIST entry suppresses the warning
  // for keys that intentionally only appear inside a compound spec.
  STALE_SPEC_ALLOWLIST.ios.compound_only = "test fixture — compound chip half";
  try {
    withFakeFs(
      {
        "screen.swift": `Text("pair_watch")`,
        "test.swift": `
          Spec(screen: "X", keys: ["pair_watch"], widthBudget: 1)
          Spec(screen: "X", keys: ["pair_watch", "compound_only"], widthBudget: 1)
        `,
      },
      () => {
        const r = check(
          "ios", ["screen.swift"], "test.swift",
          extractIosKeys, extractIosSpecKeys,
        );
        expect("reverse[E] STALE_SPEC_ALLOWLIST suppresses",
          r.stale.map(x => x.key), []);
      },
    );
  } finally {
    delete STALE_SPEC_ALLOWLIST.ios.compound_only;
  }

  // Scenario J — `discoverScreens` against a real fixture directory
  // (Task #2225). The fixture lives at
  // `scripts/fixtures/watch-label-coverage/` and contains the same
  // `Kharagolf*.mc` shape as the production Garmin source dir, plus a
  // synthetic `KharagolfStatsView.mc` that simulates the "designer
  // adds a fifth player-facing view" scenario the task is guarding
  // against. The discovery helper must:
  //   - pick up the synthetic new view file with no edits to this
  //     script (proving auto-discovery works), and
  //   - skip every name listed in the platform's denylist (proving
  //     `KharagolfApp.mc` / `KharagolfBackend.mc` stay excluded even
  //     though they live in the same directory).
  // We exercise this against the real fixture rather than an in-memory
  // stub so the actual `readdirSync` code path is what CI verifies.
  const fixtureDir = "scripts/fixtures/watch-label-coverage";
  const fixtureDenylist = {
    "KharagolfApp.mc":
      "fixture — Connect IQ app entry, mirrors production denylist",
    "KharagolfBackend.mc":
      "fixture — background service, mirrors production denylist",
  };
  expect(
    "discoverScreens: globs Kharagolf*.mc, sorts results, applies denylist",
    discoverScreens(fixtureDir, /^Kharagolf.+\.mc$/, fixtureDenylist),
    [
      `${fixtureDir}/KharagolfDataField.mc`,
      `${fixtureDir}/KharagolfPairing.mc`,
      `${fixtureDir}/KharagolfQaView.mc`,
      `${fixtureDir}/KharagolfRoundView.mc`,
      // The "new view a designer just added" file — auto-picked up
      // without anyone touching this script, which is the whole
      // point of the task.
      `${fixtureDir}/KharagolfStatsView.mc`,
    ],
  );
  expect(
    "discoverScreens: empty denylist still yields all matching files",
    discoverScreens(fixtureDir, /^Kharagolf.+\.mc$/, {}),
    [
      `${fixtureDir}/KharagolfApp.mc`,
      `${fixtureDir}/KharagolfBackend.mc`,
      `${fixtureDir}/KharagolfDataField.mc`,
      `${fixtureDir}/KharagolfPairing.mc`,
      `${fixtureDir}/KharagolfQaView.mc`,
      `${fixtureDir}/KharagolfRoundView.mc`,
      `${fixtureDir}/KharagolfStatsView.mc`,
    ],
  );
  expect(
    "discoverScreens: pattern that matches nothing yields empty list",
    discoverScreens(fixtureDir, /\.swift$/, {}),
    [],
  );
  // Every production denylist entry must actually exist in its
  // discovery directory — otherwise the entry is dead weight that
  // would silently rot if the file is renamed without touching the
  // denylist. We assert this for all three platforms so the audit
  // trail in `SCREEN_FILE_DENYLIST` stays accurate.
  for (const [platform, dir, pattern] of [
    ["ios", IOS_SCREEN_DIR, IOS_SCREEN_PATTERN],
    ["wear", WEAR_SCREEN_DIR, WEAR_SCREEN_PATTERN],
    ["garmin", GARMIN_SCREEN_DIR, GARMIN_SCREEN_PATTERN],
  ]) {
    const present = new Set(
      readdirSync(join(repoRoot, dir)).filter((n) => pattern.test(n)),
    );
    for (const name of Object.keys(SCREEN_FILE_DENYLIST[platform])) {
      if (!present.has(name)) {
        console.error(
          `SELF-TEST FAIL: SCREEN_FILE_DENYLIST.${platform} lists ` +
            `'${name}' but no such file matches ${pattern} in ${dir}`,
        );
        failures += 1;
      }
    }
  }

  if (failures > 0) {
    console.error(`\nself-test: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("self-test: all extractors and reverse-check scenarios pass");
}

// ── Driver ────────────────────────────────────────────────────────────

// Indirection so the self-test can stub file reads with in-memory
// fixtures without touching the disk. Production code paths still
// flow through `readUtf8(...)` exactly as before.
const readUtf8Impl = {
  fn: (rel) => readFileSync(join(repoRoot, rel), "utf8"),
};
function readUtf8(rel) {
  return readUtf8Impl.fn(rel);
}

/**
 * Auto-discover screen sources in `dirRel` (a repo-relative directory)
 * that match `pattern` and are NOT in `denylist` (Task #2225). Results
 * are returned sorted so the order in CI logs is stable across
 * filesystems / locales. The returned paths are repo-relative and ready
 * to feed straight into `check(...)` / the spec extractors.
 */
function discoverScreens(dirRel, pattern, denylist) {
  const denySet = new Set(Object.keys(denylist));
  return readdirSync(join(repoRoot, dirRel))
    .filter((name) => pattern.test(name) && !denySet.has(name))
    .sort()
    .map((name) => `${dirRel}/${name}`);
}

/**
 * Run both directions of the coverage check for one platform.
 *
 * Forward (`uncovered`): a screen key with no matching spec entry and
 *   no `ALLOWLIST` entry → "add a Spec entry".
 * Reverse (`stale`): a spec-list key that no configured screen file
 *   references and that is not in `STALE_SPEC_ALLOWLIST` → "remove
 *   from spec".
 */
function check(platform, screens, testFile, extractScreen, extractSpec) {
  const allowed = new Set(Object.keys(ALLOWLIST[platform]));
  const staleAllowed = new Set(Object.keys(STALE_SPEC_ALLOWLIST[platform]));
  const specKeys = extractSpec(readUtf8(testFile));
  const allScreenKeys = new Set();
  const uncovered = [];
  for (const screenPath of screens) {
    const screenKeys = extractScreen(readUtf8(screenPath));
    for (const key of screenKeys) {
      allScreenKeys.add(key);
      if (specKeys.has(key)) continue;
      if (allowed.has(key)) continue;
      uncovered.push({ platform, screen: screenPath, key });
    }
  }
  const stale = [];
  for (const key of specKeys) {
    if (allScreenKeys.has(key)) continue;
    if (staleAllowed.has(key)) continue;
    stale.push({ platform, testFile, key });
  }
  return { uncovered, stale };
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const iosScreens = discoverScreens(
    IOS_SCREEN_DIR, IOS_SCREEN_PATTERN, SCREEN_FILE_DENYLIST.ios,
  );
  const wearScreens = discoverScreens(
    WEAR_SCREEN_DIR, WEAR_SCREEN_PATTERN, SCREEN_FILE_DENYLIST.wear,
  );
  const garminScreens = discoverScreens(
    GARMIN_SCREEN_DIR, GARMIN_SCREEN_PATTERN, SCREEN_FILE_DENYLIST.garmin,
  );
  const ios = check(
    "ios", iosScreens, IOS_TEST, extractIosKeys, extractIosSpecKeys,
  );
  const wear = check(
    "wear", wearScreens, WEAR_TEST, extractWearKeys, extractWearSpecKeys,
  );
  const garmin = check(
    "garmin", garminScreens, GARMIN_TEST,
    extractGarminKeys, extractGarminSpecKeys,
  );
  const uncovered = [...ios.uncovered, ...wear.uncovered, ...garmin.uncovered];
  const stale = [...ios.stale, ...wear.stale, ...garmin.stale];
  if (uncovered.length === 0 && stale.length === 0) {
    console.log(
      "check-watch-label-coverage: all visible labels are covered " +
        "and no spec entries are stale.",
    );
    return;
  }
  if (uncovered.length > 0) {
    console.error(
      `check-watch-label-coverage: ${uncovered.length} visible label(s) ` +
        `not covered by any overflow spec:\n`,
    );
    for (const f of uncovered) {
      console.error(
        `  - [${f.platform}] ${relative(repoRoot, f.screen)} → ${f.key}`,
      );
    }
    console.error(
      `\nFix by adding a Spec entry for the key in the matching test ` +
        `file (${IOS_TEST}, ${WEAR_TEST}, or — for [garmin] failures — ` +
        `the SPECS table inside ${GARMIN_TEST}), or — if the label is ` +
        `genuinely not subject to overflow budgets — extend the ` +
        `ALLOWLIST in this script with an explanation.`,
    );
  }
  if (stale.length > 0) {
    if (uncovered.length > 0) console.error("");
    console.error(
      `check-watch-label-coverage: ${stale.length} stale spec ` +
        `entry/entries — no configured screen file references this ` +
        `key any more, remove from spec:\n`,
    );
    for (const f of stale) {
      console.error(
        `  - [${f.platform}] ${relative(repoRoot, f.testFile)} → ${f.key}`,
      );
    }
    console.error(
      `\nFix by deleting the matching Spec entry from the test file. ` +
        `If the key is intentionally retained because it only ever ` +
        `surfaces inside a concatenated/compound spec or format ` +
        `string (and never as a standalone screen reference), add it ` +
        `to STALE_SPEC_ALLOWLIST in this script with a reason.`,
    );
  }
  process.exit(1);
}

main();
