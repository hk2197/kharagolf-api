/**
 * Highlight reel render queue (Task #418).
 *
 * Renders used to run in-process inside the API server via setImmediate,
 * which spawned ffmpeg on the same dyno that serves all other HTTP requests.
 * For long videos that stalls the event loop and risks OOM-killing the API.
 *
 * This module owns the lightweight job-queue contract used by the API and
 * by the dedicated worker process (`src/highlightWorker.ts`). The queue is
 * backed by columns on `highlight_reels` itself (no extra tables, no extra
 * runtime dependency):
 *
 *   - status='queued' + next_attempt_at <= now()  → ready to run
 *   - status='rendering'                         → currently being processed
 *   - status='ready'                             → finished
 *   - status='failed'                            → exhausted retries
 *   - attempts                                   → 0-based retry counter
 *
 * Workers claim a single ready row with `SELECT ... FOR UPDATE SKIP LOCKED`
 * inside a transaction, flip the status to 'rendering', and run the actual
 * ffmpeg pipeline outside the transaction. Failures schedule an exponential
 * backoff retry; success leaves status='ready'.
 */
import { db, highlightReelsTable } from "@workspace/db";
import { and, eq, lte, sql } from "drizzle-orm";

export const MAX_ATTEMPTS = 4;

/** Rough average render time per reel, used to estimate "time to my turn"
 * for waiting players. Real renders vary widely with photo count and
 * template; this is intentionally conservative so we under-promise. */
export const AVG_RENDER_SECONDS = 45;

/** Backoff in seconds — 30s, 2m, 8m, 30m. Caps total retry window at ~40m. */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * Math.pow(4, Math.max(0, attempts - 1)), 30 * 60);
}

/**
 * Mark a reel as queued and ready to run NOW. Called by the API on create
 * and on re-render. Resets attempts and clears any previous error so the
 * worker treats this as a fresh run.
 */
export async function enqueueRender(reelId: number): Promise<void> {
  await db.update(highlightReelsTable).set({
    status: "queued",
    attempts: 0,
    nextAttemptAt: new Date(),
    errorMessage: null,
    renderStartedAt: null,
    renderCompletedAt: null,
    updatedAt: new Date(),
  }).where(eq(highlightReelsTable.id, reelId));
}

/**
 * Atomically claim the next ready render. Returns the reel id, or null if
 * no work is available. Uses FOR UPDATE SKIP LOCKED so multiple worker
 * instances can run in parallel without double-processing a row.
 */
export async function claimNextRender(): Promise<number | null> {
  // We can't easily express FOR UPDATE SKIP LOCKED + UPDATE ... RETURNING
  // through drizzle's fluent builder, so use a single CTE round-trip.
  const result = await db.execute<{ id: number }>(sql`
    WITH claimed AS (
      SELECT id
      FROM highlight_reels
      WHERE status = 'queued'
        AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE highlight_reels h
    SET status = 'rendering',
        attempts = h.attempts + 1,
        render_started_at = now(),
        updated_at = now()
    FROM claimed
    WHERE h.id = claimed.id
    RETURNING h.id
  `);
  const row = result.rows[0];
  return row ? Number(row.id) : null;
}

/**
 * Schedule a failed render for retry, or mark it permanently failed once
 * the attempt cap is reached. Always called from the worker after the
 * render pipeline throws.
 */
export async function recordFailure(reelId: number, errorMessage: string): Promise<void> {
  const [row] = await db.select({ attempts: highlightReelsTable.attempts })
    .from(highlightReelsTable).where(eq(highlightReelsTable.id, reelId)).limit(1);
  const attempts = row?.attempts ?? 0;
  const trimmed = errorMessage.slice(0, 500);
  if (attempts >= MAX_ATTEMPTS) {
    await db.update(highlightReelsTable).set({
      status: "failed",
      errorMessage: trimmed,
      renderCompletedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(highlightReelsTable.id, reelId));
    return;
  }
  const delay = backoffSeconds(attempts);
  const next = new Date(Date.now() + delay * 1000);
  await db.update(highlightReelsTable).set({
    status: "queued",
    errorMessage: trimmed,
    nextAttemptAt: next,
    updatedAt: new Date(),
  }).where(eq(highlightReelsTable.id, reelId));
}

/**
 * How many reels are currently queued and ready to run (next_attempt_at <= now).
 * Used to surface queue depth on the API responses so waiting players can see
 * roughly how busy the worker is.
 */
export async function getQueueDepth(): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM highlight_reels
    WHERE status = 'queued' AND next_attempt_at <= now()
  `);
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * Compute the queue position (1 = next in line) for a single reel that is
 * currently queued. Returns null when the reel is not queued, not ready
 * yet (its next_attempt_at is in the future), or otherwise not waiting.
 *
 * Position counts queued+ready reels with an earlier next_attempt_at, plus
 * those with the same timestamp but a smaller id, matching the ORDER BY
 * used by claimNextRender. We add 1 so the row's own position is 1-based.
 */
export async function getQueuePosition(reelId: number): Promise<number | null> {
  const result = await db.execute<{ pos: number }>(sql`
    WITH me AS (
      SELECT id, next_attempt_at, status
      FROM highlight_reels
      WHERE id = ${reelId}
    )
    SELECT (
      SELECT count(*)::int
      FROM highlight_reels h, me
      WHERE h.status = 'queued'
        AND h.next_attempt_at <= now()
        AND me.status = 'queued'
        AND me.next_attempt_at <= now()
        AND (
          h.next_attempt_at < me.next_attempt_at
          OR (h.next_attempt_at = me.next_attempt_at AND h.id < me.id)
        )
    ) + 1 AS pos
    FROM me
    WHERE me.status = 'queued' AND me.next_attempt_at <= now()
  `);
  const row = result.rows[0];
  return row ? Number(row.pos) : null;
}

/**
 * Best-effort sweep: any rows that have been 'rendering' for longer than the
 * stale window are treated as crashed workers and re-queued for another
 * attempt. The worker calls this periodically so crashes don't strand jobs.
 */
export async function recoverStaleRendering(staleAfterSeconds = 15 * 60): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterSeconds * 1000);
  const result = await db.update(highlightReelsTable).set({
    status: "queued",
    nextAttemptAt: new Date(),
    errorMessage: "Worker crashed mid-render — retrying",
    updatedAt: new Date(),
  }).where(and(
    eq(highlightReelsTable.status, "rendering"),
    lte(highlightReelsTable.renderStartedAt, cutoff),
  )).returning({ id: highlightReelsTable.id });
  return result.length;
}
