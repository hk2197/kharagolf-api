/**
 * Swing-video frame-rate probe worker (Task #1217).
 *
 * Standalone Node process. Polls swing_video_fps_probes for queued probes,
 * claims them with FOR UPDATE SKIP LOCKED, runs ffprobe, and reports
 * success or schedules a retry. Multiple workers can run in parallel —
 * the SKIP LOCKED claim guarantees each row is processed by exactly one
 * worker.
 *
 * Modeled on `highlightWorker.ts` (Task #418). Runs as a separate process
 * from the API server so a slow ffprobe doesn't add latency to API
 * responses, and so the API server restarting (deploy / crash) doesn't
 * lose any in-flight probe state — pending probes live in Postgres.
 *
 * Run with:   node ./dist/swingFpsProbeWorker.mjs
 */
import {
  processOneFpsProbe,
  recoverStaleFpsProbing,
} from "./lib/swingFpsProbeQueue";
import { logger } from "./lib/logger";

const IDLE_POLL_MS = Number(process.env["SWING_FPS_WORKER_POLL_MS"] ?? 2000);
const STALE_SWEEP_MS = Number(process.env["SWING_FPS_WORKER_STALE_SWEEP_MS"] ?? 60_000);

let running = true;

/** Re-exported so tests can drive a single iteration without spinning up
 * the polling loops. */
export async function processOne(): Promise<boolean> {
  return processOneFpsProbe();
}

async function staleSweepLoop(): Promise<void> {
  while (running) {
    try {
      const recovered = await recoverStaleFpsProbing();
      if (recovered > 0) {
        logger.warn({ recovered }, "[swing-fps-worker] requeued stale 'probing' rows");
      }
    } catch (err) {
      logger.error({ err }, "[swing-fps-worker] stale sweep failed");
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
      logger.error({ err }, "[swing-fps-worker] main loop error");
      await sleep(IDLE_POLL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shutdown(signal: string): void {
  logger.info({ signal }, "[swing-fps-worker] shutting down");
  running = false;
  // Give the in-flight ffprobe a generous window to finish before forcing exit.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Auto-start the polling loops when run as the worker entry point. Tests
// import this module to exercise `processOne` in isolation and set
// SWING_FPS_WORKER_DISABLE_AUTOSTART=1 so the loops don't keep the
// process alive or race with the test's DB fixtures.
if (!process.env["SWING_FPS_WORKER_DISABLE_AUTOSTART"]) {
  logger.info({ pollMs: IDLE_POLL_MS }, "[swing-fps-worker] starting");
  Promise.all([mainLoop(), staleSweepLoop()]).catch(err => {
    logger.error({ err }, "[swing-fps-worker] fatal");
    process.exit(1);
  });
}
