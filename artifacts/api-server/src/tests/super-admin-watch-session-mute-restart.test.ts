/**
 * Task #2121 — End-to-end coverage for the boot-time watch session mute
 * hydration wired into `src/index.ts`.
 *
 * Task #1679 introduced the persisted `watch_session_mutes` table and a
 * boot-time `hydrateMutedSessionsFromDb()` call inside the API server's
 * listen callback so a deploy or restart no longer silently lifts every
 * active mute. The unit tests in
 * `super-admin-watch-session-mute.test.ts` cover the helper behaviour
 * (Map ↔ table sync, expiry pruning, upsert semantics, etc.) but every
 * one of those tests calls `hydrateMutedSessionsFromDb()` directly in
 * the test process. None of them exercises the actual boot path that
 * wires the call into `src/index.ts` — which means a regression that
 * removes the `hydrateMutedSessionsFromDb()` await from the listen
 * callback (or moves it somewhere it never executes) would silently
 * break restart-survival without breaking any existing test.
 *
 * This file closes that gap by spawning the real `src/index.ts` as a
 * child process (`pnpm exec tsx src/index.ts`) with a pre-seeded mute
 * row in the table, then waiting on the child's stdout for the
 * structured hydration log. The log line is only emitted from inside
 * `hydrateMutedSessionsFromDb()`, and only when at least one row is
 * loaded — so its absence (within a generous timeout) is direct
 * evidence that the boot-time hydration call regressed.
 *
 * Wire flow exercised:
 *   1. Insert a `watch_session_mutes` row directly (simulates a mute
 *      that was set on a prior boot of the API server).
 *   2. Pick a free TCP port and spawn `tsx src/index.ts` as a fresh
 *      child process — same entry point production runs. NODE_ENV is
 *      pinned to `production` so pino emits structured JSON lines we
 *      can parse without fighting the dev `pino-pretty` colour codes.
 *   3. Stream the child's stdout, parsing each line as JSON, until we
 *      find the hydration log entry (msg includes "hydrated watch
 *      session mutes from persisted store"). Assert it carries the
 *      expected `hydrated` count (≥ 1, and includes our row).
 *   4. SIGTERM the child (with a SIGKILL escalation safety net) so the
 *      listening port and the spawned cron timers don't outlive the
 *      test.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, watchSessionMutesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { uid } from "./helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// `src/tests/foo.test.ts` → `artifacts/api-server`
const apiServerDir = path.resolve(__dirname, "..", "..");
// The same entry point the prod `start` script executes, but driven via
// `tsx` so we don't depend on a prior `pnpm build`.
const indexEntry = path.resolve(__dirname, "..", "index.ts");

interface HydrationLogEntry {
  hydrated: number;
  expired: number;
}

/**
 * Walk every line in `buffer`, parse the ones that look like pino JSON,
 * and return the first entry whose `msg` matches the boot-time mute
 * hydration log. Returns `null` if nothing matched yet.
 */
function findHydrationLog(buffer: string): HydrationLogEntry | null {
  for (const line of buffer.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = parsed["msg"];
    if (
      typeof msg === "string" &&
      msg.includes("hydrated watch session mutes from persisted store")
    ) {
      const hydrated =
        typeof parsed["hydrated"] === "number" ? (parsed["hydrated"] as number) : -1;
      const expired =
        typeof parsed["expired"] === "number" ? (parsed["expired"] as number) : -1;
      return { hydrated, expired };
    }
  }
  return null;
}

function hasListeningLog(buffer: string): boolean {
  for (const line of buffer.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed["msg"] === "Server listening") return true;
    } catch {
      // pino-only line; skip
    }
  }
  return false;
}

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close((err) => (err ? reject(err) : resolve(port)));
      } else {
        reject(new Error("Could not allocate free port"));
      }
    });
  });
}

const seededSessionIds: string[] = [];

beforeEach(async () => {
  // Wipe the mute table so the spawned API server hydrates a known set
  // of rows — every "hydrated" log line we see is guaranteed to come
  // from a row we inserted in this test, not stray rows left over by
  // a sibling suite that crashed mid-run.
  await db.execute(sql`TRUNCATE TABLE ${watchSessionMutesTable}`);
});

afterAll(async () => {
  for (const sid of seededSessionIds) {
    await db
      .delete(watchSessionMutesTable)
      .where(eq(watchSessionMutesTable.sessionId, sid));
  }
});

describe("API server boot hydrates watch session mutes (Task #2121)", () => {
  it(
    "a session muted before the restart is still muted after a fresh boot — without anyone re-issuing the mute",
    async () => {
      // Step 1 — Persist a mute as if a previous boot had set it. The
      // in-memory `mutedSessions` Map only exists inside a live API
      // server process, so a fresh spawn starts with an empty Map: the
      // *only* way the mute survives is if the listen callback's
      // boot-time `hydrateMutedSessionsFromDb()` call repopulates it
      // from this row.
      const sessionId = `sess-boot-${uid("hydrate")}`;
      const futureExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await db.insert(watchSessionMutesTable).values({
        sessionId,
        expiresAt: futureExpiresAt,
      });
      seededSessionIds.push(sessionId);

      const port = await findFreePort();

      // Step 2 — Spawn the real `src/index.ts` (same entry point the
      // prod `start` script runs) as a fresh child process so this
      // test exercises the actual boot codepath, not a re-import.
      // NODE_ENV=production keeps pino in JSON mode so we can parse
      // each line cleanly instead of stripping pino-pretty colour
      // codes; it does not change behaviour we care about for this
      // assertion.
      const child: ChildProcess = spawn(
        "pnpm",
        ["exec", "tsx", indexEntry],
        {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: apiServerDir,
          env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: "production",
            // Pin the cross-replica resync interval to a value larger
            // than the test timeout so the only thing that can populate
            // the in-memory mute Map (and emit the hydration log) is
            // the boot-time `hydrateMutedSessionsFromDb()` call. If
            // that call is removed the periodic resync would otherwise
            // mask the regression after a few seconds.
            WATCH_MUTE_RESYNC_MS: String(10 * 60 * 1000),
          },
        },
      );

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let exited = false;
      const exitInfoRef: { value: { code: number | null; signal: NodeJS.Signals | null } | null } = { value: null };
      child.on("exit", (code, signal) => {
        exited = true;
        exitInfoRef.value = { code, signal };
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
      });

      try {
        // Step 3 — Wait for the structured hydration log. Polling
        // (instead of waiting on a single one-shot event) keeps the
        // test resilient to any future re-ordering of the listen
        // callback's startup tasks.
        const startedAt = Date.now();
        const TIMEOUT_MS = 45_000;
        let hydrationLog: HydrationLogEntry | null = null;
        let sawListening = false;
        while (Date.now() - startedAt < TIMEOUT_MS) {
          if (exited) {
            throw new Error(
              `[task-2121] API server child exited before emitting the hydration log ` +
                `(code ${exitInfoRef.value?.code ?? "null"}, signal ${exitInfoRef.value?.signal ?? "none"}).\n` +
                `stdout (last 4KB):\n${stdoutBuffer.slice(-4096)}\n` +
                `stderr (last 4KB):\n${stderrBuffer.slice(-4096)}`,
            );
          }
          if (!sawListening) sawListening = hasListeningLog(stdoutBuffer);
          hydrationLog = findHydrationLog(stdoutBuffer);
          if (hydrationLog !== null) break;
          await new Promise((r) => setTimeout(r, 100));
        }

        if (hydrationLog === null) {
          throw new Error(
            `[task-2121] API server booted but did not emit the watch-session-mute ` +
              `hydration log within ${TIMEOUT_MS}ms — boot-time ` +
              `hydrateMutedSessionsFromDb() in src/index.ts may have regressed.\n` +
              `sawListening=${sawListening}\n` +
              `stdout (last 8KB):\n${stdoutBuffer.slice(-8192)}\n` +
              `stderr (last 4KB):\n${stderrBuffer.slice(-4096)}`,
          );
        }

        expect(sawListening).toBe(true);
        // The hydrated count is the number of *non-expired* rows the
        // boot-time call moved into the in-memory Map. We seeded
        // exactly one such row above and truncated the table in
        // beforeEach, so we should see at least our row carry over.
        // (We assert >= 1 rather than === 1 so the test is robust to
        // a future change that legitimately seeds extra rows during
        // boot — e.g. a fixture loader.)
        expect(hydrationLog.hydrated).toBeGreaterThanOrEqual(1);
        // And nothing should have been pruned for being expired —
        // the only row the table held when the server booted was the
        // one we seeded with a 60-minute future TTL.
        expect(hydrationLog.expired).toBe(0);
      } finally {
        // Step 4 — Tear the spawned server down, even if the assertions
        // above threw. SIGTERM first; escalate to SIGKILL after a
        // short grace period so a hanging child can't keep our test
        // worker alive.
        if (!exited) {
          await new Promise<void>((resolve) => {
            const onExit = () => resolve();
            child.once("exit", onExit);
            try {
              child.kill("SIGTERM");
            } catch {
              // already dead — the `exit` listener resolves us
            }
            const killTimer = setTimeout(() => {
              if (!exited) {
                try {
                  child.kill("SIGKILL");
                } catch {
                  // ignore — best effort
                }
              }
            }, 5_000);
            killTimer.unref();
          });
        }
      }
    },
    60_000,
  );
});
