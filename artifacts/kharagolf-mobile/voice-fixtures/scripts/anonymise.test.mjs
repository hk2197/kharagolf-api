// End-to-end tests for anonymise.mjs.
//
// Each test runs the real script as a child process against a sandbox
// copy of dogfooding-transcripts.json so we exercise the same code path
// (including the FIXTURE_PATH resolution and the JSON validity guard)
// that contributors and CI hit. No dependencies beyond Node's built-in
// test runner — keeps this in step with how lint-fixture.mjs already
// runs in CI without a pnpm install.
//
// Run from this directory:
//   node --test anonymise.test.mjs
// or via the mobile package script:
//   pnpm voice-fixtures:test

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

// ---------- sandbox helpers ---------------------------------------------

// Build a temp directory laid out like the real voice-fixtures dir:
//   <tmp>/dogfooding-transcripts.json
//   <tmp>/scripts/anonymise.mjs
// The script computes its fixture path relative to its own location, so
// running the copy in <tmp>/scripts/ keeps the resolution identical to
// production while leaving the real corpus untouched.
function makeSandbox({ fixtureText, omitFixture = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonymise-test-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(ORIGINAL_SCRIPT, join(dir, "scripts", "anonymise.mjs"));
  if (!omitFixture) {
    const text = fixtureText ?? readFileSync(ORIGINAL_FIXTURE, "utf8");
    writeFileSync(join(dir, "dogfooding-transcripts.json"), text);
  }
  return {
    dir,
    scriptPath: join(dir, "scripts", "anonymise.mjs"),
    fixturePath: join(dir, "dogfooding-transcripts.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runScript(sandbox, args, { input } = {}) {
  return spawnSync(process.execPath, [sandbox.scriptPath, ...args], {
    input,
    encoding: "utf8",
  });
}

// Find which `_comment` group an inserted entry landed in by walking
// the file the same way the script does — track the most recent
// sub-group header (the `── ... ──` ones) as we scan.
function findGroupForId(fixtureText, id) {
  let currentComment = null;
  for (const line of fixtureText.split("\n")) {
    const commentMatch = line.match(/"_comment"\s*:\s*"([^"]*)"/);
    if (commentMatch && line.includes("──")) {
      currentComment = commentMatch[1];
    }
    if (line.includes(`"id": "${id}"`)) {
      return currentComment;
    }
  }
  return null;
}

// Return the column at which `"expected":` appears in the line that
// contains the given id. Used to verify column-alignment behaviour.
function expectedColumnForId(fixtureText, id) {
  for (const line of fixtureText.split("\n")) {
    if (!line.includes(`"id": "${id}"`)) continue;
    const idx = line.indexOf('"expected":');
    return idx === -1 ? null : idx;
  }
  return null;
}

// Most common column of `"expected":` across rows that have one — used
// to assert the canonical alignment isn't disturbed by a long row.
function dominantExpectedColumn(fixtureText) {
  const counts = new Map();
  for (const line of fixtureText.split("\n")) {
    const idx = line.indexOf('"expected":');
    if (idx > 0 && /"id"\s*:/.test(line)) {
      counts.set(idx, (counts.get(idx) ?? 0) + 1);
    }
  }
  let best = -1;
  let bestCount = 0;
  for (const [col, count] of counts) {
    if (count > bestCount) {
      best = col;
      bestCount = count;
    }
  }
  return best;
}

// Compute the id `anonymise.mjs` will assign to the next inserted row,
// using the same `max(dNNN) + 1` rule the script's `nextFreeId` uses.
// Derived per-sandbox so the suite keeps working as the corpus grows.
function computeNextId(fixturePath) {
  let raw;
  try {
    raw = readFileSync(fixturePath, "utf8");
  } catch {
    return "d001";
  }
  const ids = [...raw.matchAll(/"id"\s*:\s*"d(\d+)"/g)].map((m) => Number(m[1]));
  const max = ids.length > 0 ? Math.max(...ids) : 0;
  return "d" + String(max + 1).padStart(3, "0");
}

function bumpId(id, n) {
  return "d" + String(Number(id.slice(1)) + n).padStart(3, "0");
}

// ---------- routing branches --------------------------------------------
//
// Each routing branch in pickGroupKey corresponds to a `_comment` group
// in the corpus. These tests pipe a single transcript through `--apply`
// and assert it lands inside the matching group. They also re-parse the
// resulting file so the JSON validity guard is exercised end-to-end on
// every routing branch — that's the corpus invariant the script is
// meant to defend.

const ROUTING_CASES = [
  { name: "putts → 'Putts variants'",                input: "two putts on hole 6",        markerLower: "putts variants" },
  { name: "birdie → 'Birdie / eagle'",               input: "birdie on 4",                markerLower: "birdie / eagle" },
  { name: "eagle → 'Birdie / eagle'",                input: "eagle on 12",                markerLower: "birdie / eagle" },
  { name: "par → 'Par phrasings'",                   input: "par on 7",                   markerLower: "par phrasings" },
  { name: "bogey → 'Bogey / double / triple'",       input: "bogey on 3",                 markerLower: "bogey / double" },
  { name: "ace → 'Hole-in-one / ace'",               input: "ace on 8",                   markerLower: "hole-in-one" },
  { name: "absolute strokes → 'Absolute strokes'",   input: "log 5 on hole 1",            markerLower: "absolute strokes" },
  { name: "homophone-sourced score → 'Mishears'",    input: "tree on hole 5",             markerLower: "common mishears" },
  { name: "undo → 'Undo phrasings'",                 input: "undo that",                  markerLower: "undo phrasings" },
  { name: "side-chatter → 'Side-chatter'",           input: "great shot man",             markerLower: "side-chatter" },
  // Digit-based score with strokes >= 11 routes to the high-stroke
  // group. Number-word inputs ("twelve on hole 4") don't currently
  // suggest a strokes value because suggestExpected's vocab stops at
  // ten — those entries are still hand-curated.
  { name: "high-stroke (digit, strokes>=11) → 'High-stroke'", input: "took 12 on hole 5",  markerLower: "high-stroke" },
  // Single-utterance stroke corrections ("actually six", "make it a
  // six instead", "scratch that, six") share a dedicated group keyed
  // on `correction: true` with a null hole.
  { name: "single-utterance correction → 'Single-utterance stroke corrections'", input: "actually six", markerLower: "single-utterance stroke corrections" },
  // Hole-targeted corrections carry an explicit older hole AND
  // `correction: true`. The corpus splits them into two sub-groups
  // by editorial convention: digit-form holes ("change hole 7 to a
  // five", "fix hole 9 to 4", "hole 12 should be a bogey") and
  // worded-form holes ("fix hole eleven to four", "fix hole tin to a
  // bogey"). The router picks the right sub-group based on whether
  // the cleaned transcript uses a digit or a word for the hole
  // token, and we assert each input lands in the *specific*
  // sub-group rather than just somewhere matching "hole-targeted
  // corrections" — that's the bug the split fixes. Routing is
  // independent of whether the value parses as Score or Relative.
  // The digit-form marker substring includes the trailing `(` so it
  // doesn't also match the worded-form header (which reads
  // `Hole-targeted corrections where the hole number is spoken as a
  // word`, with no `(` after `corrections`).
  { name: "hole-targeted correction (digit hole, score)             → 'Hole-targeted corrections (digit form)'",  input: "change hole 7 to a five",  markerLower: "hole-targeted corrections (" },
  { name: "hole-targeted correction (digit hole, bare digit)        → 'Hole-targeted corrections (digit form)'",  input: "fix hole 9 to 4",          markerLower: "hole-targeted corrections (" },
  { name: "hole-targeted correction (digit hole, relative)          → 'Hole-targeted corrections (digit form)'",  input: "hole 12 should be a bogey", markerLower: "hole-targeted corrections (" },
  { name: "hole-targeted correction (worded hole, score)            → 'Hole-targeted corrections (worded form)'", input: "fix hole eleven to four",  markerLower: "hole-targeted corrections where the hole number is spoken as a word" },
  { name: "hole-targeted correction (worded hole, relative)         → 'Hole-targeted corrections (worded form)'", input: "change hole nine to a birdie", markerLower: "hole-targeted corrections where the hole number is spoken as a word" },
  { name: "hole-targeted correction (mishear 'tin'=10, relative)    → 'Hole-targeted corrections (worded form)'", input: "fix hole tin to a bogey",  markerLower: "hole-targeted corrections where the hole number is spoken as a word" },
];

// NOTE: pickGroupKey also has a `delta === -3` branch (albatross /
// double eagle), but suggestExpected has no keyword that produces
// delta=-3 today — `albatross` and `snowman` entries are hand-
// curated. Once the suggester learns those words, add a case above.

for (const { name, input, markerLower } of ROUTING_CASES) {
  test(`routing: ${name}`, (t) => {
    const sb = makeSandbox();
    t.after(sb.cleanup);

    const expectedId = computeNextId(sb.fixturePath);
    const result = runScript(sb, ["-", "--apply"], { input });
    assert.equal(result.status, 0, `expected success — stderr:\n${result.stderr}`);

    const updated = readFileSync(sb.fixturePath, "utf8");

    // JSON validity guard: every routing branch must leave a still-parseable corpus.
    const parsed = JSON.parse(updated);
    assert.ok(Array.isArray(parsed.samples), "samples array preserved");
    assert.ok(
      parsed.samples.some((s) => s.id === expectedId),
      `inserted entry ${expectedId} should appear in the parsed samples`,
    );

    // Routed into the right group.
    const group = findGroupForId(updated, expectedId);
    assert.ok(group, `entry ${expectedId} should sit inside a _comment group`);
    assert.ok(
      group.toLowerCase().includes(markerLower),
      `entry ${expectedId} landed in group "${group}", expected one matching "${markerLower}"`,
    );
  });
}

// ---------- column alignment --------------------------------------------

test("column alignment: typical transcript stays at the canonical column", (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  const baseline = dominantExpectedColumn(readFileSync(sb.fixturePath, "utf8"));
  // Sanity check: the corpus has a single dominant column. If this ever
  // shifts, the script's column-detection fallback will need a re-look.
  assert.ok(baseline > 0, "baseline corpus has a detectable canonical column");

  const expectedId = computeNextId(sb.fixturePath);
  const result = runScript(sb, ["-", "--apply"], { input: "par on 7" });
  assert.equal(result.status, 0, result.stderr);

  const col = expectedColumnForId(readFileSync(sb.fixturePath, "utf8"), expectedId);
  assert.equal(
    col,
    baseline,
    `inserted row should align "expected": at column ${baseline}, got ${col}`,
  );
});

test("column alignment: long transcript degrades to single-space padding without disturbing other rows", (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  const before = readFileSync(sb.fixturePath, "utf8");
  const baseline = dominantExpectedColumn(before);

  // Long enough that the prefix overruns the canonical column. Routes
  // as side-chatter (kind: "none") because none of the scoring keywords
  // match — that's fine, the column-alignment logic runs identically
  // for every group, and side-chatter is always present in the corpus.
  const longInput =
    "boy that was a really really really long ridiculous embarrassing catastrophe of a hole out there today";

  const expectedId = computeNextId(sb.fixturePath);
  const result = runScript(sb, ["-", "--apply"], { input: longInput });
  assert.equal(result.status, 0, result.stderr);

  const after = readFileSync(sb.fixturePath, "utf8");

  // The new row falls back to a single space before "expected": because
  // the prefix already exceeds the canonical column.
  const insertedLine = after
    .split("\n")
    .find((line) => line.includes(`"id": "${expectedId}"`));
  assert.ok(insertedLine, "inserted row should be present");
  assert.ok(
    /",\s"expected":/.test(insertedLine),
    `long-transcript row should fall back to single-space padding; got: ${insertedLine}`,
  );

  // The canonical column for the rest of the corpus is unchanged.
  const baselineAfter = dominantExpectedColumn(after);
  assert.equal(
    baselineAfter,
    baseline,
    "an over-long row must not skew the canonical column for surrounding rows",
  );

  // Spot-check: a known short row still sits at the canonical column.
  const knownRowCol = expectedColumnForId(after, "d013");
  assert.equal(
    knownRowCol,
    baseline,
    "pre-existing short rows keep their original alignment after insertion",
  );
});

// ---------- WARN handling -----------------------------------------------

test("WARN: dry-run still prints draft and surfaces the WARN, but does not write", (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  const before = readFileSync(sb.fixturePath, "utf8");
  // "Sarah" (capitalised) trips the proper-name heuristic in detectWarnings —
  // detectWarnings inspects the raw transcript before cleanTranscript() lowercases it.
  const expectedId = computeNextId(sb.fixturePath);
  const result = runScript(sb, ["-"], { input: "birdie Sarah on 5" });
  assert.equal(result.status, 0, `dry-run should succeed; stderr:\n${result.stderr}`);
  assert.match(result.stdout, /\/\/ WARN: possible name/, "WARN comment surfaced in dry-run output");
  assert.ok(
    result.stdout.includes(`"id": "${expectedId}"`),
    `draft entry ${expectedId} should be rendered to stdout`,
  );

  const after = readFileSync(sb.fixturePath, "utf8");
  assert.equal(after, before, "dry-run must not mutate the fixture");
});

test("WARN: --apply refuses when WARNs are present and leaves the fixture untouched", (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  const before = readFileSync(sb.fixturePath, "utf8");
  const result = runScript(sb, ["-", "--apply"], { input: "birdie Sarah on 5" });
  assert.equal(result.status, 1, "should exit non-zero on WARN refusal");
  assert.match(result.stderr, /refusing to --apply/i);
  assert.match(result.stderr, /--allow-warn/);

  const after = readFileSync(sb.fixturePath, "utf8");
  assert.equal(after, before, "WARN refusal must not mutate the fixture");
});

test("WARN: --apply --allow-warn writes despite WARNs and notes the bypass", (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  const expectedId = computeNextId(sb.fixturePath);
  const result = runScript(sb, ["-", "--apply", "--allow-warn"], {
    input: "birdie Sarah on 5",
  });
  assert.equal(result.status, 0, `should succeed with --allow-warn; stderr:\n${result.stderr}`);
  assert.match(result.stderr, /WARN.*bypassed via --allow-warn/);

  const updated = JSON.parse(readFileSync(sb.fixturePath, "utf8"));
  assert.ok(
    updated.samples.some((s) => s.id === expectedId),
    `entry ${expectedId} should be present after --allow-warn override`,
  );
});

test("WARN: --allow-warn alone (no --apply) is rejected with a usage error", (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  const result = runScript(sb, ["-", "--allow-warn"], { input: "par on 7" });
  assert.equal(result.status, 2, "--allow-warn without --apply should exit 2");
  assert.match(result.stderr, /--allow-warn only makes sense together with --apply/);
});

// ---------- ID auto-increment ------------------------------------------

test("id auto-increment: next id is max(existing dNNN) + 1, zero-padded", (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  const before = JSON.parse(readFileSync(sb.fixturePath, "utf8"));
  const beforeIds = new Set(before.samples.map((s) => s.id));
  const expectedId = computeNextId(sb.fixturePath);
  assert.ok(
    !beforeIds.has(expectedId),
    `${expectedId} must not already exist before --apply (sanity check on computeNextId)`,
  );

  const result = runScript(sb, ["-", "--apply"], { input: "par on 7" });
  assert.equal(result.status, 0, result.stderr);

  const updated = JSON.parse(readFileSync(sb.fixturePath, "utf8"));
  const ids = updated.samples.map((s) => s.id);
  assert.ok(ids.includes(expectedId), `expected new id ${expectedId}, got ids ${ids.slice(-5).join(",")}`);
});

test("id auto-increment: a multi-input run assigns consecutive ids", (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  const baseId = computeNextId(sb.fixturePath);
  const result = runScript(sb, ["-", "--apply"], {
    input: ["par on 7", "birdie on 4", "two putts"].join("\n"),
  });
  assert.equal(result.status, 0, result.stderr);

  const updated = JSON.parse(readFileSync(sb.fixturePath, "utf8"));
  const ids = new Set(updated.samples.map((s) => s.id));
  for (let i = 0; i < 3; i++) {
    const id = bumpId(baseId, i);
    assert.ok(ids.has(id), `expected ${id} to be assigned`);
  }
});

test("id auto-increment: missing fixture falls back to d001 (dry-run)", (t) => {
  const sb = makeSandbox({ omitFixture: true });
  t.after(sb.cleanup);

  const result = runScript(sb, ["-"], { input: "par on 7" });
  assert.equal(result.status, 0, `dry-run should succeed without a fixture; stderr:\n${result.stderr}`);
  assert.match(result.stdout, /"id": "d001"/, "should start numbering at d001 when no fixture exists");
});

// ---------- manual-fallback path for un-routable drafts -----------------

test("manual fallback: an entry whose target group is missing is surfaced to stderr and not inserted", (t) => {
  // Strip the "Putts variants" sub-group out of the fixture so a putts
  // draft has nowhere to go — the script should keep the file valid
  // and print the rendered row to stderr for manual pasting.
  const original = readFileSync(ORIGINAL_FIXTURE, "utf8");
  const lines = original.split("\n");

  const headerIdx = lines.findIndex((line) =>
    line.toLowerCase().includes("putts variants"),
  );
  assert.ok(headerIdx > 0, "test setup: expected a 'Putts variants' header");
  // Walk forward to the next blank line — that's the boundary between
  // sub-groups in the corpus convention.
  let endIdx = headerIdx;
  while (endIdx < lines.length && lines[endIdx].trim() !== "") endIdx++;
  const truncated = lines.slice(0, headerIdx).concat(lines.slice(endIdx)).join("\n");
  // Sanity: the truncated text is still valid JSON and no longer has the marker.
  JSON.parse(truncated);
  assert.ok(!truncated.toLowerCase().includes("putts variants"));

  const sb = makeSandbox({ fixtureText: truncated });
  t.after(sb.cleanup);

  const before = readFileSync(sb.fixturePath, "utf8");
  const expectedId = computeNextId(sb.fixturePath);
  const result = runScript(sb, ["-", "--apply"], { input: "two putts" });
  assert.equal(result.status, 0, result.stderr);

  // Stderr should call out the un-routed entry by its routing key.
  assert.match(
    result.stderr,
    /could not be auto-routed/i,
    "missing-group fallback should be announced on stderr",
  );
  assert.match(
    result.stderr,
    /no _comment group matched routing key "putts"/,
    "stderr should name the routing key that had no group",
  );
  assert.ok(
    new RegExp(`"id": "${expectedId}".*"transcript": "two putts"`).test(result.stderr),
    `stderr should include the rendered row (${expectedId}) so the contributor can paste it`,
  );

  // The fixture is still valid JSON and the un-routable entry was NOT inserted.
  const after = readFileSync(sb.fixturePath, "utf8");
  const parsed = JSON.parse(after);
  assert.ok(
    !parsed.samples.some((s) => s.id === expectedId),
    `un-routable entry ${expectedId} must not appear in the corpus`,
  );
  // The rest of the file is unchanged.
  assert.equal(after, before, "missing-group fallback must leave the fixture byte-identical");
});

// ---------- explicit-marker section detection ---------------------------
//
// Section detection used to substring-match on the prose inside each
// `_comment` header ("birdie / eagle", "high-stroke", "common
// mishears", ...). That made adding any new section a prose minefield:
// a header whose description happened to mention another section's
// keyword got mis-identified, and any auto-routed entry then landed in
// the wrong group — silently producing invalid JSON the next time
// --apply ran. Sections now declare their routing key via an explicit
// `"_groupKey": "<key>"` field on the same JSON line, so the prose can
// say whatever the contributor likes.

test("section detection: comment text mentioning another group's keywords does not misroute insertions", (t) => {
  // A "Par phrasings" sub-group whose comment ALSO mentions both
  // "high-stroke" and "common mishears" — substrings of two *other*
  // sections' legacy markers. Under the old substring-matcher the
  // header would resolve to whichever marker was checked first in the
  // GROUP_MARKERS map (highStroke), so a `par on 7` insertion would
  // have landed in the wrong group. With the explicit `_groupKey`
  // field the prose is irrelevant and the entry must land here.
  // The trailing "Worded notes" sub-group is intentionally left
  // un-routable (no `_groupKey`) so the par and high-stroke groups are
  // never the last group in the file — the existing trailing-comma
  // convention in applyInsertions assumes inserts land before another
  // entry, not at the very end of the samples array.
  const synthetic = [
    "{",
    '  "minimumRecognitionRate": 0,',
    '  "samples": [',
    '    { "_comment": "── Par phrasings (notes: see also high-stroke and common mishears banter elsewhere) ──", "_groupKey": "par",',
    '      "id": "d001", "transcript": "par on 1", "expected": { "kind": "relative", "hole": 1, "delta": 0 } },',
    '    { "id": "d002", "transcript": "par on 2", "expected": { "kind": "relative", "hole": 2, "delta": 0 } },',
    '    { "_comment": "── Real high-stroke entries ──", "_groupKey": "highStroke",',
    '      "id": "d003", "transcript": "took 12 on hole 5", "expected": { "kind": "score", "hole": 5, "strokes": 12 } },',
    '    { "_comment": "── Worded notes (unrouted on purpose) ──",',
    '      "id": "d004", "transcript": "took eight on hole eleven", "expected": { "kind": "score", "hole": 11, "strokes": 8 } }',
    "  ]",
    "}",
    "",
  ].join("\n");

  const sb = makeSandbox({ fixtureText: synthetic });
  t.after(sb.cleanup);

  const expectedId = computeNextId(sb.fixturePath); // "d004"
  const result = runScript(sb, ["-", "--apply"], { input: "par on 7" });
  assert.equal(result.status, 0, `expected success — stderr:\n${result.stderr}`);

  const updated = readFileSync(sb.fixturePath, "utf8");
  JSON.parse(updated); // still valid JSON

  // Verify by line position: the inserted row must sit between the
  // par header and the high-stroke header, i.e. inside the par group.
  // We can't just scan the comment text since it deliberately contains
  // the "high-stroke" buzzword as part of the test setup, which would
  // make findGroupForId / regex-on-the-prose checks ambiguous.
  const lines = updated.split("\n");
  const parHeaderIdx = lines.findIndex((l) => l.includes('"_groupKey": "par"'));
  const highStrokeHeaderIdx = lines.findIndex((l) => l.includes('"_groupKey": "highStroke"'));
  const insertedIdx = lines.findIndex((l) => l.includes(`"id": "${expectedId}"`));
  assert.ok(parHeaderIdx >= 0, "par header should exist");
  assert.ok(highStrokeHeaderIdx > parHeaderIdx, "high-stroke header should follow the par header");
  assert.ok(
    insertedIdx > parHeaderIdx && insertedIdx < highStrokeHeaderIdx,
    `par draft should land inside the par group (between lines ${parHeaderIdx} ` +
      `and ${highStrokeHeaderIdx}); landed at line ${insertedIdx}. ` +
      `Under the old substring matcher the par header would have been ` +
      `mis-classified as high-stroke (its prose mentions the buzzword) ` +
      `and the entry would have landed after the real high-stroke header instead.`,
  );

  // Sanity: a real high-stroke draft still routes to its own section,
  // i.e. the explicit marker isn't only avoiding the par section by
  // accident.
  const highId = computeNextId(sb.fixturePath);
  const highResult = runScript(sb, ["-", "--apply"], { input: "took 13 on hole 4" });
  assert.equal(highResult.status, 0, highResult.stderr);
  const linesAfter = readFileSync(sb.fixturePath, "utf8").split("\n");
  const highStrokeHeaderIdx2 = linesAfter.findIndex((l) =>
    l.includes('"_groupKey": "highStroke"'),
  );
  const highInsertedIdx = linesAfter.findIndex((l) => l.includes(`"id": "${highId}"`));
  assert.ok(
    highInsertedIdx > highStrokeHeaderIdx2,
    `genuine high-stroke draft should land after the high-stroke header (line ` +
      `${highStrokeHeaderIdx2}); landed at line ${highInsertedIdx}.`,
  );
});

test("section detection: a header without a _groupKey is treated as untracked (manual fallback)", (t) => {
  // A header whose prose loudly advertises itself as "Putts variants"
  // but carries no explicit `_groupKey` is now ignored by the router.
  // That's the deterministic guarantee: only the explicit marker
  // counts. Without a routable group the putts draft falls through to
  // the manual-fallback path on stderr.
  const synthetic = [
    "{",
    '  "minimumRecognitionRate": 0,',
    '  "samples": [',
    '    { "_comment": "── Putts variants (no groupKey on purpose) ──",',
    '      "id": "d001", "transcript": "two putts", "expected": { "kind": "putts", "count": 2 } }',
    "  ]",
    "}",
    "",
  ].join("\n");

  const sb = makeSandbox({ fixtureText: synthetic });
  t.after(sb.cleanup);

  const before = readFileSync(sb.fixturePath, "utf8");
  const expectedId = computeNextId(sb.fixturePath);
  const result = runScript(sb, ["-", "--apply"], { input: "three putts" });
  assert.equal(result.status, 0, result.stderr);

  assert.match(
    result.stderr,
    /no _comment group matched routing key "putts"/,
    "missing _groupKey should not be filled in by substring-matching the prose",
  );
  const after = readFileSync(sb.fixturePath, "utf8");
  assert.equal(after, before, "untracked header must leave the fixture untouched");
  assert.ok(
    !JSON.parse(after).samples.some((s) => s.id === expectedId),
    `unrouted entry ${expectedId} must not be inserted`,
  );
});

// ---------- mixed routing in one run ------------------------------------

test("multi-input: independently routes each transcript to its matching group", (t) => {
  const sb = makeSandbox();
  t.after(sb.cleanup);

  const baseId = computeNextId(sb.fixturePath);
  const result = runScript(sb, ["-", "--apply"], {
    input: ["par on 7", "two putts", "undo that"].join("\n"),
  });
  assert.equal(result.status, 0, result.stderr);

  const updated = readFileSync(sb.fixturePath, "utf8");
  JSON.parse(updated); // still valid JSON

  const groupFor = (id) => (findGroupForId(updated, id) ?? "").toLowerCase();
  assert.match(groupFor(bumpId(baseId, 0)), /par phrasings/);
  assert.match(groupFor(bumpId(baseId, 1)), /putts variants/);
  assert.match(groupFor(bumpId(baseId, 2)), /undo phrasings/);
});
