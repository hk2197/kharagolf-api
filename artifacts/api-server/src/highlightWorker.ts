/**
 * Highlight render worker (Task #418).
 *
 * Standalone Node process. Polls highlight_reels for queued renders, claims
 * them with FOR UPDATE SKIP LOCKED, runs the ffmpeg pipeline outside the
 * API server, and reports success or schedules a retry. Multiple workers
 * can run in parallel — the SKIP LOCKED claim guarantees each row is
 * processed by exactly one worker.
 *
 * Run with:   node ./dist/highlightWorker.mjs
 */
import { executeRender } from "./lib/highlightRender";
import { claimNextRender, recordFailure, recoverStaleRendering } from "./lib/highlightQueue";
import { notifyHighlightReady } from "./lib/notifications";
import { logger } from "./lib/logger";

const IDLE_POLL_MS = Number(process.env["HIGHLIGHT_WORKER_POLL_MS"] ?? 2000);
const STALE_SWEEP_MS = Number(process.env["HIGHLIGHT_WORKER_STALE_SWEEP_MS"] ?? 60_000);

let running = true;

export async function processOne(): Promise<boolean> {
  const reelId = await claimNextRender();
  if (reelId == null) return false;
  logger.info({ reelId }, "[highlight-worker] claimed render");
  try {
    await executeRender(reelId);
    logger.info({ reelId }, "[highlight-worker] render succeeded");
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    logger.error({ reelId, err }, "[highlight-worker] render failed — scheduling retry");
    try {
      await recordFailure(reelId, msg);
    } catch (bookkeepErr) {
      logger.error({ reelId, err: bookkeepErr }, "[highlight-worker] failed to record failure");
    }
  }
  // Tell the player the moment their reel hits a terminal state. Skips
  // silently when the row is still queued for retry, so transient ffmpeg
  // failures don't spam the user with "failed" pushes.
  try {
    const result = await notifyHighlightReady(reelId);
    if (result.status === "sent") {
      logger.info({ reelId, reelStatus: result.reelStatus }, "[highlight-worker] notified player");
    }
  } catch (notifyErr) {
    logger.warn({ reelId, err: notifyErr }, "[highlight-worker] notify failed");
  }
  return true;
}

async function staleSweepLoop(): Promise<void> {
  while (running) {
    try {
      const recovered = await recoverStaleRendering();
      if (recovered > 0) {
        logger.warn({ recovered }, "[highlight-worker] requeued stale 'rendering' rows");
      }
    } catch (err) {
      logger.error({ err }, "[highlight-worker] stale sweep failed");
    }
    await sleep(STALE_SWEEP_MS);
  }
}

async function mainLoop(): Promise<void> {
  while (running) {
    try {
      const did = await processOne();
      if (!did) await sleep(IDLE_POLL_MS);
    } catch (err) {
      logger.error({ err }, "[highlight-worker] main loop error");
      await sleep(IDLE_POLL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shutdown(signal: string): void {
  logger.info({ signal }, "[highlight-worker] shutting down");
  running = false;
  // Give the in-flight render a generous window to finish before forcing exit.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Auto-start the polling loops when run as the worker entry point. Tests
// import this module to exercise `processOne` in isolation and set
// HIGHLIGHT_WORKER_DISABLE_AUTOSTART=1 so the loops don't keep the process
// alive or race with the test's DB fixtures.
if (!process.env["HIGHLIGHT_WORKER_DISABLE_AUTOSTART"]) {
  logger.info({ pollMs: IDLE_POLL_MS }, "[highlight-worker] starting");
  Promise.all([mainLoop(), staleSweepLoop()]).catch(err => {
    logger.error({ err }, "[highlight-worker] fatal");
    process.exit(1);
  });
}
