// Unit coverage for `watch-release-json.mjs`. Runs under `node --test`
// (no extra deps, ~1s) and is wired into both the local `npm run
// watch-release:test` script and the `watch-release-json` CI workflow.
//
// The point of these tests is to make the JSON contract loud: if a
// future Fastfile edit changes `buildNumber` to `build_number`, or
// starts writing the literal string "unknown" again, the validator
// here is what tells us before the team-channel post does.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validate,
  SUPPORTED_SCHEMA_VERSION,
  SUPPORTED_PLATFORMS,
} from "./watch-release-json.mjs";

const samplePayload = (overrides = {}) => ({
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  platform: "ios",
  buildNumber: "42",
  versionName: "1.2.3",
  easBuildId: "abc123",
  generatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

test("accepts a well-formed iOS payload", () => {
  assert.deepEqual(validate(samplePayload()), []);
});

test("accepts a well-formed Android payload", () => {
  assert.deepEqual(
    validate(samplePayload({ platform: "android", buildNumber: "1234" })),
    [],
  );
});

test("accepts a dotted iOS build number (e.g. 1.2.3)", () => {
  assert.deepEqual(validate(samplePayload({ buildNumber: "1.2.3" })), []);
});

test("accepts an empty versionName as a tolerable absence", () => {
  // Fastlane writes "" when EAS hasn't surfaced an appVersion yet;
  // that's degraded but still useful — only `buildNumber` is critical
  // for the team-channel post.
  assert.deepEqual(validate(samplePayload({ versionName: "" })), []);
});

test("rejects an unknown schemaVersion", () => {
  const errors = validate(samplePayload({ schemaVersion: 2 }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /schemaVersion/);
});

test("rejects a missing schemaVersion", () => {
  const obj = samplePayload();
  delete obj.schemaVersion;
  const errors = validate(obj);
  assert.ok(errors.some((e) => /schemaVersion/.test(e)));
});

test("rejects an unsupported platform", () => {
  const errors = validate(samplePayload({ platform: "windows" }));
  assert.ok(errors.some((e) => /platform/.test(e)));
});

test("rejects a platform mismatch when caller pins one", () => {
  const errors = validate(samplePayload({ platform: "android" }), {
    platform: "ios",
  });
  assert.ok(errors.some((e) => /mismatch/.test(e)));
});

test("rejects an empty buildNumber", () => {
  const errors = validate(samplePayload({ buildNumber: "" }));
  assert.ok(errors.some((e) => /buildNumber/.test(e)));
});

test("rejects the literal 'unknown' build number", () => {
  // This is the regression we are guarding against — the old
  // log-grep used to fall back to the literal string "unknown" when
  // it couldn't parse a build number. The Fastfile will refuse to
  // write that, but if a future edit ever did, the validator must
  // catch it before the notification fires.
  const errors = validate(samplePayload({ buildNumber: "unknown" }));
  assert.ok(errors.some((e) => /buildNumber/.test(e)));
});

test("rejects a non-string buildNumber", () => {
  const errors = validate(samplePayload({ buildNumber: 42 }));
  assert.ok(errors.some((e) => /buildNumber/.test(e)));
});

test("rejects an empty easBuildId", () => {
  const errors = validate(samplePayload({ easBuildId: "" }));
  assert.ok(errors.some((e) => /easBuildId/.test(e)));
});

test("rejects a non-ISO-8601 generatedAt", () => {
  const errors = validate(samplePayload({ generatedAt: "yesterday" }));
  assert.ok(errors.some((e) => /generatedAt/.test(e)));
});

test("rejects non-object inputs", () => {
  assert.deepEqual(validate(null), [
    "watch-release JSON must be a JSON object",
  ]);
  assert.deepEqual(validate([]), [
    "watch-release JSON must be a JSON object",
  ]);
  assert.deepEqual(validate("hi"), [
    "watch-release JSON must be a JSON object",
  ]);
});

test("SUPPORTED_PLATFORMS exports both shipping platforms", () => {
  // Frozen so accidental mutation doesn't widen the contract at runtime.
  assert.deepEqual([...SUPPORTED_PLATFORMS].sort(), ["android", "ios"]);
  assert.throws(() => {
    SUPPORTED_PLATFORMS.push("windows");
  });
});
