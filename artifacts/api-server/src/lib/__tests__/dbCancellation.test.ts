/**
 * Task #2016 — `dbCancellation.cancelBackend(pid)` exercise.
 *
 * The streaming audit CSV export (Task #1623) uses this helper to
 * interrupt the in-flight Postgres `FETCH` when an admin closes their
 * tab mid-download, so the pool connection is released within a
 * fraction of a second instead of after the next FETCH boundary.
 *
 * This test pins the underlying primitive in isolation:
 *   • A long-running query (`SELECT pg_sleep(…)`) is started on one
 *     pooled session.
 *   • A second connection is asked for that session's PID via
 *     `pg_backend_pid()` and `cancelBackend(pid)` is invoked.
 *   • The long-running query rejects with the `query_canceled`
 *     SQLSTATE (`57014`) within hundreds of milliseconds — well under
 *     the natural sleep duration — proving the cancel actually
 *     interrupted the running statement.
 *   • The originally-blocked client is still usable for a follow-up
 *     query after `ROLLBACK`, confirming we only cancelled the
 *     statement, not the session.
 */
import { describe, it, expect } from "vitest";
import { pool, dbCancellation } from "@workspace/db";

describe("dbCancellation.cancelBackend", () => {
  it("interrupts a long-running statement on another session within ms", async () => {
    const victim = await pool.connect();
    try {
      // Capture the victim session's PID so the cancellor can target
      // it. `pg_backend_pid()` returns the PID of the *current*
      // session, so it must run on the same client we're about to
      // block.
      const pidRow = await victim.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const pid = pidRow.rows[0]?.pid;
      expect(typeof pid).toBe("number");
      expect(pid).toBeGreaterThan(0);

      // Kick off a 30-second sleep on the victim session. We don't
      // await it here — we want the cancel to land while it's still
      // in flight. Wrap rejections so node doesn't briefly mark the
      // promise as unhandled while we're racing the cancel.
      const startedAt = Date.now();
      const errorBox: { value: { code?: string } | null } = { value: null };
      const sleepPromise = victim
        .query("SELECT pg_sleep(30)")
        .then(() => { /* unexpected — assertion below catches it */ })
        .catch((err: unknown) => {
          errorBox.value = (err ?? null) as { code?: string } | null;
        });

      // Give Postgres a moment to actually start executing the sleep
      // before we ask another session to cancel it. Without this
      // small wait the cancel can race ahead of the statement and
      // the sleep would still complete normally.
      await new Promise((r) => setTimeout(r, 50));

      // Issue the cancel from a *separate* connection. The helper
      // opens its own one-off `Client` so it never blocks waiting
      // for a free pool slot.
      await dbCancellation.cancelBackend(pid as number);

      // The sleep should now reject with SQLSTATE 57014
      // (`query_canceled`) almost immediately — orders of magnitude
      // faster than the 30-second natural duration.
      await sleepPromise;
      const elapsed = Date.now() - startedAt;
      expect(errorBox.value).not.toBeNull();
      expect(errorBox.value?.code).toBe("57014");
      // 5s is generous — we expect this to land in well under a
      // second on a healthy DB, but loaded CI runners can drift.
      // The point is to fail loudly if the cancel didn't actually
      // interrupt the sleep (which would be ~30s).
      expect(elapsed).toBeLessThan(5_000);

      // The session itself is still alive — only the statement was
      // cancelled. After a ROLLBACK we can run another query on it,
      // confirming the connection can be safely returned to the
      // pool. (The cancelled statement leaves the implicit
      // transaction in an aborted state, hence the ROLLBACK.)
      try { await victim.query("ROLLBACK"); } catch { /* no tx */ }
      const followUp = await victim.query<{ alive: number }>(
        "SELECT 1 AS alive",
      );
      expect(followUp.rows[0]?.alive).toBe(1);
    } finally {
      victim.release();
    }
  });

  it("is a no-op when the target PID does not exist", async () => {
    // `pg_cancel_backend` returns false (and emits a warning notice)
    // for unknown PIDs rather than throwing — we want the helper to
    // surface that as a clean resolution so callers can rely on
    // `.catch()` only firing on real failures (network down, auth
    // misconfigured, etc.).
    await expect(dbCancellation.cancelBackend(2_147_483_646)).resolves.toBeUndefined();
  });
});
