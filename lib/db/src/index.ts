import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool, Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema";

// Task #2016 — Cancel an in-flight Postgres query running on a specific
// backend PID. Used by long-running streaming endpoints (e.g. the admin
// audit CSV export) so that when the client disconnects mid-export we
// can stop the in-flight `FETCH` immediately instead of waiting for it
// to drain naturally before the loop can break and release the pool
// connection.
//
// Cancellation is delivered via Postgres' `pg_cancel_backend(pid)`,
// which requires a *separate* session — the pure-JS node-postgres
// client doesn't expose the wire-level CANCEL_REQUEST primitive that
// the native binding does. We open a one-off `Client` (not via the
// shared pool) so that callers can never deadlock waiting for a free
// pool slot to issue the cancel: the streaming export itself may be
// holding the last pool slot when the abort fires.
//
// Exported as an object property so tests can stub or spy on the
// behaviour without breaking other consumers of `@workspace/db`.
export const dbCancellation = {
  async cancelBackend(pid: number): Promise<void> {
    const cancellor = new Client({
      connectionString: process.env.DATABASE_URL,
      // Cap the connect attempt — if the database is unreachable
      // there's nothing useful we can do with the cancel and we don't
      // want the helper to hang forever holding a stale socket.
      connectionTimeoutMillis: 5_000,
    });
    await cancellor.connect();
    try {
      await cancellor.query("SELECT pg_cancel_backend($1)", [pid]);
    } finally {
      try { await cancellor.end(); } catch { /* best-effort */ }
    }
  },
};
