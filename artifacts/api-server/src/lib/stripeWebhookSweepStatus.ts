/**
 * Task #1294 — Last-result accessor for the daily `stripe_webhook_deliveries`
 * retention sweep (Task #1125).
 *
 * The actual sweep lives in `cron.ts` (`sweepOldStripeWebhookDeliveries`).
 * After each run it persists a row to `stripe_webhook_sweep_runs` and updates
 * the in-memory cache exported here. The admin Stripe webhook audit route
 * reads from this module so it can surface the sweep summary without having
 * to import the (very large) `cron.ts` module — that would pull mailer /
 * comms / etc. into the route's dependency graph and is hostile to the
 * existing route-level test mocks.
 */
import { db, stripeWebhookSweepRunsTable } from "@workspace/db";
import { desc, gte } from "drizzle-orm";
import { logger } from "./logger";

export interface StripeWebhookSweepStatus {
  ranAt: string; // ISO timestamp
  removed: number;
}

/**
 * Task #1295 — How long the admin tile waits before flagging the daily
 * `stripe_webhook_deliveries` retention sweep as "stalled". The sweep is
 * scheduled every 24h; we give it a 12h grace window before raising a
 * warning so a slightly delayed cron run doesn't trip the alert.
 */
export const STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

let _lastStripeWebhookSweepResult: StripeWebhookSweepStatus | null = null;
let _lastStripeWebhookSweepCacheLoaded = false;

// Used by {@link isStripeWebhookSweepStale} to decide when a `null` last-sweep
// reading should be treated as a problem. Right after a fresh deploy `null` is
// expected (the next daily sweep just hasn't fired yet); after the process has
// been up longer than the stale threshold a `null` reading means the cron has
// genuinely never written a row and should alert.
let _processStartedAt = Date.now();

/**
 * Test-only hook: forget the in-memory cache so the next call to
 * {@link getLastStripeWebhookSweepResult} re-reads from the database.
 */
export function _resetStripeWebhookSweepCacheForTests(): void {
  _lastStripeWebhookSweepResult = null;
  _lastStripeWebhookSweepCacheLoaded = false;
}

/**
 * Test-only hook: pretend the process started at a specific epoch ms so the
 * "long uptime" branch of {@link isStripeWebhookSweepStale} can be exercised
 * without waiting 36h.
 */
export function _setProcessStartedAtForTests(epochMs: number): void {
  _processStartedAt = epochMs;
}

/**
 * Internal hook used by `sweepOldStripeWebhookDeliveries` in cron.ts to
 * publish the most recent sweep summary to the in-memory cache without
 * waiting for the next cache hydration to read it back from Postgres.
 * Not intended for use outside of the cron sweep.
 */
export function _setLastStripeWebhookSweepResult(status: StripeWebhookSweepStatus): void {
  _lastStripeWebhookSweepResult = status;
  _lastStripeWebhookSweepCacheLoaded = true;
}

/**
 * Returns the most recent stripe-webhook-deliveries sweep summary. Reads
 * from the in-process cache first; on a cold start (e.g. right after a
 * restart) hydrates the cache from `stripe_webhook_sweep_runs` so the
 * admin tile is populated before the next daily sweep runs.
 */
export async function getLastStripeWebhookSweepResult(): Promise<StripeWebhookSweepStatus | null> {
  if (_lastStripeWebhookSweepCacheLoaded) return _lastStripeWebhookSweepResult;
  try {
    const [row] = await db
      .select({
        ranAt: stripeWebhookSweepRunsTable.ranAt,
        removed: stripeWebhookSweepRunsTable.removed,
      })
      .from(stripeWebhookSweepRunsTable)
      .orderBy(desc(stripeWebhookSweepRunsTable.ranAt))
      .limit(1);
    _lastStripeWebhookSweepResult = row
      ? { ranAt: row.ranAt.toISOString(), removed: row.removed }
      : null;
  } catch (err) {
    logger.warn(
      { err },
      "[stripe-webhook-sweep-status] failed to hydrate last sweep result from DB",
    );
    _lastStripeWebhookSweepResult = null;
  }
  _lastStripeWebhookSweepCacheLoaded = true;
  return _lastStripeWebhookSweepResult;
}

/**
 * Task #1525 — Recent stripe-webhook sweep runs (most-recent-first) for the
 * admin trend chart. Mirrors `getWellnessSweepHistory`. Reads directly from
 * `stripe_webhook_sweep_runs` so it survives a server restart and reflects
 * runs from any process that wrote to the table. The retention horizon for
 * the underlying table is ~90 days, so callers should not request a window
 * longer than that.
 */
export async function getStripeWebhookSweepHistory(
  days = 14,
): Promise<StripeWebhookSweepStatus[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    const rows = await db
      .select({
        ranAt: stripeWebhookSweepRunsTable.ranAt,
        removed: stripeWebhookSweepRunsTable.removed,
      })
      .from(stripeWebhookSweepRunsTable)
      .where(gte(stripeWebhookSweepRunsTable.ranAt, cutoff))
      .orderBy(desc(stripeWebhookSweepRunsTable.ranAt));
    return rows.map((row) => ({
      ranAt: row.ranAt.toISOString(),
      removed: row.removed,
    }));
  } catch (err) {
    logger.warn(
      { err },
      "[stripe-webhook-sweep-status] failed to load sweep history from DB",
    );
    return [];
  }
}

/**
 * Task #1295 — Returns true when the daily retention sweep should be flagged
 * as stalled on the admin audit page. The sweep is supposed to run every 24h;
 * if more than {@link STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS} has elapsed since
 * the last recorded run (or since process start, when no run has ever been
 * recorded), the cron is almost certainly broken and the admin should see a
 * warning rather than a calm "last ran X ago" line.
 *
 * The threshold lives server-side so the admin UI doesn't have to recompute
 * it on every render and so it can't drift between clients.
 */
export function isStripeWebhookSweepStale(
  status: StripeWebhookSweepStatus | null,
  now: number = Date.now(),
): boolean {
  if (status === null) {
    // No sweep has ever been recorded. Right after a fresh deploy this is
    // expected and not stale; only flag once the process has been up longer
    // than the stale threshold without a single sweep landing.
    return now - _processStartedAt > STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS;
  }
  const ranAtMs = new Date(status.ranAt).getTime();
  if (Number.isNaN(ranAtMs)) {
    // Defensive: a corrupt timestamp shouldn't quietly hide a real problem,
    // but it also isn't proof the sweep has stalled — log nothing here, fall
    // back to "not stale" and rely on the existing render path.
    return false;
  }
  return now - ranAtMs > STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS;
}
