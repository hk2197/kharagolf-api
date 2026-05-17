#!/usr/bin/env node
// Turn a raw recogniser dump into a draft fixture entry for
// dogfooding-transcripts.json.
//
// Usage:
//   node anonymise.mjs <input-file>
//   node anonymise.mjs -                 # read raw transcript from stdin
//   node anonymise.mjs <input> --apply   # write directly into the fixture
//   node anonymise.mjs <input> --apply --allow-warn
//                                        # write even if WARN comments fired
//
// Input formats accepted:
//   - Plain text: each non-empty line is treated as one transcript.
//   - JSON string:  "raw transcript here"
//   - JSON array of strings: ["t1", "t2", ...]
//   - JSON array of objects with a `transcript` (or `text`) field:
//       [{ "transcript": "...", "timestamp": "...", "player": "..." }]
//   - JSON object with `transcript`/`text`, or with `transcripts`/`samples`
//     arrays of either of the above shapes.
//
// Default output (no --apply): draft fixture entries written to stdout,
// one per input transcript, ready to paste into
// dogfooding-transcripts.json. Likely PII (names, course/club
// identifiers, timestamps, IDs) is flagged in `// WARN:` comments above
// each entry — the script never silently deletes anything; the reviewer
// decides.
//
// With --apply: the entries are inserted directly into
// dogfooding-transcripts.json, slotted into the matching `_comment`
// group based on the suggested `expected.kind`, and column-aligned to
// match the surrounding rows so PR diffs stay tidy. The script refuses
// to write when *any* WARN was emitted unless --allow-warn is also
// passed.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "..", "dogfooding-transcripts.json");

// ---------- input loading -------------------------------------------------

function readInput(arg) {
  if (arg === "-" || arg === undefined) {
    return readFileSync(0, "utf8");
  }
  return readFileSync(resolve(arg), "utf8");
}

function extractRawTranscripts(input) {
  const trimmed = input.trim();
  if (!trimmed) return [];

  // Try JSON first.
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed);
      return collectFromJson(parsed);
    } catch {
      // fall through to plain-text handling
    }
  }

  // Plain text: one transcript per non-empty line.
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function collectFromJson(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectFromJson);
  if (value && typeof value === "object") {
    if (typeof value.transcript === "string") return [value.transcript];
    if (typeof value.text === "string") return [value.text];
    if (Array.isArray(value.transcripts)) return collectFromJson(value.transcripts);
    if (Array.isArray(value.samples)) return collectFromJson(value.samples);
    if (Array.isArray(value.results)) return collectFromJson(value.results);
  }
  return [];
}

// ---------- fixture inspection -------------------------------------------

function nextFreeId() {
  let raw;
  try {
    raw = readFileSync(FIXTURE_PATH, "utf8");
  } catch {
    return "d001";
  }
  const ids = [...raw.matchAll(/"id"\s*:\s*"d(\d+)"/g)].map((m) => Number(m[1]));
  const max = ids.length > 0 ? Math.max(...ids) : 0;
  return "d" + String(max + 1).padStart(3, "0");
}

// ---------- PII detection on the *raw* (pre-lowercased) transcript -------

// Common golf vocabulary that legitimately appears capitalised at the
// start of a sentence or as proper nouns we don't care about. Lower-cased
// for comparison.
const GOLF_VOCAB = new Set([
  "i", "a", "an", "the", "on", "in", "of", "for", "and", "or", "at", "to",
  "is", "it", "that", "this", "was", "were", "had", "got", "made", "took",
  "log", "logged", "score", "scored", "uh", "er", "um", "yeah", "yep",
  "okay", "ok", "alright", "nice", "easy", "just", "today", "think",
  "par", "birdie", "eagle", "bogey", "double", "triple", "ace",
  "hole", "holes", "putt", "putts", "putted", "stroke", "strokes",
  "shot", "shots", "round", "course", "tee", "fairway", "green", "rough",
  "bunker", "sand", "water", "drop", "penalty", "drive", "chip", "pitch",
  "wedge", "iron", "wood", "driver", "putter",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen",
  "knife", "tree", "fife", "ate", "won", "for", // common mishears
  "undo", "redo", "scratch", "ignore",
  "let's", "lets",
]);

export function detectWarnings(raw) {
  const warnings = [];

  // Timestamps: 12:34, 12:34:56, 12:34am/pm, ISO-ish.
  const timeRe = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?\b/i;
  if (timeRe.test(raw)) {
    warnings.push("looks like a clock/timestamp — please remove");
  }
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(raw) || /\b\d{4}\/\d{2}\/\d{2}\b/.test(raw)) {
    warnings.push("looks like a date — please remove");
  }
  if (/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?z?\b/i.test(raw)) {
    warnings.push("looks like a precise timestamp — please remove");
  }

  // UUID / device / round identifiers.
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(raw)) {
    warnings.push("looks like a UUID — please remove");
  }
  if (/\b(?:round|device|user|player)[\s_-]?id[:=]?\s*\S+/i.test(raw)) {
    warnings.push("looks like a round/device/user id — please remove");
  }

  // ALL-CAPS or mixed-case tokens that look like course/club codes
  // (e.g. KHARAGOLF, AC123, GC-7). These are almost never legitimate
  // transcript content.
  const codeMatches = [...raw.matchAll(/\b[A-Z]{2,}[A-Z0-9_-]*\b/g)].map((m) => m[0]);
  if (codeMatches.length > 0) {
    warnings.push(
      `possible course/club identifier(s): ${[...new Set(codeMatches)].join(", ")} — please scrub`,
    );
  }

  // Capitalised words anywhere in the transcript that aren't common
  // golf vocab — likely player/caddie/course names. We don't try to
  // be clever with sentence-initial capitalisation; capitalisation in
  // a recogniser dump is meaningful and worth a glance.
  const nameCandidates = [];
  for (const match of raw.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    const word = match[0];
    if (!GOLF_VOCAB.has(word.toLowerCase())) nameCandidates.push(word);
  }
  if (nameCandidates.length > 0) {
    warnings.push(
      `possible name(s): ${[...new Set(nameCandidates)].join(", ")} — replace with 'partner' or remove`,
    );
  }

  // Course / club mentions by keyword.
  if (/\b(?:course|club|country club|golf club|cc|gc)\b/i.test(raw)) {
    warnings.push("mentions course/club — drop hole/course names (hole numbers are fine)");
  }

  return warnings;
}

// ---------- minimal cleanup -----------------------------------------------

function cleanTranscript(raw) {
  let out = raw;
  // Drop leading "[hh:mm] " or "(hh:mm:ss) " prefixes some recognisers add.
  out = out.replace(/^\s*[\[(]\s*\d{1,2}:\d{2}(?::\d{2})?\s*[\])]\s*/u, "");
  // Collapse whitespace and lowercase per the README's step 1.
  out = out.replace(/\s+/g, " ").trim().toLowerCase();
  return out;
}

// ---------- best-effort `expected` shape suggestion ----------------------

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// Spelled-out high-stroke number words the parser already understands
// (eleven–fifteen). Real dogfooding utterances ("twelve on the par
// five", "fifteen on the par four") never include a digit for these
// counts, so the detector needs to trigger on the word alone.
const HIGH_NUMBER_WORDS = {
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
};

// Recogniser homophones that real dogfooding rounds keep producing in
// place of digits — see the existing Mishears group in
// dogfooding-transcripts.json for the canonical examples.
const HOMOPHONES = {
  for: 4, to: 2, tree: 3, fife: 5, ate: 8, knife: 9, won: 1,
};

// Verbs/phrasings that, when combined with a spelled or homophone
// number elsewhere in the utterance, signal a score utterance rather
// than banter. Mirrors the verbs the parser's payload regex tolerates
// plus the everyday verbs ("got", "had", "made", "gave") that show up
// in dogfooding transcripts ("got a fife", "had ate", "made knife").
const SCORE_VERB_RE =
  /\b(?:log|logged|score|scored|took|taken|shoot|shot|carded|made|got|had|gave|give|gives|made it|give me|make it)\b/;

// Phrasings the parser treats as a stroke-correction marker. A single
// utterance like "make it a six instead" or "actually six" should
// land in the Single-utterance stroke corrections group with the
// `correction: true` flag set.
function isCorrectionMarker(t) {
  return /\bscratch that\b/.test(t)
      || /\bmake it\b/.test(t)
      || /\binstead\b/.test(t)
      || /\bactually\b/.test(t);
}

// Hole-number tokens accepted by `parseHoleCorrection` — digits 1–18,
// the standard English number words, plus the recogniser mishears
// ("tin" → 10, "leaven"/"elven" → 11) the parser already tolerates.
// Mirrors the equivalent map in
// ios-watch-extension/KHARAGOLFWatch/VoiceScoreEntry.swift so the
// suggester accepts every form the runtime parser does.
const HOLE_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, tin: 10, eleven: 11, leaven: 11, elven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18,
};

const HOLE_PART = "(\\d{1,2}|seventeen|sixteen|fifteen|fourteen|thirteen|" +
  "eighteen|eleven|twelve|leaven|elven|seven|eight|nine|three|four|" +
  "five|six|ten|tin|one|two)";

const HOLE_CORRECTION_PATTERNS = [
  new RegExp("^\\s*(?:change|fix|make)\\s+hole\\s+" + HOLE_PART +
    "\\s+(?:to\\s+)?(?:a\\s+)?(.+?)\\s*$", "i"),
  new RegExp("^\\s*hole\\s+" + HOLE_PART +
    "\\s+should\\s+be\\s+(?:a\\s+)?(.+?)\\s*$", "i"),
];

function parseHoleWord(w) {
  const n = Number(w);
  if (Number.isInteger(n) && n >= 1 && n <= 18) return n;
  return HOLE_WORDS[w.toLowerCase()] ?? null;
}

// Detects "change hole N to <value>", "fix hole N to <value>",
// "make hole N <value>", and "hole N should be <value>" phrasings —
// mirrors the Swift `parseHoleCorrection` so the suggester can route
// these straight into the Hole-targeted corrections group instead of
// leaving the contributor to move them by hand. Returns the parsed
// hole and the raw value substring; the caller re-parses the value
// through the normal payload pipeline.
function parseHoleCorrection(t) {
  for (const re of HOLE_CORRECTION_PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    const hole = parseHoleWord(m[1]);
    if (hole === null) continue;
    const value = m[2].trim();
    if (!value) continue;
    return { hole, valueText: value };
  }
  return null;
}

// Re-runs the hole-correction patterns to determine *how* the hole
// number was spoken — as a digit ("change hole 7 to a five") or as a
// word ("change hole seven to a five", "fix hole tin to a bogey").
// The dogfooding corpus splits Hole-targeted corrections into two
// sub-groups by editorial convention, so the router uses this to keep
// digit-form and worded-form entries in their own buckets instead of
// dumping every newly-routed correction into the last sub-group in
// the file. Returns "digit", "word", or null if no correction
// pattern matches.
function holeCorrectionForm(cleaned) {
  if (typeof cleaned !== "string" || !cleaned) return null;
  for (const re of HOLE_CORRECTION_PATTERNS) {
    const m = cleaned.match(re);
    if (!m) continue;
    return /^\d+$/.test(m[1]) ? "digit" : "word";
  }
  return null;
}

// Common undo phrasings the suggester recognises. Kept narrow on
// purpose: extra synonyms ("knock that off", "disregard that", ...)
// also appear in the corpus but were added by hand, so the suggester
// only auto-routes the unambiguous wordings.
const UNDO_PHRASE_RE = /\bundo\b|\bscratch that\b|\bignore that\b|\bnever mind\b/;

function homophoneNumber(t) {
  for (const [word, n] of Object.entries(HOMOPHONES)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return n;
  }
  return null;
}

function suggestExpected(transcript) {
  const t = transcript;

  // Hole-targeted corrections ("change hole 7 to a five", "fix hole 9
  // to 4", "hole 12 should be a bogey") take priority. The runtime
  // parser special-cases these via `parseHoleCorrection` and emits a
  // Score / Relative carrying the explicit hole AND `correction:
  // true`. Detecting them here lets --apply auto-route the entry into
  // the Hole-targeted corrections group instead of leaving it for the
  // contributor to move by hand. The literal "to" (which homophone
  // normalisation would otherwise rewrite to "two") is matched on the
  // raw cleaned transcript before any number-word substitution kicks
  // in, mirroring the Swift parser's ordering.
  const holeCorrection = parseHoleCorrection(t);
  if (holeCorrection) {
    const { hole, valueText } = holeCorrection;
    const payload = detectPayload(valueText, valueText, null, true);
    if (payload.kind !== "none") {
      payload.hole = hole;
      payload.correction = true;
      return payload;
    }
    // Bare-digit values (e.g. "fix hole 9 to 4") don't trip
    // detectPayload's score-verb / strokes-suffix guards because the
    // value substring is just the digit, so handle that one fallback
    // here so the entry still routes correctly.
    const digit = valueText.match(/\b(\d{1,2})\b/);
    if (digit) {
      const n = Number(digit[1]);
      if (n >= 1 && n <= 15) {
        return { kind: "score", hole, strokes: n, correction: true };
      }
    }
    return { kind: "none" };
  }

  const correction = isCorrectionMarker(t);
  const holeMatch = t.match(/(?:^|\s)(?:on|hole)\s+(\d{1,2})\b/);
  const hole = holeMatch ? clampHole(Number(holeMatch[1])) : null;
  // Strip the "on N" hole suffix when looking for the score/putt count
  // so "took 6 on 3" reads strokes=6, not strokes=3.
  const tNoHole = t.replace(/\b(?:on|hole)\s+\d{1,2}\b/g, " ");

  // Bare undo phrasings. Skip when a correction marker is also present
  // ("scratch that, six" should parse as a Score correction, not undo)
  // — we revisit the undo fallback at the bottom if no payload matched.
  if (!correction && UNDO_PHRASE_RE.test(t)) {
    return { kind: "undo" };
  }

  const payload = detectPayload(t, tNoHole, hole, correction);
  if (payload.kind !== "none") {
    if (correction) payload.correction = true;
    return payload;
  }

  // Correction marker fired but nothing parseable followed
  // ("scratch that" on its own, "actually never mind"): fall back to
  // undo so the entry still routes somewhere sensible instead of
  // silently landing in Side-chatter.
  if (correction && UNDO_PHRASE_RE.test(t)) {
    return { kind: "undo" };
  }

  return { kind: "none" };
}

function detectPayload(t, tNoHole, hole, correction) {
  if (/\bputt(?:s|ed)?\b/.test(t)) {
    return { kind: "putts", count: extractCount(tNoHole) ?? 0 };
  }
  // Albatross / "double eagle" → 3-under. Checked before the plain
  // `eagle` rule so "double eagle on 16" isn't swallowed as an eagle.
  if (/\balbatross\b/.test(t) || /\bdouble\s+eagle\b/.test(t)) {
    return { kind: "relative", hole, delta: -3 };
  }
  // Spelled-out high-stroke numbers (eleven–fifteen). Treated as a
  // standalone signal — utterances like "twelve on the par five"
  // describe the hole's par, not a relative-to-par score, so the
  // absolute number must take precedence over the par/eagle branches
  // below (mirrors the parser's ordering).
  const highMatch = tNoHole.match(/\b(eleven|twelve|thirteen|fourteen|fifteen)\b/);
  if (highMatch) {
    return { kind: "score", hole, strokes: HIGH_NUMBER_WORDS[highMatch[1]] };
  }
  if (/\bhole in one\b|\bace\b/.test(t)) {
    return { kind: "score", hole, strokes: 1 };
  }
  if (/\beagle\b/.test(t)) return { kind: "relative", hole, delta: -2 };
  if (/\bbirdie\b/.test(t)) return { kind: "relative", hole, delta: -1 };
  if (/\btriple\s+bogey\b/.test(t)) return { kind: "relative", hole, delta: 3 };
  if (/\bdouble\s+bogey\b/.test(t)) return { kind: "relative", hole, delta: 2 };
  if (/\bbogey\b/.test(t)) return { kind: "relative", hole, delta: 1 };
  if (/\bpar\b/.test(t)) return { kind: "relative", hole, delta: 0 };
  if (/\b\d{1,2}\s*strokes?\b/.test(t) || /\b(?:log|score|took|scored|logged|shot)\s+\d{1,2}\b/.test(t)) {
    return { kind: "score", hole, strokes: extractCount(tNoHole) ?? 0 };
  }
  // Spelled-out one–ten, but only when the surrounding utterance reads
  // like a score ("shot four", "took five") or a single-utterance
  // correction ("actually six", "make it a six instead"). Without that
  // guard the detector would also fire on banter like "we drank four
  // beers".
  const lowMatch = tNoHole.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (lowMatch && (correction || SCORE_VERB_RE.test(t))) {
    return { kind: "score", hole, strokes: NUMBER_WORDS[lowMatch[1]] };
  }
  // Mishear fallback: a homophone digit is present and the surrounding
  // text looks like a score utterance (has a hole suffix, a scoring
  // verb, a correction marker, or is just the homophone on its own).
  // Without this guard the detector would also fire on banter like
  // "we won by two strokes".
  const homo = homophoneNumber(tNoHole);
  if (homo !== null) {
    const homoOnly = /^\s*\w+\s*$/.test(t);
    const looksLikeScore =
      hole !== null || correction || SCORE_VERB_RE.test(t);
    if (homoOnly || looksLikeScore) {
      return { kind: "score", hole, strokes: homo };
    }
  }
  return { kind: "none" };
}

function extractCount(t) {
  const digit = t.match(/\b(\d{1,2})\b/);
  if (digit) return Number(digit[1]);
  for (const [word, n] of Object.entries(HIGH_NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return n;
  }
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return n;
  }
  for (const [word, n] of Object.entries(HOMOPHONES)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return n;
  }
  return null;
}

function clampHole(n) {
  return n >= 1 && n <= 18 ? n : null;
}

// ---------- formatting ----------------------------------------------------

function formatExpected(expected) {
  // Inline JSON so it visually matches the existing fixture entries.
  const parts = [`"kind": ${JSON.stringify(expected.kind)}`];
  if ("hole" in expected) parts.push(`"hole": ${expected.hole === null ? "null" : expected.hole}`);
  if ("strokes" in expected) parts.push(`"strokes": ${expected.strokes}`);
  if ("delta" in expected) parts.push(`"delta": ${expected.delta}`);
  if ("count" in expected) parts.push(`"count": ${expected.count}`);
  if (expected.correction === true) parts.push(`"correction": true`);
  return `{ ${parts.join(", ")} }`;
}

function formatEntry(id, transcript, expected, warnings) {
  const lines = [];
  for (const w of warnings) lines.push(`// WARN: ${w}`);
  lines.push(
    `{ "id": "${id}", "transcript": ${JSON.stringify(transcript)}, "expected": ${formatExpected(expected)} },`,
  );
  return lines.join("\n");
}

// ---------- group routing for --apply mode -------------------------------

// The set of routing keys recognised by --apply. Each `_comment`
// sub-group header in dogfooding-transcripts.json declares which key
// it owns via an explicit `"_groupKey": "<key>"` field on the same
// JSON line, e.g.
//
//   { "_comment": "── Putts variants ──", "_groupKey": "putts",
//     "id": "d039", "transcript": "four putts", ... },
//
// We used to fish the key out of the comment text via substring
// matching ("birdie / eagle", "high-stroke", ...) but that turned
// section detection into a prose minefield: any unrelated header
// whose description happened to mention another section's keyword
// got mis-identified, silently routed entries into the wrong group,
// and produced invalid JSON the next time --apply ran. The explicit
// marker makes the routing deterministic and frees contributors to
// describe each section in whatever wording reads best.
//
// Hole-targeted corrections are split into two sub-groups by
// editorial convention: one for digit-spoken holes ("change hole 7
// to a five") and one for worded-spoken holes ("change hole seven to
// a five", including the "tin"/"leaven"/"elven" mishears). Each
// sub-group declares its own key (`holeTargetedCorrectionDigit` or
// `holeTargetedCorrectionWord`) and `pickGroupKey` chooses between
// them based on whether the cleaned transcript uses a digit or a
// word for the hole token, so the two buckets stay separate instead
// of collapsing onto whichever sub-group comes last in the file.
const GROUP_KEYS = new Set([
  "putts",
  "birdieEagle",
  "par",
  "bogey",
  "ace",
  "absoluteStrokes",
  "mishears",
  "undo",
  "sideChatter",
  "highStroke",
  "singleUtteranceCorrection",
  "holeTargetedCorrectionDigit",
  "holeTargetedCorrectionWord",
]);

function pickGroupKey(expected, cleaned) {
  if (!expected || typeof expected !== "object") return null;
  // Correction entries split by whether the contributor named an
  // explicit older hole. Single-utterance corrections ("actually six",
  // "make it a six instead", "scratch that, six") leave `hole` as
  // null and route to the Single-utterance group; hole-targeted
  // corrections ("change hole 7 to a five", "fix hole 9 to 4",
  // "hole 12 should be a bogey") carry an explicit hole and route to
  // the Hole-targeted corrections group instead. Both groups accept
  // either Score or Relative payloads so the kind doesn't influence
  // the routing.
  //
  // The Hole-targeted bucket is itself split by editorial convention
  // into a digit-form sub-group ("change hole 7 to a five") and a
  // worded-form sub-group ("change hole seven to a five",
  // "fix hole tin to a bogey"). We re-detect the form from the
  // cleaned transcript so each entry lands in the matching sub-group
  // automatically — without this split the last-header-wins behaviour
  // in `findGroupInsertionPoints` would dump every newly-routed entry
  // into whichever sub-group happens to come last in the file.
  if (expected.correction === true) {
    if (expected.hole === null || expected.hole === undefined) {
      return "singleUtteranceCorrection";
    }
    return holeCorrectionForm(cleaned) === "word"
      ? "holeTargetedCorrectionWord"
      : "holeTargetedCorrectionDigit";
  }
  switch (expected.kind) {
    case "undo":
      return "undo";
    case "none":
      return "sideChatter";
    case "putts":
      return "putts";
    case "score":
      // A score whose digit was *actually supplied* by a recogniser
      // homophone ("won on hole 3", "tree on hole 5") belongs in
      // Mishears. We only treat it as homophone-sourced when there's
      // no digit or number-word elsewhere in the transcript that
      // could have been the real source — otherwise an utterance like
      // "took 4 strokes for that one" would be misrouted just because
      // "for" appears in it.
      if (cleaned && isHomophoneSourcedScore(cleaned)) return "mishears";
      if (expected.strokes === 1) return "ace";
      if (typeof expected.strokes === "number" && expected.strokes >= 11) return "highStroke";
      return "absoluteStrokes";
    case "relative":
      if (expected.delta === -3) return "highStroke";
      if (expected.delta === -1 || expected.delta === -2) return "birdieEagle";
      if (expected.delta === 0) return "par";
      if (typeof expected.delta === "number" && expected.delta >= 1) return "bogey";
      return null;
    default:
      return null;
  }
}

function isHomophoneSourcedScore(cleaned) {
  // Strip the hole suffix first so the hole number doesn't count as
  // the strokes source.
  const tNoHole = cleaned.replace(/\b(?:on|hole)\s+\d{1,2}\b/g, " ");
  // A literal digit or spelled-out number means the strokes value
  // came from there, not from a homophone.
  if (/\b\d{1,2}\b/.test(tNoHole)) return false;
  for (const word of Object.keys(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(tNoHole)) return false;
  }
  for (const word of Object.keys(HIGH_NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(tNoHole)) return false;
  }
  return homophoneNumber(tNoHole) !== null;
}

// ---------- fixture text manipulation for --apply ------------------------

// Returns the column at which `"expected":` appears in the existing
// fixture. We pick the most common column so an entry with an unusually
// long transcript can't skew the alignment for the whole group.
function detectExpectedColumn(text) {
  const counts = new Map();
  for (const line of text.split("\n")) {
    const idx = line.indexOf('"expected":');
    if (idx > 0 && /"id"\s*:/.test(line)) {
      counts.set(idx, (counts.get(idx) ?? 0) + 1);
    }
  }
  let best = 65; // sensible default matching the current corpus
  let bestCount = 0;
  for (const [col, count] of counts) {
    if (count > bestCount) {
      best = col;
      bestCount = count;
    }
  }
  return best;
}

// Walk the fixture line by line and find the index of the last entry
// inside each named sub-group (the ones whose `_comment` line contains
// `── ... ──`). We need the *last* entry so new rows append in order.
function findGroupInsertionPoints(lines) {
  const groups = new Map(); // groupKey -> { headerIndex, lastEntryIndex }
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isSubGroupHeader = line.includes('"_comment"') && line.includes("──");
    if (isSubGroupHeader) {
      if (current) groups.set(current.key, current);
      const key = matchGroupKey(line);
      // The first entry of the group sits on the very next line (the
      // `_comment` line shares its `{` with the entry that follows).
      current = key
        ? { key, headerIndex: i, lastEntryIndex: i + 1 }
        : null;
      continue;
    }
    if (current && /^\s*\{\s*"id"\s*:/.test(line)) {
      current.lastEntryIndex = i;
    }
    // The `]` line closes the samples array; flush the in-flight group.
    if (current && /^\s*\]\s*$/.test(line)) {
      groups.set(current.key, current);
      current = null;
    }
  }
  if (current) groups.set(current.key, current);
  return groups;
}

function matchGroupKey(headerLine) {
  // Pull the explicit `_groupKey` field off the header line. We
  // deliberately do NOT fall back to substring-matching the comment
  // text — see the GROUP_KEYS doc-comment for why. Unknown keys (typos
  // in the fixture) return null so the group is treated as untracked
  // rather than being silently mis-routed.
  const m = headerLine.match(/"_groupKey"\s*:\s*"([^"]+)"/);
  if (!m) return null;
  const key = m[1];
  return GROUP_KEYS.has(key) ? key : null;
}

function buildEntryLine(id, transcript, expected, expectedCol) {
  const prefix = `    { "id": "${id}", "transcript": ${JSON.stringify(transcript)},`;
  const padding = Math.max(1, expectedCol - prefix.length);
  return `${prefix}${" ".repeat(padding)}"expected": ${formatExpected(expected)} },`;
}

// Insert prepared entry lines into the file text. Insertions are grouped
// by target group and applied bottom-up so earlier indices remain valid.
function applyInsertions(originalText, insertions) {
  const lines = originalText.split("\n");
  const groups = findGroupInsertionPoints(lines);

  // Sort groups by their insertion line, descending, so splicing earlier
  // groups doesn't shift the indices of later ones.
  const ordered = [...insertions.entries()]
    .map(([key, rows]) => {
      const group = groups.get(key);
      return group ? { key, rows, lastEntryIndex: group.lastEntryIndex } : null;
    })
    .filter((x) => x !== null)
    .sort((a, b) => b.lastEntryIndex - a.lastEntryIndex);

  for (const { rows, lastEntryIndex } of ordered) {
    lines.splice(lastEntryIndex + 1, 0, ...rows);
  }

  return { text: lines.join("\n"), placedKeys: new Set(ordered.map((x) => x.key)) };
}

// ---------- main ----------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stderr.write(
      "usage: node anonymise.mjs <input-file|-> [--apply [--allow-warn]]\n" +
        "  Reads a raw recogniser dump (text or JSON) and prints draft\n" +
        "  fixture entries to stdout. Likely PII is flagged via WARN\n" +
        "  comments — nothing is silently rewritten.\n" +
        "\n" +
        "  --apply       insert the entries into dogfooding-transcripts.json\n" +
        "                directly, into the `_comment` group matching each\n" +
        "                suggested expected.kind. Refuses to write if any\n" +
        "                WARN was emitted.\n" +
        "  --allow-warn  paired with --apply, write anyway. Use only after\n" +
        "                eyeballing every WARN line in the dry-run output.\n" +
        "\n" +
        "  See README.md for the anonymisation rubric.\n",
    );
    process.exit(0);
  }

  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const applyMode = flags.has("--apply");
  const allowWarn = flags.has("--allow-warn");

  if (allowWarn && !applyMode) {
    process.stderr.write("--allow-warn only makes sense together with --apply\n");
    process.exit(2);
  }

  const raw = readInput(positional[0]);
  const transcripts = extractRawTranscripts(raw);
  if (transcripts.length === 0) {
    process.stderr.write("no transcripts found in input\n");
    process.exit(1);
  }

  let nextNum = Number(nextFreeId().slice(1));
  const drafts = [];
  let totalWarnings = 0;

  for (const rawTranscript of transcripts) {
    const id = "d" + String(nextNum++).padStart(3, "0");
    const warnings = detectWarnings(rawTranscript);
    totalWarnings += warnings.length;
    const cleaned = cleanTranscript(rawTranscript);
    const expected = suggestExpected(cleaned);
    drafts.push({ id, cleaned, expected, warnings });
  }

  if (!applyMode) {
    const out = drafts.map((d) =>
      formatEntry(d.id, d.cleaned, d.expected, d.warnings),
    );
    process.stdout.write(out.join("\n") + "\n");
    process.stderr.write(
      `\n${drafts.length} draft entr${drafts.length === 1 ? "y" : "ies"} written` +
        (totalWarnings > 0
          ? `; ${totalWarnings} PII warning${totalWarnings === 1 ? "" : "s"} flagged — review the WARN comments before pasting.\n`
          : `; no PII warnings — still review by eye before pasting.\n`) +
        `Re-run with --apply to insert directly into dogfooding-transcripts.json.\n`,
    );
    return;
  }

  // --apply path -----------------------------------------------------------

  if (totalWarnings > 0 && !allowWarn) {
    // Surface the same WARN preview the dry-run mode shows so the
    // contributor knows exactly what tripped the refusal.
    const preview = drafts.map((d) =>
      formatEntry(d.id, d.cleaned, d.expected, d.warnings),
    );
    process.stdout.write(preview.join("\n") + "\n");
    process.stderr.write(
      `\nrefusing to --apply: ${totalWarnings} PII warning${totalWarnings === 1 ? "" : "s"} flagged above.\n` +
        `Hand-clean the transcripts and re-run, or pass --allow-warn if you ` +
        `have already verified each WARN line is a false positive.\n`,
    );
    process.exit(1);
  }

  const fixtureText = readFileSync(FIXTURE_PATH, "utf8");
  const expectedCol = detectExpectedColumn(fixtureText);

  const insertions = new Map(); // groupKey -> string[] (entry lines)
  const skipped = []; // drafts we couldn't auto-route
  for (const d of drafts) {
    const key = pickGroupKey(d.expected, d.cleaned);
    if (!key) {
      skipped.push(d);
      continue;
    }
    const line = buildEntryLine(d.id, d.cleaned, d.expected, expectedCol);
    if (!insertions.has(key)) insertions.set(key, []);
    insertions.get(key).push(line);
  }

  const { text: nextText, placedKeys } = applyInsertions(fixtureText, insertions);

  // Anything we tried to insert but couldn't because the matching group
  // was missing from the file is a router miss — surface it loudly so
  // the contributor still gets the draft and can paste it manually.
  for (const [key, rows] of insertions) {
    if (!placedKeys.has(key)) {
      skipped.push(
        ...rows.map((row) => ({
          rendered: row,
          reason: `no _comment group matched routing key "${key}"`,
        })),
      );
    }
  }
  // Each entry in `skipped` corresponds to exactly one input draft —
  // either a draft with no routable kind, or a single rendered line
  // whose target group was missing from the file.

  // Sanity check: the result must still be valid JSON. Bail out without
  // touching the file if our insertion produced garbage — far better to
  // fail loudly than to corrupt the corpus.
  try {
    JSON.parse(nextText);
  } catch (err) {
    process.stderr.write(
      `aborting --apply: edited fixture would not parse as JSON (${err.message}). ` +
        `Original file left untouched.\n`,
    );
    process.exit(1);
  }

  writeFileSync(FIXTURE_PATH, nextText);

  const placedCount = drafts.length - skipped.length;
  process.stderr.write(
    `inserted ${placedCount} entr${placedCount === 1 ? "y" : "ies"} into ` +
      `dogfooding-transcripts.json` +
      (totalWarnings > 0
        ? ` (${totalWarnings} WARN${totalWarnings === 1 ? "" : "s"} bypassed via --allow-warn)`
        : "") +
      `.\n`,
  );
  if (skipped.length > 0) {
    process.stderr.write(
      `\n${skipped.length} entr${skipped.length === 1 ? "y" : "ies"} could not be auto-routed — ` +
        `paste manually:\n`,
    );
    for (const s of skipped) {
      if ("rendered" in s) {
        process.stderr.write(`  // ${s.reason}\n  ${s.rendered}\n`);
      } else {
        process.stderr.write(
          `  // suggested expected.kind=${JSON.stringify(s.expected.kind)} has no matching group — review by hand\n` +
            `  ${formatEntry(s.id, s.cleaned, s.expected, [])}\n`,
        );
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
