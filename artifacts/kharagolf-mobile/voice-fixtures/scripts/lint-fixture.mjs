#!/usr/bin/env node
// Re-run the PII heuristics from anonymise.mjs over every committed
// transcript in dogfooding-transcripts.json and fail the build if any
// sample would have produced a `// WARN:` comment when freshly
// anonymised.
//
// Intended to be wired into CI / a pre-commit hook so accidental PII
// leaks (or tightened heuristics catching old slip-ups) block the
// merge instead of shipping with the test bundles. See README.md.
//
// Usage:
//   node scripts/lint-fixture.mjs

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { detectWarnings } from "./anonymise.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Default: lint the committed dogfooding corpus. The `VOICE_FIXTURE_PATH`
// override exists so the runner's own test suite can point it at a
// synthetic fixture in a tmp dir; production CI never sets it.
const FIXTURE_PATH = process.env.VOICE_FIXTURE_PATH
  ? resolve(process.env.VOICE_FIXTURE_PATH)
  : resolve(HERE, "..", "dogfooding-transcripts.json");

function loadSamples() {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  const json = JSON.parse(raw);
  if (!json || !Array.isArray(json.samples)) {
    throw new Error(
      "dogfooding-transcripts.json: expected a top-level `samples` array",
    );
  }
  // Every entry in `samples` must carry a string `transcript`. We refuse
  // to silently skip schema drift here — otherwise a malformed entry
  // (e.g. a typo'd field name or a stray non-string transcript) could
  // sneak past the PII gate without ever being scanned.
  const malformed = [];
  json.samples.forEach((s, index) => {
    if (!s || typeof s !== "object" || typeof s.transcript !== "string") {
      malformed.push({ index, sample: s });
    }
  });
  if (malformed.length > 0) {
    const summary = malformed
      .map(({ index, sample }) => `  samples[${index}]: ${JSON.stringify(sample)}`)
      .join("\n");
    throw new Error(
      `dogfooding-transcripts.json: ${malformed.length} sample entr${malformed.length === 1 ? "y is" : "ies are"} ` +
        `missing a string \`transcript\` — refusing to lint a corpus with schema drift:\n${summary}`,
    );
  }
  return json.samples;
}

function main() {
  const samples = loadSamples();
  const failures = [];
  for (const sample of samples) {
    const warnings = detectWarnings(sample.transcript);
    if (warnings.length > 0) {
      failures.push({
        id: sample.id ?? "(no id)",
        transcript: sample.transcript,
        warnings,
      });
    }
  }

  if (failures.length === 0) {
    process.stderr.write(
      `voice-fixtures lint: ${samples.length} sample${samples.length === 1 ? "" : "s"} clean — no PII warnings.\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    `voice-fixtures lint: PII detector flagged ${failures.length} sample${failures.length === 1 ? "" : "s"} in dogfooding-transcripts.json.\n` +
      `Re-run the heuristics from scripts/anonymise.mjs (see voice-fixtures/README.md) and scrub the offending entries before committing.\n\n`,
  );
  for (const { id, transcript, warnings } of failures) {
    process.stderr.write(`  ${id}: ${JSON.stringify(transcript)}\n`);
    for (const w of warnings) {
      process.stderr.write(`    WARN: ${w}\n`);
    }
  }
  process.exit(1);
}

main();
