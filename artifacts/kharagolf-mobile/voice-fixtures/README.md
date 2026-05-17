# Voice fixtures — dogfooding transcripts

`dogfooding-transcripts.json` is a corpus of anonymised voice transcripts
captured during real KHARAGOLF dogfooding rounds. Both the iOS watch and
Wear OS modules read this same file from their unit-test harnesses
(`VoiceScoreEntryDogfoodingHarnessTests.swift` and
`VoiceScoreEntryDogfoodingHarnessTest.kt`). Each transcript is replayed
through `VoiceScoreEntry.parse(...)` and the harness fails the build if
the overall recognition rate drops below `minimumRecognitionRate`.

The corpus is the only source of truth for what we consider an
acceptable recognition baseline, so keeping it healthy and growing it
from real rounds is part of the regular dogfooding feedback loop.

## When to add a new transcript

Add a sample whenever you notice an utterance during a dogfooding round
that is interesting for the parser, including:

- A new phrasing that the parser already handles correctly — adds
  coverage and prevents future regressions.
- A mishear from the speech recogniser (e.g. `for` instead of `four`,
  `tree` instead of `three`) — verifies the homophone normaliser keeps
  doing its job.
- A phrase the parser currently *misses* — see "Capturing parser gaps"
  below. Honestly recording these keeps the recognition rate truthful.
- Side-chatter / banter that should *not* be recognised as a score —
  recorded with `kind: "none"` so we notice if the parser starts picking
  these up by accident.

If the transcript is a near-duplicate of something already in the
fixture (same phrasing, same hole shape), skip it. Aim for variety.

## Anonymising a transcript

For anything more than a one-line tweak, use the helper script — it
does the mechanical cleanup for you and flags likely PII so you don't
ship it accidentally:

```
node scripts/anonymise.mjs <raw-recogniser-dump>
# or pipe via stdin
pbpaste | node scripts/anonymise.mjs -
```

The script accepts plain text (one transcript per line) or JSON (a
string, an array of strings, or objects with a `transcript`/`text`
field). It prints draft fixture entries to stdout with:

- the transcript lower-cased and stripped of leading `[hh:mm]`-style
  timestamps,
- the next free `id` (auto-incremented from the highest `dNNN`
  already in `dogfooding-transcripts.json`),
- a best-effort `expected` shape based on keywords in the transcript
  (always re-check the numbers — `count`/`strokes` default to `0`
  when the script can't figure them out),
- `// WARN:` comments above any entry where the input still looks
  like it contains names, course/club codes, timestamps, or device/
  round IDs. The script never silently rewrites these — you decide
  what to do with each one.

Skim the warnings, hand-fix the transcript and `expected` shape, then
paste the entry into the matching `_comment` group in
`dogfooding-transcripts.json`. Edit the JSON by hand only when you're
making a tiny tweak to an existing entry.

### Letting the script do the paste (`--apply`)

Once the dry-run output looks clean, re-run with `--apply` to insert
the entries directly into `dogfooding-transcripts.json`:

```
pbpaste | node scripts/anonymise.mjs - --apply
```

The script picks the matching `_comment` group from each entry's
suggested `expected` shape (Putts, Birdie / eagle, Par, Bogey,
Hole-in-one, Absolute strokes, Mishears for homophone-derived digits
like `"won on hole 3"` / `"tree on hole 5"` / `"got a fife"`, Undo,
Side-chatter, High-stroke for `albatross` / `double eagle` and the
spelled-out 11–15 stroke counts, Single-utterance stroke corrections
for `"actually six"` / `"make it a six instead"` / `"scratch that,
six"`, and Hole-targeted corrections — split into a digit-form
sub-group for `"change hole 7 to a five"` / `"fix hole 9 to 4"` /
`"hole 12 should be a bogey"` and a worded-form sub-group for
`"change hole seven to a five"` / `"fix hole eleven to four"` /
`"fix hole tin to a bogey"`, picked based on whether the cleaned
transcript uses a digit or a word for the hole token), appends the
row to the bottom of that group, and pads the columns so
`"expected":` lines up with the surrounding rows. Multi-input runs
route each entry independently, so a mixed dump slots into several
groups in one shot.

Safety rails:

- `--apply` **refuses to write** if any `// WARN:` was emitted. Clean
  the transcripts and re-run, or pass `--allow-warn` once you have
  eyeballed every WARN line and confirmed it's a false positive.
- If the suggested `expected` shape doesn't map cleanly to a group,
  the script prints the rendered entry to stderr and leaves it for
  you to paste manually — the corpus stays valid JSON either way.

The checklist below is what the script encodes — use it as the rubric
when reviewing the script's output, or when editing the JSON directly.
Captured transcripts may contain PII or course-identifying details.

1. **Lower-case everything.** The parser lower-cases input internally,
   so the fixture stores transcripts pre-lowered for readability.
2. **Strip names.** Replace any player, caddie, or guest name with a
   generic substitute like `partner`, `man`, or just delete the
   reference. Example:
   - Captured: `"nice birdie sarah on 5"`
   - Anonymised: `"nice birdie on 5"` (or `"nice birdie partner"` if
     the name shape matters for testing).
3. **Strip course / club identifiers.** Drop hole names, course names,
   and club names. Hole *numbers* are fine and important.
4. **Keep filler words.** `"uh"`, `"er"`, `"yeah"`, `"alright"`,
   `"i think"` are valuable — they reflect how people actually speak
   on the course and the parser must tolerate them.
5. **Keep mishears verbatim.** If the recogniser returned `"knife on
   hole 6"` when the player said `"nine on hole 6"`, store the
   *transcript as the recogniser produced it* (`"knife on hole 6"`).
   That's exactly what the parser will be fed at runtime.
6. **Drop any timestamps, round IDs, or device identifiers** that may
   have come along for the ride.

When in doubt, err toward stripping detail — these samples are checked
into source control and shipped with the test bundles.

## CI: PII regression check

Every PR that touches anything under `voice-fixtures/` (and every push
to `main`) runs the **Voice fixtures PII check** GitHub Actions job
defined in
[`.github/workflows/voice-fixtures-pii.yml`](../../../.github/workflows/voice-fixtures-pii.yml).
The job is a single step — `node artifacts/kharagolf-mobile/voice-fixtures/scripts/lint-fixture.mjs`,
run from the repo root — that re-runs the same heuristics from `scripts/anonymise.mjs` over
every transcript already committed to `dogfooding-transcripts.json`. A
hand-edit (or a tightening of the heuristics in `anonymise.mjs`) that
would slip fresh PII into the corpus is a **required check failure**:
the merge is blocked until the offending entries are scrubbed.

You can find the status of the most recent runs (and the badge URL)
under the repository's **Actions → Voice fixtures PII check** tab on
GitHub. When a PR fails the check, the job log shows the offending
sample id, transcript, and matching `WARN:` reasons inline — that is
the script's normal stderr output, surfaced verbatim by Actions, so
no extra log-spelunking is needed.

To run the same check locally before pushing:

```
# from this directory
node scripts/lint-fixture.mjs

# or, from artifacts/kharagolf-mobile
pnpm voice-fixtures:lint-pii
```

The script exits non-zero and prints the offending sample id,
transcript, and matching `WARN:` reasons whenever any committed
transcript would have produced a warning if it were freshly
anonymised. If your PR fails this check, run it locally, scrub the
flagged entries the same way you would a fresh sample, and re-run
until it reports `clean — no PII warnings.`. No install step is
required (Node ESM only — that is exactly why CI runs the script
directly with `node`, no pnpm install).

## CI: anonymise.mjs unit tests

The same workflow also runs `scripts/anonymise.test.mjs` — an
end-to-end test suite that exercises each routing branch (Putts,
Birdie / eagle, Par, Bogey, Hole-in-one, Absolute strokes, Mishears,
Undo, Side-chatter, Single-utterance and Hole-targeted corrections),
the column-alignment logic, the JSON validity guard around `--apply`,
the `WARN`-refusal vs `--allow-warn` behaviour, the `dNNN` ID
auto-increment, and the manual-fallback path when a routing key has
no matching `_comment` group. Every test sandboxes its own temp copy
of `dogfooding-transcripts.json`, so the real corpus is never
touched.

Alongside it, `scripts/anonymise.input-formats.test.mjs` covers each
of the six documented input shapes end-to-end — plain text, a JSON
string, a JSON array of strings, a JSON array of objects with a
`transcript`/`text` field, a JSON object with `transcript`/`text`,
and a JSON envelope whose `transcripts`/`samples`/`results` array
contains either of the above shapes — plus the malformed-JSON
fallback (a string that starts with `{`/`[`/`"` but isn't valid JSON
falls through to plain-text handling). It feeds the same canonical
set of transcripts through every envelope and asserts the rendered
draft entries come out identical, so a regression in
`extractRawTranscripts` / `collectFromJson` is caught before the next
recogniser-dump paste.

Run locally:

```
# from this directory
node --test scripts/anonymise.test.mjs scripts/anonymise.input-formats.test.mjs

# or, from artifacts/kharagolf-mobile
pnpm voice-fixtures:test
```

Like the PII lint, this runs with plain `node` — no install step.

## Adding the entry

1. Pick the next free `id` in the `samples` array. The convention is
   `dNNN` zero-padded (`d109`, `d110`, ...). IDs only need to be
   unique; ordering is otherwise unimportant.
2. Group your sample with similar ones by inserting it inside the
   matching `_comment` block (Putts variants, Birdie / eagle, Par,
   Bogey, Hole-in-one, Absolute strokes, Mishears, Undo, Side-chatter,
   or Known parser gaps).
3. Pick the `expected` shape based on what the parser *should* return
   for the transcript:

   | `kind`       | Required fields                  | Used when                                                  |
   | ------------ | -------------------------------- | ---------------------------------------------------------- |
   | `"score"`    | `hole` (or `null`), `strokes`    | An absolute stroke count (`"5 strokes"`, `"log 6 on 4"`)   |
   | `"relative"` | `hole` (or `null`), `delta`      | Par-relative (`birdie=-1`, `par=0`, `bogey=1`, `eagle=-2`) |
   | `"putts"`    | `count`                          | Putts on the previous shot (`"two putts"`)                 |
   | `"undo"`     | (none)                           | Anything the parser should treat as undo                   |
   | `"none"`     | (none)                           | Side-chatter / gibberish that must NOT parse               |

   `hole` is the hole number 1–18 if mentioned in the transcript via
   `"on N"` or `"hole N"`, otherwise `null`. `delta` is signed:
   eagle `-2`, birdie `-1`, par `0`, bogey `+1`, double bogey `+2`,
   triple bogey `+3`.

4. If you're unsure what the parser will currently return, run the
   harness locally — see "Reviewing the recognition rate" below — and
   read the `MISS` lines it prints to confirm the actual behaviour
   before deciding whether your sample belongs in the regular group or
   in "Known parser gaps".

5. Keep the JSON layout: one sample per line, columns roughly
   aligned, no trailing comma. The file is hand-edited and PR diffs
   are easier to read this way.

## Capturing parser gaps

It is useful to record utterances the parser *should* recognise but
currently doesn't, so the corpus reflects ground truth rather than
just things we know we can pass. Put these in the `Known parser gaps`
group at the bottom of the file (its `_comment` block explains the
intent). The harness will count them as misses, so:

- Each new gap entry pushes the overall recognition rate down a tiny
  amount. Bump `minimumRecognitionRate` only if you accidentally drop
  it below the current baseline (you'll see a clear test failure).
- When the parser learns to handle the gap, *move the entry out of the
  gaps group* into the matching regular group rather than deleting it
  — it then becomes a regression guard.

## Reviewing the recognition rate

After adding samples (or after a parser change), run both harnesses
and read the printed `[VoiceScoreEntry dogfooding harness] X/Y
recognised (Z%) — baseline B%` line:

- iOS:    `cd artifacts/kharagolf-mobile/ios-watch-extension && swift test --filter VoiceScoreEntryDogfoodingHarnessTests`
- Wear OS: `cd artifacts/kharagolf-mobile/wear-os-module && ./gradlew test --tests "*VoiceScoreEntryDogfoodingHarnessTest*"`

If the corpus has grown meaningfully *and* the rate is comfortably
above the current baseline on both platforms, consider bumping
`minimumRecognitionRate` so the harness keeps holding the line. Leave
a few percentage points of headroom for the next gap entry.

If the rate has *dropped* below the baseline:

- Don't lower the baseline to make the build pass — that defeats the
  point of the harness.
- Read the `MISS [...]` lines the harness prints. Either fix the
  parser (preferred) or, if the new transcript is a genuine new gap,
  move it into the `Known parser gaps` group.
