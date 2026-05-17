#!/usr/bin/env node
/**
 * Repository guard against new digestable notifications shipping without
 * the per-row description translations the web and mobile preference
 * screens look up (Task #2165).
 *
 * Task #1742 wired the notification preferences UI to translate the
 * per-row description copy through `notificationKeys.<key>` (web) and
 * `commPrefs.notificationKeys.<key>` (mobile) instead of rendering the
 * registry's English `description` directly. The lookup falls back to
 * the API's English description plus a "(in English)" tag when the
 * translation key is missing — which is what every non-English member
 * silently sees the moment an engineer adds a new `digestable: true`
 * entry to `notificationRegistry.ts` without also adding the matching
 * translation key.
 *
 * Nothing in the build cross-checked the registry against the i18n
 * bundles. The existing mobile / portal translation lints walk the
 * English bundles and confirm every key is mirrored across the other
 * 20 locales, but they cannot tell if the English bundle itself is
 * missing a key the registry expects.
 *
 * This script closes that gap. It:
 *
 *   1. Parses `artifacts/api-server/src/lib/notificationRegistry.ts`
 *      and collects every entry whose definition contains
 *      `digestable: true`.
 *   2. Loads the English portal bundle
 *      (`artifacts/kharagolf-web/src/i18n/locales/en/portal.json`) and
 *      asserts each digestable key is present under `notificationKeys`.
 *   3. Loads the English mobile bundle
 *      (`artifacts/kharagolf-mobile/i18n/locales/en/profile.json`) and
 *      asserts each digestable key is present under
 *      `commPrefs.notificationKeys`.
 *
 * The per-locale completeness for the other 20 locales is the
 * responsibility of `check-portal-translations.mjs` and
 * `check-mobile-translations.mjs`, which both treat the
 * `notificationKeys.` / `commPrefs.notificationKeys.` subtrees as
 * strict-translation prefixes (Task #1743 mechanism) so the moment a
 * new English key is added every other locale is required to translate
 * it — `--update-baseline` is not allowed to grandfather these keys.
 *
 * Flags:
 *   --self-test    exercise the detection logic with fixture cases
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

const REGISTRY_PATH = join(
  repoRoot,
  "artifacts",
  "api-server",
  "src",
  "lib",
  "notificationRegistry.ts",
);

const PORTAL_EN_PATH = join(
  repoRoot,
  "artifacts",
  "kharagolf-web",
  "src",
  "i18n",
  "locales",
  "en",
  "portal.json",
);

const MOBILE_EN_PATH = join(
  repoRoot,
  "artifacts",
  "kharagolf-mobile",
  "i18n",
  "locales",
  "en",
  "profile.json",
);

// ---------------------------------------------------------------------------
// Registry parsing
// ---------------------------------------------------------------------------

/**
 * Extract every notification spec literal of the form
 *
 *   { key: "...", ..., digestable: true, ... }
 *
 * from the source of `notificationRegistry.ts`. We match `digestable: true`
 * specifically because the registry also contains `digestable?: boolean`
 * type annotations and `digestable: spec.digestable ?? false` derivation
 * lines that we must not mistake for actual digestable entries.
 *
 * Returns the list of dotted notification keys, in source order.
 */
export function extractDigestableKeys(source) {
  /** @type {string[]} */
  const keys = [];
  // Each spec is a `{ ... }` literal on (typically) one line. We grab
  // every brace-bounded segment that contains BOTH a `key: "..."` and a
  // `digestable: true` token and pull the key string out of it.
  const objectRe = /\{[^{}]*\}/g;
  let m;
  while ((m = objectRe.exec(source)) !== null) {
    const segment = m[0];
    if (!/\bdigestable\s*:\s*true\b/.test(segment)) continue;
    const keyMatch = segment.match(/\bkey\s*:\s*["']([^"']+)["']/);
    if (!keyMatch) continue;
    keys.push(keyMatch[1]);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Bundle traversal
// ---------------------------------------------------------------------------

/**
 * Walk an explicit chain of property names through a parsed JSON bundle
 * and return the leaf when (and only when) it is a non-empty string.
 *
 * NOTE: the chain is taken as an array rather than a dotted string
 * because notification keys themselves contain dots (e.g.
 * `achievement.unlocked` is a SINGLE JSON property, not a nested
 * object). Splitting the lookup path on `.` would silently miss every
 * one of them.
 *
 * The notification rows render the leaf value verbatim, so an empty
 * string would be just as broken as a missing key — both return
 * `undefined`.
 */
export function getString(bundle, chain) {
  let cursor = bundle;
  for (const segment of chain) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = cursor[segment];
    if (cursor === undefined) return undefined;
  }
  if (typeof cursor !== "string" || cursor.length === 0) return undefined;
  return cursor;
}

/**
 * Inspect a single (key, portal-en bundle, mobile-en bundle) tuple and
 * return the failures that fire. Pure function — no I/O — so the
 * self-test can drive it directly.
 */
export function inspectKey({ key, portalEn, mobileEn }) {
  /** @type {Array<{ surface: "portal" | "mobile", path: string }>} */
  const failures = [];
  const portalChain = ["notificationKeys", key];
  const mobileChain = ["commPrefs", "notificationKeys", key];
  if (getString(portalEn, portalChain) === undefined) {
    failures.push({ surface: "portal", path: portalChain.join(".") });
  }
  if (getString(mobileEn, mobileChain) === undefined) {
    failures.push({ surface: "mobile", path: mobileChain.join(".") });
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Self-test fixtures
// ---------------------------------------------------------------------------

const SAMPLE_REGISTRY_SOURCE = `
  // ----- transactional -----
  { key: "booking.confirmed",      category: "tee",         description: "Tee-time booking confirmed" },
  // ----- digestable -----
  { key: "achievement.unlocked",   category: "engagement",  description: "Player unlocked a new achievement", digestable: true },
  { key: "highlight.ready",        category: "engagement",  description: "Your highlight reel is ready", digestable: true },
  // ----- digestable with a trailing flag -----
  { key: "coach.payout.account.changed.admin", category: "coaching", description: "Coach payout account changed", digestable: true, auditRequired: true },
  // ----- digestable: false should NOT be picked up -----
  { key: "booking.cancelled",      category: "tee",         description: "Tee-time was cancelled", digestable: false },
  // ----- type annotations and ?? defaults must be ignored -----
  // digestable?: boolean;
  // digestable: spec.digestable ?? false,
`;

function runSelfTest() {
  /** @type {Array<{ name: string, run: () => void }>} */
  const cases = [];
  let failed = 0;
  const expectEqual = (label, got, want) => {
    const gotJson = JSON.stringify(got);
    const wantJson = JSON.stringify(want);
    if (gotJson !== wantJson) {
      failed += 1;
      console.error(
        `  ✗ ${label}\n      expected: ${wantJson}\n      got:      ${gotJson}`,
      );
      return false;
    }
    console.log(`  ✓ ${label}`);
    return true;
  };

  // ---- extractDigestableKeys --------------------------------------------
  cases.push({
    name: "extractDigestableKeys collects only digestable: true entries",
    run: () => {
      expectEqual(
        "extractDigestableKeys: only digestable:true keys",
        extractDigestableKeys(SAMPLE_REGISTRY_SOURCE),
        [
          "achievement.unlocked",
          "highlight.ready",
          "coach.payout.account.changed.admin",
        ],
      );
      expectEqual(
        "extractDigestableKeys: empty source yields no keys",
        extractDigestableKeys(""),
        [],
      );
      expectEqual(
        "extractDigestableKeys: digestable:false is NOT collected",
        extractDigestableKeys(
          '{ key: "x.y", description: "z", digestable: false }',
        ),
        [],
      );
    },
  });

  // ---- getString --------------------------------------------------------
  cases.push({
    name: "getString resolves nested string leaves",
    run: () => {
      expectEqual(
        "getString: present string leaf",
        getString(
          { notificationKeys: { "achievement.unlocked": "You unlocked!" } },
          ["notificationKeys", "achievement.unlocked"],
        ),
        "You unlocked!",
      );
      expectEqual(
        "getString: dotted property name is NOT split into nested objects",
        getString(
          { notificationKeys: { achievement: { unlocked: "nested" } } },
          ["notificationKeys", "achievement.unlocked"],
        ),
        undefined,
      );
      expectEqual(
        "getString: missing top-level segment",
        getString({}, ["notificationKeys", "foo.bar"]),
        undefined,
      );
      expectEqual(
        "getString: empty-string leaf is treated as missing",
        getString({ a: { b: "" } }, ["a", "b"]),
        undefined,
      );
      expectEqual(
        "getString: non-string leaf is treated as missing",
        getString({ a: { b: 42 } }, ["a", "b"]),
        undefined,
      );
    },
  });

  // ---- inspectKey: translation present everywhere -----------------------
  cases.push({
    name: "inspectKey passes when both surfaces have the key",
    run: () => {
      const portalEn = {
        notificationKeys: {
          "achievement.unlocked": "You unlocked a new achievement",
        },
      };
      const mobileEn = {
        commPrefs: {
          notificationKeys: {
            "achievement.unlocked": "You unlocked a new achievement",
          },
        },
      };
      expectEqual(
        "inspectKey: both surfaces present",
        inspectKey({
          key: "achievement.unlocked",
          portalEn,
          mobileEn,
        }),
        [],
      );
    },
  });

  // ---- inspectKey: missing key on one or both surfaces ------------------
  cases.push({
    name: "inspectKey fires when the key is missing on one or both surfaces",
    run: () => {
      const fullPortal = {
        notificationKeys: { "highlight.ready": "Your highlight reel is ready" },
      };
      const fullMobile = {
        commPrefs: {
          notificationKeys: {
            "highlight.ready": "Your highlight reel is ready",
          },
        },
      };
      const emptyPortal = { notificationKeys: {} };
      const emptyMobile = { commPrefs: { notificationKeys: {} } };

      expectEqual(
        "inspectKey: missing on portal only",
        inspectKey({
          key: "highlight.ready",
          portalEn: emptyPortal,
          mobileEn: fullMobile,
        }),
        [{ surface: "portal", path: "notificationKeys.highlight.ready" }],
      );
      expectEqual(
        "inspectKey: missing on mobile only",
        inspectKey({
          key: "highlight.ready",
          portalEn: fullPortal,
          mobileEn: emptyMobile,
        }),
        [
          {
            surface: "mobile",
            path: "commPrefs.notificationKeys.highlight.ready",
          },
        ],
      );
      expectEqual(
        "inspectKey: missing on both surfaces",
        inspectKey({
          key: "highlight.ready",
          portalEn: emptyPortal,
          mobileEn: emptyMobile,
        }),
        [
          { surface: "portal", path: "notificationKeys.highlight.ready" },
          {
            surface: "mobile",
            path: "commPrefs.notificationKeys.highlight.ready",
          },
        ],
      );
    },
  });

  // ---- end-to-end: SAMPLE_REGISTRY against synthetic bundles ------------
  cases.push({
    name: "end-to-end: every digestable key in sample registry is required on both surfaces",
    run: () => {
      const digestable = extractDigestableKeys(SAMPLE_REGISTRY_SOURCE);
      // Bundles that mirror the sample registry — should pass.
      const portalEnFull = { notificationKeys: {} };
      const mobileEnFull = { commPrefs: { notificationKeys: {} } };
      for (const k of digestable) {
        portalEnFull.notificationKeys[k] = `portal copy for ${k}`;
        mobileEnFull.commPrefs.notificationKeys[k] = `mobile copy for ${k}`;
      }
      const passingFailures = digestable.flatMap((key) =>
        inspectKey({
          key,
          portalEn: portalEnFull,
          mobileEn: mobileEnFull,
        }),
      );
      expectEqual(
        "end-to-end: all keys translated → no failures",
        passingFailures,
        [],
      );

      // Drop one key from each surface — the lint must catch both gaps.
      const portalEnHole = JSON.parse(JSON.stringify(portalEnFull));
      const mobileEnHole = JSON.parse(JSON.stringify(mobileEnFull));
      delete portalEnHole.notificationKeys["highlight.ready"];
      delete mobileEnHole.commPrefs.notificationKeys[
        "achievement.unlocked"
      ];
      const breakingFailures = digestable.flatMap((key) =>
        inspectKey({
          key,
          portalEn: portalEnHole,
          mobileEn: mobileEnHole,
        }),
      );
      // Failures are emitted in (registry-order × surface-order):
      // achievement.unlocked is first in the registry and only the
      // mobile surface drops it, then highlight.ready follows and only
      // the portal surface drops it, then the third key passes.
      expectEqual(
        "end-to-end: dropped keys are flagged on the right surface",
        breakingFailures,
        [
          {
            surface: "mobile",
            path: "commPrefs.notificationKeys.achievement.unlocked",
          },
          { surface: "portal", path: "notificationKeys.highlight.ready" },
        ],
      );
    },
  });

  for (const c of cases) c.run();
  if (failed > 0) {
    console.error(`\nself-test: ${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log(
    `\nself-test: all ${cases.length} case group(s) passed (${cases.length} groups, multiple assertions each)`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  let registrySource;
  try {
    registrySource = readFileSync(REGISTRY_PATH, "utf8");
  } catch (err) {
    console.error(
      `failed to read ${relative(repoRoot, REGISTRY_PATH)}: ${err.message}`,
    );
    process.exit(2);
  }

  let portalEn;
  try {
    portalEn = JSON.parse(readFileSync(PORTAL_EN_PATH, "utf8"));
  } catch (err) {
    console.error(
      `failed to read ${relative(repoRoot, PORTAL_EN_PATH)}: ${err.message}`,
    );
    process.exit(2);
  }

  let mobileEn;
  try {
    mobileEn = JSON.parse(readFileSync(MOBILE_EN_PATH, "utf8"));
  } catch (err) {
    console.error(
      `failed to read ${relative(repoRoot, MOBILE_EN_PATH)}: ${err.message}`,
    );
    process.exit(2);
  }

  const digestableKeys = extractDigestableKeys(registrySource);
  if (digestableKeys.length === 0) {
    console.error(
      `check-notification-row-translations: parsed ${relative(repoRoot, REGISTRY_PATH)} but found 0 digestable: true entries — the parser is likely broken.`,
    );
    process.exit(2);
  }

  /** @type {Array<{ key: string, surface: "portal" | "mobile", path: string }>} */
  const failures = [];
  for (const key of digestableKeys) {
    for (const f of inspectKey({ key, portalEn, mobileEn })) {
      failures.push({ key, ...f });
    }
  }

  if (failures.length > 0) {
    console.error(
      `\ncheck-notification-row-translations: found ${failures.length} digestable notification key(s) without an English translation entry:\n`,
    );
    const portalGaps = failures.filter((f) => f.surface === "portal");
    const mobileGaps = failures.filter((f) => f.surface === "mobile");
    if (portalGaps.length > 0) {
      console.error(
        `  ${relative(repoRoot, PORTAL_EN_PATH)} is missing under "notificationKeys":`,
      );
      for (const f of portalGaps) console.error(`    - ${f.key}`);
    }
    if (mobileGaps.length > 0) {
      console.error(
        `  ${relative(repoRoot, MOBILE_EN_PATH)} is missing under "commPrefs.notificationKeys":`,
      );
      for (const f of mobileGaps) console.error(`    - ${f.key}`);
    }
    console.error(
      "\nAdd an English notification-row description for each key above, then run\n" +
        "  pnpm run lint:portal-translations\n" +
        "  pnpm run lint:mobile-translations\n" +
        "to translate the new entry across the other 20 locales (the per-locale\n" +
        "completeness check refuses to baseline these keys).\n",
    );
    process.exit(1);
  }

  console.log(
    `check-notification-row-translations: scanned ${digestableKeys.length} digestable notification key(s) — every key has an English row description in both ${relative(repoRoot, PORTAL_EN_PATH)} and ${relative(repoRoot, MOBILE_EN_PATH)}.`,
  );
}

main();
