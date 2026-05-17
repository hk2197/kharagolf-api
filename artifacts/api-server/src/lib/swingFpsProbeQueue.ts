/**
 * Swing-video frame-rate probe queue.
 *
 * History:
 *   - Task #910 ran the ffprobe inline inside POST /api/swing-videos, which
 *     added noticeable upload-completion latency on patchy networks.
 *   - Task #1057 moved it into an in-process background scheduler with a
 *     short retry chain so the upload-completion request returned the
 *     moment the row was inserted.
 *   - Task #1217 makes those probes durable. The in-process scheduler
 *     died with the API process, so any swing video uploaded right before
 *     a deploy / crash / scale-down kept fps=NULL until somebody re-ran
 *     the manual backfill script. We now persist every pending probe in
 *     `swing_video_fps_probes` and a standalone worker
 *     (`swingFpsProbeWorker.ts`) claims them with FOR UPDATE SKIP LOCKED,
 *     mirroring the durable highlight-render queue from Task #418.
 *
 * The route still calls `scheduleFpsProbe(swingVideoId, objectPath)`; that
 * call now does a single INSERT … ON CONFLICT DO NOTHING (cheap, unlikely
 * to add measurable latency to the upload-completion request) and returns.
 * Tests can `await waitForPendingFpsProbes()` to drain the queue
 * deterministically without spinning up the worker process.
 */
import { db, swingVideoFpsProbesTable, swingVideosTable } from "@workspace/db";
import { and, eq, isNull, lt, lte, sql } from "drizzle-orm";
import { probeVideoFps } from "./videoFps";
import { logger } from "./logger";

/**
 * Retention window for terminal-state probe rows. The unique index on
 * `swing_video_id` guarantees one row per video, so without a sweep the
 * table grows monotonically as more swing videos are uploaded.
 *
 * Why 30 days for `done`: by the time a probe is `done`, swing_videos.fps
 * is populated, so deleting the probe row never causes a re-probe race —
 * `enqueueFpsProbe` does `INSERT … ON CONFLICT DO NOTHING` and a
 * subsequent fresh row would simply trigger another probe (which would
 * succeed instantly using the now-stored object). 30 days gives ample
 * audit visibility for triaging recent ingest issues without growing
 * unbounded.
 *
 * Why we keep `failed`: a `failed` row means MAX_FPS_PROBE_ATTEMPTS
 * exhausted itself against a real, persistent problem (corrupt object,
 * unreachable storage). Operators want those visible until they're
 * triaged, so the sweep deliberately leaves them alone.
 */
export const FPS_PROBE_DONE_RETENTION_DAYS = 30;

/** A drizzle executor — either the global `db` handle or an open
 * transaction. Lets the route enqueue the probe in the same transaction
 * that inserts the swing_videos row, so a crash between the two writes
 * cannot strand a video with fps=NULL and no queue row. */
type TxArg = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbExecutor = typeof db | TxArg;

/** Cap on retry attempts before we give up and mark the row 'failed'. */
export const MAX_FPS_PROBE_ATTEMPTS = 5;

/** Backoff in seconds — 5s, 30s, 2m, 8m, 30m. Caps total retry window
 * around 40m so a transient storage hiccup recovers quickly while a
 * permanently broken object eventually stops retrying. */
export function fpsProbeBackoffSeconds(attempts: number): number {
  // attempts is the post-increment count: 1 → first failure → 5s wait
  const base = 5 * Math.pow(4, Math.max(0, attempts - 1));
  return Math.min(base, 30 * 60);
}

/**
 * Persistently enqueue an fps probe for a freshly inserted swing video.
 * Idempotent: re-enqueue on the same swingVideoId is a no-op (the unique
 * index guarantees one probe row per video). Called by POST /api/swing
 * -videos in the same transaction that inserts the swing_videos row, so
 * a crash between the two writes cannot strand a video with fps=NULL
 * and no queue row.
 */
export async function enqueueFpsProbe(
  swingVideoId: number,
  objectPath: string,
  executor: DbExecutor = db,
): Promise<void> {
  await executor.insert(swingVideoFpsProbesTable)
    .values({
      swingVideoId,
      objectPath,
      status: "queued",
      attempts: 0,
      nextAttemptAt: new Date(),
    })
    .onConflictDoNothing({ target: swingVideoFpsProbesTable.swingVideoId });
}

/**
 * Backwards-compatible alias for the previous in-process scheduler. The
 * route used to fire-and-forget this; we still accept that shape so the
 * caller doesn't need to change, but we now durably persist the probe
 * before returning. Errors are logged but not thrown — leaving the row
 * with NULL fps (and surfacing later via the manual backfill script) is
 * preferable to failing the upload-completion response.
 */
export async function scheduleFpsProbe(swingVideoId: number, objectPath: string): Promise<void> {
  try {
    await enqueueFpsProbe(swingVideoId, objectPath);
  } catch (err) {
    logger.error({ err, swingVideoId }, "[swing-fps-probe] enqueue failed");
  }
}

/**
 * Task #1411 — Bulk-enqueue every legacy swing video that still has
 * fps=NULL into the durable probe queue, so the standalone worker can
 * drain them with the same retry/backoff/crash-recovery semantics that
 * fresh uploads get. Replaces the old inline-probe loop in
 * `scripts/backfillSwingVideoFps.ts`, which would download and probe
 * every legacy object inside the script process and could not survive
 * the script being killed mid-run.
 *
 * Implemented as a single INSERT … SELECT … ON CONFLICT DO NOTHING so
 * the whole backfill is one round-trip and re-running it is a cheap
 * no-op: the `swing_video_fps_probes_video_uniq` index drops any row
 * we've already enqueued (regardless of its current status — queued,
 * probing, done, or failed) and we never clobber the probe row's
 * attempts/error_message/etc. Returns counts so the script can log a
 * meaningful summary.
 */
export async function enqueueLegacyFpsProbes(): Promise<{
  legacyCount: number;
  newlyEnqueued: number;
}> {
  const [legacyRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(swingVideosTable)
    .where(isNull(swingVideosTable.fps));
  const legacyCount = Number(legacyRow?.count ?? 0);

  if (legacyCount === 0) {
    return { legacyCount: 0, newlyEnqueued: 0 };
  }

  const result = await db.execute<{ swing_video_id: number }>(sql`
    INSERT INTO swing_video_fps_probes (swing_video_id, object_path)
    SELECT id, video_url FROM swing_videos WHERE fps IS NULL
    ON CONFLICT (swing_video_id) DO NOTHING
    RETURNING swing_video_id
  `);
  return { legacyCount, newlyEnqueued: result.rows.length };
}

/**
 * Atomically claim the next ready probe. Returns the probe row, or null if
 * no work is available. Uses FOR UPDATE SKIP LOCKED so multiple workers
 * can run in parallel without double-claiming a single row, mirroring
 * `claimNextRender` in highlightQueue.
 */
export interface ClaimedFpsProbe {
  id: number;
  swingVideoId: number;
  objectPath: string;
  attempts: number;
}

export async function claimNextFpsProbe(): Promise<ClaimedFpsProbe | null> {
  const result = await db.execute<{
    id: number;
    swing_video_id: number;
    object_path: string;
    attempts: number;
  }>(sql`
    WITH claimed AS (
      SELECT id
      FROM swing_video_fps_probes
      WHERE status = 'queued'
        AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE swing_video_fps_probes p
    SET status = 'probing',
        attempts = p.attempts + 1,
        started_at = now(),
        updated_at = now()
    FROM claimed
    WHERE p.id = claimed.id
    RETURNING p.id, p.swing_video_id, p.object_path, p.attempts
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    swingVideoId: Number(row.swing_video_id),
    objectPath: String(row.object_path),
    attempts: Number(row.attempts),
  };
}

/**
 * Mark a probe as successful: persist the detected fps onto the swing_videos
 * row and flip the probe row to 'done'. Both writes share a transaction so
 * we never publish an fps without recording the probe outcome.
 */
export async function recordFpsProbeSuccess(probeId: number, swingVideoId: number, fps: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(swingVideosTable)
      .set({ fps: String(fps) })
      .where(eq(swingVideosTable.id, swingVideoId));
    await tx.update(swingVideoFpsProbesTable).set({
      status: "done",
      errorMessage: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(swingVideoFpsProbesTable.id, probeId));
  });
}

/**
 * Schedule a failed probe for retry, or mark it permanently 'failed' once
 * the attempt cap is reached. Called from the worker after probeVideoFps
 * throws or returns null. Mirrors `recordFailure` in highlightQueue.
 */
export async function recordFpsProbeFailure(probeId: number, errorMessage: string): Promise<void> {
  const [row] = await db.select({ attempts: swingVideoFpsProbesTable.attempts })
    .from(swingVideoFpsProbesTable)
    .where(eq(swingVideoFpsProbesTable.id, probeId))
    .limit(1);
  const attempts = row?.attempts ?? 0;
  const trimmed = errorMessage.slice(0, 500);
  if (attempts >= MAX_FPS_PROBE_ATTEMPTS) {
    await db.update(swingVideoFpsProbesTable).set({
      status: "failed",
      errorMessage: trimmed,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(swingVideoFpsProbesTable.id, probeId));
    return;
  }
  const delay = fpsProbeBackoffSeconds(attempts);
  const next = new Date(Date.now() + delay * 1000);
  await db.update(swingVideoFpsProbesTable).set({
    status: "queued",
    errorMessage: trimmed,
    nextAttemptAt: next,
    updatedAt: new Date(),
  }).where(eq(swingVideoFpsProbesTable.id, probeId));
}

/**
 * Best-effort sweep: any rows that have been 'probing' for longer than the
 * stale window are treated as crashed workers and re-queued for another
 * attempt. The worker calls this periodically so SIGKILL'd ffprobe
 * processes don't strand swing videos with NULL fps.
 */
export async function recoverStaleFpsProbing(staleAfterSeconds = 5 * 60): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterSeconds * 1000);
  const result = await db.update(swingVideoFpsProbesTable).set({
    status: "queued",
    nextAttemptAt: new Date(),
    errorMessage: "Worker crashed mid-probe — retrying",
    updatedAt: new Date(),
  }).where(and(
    eq(swingVideoFpsProbesTable.status, "probing"),
    lte(swingVideoFpsProbesTable.startedAt, cutoff),
  )).returning({ id: swingVideoFpsProbesTable.id });
  return result.length;
}

/**
 * Run a single claim → probe → record cycle. Exported for both the
 * standalone worker's main loop and for tests that want to drain the
 * queue without spinning up a separate process. Returns true if a probe
 * was processed (success or failure), false if there was no work.
 */
export async function processOneFpsProbe(): Promise<boolean> {
  const claim = await claimNextFpsProbe();
  if (!claim) return false;
  let fps: number | null = null;
  let probeError: string | null = null;
  try {
    fps = await probeVideoFps(claim.objectPath);
    if (fps == null) probeError = "ffprobe returned no usable frame rate";
  } catch (err) {
    probeError = (err as Error)?.message ?? String(err);
    logger.warn({ err, swingVideoId: claim.swingVideoId, attempts: claim.attempts }, "[swing-fps-probe] ffprobe threw");
  }
  if (fps != null) {
    try {
      await recordFpsProbeSuccess(claim.id, claim.swingVideoId, fps);
      logger.info({ swingVideoId: claim.swingVideoId, fps, attempts: claim.attempts }, "[swing-fps-probe] persisted");
      return true;
    } catch (err) {
      probeError = (err as Error)?.message ?? String(err);
      logger.error({ err, swingVideoId: claim.swingVideoId, fps }, "[swing-fps-probe] persist failed; will retry");
    }
  }
  try {
    await recordFpsProbeFailure(claim.id, probeError ?? "unknown probe failure");
  } catch (bookkeepErr) {
    logger.error({ err: bookkeepErr, swingVideoId: claim.swingVideoId }, "[swing-fps-probe] failed to record failure");
  }
  return true;
}

/**
 * Drain every queued probe synchronously by repeatedly calling
 * processOneFpsProbe. Intended for tests, where the standalone worker
 * isn't running and we want deterministic ordering. Bounded by a
 * generous safety cap so a buggy probe loop can't hang the test runner.
 */
export async function waitForPendingFpsProbes(safetyCap = 100): Promise<void> {
  for (let i = 0; i < safetyCap; i++) {
    const did = await processOneFpsProbe();
    if (!did) return;
  }
  logger.warn({ safetyCap }, "[swing-fps-probe] waitForPendingFpsProbes hit safety cap");
}

/**
 * Task #1709 — Snapshot of the durable probe queue's current state for
 * operators / admin tooling.
 *
 * After Task #1411 turned `backfill:swing-video-fps` into a one-shot
 * enqueue, ops had no easy way to see whether the standalone worker was
 * actually draining the queue without dropping into psql. This helper
 * returns the same numbers triagers used to compute by hand:
 *
 *   • `byStatus` — row counts for every value of the
 *     `swing_video_fps_probe_status` enum. Statuses with zero rows are
 *     still present (set to 0) so the response shape is stable for
 *     dashboards and the test below.
 *   • `oldestQueuedNextAttemptAt` — the `next_attempt_at` of the oldest
 *     row currently in `queued`. If the worker is healthy this should
 *     hover near `now()`; a value drifting further into the past is the
 *     signal that the queue is stuck.
 *   • `total` — convenience sum, same as `Object.values(byStatus).reduce(+)`.
 *
 * The query is two cheap aggregates over `swing_video_fps_probes`,
 * which is bounded (one row per swing video, plus the 30-day `done`
 * retention sweep) and indexed on `(status, next_attempt_at)`.
 */
export type FpsProbeQueueStats = {
  byStatus: Record<"queued" | "probing" | "done" | "failed", number>;
  total: number;
  oldestQueuedNextAttemptAt: string | null;
};

export async function getFpsProbeQueueStats(): Promise<FpsProbeQueueStats> {
  const grouped = await db
    .select({
      status: swingVideoFpsProbesTable.status,
      n: sql<number>`count(*)::int`,
    })
    .from(swingVideoFpsProbesTable)
    .groupBy(swingVideoFpsProbesTable.status);

  const byStatus: FpsProbeQueueStats["byStatus"] = {
    queued: 0,
    probing: 0,
    done: 0,
    failed: 0,
  };
  for (const row of grouped) {
    // status is the enum from the schema; cast through the keyof so a
    // future enum value would surface as a TS error here rather than
    // being silently dropped.
    const key = row.status as keyof FpsProbeQueueStats["byStatus"];
    byStatus[key] = Number(row.n ?? 0);
  }
  const total = byStatus.queued + byStatus.probing + byStatus.done + byStatus.failed;

  const [oldestRow] = await db
    .select({ nextAttemptAt: swingVideoFpsProbesTable.nextAttemptAt })
    .from(swingVideoFpsProbesTable)
    .where(eq(swingVideoFpsProbesTable.status, "queued"))
    .orderBy(swingVideoFpsProbesTable.nextAttemptAt)
    .limit(1);

  return {
    byStatus,
    total,
    oldestQueuedNextAttemptAt: oldestRow?.nextAttemptAt
      ? new Date(oldestRow.nextAttemptAt).toISOString()
      : null,
  };
}

/**
 * Periodic retention sweep for the durable probe queue.
 *
 * Deletes `done` rows whose `completedAt` is older than
 * `retentionDays` (default {@link FPS_PROBE_DONE_RETENTION_DAYS}). The
 * unique index on `swing_video_id` plus `onConflictDoNothing` in
 * `enqueueFpsProbe` make this safe: by the time a row is `done`,
 * `swing_videos.fps` is already populated, so even if a future upload
 * somehow re-used the same swing_video_id (it can't — videos are
 * insert-only), the worst case would be one extra successful probe.
 *
 * `failed` rows are intentionally left in place so persistent failures
 * stay visible to operators. The returned `failedRetained` count makes
 * it easy for the cron logger / future ops alert to surface a growing
 * failure backlog without having to issue a separate query.
 */
export async function sweepOldFpsProbes(
  retentionDays = FPS_PROBE_DONE_RETENTION_DAYS,
): Promise<{ removedDone: number; failedRetained: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const removed = await db
    .delete(swingVideoFpsProbesTable)
    .where(and(
      eq(swingVideoFpsProbesTable.status, "done"),
      lt(swingVideoFpsProbesTable.completedAt, cutoff),
    ))
    .returning({ id: swingVideoFpsProbesTable.id });
  const removedDone = removed.length;

  const [failedCountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(swingVideoFpsProbesTable)
    .where(eq(swingVideoFpsProbesTable.status, "failed"));
  const failedRetained = failedCountRow?.n ?? 0;

  if (removedDone > 0 || failedRetained > 0) {
    logger.info(
      { removedDone, failedRetained, retentionDays, cutoff: cutoff.toISOString() },
      "[swing-fps-probe] retention sweep complete",
    );
  } else {
    logger.debug(
      { removedDone, failedRetained, retentionDays, cutoff: cutoff.toISOString() },
      "[swing-fps-probe] retention sweep: nothing to do",
    );
  }

  return { removedDone, failedRetained };
}
