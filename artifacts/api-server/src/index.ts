import { createServer } from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { startCronJobs } from "./lib/cron";
import { validateMailerConfig } from "./lib/mailer";
import { attachWatchWebSocketServer } from "./routes/ws-watch";
import { ensurePlanConfigsSeed } from "./lib/planConfigLoader";
import { hydrate as hydrateNotificationRegistry } from "./lib/notificationRegistry";
import {
  hydrateMutedSessionsFromDb,
  resolveWatchMuteResyncIntervalMs,
  startWatchMuteResyncLoop,
} from "./lib/watchPositionMetrics";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Create a plain Node.js HTTP server so we can attach WebSocket support
// alongside the Express app without changing any existing middleware.
const httpServer = createServer(app);

// Attach /ws/watch WebSocket endpoint (Apple Watch & Wear OS companion)
attachWatchWebSocketServer(httpServer);

httpServer.listen(port, () => {
  logger.info({ port }, "Server listening");

  // Validate email transport configuration at startup
  validateMailerConfig();

  // Seed subscription_plan_configs with canonical defaults for all 4 tiers
  // (INSERT ... ON CONFLICT DO NOTHING — existing admin-edited rows are preserved)
  ensurePlanConfigsSeed().catch((err) => {
    logger.warn({ err }, "[plan-seed] Failed to seed plan configs — hardcoded fallback will be used");
  });

  // Wave 2 (Task #937): hydrate the notification type registry so future
  // dispatch helpers can call assertRegistered(key) on the hot path.
  hydrateNotificationRegistry().catch((err) => {
    logger.warn({ err }, "[notification-registry] Failed to hydrate — assertRegistered will throw until next boot");
  });

  // Task #1679: re-load any active watch session mutes from the persisted
  // store so a deploy / restart doesn't silently lift them. Failures here
  // log a warn and let boot proceed — without hydration the in-memory Map
  // simply starts empty (matches the pre-#1679 behaviour we are replacing,
  // so a transient DB blip on boot is no worse than the old default).
  hydrateMutedSessionsFromDb().catch((err) => {
    logger.warn({ err }, "[watch-session-mutes] Failed to hydrate from DB — active mutes may not survive this restart");
  });

  // Task #2090 / #2120: periodically reconcile this replica's
  // in-memory mute Map with the persisted `watch_session_mutes` table
  // so a mute / unmute issued via a *different* api-server replica
  // propagates here without the watch having to drop its socket. The
  // DB row is the source of truth; each replica converges within
  // `WATCH_MUTE_RESYNC_MS` (default 5s, well inside Task #2120's
  // ~30s target). Override via the env var if a deployment wants
  // tighter / looser convergence — values below the 1s floor snap
  // back to the default so an env-var typo can't hammer the DB.
  // The helper unref's the timer so it never blocks process shutdown.
  const watchMuteResyncIntervalMs = resolveWatchMuteResyncIntervalMs(
    process.env.WATCH_MUTE_RESYNC_MS,
  );
  startWatchMuteResyncLoop({ intervalMs: watchMuteResyncIntervalMs });
  logger.info(
    { intervalMs: watchMuteResyncIntervalMs, watchPosition: true },
    "[watch-session-mutes] periodic cross-replica resync loop started",
  );

  // Start background cron jobs
  startCronJobs();
});

httpServer.on("error", (err: Error) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
