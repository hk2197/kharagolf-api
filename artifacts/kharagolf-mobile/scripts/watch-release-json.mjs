#!/usr/bin/env node
// Schema check for the JSON file fastlane writes at the end of each
// `beta` lane (see `../fastlane/Fastfile`). The watch shipping CI
// workflow reads this file to populate the team-channel post, so a
// drift in shape — a renamed field, an empty build number, a typo in
// `platform` — would silently fall back to "unknown" the way the old
// log-grep did.
//
// This module exports `validate(obj, opts)` for unit tests, and runs
// as a CLI when invoked directly so the workflow can fail loudly
// before the notification job ever sees a bad file.
//
// Usage:
//   node scripts/watch-release-json.mjs --platform ios tmp/watch-release.json
//   node scripts/watch-release-json.mjs tmp/watch-release.json
//
// Exits 0 on success, 1 on validation failure, 2 on usage error.

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SUPPORTED_SCHEMA_VERSION = 1;
export const SUPPORTED_PLATFORMS = Object.freeze(["ios", "android"]);

/**
 * Validate a parsed watch-release JSON payload.
 * Returns an array of error messages — empty array means valid.
 *
 * @param {unknown} obj - Parsed JSON value.
 * @param {{ platform?: string }} [opts] - When `platform` is supplied,
 *   the payload's `platform` field must match it (used by CI to make
 *   sure the iOS job didn't accidentally read the Android JSON).
 */
export function validate(obj, opts = {}) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return ["watch-release JSON must be a JSON object"];
  }

  const errors = [];

  if (obj.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be ${SUPPORTED_SCHEMA_VERSION}, got ${JSON.stringify(obj.schemaVersion)}`,
    );
  }

  if (!SUPPORTED_PLATFORMS.includes(obj.platform)) {
    errors.push(
      `platform must be one of ${SUPPORTED_PLATFORMS.join("/")}, got ${JSON.stringify(obj.platform)}`,
    );
  } else if (opts.platform && obj.platform !== opts.platform) {
    errors.push(
      `platform mismatch: expected ${opts.platform}, got ${obj.platform}`,
    );
  }

  if (typeof obj.buildNumber !== "string" || obj.buildNumber.trim() === "") {
    errors.push(
      `buildNumber must be a non-empty string, got ${JSON.stringify(obj.buildNumber)}`,
    );
  } else if (!/^[0-9]+(\.[0-9]+)*$/.test(obj.buildNumber)) {
    // TestFlight build numbers are dotted integers (e.g. "42" or
    // "1.2.3"); Play version codes are pure integers. Anything else
    // (e.g. "unknown", "v42", "") is a sign the source picker fell
    // back to a placeholder.
    errors.push(
      `buildNumber must look like a numeric/dotted version, got ${JSON.stringify(obj.buildNumber)}`,
    );
  }

  if (typeof obj.easBuildId !== "string" || obj.easBuildId.trim() === "") {
    errors.push("easBuildId must be a non-empty string");
  }

  if (
    typeof obj.generatedAt !== "string" ||
    Number.isNaN(Date.parse(obj.generatedAt))
  ) {
    errors.push("generatedAt must be an ISO-8601 timestamp string");
  }

  if (
    "versionName" in obj &&
    obj.versionName !== "" &&
    typeof obj.versionName !== "string"
  ) {
    errors.push("versionName must be a string when present");
  }

  return errors;
}

function usage() {
  return (
    "Usage: watch-release-json.mjs [--platform ios|android] <path-to-watch-release.json>...\n"
  );
}

function main(argv) {
  const args = argv.slice(2);
  let platform;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--platform") {
      platform = args[++i];
      if (!platform) {
        process.stderr.write("--platform requires a value\n");
        return 2;
      }
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(usage());
      return 0;
    } else if (a.startsWith("--")) {
      process.stderr.write(`Unknown flag: ${a}\n${usage()}`);
      return 2;
    } else {
      files.push(a);
    }
  }
  if (files.length === 0) {
    process.stderr.write(usage());
    return 2;
  }

  let exitCode = 0;
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      process.stderr.write(`${file}: cannot read file: ${err.message}\n`);
      exitCode = 1;
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      process.stderr.write(`${file}: failed to parse JSON: ${err.message}\n`);
      exitCode = 1;
      continue;
    }
    const errors = validate(obj, { platform });
    if (errors.length > 0) {
      process.stderr.write(`${file}: invalid watch-release JSON\n`);
      for (const e of errors) process.stderr.write(`  - ${e}\n`);
      exitCode = 1;
    } else {
      process.stdout.write(
        `${file}: ok (${obj.platform} build ${obj.buildNumber})\n`,
      );
    }
  }
  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
