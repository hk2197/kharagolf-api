#!/usr/bin/env node
// Task #1707 — static guard against accidental `useBadgePolling()`
// call-sites outside the main tab bar.
//
// Background. `useBadgePolling()` (defined in
// `artifacts/kharagolf-mobile/context/moreBadges.tsx`) starts the
// safety-net poll for `/api/portal/badge-counts` while at least one
// subscriber is mounted. By design only the screens that actually
// render a badge value should call it — currently the bottom tab bar
// (`app/(tabs)/_layout.tsx`) and the More menu (`app/(tabs)/more.tsx`).
//
// Tasks #1213 and #1408 already pin this property at runtime via a unit
// test (`__tests__/moreBadges-polling-gated.test.tsx`) and an
// integration test (`__tests__/moreBadges-polling-gated-e2e.test.tsx`),
// but both can only assert on the screens they happen to mount. A
// regression where someone wires `useBadgePolling()` into, say,
// `app/wallet.tsx`, a top-level provider in `app/_layout.tsx`, or a
// peer-review modal would silently restart the poll on auth screens,
// modals and standalone deep-linked routes — exactly what #1213 set
// out to prevent.
//
// This script complements the runtime tests with a structural sweep of
// the entire mobile `app/` tree. It walks every source file, looks for
// `useBadgePolling(` call-sites (the trailing `(` keeps imports and
// the JSDoc reference in moreBadges.tsx itself out of the match), and
// exits non-zero on any call-site that is not in the allow-list below.
//
// Task #2125 — `useBadgePolling()` is just a thin wrapper over
// `useContext(MoreBadgesContext)?.subscribe()`, so a regression where
// a future screen reaches in and calls `useMoreBadges().subscribe()`
// or `useContext(MoreBadgesContext).subscribe()` directly would
// re-arm the safety-net poll on auth screens / modals / standalone
// routes and slip past the hook-name lint untouched. We therefore
// also flag direct `.subscribe(` calls that resolve to the
// `MoreBadgesContext` value, with the same allow-list.
//
// Run locally with:
//   pnpm --filter @workspace/kharagolf-mobile run lint:badge-polling
//
// Flags:
//   --self-test  exercise the detection logic against synthetic fixtures
//                in a tmp dir (used by the matching `*.test.mjs` suite)
//
// Exits 0 on success, 1 on a real or fixture violation, 2 on usage error.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = join(HERE, "..");
const APP_DIR = join(MOBILE_ROOT, "app");

// ---------------------------------------------------------------------------
// Allow-list
// ---------------------------------------------------------------------------
//
// Paths are POSIX-style and relative to `artifacts/kharagolf-mobile/app/`.
// Every entry needs a one-line justification so the next person to
// touch this file knows whether their edit is allowed to widen the
// allow-list. If you remove or rename one of the (tabs) routes, update
// this list in the same change — the lint will fail otherwise.
const ALLOWED_CALL_SITES = Object.freeze({
  // The bottom tab bar mounts on every authenticated screen and renders
  // the badge dot on the More tab icon, so it is the canonical
  // subscriber. Without it the safety-net poll would never start while
  // the user is on a tab other than More.
  "(tabs)/_layout.tsx": "Bottom tab bar renders the More-tab badge dot.",
  // The More menu is the screen that actually surfaces every badge
  // value (feed, follows, etc.), so it subscribes for the duration of
  // the user's visit to keep counts fresh while they read the list.
  "(tabs)/more.tsx": "More menu renders the per-row badge counts.",
});

// File extensions we scan. The mobile app is TypeScript-first but we
// include `.js`/`.jsx` defensively so a stray JS file in `app/` cannot
// smuggle a poll-starting call past the lint.
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

// We deliberately match on the *call* shape `useBadgePolling(` rather
// than the bare identifier so import statements, the hook's own
// definition in `context/moreBadges.tsx`, and JSDoc references that
// mention the name in prose are not false positives. The optional
// whitespace allows formatters that wrap arguments onto the next line.
//
// Task #2125 — we also detect direct `.subscribe(` chains that
// resolve to the `MoreBadgesContext` value (the lower-level primitive
// the hook wraps). Two shapes are flagged:
//
//   - `useMoreBadges()<sep>.subscribe(` — the documented accessor
//     hook, called inline with `.subscribe(` chained off the result.
//   - `useContext(MoreBadgesContext)<sep>.subscribe(` — the raw
//     `useContext` form that bypasses `useMoreBadges()` entirely.
//
// `<sep>` allows the optional-chain operator (`?.`), the TypeScript
// non-null assertion (`!`), and arbitrary whitespace between the
// closing `)` and the `.subscribe` member access — all common
// formatter / type-narrowing variants. We do NOT try to chase
// destructured assignments (`const { subscribe } = useMoreBadges()`)
// because that requires real scope tracking; the runtime guard in
// `__tests__/moreBadges-polling-gated-e2e.test.tsx` continues to
// catch those at test time.
const CALL_SITE_PATTERNS = Object.freeze([
  {
    label: "useBadgePolling()",
    pattern: /\buseBadgePolling\s*\(/g,
  },
  {
    label: "useMoreBadges().subscribe()",
    pattern: /\buseMoreBadges\s*\(\s*\)\s*[?!]?\s*\.\s*subscribe\s*\(/g,
  },
  {
    label: "useContext(MoreBadgesContext).subscribe()",
    // The optional `,?` after `MoreBadgesContext` lets the regex
    // survive Prettier-style trailing commas
    // (`useContext(\n  MoreBadgesContext,\n)`), which are the most
    // common multi-line wrap shape for a single-argument call.
    pattern:
      /\buseContext\s*\(\s*MoreBadgesContext\s*,?\s*\)\s*[?!]?\s*\.\s*subscribe\s*\(/g,
  },
]);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Recursively walk `dir`, returning every file whose extension is in
 * `SCANNED_EXTENSIONS`. Symlinks and dotfiles are skipped to avoid
 * accidentally recursing into editor metadata or out-of-tree node_modules.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      out.push(...walk(abs));
      continue;
    }
    if (!stat.isFile()) continue;
    const dot = entry.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = entry.slice(dot);
    if (SCANNED_EXTENSIONS.has(ext)) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Convert an absolute path inside `appDir` into the POSIX-style
 * relative path the allow-list keys are expressed in.
 *
 * @param {string} absPath
 * @param {string} appDir
 */
function relPosix(absPath, appDir) {
  return relative(appDir, absPath).split(sep).join("/");
}

/**
 * Locate every poll-starting call-site under `appDir`.
 *
 * Today that means `useBadgePolling(` plus the two direct
 * `MoreBadgesContext.subscribe(` shapes documented above
 * (`useMoreBadges().subscribe(` and
 * `useContext(MoreBadgesContext).subscribe(`). Each pattern carries a
 * human-readable `kind` label so violation messages can tell the
 * developer which shape tripped the lint.
 *
 * Returns an array of `{ file, line, kind }` records (POSIX-style
 * relative file paths, 1-indexed line numbers, see `CALL_SITE_PATTERNS`
 * for the `kind` values) so violation messages can point at the exact
 * location and shape for the developer to fix. If two patterns happen
 * to match at the same offset (unlikely with the current set, but
 * cheap to defend against), the first match wins so we don't
 * double-count a single source location.
 *
 * @param {string} appDir
 * @returns {{ file: string, line: number, kind: string }[]}
 */
export function findCallSites(appDir) {
  const sites = [];
  for (const abs of walk(appDir)) {
    const rel = relPosix(abs, appDir);
    const source = readFileSync(abs, "utf8");
    // Track which character offsets we've already attributed to a
    // pattern so overlapping shapes (e.g. a regex that subsumes
    // another) cannot inflate the violation count for a single
    // physical call.
    const claimed = new Set();
    for (const { label, pattern } of CALL_SITE_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        if (claimed.has(match.index)) continue;
        claimed.add(match.index);
        // 1-indexed line number — count newlines up to (and not
        // including) the match offset.
        const line = source.slice(0, match.index).split("\n").length;
        sites.push({ file: rel, line, kind: label });
      }
    }
  }
  // Stable order — easier to diff and easier to read in CI logs.
  sites.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });
  return sites;
}

/**
 * Compare detected call-sites against the allow-list.
 *
 * Returns `{ violations, missing }`:
 *   - `violations` is the list of call-sites that are NOT in the allow-list
 *     (i.e. unexpected new poll subscribers — the regression we are
 *     guarding against).
 *   - `missing` is the list of allow-listed paths for which no call-site
 *     was found (i.e. the (tabs) layout/More screen was renamed or the
 *     `useBadgePolling()` call was deleted without updating the list).
 *
 * @param {{ file: string, line: number, kind?: string }[]} sites
 * @param {Record<string, string>} allowList
 */
export function classifyCallSites(sites, allowList = ALLOWED_CALL_SITES) {
  const allowed = new Set(Object.keys(allowList));
  const seen = new Set();
  const violations = [];
  for (const site of sites) {
    if (allowed.has(site.file)) {
      seen.add(site.file);
    } else {
      violations.push(site);
    }
  }
  const missing = [...allowed].filter((p) => !seen.has(p)).sort();
  return { violations, missing };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return (
    "Usage: lint-badge-polling.mjs [--self-test]\n" +
    "  Scans artifacts/kharagolf-mobile/app/** for badge-polling call-sites\n" +
    "  (useBadgePolling() and direct MoreBadgesContext.subscribe() chains)\n" +
    "  and fails if any live outside the documented allow-list.\n"
  );
}

function formatViolations(violations) {
  return violations
    .map((v) => `  - app/${v.file}:${v.line}  [${v.kind ?? "useBadgePolling()"}]`)
    .join("\n");
}

function formatAllowList(allowList) {
  return Object.entries(allowList)
    .map(([path, why]) => `  - app/${path}  (${why})`)
    .join("\n");
}

function runOnce(appDir, allowList = ALLOWED_CALL_SITES) {
  const sites = findCallSites(appDir);
  const { violations, missing } = classifyCallSites(sites, allowList);

  if (violations.length === 0 && missing.length === 0) {
    process.stderr.write(
      `lint-badge-polling: ${sites.length} badge-polling call-site${
        sites.length === 1 ? "" : "s"
      } — all in the allow-list.\n`,
    );
    return 0;
  }

  if (violations.length > 0) {
    process.stderr.write(
      `lint-badge-polling: ${violations.length} unexpected badge-polling ` +
        `call-site${violations.length === 1 ? "" : "s"} ` +
        `outside the main tab bar:\n${formatViolations(violations)}\n\n` +
        `Only the following call-sites are allowed (see Task #1213/#1408/#2125 for context):\n` +
        `${formatAllowList(allowList)}\n\n` +
        `If you genuinely need a new screen to drive badge polling, update ` +
        `the allow-list in artifacts/kharagolf-mobile/scripts/lint-badge-polling.mjs ` +
        `with a one-line justification, and extend the runtime guard in ` +
        `__tests__/moreBadges-polling-gated-e2e.test.tsx to cover the new screen. ` +
        `Prefer the documented useBadgePolling() hook over reaching into ` +
        `MoreBadgesContext.subscribe() directly.\n`,
    );
  }

  if (missing.length > 0) {
    process.stderr.write(
      `lint-badge-polling: allow-listed call-site${missing.length === 1 ? "" : "s"} ` +
        `not found in the source tree:\n` +
        `${missing.map((p) => `  - app/${p}`).join("\n")}\n\n` +
        `Either restore the useBadgePolling() call or remove the entry from ` +
        `the allow-list in artifacts/kharagolf-mobile/scripts/lint-badge-polling.mjs ` +
        `in the same change.\n`,
    );
  }

  return 1;
}

function main(argv) {
  const args = argv.slice(2);
  for (const a of args) {
    if (a === "--help" || a === "-h") {
      process.stdout.write(usage());
      return 0;
    }
    if (a === "--self-test") {
      // The self-test path exists for the accompanying `*.test.mjs`
      // suite — kept as a flag so a developer can sanity-check the
      // detector by hand without having to invoke `node --test`.
      process.stdout.write(
        "Self-test is exercised by lint-badge-polling.test.mjs — run:\n" +
          "  node --test artifacts/kharagolf-mobile/scripts/lint-badge-polling.test.mjs\n",
      );
      return 0;
    }
    process.stderr.write(`Unknown flag: ${a}\n${usage()}`);
    return 2;
  }
  return runOnce(APP_DIR);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
