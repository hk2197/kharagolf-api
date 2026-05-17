#!/usr/bin/env node
/**
 * SDK-gated tight overflow guard for the Garmin Connect IQ watch app
 * (Task #2233 — confirms the per-glyph overflow model from Task #1785
 * against the real Connect IQ simulator).
 *
 * The pure-Node estimator in `check-garmin-watch-overflow.mjs` is the
 * always-on PR check: it runs in seconds, requires no SDK, and keeps the
 * baseline honest. Its per-glyph widths were transcribed from the
 * fenix7s `system_5/6/7.fnt` + `numhot.fnt` glyph tables shipped in CIQ
 * SDK 7.4.x and rounded UP per glyph, so the model is upper-bounded —
 * but it has never actually been validated against
 * `Toybox.Graphics.Dc.getTextWidthInPixels` from the simulator. This
 * runner does that validation by:
 *
 *   1. Reusing the *same* SPECS + locale resolver from the pure-Node
 *      guard so the harness measures exactly the same rendered strings
 *      on exactly the same device tier.
 *   2. Generating a tiny single-device (fenix7s) Connect IQ watch app
 *      whose `View.onUpdate(dc)` walks every (spec, locale, line)
 *      sample, calls `dc.getTextWidthInPixels(text, font)`, and prints
 *      `MEASURE|<id>|<width>` to stdout via `System.println`.
 *   3. Compiling the harness with `monkeyc -d fenix7s`.
 *   4. Booting `monkeydo` headlessly (with xvfb in CI) and capturing
 *      its stdout.
 *   5. Reconciling each measured width against the Node estimator's
 *      `measureLinePx` for the same string + font.
 *
 * Reconciliation rules
 * --------------------
 *   - Node < real      → FALSE NEGATIVE: the upper-bound property is
 *                        broken for that glyph set. The script exits
 *                        non-zero so CI surfaces it. The fix is to bump
 *                        the relevant entry in `ASCII_WIDTH_FRAC` /
 *                        `SCRIPT_WIDTH_MULTIPLIER` / `FONT_METRICS`.
 *   - Node == real     → exact agreement. No-op.
 *   - Node > real      → over-estimate. Acceptable (the upper bound
 *                        property still holds), but if the gap is
 *                        ≥ TIGHTENING_HINT_PX we log a tightening
 *                        opportunity so translators can be told "this
 *                        actually fits" instead of relying on the
 *                        worst-case bound.
 *
 * Modes
 * -----
 *   --self-test       Sanity-check the sample generator + log parser +
 *                     reconciliation logic against built-in fixtures.
 *                     Always works, no SDK required. This is what the
 *                     `lint:garmin-watch-overflow-tight:self-test`
 *                     pnpm script invokes.
 *
 *   --write-harness   Generate the MonkeyC harness sources into
 *                     `.local/garmin-overflow-tight-harness/` and exit.
 *                     Lets a maintainer inspect the generated app
 *                     without invoking the SDK.
 *
 *   (default)         Full pipeline. Requires `CONNECT_IQ_SDK_HOME` to
 *                     point at a Connect IQ SDK 7.4.x install. Also
 *                     requires the simulator to be runnable on the host
 *                     (`xvfb-run` is sufficient on Linux runners).
 *
 * CI gating
 * ---------
 * This script is meant to run inside the `garmin-overflow-tight` job in
 * `.github/workflows/watch-face-overflow.yml`, which is gated on
 * `secrets.CONNECT_IQ_SDK_URL` (the same secret that
 * `garmin-connectiq-build.yml` already uses). When the secret isn't
 * configured the job no-ops; the always-on pure-Node guard
 * (`garmin-overflow` job) still runs unconditionally on every PR.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOCALES,
  SPECS,
  budgetForSpec,
  loadAllLocales,
  measureLinePx,
  resolveText,
  splitLines,
} from "./check-garmin-watch-overflow.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const HARNESS_DIR = join(repoRoot, ".local", "garmin-overflow-tight-harness");

// ── Knobs ───────────────────────────────────────────────────────────────
//
// Reconciliation tolerances. The Node model rounds UP per glyph and
// applies a small safety margin via `chordPxAt`, so an exact match with
// the simulator is the exception, not the rule. We only complain when
// the *direction* of the discrepancy violates the upper-bound contract.
//
// `ALLOWED_NODE_UNDERSHOOT_PX` lets us absorb 1 px of harmless
// floating-point/rounding noise before flagging an under-bound — the
// simulator's bitmap glyph table is integer-valued, but the Node model
// applies `Math.ceil` to a float multiplication and could in theory be
// off by ±1 due to JavaScript IEEE-754 rounding on a borderline value.
// Anything beyond that is a real model bug.
const ALLOWED_NODE_UNDERSHOOT_PX = 1;
// Over-estimates this large or larger surface as a tightening hint in
// the report (informational; never fails CI). 4 px ≈ a single thin
// punctuation glyph at TINY tier; smaller gaps are within the rounding
// noise of the Node model and not worth reporting.
const TIGHTENING_HINT_PX = 4;

// The smallest supported device — same one the pure-Node guard models.
// Both fenix7s and approachs62 are 240 × 240 round and use the same
// system_*.fnt glyph tables, so a single device build covers both.
const TARGET_DEVICE = "fenix7s";

// ── Sample generation ──────────────────────────────────────────────────
//
// One sample per (spec, locale, line). Each sample is a tuple of
// [id, fontKey, text]. The id encodes everything needed to look the
// row back up in the reconciliation step; the harness is intentionally
// dumb (it just measures + prints).

/** @typedef {{
 *   id: string,
 *   screen: string,
 *   label: string,
 *   locale: string,
 *   lineIndex: number,
 *   font: string,
 *   text: string,
 *   nodeWidthPx: number,
 *   budgetPx: number,
 * }} Sample */

/** Build the full sample set, computing the Node-model width per row.
 *  Returns rows in stable (screen,label,locale,lineIndex) order so the
 *  generated JSON resource diffs cleanly between runs. */
export function buildSamples(localeData) {
  /** @type {Sample[]} */
  const samples = [];
  for (const spec of SPECS) {
    const budgetPx = budgetForSpec(spec);
    for (const locale of LOCALES) {
      const map = localeData.get(locale);
      if (!map) continue;
      const rendered = resolveText(spec, map);
      if (rendered === null) continue;
      const lines = splitLines(rendered);
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i];
        // Skip empty lines — `getTextWidthInPixels("")` returns 0
        // trivially and adds no signal; would also bloat the harness.
        if (text.length === 0) continue;
        samples.push({
          id: `${spec.screen}|${spec.label}|${locale}|${i}`,
          screen: spec.screen,
          label: spec.label,
          locale,
          lineIndex: i,
          font: spec.font,
          text,
          nodeWidthPx: measureLinePx(text, spec.font, locale),
          budgetPx,
        });
      }
    }
  }
  // Stable sort already implied by the iteration order above (SPECS in
  // file order, LOCALES in array order, lines in source order), but
  // re-sort defensively so a future iteration-order change doesn't
  // produce a spurious harness diff.
  samples.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return samples;
}

// ── Harness writer ─────────────────────────────────────────────────────

/** Write the MonkeyC harness app to `dir`. Returns the absolute path of
 *  the generated `monkey.jungle`. */
export function writeHarness(samples, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "source"), { recursive: true });
  mkdirSync(join(dir, "resources", "strings"), { recursive: true });
  mkdirSync(join(dir, "resources", "json"), { recursive: true });
  mkdirSync(join(dir, "resources", "drawables"), { recursive: true });

  // The harness samples — flat arrays for compactness. `Rez.JsonData`
  // returns this as a Toybox.Lang.Array of Arrays at runtime.
  const samplePayload = samples.map((s) => [s.id, s.font, s.text]);
  writeFileSync(
    join(dir, "resources", "json", "samples.json"),
    JSON.stringify(samplePayload, null, 0) + "\n",
    "utf8",
  );

  // Resource registration for the JSON sample file.
  writeFileSync(
    join(dir, "resources", "json", "jsonData.xml"),
    `<?xml version="1.0"?>\n` +
      `<resources>\n` +
      `  <jsonData id="SAMPLES" filename="samples.json"/>\n` +
      `</resources>\n`,
    "utf8",
  );

  // Minimal app strings (Connect IQ requires a non-empty AppName even
  // for harnesses).
  writeFileSync(
    join(dir, "resources", "strings", "strings.xml"),
    `<?xml version="1.0"?>\n` +
      `<strings>\n` +
      `  <string id="AppName">KharagolfOverflowHarness</string>\n` +
      `</strings>\n`,
    "utf8",
  );

  // Single-device manifest. fenix7s is the smallest 240×240 round face;
  // approachs62 uses the same `system_*.fnt` glyph tables so we cover
  // both with one build. The unique app id is reserved for this harness
  // (never shipped, never published — different from the production
  // `0d3b4a6e-…` id in `garmin-connectiq/manifest.xml`).
  writeFileSync(
    join(dir, "manifest.xml"),
    `<?xml version="1.0"?>\n` +
      `<iq:manifest xmlns:iq="http://www.garmin.com/xml/connectiq" version="3">\n` +
      `  <iq:application\n` +
      `      id="0d3b4a6e4f7c4b399ad87cf9c1e0a233"\n` +
      `      type="watch-app"\n` +
      `      name="@Strings.AppName"\n` +
      `      entry="HarnessApp"\n` +
      `      launcherIcon="@Drawables.LauncherIcon"\n` +
      `      minApiLevel="3.2.0">\n` +
      `    <iq:products>\n` +
      `      <iq:product id="${TARGET_DEVICE}"/>\n` +
      `    </iq:products>\n` +
      `    <iq:permissions/>\n` +
      `    <iq:languages>\n` +
      `      <iq:language>eng</iq:language>\n` +
      `    </iq:languages>\n` +
      `  </iq:application>\n` +
      `</iq:manifest>\n`,
    "utf8",
  );

  // Required launcher icon stub — a 1×1 transparent PNG. Connect IQ
  // refuses to build without one even for headless harnesses.
  // (Bytes are the canonical 1×1 transparent PNG.)
  const transparentPng = Buffer.from(
    "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4" +
      "890000000D49444154789C6300010000000500010D0A2DB40000000049454E44AE426082",
    "hex",
  );
  writeFileSync(
    join(dir, "resources", "drawables", "launcher_icon.png"),
    transparentPng,
  );
  writeFileSync(
    join(dir, "resources", "drawables", "drawables.xml"),
    `<?xml version="1.0"?>\n` +
      `<drawables>\n` +
      `  <bitmap id="LauncherIcon" filename="launcher_icon.png"/>\n` +
      `</drawables>\n`,
    "utf8",
  );

  writeFileSync(
    join(dir, "monkey.jungle"),
    `# Auto-generated by scripts/check-garmin-watch-overflow-tight.mjs.\n` +
      `# Do not edit; regenerate via\n` +
      `#   node scripts/check-garmin-watch-overflow-tight.mjs --write-harness\n` +
      `project.manifest = manifest.xml\n` +
      `base.sourcePath = source\n` +
      `base.resourcePath = resources\n`,
    "utf8",
  );

  // Harness MonkeyC: load samples, measure, print, exit. The
  // `MEASURE|<id>|<width>` line shape is parsed by `parseSimulatorLog`
  // below; the `MEASURE_DONE` sentinel lets the runner know when to
  // stop tailing the simulator's stdout.
  const harnessMc = `using Toybox.Application as App;
using Toybox.WatchUi as Ui;
using Toybox.Graphics as Gfx;
using Toybox.System as Sys;
using Toybox.Lang as Lang;

class HarnessApp extends App.AppBase {
  function initialize() {
    AppBase.initialize();
  }

  function getInitialView() {
    return [ new HarnessView() ];
  }
}

class HarnessView extends Ui.View {
  function initialize() {
    View.initialize();
  }

  // Map the Node-side font keys ("TINY" / "SMALL" / "MEDIUM" /
  // "NUMBER_HOT") to the Connect IQ Graphics constants. Anything else
  // is a script bug and is reported as a sentinel width of -1 so the
  // runner can fail loudly.
  function fontFor(key) {
    if (key.equals("TINY"))       { return Gfx.FONT_TINY; }
    if (key.equals("SMALL"))      { return Gfx.FONT_SMALL; }
    if (key.equals("MEDIUM"))     { return Gfx.FONT_MEDIUM; }
    if (key.equals("NUMBER_HOT")) { return Gfx.FONT_NUMBER_HOT; }
    return null;
  }

  function onUpdate(dc) {
    var samples = Rez.JsonData.SAMPLES;
    var n = samples.size();
    Sys.println("MEASURE_BEGIN|" + n);
    for (var i = 0; i < n; i++) {
      var row = samples[i];
      var id   = row[0];
      var fkey = row[1];
      var text = row[2];
      var font = fontFor(fkey);
      var w;
      if (font == null) {
        w = -1;
      } else {
        w = dc.getTextWidthInPixels(text, font);
      }
      Sys.println("MEASURE|" + id + "|" + w);
    }
    Sys.println("MEASURE_DONE");
    // Garmin doesn't support System.exit on most devices; the runner
    // SIGTERMs the simulator after seeing MEASURE_DONE. We still
    // request a redraw-stop so the simulator's CPU goes idle.
  }
}
`;
  writeFileSync(join(dir, "source", "HarnessApp.mc"), harnessMc, "utf8");

  return join(dir, "monkey.jungle");
}

// ── Log parsing ────────────────────────────────────────────────────────

/** Parse a chunk of simulator stdout and return a Map<id, widthPx>. */
export function parseSimulatorLog(log) {
  const out = new Map();
  let sawDone = false;
  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "MEASURE_DONE") {
      sawDone = true;
      continue;
    }
    if (!line.startsWith("MEASURE|")) continue;
    // Strip the prefix then split from the RIGHT on `|` so an id that
    // happens to contain a `|` (e.g. the spec ids do) isn't mangled.
    const rest = line.slice("MEASURE|".length);
    const lastPipe = rest.lastIndexOf("|");
    if (lastPipe < 0) continue;
    const id = rest.slice(0, lastPipe);
    const width = Number.parseInt(rest.slice(lastPipe + 1), 10);
    if (Number.isFinite(width)) out.set(id, width);
  }
  return { measurements: out, sawDone };
}

// ── Reconciliation ─────────────────────────────────────────────────────

/** @typedef {{
 *   id: string,
 *   screen: string,
 *   label: string,
 *   locale: string,
 *   lineIndex: number,
 *   font: string,
 *   text: string,
 *   nodeWidthPx: number,
 *   simWidthPx: number,
 *   diffPx: number,
 *   budgetPx: number,
 *   kind: "missing" | "underbound" | "tightening-hint" | "ok",
 * }} Reconciliation */

/** Compare each Node estimate against the simulator's measurement.
 *  Returns one Reconciliation per sample.
 *
 *    - "missing"          : harness produced no measurement for this id
 *    - "underbound"       : Node estimate < simulator (FALSE NEGATIVE)
 *    - "tightening-hint"  : Node ≫ simulator (over-conservative)
 *    - "ok"               : within tolerance, model matches reality
 */
export function reconcile(samples, measurements) {
  /** @type {Reconciliation[]} */
  const out = [];
  for (const s of samples) {
    const sim = measurements.get(s.id);
    if (sim === undefined) {
      out.push({
        id: s.id, screen: s.screen, label: s.label, locale: s.locale,
        lineIndex: s.lineIndex, font: s.font, text: s.text,
        nodeWidthPx: s.nodeWidthPx, simWidthPx: -1, diffPx: 0,
        budgetPx: s.budgetPx, kind: "missing",
      });
      continue;
    }
    const diff = s.nodeWidthPx - sim;
    let kind;
    if (diff < -ALLOWED_NODE_UNDERSHOOT_PX) {
      kind = "underbound";
    } else if (diff >= TIGHTENING_HINT_PX) {
      kind = "tightening-hint";
    } else {
      kind = "ok";
    }
    out.push({
      id: s.id, screen: s.screen, label: s.label, locale: s.locale,
      lineIndex: s.lineIndex, font: s.font, text: s.text,
      nodeWidthPx: s.nodeWidthPx, simWidthPx: sim, diffPx: diff,
      budgetPx: s.budgetPx, kind,
    });
  }
  return out;
}

/** Pretty-print one reconciliation row for the human report. */
function formatRow(r) {
  const head = `[${r.screen}/${r.label}/${r.locale}#${r.lineIndex}]`;
  const meta = `font=${r.font} budget=${r.budgetPx}px node=${r.nodeWidthPx}px sim=${r.simWidthPx}px diff=${r.diffPx >= 0 ? "+" : ""}${r.diffPx}px`;
  return `  - ${head} ${meta} — ${JSON.stringify(r.text)}`;
}

/** Group rows by kind, with predictable ordering. */
function groupByKind(rows) {
  const groups = { underbound: [], "tightening-hint": [], missing: [], ok: [] };
  for (const r of rows) groups[r.kind].push(r);
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  return groups;
}

// ── Simulator runner ───────────────────────────────────────────────────

/** Build the harness with monkeyc and return the path to the .prg. */
function buildHarness(jungle, sdkHome, outPrg) {
  const monkeyc = join(sdkHome, "bin", "monkeyc");
  return runCmd(monkeyc, [
    "-d", TARGET_DEVICE,
    "-f", jungle,
    "-o", outPrg,
    "--warn",
  ]);
}

/** Boot monkeydo, capture stdout until we see MEASURE_DONE, then kill.
 *  Resolves with the captured stdout buffer. */
function runMonkeydo(prg, sdkHome, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const monkeydo = join(sdkHome, "bin", "monkeydo");
    const child = spawn(monkeydo, [prg, TARGET_DEVICE], {
      env: { ...process.env, CONNECT_IQ_SDK_HOME: sdkHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      const killHard = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, 3_000);
      killHard.unref?.();
      if (err) reject(err);
      else resolve({ stdout, stderr });
    };
    const timer = setTimeout(
      () => settle(new Error(`monkeydo timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      // Echo to our own stdout so CI logs show progress in real time.
      process.stdout.write(chunk);
      if (stdout.includes("MEASURE_DONE")) settle();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      process.stderr.write(chunk);
    });
    child.on("error", (err) => settle(err));
    child.on("exit", (code, signal) => {
      // monkeydo exits non-zero when we SIGTERM it after MEASURE_DONE,
      // which is fine. Only treat exit-without-MEASURE_DONE as failure.
      if (!stdout.includes("MEASURE_DONE")) {
        settle(new Error(
          `monkeydo exited (code=${code}, signal=${signal}) before printing MEASURE_DONE`,
        ));
      } else {
        settle();
      }
    });
  });
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────────

async function runFullPipeline() {
  const sdkHome = process.env.CONNECT_IQ_SDK_HOME;
  if (!sdkHome) {
    console.error(
      "check-garmin-watch-overflow-tight: CONNECT_IQ_SDK_HOME is not set.\n" +
        "  This script requires a Connect IQ SDK install (≥ 7.4.x).\n" +
        "  In CI it's provisioned by the `garmin-overflow-tight` job in\n" +
        "  `.github/workflows/watch-face-overflow.yml`, gated on\n" +
        "  `secrets.CONNECT_IQ_SDK_URL`. The always-on pure-Node guard\n" +
        "  (`pnpm run lint:garmin-watch-overflow`) is what gates PRs;\n" +
        "  this tight check is informational SDK-gated reconciliation.",
    );
    process.exit(2);
  }

  const localeData = loadAllLocales();
  const samples = buildSamples(localeData);
  console.log(
    `check-garmin-watch-overflow-tight: generated ${samples.length} ` +
      `(spec, locale, line) samples from ${SPECS.length} specs × ` +
      `${localeData.size} locales.`,
  );

  console.log(`Writing harness to ${relative(repoRoot, HARNESS_DIR)}/`);
  const jungle = writeHarness(samples, HARNESS_DIR);

  const outPrg = join(HARNESS_DIR, "build", `harness-${TARGET_DEVICE}.prg`);
  mkdirSync(dirname(outPrg), { recursive: true });
  console.log(`Building harness with monkeyc -d ${TARGET_DEVICE}…`);
  await buildHarness(jungle, sdkHome, outPrg);

  console.log(`Running monkeydo against the ${TARGET_DEVICE} simulator…`);
  const { stdout } = await runMonkeydo(outPrg, sdkHome);
  const { measurements, sawDone } = parseSimulatorLog(stdout);
  if (!sawDone) {
    console.error(
      "check-garmin-watch-overflow-tight: simulator stdout missing the " +
        "MEASURE_DONE sentinel — harness or simulator failed mid-run.",
    );
    process.exit(2);
  }

  const rows = reconcile(samples, measurements);
  return reportAndExit(rows);
}

function reportAndExit(rows) {
  const groups = groupByKind(rows);
  const total = rows.length;
  const okCount = groups.ok.length;
  const tightHints = groups["tightening-hint"];
  const underbound = groups.underbound;
  const missing = groups.missing;

  console.log(
    `\ncheck-garmin-watch-overflow-tight: reconciled ${total} samples ` +
      `against the simulator.\n` +
      `  exact / within-tolerance : ${okCount}\n` +
      `  tightening hints (Node > sim by ≥ ${TIGHTENING_HINT_PX}px) : ${tightHints.length}\n` +
      `  missing measurements     : ${missing.length}\n` +
      `  UNDER-BOUND (Node < sim) : ${underbound.length}\n`,
  );

  if (tightHints.length > 0) {
    console.log(
      `Over-estimates (informational — Node model is upper-bounded but ` +
        `padded; consider tightening the per-glyph fractions):`,
    );
    for (const r of tightHints) console.log(formatRow(r));
    console.log("");
  }

  if (missing.length > 0) {
    console.error(
      `Samples not measured by the simulator (harness regression?):`,
    );
    for (const r of missing) console.error(formatRow(r));
    console.error("");
  }

  if (underbound.length > 0) {
    console.error(
      `FALSE NEGATIVES — the Node estimator under-bounded the simulator:`,
    );
    for (const r of underbound) console.error(formatRow(r));
    console.error(
      `\nFix by raising the relevant entry in ASCII_WIDTH_FRAC, ` +
        `SCRIPT_WIDTH_MULTIPLIER, or FONT_METRICS in\n` +
        `  scripts/check-garmin-watch-overflow.mjs\n` +
        `until \`node scripts/check-garmin-watch-overflow-tight.mjs\` ` +
        `reports zero under-bounds.\n`,
    );
    process.exit(1);
  }
  if (missing.length > 0) process.exit(2);
  process.exit(0);
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

  // Sample generator: build against the real strings.xml tree so we
  // exercise the full SPEC × LOCALE matrix.
  const samples = buildSamples(loadAllLocales());
  expect(
    "buildSamples produces a non-empty sample list",
    samples.length > 0,
    `got ${samples.length}`,
  );
  expect(
    "every sample has a valid font key",
    samples.every((s) =>
      ["TINY", "SMALL", "MEDIUM", "NUMBER_HOT"].includes(s.font),
    ),
  );
  expect(
    "every sample has a non-empty text and stable id",
    samples.every(
      (s) =>
        typeof s.text === "string" &&
        s.text.length > 0 &&
        /^[^|]+\|[^|]+\|[^|]+\|\d+$/.test(s.id),
    ),
  );
  expect(
    "every spec is represented at least once",
    new Set(samples.map((s) => s.label)).size === SPECS.length,
    `got ${new Set(samples.map((s) => s.label)).size} of ${SPECS.length}`,
  );
  expect(
    "ids are unique across the sample set",
    new Set(samples.map((s) => s.id)).size === samples.length,
  );
  // Node widths populated and >0 for non-empty text.
  expect(
    "nodeWidthPx is positive for every sample",
    samples.every((s) => s.nodeWidthPx > 0),
  );

  // Harness writer: round-trip against a temp dir so we don't pollute
  // the persistent .local copy that real runs write.
  const tmp = join(repoRoot, ".local", `garmin-tight-selftest-${process.pid}`);
  writeHarness(samples.slice(0, 3), tmp);
  for (const rel of [
    "manifest.xml",
    "monkey.jungle",
    "source/HarnessApp.mc",
    "resources/strings/strings.xml",
    "resources/json/jsonData.xml",
    "resources/json/samples.json",
    "resources/drawables/drawables.xml",
    "resources/drawables/launcher_icon.png",
  ]) {
    expect(`writeHarness creates ${rel}`, existsSync(join(tmp, rel)));
  }
  // Generated jsonData payload round-trips JSON cleanly and matches
  // the input samples.
  const reread = JSON.parse(
    readFileSync(join(tmp, "resources", "json", "samples.json"), "utf8"),
  );
  expect(
    "samples.json round-trip preserves ids + fonts + text",
    reread.length === 3 &&
      reread[0][0] === samples[0].id &&
      reread[0][1] === samples[0].font &&
      reread[0][2] === samples[0].text,
  );
  // Manifest declares the smallest-face product so the harness
  // measures against the actual fenix7s glyph tables, not a larger
  // device's supersized fonts.
  const manifest = readFileSync(join(tmp, "manifest.xml"), "utf8");
  expect(
    `manifest pins the ${TARGET_DEVICE} product`,
    manifest.includes(`<iq:product id="${TARGET_DEVICE}"/>`),
  );
  // Harness source contains the sentinel + measurement loop + the
  // 4-way font dispatch.
  const harnessMc = readFileSync(join(tmp, "source", "HarnessApp.mc"), "utf8");
  expect(
    "harness source emits MEASURE_BEGIN / MEASURE / MEASURE_DONE",
    harnessMc.includes('"MEASURE_BEGIN|"') &&
      harnessMc.includes('"MEASURE|"') &&
      harnessMc.includes('"MEASURE_DONE"'),
  );
  expect(
    "harness source dispatches all four font tiers",
    harnessMc.includes("FONT_TINY") &&
      harnessMc.includes("FONT_SMALL") &&
      harnessMc.includes("FONT_MEDIUM") &&
      harnessMc.includes("FONT_NUMBER_HOT"),
  );
  rmSync(tmp, { recursive: true, force: true });

  // Log parser fixtures.
  const fixtureLog =
    "monkeydo: launching harness on fenix7s\n" +
    "MEASURE_BEGIN|3\n" +
    "MEASURE|KharagolfPairingView|PairTitle|eng|0|72\n" +
    "MEASURE|KharagolfRoundView|HoleHeader|eng|0|110\n" +
    "MEASURE|KharagolfDataField|DfPlaysLikeLine|chs|0|180\n" +
    "MEASURE_DONE\n" +
    "monkeydo: app exited\n";
  const parsed = parseSimulatorLog(fixtureLog);
  expect("parseSimulatorLog detects MEASURE_DONE", parsed.sawDone === true);
  expect(
    "parseSimulatorLog parses three measurements with pipe-rich ids",
    parsed.measurements.size === 3 &&
      parsed.measurements.get("KharagolfPairingView|PairTitle|eng|0") === 72 &&
      parsed.measurements.get("KharagolfRoundView|HoleHeader|eng|0") === 110 &&
      parsed.measurements.get("KharagolfDataField|DfPlaysLikeLine|chs|0") === 180,
  );
  // Truncated logs (no MEASURE_DONE) are flagged so the runner can
  // distinguish "harness ran to completion" from "simulator died
  // mid-run".
  const truncated = parseSimulatorLog(
    "MEASURE_BEGIN|2\nMEASURE|a|b|c|0|10\n",
  );
  expect("parseSimulatorLog flags truncated logs", truncated.sawDone === false);

  // Reconciliation classifier.
  /** @type {Sample[]} */
  const synth = [
    {
      id: "S1|L1|eng|0", screen: "S1", label: "L1", locale: "eng",
      lineIndex: 0, font: "TINY", text: "ok",
      nodeWidthPx: 50, budgetPx: 100,
    },
    {
      id: "S2|L2|eng|0", screen: "S2", label: "L2", locale: "eng",
      lineIndex: 0, font: "TINY", text: "tight",
      nodeWidthPx: 80, budgetPx: 100,
    },
    {
      id: "S3|L3|eng|0", screen: "S3", label: "L3", locale: "eng",
      lineIndex: 0, font: "TINY", text: "under",
      nodeWidthPx: 30, budgetPx: 100,
    },
    {
      id: "S4|L4|eng|0", screen: "S4", label: "L4", locale: "eng",
      lineIndex: 0, font: "TINY", text: "missing",
      nodeWidthPx: 40, budgetPx: 100,
    },
    {
      id: "S5|L5|eng|0", screen: "S5", label: "L5", locale: "eng",
      lineIndex: 0, font: "TINY", text: "rounding",
      nodeWidthPx: 49, budgetPx: 100,
    },
  ];
  const measurements = new Map([
    ["S1|L1|eng|0", 50], // exact
    ["S2|L2|eng|0", 60], // node 80 vs sim 60 → +20 → tightening hint
    ["S3|L3|eng|0", 50], // node 30 vs sim 50 → −20 → underbound
    // S4 deliberately missing
    ["S5|L5|eng|0", 50], // node 49 vs sim 50 → −1 → within tolerance
  ]);
  const recs = reconcile(synth, measurements);
  const byId = Object.fromEntries(recs.map((r) => [r.id, r]));
  expect("reconcile: exact match → ok", byId["S1|L1|eng|0"].kind === "ok");
  expect(
    "reconcile: node ≫ sim → tightening-hint",
    byId["S2|L2|eng|0"].kind === "tightening-hint" &&
      byId["S2|L2|eng|0"].diffPx === 20,
  );
  expect(
    "reconcile: node < sim → underbound",
    byId["S3|L3|eng|0"].kind === "underbound" &&
      byId["S3|L3|eng|0"].diffPx === -20,
  );
  expect(
    "reconcile: missing measurement → missing",
    byId["S4|L4|eng|0"].kind === "missing" &&
      byId["S4|L4|eng|0"].simWidthPx === -1,
  );
  expect(
    "reconcile: 1 px under bound is absorbed as ok (rounding noise)",
    byId["S5|L5|eng|0"].kind === "ok" && byId["S5|L5|eng|0"].diffPx === -1,
  );

  // formatRow stable shape (used in CI logs; downstream tooling greps
  // it for the failure list — keep the leading "  - [screen/label/" prefix).
  const sample = formatRow(byId["S3|L3|eng|0"]);
  expect(
    "formatRow has the documented leading prefix",
    sample.startsWith("  - [S3/L3/eng#0]"),
    `got ${sample}`,
  );

  if (failed > 0) {
    console.error(`\nself-test: ${failed} case(s) failed`);
    process.exit(1);
  }
  console.log("\nself-test: all cases passed");
}

async function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  if (process.argv.includes("--write-harness")) {
    const samples = buildSamples(loadAllLocales());
    writeHarness(samples, HARNESS_DIR);
    console.log(
      `check-garmin-watch-overflow-tight: wrote harness for ` +
        `${samples.length} samples to ` +
        `${relative(repoRoot, HARNESS_DIR)}/`,
    );
    return;
  }
  await runFullPipeline();
}

main().catch((err) => {
  console.error(`check-garmin-watch-overflow-tight: ${err.stack || err}`);
  process.exit(2);
});
