// Task #1707 — unit coverage for `lint-badge-polling.mjs`. Runs under
// `node --test` (no extra deps, ~1s) and is wired into the matching
// `lint:badge-polling:test` pnpm script.
//
// We exercise the detector against a synthetic `app/` tree on disk so
// the tests do not depend on the real mobile source tree (which the
// CLI itself walks). That keeps the suite stable as new screens land.
//
// Task #2125 — coverage was extended to also cover the direct
// `MoreBadgesContext.subscribe(` chains the lint now flags
// (`useMoreBadges().subscribe(` and
// `useContext(MoreBadgesContext).subscribe(`), plus negative tests
// proving unrelated `.subscribe(` calls (RxJS observers, event
// emitters, `AppState.addEventListener(...).remove`, …) are NOT
// flagged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findCallSites, classifyCallSites } from "./lint-badge-polling.mjs";

/** Build a throw-away `app/` tree under a fresh tmp dir. */
function buildAppTree(files) {
  const root = mkdtempSync(join(tmpdir(), "lint-badge-polling-"));
  const appDir = join(root, "app");
  mkdirSync(appDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(appDir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return { root, appDir };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

const ALLOW = Object.freeze({
  "(tabs)/_layout.tsx": "tab bar",
  "(tabs)/more.tsx": "more menu",
});

test("detects call-sites and reports POSIX-relative paths + line numbers", () => {
  const { root, appDir } = buildAppTree({
    "(tabs)/_layout.tsx":
      "import { useBadgePolling } from '@/context/moreBadges';\n" +
      "export default function L() { useBadgePolling(); return null; }\n",
    "(tabs)/more.tsx":
      "import { useBadgePolling } from '@/context/moreBadges';\n" +
      "// header\n" +
      "useBadgePolling();\n",
    "wallet.tsx": "// no call here\nexport default function W() {}\n",
  });
  try {
    const sites = findCallSites(appDir);
    assert.deepEqual(sites, [
      { file: "(tabs)/_layout.tsx", line: 2, kind: "useBadgePolling()" },
      { file: "(tabs)/more.tsx", line: 3, kind: "useBadgePolling()" },
    ]);
  } finally {
    cleanup(root);
  }
});

test("ignores import statements and JSDoc references", () => {
  const { root, appDir } = buildAppTree({
    // Only an import + a prose mention — no actual call-site.
    "wallet.tsx":
      "import { useBadgePolling } from '@/context/moreBadges';\n" +
      "/** Prefer useBadgePolling — but we don't call it here. */\n" +
      "export default function W() { return null; }\n",
  });
  try {
    assert.deepEqual(findCallSites(appDir), []);
  } finally {
    cleanup(root);
  }
});

test("flags call-sites outside the allow-list as violations", () => {
  const { root, appDir } = buildAppTree({
    "(tabs)/_layout.tsx": "useBadgePolling();\n",
    "(tabs)/more.tsx": "useBadgePolling();\n",
    "wallet.tsx": "useBadgePolling();\n",
    "peer-review/modal.tsx": "useBadgePolling();\n",
  });
  try {
    const { violations, missing } = classifyCallSites(
      findCallSites(appDir),
      ALLOW,
    );
    assert.deepEqual(missing, []);
    assert.deepEqual(violations, [
      { file: "peer-review/modal.tsx", line: 1, kind: "useBadgePolling()" },
      { file: "wallet.tsx", line: 1, kind: "useBadgePolling()" },
    ]);
  } finally {
    cleanup(root);
  }
});

test("reports a missing allow-listed entry when the call is removed", () => {
  const { root, appDir } = buildAppTree({
    // Only the tab-bar layout calls the hook; the More screen exists
    // but no longer subscribes. The lint must surface that drift so
    // either the call gets restored or the allow-list gets updated.
    "(tabs)/_layout.tsx": "useBadgePolling();\n",
    "(tabs)/more.tsx": "// no call here\n",
  });
  try {
    const { violations, missing } = classifyCallSites(
      findCallSites(appDir),
      ALLOW,
    );
    assert.deepEqual(violations, []);
    assert.deepEqual(missing, ["(tabs)/more.tsx"]);
  } finally {
    cleanup(root);
  }
});

test("scans .ts/.tsx/.js/.jsx but skips other extensions and dotfiles", () => {
  const { root, appDir } = buildAppTree({
    "a.ts": "useBadgePolling();\n",
    "b.tsx": "useBadgePolling();\n",
    "c.js": "useBadgePolling();\n",
    "d.jsx": "useBadgePolling();\n",
    // Should NOT be scanned:
    "readme.md": "useBadgePolling();\n",
    "config.json": "{}\n",
    ".hidden.tsx": "useBadgePolling();\n",
  });
  try {
    const sites = findCallSites(appDir);
    assert.deepEqual(
      sites.map((s) => s.file).sort(),
      ["a.ts", "b.tsx", "c.js", "d.jsx"],
    );
  } finally {
    cleanup(root);
  }
});

test("tolerates whitespace between the identifier and the open paren", () => {
  // Some formatters wrap the call onto its own line — the detector
  // must still match `useBadgePolling   (` (including a newline).
  const { root, appDir } = buildAppTree({
    "wallet.tsx": "useBadgePolling\n  ();\n",
  });
  try {
    assert.deepEqual(findCallSites(appDir), [
      { file: "wallet.tsx", line: 1, kind: "useBadgePolling()" },
    ]);
  } finally {
    cleanup(root);
  }
});

test("returns no false positives for identifiers that share a prefix", () => {
  // `useBadgePollingDisabled(` or `notUseBadgePolling(` should not
  // trigger the lint — the regex uses a word boundary on both sides.
  const { root, appDir } = buildAppTree({
    "wallet.tsx":
      "useBadgePollingDisabled();\n" +
      "function notUseBadgePolling() {}\n" +
      "myUseBadgePolling();\n",
  });
  try {
    assert.deepEqual(findCallSites(appDir), []);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Task #2125 — direct MoreBadgesContext.subscribe() call-sites
// ---------------------------------------------------------------------------
//
// `useBadgePolling()` is a thin wrapper over
// `useContext(MoreBadgesContext)?.subscribe()`. A regression where a
// future screen reaches in and calls `useMoreBadges().subscribe()` or
// `useContext(MoreBadgesContext).subscribe()` directly would re-arm
// the safety-net poll and slip past the hook-name lint untouched. The
// detector therefore also flags those two chained shapes — the tests
// below pin that behaviour.

test("flags direct useMoreBadges().subscribe() calls", () => {
  // Mirrors the real shape a future screen might use to bypass
  // `useBadgePolling()` — a hand-rolled subscribe/cleanup pair that
  // would silently restart the poll on this screen.
  const { root, appDir } = buildAppTree({
    "wallet.tsx":
      "import { useMoreBadges } from '@/context/moreBadges';\n" +
      "export default function W() {\n" +
      "  useMoreBadges().subscribe();\n" +
      "  return null;\n" +
      "}\n",
  });
  try {
    const sites = findCallSites(appDir);
    assert.deepEqual(sites, [
      {
        file: "wallet.tsx",
        line: 3,
        kind: "useMoreBadges().subscribe()",
      },
    ]);
    const { violations } = classifyCallSites(sites, ALLOW);
    assert.deepEqual(violations, sites);
  } finally {
    cleanup(root);
  }
});

test("flags direct useContext(MoreBadgesContext).subscribe() calls", () => {
  // The same regression but using the raw `useContext(...)` form
  // that bypasses `useMoreBadges()` entirely. Both `?.` and `!`
  // type-narrowing variants must be flagged because TS-heavy code
  // bases tend to use one or the other depending on local typing.
  const { root, appDir } = buildAppTree({
    "wallet.tsx":
      "import { useContext } from 'react';\n" +
      "import { MoreBadgesContext } from '@/context/moreBadges';\n" +
      "export default function W() {\n" +
      "  useContext(MoreBadgesContext)?.subscribe();\n" +
      "  return null;\n" +
      "}\n",
    "peer-review/modal.tsx":
      "import { useContext } from 'react';\n" +
      "import { MoreBadgesContext } from '@/context/moreBadges';\n" +
      "useContext(MoreBadgesContext)!.subscribe();\n",
  });
  try {
    const sites = findCallSites(appDir);
    assert.deepEqual(sites, [
      {
        file: "peer-review/modal.tsx",
        line: 3,
        kind: "useContext(MoreBadgesContext).subscribe()",
      },
      {
        file: "wallet.tsx",
        line: 4,
        kind: "useContext(MoreBadgesContext).subscribe()",
      },
    ]);
    const { violations } = classifyCallSites(sites, ALLOW);
    assert.deepEqual(violations, sites);
  } finally {
    cleanup(root);
  }
});

test("tolerates whitespace and newlines between the chain segments", () => {
  // Some formatters wrap a chain across several lines — the line
  // number reported should be the line containing the *start* of
  // the chain (i.e. the `useMoreBadges` / `useContext` identifier).
  const { root, appDir } = buildAppTree({
    "wallet.tsx":
      "useMoreBadges()\n" +
      "  ?.subscribe(\n" +
      "    handler,\n" +
      "  );\n",
    "settings.tsx":
      "useContext(\n" +
      "  MoreBadgesContext,\n" +
      ")\n" +
      "  .subscribe();\n",
  });
  try {
    assert.deepEqual(findCallSites(appDir), [
      {
        file: "settings.tsx",
        line: 1,
        kind: "useContext(MoreBadgesContext).subscribe()",
      },
      {
        file: "wallet.tsx",
        line: 1,
        kind: "useMoreBadges().subscribe()",
      },
    ]);
  } finally {
    cleanup(root);
  }
});

test("ignores legitimate non-context .subscribe() calls", () => {
  // The whole point of Task #2125 is to flag `.subscribe()` calls
  // that resolve to MoreBadgesContext — every other `.subscribe()` in
  // the codebase (RxJS observers, EventEmitter subscriptions, store
  // subscriptions, AppState listeners, etc.) must keep working
  // unflagged. If this test ever starts failing we have over-matched
  // and need to tighten the regex.
  const { root, appDir } = buildAppTree({
    "wallet.tsx":
      "import { Observable } from 'rxjs';\n" +
      "const obs = new Observable();\n" +
      "obs.subscribe((v) => console.log(v));\n" +
      "obs?.subscribe(handler);\n" +
      "store.subscribe(() => {});\n" +
      "appState.subscribe(handler);\n" +
      "useStore().subscribe(handler);\n" +
      "useNotifications().subscribe(handler);\n" +
      "useContext(SomeOtherContext).subscribe();\n" +
      "useContext(NotMoreBadgesContext).subscribe();\n",
  });
  try {
    // None of the `.subscribe(` calls above resolve to
    // `MoreBadgesContext`, so the detector must report zero hits.
    // (The regex matches text whether or not it lives inside a
    // comment, so we deliberately keep the fixture comment-free to
    // avoid false-positive noise in this assertion.)
    assert.deepEqual(findCallSites(appDir), []);
  } finally {
    cleanup(root);
  }
});

test("identifiers that share a prefix do not trigger the subscribe-chain rule", () => {
  // `useMoreBadgesPolling()` (hypothetical sibling hook) and
  // `MoreBadgesContextProvider` (a different identifier that happens
  // to start with `MoreBadgesContext`) must NOT trip the new rule.
  const { root, appDir } = buildAppTree({
    "wallet.tsx":
      "useMoreBadgesPolling().subscribe();\n" +
      "useContext(MoreBadgesContextProvider).subscribe();\n" +
      "myUseMoreBadges().subscribe();\n",
  });
  try {
    assert.deepEqual(findCallSites(appDir), []);
  } finally {
    cleanup(root);
  }
});

test("a single screen with both shapes reports both call-sites", () => {
  // Defence-in-depth: if a regression somehow lands both shapes in
  // the same file, the detector must surface both lines so the
  // developer can fix them in one pass instead of playing
  // whack-a-mole across CI runs.
  const { root, appDir } = buildAppTree({
    "wallet.tsx":
      "useBadgePolling();\n" +
      "useMoreBadges().subscribe();\n" +
      "useContext(MoreBadgesContext)?.subscribe();\n",
  });
  try {
    const { violations } = classifyCallSites(findCallSites(appDir), ALLOW);
    assert.deepEqual(violations, [
      { file: "wallet.tsx", line: 1, kind: "useBadgePolling()" },
      { file: "wallet.tsx", line: 2, kind: "useMoreBadges().subscribe()" },
      {
        file: "wallet.tsx",
        line: 3,
        kind: "useContext(MoreBadgesContext).subscribe()",
      },
    ]);
  } finally {
    cleanup(root);
  }
});

test("real app/ tree is clean: every detected call-site is allow-listed", async () => {
  // Smoke test against the actual mobile source tree — protects us
  // from a bad refactor that, say, deletes the (tabs) layout without
  // updating the allow-list. We re-import the module's internal
  // ALLOWED_CALL_SITES indirectly via the CLI — running the script
  // would `process.exit`, so instead we re-compute against the same
  // source files using the exported helpers.
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const realAppDir = join(here, "..", "app");
  const sites = findCallSites(realAppDir);
  // The real allow-list lives inside the script module; importing it
  // dynamically keeps this test honest if it ever changes.
  const mod = await import("./lint-badge-polling.mjs");
  // `ALLOWED_CALL_SITES` is not exported by name, but the helper
  // signature defaults to it — call without an override and trust the
  // module's own constant.
  const { violations, missing } = mod.classifyCallSites(sites);
  assert.deepEqual(
    violations,
    [],
    `Unexpected useBadgePolling() call-sites in app/: ${JSON.stringify(violations)}`,
  );
  assert.deepEqual(
    missing,
    [],
    `Allow-listed call-sites missing from app/: ${JSON.stringify(missing)}`,
  );
});
