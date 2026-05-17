/**
 * Task #1595 — end-to-end tests for the voice-fixture lint runner
 * (`voice-fixtures/scripts/lint-fixture.mjs`).
 *
 * Task #1337 already pinned the `detectWarnings` heuristic, but the
 * surrounding runner — schema-drift validation in `loadSamples` and the
 * exit-code/summary contract in `main` — was untested. Both are
 * load-bearing for the PII gate: a regression in `loadSamples` would let
 * malformed corpora silently skip the scan, and a regression in `main`
 * would mean failing samples no longer block CI.
 *
 * We exercise the runner as an actual subprocess, pointed at a
 * synthetic fixture file in a tmp dir via the `VOICE_FIXTURE_PATH`
 * override, so we cover the real CLI path the pre-commit hook uses.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
  HERE,
  "..",
  "voice-fixtures",
  "scripts",
  "lint-fixture.mjs",
);

let tmpDir: string;
let fixturePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "voice-fixture-lint-"));
  fixturePath = join(tmpDir, "fixture.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runLint(corpus: unknown) {
  writeFileSync(fixturePath, JSON.stringify(corpus));
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, VOICE_FIXTURE_PATH: fixturePath },
    encoding: "utf8",
  });
}

describe("voice-fixtures lint runner — clean corpus", () => {
  it("exits 0 and reports `N samples clean` on stderr", () => {
    const result = runLint({
      samples: [
        { id: "clean-1", transcript: "birdie on hole 3" },
        { id: "clean-2", transcript: "two putts on hole 5" },
      ],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("voice-fixtures lint:");
    expect(result.stderr).toContain("2 samples clean");
    expect(result.stderr).toContain("no PII warnings");
  });

  it("uses the singular form when there is exactly one sample", () => {
    const result = runLint({
      samples: [{ id: "only", transcript: "birdie on hole 3" }],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("1 sample clean");
  });

  it("exits 0 on an empty corpus", () => {
    const result = runLint({ samples: [] });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("0 samples clean");
  });
});

describe("voice-fixtures lint runner — flagged samples", () => {
  it("exits 1 and lists the offending id and WARN lines", () => {
    const result = runLint({
      samples: [
        { id: "good", transcript: "birdie on hole 3" },
        { id: "bad-uuid", transcript: "round 550e8400-e29b-41d4-a716-446655440000 finished" },
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PII detector flagged 1 sample");
    expect(result.stderr).toContain("bad-uuid:");
    expect(result.stderr).toContain("WARN:");
    expect(result.stderr).toContain("UUID");
    // The clean sample must not be listed in the per-sample failure block.
    expect(result.stderr).not.toMatch(/^\s+good:/m);
  });

  it("uses the plural form and lists every offending sample", () => {
    const result = runLint({
      samples: [
        { id: "bad-clock", transcript: "logged a 4 at 12:34 on hole 3" },
        { id: "bad-name", transcript: "Sanjay carded six" },
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PII detector flagged 2 samples");
    expect(result.stderr).toContain("bad-clock:");
    expect(result.stderr).toContain("bad-name:");
  });

  it("falls back to `(no id)` when an offending sample lacks an id", () => {
    const result = runLint({
      samples: [{ transcript: "Sanjay carded six" }],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("(no id):");
  });
});

describe("voice-fixtures lint runner — schema drift", () => {
  it("throws with a clear message when the top-level `samples` array is missing", () => {
    const result = runLint({ notSamples: [] });

    expect(result.status).not.toBe(0);
    // Node prints uncaught Errors to stderr; assert on the message text.
    expect(result.stderr).toContain(
      "expected a top-level `samples` array",
    );
    // Should not have produced the success summary.
    expect(result.stderr).not.toContain("samples clean");
  });

  it("throws when the JSON root is not an object at all", () => {
    const result = runLint(null);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "expected a top-level `samples` array",
    );
  });

  it("throws the schema-drift error when a sample has a non-string transcript", () => {
    const result = runLint({
      samples: [
        { id: "ok", transcript: "birdie on hole 3" },
        { id: "bad", transcript: 42 },
      ],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "missing a string `transcript`",
    );
    expect(result.stderr).toContain("refusing to lint a corpus with schema drift");
    // The bad sample's index and serialised payload should be in the summary.
    expect(result.stderr).toContain("samples[1]:");
  });

  it("throws when the transcript field is missing entirely", () => {
    const result = runLint({
      samples: [{ id: "no-transcript" }],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing a string `transcript`");
    expect(result.stderr).toContain("samples[0]:");
  });

  it("uses the plural error wording when multiple entries are malformed", () => {
    const result = runLint({
      samples: [
        { id: "bad-1", transcript: null },
        { id: "bad-2" },
      ],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("2 sample entries are missing a string `transcript`");
  });

  it("uses the singular error wording when exactly one entry is malformed", () => {
    const result = runLint({
      samples: [
        { id: "ok", transcript: "birdie on hole 3" },
        { id: "bad", transcript: null },
      ],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("1 sample entry is missing a string `transcript`");
  });
});
