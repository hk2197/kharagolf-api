/**
 * Task #877 — Server-side counter for watch GPS `position` messages.
 *
 * Records the rate of `position` WS messages per active watch session in
 * one-minute buckets so we can:
 *   1. Confirm the volume drop introduced by Task #722 (client-side debounce
 *      that stops the watch forwarding redundant pings).
 *   2. Catch a regression if a future change re-floods the channel.
 *
 * Storage strategy: an in-process map keyed by sessionId holds the count
 * for the *current* minute. When a position arrives in a different minute
 * than the one we're currently accumulating for, the previous bucket is
 * flushed to `watch_position_metrics` and a fresh accumulator starts. On
 * session close, any partial bucket is flushed too.
 */
import {
  db,
  watchPositionMetricsTable,
  watchPositionSamplesTable,
  watchSessionMutesTable,
  watchGpsOpsAlertTestPagesTable,
} from "@workspace/db";
import { and, eq, gt, gte, lt, sql, desc } from "drizzle-orm";
import { logger as baseLogger } from "./logger";
import { sendWatchPositionTrendOpsAlertEmail } from "./mailer";
import {
  postWatchPositionTrendOpsAlertSlack,
  triggerWatchPositionTrendOpsAlertPagerDuty,
  resolveOpsAlertChatTargets,
  type OpsAlertChatTargets,
} from "./opsAlertChat";

interface SessionAccumulator {
  userId: number;
  sessionId: string;
  tournamentId: number | null;
  batteryMode: boolean;
  bucketMinuteMs: number; // start-of-minute (epoch ms, UTC)
  count: number;
}

const accumulators = new Map<string, SessionAccumulator>();

// ── Mute list (Task #1393, persisted in Task #1679, fanned out in Task #2090 / #2120) ──
//
// In-process block list of `sessionId`s whose `position` messages are dropped
// before they hit `recordWatchPosition`. Lets ops kill a runaway watch from
// the dashboard without paging engineering, in force until the persisted
// mute's TTL expires.
//
// Task #1679 backed the in-process Map with the `watch_session_mutes` table
// so a deploy / restart can't silently lift every active mute. The Map stays
// the hot-path lookup (called for every `position` WS message); the table is
// the persistent source of truth that hydrates the Map on boot and keeps
// long-TTL mutes (e.g. the 4-hour ceiling during a tournament) in force
// across restarts.
//
// Task #2090 / #2120 closed the cross-replica gap: every replica's
// `index.ts` boot wires a periodic `setInterval` that calls
// `syncMutedSessionsFromDb` (default 5s, well inside the "within ~30s"
// target from Task #2120). A mute applied via replica A persists to the
// table inline, and replica B picks it up on its next tick — so the
// flood stops everywhere even when the watch's WebSocket happens to be
// pinned to a different replica and never disconnects. The dashboard
// no longer says "until reconnect"; it says "until expiry" because
// that's now the actual semantics.

/** Default mute lifetime when the caller doesn't specify one. */
export const WATCH_SESSION_MUTE_DEFAULT_TTL_MS = 30 * 60 * 1000;
/** Hard ceiling so a stray request can't pin a session indefinitely. */
export const WATCH_SESSION_MUTE_MAX_TTL_MS = 4 * 60 * 60 * 1000;

const mutedSessions = new Map<string, number>(); // sessionId → expiresAtMs

function pruneExpiredMutes(nowMs: number): void {
  // Lazy: also called from `isWatchSessionMuted` so the map can't grow
  // unbounded even if no one ever queries a long-tail of muted sessions.
  for (const [sid, exp] of mutedSessions) {
    if (exp <= nowMs) mutedSessions.delete(sid);
  }
}

/**
 * Reconcile the in-process `mutedSessions` Map with the persisted
 * `watch_session_mutes` table.
 *
 * Idempotent: every live (non-expired) DB row ends up in the in-memory
 * Map, every Map entry whose persisted row is gone (or expired) is
 * dropped, and Map entries whose persisted `expires_at` has been moved
 * pick up the new value. Also fires a best-effort prune of already-
 * expired rows so the table doesn't carry long tails between cron
 * sweeps.
 *
 * Called from two places:
 *
 *   1. Boot (via `hydrateMutedSessionsFromDb`) — the Map starts empty,
 *      sync just adds whatever the table holds.
 *   2. A periodic interval scheduled in `index.ts` — every replica
 *      re-syncs every few seconds so a mute applied on replica A or an
 *      unmute issued via replica B propagates without a restart. This
 *      is the cross-replica "broadcast" promised by Task #2090: the
 *      DB row is the source of truth and each replica converges to it
 *      on its next tick.
 */
export async function syncMutedSessionsFromDb(
  nowMs: number = Date.now(),
): Promise<{
  added: number;
  updated: number;
  removed: number;
  expiredPruned: number;
}> {
  const now = new Date(nowMs);
  const rows = await db
    .select({
      sessionId: watchSessionMutesTable.sessionId,
      expiresAt: watchSessionMutesTable.expiresAt,
    })
    .from(watchSessionMutesTable);
  const live = new Map<string, number>();
  let expiredPruned = 0;
  for (const row of rows) {
    const expMs = row.expiresAt.getTime();
    if (expMs <= nowMs) {
      expiredPruned += 1;
      continue;
    }
    live.set(row.sessionId, expMs);
  }
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const [sid, exp] of live) {
    const existing = mutedSessions.get(sid);
    if (existing === undefined) {
      mutedSessions.set(sid, exp);
      added += 1;
    } else if (existing !== exp) {
      mutedSessions.set(sid, exp);
      updated += 1;
    }
  }
  // Drop in-memory entries the DB no longer has — this is what makes a
  // remote unmute (issued via a different replica's DELETE) actually
  // stop dropping position messages here, instead of having to wait for
  // the original TTL to elapse on this replica.
  for (const sid of Array.from(mutedSessions.keys())) {
    if (!live.has(sid)) {
      mutedSessions.delete(sid);
      removed += 1;
    }
  }
  if (expiredPruned > 0) {
    // Fire-and-forget — the cron prune will catch these on its next
    // tick anyway; this just keeps the table tidy.
    void db
      .delete(watchSessionMutesTable)
      .where(lt(watchSessionMutesTable.expiresAt, now))
      .catch((err: unknown) => {
        baseLogger.warn(
          { err, watchPosition: true },
          "[ws-watch/metrics] failed to prune expired watch_session_mutes during resync",
        );
      });
  }
  return { added, updated, removed, expiredPruned };
}

/**
 * Boot-time wrapper around `syncMutedSessionsFromDb` that preserves the
 * historical `{ hydrated, expired }` return shape (Task #1679's tests
 * read these counts) and emits a one-shot info log when something was
 * loaded so a deploy's boot trail still shows the mute carry-over.
 *
 * Called from `index.ts` after the HTTP server starts listening;
 * failures are logged but never block boot — without hydration the Map
 * simply starts empty (matches pre-#1679 behaviour, which is exactly
 * the regression we are fixing, but better to come up cleanly than to
 * refuse to serve).
 */
export async function hydrateMutedSessionsFromDb(
  nowMs: number = Date.now(),
): Promise<{ hydrated: number; expired: number }> {
  const result = await syncMutedSessionsFromDb(nowMs);
  if (result.added > 0 || result.expiredPruned > 0) {
    baseLogger.info(
      {
        watchPosition: true,
        hydrated: result.added,
        expired: result.expiredPruned,
      },
      "[ws-watch/metrics] hydrated watch session mutes from persisted store",
    );
  }
  return { hydrated: result.added, expired: result.expiredPruned };
}

// ── Periodic cross-replica resync loop (Task #2090 / #2120) ──────────────────
//
// Default tick period for the cross-replica mute resync. Five seconds is
// well inside the "every replica enforces a mute within ~30s of the
// dashboard click" target from Task #2120 while keeping the DB load to
// roughly one tiny SELECT per replica per five seconds.
export const WATCH_MUTE_RESYNC_DEFAULT_INTERVAL_MS = 5_000;
// Floor: don't let an env-var typo (e.g. "500" meant as 500ms instead of
// 500s) hammer the DB from every replica. Anything under one second
// silently snaps back to the default — matches the "well above a
// single round-trip latency" comment that used to live in `index.ts`.
export const WATCH_MUTE_RESYNC_MIN_INTERVAL_MS = 1_000;

/**
 * Resolve the resync interval for the boot-time loop, applying the
 * floor / non-finite fallback that `index.ts` used to do inline. Lifted
 * here so the test suite can cover the clamp without re-importing the
 * server entrypoint (which would also start an HTTP listener).
 */
export function resolveWatchMuteResyncIntervalMs(
  raw: string | number | undefined,
): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(n) && n >= WATCH_MUTE_RESYNC_MIN_INTERVAL_MS) {
    return Math.floor(n);
  }
  return WATCH_MUTE_RESYNC_DEFAULT_INTERVAL_MS;
}

/**
 * Handle for a running cross-replica mute resync loop. `stop()` clears
 * the underlying timer; safe to call more than once. `intervalMs` is
 * exposed so callers (and tests) can confirm which value won the
 * env-var clamp without re-deriving it.
 */
export interface WatchMuteResyncLoop {
  intervalMs: number;
  stop(): void;
}

/**
 * Start the cross-replica mute resync loop on this replica.
 *
 * Every `intervalMs` (default 5s, env-overridable via
 * `WATCH_MUTE_RESYNC_MS` from the boot wiring), this replica calls
 * `syncMutedSessionsFromDb`, which is what makes a mute applied via a
 * *different* api-server replica's HTTP listener actually start
 * dropping `position` messages here without the watch having to drop
 * its socket and reconnect. This is the "apply a mute on one server to
 * every server within seconds" promise from Task #2120.
 *
 * The returned timer is `unref`'d so the loop never blocks process
 * shutdown — the caller doesn't need to remember to stop it on SIGTERM.
 * `stop()` is provided for tests (and any future graceful-shutdown
 * code) that need deterministic cleanup.
 *
 * Resync failures are caught and warn-logged with the same wording the
 * original inline loop used so existing log queries / alerts keep
 * matching. We don't crash the loop on a transient DB blip — the next
 * tick will retry.
 */
export function startWatchMuteResyncLoop(
  opts: { intervalMs?: number } = {},
): WatchMuteResyncLoop {
  const intervalMs =
    typeof opts.intervalMs === "number" &&
    Number.isFinite(opts.intervalMs) &&
    opts.intervalMs >= WATCH_MUTE_RESYNC_MIN_INTERVAL_MS
      ? Math.floor(opts.intervalMs)
      : WATCH_MUTE_RESYNC_DEFAULT_INTERVAL_MS;
  const timer = setInterval(() => {
    syncMutedSessionsFromDb().catch((err: unknown) => {
      baseLogger.warn(
        { err, watchPosition: true },
        "[watch-session-mutes] periodic resync failed — cross-replica mute changes may lag until the next tick",
      );
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  let stopped = false;
  return {
    intervalMs,
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Add `sessionId` to the mute list and persist it to `watch_session_mutes`
 * so the mute survives an API server restart. Further `position` messages
 * for that session will be dropped (and not counted) until `expiresAt`.
 *
 * `ttlMs` is clamped to (0, WATCH_SESSION_MUTE_MAX_TTL_MS]; falsy /
 * non-finite inputs fall back to WATCH_SESSION_MUTE_DEFAULT_TTL_MS.
 *
 * Persistence is awaited (and propagated on failure) so a transient DB
 * outage surfaces as a 500 to the super-admin dashboard rather than a
 * silent "mute that won't survive a deploy". The in-memory Map is only
 * updated after the upsert succeeds so we never have an entry the cron
 * prune doesn't know about.
 */
export async function muteWatchSession(
  sessionId: string,
  ttlMs?: number,
  nowMs: number = Date.now(),
): Promise<{ expiresAt: Date; ttlMs: number }> {
  pruneExpiredMutes(nowMs);
  let effectiveTtl = WATCH_SESSION_MUTE_DEFAULT_TTL_MS;
  if (typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0) {
    effectiveTtl = Math.min(WATCH_SESSION_MUTE_MAX_TTL_MS, Math.floor(ttlMs));
  }
  const expiresAtMs = nowMs + effectiveTtl;
  const expiresAt = new Date(expiresAtMs);
  // Persist first — if the DB write fails, propagate so the route 500s
  // and ops know the mute didn't take. Re-muting an already-muted session
  // overwrites `expires_at` (matches the in-memory `Map.set` semantics).
  await db
    .insert(watchSessionMutesTable)
    .values({ sessionId, expiresAt })
    .onConflictDoUpdate({
      target: watchSessionMutesTable.sessionId,
      set: { expiresAt },
    });
  mutedSessions.set(sessionId, expiresAtMs);
  return { expiresAt, ttlMs: effectiveTtl };
}

/**
 * Returns true if `sessionId` is currently muted. Lazily prunes its own
 * entry on expiry so the map self-cleans.
 */
export function isWatchSessionMuted(
  sessionId: string,
  nowMs: number = Date.now(),
): boolean {
  const exp = mutedSessions.get(sessionId);
  if (exp == null) return false;
  if (exp <= nowMs) {
    mutedSessions.delete(sessionId);
    return false;
  }
  return true;
}

/**
 * Remove the mute entry for `sessionId`, if any. Drops the in-memory
 * entry synchronously and fires a best-effort DB delete so a reconnect
 * (which calls this via `flushWatchPositionSession`) doesn't leave a
 * stale persisted row that a future restart would resurrect.
 */
export function unmuteWatchSession(sessionId: string): void {
  const had = mutedSessions.delete(sessionId);
  // Always attempt the DB delete: the row may exist on another replica's
  // restart (hydrated there), or this replica may never have hydrated it
  // because it was muted on a peer. Fire-and-forget — the WS close path
  // is sync and we don't want a transient DB blip to wedge it.
  void db
    .delete(watchSessionMutesTable)
    .where(eq(watchSessionMutesTable.sessionId, sessionId))
    .catch((err: unknown) => {
      baseLogger.warn(
        { err, watchPosition: true, sessionId, hadInMemory: had },
        "[ws-watch/metrics] failed to delete persisted watch session mute",
      );
    });
}

/**
 * Delete every `watch_session_mutes` row whose `expires_at` has already
 * passed. Run on the same daily schedule as `pruneWatchPositionMetrics`
 * so the table tracks the in-memory Map's lazy expiry, even when long
 * tails of muted sessions never reconnect to clear themselves.
 */
export async function pruneExpiredWatchSessionMutes(
  nowMs: number = Date.now(),
): Promise<{ deleted: number }> {
  const now = new Date(nowMs);
  const deleted = await db
    .delete(watchSessionMutesTable)
    .where(lt(watchSessionMutesTable.expiresAt, now))
    .returning({ sessionId: watchSessionMutesTable.sessionId });
  if (deleted.length > 0) {
    baseLogger.info(
      { watchPosition: true, deleted: deleted.length, cutoff: now.toISOString() },
      "[ws-watch/metrics] pruned expired watch session mutes",
    );
  }
  return { deleted: deleted.length };
}

/**
 * Snapshot of the in-process mute list. Used as a diagnostic / test
 * helper — the super-admin dashboard now reads from
 * `listActiveMutedSessionsFromDb` so it sees mutes from every replica,
 * not just the one that handled the request (Task #2090).
 *
 * Per-replica scope: only returns mutes recorded on *this* server
 * process, mirroring `mutedSessions`.
 */
export interface ActiveMutedSessionEntry {
  sessionId: string;
  expiresAtMs: number;
}

export function listActiveMutedSessions(
  nowMs: number = Date.now(),
): ActiveMutedSessionEntry[] {
  pruneExpiredMutes(nowMs);
  const out: ActiveMutedSessionEntry[] = [];
  for (const [sessionId, expiresAtMs] of mutedSessions) {
    out.push({ sessionId, expiresAtMs });
  }
  // Soonest-to-expire first so the dashboard surfaces the urgent
  // entries (a stale mute the operator may want to lift NOW) above
  // the long-tail ones.
  out.sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  return out;
}

/**
 * Cross-replica view of every currently-muted watch session, read
 * straight from `watch_session_mutes` (the persisted source of truth
 * since Task #1679). This is what the super-admin "Active mutes" panel
 * queries so ops sees every mute regardless of which replica answered
 * their dashboard request — fixes Task #2090's per-replica gap.
 *
 * Already-expired rows are filtered out at the SQL layer rather than
 * relying on the local in-memory `pruneExpiredMutes` sweep, since this
 * endpoint is the canonical "what is muted right now" answer for ops.
 */
export async function listActiveMutedSessionsFromDb(
  nowMs: number = Date.now(),
): Promise<ActiveMutedSessionEntry[]> {
  const now = new Date(nowMs);
  const rows = await db
    .select({
      sessionId: watchSessionMutesTable.sessionId,
      expiresAt: watchSessionMutesTable.expiresAt,
    })
    .from(watchSessionMutesTable)
    .where(gt(watchSessionMutesTable.expiresAt, now));
  return rows
    .map((r) => ({
      sessionId: r.sessionId,
      expiresAtMs: r.expiresAt.getTime(),
    }))
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs);
}

/**
 * Returns the persisted `expires_at` for `sessionId` if there's a live
 * (non-expired) row in `watch_session_mutes`, otherwise null. Used by
 * the DELETE endpoint to decide whether the session is muted *anywhere
 * in the fleet*, instead of only checking this replica's in-memory
 * map (Task #2090) — without this, ops can't lift a mute that was
 * applied on a different replica.
 */
export async function getPersistedWatchSessionMuteExpiryMs(
  sessionId: string,
  nowMs: number = Date.now(),
): Promise<number | null> {
  const rows = await db
    .select({ expiresAt: watchSessionMutesTable.expiresAt })
    .from(watchSessionMutesTable)
    .where(eq(watchSessionMutesTable.sessionId, sessionId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const ms = r.expiresAt.getTime();
  return ms > nowMs ? ms : null;
}

/**
 * Awaited delete of the persisted `watch_session_mutes` row for
 * `sessionId`. Returns the number of rows deleted (0 if it was already
 * gone, e.g. another replica beat us to it).
 *
 * Paired with `dropLocalWatchSessionMute` from the DELETE endpoint:
 * after the awaited DB delete, this replica drops its own in-memory
 * entry immediately, and every other replica picks up the change on
 * its next periodic resync tick (≈5s) — that's the cross-replica
 * "broadcast" Task #2090 calls for.
 */
export async function deletePersistedWatchSessionMute(
  sessionId: string,
): Promise<number> {
  const deleted = await db
    .delete(watchSessionMutesTable)
    .where(eq(watchSessionMutesTable.sessionId, sessionId))
    .returning({ sessionId: watchSessionMutesTable.sessionId });
  return deleted.length;
}

/**
 * Drop the in-memory mute entry for `sessionId` on this replica only.
 * Sync companion to `deletePersistedWatchSessionMute`: the DELETE
 * endpoint deletes the persisted row (so other replicas converge on
 * their next resync) and calls this to skip the wait on the local
 * resync tick.
 */
export function dropLocalWatchSessionMute(sessionId: string): void {
  mutedSessions.delete(sessionId);
}

function startOfMinute(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

// ── Trend warning ────────────────────────────────────────────────────────────
//
// Mirrors the in-process trend detector in `caddiePromptMetrics.ts`: every
// completed per-session-minute bucket is pushed onto a small ring, and when
// the rolling average over the most recent window exceeds the older baseline
// window by `TREND_BASELINE_MULTIPLIER`x, we emit a logger.warn so ops can be
// paged. This catches a regression that re-floods the watch GPS channel
// (Task #722's debounce being undone, etc.) without waiting for someone to
// open the dashboard.
//
// Sized for per-replica detection: a single replica with a few active watches
// will fill the ring within minutes of a regression. The DB table remains the
// source of truth for cross-replica visibility (the dashboard queries it).
const TREND_WINDOW = 20; // most-recent buckets compared against ...
const TREND_BASELINE_MULTIPLIER = 3; // ... a baseline of equal size, multiplied by this
const TREND_MIN_RATE = 5; // recent avg must clear this floor (msgs/session-minute) to fire
const TREND_RING_SIZE = TREND_WINDOW * 2;
const TREND_WARN_COOLDOWN_MS = 10 * 60 * 1000; // suppress repeats while spike persists
const trendRing: number[] = [];
let trendRingStart = 0;
let lastTrendWarnAt = 0;

function pushTrend(rate: number): void {
  if (trendRing.length < TREND_RING_SIZE) {
    trendRing.push(rate);
  } else {
    trendRing[trendRingStart] = rate;
    trendRingStart = (trendRingStart + 1) % TREND_RING_SIZE;
  }
}

function trendSnapshot(): number[] {
  if (trendRing.length < TREND_RING_SIZE) return trendRing.slice();
  return [...trendRing.slice(trendRingStart), ...trendRing.slice(0, trendRingStart)];
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function parseRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the ops alert recipient list for the watch GPS spike alert.
 *
 * Lookup order:
 *   1. `OPS_WATCH_GPS_ALERT_EMAILS` — dedicated channel so on-call can
 *      route this signal to a focused inbox (mobile / wearable team)
 *      without having to re-route every other ops alert.
 *   2. `OPS_ALERT_EMAILS` — shared ops list, the same one used by the
 *      notification-retry exhaustion alert (Task #1130). Most deploys
 *      will only ever set this one.
 *
 * Returns `[]` when neither is set; `dispatchTrendOpsAlertEmail` then
 * skips the dispatch (and warn-logs once via the cooldown gate so the
 * misconfiguration is visible).
 */
function getWatchGpsOpsAlertRecipients(): string[] {
  const dedicated = parseRecipients(process.env.OPS_WATCH_GPS_ALERT_EMAILS);
  if (dedicated.length > 0) return dedicated;
  return parseRecipients(process.env.OPS_ALERT_EMAILS);
}

/**
 * Resolve the env-driven Slack webhook + PagerDuty routing key targets
 * for the watch GPS spike alert. Either, both, or neither may be set.
 *
 * Lookup order (Task #1652 — same shared-fallback shape used by every
 * `OPS_ALERT_EMAILS` flow that pages humans):
 *   1. `OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK` /
 *      `OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY` — dedicated, lets
 *      ops route the watch GPS signal to a focused channel without
 *      having to re-route every other ops alert.
 *   2. `OPS_ALERT_SLACK_WEBHOOK` / `OPS_ALERT_PAGERDUTY_ROUTING_KEY`
 *      — shared fallback, the same pair the notification-retry
 *      exhaustion alert (Task #1130) uses. Most deploys will only
 *      ever set this pair.
 *
 * Returning both channels in one object keeps the dispatch site
 * straightforward and lets a single warn-log cover the "neither
 * configured" case (mirrors the email branch's single warn).
 */
function getWatchGpsOpsAlertChatTargets(): OpsAlertChatTargets {
  return resolveOpsAlertChatTargets({
    slackEnvVar: "OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK",
    pagerDutyEnvVar: "OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY",
  });
}

/**
 * Public, sanitized view of the chat-channel configuration for the
 * super-admin dashboard. Only exposes whether each channel is configured —
 * never the webhook URL or routing key — so a UI render of this struct
 * can't accidentally leak credentials into a screenshot or browser
 * console (Task #1653).
 */
export interface WatchGpsOpsAlertChatTargetsStatus {
  slackConfigured: boolean;
  pagerDutyConfigured: boolean;
}

export function getWatchGpsOpsAlertChatTargetsStatus(): WatchGpsOpsAlertChatTargetsStatus {
  const { slackWebhook, pagerDutyRoutingKey } = getWatchGpsOpsAlertChatTargets();
  return {
    slackConfigured: slackWebhook !== null,
    pagerDutyConfigured: pagerDutyRoutingKey !== null,
  };
}

function dispatchTrendOpsAlertChat(
  recentAvg: number,
  baselineAvg: number,
): void {
  const { slackWebhook, pagerDutyRoutingKey } = getWatchGpsOpsAlertChatTargets();
  if (!slackWebhook && !pagerDutyRoutingKey) {
    baseLogger.warn(
      { watchPosition: true },
      "[ws-watch/metrics] watch GPS spike detected but no chat target configured (set OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK / OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY, or the shared OPS_ALERT_SLACK_WEBHOOK / OPS_ALERT_PAGERDUTY_ROUTING_KEY); skipping ops chat page",
    );
    return;
  }
  const cooldownMinutes = Math.max(1, Math.round(TREND_WARN_COOLDOWN_MS / 60_000));
  const now = new Date();
  const shared = {
    recentAvg: Math.round(recentAvg * 100) / 100,
    baselineAvg: Math.round(baselineAvg * 100) / 100,
    windowSize: TREND_WINDOW,
    multiplier: TREND_BASELINE_MULTIPLIER,
    cooldownMinutes,
    now,
  };
  // Fire-and-forget — never block the WS handler / metrics flush on
  // the chat page. Independent try/catch per channel so a Slack outage
  // doesn't suppress the PagerDuty trigger (and vice versa).
  if (slackWebhook) {
    void postWatchPositionTrendOpsAlertSlack({ webhookUrl: slackWebhook, ...shared }).catch(
      (err: unknown) => {
        baseLogger.warn(
          { err, watchPosition: true },
          "[ws-watch/metrics] failed to post watch GPS spike ops alert to Slack",
        );
      },
    );
  }
  if (pagerDutyRoutingKey) {
    void triggerWatchPositionTrendOpsAlertPagerDuty({ routingKey: pagerDutyRoutingKey, ...shared }).catch(
      (err: unknown) => {
        baseLogger.warn(
          { err, watchPosition: true },
          "[ws-watch/metrics] failed to trigger watch GPS spike ops alert on PagerDuty",
        );
      },
    );
  }
}

function dispatchTrendOpsAlertEmail(
  recentAvg: number,
  baselineAvg: number,
): void {
  const recipients = getWatchGpsOpsAlertRecipients();
  if (recipients.length === 0) {
    baseLogger.warn(
      { watchPosition: true },
      "[ws-watch/metrics] watch GPS spike detected but OPS_WATCH_GPS_ALERT_EMAILS / OPS_ALERT_EMAILS are unset; skipping ops email",
    );
    return;
  }
  const cooldownMinutes = Math.max(1, Math.round(TREND_WARN_COOLDOWN_MS / 60_000));
  const now = new Date();
  // Fire-and-forget per recipient — never block the WS handler / metrics
  // flush on email delivery. Per-recipient try/catch so one bad address
  // doesn't suppress the others.
  for (const to of recipients) {
    void sendWatchPositionTrendOpsAlertEmail({
      to,
      recentAvg: Math.round(recentAvg * 100) / 100,
      baselineAvg: Math.round(baselineAvg * 100) / 100,
      windowSize: TREND_WINDOW,
      multiplier: TREND_BASELINE_MULTIPLIER,
      cooldownMinutes,
      now,
    }).catch((err: unknown) => {
      baseLogger.warn(
        { err, watchPosition: true, to },
        "[ws-watch/metrics] failed to send watch GPS spike ops alert email",
      );
    });
  }
}

function maybeWarnOnTrend(): void {
  const all = trendSnapshot();
  if (all.length < TREND_RING_SIZE) return;
  const recent = all.slice(-TREND_WINDOW);
  const baseline = all.slice(0, all.length - TREND_WINDOW);
  const recentAvg = avg(recent);
  const baselineAvg = avg(baseline);
  if (
    recentAvg >= TREND_MIN_RATE &&
    baselineAvg > 0 &&
    recentAvg >= baselineAvg * TREND_BASELINE_MULTIPLIER &&
    Date.now() - lastTrendWarnAt > TREND_WARN_COOLDOWN_MS
  ) {
    lastTrendWarnAt = Date.now();
    baseLogger.warn(
      {
        watchPosition: true,
        recentAvgMsgsPerSessionMinute: Math.round(recentAvg * 100) / 100,
        baselineAvgMsgsPerSessionMinute: Math.round(baselineAvg * 100) / 100,
        windowSize: TREND_WINDOW,
        multiplier: TREND_BASELINE_MULTIPLIER,
      },
      "[ws-watch/metrics] watch GPS msg rate trending up — possible regression of Task #722 debounce",
    );
    // Task #1189 — also page ops via email so a regression of Task #722's
    // debounce doesn't depend on someone tailing the log stream. Gated by
    // the same `lastTrendWarnAt` cooldown above so repeats during a
    // sustained spike are suppressed identically to the warn log.
    dispatchTrendOpsAlertEmail(recentAvg, baselineAvg);
    // Task #1374 — also page on-call via Slack and/or PagerDuty so
    // out-of-hours spikes get a faster signal than email. Same per-replica
    // cooldown gate above; per-channel env vars; missing config skips
    // with a single warn log (mirrors the email branch).
    dispatchTrendOpsAlertChat(recentAvg, baselineAvg);
  }
}

function persistBucket(acc: SessionAccumulator): void {
  if (acc.count <= 0) return;
  pushTrend(acc.count);
  maybeWarnOnTrend();
  const row = {
    userId: acc.userId,
    sessionId: acc.sessionId,
    tournamentId: acc.tournamentId,
    batteryMode: acc.batteryMode,
    bucketMinute: new Date(acc.bucketMinuteMs),
    positionCount: acc.count,
  };
  // Fire-and-forget — never block the WS handler on metrics persistence.
  // ON CONFLICT (session_id, bucket_minute) keeps the table sane if the
  // same bucket is somehow flushed twice (e.g. close races forward-roll).
  void db
    .insert(watchPositionMetricsTable)
    .values(row)
    .onConflictDoUpdate({
      target: [watchPositionMetricsTable.sessionId, watchPositionMetricsTable.bucketMinute],
      set: {
        positionCount: sql`${watchPositionMetricsTable.positionCount} + ${acc.count}`,
        batteryMode: acc.batteryMode,
        tournamentId: acc.tournamentId,
      },
    })
    .catch((err: unknown) => {
      baseLogger.warn(
        { err, watchPosition: true, sessionId: acc.sessionId },
        "[ws-watch/metrics] failed to persist position-rate bucket",
      );
    });
}

export interface RecordWatchPositionInput {
  userId: number;
  sessionId: string;
  tournamentId: number | null;
  batteryMode: boolean;
  nowMs?: number; // injected in tests
}

/**
 * Increment the position-message counter for the given watch session.
 * Rolls the bucket forward (and flushes the previous one) when the wall
 * clock crosses into a new minute.
 */
export function recordWatchPosition(input: RecordWatchPositionInput): void {
  const now = input.nowMs ?? Date.now();
  const bucket = startOfMinute(now);
  const existing = accumulators.get(input.sessionId);
  if (!existing) {
    accumulators.set(input.sessionId, {
      userId: input.userId,
      sessionId: input.sessionId,
      tournamentId: input.tournamentId,
      batteryMode: input.batteryMode,
      bucketMinuteMs: bucket,
      count: 1,
    });
    return;
  }
  if (existing.bucketMinuteMs !== bucket) {
    persistBucket(existing);
    existing.bucketMinuteMs = bucket;
    existing.count = 0;
  }
  existing.count += 1;
  // Always pick up the most recent metadata — battery mode toggles and
  // subscriptions can change mid-session.
  existing.userId = input.userId;
  existing.tournamentId = input.tournamentId;
  existing.batteryMode = input.batteryMode;
}

/**
 * Flush any partial in-memory bucket for the session and forget it.
 * Called on WS close so per-minute totals aren't lost.
 *
 * Also drops any in-process mute entry (Task #1393) — the watch's next
 * connection allocates a fresh `sessionId` so the old mute would only
 * sit in the map until its TTL expires; clearing it eagerly keeps the
 * map small and the persisted `watch_session_mutes` row tidy. The
 * cross-replica fan-out from Task #2090 / #2120 means the silence
 * already applied fleet-wide while the socket was open, so the eager
 * cleanup is a housekeeping detail, not a correctness requirement.
 */
export function flushWatchPositionSession(sessionId: string): void {
  unmuteWatchSession(sessionId);
  const acc = accumulators.get(sessionId);
  if (!acc) return;
  persistBucket(acc);
  accumulators.delete(sessionId);
}

// ── Aggregations for the ops dashboard ───────────────────────────────────────

export interface WatchPositionMetricsWindow {
  totalMessages: number;
  bucketCount: number;
  activeSessionCount: number;
  avgMessagesPerSessionMinute: number;
  p50MessagesPerSessionMinute: number;
  p95MessagesPerSessionMinute: number;
  maxMessagesPerSessionMinute: number;
}

export interface WatchPositionRecentBucket {
  bucketMinute: string; // ISO
  sessionId: string;
  userId: number;
  tournamentId: number | null;
  batteryMode: boolean;
  positionCount: number;
}

export interface WatchPositionSeriesPoint {
  bucket: string; // ISO start of bucket
  sampleCount: number;
  avg: number;
  p95: number;
  max: number;
  batteryAvg: number | null;
  batterySampleCount: number;
  normalAvg: number | null;
  normalSampleCount: number;
}

export interface WatchPositionMetricsSummary {
  windows: {
    "24h": WatchPositionMetricsWindow;
    "7d": WatchPositionMetricsWindow;
    "30d": WatchPositionMetricsWindow;
  };
  /**
   * Time-series of avg/p95 messages-per-session-minute for each window so
   * the dashboard can render a sparkline alongside the headline numbers.
   * Bucket sizes are picked so each series stays under a few hundred
   * points: 24h → per minute, 7d → per hour, 30d → per 6h.
   */
  seriesByWindow: {
    "24h": WatchPositionSeriesPoint[];
    "7d": WatchPositionSeriesPoint[];
    "30d": WatchPositionSeriesPoint[];
  };
  /** Bucket size in seconds for each series, mirrored so the client can label axes. */
  seriesBucketSeconds: {
    "24h": number;
    "7d": number;
    "30d": number;
  };
  recent: WatchPositionRecentBucket[];
  /**
   * Task #1653 — sanitized snapshot of which chat-channel ops alert
   * targets are configured. Lets the dashboard render a "Slack ✓ /
   * PagerDuty ✗" badge so ops can spot a missing env var before the
   * next spike — without ever sending the webhook URL or routing key
   * to the browser.
   */
  chatTargets: WatchGpsOpsAlertChatTargetsStatus;
}

const EMPTY_WINDOW: WatchPositionMetricsWindow = {
  totalMessages: 0,
  bucketCount: 0,
  activeSessionCount: 0,
  avgMessagesPerSessionMinute: 0,
  p50MessagesPerSessionMinute: 0,
  p95MessagesPerSessionMinute: 0,
  maxMessagesPerSessionMinute: 0,
};

async function aggregateWindow(sinceMs: number): Promise<WatchPositionMetricsWindow> {
  const since = new Date(sinceMs);
  const rows = await db
    .select({
      totalMessages: sql<number>`coalesce(sum(${watchPositionMetricsTable.positionCount}), 0)::int`,
      bucketCount: sql<number>`count(*)::int`,
      sessionCount: sql<number>`count(distinct ${watchPositionMetricsTable.sessionId})::int`,
      avg: sql<number>`coalesce(avg(${watchPositionMetricsTable.positionCount}), 0)`,
      p50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${watchPositionMetricsTable.positionCount}), 0)`,
      p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${watchPositionMetricsTable.positionCount}), 0)`,
      max: sql<number>`coalesce(max(${watchPositionMetricsTable.positionCount}), 0)::int`,
    })
    .from(watchPositionMetricsTable)
    .where(gte(watchPositionMetricsTable.bucketMinute, since));
  const r = rows[0];
  if (!r || Number(r.bucketCount) === 0) return { ...EMPTY_WINDOW };
  return {
    totalMessages: Number(r.totalMessages),
    bucketCount: Number(r.bucketCount),
    activeSessionCount: Number(r.sessionCount),
    avgMessagesPerSessionMinute: Math.round(Number(r.avg) * 100) / 100,
    p50MessagesPerSessionMinute: Math.round(Number(r.p50) * 100) / 100,
    p95MessagesPerSessionMinute: Math.round(Number(r.p95) * 100) / 100,
    maxMessagesPerSessionMinute: Number(r.max),
  };
}

async function aggregateSeries(sinceMs: number, intervalSec: number): Promise<WatchPositionSeriesPoint[]> {
  const since = new Date(sinceMs);
  const result = await db.execute(sql`
    SELECT
      to_timestamp(floor(extract(epoch from bucket_minute) / ${intervalSec}) * ${intervalSec}) AS bucket,
      count(*)::int AS sample_count,
      coalesce(avg(position_count), 0) AS avg,
      coalesce(percentile_cont(0.95) within group (order by position_count), 0) AS p95,
      coalesce(max(position_count), 0)::int AS max,
      avg(position_count) FILTER (WHERE battery_mode) AS battery_avg,
      count(*) FILTER (WHERE battery_mode)::int AS battery_sample_count,
      avg(position_count) FILTER (WHERE NOT battery_mode) AS normal_avg,
      count(*) FILTER (WHERE NOT battery_mode)::int AS normal_sample_count
    FROM watch_position_metrics
    WHERE bucket_minute >= ${since}
    GROUP BY 1
    ORDER BY 1
  `);
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  const round2 = (n: unknown): number => Math.round(Number(n) * 100) / 100;
  return rows.map((r) => ({
    bucket: new Date(r.bucket as string | Date).toISOString(),
    sampleCount: Number(r.sample_count ?? 0),
    avg: round2(r.avg ?? 0),
    p95: round2(r.p95 ?? 0),
    max: Number(r.max ?? 0),
    batteryAvg: r.battery_avg == null ? null : round2(r.battery_avg),
    batterySampleCount: Number(r.battery_sample_count ?? 0),
    normalAvg: r.normal_avg == null ? null : round2(r.normal_avg),
    normalSampleCount: Number(r.normal_sample_count ?? 0),
  }));
}

const SERIES_BUCKET_SECONDS = {
  "24h": 60, // per minute
  "7d": 60 * 60, // per hour
  "30d": 6 * 60 * 60, // per 6 hours
} as const;

export async function getWatchPositionMetricsSummary(recentLimit = 20): Promise<WatchPositionMetricsSummary> {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const [w24h, w7d, w30d, s24h, s7d, s30d, recentRows] = await Promise.all([
    aggregateWindow(now - day),
    aggregateWindow(now - 7 * day),
    aggregateWindow(now - 30 * day),
    aggregateSeries(now - day, SERIES_BUCKET_SECONDS["24h"]),
    aggregateSeries(now - 7 * day, SERIES_BUCKET_SECONDS["7d"]),
    aggregateSeries(now - 30 * day, SERIES_BUCKET_SECONDS["30d"]),
    db
      .select()
      .from(watchPositionMetricsTable)
      .orderBy(desc(watchPositionMetricsTable.bucketMinute))
      .limit(Math.max(1, Math.min(200, recentLimit))),
  ]);
  const recent: WatchPositionRecentBucket[] = recentRows.map((r) => ({
    bucketMinute: r.bucketMinute.toISOString(),
    sessionId: r.sessionId,
    userId: r.userId,
    tournamentId: r.tournamentId,
    batteryMode: r.batteryMode,
    positionCount: r.positionCount,
  }));
  return {
    windows: { "24h": w24h, "7d": w7d, "30d": w30d },
    seriesByWindow: { "24h": s24h, "7d": s7d, "30d": s30d },
    seriesBucketSeconds: { ...SERIES_BUCKET_SECONDS },
    recent,
    chatTargets: getWatchGpsOpsAlertChatTargetsStatus(),
  };
}

// ── Ops alert wiring test (Task #1653) ───────────────────────────────────────
//
// Lets a super-admin fire a clearly-labelled test page through the same
// Slack / PagerDuty senders the real spike alert uses. The point is to catch
// a typo in the webhook URL or routing key BEFORE a real spike — today the
// only signal a misconfigured env var produces is silence at the moment it
// matters most.
//
// Implementation notes:
//   - Awaits the senders (rather than the fire-and-forget pattern the real
//     dispatch uses) so the dashboard can report per-channel success/failure
//     synchronously. The senders themselves do the same fetch + throw on
//     non-2xx that the real path does, so a typo'd webhook still surfaces.
//   - Re-emits the same `baseLogger.warn` log message on per-channel
//     failure as the real dispatch path so a wiring failure detected via
//     the test button looks identical in the log stream to a wiring
//     failure detected by a real spike — keeps the runbook simple.
//   - Independent try/catch per channel so a Slack 404 doesn't suppress
//     the PagerDuty result (and vice versa); this matches the real
//     dispatch site's behaviour.

export interface WatchGpsOpsAlertChatTestResult {
  /** Whether each channel was configured at the moment the test fired. */
  targets: WatchGpsOpsAlertChatTargetsStatus;
  /**
   * Per-channel outcome. `attempted` is false when the channel wasn't
   * configured at all (no env var set). When `attempted` is true,
   * `ok` reflects whether the underlying sender resolved successfully;
   * `error` carries the error message on failure for the toast.
   */
  slack: { configured: boolean; attempted: boolean; ok: boolean; error: string | null };
  pagerDuty: { configured: boolean; attempted: boolean; ok: boolean; error: string | null };
}

export async function sendWatchGpsOpsAlertTestPage(): Promise<WatchGpsOpsAlertChatTestResult> {
  const { slackWebhook, pagerDutyRoutingKey } = getWatchGpsOpsAlertChatTargets();
  const cooldownMinutes = Math.max(1, Math.round(TREND_WARN_COOLDOWN_MS / 60_000));
  const now = new Date();
  // Use zeroed numeric fields so a downstream renderer (e.g. a future
  // PagerDuty consumer that still reads `recent_avg_msgs_per_session_minute`)
  // can't mistake a test page for a real spike worth charting. The
  // `testMode: true` flag does the actual labelling on both senders.
  const shared = {
    recentAvg: 0,
    baselineAvg: 0,
    windowSize: TREND_WINDOW,
    multiplier: TREND_BASELINE_MULTIPLIER,
    cooldownMinutes,
    now,
    testMode: true as const,
  };

  const result: WatchGpsOpsAlertChatTestResult = {
    targets: {
      slackConfigured: slackWebhook !== null,
      pagerDutyConfigured: pagerDutyRoutingKey !== null,
    },
    slack: { configured: slackWebhook !== null, attempted: false, ok: false, error: null },
    pagerDuty: { configured: pagerDutyRoutingKey !== null, attempted: false, ok: false, error: null },
  };

  // Run both in parallel so the slower channel doesn't gate the faster
  // one in the dashboard's loading spinner.
  const tasks: Promise<void>[] = [];
  if (slackWebhook) {
    result.slack.attempted = true;
    tasks.push(
      postWatchPositionTrendOpsAlertSlack({ webhookUrl: slackWebhook, ...shared })
        .then(() => {
          result.slack.ok = true;
        })
        .catch((err: unknown) => {
          result.slack.ok = false;
          result.slack.error = err instanceof Error ? err.message : String(err);
          baseLogger.warn(
            { err, watchPosition: true, opsAlertWiringTest: true },
            "[ws-watch/metrics] failed to post watch GPS spike ops alert to Slack",
          );
        }),
    );
  }
  if (pagerDutyRoutingKey) {
    result.pagerDuty.attempted = true;
    tasks.push(
      triggerWatchPositionTrendOpsAlertPagerDuty({ routingKey: pagerDutyRoutingKey, ...shared })
        .then(() => {
          result.pagerDuty.ok = true;
        })
        .catch((err: unknown) => {
          result.pagerDuty.ok = false;
          result.pagerDuty.error = err instanceof Error ? err.message : String(err);
          baseLogger.warn(
            { err, watchPosition: true, opsAlertWiringTest: true },
            "[ws-watch/metrics] failed to trigger watch GPS spike ops alert on PagerDuty",
          );
        }),
    );
  }
  await Promise.all(tasks);
  return result;
}

// ── Test-page audit log (Task #2056) ─────────────────────────────────────────
//
// Persist one row per super-admin "Send test page" click so leadership can
// see how often the watch GPS paging wiring is exercised, prove "we test
// our paging weekly" during incident reviews, and chart the cadence over
// the last 30 days. The route already info-logs each click; this just
// promotes that log line into a queryable table so the dashboard can
// render "Last test page: 3h ago by Asha" without grepping the log
// stream.
//
// The insert is best-effort: if the audit write fails we warn-log and
// fall through so the operator still gets the test-page outcome (the
// real value of the button is the page itself, not the audit row).

export interface RecordWatchGpsOpsAlertTestPageInput {
  actorUserId: number | null;
  actorName: string | null;
  result: WatchGpsOpsAlertChatTestResult;
  nowMs?: number; // injected in tests
}

export async function recordWatchGpsOpsAlertTestPage(
  input: RecordWatchGpsOpsAlertTestPageInput,
): Promise<void> {
  try {
    await db.insert(watchGpsOpsAlertTestPagesTable).values({
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      slackAttempted: input.result.slack.attempted,
      slackOk: input.result.slack.ok,
      slackError: input.result.slack.error,
      pagerDutyAttempted: input.result.pagerDuty.attempted,
      pagerDutyOk: input.result.pagerDuty.ok,
      pagerDutyError: input.result.pagerDuty.error,
      ...(input.nowMs != null ? { createdAt: new Date(input.nowMs) } : {}),
    });
  } catch (err: unknown) {
    baseLogger.warn(
      { err, watchPosition: true, opsAlertWiringTest: true },
      "[ws-watch/metrics] failed to persist watch GPS ops alert test page audit row",
    );
  }
}

export interface WatchGpsOpsAlertTestPageLastEntry {
  /** ISO timestamp of the most recent test-page click. */
  firedAt: string;
  /** `app_users.id` of the actor at the time of the click; null if the route lost the principal. */
  actorUserId: number | null;
  /** `displayName ?? username` cached at insert time; null if the route lost the principal. */
  actorName: string | null;
  slack: { attempted: boolean; ok: boolean; error: string | null };
  pagerDuty: { attempted: boolean; ok: boolean; error: string | null };
}

export interface WatchGpsOpsAlertTestPageDayPoint {
  /** YYYY-MM-DD (UTC) — the day bucket. */
  date: string;
  /** Number of test pages fired that day. */
  count: number;
}

export interface WatchGpsOpsAlertTestPageHistory {
  /** Most recent test-page click, or null if no rows exist yet. */
  last: WatchGpsOpsAlertTestPageLastEntry | null;
  /** Per-day count series (UTC days) covering the last 30 days. */
  dailySeries: WatchGpsOpsAlertTestPageDayPoint[];
  /** Total clicks in the last 30 days. */
  totalLast30Days: number;
}

const TEST_PAGE_HISTORY_DAYS = 30;

function startOfUtcDay(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcDateString(d: Date): string {
  // YYYY-MM-DD in UTC — small, stable, sortable, ignores caller TZ.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Read the most recent test-page audit row plus a per-day count series
 * for the last 30 days so the dashboard can render
 * "Last test page: 3h ago by Asha" plus a small frequency chart under
 * the wiring badges.
 *
 * Days with zero clicks are emitted as `count: 0` so the chart has a
 * dense, evenly-spaced X axis (and the renderer doesn't have to fill
 * gaps client-side).
 */
export async function getWatchGpsOpsAlertTestPageHistory(
  nowMs: number = Date.now(),
): Promise<WatchGpsOpsAlertTestPageHistory> {
  // The window starts at the *start of the UTC day* TEST_PAGE_HISTORY_DAYS-1
  // days ago so today + the 29 prior days are included (30 buckets total),
  // not "30×24h ago" which would miss the current day's earliest hours.
  const todayStart = startOfUtcDay(nowMs);
  const windowStart = new Date(
    todayStart.getTime() - (TEST_PAGE_HISTORY_DAYS - 1) * 24 * 60 * 60 * 1000,
  );

  const [lastRows, dayRows] = await Promise.all([
    db
      .select()
      .from(watchGpsOpsAlertTestPagesTable)
      .orderBy(desc(watchGpsOpsAlertTestPagesTable.createdAt))
      .limit(1),
    db.execute(sql`
      SELECT
        to_char(date_trunc('day', ${watchGpsOpsAlertTestPagesTable.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
        count(*)::int AS cnt
      FROM ${watchGpsOpsAlertTestPagesTable}
      WHERE ${watchGpsOpsAlertTestPagesTable.createdAt} >= ${windowStart}
      GROUP BY 1
      ORDER BY 1
    `),
  ]);

  const dayCounts = new Map<string, number>();
  const rows = (dayRows as unknown as { rows: Record<string, unknown>[] }).rows;
  for (const r of rows) {
    dayCounts.set(String(r.day), Number(r.cnt ?? 0));
  }

  const dailySeries: WatchGpsOpsAlertTestPageDayPoint[] = [];
  let totalLast30Days = 0;
  for (let i = 0; i < TEST_PAGE_HISTORY_DAYS; i += 1) {
    const d = new Date(windowStart.getTime() + i * 24 * 60 * 60 * 1000);
    const key = utcDateString(d);
    const count = dayCounts.get(key) ?? 0;
    totalLast30Days += count;
    dailySeries.push({ date: key, count });
  }

  let last: WatchGpsOpsAlertTestPageLastEntry | null = null;
  const lastRow = lastRows[0];
  if (lastRow) {
    last = {
      firedAt: lastRow.createdAt.toISOString(),
      actorUserId: lastRow.actorUserId,
      actorName: lastRow.actorName,
      slack: {
        attempted: lastRow.slackAttempted,
        ok: lastRow.slackOk,
        error: lastRow.slackError,
      },
      pagerDuty: {
        attempted: lastRow.pagerDutyAttempted,
        ok: lastRow.pagerDutyOk,
        error: lastRow.pagerDutyError,
      },
    };
  }

  return { last, dailySeries, totalLast30Days };
}

// ── Top sessions in a chart bucket ───────────────────────────────────────────
//
// Task #1195 — When ops clicks a point on the "Watch GPS position rate" chart,
// we drill into the top offending sessions in that bucket so the spike can be
// traced back to a specific watch + user + tournament.

export interface WatchPositionTopSession {
  sessionId: string;
  userId: number;
  tournamentId: number | null;
  /** Sum of `position_count` rows for the session inside the bucket window. */
  positionCount: number;
  /** Number of distinct minute-rows the session contributed inside the bucket. */
  bucketCount: number;
  /**
   * Whether the session was in battery mode for any of the rows inside the
   * bucket. Mirrors the chart's "battery vs normal" colouring.
   */
  batteryMode: boolean;
}

/**
 * Return the top N watch sessions whose minute-rows fall inside the given
 * chart bucket, ordered by total messages descending.
 *
 * The chart series is bucketed at SERIES_BUCKET_SECONDS sizes (per-minute /
 * per-hour / per-6h depending on the window), so a single point on the chart
 * may aggregate many minute-rows from many sessions. This query unrolls them.
 */
export async function getTopSessionsForBucket(
  bucketStartMs: number,
  bucketEndMs: number,
  limit = 10,
): Promise<WatchPositionTopSession[]> {
  if (!Number.isFinite(bucketStartMs) || !Number.isFinite(bucketEndMs) || bucketEndMs <= bucketStartMs) {
    return [];
  }
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const startDate = new Date(bucketStartMs);
  const endDate = new Date(bucketEndMs);
  const result = await db.execute(sql`
    SELECT
      session_id,
      max(user_id)::int AS user_id,
      max(tournament_id)::int AS tournament_id,
      sum(position_count)::int AS position_count,
      count(*)::int AS bucket_count,
      bool_or(battery_mode) AS battery_mode
    FROM watch_position_metrics
    WHERE bucket_minute >= ${startDate} AND bucket_minute < ${endDate}
    GROUP BY session_id
    ORDER BY position_count DESC, session_id ASC
    LIMIT ${safeLimit}
  `);
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  return rows.map((r) => ({
    sessionId: String(r.session_id),
    userId: Number(r.user_id),
    tournamentId: r.tournament_id == null ? null : Number(r.tournament_id),
    positionCount: Number(r.position_count ?? 0),
    bucketCount: Number(r.bucket_count ?? 0),
    batteryMode: Boolean(r.battery_mode),
  }));
}

const PRUNE_KEEP_DAYS = 90;

export async function pruneWatchPositionMetrics(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - PRUNE_KEEP_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(watchPositionMetricsTable)
    .where(lt(watchPositionMetricsTable.bucketMinute, cutoff))
    .returning({ id: watchPositionMetricsTable.id });
  if (deleted.length > 0) {
    baseLogger.info(
      { watchPosition: true, deleted: deleted.length, cutoff: cutoff.toISOString() },
      "[ws-watch/metrics] pruned old position-rate buckets",
    );
  }
  return { deleted: deleted.length };
}

// ── Raw position-payload ring buffer (Tasks #1392, #1676) ────────────────────
//
// The minute-bucket counter above tells ops *how loud* a watch session is, but
// not *what* it's emitting. When ops drills into a noisy session from the
// chart, they need to see the actual lat/lon/accuracy/timestamps so they can
// decide whether the watch is stuck in a tight loop, drifting, or being faked.
//
// Storage: a shared `watch_position_samples` Postgres table, holding the most
// recent N samples per session (per-session ring cap enforced on every insert)
// and pruned by a TTL sweep that piggy-backs on the existing daily metrics
// prune cron.
//
// Task #1676 promoted this from an in-process per-replica `Map` to the shared
// table above so a misbehaving watch's recent positions are visible from any
// api-server replica. Previously the WS socket pinned the writer to one
// replica while the dashboard read landed on whichever replica the load
// balancer picked, so ops had to refresh until they hit the right one and
// the panel showed "no recent positions" even though another replica had
// them. With the table everyone reads from the same place.
//
// We keep the size discipline of the original ring buffer:
//   - Per-session cap (POSITION_SAMPLE_RING_SIZE rows): every insert also
//     opportunistically deletes that session's rows beyond the cap, so the
//     table size is bounded by `(active sessions × ring size)` regardless of
//     watch send rate.
//   - TTL eviction (POSITION_SAMPLE_TTL_MS): reads filter older rows out, and
//     the daily prune sweep (`pruneWatchPositionSamples`) deletes them so
//     sessions that disconnected without being trimmed don't pile up.

const POSITION_SAMPLE_RING_SIZE = 100; // last N samples per session
const POSITION_SAMPLE_TTL_MS = 30 * 60 * 1000; // evict samples older than 30 min

export interface RecordWatchPositionSampleInput {
  sessionId: string;
  lat: number;
  lng: number;
  accuracy?: number | null;
  batteryMode: boolean;
  nowMs?: number; // injected in tests
}

/**
 * Append one raw position payload to the shared `watch_position_samples`
 * table so ops can later inspect what the watch was emitting from any
 * replica. Silently no-ops on non-finite coords.
 *
 * Returns a Promise so tests can await deterministic ordering, but the
 * common WS-handler caller can `void` the result — the function never
 * throws (DB errors are caught and logged).
 */
export function recordWatchPositionSample(
  input: RecordWatchPositionSampleInput,
): Promise<void> {
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) {
    return Promise.resolve();
  }
  const recordedAt = new Date(input.nowMs ?? Date.now());
  const accuracy =
    input.accuracy != null && Number.isFinite(input.accuracy)
      ? input.accuracy
      : null;
  return persistAndTrimSample({
    sessionId: input.sessionId,
    recordedAt,
    lat: input.lat,
    lng: input.lng,
    accuracy,
    batteryMode: input.batteryMode,
  }).catch((err: unknown) => {
    baseLogger.warn(
      { err, watchPosition: true, sessionId: input.sessionId },
      "[ws-watch/metrics] failed to persist watch position sample",
    );
  });
}

async function persistAndTrimSample(row: {
  sessionId: string;
  recordedAt: Date;
  lat: number;
  lng: number;
  accuracy: number | null;
  batteryMode: boolean;
}): Promise<void> {
  await db.insert(watchPositionSamplesTable).values(row);
  // Per-session ring cap: delete this session's rows beyond the most-recent
  // RING_SIZE so the table can't grow unbounded for a single noisy watch.
  // Indexed by (session_id, recorded_at desc) — the subquery and the outer
  // delete both hit the index, which keeps this cheap on the hot path.
  await db.execute(sql`
    DELETE FROM watch_position_samples
    WHERE session_id = ${row.sessionId}
      AND id NOT IN (
        SELECT id FROM watch_position_samples
        WHERE session_id = ${row.sessionId}
        ORDER BY recorded_at DESC, id DESC
        LIMIT ${POSITION_SAMPLE_RING_SIZE}
      )
  `);
}

export interface WatchPositionSamplePayload {
  /** ISO timestamp of when the server received the sample. */
  timestamp: string;
  lat: number;
  lng: number;
  /** Optional GPS accuracy in metres if the watch included it; otherwise null. */
  accuracy: number | null;
  batteryMode: boolean;
}

export interface WatchPositionSamplesResponse {
  sessionId: string;
  /** Most recent samples first; capped at the ring size. */
  samples: WatchPositionSamplePayload[];
  /** Total samples currently held in the ring (after stale eviction). */
  totalSamples: number;
  /** Per-session ring metadata so the UI can disclose limits accurately. */
  ringSize: number;
  ttlSeconds: number;
}

/**
 * Read the most recent raw position samples for a single watch session.
 * Returns up to `limit` samples, most-recent first. Samples older than the
 * TTL are filtered out of both `samples` and `totalSamples` (the daily
 * prune sweep deletes them from the table itself).
 */
export async function getRecentWatchPositionSamples(
  sessionId: string,
  limit = 50,
  nowMs: number = Date.now(),
): Promise<WatchPositionSamplesResponse> {
  const safeLimit = Math.max(
    1,
    Math.min(POSITION_SAMPLE_RING_SIZE, Math.floor(limit)),
  );
  const cutoff = new Date(nowMs - POSITION_SAMPLE_TTL_MS);
  const empty: WatchPositionSamplesResponse = {
    sessionId,
    samples: [],
    totalSamples: 0,
    ringSize: POSITION_SAMPLE_RING_SIZE,
    ttlSeconds: POSITION_SAMPLE_TTL_MS / 1000,
  };
  // Two parallel queries: one for the (limited) most-recent payload list
  // the UI renders, one for the total fresh-row count so the UI can show
  // "showing N of M" without paginating. Both hit the
  // (session_id, recorded_at desc) index. The session_id + cutoff filter
  // guarantees totalSamples is bounded by RING_SIZE in steady state.
  const [rows, countRows] = await Promise.all([
    db
      .select({
        recordedAt: watchPositionSamplesTable.recordedAt,
        lat: watchPositionSamplesTable.lat,
        lng: watchPositionSamplesTable.lng,
        accuracy: watchPositionSamplesTable.accuracy,
        batteryMode: watchPositionSamplesTable.batteryMode,
      })
      .from(watchPositionSamplesTable)
      .where(
        and(
          eq(watchPositionSamplesTable.sessionId, sessionId),
          gte(watchPositionSamplesTable.recordedAt, cutoff),
        ),
      )
      .orderBy(desc(watchPositionSamplesTable.recordedAt), desc(watchPositionSamplesTable.id))
      .limit(safeLimit),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(watchPositionSamplesTable)
      .where(
        and(
          eq(watchPositionSamplesTable.sessionId, sessionId),
          gte(watchPositionSamplesTable.recordedAt, cutoff),
        ),
      ),
  ]);
  const totalSamples = Number(countRows[0]?.count ?? 0);
  if (totalSamples === 0 || rows.length === 0) return empty;
  return {
    sessionId,
    samples: rows.map((r) => ({
      timestamp: r.recordedAt.toISOString(),
      lat: Number(r.lat),
      lng: Number(r.lng),
      accuracy: r.accuracy == null ? null : Number(r.accuracy),
      batteryMode: r.batteryMode,
    })),
    totalSamples,
    ringSize: POSITION_SAMPLE_RING_SIZE,
    ttlSeconds: POSITION_SAMPLE_TTL_MS / 1000,
  };
}

/**
 * Delete samples older than the TTL. Called from the daily metrics prune
 * cron so sessions that disconnected without being trimmed (or that
 * stopped sending before the per-session cap kicked in) don't pile up.
 */
export async function pruneWatchPositionSamples(
  nowMs: number = Date.now(),
): Promise<{ deleted: number }> {
  const cutoff = new Date(nowMs - POSITION_SAMPLE_TTL_MS);
  const deleted = await db
    .delete(watchPositionSamplesTable)
    .where(lt(watchPositionSamplesTable.recordedAt, cutoff))
    .returning({ id: watchPositionSamplesTable.id });
  if (deleted.length > 0) {
    baseLogger.info(
      { watchPosition: true, deleted: deleted.length, cutoff: cutoff.toISOString() },
      "[ws-watch/metrics] pruned stale position samples",
    );
  }
  return { deleted: deleted.length };
}

// Test helpers — clears in-process accumulators only. The DB tables are
// cleaned by the test fixtures themselves.
export function _resetWatchPositionMetricsForTests(): void {
  accumulators.clear();
  trendRing.length = 0;
  trendRingStart = 0;
  lastTrendWarnAt = 0;
  mutedSessions.clear();
}

/**
 * Test helper — exposes the in-process mute state for assertions without
 * leaking the underlying map. Returns null when the session is not muted
 * or its entry has already expired.
 */
export function _peekWatchSessionMuteForTests(
  sessionId: string,
  nowMs: number = Date.now(),
): { expiresAtMs: number } | null {
  const exp = mutedSessions.get(sessionId);
  if (exp == null || exp <= nowMs) return null;
  return { expiresAtMs: exp };
}

export function _peekWatchPositionAccumulatorForTests(sessionId: string): SessionAccumulator | undefined {
  const acc = accumulators.get(sessionId);
  return acc ? { ...acc } : undefined;
}

/**
 * Test helper — list every sessionId that currently has at least one
 * sample in the per-session position ring buffer. Used by the WS↔HTTP
 * end-to-end test (Task #1677) to discover the server-assigned
 * `sessionId` for the test's WebSocket connection without modifying
 * the wire protocol.
 */
export function _peekWatchPositionSampleSessionsForTests(): string[] {
  return Array.from(accumulators.keys());
}

/**
 * Test helper — exposes the env-driven recipient resolver so tests can
 * cover the `OPS_WATCH_GPS_ALERT_EMAILS` → `OPS_ALERT_EMAILS` fallback
 * order without having to fill the trend ring end-to-end.
 */
export function _resolveWatchGpsOpsAlertRecipientsForTests(): string[] {
  return getWatchGpsOpsAlertRecipients();
}

/**
 * Test helper — exposes the env-driven Slack webhook + PagerDuty
 * routing key resolver so tests can cover the per-channel
 * configuration matrix without filling the trend ring end-to-end.
 */
export function _resolveWatchGpsOpsAlertChatTargetsForTests(): {
  slackWebhook: string | null;
  pagerDutyRoutingKey: string | null;
} {
  return getWatchGpsOpsAlertChatTargets();
}

/**
 * Test helper — pushes a single value onto the trend ring and runs
 * `maybeWarnOnTrend` so tests can drive the alert path without spinning
 * 40 minute-rolls through `recordWatchPosition` + the DB.
 */
export function _pushTrendForTests(rate: number): void {
  pushTrend(rate);
  maybeWarnOnTrend();
}
