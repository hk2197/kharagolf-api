/**
 * Task #2008 — Branded notification dispatch coverage.
 *
 * The companion test `notification-dispatch-and-digest.test.ts` does a
 * forward scan: for every literal `dispatchNotification("key", …)`
 * call site found in `lib/` or `routes/`, it verifies the payload
 * populates the URL alias the branded email/push template needs to
 * render its CTA button.
 *
 * This test does the *inverted* check: every key listed in
 * `EXPECTED_BRANDED_KEYS` (the canonical fixture of branded templated
 * keys, derived from the email-template renderer) must be triggered
 * from a real upstream call site in production code — i.e. there must
 * exist some file in `lib/` or `routes/`, *outside* the helper module
 * `brandedNotifications.ts`, that either:
 *
 *   1. invokes the helper that dispatches the key (e.g.
 *      `notifyAchievementUnlocked(...)` for `achievement.unlocked`), or
 *   2. directly calls `dispatchNotification("<key>", …)` itself.
 *
 * Just defining a helper inside `brandedNotifications.ts` is *not*
 * enough — the literal dispatch lives there but never runs unless an
 * upstream caller invokes the helper. This guard is the difference
 * between "templated" (renderer exists) and "actually fired"
 * (recipient receives the message).
 */
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_BRANDED_KEYS } from "./_fixtures/notificationEmailExpectations.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const srcRoot = path.resolve(__dirname, "..");

const BRANDED_HELPER_FILE = path.join(srcRoot, "lib", "brandedNotifications.ts");

async function walk(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(abs)));
    } else if (e.isFile() && abs.endsWith(".ts")) {
      out.push(abs);
    }
  }
  return out;
}

// Files that contain `dispatchNotification(` only as a definition /
// docstring / fixture rather than a real fire site. Mirrors the
// SKIP_RE in notification-dispatch-and-digest.test.ts so the two tests
// stay in lockstep.
const SKIP_RE =
  /(?:notifyDispatch|notificationDispatchCoverage|notificationEmailTemplates|notificationRegistry|mailer)\.ts$/;

const callRe = /dispatchNotification\(\s*["']([a-z0-9_.]+)["']/g;

/**
 * Parse `brandedNotifications.ts` to learn the helper-name → branded
 * key mapping, by walking each `export async function notifyXxx`
 * definition and looking up the literal `dispatchNotification("key", …)`
 * call inside it.
 */
async function buildHelperKeyMap(): Promise<Map<string, string>> {
  const src = await fs.readFile(BRANDED_HELPER_FILE, "utf8");
  const helperRe = /export async function (notify[A-Za-z0-9_]+)\s*\([^)]*\)\s*:[^{]*\{/g;
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = helperRe.exec(src)) !== null) {
    const helperName = m[1];
    // Find the matching closing brace for this function body so we can
    // scope the dispatchNotification literal lookup to just this helper.
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    const body = src.slice(start, i);
    const keyMatch = /dispatchNotification\(\s*["']([a-z0-9_.]+)["']/.exec(body);
    if (keyMatch) {
      map.set(helperName, keyMatch[1]);
    }
  }
  return map;
}

describe("Task #2008 — every branded notification key has a real upstream dispatch", () => {
  it("every EXPECTED_BRANDED_KEY is fired from a real call site outside lib/brandedNotifications.ts", async () => {
    const helperKeyMap = await buildHelperKeyMap();
    // Reverse map: branded key → set of helper names that dispatch it.
    const helpersByKey = new Map<string, Set<string>>();
    for (const [helper, key] of helperKeyMap) {
      let set = helpersByKey.get(key);
      if (!set) {
        set = new Set();
        helpersByKey.set(key, set);
      }
      set.add(helper);
    }

    const candidateDirs = ["lib", "routes"].map((d) => path.join(srcRoot, d));
    const allFiles = (await Promise.all(candidateDirs.map(walk))).flat();
    // Exclude the dispatcher / registry / templates / mailer (the
    // standard SKIP_RE) *and* the helper module itself: the literal
    // `dispatchNotification(...)` and the helper definitions inside
    // `brandedNotifications.ts` don't count as upstream fire sites
    // for this guard. We need a real *caller* in any other file.
    const callSiteFiles = allFiles.filter(
      (f) => !SKIP_RE.test(f) && f !== BRANDED_HELPER_FILE,
    );

    // Track which branded keys appear, by either route:
    //   1. a literal `dispatchNotification("key", …)` call in non-helper code, or
    //   2. an invocation `notifyXxx(` of a helper that dispatches the key.
    const dispatched = new Set<string>();

    // Pre-build a fast helper-name → key lookup.
    for (const abs of callSiteFiles) {
      const src = await fs.readFile(abs, "utf8");

      // Route 1: literal dispatchNotification calls in non-helper code.
      callRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(src)) !== null) {
        dispatched.add(m[1]);
      }

      // Route 2: helper invocations. We treat any `notifyXxx(` token
      // (with optional `await`/`void` prefix and not preceded by a
      // word char so we don't match `myNotifyXxx`) as an invocation.
      for (const [helperName, key] of helperKeyMap) {
        const invokeRe = new RegExp(`(?:^|[^A-Za-z0-9_$])${helperName}\\s*\\(`);
        if (invokeRe.test(src)) {
          dispatched.add(key);
        }
      }
    }

    const missing = EXPECTED_BRANDED_KEYS.filter((k) => !dispatched.has(k));
    expect(
      missing,
      `These branded notification keys ship a templated email/push but no upstream production code ever fires them — the literal dispatch in lib/brandedNotifications.ts won't run unless something calls it. Either invoke the matching helper from a real call site in lib/ or routes/, or add a direct dispatchNotification("<key>", …) call there. Missing: ${missing.join(", ")}`,
    ).toEqual([]);

    // Sanity check: we actually parsed the helper map. If
    // `brandedNotifications.ts` is renamed or its export style changes,
    // the map can quietly go empty and every branded key would then
    // appear "missing" via route 2. Catching it here makes the
    // diagnostic obvious.
    expect(
      helpersByKey.size,
      "Failed to parse any helper → key mappings from brandedNotifications.ts — has the helper signature changed?",
    ).toBeGreaterThan(0);
  });
});
