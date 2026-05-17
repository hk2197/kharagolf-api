// End-to-end coverage for every input shape `anonymise.mjs` documents
// in its header comment and in voice-fixtures/README.md.
//
// The existing anonymise.test.mjs suite only exercises the plain-text
// path via stdin, so a regression in extractRawTranscripts /
// collectFromJson (e.g. dropping the `samples` envelope key, or
// flipping which of `transcript`/`text` wins) would slip through CI
// silently and only surface the next time someone tried to paste a
// recogniser dump in JSON form. This file feeds the same canonical
// set of transcripts through every documented envelope and asserts
// that the rendered draft entries come out identical regardless of
// envelope, plus that a string starting with `{` but not valid JSON
// falls through to plain-text handling.
//
// Same dependency-free Node ESM setup as the sibling test file —
// runs via `pnpm voice-fixtures:test` and as part of the
// `Voice fixtures PII check` GitHub Actions workflow.
//
// Run from this directory:
//   node --test anonymise.input-formats.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGINAL_SCRIPT = resolve(HERE, "anonymise.mjs");
const ORIGINAL_FIXTURE = resolve(HERE, "..", "dogfooding-transcripts.json");

// Mirror the sandbox layout used by anonymise.test.mjs so the script's
// FIXTURE_PATH resolution (relative to its own location) keeps working
// while the real corpus stays untouched.
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "anonymise-input-formats-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(ORIGINAL_SCRIPT, join(dir, "scripts", "anonymise.mjs"));
  writeFileSync(
    join(dir, "dogfooding-transcripts.json"),
    readFileSync(ORIGINAL_FIXTURE, "utf8"),
  );
  return {
    scriptPath: join(dir, "scripts", "anonymise.mjs"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runDry(sb, input) {
  return spawnSync(process.execPath, [sb.scriptPath, "-"], {
    input,
    encoding: "utf8",
  });
}

// Pull every rendered transcript string out of dry-run stdout. The
// formatter emits one `{ "id": ..., "transcript": "...", ... }` line
// per draft entry, so the regex is unambiguous.
function renderedTranscripts(stdout) {
  const out = [];
  const re = /"transcript":\s*("(?:[^"\\]|\\.)*")/g;
  let match;
  while ((match = re.exec(stdout)) !== null) {
    out.push(JSON.parse(match[1]));
  }
  return out;
}

// Canonical set fed through every shape. Chosen so cleanTranscript is
// a no-op (already lowercased, no leading timestamp prefix) and so
// detectWarnings stays quiet — a dry-run with WARNs would still
// succeed, but we want the rendered transcripts to be byte-identical
// across shapes so the equality assertions below are meaningful.
const CANONICAL = ["par on 7", "two putts on hole 6", "log 5 on hole 1"];

// Each shape lists the inputs it produces along with the exact set of
// transcripts the script should extract. The expected set is asserted
// as an *ordered* list because extractRawTranscripts preserves input
// order (Array.flatMap, plain-text line iteration) — a regression that
// shuffles the order would be a bug in its own right.
const SHAPES = [
  {
    name: "plain text — one transcript per non-empty line",
    input: ["", "par on 7", "  two putts on hole 6  ", "", "log 5 on hole 1", ""].join("\n"),
    expected: CANONICAL,
  },
  {
    name: "JSON string — single transcript",
    input: JSON.stringify("par on 7"),
    expected: ["par on 7"],
  },
  {
    name: "JSON array of strings",
    input: JSON.stringify(CANONICAL),
    expected: CANONICAL,
  },
  {
    name: "JSON array of objects with `transcript` field (extra metadata ignored)",
    input: JSON.stringify(
      CANONICAL.map((t) => ({ transcript: t, timestamp: "12:34", player: "anon" })),
    ),
    expected: CANONICAL,
  },
  {
    name: "JSON array of objects with `text` field (text fallback when no transcript key)",
    input: JSON.stringify(CANONICAL.map((t) => ({ text: t }))),
    expected: CANONICAL,
  },
  {
    name: "JSON object with `transcript` field — single entry",
    input: JSON.stringify({ transcript: "par on 7", timestamp: "12:34" }),
    expected: ["par on 7"],
  },
  {
    name: "JSON object with `text` field — single entry (text fallback)",
    input: JSON.stringify({ text: "par on 7" }),
    expected: ["par on 7"],
  },
  {
    name: "JSON envelope with `transcripts` array of strings",
    input: JSON.stringify({ transcripts: CANONICAL }),
    expected: CANONICAL,
  },
  {
    name: "JSON envelope with `samples` array of objects",
    input: JSON.stringify({ samples: CANONICAL.map((t) => ({ transcript: t })) }),
    expected: CANONICAL,
  },
  {
    name: "JSON envelope with `results` array of mixed strings + `text` objects",
    input: JSON.stringify({
      results: [CANONICAL[0], { text: CANONICAL[1] }, { transcript: CANONICAL[2] }],
    }),
    expected: CANONICAL,
  },
];

for (const { name, input, expected } of SHAPES) {
  test(`input shape: ${name}`, (t) => {
    const sb = makeSandbox();
    t.after(sb.cleanup);

    const result = runDry(sb, input);
    assert.equal(
      result.status,
      0,
      `dry-run should succeed for shape "${name}"; stderr:\n${result.stderr}`,
    );

    const got = renderedTranscripts(result.stdout);
    assert.deepEqual(
      got,
      expected,
      `shape "${name}" should yield ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
    );
  });
}

// Cross-shape consistency: every envelope that wraps the canonical
// triple must produce byte-identical rendered transcripts. We compare
// against the plain-text rendering as the reference, so a regression
// that, say, started preferring `text` over `transcript` (or stopped
// recognising `samples`) would produce a diff here even if the
// per-shape assertions above were loosened.
test("cross-shape consistency: every envelope renders the same transcripts", (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  const reference = renderedTranscripts(runDry(sb, CANONICAL.join("\n")).stdout);
  assert.deepEqual(reference, CANONICAL, "reference plain-text rendering");

  for (const { name, input, expected } of SHAPES) {
    if (expected.length !== CANONICAL.length) continue;
    const got = renderedTranscripts(runDry(sb, input).stdout);
    assert.deepEqual(
      got,
      reference,
      `shape "${name}" diverged from plain-text reference: ${JSON.stringify(got)} vs ${JSON.stringify(reference)}`,
    );
  }
});

// Malformed JSON: a string that starts with `{` (or `[`, or `"`)
// but isn't valid JSON must fall through to the plain-text branch
// rather than throwing. This is the documented behaviour of
// extractRawTranscripts — without it, a contributor pasting a partial
// JSON snippet would see a confusing syntax error instead of a draft
// entry.
test("malformed JSON starting with `{` falls through to plain-text handling", (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  // Starts with `{` so the JSON.parse branch is attempted, but the
  // missing closing brace makes it invalid. Plain-text handling
  // should treat the whole line as a single transcript.
  const input = "{ par on 7";
  const result = runDry(sb, input);
  assert.equal(result.status, 0, `dry-run should succeed; stderr:\n${result.stderr}`);

  const got = renderedTranscripts(result.stdout);
  assert.deepEqual(
    got,
    ["{ par on 7"],
    `malformed-JSON input should fall through to plain text; got ${JSON.stringify(got)}`,
  );
});

test("malformed JSON starting with `[` falls through to plain-text handling", (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  // Two non-empty lines, both starting in a way that would normally
  // trigger JSON parsing. The whole input as a unit isn't valid JSON,
  // so plain-text handling must split on newlines and emit two draft
  // entries.
  const input = "[ par on 7\n[ two putts on hole 6";
  const result = runDry(sb, input);
  assert.equal(result.status, 0, `dry-run should succeed; stderr:\n${result.stderr}`);

  const got = renderedTranscripts(result.stdout);
  assert.deepEqual(
    got,
    ["[ par on 7", "[ two putts on hole 6"],
    `malformed-JSON multi-line input should fall through to plain text; got ${JSON.stringify(got)}`,
  );
});

test("malformed JSON starting with `\"` falls through to plain-text handling", (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  // Opens like a JSON string but never closes the quote.
  const input = '"par on 7';
  const result = runDry(sb, input);
  assert.equal(result.status, 0, `dry-run should succeed; stderr:\n${result.stderr}`);

  const got = renderedTranscripts(result.stdout);
  assert.deepEqual(
    got,
    ['"par on 7'],
    `malformed JSON-string input should fall through to plain text; got ${JSON.stringify(got)}`,
  );
});
