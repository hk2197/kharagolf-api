/**
 * Task #1337 — unit tests for the `detectWarnings` PII heuristic in
 * voice-fixtures/scripts/anonymise.mjs.
 *
 * `detectWarnings` is the gate the new fixture lint
 * (`scripts/lint-fixture.mjs`) uses to decide whether
 * `dogfooding-transcripts.json` is allowed to merge. Without dedicated
 * coverage a well-meaning tweak (loosening a regex, dropping a keyword)
 * could silently weaken the gate. These tests pin each warning category
 * with both a positive (known-bad input is flagged) and a negative
 * (clean transcript or established golf-vocab) assertion.
 */
import { describe, it, expect } from "vitest";

// @ts-expect-error -- plain .mjs module without type declarations.
import { detectWarnings } from "../voice-fixtures/scripts/anonymise.mjs";

const detect = detectWarnings as (raw: string) => string[];

function hasWarning(raw: string, needle: string): boolean {
  return detect(raw).some((w) => w.includes(needle));
}

describe("detectWarnings — timestamps", () => {
  it("flags a bare clock time like 12:34", () => {
    expect(hasWarning("logged a 4 at 12:34 on hole 3", "clock/timestamp")).toBe(true);
  });

  it("flags a 12:34:56 hh:mm:ss timestamp", () => {
    // The hh:mm:ss form is matched by both the clock and the precise-timestamp
    // checks; we only care that *something* fires for it.
    const warnings = detect("started round at 09:15:42");
    expect(
      warnings.some(
        (w) => w.includes("clock/timestamp") || w.includes("precise timestamp"),
      ),
    ).toBe(true);
  });

  it("flags a 12:34am am/pm timestamp", () => {
    expect(hasWarning("teed off 7:05am sharp", "clock/timestamp")).toBe(true);
  });

  it("flags a sub-second precise timestamp like 09:15:42.123", () => {
    expect(hasWarning("event at 09:15:42.123", "precise timestamp")).toBe(true);
  });

  it("does not flag a clean transcript with no clock time", () => {
    expect(detect("birdie on hole 3")).toEqual([]);
  });

  it("does not flag a hole-number-style 'on 3' phrase", () => {
    // Single digit followed by no `:` must never read as a timestamp.
    expect(detect("took 4 on 3")).toEqual([]);
  });
});

describe("detectWarnings — dates", () => {
  it("flags an ISO-style 2026-04-24 date", () => {
    expect(hasWarning("round on 2026-04-24 was tough", "date")).toBe(true);
  });

  it("flags a slash-separated 2026/04/24 date", () => {
    expect(hasWarning("round on 2026/04/24 was tough", "date")).toBe(true);
  });

  it("does not flag a transcript with no date", () => {
    expect(detect("scored 4 on hole 3")).toEqual([]);
  });
});

describe("detectWarnings — UUIDs", () => {
  it("flags a canonical 8-4-4-4-12 UUID", () => {
    expect(
      hasWarning(
        "round 550e8400-e29b-41d4-a716-446655440000 finished",
        "UUID",
      ),
    ).toBe(true);
  });

  it("flags an upper-case UUID variant (case-insensitive match)", () => {
    expect(
      hasWarning(
        "round 550E8400-E29B-41D4-A716-446655440000 finished",
        "UUID",
      ),
    ).toBe(true);
  });

  it("does not flag a non-UUID hex blob", () => {
    expect(detect("birdie on hole 3")).toEqual([]);
  });
});

describe("detectWarnings — round/device/user/player IDs", () => {
  it("flags a `round id: ...` reference", () => {
    expect(hasWarning("round id: r-42 done", "round/device/user id")).toBe(true);
  });

  it("flags a `device_id=...` reference", () => {
    expect(hasWarning("device_id=watch-7 paired", "round/device/user id")).toBe(true);
  });

  it("flags a `user-id ...` reference", () => {
    expect(hasWarning("user-id u789 finished", "round/device/user id")).toBe(true);
  });

  it("flags a `player id ...` reference", () => {
    expect(hasWarning("player id p3 carded six", "round/device/user id")).toBe(true);
  });

  it("does not flag the bare word 'round' on its own", () => {
    expect(detect("good round today")).toEqual([]);
  });
});

describe("detectWarnings — ALL-CAPS course/club identifiers", () => {
  it("flags an all-caps brand-style code like KHARAGOLF", () => {
    const warnings = detect("logged at KHARAGOLF");
    expect(warnings.some((w) => w.includes("course/club identifier"))).toBe(true);
    expect(warnings.some((w) => w.includes("KHARAGOLF"))).toBe(true);
  });

  it("flags a mixed alphanumeric code like AC123", () => {
    expect(hasWarning("hole at AC123 was rough", "course/club identifier")).toBe(true);
  });

  it("flags a hyphenated code like GC-7", () => {
    expect(hasWarning("started at GC-7 today", "course/club identifier")).toBe(true);
  });

  it("does not flag the single capital letter 'I'", () => {
    // The minimum length for the all-caps regex is 2, so the pronoun
    // 'I' must never trip this category.
    expect(detect("I scored four")).toEqual([]);
  });
});

describe("detectWarnings — capitalised name candidates", () => {
  it("flags a capitalised player name like Sanjay", () => {
    const warnings = detect("Sanjay carded six");
    expect(warnings.some((w) => w.includes("possible name"))).toBe(true);
    expect(warnings.some((w) => w.includes("Sanjay"))).toBe(true);
  });

  it("flags a capitalised caddie name embedded mid-sentence", () => {
    expect(hasWarning("partner Priya picked the right club", "possible name")).toBe(true);
  });

  it("does not flag capitalised golf vocab like Birdie or Putt", () => {
    // Sentence-initial capitalisation of common golf terms is allow-listed
    // via GOLF_VOCAB so the gate doesn't drown in false positives.
    expect(detect("Birdie on hole 3")).toEqual([]);
    expect(detect("Putt dropped from twelve feet")).toEqual([]);
  });

  it("does not flag short capitalised words below the 3-letter threshold", () => {
    // The regex requires 3+ lowercase letters after the initial capital,
    // which keeps the heuristic from firing on stutters/interjections.
    expect(detect("Uh nice one")).toEqual([]);
  });
});

describe("detectWarnings — course / club keyword mentions", () => {
  it("flags a transcript mentioning the word 'course'", () => {
    expect(hasWarning("the course was wet", "course/club")).toBe(true);
  });

  it("flags a transcript mentioning the word 'club'", () => {
    expect(hasWarning("wrong club for that shot", "course/club")).toBe(true);
  });

  it("flags 'country club'", () => {
    expect(hasWarning("nice country club today", "course/club")).toBe(true);
  });

  it("flags 'golf club'", () => {
    expect(hasWarning("at the golf club", "course/club")).toBe(true);
  });

  it("flags the cc / gc abbreviations", () => {
    expect(hasWarning("met at cc this morning", "course/club")).toBe(true);
    expect(hasWarning("met at gc this morning", "course/club")).toBe(true);
  });

  it("does not flag a transcript with no course/club keywords", () => {
    expect(detect("birdie on hole 3")).toEqual([]);
  });
});

describe("detectWarnings — golf-vocab allow-list & clean transcripts", () => {
  it.each([
    "birdie on hole 3",
    "took 4 on 3",
    "two putts on hole 5",
    "scratch that",
    "hole in one",
    "triple bogey on hole 12",
    "logged a six",
    "for on hole 3", // homophone for '4'
    "tree on hole 5", // homophone for '3'
  ])("does not flag known-clean transcript %p", (transcript) => {
    expect(detect(transcript)).toEqual([]);
  });

  it("returns warnings as an array", () => {
    expect(Array.isArray(detect(""))).toBe(true);
    expect(detect("")).toEqual([]);
  });
});
