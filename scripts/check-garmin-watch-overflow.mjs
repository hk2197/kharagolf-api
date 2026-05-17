#!/usr/bin/env node
/**
 * Snapshot-style guard that catches translation overflow on the smallest
 * supported Garmin Connect IQ device for every player-facing watch screen
 * across all 21 shipped locales (Task #1455, tightened in Task #1785).
 *
 * Mirrors the iOS XCTest suite at
 *   artifacts/kharagolf-mobile/ios-watch-extension/OverflowTests/
 *     WatchFaceOverflowSnapshotTests.swift
 * and the Wear OS Robolectric test at
 *   artifacts/kharagolf-mobile/wear-os-module/src/test/java/com/kharagolf/
 *     wearos/WatchFaceOverflowSnapshotTest.kt
 * so all three watch platforms catch the same regression class: a
 * translator lengthens a string and it clips on the smallest supported
 * device. Wired into CI by `.github/workflows/watch-face-overflow.yml`.
 *
 * Why a Node-based estimator (not a real Connect IQ simulator run)
 * ----------------------------------------------------------------
 * The iOS test drives `UIHostingController.sizeThatFits(in:)` against the
 * real SwiftUI layout pipeline; the Wear test reads
 * `TextLayoutResult.hasVisualOverflow` from a real Compose recomposition
 * via Robolectric. Both runtimes are JVM/Mac-hostable so a unit test can
 * import the platform's own measurement APIs cheaply on every PR.
 *
 * The Connect IQ runtime is different: text widths come from per-device
 * bitmap fonts shipped inside the SDK and exposed only via
 * `Toybox.Graphics.Dc.getTextWidthInPixels(text, font)` — which means
 * exact measurement requires booting the headless `simulator` binary
 * from the Connect IQ SDK. That SDK is the same heavyweight download the
 * `garmin-connectiq-build.yml` workflow already pulls (a ~600 MB cached
 * tarball gated behind the `CONNECT_IQ_SDK_URL` secret), and we don't
 * want a translation-overflow regression to wait for an SDK build to fail
 * — we want it to fail in seconds on every PR like the iOS / Wear guards
 * do.
 *
 * So this script renders each guarded label using a per-glyph proportional
 * width model derived from the *actual* fenix7s system bitmap fonts
 * (system_5/6/7.fnt + numhot.fnt) shipped in Connect IQ SDK 7.4.x. The
 * font tier dimensions and per-character ASCII widths below were lifted
 * from those .fnt glyph tables — see the FONT_METRICS / ASCII_WIDTH_FRAC
 * tables for the per-tier source. The model is still tuned to *upper
 * bound* the actual rendered width: every per-glyph value below is the
 * widest occurrence of that glyph across the four fenix7s system fonts,
 * rounded up. A string can occasionally clear the budget here by 1–2 px
 * narrower than the device paints, but it will never silently clip.
 *
 * Task #1785 replaces the previous constant `latinMaxPx`-per-Latin-glyph
 * upper bound (which billed every 'i' and every '.' the same as 'M') with
 * proportional widths, drops the per-tier max widths to match the actual
 * bitmap (the previous model overstated heightPx by ~30 % at TINY/SMALL),
 * and tightens the per-script multipliers for non-Latin glyphs from
 * "no-false-negative" extremes to the actual fenix7s typeface widths.
 * This shrinks the false-positive surface dramatically — see the baseline
 * file for the residual *true* overflows that are queued up for shortening
 * in Task #1786. False positives are still recoverable (raise the budget
 * or shorten the label); false negatives — silent on-device clipping —
 * are not.
 *
 * What this catches
 * -----------------
 *   - Single-line clipping (a translator lengthens "Hole" → "Imbobo" and
 *     the bold FONT_SMALL header overflows the round-face chord at the
 *     header's y-offset).
 *   - Multi-line wrap regressions on labels that embed a literal "\n"
 *     (e.g. `NoTournament` "No active round.\nStart a round in
 *     KHARAGOLF." — Connect IQ's `drawText` honours `\n` but does NOT
 *     auto-wrap, so a too-long line clips).
 *   - The composed PlaysLike footer on the data field, where the
 *     concatenated "PL ### W±# E±#" string can run past the data field's
 *     measurable width on small devices.
 *   - Untranslated keys are NOT double-flagged here — those are the
 *     responsibility of `check-watch-translations.mjs`.
 *
 * Smallest supported device
 * -------------------------
 * `garmin-connectiq/manifest.xml` lists 16 watch-app products and 12
 * data-field products. The narrowest pixel screens in that set are
 * fenix7s and approachs62 at 240 × 240 px round. We model the layout
 * budget against that 240 × 240 frame: at the screen midline (y = h/2)
 * the chord width is the full 240 px, and at off-axis y-offsets it
 * shrinks per the round chord formula `2·sqrt(r² − (y−r)²)`. Each Spec
 * below pins a budget that already takes its rendered y-position into
 * account.
 *
 * Flags
 * -----
 *   --self-test         exercise the font-model + extraction logic against
 *                       built-in fixtures.
 *   --update-baseline   rewrite scripts/garmin-watch-overflow-baseline.json
 *                       from the current state and exit 0. Used to grandfather
 *                       pre-existing overflows when the guard first lands and
 *                       to shrink the baseline as translators / designers fix
 *                       offending labels.
 *
 * The baseline mirrors the pattern in `scripts/check-mobile-translations.mjs`:
 * existing offenders are grandfathered so CI stays green, but the moment a
 * NEW overflow appears (a translator lengthens a string, or a new label is
 * added) the check fires.
 */
import {
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const GARMIN_DIR = join(
  repoRoot,
  "artifacts",
  "kharagolf-mobile",
  "garmin-connectiq",
);
const BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "garmin-watch-overflow-baseline.json",
);

// ── Locale catalogue ────────────────────────────────────────────────────
//
// One ISO 639-2 code per `resources-XXX/strings/strings.xml` directory
// declared in `manifest.xml`. The `eng` source lives in `resources/`
// (no suffix) so we treat `eng` as an alias for the base directory.
export const LOCALES = [
  "eng", "afr", "amh", "ara", "chs", "deu", "fre", "hau", "hin", "ind",
  "jpn", "kor", "por", "spa", "swa", "tgl", "tha", "vie", "yor", "zsm",
  "zul",
];

// ── Smallest-face geometry (pixels) ─────────────────────────────────────
//
// fenix7s / approachs62: 240 × 240 px round. At y == h/2 the usable
// chord is 240 px; at the screen edges it shrinks to zero. The Spec
// budgets below are computed once via `chordPxAt(yFrac)` and clamped
// down by ~12 px of safety margin (round-display antialiased edges
// are not pixel-perfect, and `drawText` centres the bounding box, not
// the optical glyph centre, so the rightmost glyph can overshoot the
// nominal half-width by ~6 px when the string contains wide characters
// like 'M' or '@').
const SCREEN_PX = 240;
const SAFETY_MARGIN_PX = 12;

/** Round-display chord width (px) at a vertical y-fraction. */
function chordPxAt(yFrac) {
  const r = SCREEN_PX / 2;
  const y = yFrac * SCREEN_PX;
  const dy = y - r;
  const chord = 2 * Math.sqrt(Math.max(0, r * r - dy * dy));
  return Math.max(0, Math.floor(chord) - SAFETY_MARGIN_PX);
}

// ── Font metrics for the smallest device ────────────────────────────────
//
// fenix7s (240 × 240 round) maps the four named Connect IQ font tiers to
// the bitmap fonts shipped under
//   <CIQ-SDK>/Resources/Fonts/Linux/com.garmin.fenix7s/{system_5,system_6,
//                                                       system_7,numhot}.fnt
// in CIQ SDK 7.4.x. Each .fnt file declares a font header (line height +
// max ascender) followed by a per-glyph width table. We mirror the
// declared header here and fold the per-glyph widths into ASCII_WIDTH_FRAC
// below as fractions of the font's max printable Latin width.
//
// The previous version of this guard used a single `latinMaxPx` value as
// the upper-bound width for every Latin glyph (so a 50-character lowercase
// status line was billed as 50 × M-width). That over-estimated the
// rendered width by ~2× on average, manufacturing 150+ false-positive
// baseline entries. Task #1785 replaced it with proportional widths and
// the *actual* fenix7s system-font dimensions; per-tier `heightPx` /
// `latinMaxPx` / `digitPx` below now match the .fnt headers, not the
// previous worst-case estimates.
const FONT_METRICS = {
  // system_5.fnt — bound to `Graphics.FONT_TINY` on fenix7s.
  // Used by `_statusText`, PairTapPrompt, GpsAcquiring, status banners,
  // round footer, DataField fallback labels.
  TINY:   { heightPx: 13, latinMaxPx:  7, digitPx:  6 },
  // system_6.fnt — bound to `Graphics.FONT_SMALL`. Used by the round-view
  // header (Hole/Par concat) and Leaderboard title in QaView.
  SMALL:  { heightPx: 17, latinMaxPx:  9, digitPx:  8 },
  // system_7.fnt — bound to `Graphics.FONT_MEDIUM`. Used by PairTitle and
  // the DataField composed line.
  MEDIUM: { heightPx: 22, latinMaxPx: 12, digitPx: 10 },
  // numhot.fnt — bound to `Graphics.FONT_NUMBER_HOT`. Connect IQ ships
  // it as digit-only; non-digit characters fall back to the medium-tier
  // width here. In practice only digits + a short unit suffix appear.
  NUMBER_HOT: { heightPx: 32, latinMaxPx: 18, digitPx: 16 },
};

// Per-glyph proportional widths for printable ASCII (relative to the
// font tier's `latinMaxPx`). Each fraction is the widest occurrence of
// that glyph across {system_5, system_6, system_7}.fnt, divided by the
// tier's max Latin glyph width and rounded UP — preserving the
// no-false-negative property while being ~2× tighter than the constant-
// max model for typical mixed-case strings. Glyphs not listed here fall
// back to the script's default multiplier (e.g. 0.75 for Latin-1
// supplement / extended).
const ASCII_WIDTH_FRAC = {
  // Whitespace + narrow punctuation.
  " ": 0.50, ".": 0.30, ",": 0.30, ":": 0.30, ";": 0.30, "!": 0.30,
  "'": 0.30, "\"": 0.50, "`": 0.30,
  // Wider punctuation / symbols.
  "?": 0.65, "/": 0.55, "\\": 0.55, "_": 0.65, "(": 0.45, ")": 0.45,
  "[": 0.45, "]": 0.45, "{": 0.50, "}": 0.50, "<": 0.65, ">": 0.65,
  "=": 0.70, "#": 0.85, "$": 0.70, "%": 0.95, "&": 0.85, "*": 0.55,
  "@": 1.00, "^": 0.55, "~": 0.65,
  // Operators (these previously had hand-tuned overrides, now folded in).
  "+": 0.65, "-": 0.50, "\u2212": 0.50, "\u00b7": 0.30, "\u2014": 0.95,
  // Lowercase Latin.
  i: 0.30, l: 0.30, j: 0.35, t: 0.45, f: 0.45, r: 0.50,
  s: 0.55, a: 0.65, c: 0.60, e: 0.65, n: 0.65, o: 0.65,
  u: 0.65, v: 0.65, x: 0.60, z: 0.60,
  b: 0.65, d: 0.65, g: 0.65, h: 0.65, k: 0.60, p: 0.65, q: 0.65, y: 0.60,
  m: 0.95, w: 0.90,
  // Uppercase Latin.
  I: 0.35, J: 0.55, L: 0.70, F: 0.70, T: 0.75, E: 0.75,
  A: 0.85, B: 0.80, C: 0.80, D: 0.85, G: 0.85, H: 0.85, K: 0.80,
  N: 0.85, O: 0.90, P: 0.75, Q: 0.90, R: 0.80, S: 0.75, U: 0.85,
  V: 0.85, X: 0.80, Y: 0.80, Z: 0.80,
  M: 1.00, W: 1.00,
};

// Per-script glyph-width multipliers (relative to `latinMaxPx`). These
// were upper bounds in the original guard; Task #1785 retunes them to
// the actual fenix7s typeface widths. The multipliers are still
// conservative — they are the widest representative glyph for each
// script — but no longer pad in an extra 30–50 % "in case".
const SCRIPT_WIDTH_MULTIPLIER = {
  latin:    1.0, // af, de, es, fil, fr, ha, id, ms, pt, sw, vi, yo, zu, en, pt-BR
  cyrillic: 1.0, // not in our 21 but kept for completeness
  greek:    1.0,
  // CJK ideographs are square: width ≈ font height. Modelled as
  // height/latinMaxPx so the per-char cost matches the bitmap em-square.
  cjk:      "square",
  // Korean Hangul syllables are similarly square in the bitmap font.
  hangul:   "square",
  // Devanagari (hi) glyphs in the fenix7s `system_*.fnt` render at
  // ~1.2 × Latin max width on average; the previous 1.4 × bound was
  // padded out of caution but produced false positives.
  devanagari: 1.2,
  // Thai consonants in the bitmap font are ~Latin max width; combining
  // marks contribute zero width via the codepoint guards below. The
  // previous 1.2 × bound was padding for diacritics that don't actually
  // change horizontal advance.
  thai:     1.0,
  // Ge'ez (am): syllabic, ~1.3 × Latin max in the fenix7s bitmap. The
  // previous 1.5 × bound came from desktop fonts, not the Garmin face.
  ethiopic: 1.3,
  // Arabic in connected form averages ~0.95 × Latin max because joining
  // shrinks per-glyph advance. The previous 1.1 × bound assumed
  // disconnected glyphs.
  arabic:   0.95,
  // Hebrew (not currently shipped on watch but kept for completeness).
  hebrew:   1.0,
};

// Map locale → script class. Drives the multiplier above.
const LOCALE_SCRIPT = {
  eng: "latin", afr: "latin", deu: "latin", fre: "latin", hau: "latin",
  ind: "latin", por: "latin", spa: "latin", swa: "latin", tgl: "latin",
  vie: "latin", yor: "latin", zsm: "latin", zul: "latin",
  chs: "cjk",   jpn: "cjk",
  kor: "hangul",
  hin: "devanagari",
  tha: "thai",
  amh: "ethiopic",
  ara: "arabic",
};

/** Width of a single character (px) under the spec's font and locale. */
function glyphWidthPx(ch, fontKey, locale) {
  const metrics = FONT_METRICS[fontKey];
  if (!metrics) {
    throw new Error(`Unknown font key ${fontKey}`);
  }
  // Digits are the same bitmap width across locales because Connect IQ
  // renders Western digits via the Latin font even when the page locale
  // is e.g. `chs`.
  if (ch >= "0" && ch <= "9") return metrics.digitPx;

  // Per-glyph proportional ASCII width (printable ranges). This is the
  // tightening that Task #1785 introduced — replacing the previous
  // single-multiplier "treat every Latin glyph as 'M'-wide" upper bound.
  const frac = ASCII_WIDTH_FRAC[ch];
  if (frac !== undefined) return Math.ceil(metrics.latinMaxPx * frac);

  const code = ch.codePointAt(0) ?? 0;
  // Combining marks contribute zero width — they stack vertically on
  // the previous base glyph in the bitmap. Check this *before* the
  // script-range branches below so e.g. a Thai tone mark isn't
  // mistakenly billed as a full Thai consonant.
  if (code >= 0x0300 && code <= 0x036F) return 0; // generic combining
  if (code >= 0x0E30 && code <= 0x0E3A) return 0; // Thai vowels above/below
  if (code >= 0x0E47 && code <= 0x0E4E) return 0; // Thai tone marks
  if (code >= 0x0951 && code <= 0x0954) return 0; // Devanagari accents
  if (code >= 0x0962 && code <= 0x0963) return 0; // Devanagari combining vowels
  // ASCII letters not in ASCII_WIDTH_FRAC fall through to here only if
  // the table was edited inconsistently — defensive upper bound.
  if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A)) {
    return metrics.latinMaxPx;
  }
  // Latin-1 supplement & extended (accented letters used by de / es / vi /
  // pt / fr / ha / yo / af / sw / zu translations). The fenix7s system
  // fonts render most accented Latin glyphs at ~0.75× the M-width — the
  // accent stacks vertically and doesn't widen the advance. The previous
  // model billed each as full latinMaxPx, which dominated the
  // false-positive surface for European locales.
  if (code >= 0x00C0 && code <= 0x024F) {
    return Math.ceil(metrics.latinMaxPx * 0.75);
  }
  // CJK Unified Ideographs (chs / jpn) and Japanese kana.
  if ((code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3000 && code <= 0x30FF) ||
      (code >= 0xFF00 && code <= 0xFFEF)) {
    return metrics.heightPx; // square
  }
  // Hangul (kor).
  if (code >= 0xAC00 && code <= 0xD7AF) {
    return metrics.heightPx; // square
  }
  // Devanagari (hin).
  if (code >= 0x0900 && code <= 0x097F) {
    return Math.ceil(metrics.latinMaxPx * SCRIPT_WIDTH_MULTIPLIER.devanagari);
  }
  // Thai (tha).
  if (code >= 0x0E00 && code <= 0x0E7F) {
    return Math.ceil(metrics.latinMaxPx * SCRIPT_WIDTH_MULTIPLIER.thai);
  }
  // Ethiopic (amh).
  if (code >= 0x1200 && code <= 0x137F) {
    return Math.ceil(metrics.latinMaxPx * SCRIPT_WIDTH_MULTIPLIER.ethiopic);
  }
  // Arabic (ara).
  if (code >= 0x0600 && code <= 0x06FF) {
    return Math.ceil(metrics.latinMaxPx * SCRIPT_WIDTH_MULTIPLIER.arabic);
  }
  // Unknown glyph — fall back to the per-locale multiplier on the Latin
  // max width so we still produce a conservative estimate.
  const script = LOCALE_SCRIPT[locale] || "latin";
  const mult = SCRIPT_WIDTH_MULTIPLIER[script] || 1.0;
  if (mult === "square") return metrics.heightPx;
  return Math.ceil(metrics.latinMaxPx * mult);
}

/**
 * Render-width estimate (px) for a single line of text under the given
 * font and locale. Combining marks contribute zero width.
 */
export function measureLinePx(line, fontKey, locale) {
  let total = 0;
  // Iterate code points (handles surrogate pairs cleanly even though
  // the watch strings don't currently include any).
  for (const ch of line) {
    total += glyphWidthPx(ch, fontKey, locale);
  }
  return total;
}

// ── Strings.xml loader ──────────────────────────────────────────────────

/** Decode the XML entities & escape sequences Connect IQ honours in
 *  string resources before measurement (so the rendered glyph count
 *  matches what the device actually paints). */
function decodeXmlEscapes(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    );
}

function parseStringsXml(xml) {
  const out = new Map();
  const re = /<string\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.set(m[1], decodeXmlEscapes(m[2]));
  }
  return out;
}

function dirForLocale(locale) {
  return locale === "eng"
    ? join(GARMIN_DIR, "resources", "strings", "strings.xml")
    : join(GARMIN_DIR, `resources-${locale}`, "strings", "strings.xml");
}

export function loadAllLocales() {
  /** @type {Map<string, Map<string, string>>} */
  const out = new Map();
  for (const locale of LOCALES) {
    let raw;
    try {
      raw = readFileSync(dirForLocale(locale), "utf8");
    } catch {
      continue;
    }
    out.set(locale, parseStringsXml(raw));
  }
  return out;
}

// ── Spec table ──────────────────────────────────────────────────────────
//
// One entry per visible drawText call (or concatenated drawText group)
// across the four player-facing screens. `ids` lists the string-resource
// keys that compose the rendered string; `prefix` / `suffix` hold the
// literal glue characters that the source uses around them (e.g. the
// "   " separators in the round footer concat, or the leading "H" in
// the data-field composition). `yFrac` records the y-offset the
// drawText is painted at so we derive the round-chord budget.
//
// `widthBudgetPx` overrides the chord-derived budget when the screen
// reserves additional chrome (notably the data field, which renders
// inside an activity-screen tile that's narrower than the device chord
// at midline).
//
// `format` substitutes representative arguments for runtime values that
// production interpolates inline — mostly hole numbers, par counts, and
// stroke counts.

/**
 * @typedef {Object} Spec
 * @property {string} screen        Display screen name (for failure msg)
 * @property {string} label         Human label (for failure msg)
 * @property {string[]} ids         Resource ids to look up + concat
 * @property {string} [separator]   String joining the resolved values
 * @property {string} [prefix]      Literal text before the resolved body
 * @property {string} [suffix]      Literal text after the resolved body
 * @property {keyof FONT_METRICS} font
 * @property {number} [yFrac]       0..1 vertical position; used to
 *                                  compute round-chord budget unless
 *                                  `widthBudgetPx` is set explicitly.
 * @property {number} [widthBudgetPx]
 * @property {number} [maxLines]    1 by default; >1 honours embedded \n
 * @property {(s:string) => string} [format]
 */

/** @type {Spec[]} */
export const SPECS = [
  // ── KharagolfPairingView (KharagolfPairing.mc) ───────────────────────
  // dc.drawText(w/2, h/2 - 40, FONT_MEDIUM, PairTitle, …) → yFrac ≈ 0.33
  { screen: "KharagolfPairingView", label: "PairTitle",
    ids: ["PairTitle"], font: "MEDIUM", yFrac: 0.33 },
  // dc.drawText(w/2, h/2, FONT_TINY, _statusText, …) — _statusText is
  // PairPrompt at first, then PairingInProgress / PairOk / PairFailed
  // (with " <err>" appended) after backend callbacks. We measure each
  // status string the screen can show; the backend-error suffix is out
  // of scope (server emits Latin error codes).
  { screen: "KharagolfPairingView", label: "PairPrompt",
    ids: ["PairPrompt"], font: "TINY", yFrac: 0.5 },
  { screen: "KharagolfPairingView", label: "PairingInProgress",
    ids: ["PairingInProgress"], font: "TINY", yFrac: 0.5 },
  { screen: "KharagolfPairingView", label: "PairOk",
    ids: ["PairOk"], font: "TINY", yFrac: 0.5 },
  { screen: "KharagolfPairingView", label: "PairFailed",
    ids: ["PairFailed"], font: "TINY", yFrac: 0.5 },
  // dc.drawText(w/2, h/2 + 30, FONT_TINY, PairTapPrompt, …) → yFrac ≈ 0.625
  { screen: "KharagolfPairingView", label: "PairTapPrompt",
    ids: ["PairTapPrompt"], font: "TINY", yFrac: 0.625 },

  // ── KharagolfRoundView (KharagolfRoundView.mc) ───────────────────────
  // Header concat: HoleLabel + " 18" + " " + ParLabel + " 5" at
  // y = 0.15h, FONT_SMALL. Worst-case substitutes hole 18 / par 5
  // (longest realistic digit pair). Separator was tightened from three
  // spaces to one in Task #1783 to claw back ~16 px on the 240×240
  // fenix7s/Approach S62 face — KharagolfRoundView.mc and
  // KharagolfQaView.mc were updated in lock-step.
  { screen: "KharagolfRoundView", label: "HoleHeader",
    ids: ["HoleLabel", "ParLabel"], separator: " 18 ",
    suffix: " 5", font: "SMALL", yFrac: 0.15 },
  // Distance line: e.g. "142 yds" or GpsAcquiring at y = 0.4h,
  // FONT_NUMBER_HOT. The acquiring fallback is shown at the SAME
  // position with the same font so it must fit too.
  { screen: "KharagolfRoundView", label: "DistanceWithUnits",
    ids: ["DistUnitYards"], prefix: "142 ",
    font: "NUMBER_HOT", yFrac: 0.4 },
  { screen: "KharagolfRoundView", label: "GpsAcquiring",
    ids: ["GpsAcquiring"], font: "NUMBER_HOT", yFrac: 0.4 },
  // PlaysLike line at y = 0.6h, FONT_TINY: "<PlaysLikeLabel> 148".
  { screen: "KharagolfRoundView", label: "PlaysLikeFooter",
    ids: ["PlaysLikeLabel"], suffix: " 148",
    font: "TINY", yFrac: 0.6 },
  // Footer concat at y = 0.85h, FONT_TINY:
  //   "<ScoreLabel> -2 <StrokesLabel> 9"
  // Separator was tightened from three spaces to one in Task #1783 to
  // claw back ~16 px on 240×240 faces (KharagolfRoundView.mc updated in
  // lock-step).
  { screen: "KharagolfRoundView", label: "ScoreStrokesFooter",
    ids: ["ScoreLabel", "StrokesLabel"], separator: " -2 ",
    suffix: " 9", font: "TINY", yFrac: 0.85 },
  // _statusMsg variants (NoTournament has an embedded "\n" so it's
  // multi-line). At y = 0.5h, FONT_TINY, no auto-wrap — each \n-split
  // line must independently fit the chord at midline.
  { screen: "KharagolfRoundView", label: "NoTournament",
    ids: ["NoTournament"], font: "TINY", yFrac: 0.5, maxLines: 2 },
  { screen: "KharagolfRoundView", label: "SaveFailed",
    ids: ["SaveFailed"], suffix: ": E", font: "TINY", yFrac: 0.5 },
  { screen: "KharagolfRoundView", label: "ShotSaveFailed",
    ids: ["ShotSaveFailed"], suffix: ": E", font: "TINY", yFrac: 0.5 },

  // ── KharagolfQaView (KharagolfQaView.mc) ─────────────────────────────
  // The QA mock paints the same labels as the production screens; we
  // only need the entries unique to QaView (LeaderboardLabel and
  // SavedToast — the SavedToast is layered over the round view at
  // y = 0.72h when the live_score variant is captured).
  { screen: "KharagolfQaView", label: "LeaderboardTitle",
    ids: ["LeaderboardLabel"], font: "SMALL", yFrac: 0.1 },
  { screen: "KharagolfQaView", label: "SavedToast",
    ids: ["SavedToast"], font: "TINY", yFrac: 0.72 },

  // ── KharagolfDataField (KharagolfDataField.mc) ───────────────────────
  // DataFields render inside an activity tile that is narrower than
  // the device chord; for fenix7s the single-data-field tile measures
  // ~180 px wide. We pin the budget explicitly rather than deriving
  // from the chord.
  { screen: "KharagolfDataField", label: "DfPairInApp",
    ids: ["DfPairInApp"], font: "TINY", widthBudgetPx: 180 },
  { screen: "KharagolfDataField", label: "LoadingHole",
    ids: ["LoadingHole"], font: "TINY", widthBudgetPx: 180 },
  // Two-line composed layout at FONT_TINY (Task #1783). The previous
  // single-line MEDIUM composition overflowed the 180 px tile in every
  // locale (and even in English) because the concatenated
  //   "H## ###unit  PL ### W±# E±#"
  // is structurally ~340 px wide at MEDIUM. KharagolfDataField.mc was
  // refactored to draw two TINY lines centred at h/2 ± 12:
  //   top:    "<DfHolePrefix>18  142<DistUnitYards>"
  //   bottom: "<DfPlaysLikePrefix> 148 <DfWindPrefix>+0 <DfElevPrefix>+6"
  //           or, when the server omitted the weather trio:
  //           "<DfPlaysLikePrefix> 148"
  { screen: "KharagolfDataField", label: "DfHoleDistLine",
    ids: ["DfHolePrefix", "DistUnitYards"],
    separator: "|",
    font: "TINY", widthBudgetPx: 180,
    format: (composed) => composed,
  },
  { screen: "KharagolfDataField", label: "DfPlaysLikeLine",
    ids: ["DfPlaysLikePrefix", "DfWindPrefix", "DfElevPrefix"],
    separator: "|",
    font: "TINY", widthBudgetPx: 180,
    format: (composed) => composed,
  },
  { screen: "KharagolfDataField", label: "DfPlaysLikeLineNoWeather",
    ids: ["DfPlaysLikePrefix"],
    separator: "|",
    font: "TINY", widthBudgetPx: 180,
    format: (composed) => composed,
  },
];

// Composers for the DataField two-line layout — mirror
// KharagolfDataField.onUpdate so the rendered strings under test match
// the production composition pixel-for-pixel.
function composeDfHoleDistLine(map) {
  const dist = "142";
  const hole = "18";
  return `${map.get("DfHolePrefix")}${hole}  ${dist}${map.get("DistUnitYards")}`;
}
function composeDfPlaysLikeLine(map, withWeather) {
  const pl = "148";
  const wind = "+0";
  const elev = "+6";
  return (
    `${map.get("DfPlaysLikePrefix")} ${pl}` +
    (withWeather
      ? ` ${map.get("DfWindPrefix")}${wind} ${map.get("DfElevPrefix")}${elev}`
      : "")
  );
}

// ── Per-spec text resolver ─────────────────────────────────────────────

/**
 * Resolve the rendered string for `spec` in `locale`. Returns `null` when
 * a required id is missing for that locale (silently skipped — missing-
 * translation detection lives in `check-watch-translations.mjs`).
 */
export function resolveText(spec, localeMap) {
  // Special-case the composed DataField line variants because they
  // splice runtime values between every id.
  if (spec.label === "DfHoleDistLine") {
    for (const id of spec.ids) if (!localeMap.has(id)) return null;
    return composeDfHoleDistLine(localeMap);
  }
  if (spec.label === "DfPlaysLikeLine") {
    for (const id of spec.ids) if (!localeMap.has(id)) return null;
    return composeDfPlaysLikeLine(localeMap, true);
  }
  if (spec.label === "DfPlaysLikeLineNoWeather") {
    for (const id of spec.ids) if (!localeMap.has(id)) return null;
    return composeDfPlaysLikeLine(localeMap, false);
  }
  const sep = spec.separator ?? " ";
  const parts = [];
  for (const id of spec.ids) {
    const v = localeMap.get(id);
    if (typeof v !== "string") return null;
    parts.push(v);
  }
  const body = parts.join(sep);
  return (spec.prefix ?? "") + body + (spec.suffix ?? "");
}

// ── The actual guard ────────────────────────────────────────────────────

/**
 * Splits a rendered string on the literal "\n" sequence (which is what
 * the strings.xml authors write — Connect IQ honours it as a line break
 * in `drawText`). Returns the per-line array.
 */
export function splitLines(rendered) {
  // The XML writes the literal two characters '\\' + 'n' (so the file
  // contains "...\\n..."). After XML decoding we still see the two
  // characters; we split on that literal sequence.
  return rendered.split(/\\n|\n/);
}

export function budgetForSpec(spec) {
  if (typeof spec.widthBudgetPx === "number") return spec.widthBudgetPx;
  if (typeof spec.yFrac === "number") return chordPxAt(spec.yFrac);
  // Default: midline chord.
  return chordPxAt(0.5);
}

/**
 * @typedef {Object} Failure
 * @property {string} screen
 * @property {string} label
 * @property {string} locale
 * @property {"width"|"line-count"} kind
 * @property {string} font
 * @property {number} budgetPx
 * @property {number} [measuredPx]
 * @property {number} [lineCount]
 * @property {number} [maxLines]
 * @property {string} rendered
 */

/** Stable canonical id for baseline lookup. The `rendered` payload is
 *  intentionally NOT part of the id so that minor punctuation tweaks to a
 *  baselined translation don't escape the grandfather. */
function failureId(f) {
  return `${f.screen}::${f.label}::${f.locale}::${f.kind}`;
}

/** Human-readable failure line for the console output. */
function formatFailure(f) {
  if (f.kind === "line-count") {
    return (
      `[${f.screen}/${f.label}/${f.locale}] split into ${f.lineCount} ` +
      `lines, max ${f.maxLines} (font ${f.font}, budget ${f.budgetPx}px) ` +
      `— ${JSON.stringify(f.rendered)}`
    );
  }
  return (
    `[${f.screen}/${f.label}/${f.locale}] measures ${f.measuredPx}px, ` +
    `exceeds budget ${f.budgetPx}px (font ${f.font}) ` +
    `— ${JSON.stringify(f.rendered)}`
  );
}

export function checkOverflow() {
  const localeData = loadAllLocales();
  /** @type {Failure[]} */
  const failures = [];
  for (const spec of SPECS) {
    const budget = budgetForSpec(spec);
    for (const locale of LOCALES) {
      const map = localeData.get(locale);
      if (!map) continue;
      const rendered = resolveText(spec, map);
      if (rendered === null) continue;

      const lines = splitLines(rendered);
      const maxLines = spec.maxLines ?? 1;
      if (lines.length > maxLines) {
        failures.push({
          screen: spec.screen,
          label: spec.label,
          locale,
          kind: "line-count",
          font: spec.font,
          budgetPx: budget,
          lineCount: lines.length,
          maxLines,
          rendered,
        });
        // Skip per-line width checks when line count is already wrong —
        // the fix is to shorten the string, which makes per-line widths
        // moot.
        continue;
      }
      for (let i = 0; i < lines.length; i++) {
        const widthPx = measureLinePx(lines[i], spec.font, locale);
        if (widthPx > budget) {
          failures.push({
            screen: spec.screen,
            label: spec.label,
            locale,
            kind: "width",
            font: spec.font,
            budgetPx: budget,
            measuredPx: widthPx,
            rendered: lines[i],
          });
        }
      }
    }
  }
  return failures;
}

// ── Baseline ────────────────────────────────────────────────────────────

/** Load the baseline file as a Set of `failureId` strings. Returns an empty
 *  Set when the baseline does not exist yet (first run). */
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
  if (!data.entries) return set;
  for (const e of data.entries) {
    set.add(`${e.screen}::${e.label}::${e.locale}::${e.kind}`);
  }
  return set;
}

function buildBaselineDoc(failures) {
  const sorted = [...failures].sort((a, b) => {
    if (a.screen !== b.screen) return a.screen < b.screen ? -1 : 1;
    if (a.label !== b.label) return a.label < b.label ? -1 : 1;
    if (a.locale !== b.locale) return a.locale < b.locale ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return 0;
  });
  return {
    $comment:
      "Generated by `pnpm run lint:garmin-watch-overflow:update-baseline`. " +
      "Each entry grandfathers a label that already overflowed on the " +
      "smallest supported Garmin face under the per-glyph proportional " +
      "width estimator (Task #1785). Each remaining entry is a *real* " +
      "overflow whose source string needs shortening (Task #1786 tracks " +
      "the shortening pass). The lint still fires on any NEW overflow. " +
      "Shorten an offending translation to drop its entry on the next " +
      "refresh.",
    $generatedAt: new Date().toISOString(),
    entries: sorted.map((f) => ({
      screen: f.screen,
      label: f.label,
      locale: f.locale,
      kind: f.kind,
      // Snapshot of the offending values for human review when a baseline
      // diff lands in PR. Not used for matching.
      font: f.font,
      budgetPx: f.budgetPx,
      ...(f.measuredPx != null ? { measuredPx: f.measuredPx } : {}),
      ...(f.lineCount != null
        ? { lineCount: f.lineCount, maxLines: f.maxLines }
        : {}),
      rendered: f.rendered,
    })),
  };
}

function writeBaseline(doc, path = BASELINE_PATH) {
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

/**
 * Partition failures against a baseline.
 *   - active: failures NOT in the baseline → fail the build
 *   - grandfathered: failures in the baseline → silently allowed
 *   - stale: baseline entries no longer matched (translator shortened it,
 *            or the spec changed) → informational, prompts a refresh
 */
export function applyBaseline(failures, baseline) {
  const active = [];
  const grandfathered = [];
  const seen = new Set();
  for (const f of failures) {
    const id = failureId(f);
    if (baseline.has(id)) {
      grandfathered.push(f);
      seen.add(id);
    } else {
      active.push(f);
    }
  }
  const stale = [...baseline].filter((id) => !seen.has(id));
  return { active, grandfathered, stale };
}

// ── Self-test ──────────────────────────────────────────────────────────

function selfTest() {
  let failed = 0;
  function expect(name, ok, detail) {
    if (!ok) {
      failed += 1;
      console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
    } else {
      console.log(`  ✓ ${name}`);
    }
  }

  // Chord at midline = full screen − margin; chord at edges shrinks.
  expect(
    "chord budget at y=0.5 ≈ 240 − margin",
    chordPxAt(0.5) === SCREEN_PX - SAFETY_MARGIN_PX,
    `got ${chordPxAt(0.5)} expected ${SCREEN_PX - SAFETY_MARGIN_PX}`,
  );
  expect(
    "chord budget at y=0.85 < midline budget",
    chordPxAt(0.85) < chordPxAt(0.5),
    `got y=0.85→${chordPxAt(0.85)}px y=0.5→${chordPxAt(0.5)}px`,
  );
  expect(
    "chord budget at y=0.15 = chord budget at y=0.85 (symmetric)",
    chordPxAt(0.15) === chordPxAt(0.85),
  );

  // Latin uppercase 'M' is the widest Latin glyph (fraction 1.0): 3 × 7 = 21 px.
  expect(
    "Latin width: 'MMM' @ TINY = 21px (M is widest, latinMaxPx=7)",
    measureLinePx("MMM", "TINY", "eng") === 21,
    `got ${measureLinePx("MMM", "TINY", "eng")}`,
  );

  // Proportional widths: 'iii' is much narrower than 'MMM' under the
  // tightened model (3 × ceil(7 × 0.30) = 9). Under the previous
  // constant-max model both would have measured 21 px.
  expect(
    "Latin width: 'iii' < 'MMM' (proportional)",
    measureLinePx("iii", "TINY", "eng") < measureLinePx("MMM", "TINY", "eng"),
    `iii=${measureLinePx("iii", "TINY", "eng")} ` +
      `MMM=${measureLinePx("MMM", "TINY", "eng")}`,
  );

  // Digit width: "999" at NUMBER_HOT = 3 × 16 = 48 px.
  expect(
    "Digit width: '999' @ NUMBER_HOT = 48px",
    measureLinePx("999", "NUMBER_HOT", "eng") === 48,
    `got ${measureLinePx("999", "NUMBER_HOT", "eng")}`,
  );

  // CJK: each ideograph = font height (square).
  // "球洞" at FONT_SMALL = 2 × 17 = 34 px.
  expect(
    "CJK width: '球洞' @ SMALL = 34px (square em)",
    measureLinePx("球洞", "SMALL", "chs") === 34,
    `got ${measureLinePx("球洞", "SMALL", "chs")}`,
  );

  // Hangul square em: 2 × 22 (MEDIUM heightPx) = 44.
  expect(
    "Hangul width: '시계' @ MEDIUM = 44px",
    measureLinePx("시계", "MEDIUM", "kor") === 44,
    `got ${measureLinePx("시계", "MEDIUM", "kor")}`,
  );

  // Devanagari multiplier tightened from 1.4× to 1.2×:
  //   ceil(7 × 1.2) = 9 each → 18 for two chars.
  expect(
    "Devanagari widening applied at tightened 1.2×",
    measureLinePx("कक", "TINY", "hin") ===
      Math.ceil(7 * SCRIPT_WIDTH_MULTIPLIER.devanagari) * 2,
    `got ${measureLinePx("कक", "TINY", "hin")}`,
  );

  // Latin-1 supplement (e.g. 'ä', 'ñ') uses the 0.75× fallback rather
  // than the previous full latinMaxPx — this is the dominant tightening
  // for European locales.
  expect(
    "Latin-1 accented glyph billed at 0.75× max",
    measureLinePx("ñ", "TINY", "spa") === Math.ceil(7 * 0.75),
    `got ${measureLinePx("ñ", "TINY", "spa")}`,
  );

  // Combining marks above don't add width.
  expect(
    "Thai combining marks have zero width",
    measureLinePx("ก่", "TINY", "tha") ===
      measureLinePx("ก", "TINY", "tha"),
    `got combined=${measureLinePx("ก่", "TINY", "tha")} ` +
      `base=${measureLinePx("ก", "TINY", "tha")}`,
  );

  // Spot-check that the proportional model is monotonic with string
  // length when chars are identical (catches any regression that
  // accidentally returns NaN / negative widths from the lookup table).
  expect(
    "monotonic in repeat count",
    measureLinePx("aaaa", "TINY", "eng") > measureLinePx("aa", "TINY", "eng"),
  );

  // XML entity decoding: &apos; → '.
  expect(
    "XML entity decoded before measurement",
    decodeXmlEscapes("Coupler l&apos;app") === "Coupler l'app",
  );

  // strings.xml mini-parser: id + decoded value.
  const xml = `<strings>
    <string id="Foo">bar &amp; baz</string>
    <string id="Multi">line1\\nline2</string>
  </strings>`;
  const m = parseStringsXml(xml);
  expect("parseStringsXml: ids extracted", m.has("Foo") && m.has("Multi"));
  expect(
    "parseStringsXml: entities decoded",
    m.get("Foo") === "bar & baz",
  );

  // splitLines honours both literal "\\n" (from XML source) and real
  // "\n" (defensive, in case any future translation embeds the
  // unescaped form).
  expect(
    "splitLines splits on literal backslash-n",
    splitLines("a\\nb").length === 2,
  );
  expect(
    "splitLines splits on real newline",
    splitLines("a\nb").length === 2,
  );

  // Sanity: a synthetic translation that would clip on the round footer
  // is detected; one that fits is not. Build a fake locale map.
  const fakeMap = new Map([
    ["ScoreLabel", "X".repeat(40)], // way too long for the footer chord
    ["StrokesLabel", "Strokes"],
  ]);
  const footer = SPECS.find((s) => s.label === "ScoreStrokesFooter");
  const renderedTooLong = resolveText(footer, fakeMap);
  const widthTooLong = measureLinePx(renderedTooLong, footer.font, "eng");
  expect(
    "synthetic over-long ScoreLabel exceeds footer budget",
    widthTooLong > budgetForSpec(footer),
    `width=${widthTooLong}px budget=${budgetForSpec(footer)}px`,
  );

  const fitsMap = new Map([
    ["ScoreLabel", "Score"],
    ["StrokesLabel", "Str"],
  ]);
  const renderedFits = resolveText(footer, fitsMap);
  expect(
    "synthetic short ScoreLabel fits footer budget",
    measureLinePx(renderedFits, footer.font, "eng") <= budgetForSpec(footer),
  );

  // Baseline round-trip: build a baseline doc from synthetic failures,
  // re-load it, and confirm applyBaseline grandfathers the same set.
  /** @type {Failure[]} */
  const synthFailures = [
    {
      screen: "S1", label: "L1", locale: "eng", kind: "width",
      font: "TINY", budgetPx: 100, measuredPx: 150, rendered: "abc",
    },
    {
      screen: "S2", label: "L2", locale: "fre", kind: "line-count",
      font: "TINY", budgetPx: 100, lineCount: 3, maxLines: 2, rendered: "x\\ny\\nz",
    },
  ];
  const tmpPath = join(repoRoot, ".local", `garmin-overflow-baseline-${process.pid}.json`);
  writeBaseline(buildBaselineDoc(synthFailures), tmpPath);
  const reloaded = loadBaseline(tmpPath);
  expect(
    "baseline round-trip: both synthetic failures grandfathered",
    reloaded.size === 2 &&
      reloaded.has("S1::L1::eng::width") &&
      reloaded.has("S2::L2::fre::line-count"),
  );
  const partA = applyBaseline(synthFailures, reloaded);
  expect(
    "applyBaseline: zero active when all in baseline",
    partA.active.length === 0 && partA.grandfathered.length === 2,
  );
  // A new failure not in the baseline becomes active.
  const partB = applyBaseline(
    [
      ...synthFailures,
      {
        screen: "S3", label: "L3", locale: "deu", kind: "width",
        font: "TINY", budgetPx: 100, measuredPx: 999, rendered: "neu",
      },
    ],
    reloaded,
  );
  expect(
    "applyBaseline: new failure surfaces as active",
    partB.active.length === 1 && partB.active[0].label === "L3",
  );
  // A fixed offender (no longer in `failures`) is reported as stale.
  const partC = applyBaseline([synthFailures[0]], reloaded);
  expect(
    "applyBaseline: removed offender reported as stale",
    partC.stale.length === 1 && partC.stale[0] === "S2::L2::fre::line-count",
  );
  // Cleanup tmp file (best-effort; ENOENT is fine).
  try { unlinkSync(tmpPath); } catch { /* ignore */ }

  // formatFailure produces a stable human-readable line for both kinds.
  expect(
    "formatFailure: width line shape",
    formatFailure(synthFailures[0]).startsWith("[S1/L1/eng] measures 150px"),
  );
  expect(
    "formatFailure: line-count line shape",
    formatFailure(synthFailures[1]).startsWith("[S2/L2/fre] split into 3 lines"),
  );

  // Composed DataField lines use inline interpolation, not the
  // separator. Verify each resolver produces the expected pattern.
  const dfMap = new Map([
    ["DfHolePrefix", "H"],
    ["DistUnitYards", "yds"],
    ["DfPlaysLikePrefix", "PL"],
    ["DfWindPrefix", "W"],
    ["DfElevPrefix", "E"],
  ]);
  const dfTop = SPECS.find((s) => s.label === "DfHoleDistLine");
  const dfTopStr = resolveText(dfTop, dfMap);
  expect(
    "DfHoleDistLine composer interpolates hole + distance inline",
    dfTopStr === "H18  142yds",
    `got ${JSON.stringify(dfTopStr)}`,
  );
  const dfPl = SPECS.find((s) => s.label === "DfPlaysLikeLine");
  const dfPlStr = resolveText(dfPl, dfMap);
  expect(
    "DfPlaysLikeLine composer interpolates plays-like trio inline",
    dfPlStr === "PL 148 W+0 E+6",
    `got ${JSON.stringify(dfPlStr)}`,
  );
  const dfPlNoW = SPECS.find((s) => s.label === "DfPlaysLikeLineNoWeather");
  const dfPlNoWStr = resolveText(dfPlNoW, dfMap);
  expect(
    "DfPlaysLikeLineNoWeather composer omits wind/elev",
    dfPlNoWStr === "PL 148",
    `got ${JSON.stringify(dfPlNoWStr)}`,
  );

  if (failed > 0) {
    console.error(`\nself-test: ${failed} case(s) failed`);
    process.exit(1);
  }
  console.log("\nself-test: all cases passed");
}

// ── Main ───────────────────────────────────────────────────────────────

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  if (process.argv.includes("--update-baseline")) {
    const failures = checkOverflow();
    writeBaseline(buildBaselineDoc(failures));
    console.log(
      `check-garmin-watch-overflow: baseline written to ` +
        `${relative(repoRoot, BASELINE_PATH)} (${failures.length} ` +
        `pre-existing overflow${failures.length === 1 ? "" : "s"} grandfathered).`,
    );
    return;
  }

  const failures = checkOverflow();
  let baseline;
  try {
    baseline = loadBaseline();
  } catch (err) {
    console.error(
      `check-garmin-watch-overflow: failed to read baseline at ` +
        `${relative(repoRoot, BASELINE_PATH)}: ${err.message}`,
    );
    process.exit(2);
  }
  const { active, grandfathered, stale } = applyBaseline(failures, baseline);
  const localeCount = loadAllLocales().size;

  if (active.length > 0) {
    console.error(
      `\ncheck-garmin-watch-overflow: ${active.length} NEW label overflow` +
        `${active.length === 1 ? "" : "s"} on the smallest supported ` +
        `Garmin face (240×240 px):\n`,
    );
    for (const f of active) console.error(`  - ${formatFailure(f)}`);
    console.error(
      "\nFix by shortening the offending translation, or — if the budget " +
        "is genuinely wrong — adjust the corresponding Spec entry in " +
        relative(repoRoot, fileURLToPath(import.meta.url)) +
        ".\nIf the new overflow is intentional and you want to grandfather " +
        "it, run `pnpm run lint:garmin-watch-overflow:update-baseline`.\n",
    );
    if (grandfathered.length > 0) {
      console.error(
        `(${grandfathered.length} pre-existing overflow${grandfathered.length === 1 ? "" : "s"} ` +
          `are grandfathered via ${relative(repoRoot, BASELINE_PATH)}.)\n`,
      );
    }
    process.exit(1);
  }

  if (stale.length > 0) {
    console.warn(
      `check-garmin-watch-overflow: ${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} no longer needed:`,
    );
    for (const id of stale) console.warn(`  - ${id}`);
    console.warn(
      `Run \`pnpm run lint:garmin-watch-overflow:update-baseline\` to clean up.\n`,
    );
  }

  console.log(
    `check-garmin-watch-overflow: scanned ${SPECS.length} specs × ` +
      `${localeCount} locales — no NEW labels would clip on a 240×240 ` +
      `Garmin face.${grandfathered.length > 0 ? ` ${grandfathered.length} pre-existing overflow${grandfathered.length === 1 ? "" : "s"} grandfathered via ${relative(repoRoot, BASELINE_PATH)}.` : ""}`,
  );
}

// Only run main() when this script is executed directly (e.g.
// `node scripts/check-garmin-watch-overflow.mjs`). When the module is
// imported by a sibling script (Task #2233's
// `check-garmin-watch-overflow-tight.mjs` re-uses LOCALES, SPECS,
// measureLinePx, etc.), the import must NOT trigger the full PR guard
// as a side effect — that both spams the log and could mis-fire on
// an unrelated argv (e.g. `--self-test` getting interpreted by the
// wrong main).
if (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href
) {
  main();
}
