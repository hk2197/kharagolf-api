/**
 * Year in Golf launch & quarterly recap broadcast scheduler + aggregation job.
 *
 * Runs in-process. On each tick (hourly) it:
 *   1. Checks whether we're inside a launch window for the previous full
 *      window (year/quarter) and, if so, sends launch and reminder push
 *      notifications to every opted-in player on the configured cadence.
 *   2. Pre-runs ("primes") the recap aggregation queries for opted-in users
 *      on the first day of each launch window so the first real request
 *      hits warm DB / OS page caches rather than cold ones. Results are
 *      intentionally not persisted — the aggregator is fast enough at read
 *      time and a stale stored snapshot would mis-represent late-arriving
 *      scores. If the product later needs durable snapshots, materialise
 *      them in a dedicated `year_in_golf_snapshots` table.
 *
 * Broadcast send-state is persisted in the `recap_broadcasts` table
 * (Task #450) so a server restart inside a launch window cannot re-fire
 * a push that already went out. The cron claims a (year, period, day)
 * row via `INSERT ... ON CONFLICT DO NOTHING` BEFORE dispatching push
 * batches; if the insert is a no-op (row already exists from a previous
 * tick / previous process) the broadcast is skipped. The cache-warming
 * `primedWindows` set stays in-process — re-priming after a restart is
 * harmless (it just re-warms DB caches), so paying for a DB round-trip
 * to dedup it would be pure overhead.
 *
 * Players opt out via the existing `user_notification_prefs.preferPush`
 * field, settable from the Year in Golf settings UI on mobile and web.
 */
import { db, appUsersTable, deviceTokensTable, userNotificationPrefsTable, recapBroadcastsTable, notificationAuditLogTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { sendPushToUsers } from "./push";
import { logger as baseLogger } from "./logger";
import { primeYearInGolfCache, type RecapPeriod } from "./year-in-golf";

const logger = baseLogger.child({ scope: "year-in-golf-cron" });

// Task #1496 — every per-recipient dispatch row written by this cron uses
// this fixed notification key so the admin drill-down endpoint can match
// audit rows back to a specific (year, period, day) broadcast via the
// `payload` JSON. Mirrors the registry entry of the same name.
export const RECAP_NOTIFICATION_KEY = "recap.year.ready";

const POLL_INTERVAL_MS = 60 * 60 * 1000; // hourly

const primedWindows = new Set<string>();

interface LaunchWindow {
  eventName: string;
  year: number;
  period: RecapPeriod;
  label: string;
  /** Day-of-window (1-based: 1, 4, 7) drives the launch + reminder cadence. */
  day: number;
}

/** Reminder days within a launch window — day 1 launch + day 4 + day 7 nudge. */
const REMINDER_DAYS = new Set<number>([1, 4, 7]);

/**
 * Returns every launch window that is currently pending for the given day.
 * Multiple launches can be active simultaneously — e.g. early January carries
 * both the previous year's annual recap (Jan 1–10) and that year's Q4
 * recap (Jan 1–7). The caller iterates and broadcasts/warms each one
 * idempotently.
 *  - Annual recap: Jan 1–10 → previous year.
 *  - Quarterly recap: 1st–7th of the month following Q end
 *    (Apr → Q1, Jul → Q2, Oct → Q3, Jan → Q4 of previous year).
 */
export function pendingLaunches(now: Date): LaunchWindow[] {
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const y = now.getUTCFullYear();
  const out: LaunchWindow[] = [];
  if (m === 0 && d <= 10) out.push({ eventName: `year_in_golf_${y - 1}_year_d${d}`, year: y - 1, period: "year", label: `${y - 1}`, day: d });
  if (m === 0 && d <= 7) out.push({ eventName: `year_in_golf_${y - 1}_q4_d${d}`, year: y - 1, period: "q4", label: `Q4 ${y - 1}`, day: d });
  if (m === 3 && d <= 7) out.push({ eventName: `year_in_golf_${y}_q1_d${d}`, year: y, period: "q1", label: `Q1 ${y}`, day: d });
  if (m === 6 && d <= 7) out.push({ eventName: `year_in_golf_${y}_q2_d${d}`, year: y, period: "q2", label: `Q2 ${y}`, day: d });
  if (m === 9 && d <= 7) out.push({ eventName: `year_in_golf_${y}_q3_d${d}`, year: y, period: "q3", label: `Q3 ${y}`, day: d });
  return out;
}

/** Back-compat shim: returns the first pending launch (used in tests/manual). */
export function pendingLaunch(now: Date): LaunchWindow | null {
  return pendingLaunches(now)[0] ?? null;
}

async function eligibleUserIds(): Promise<number[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT u.id AS user_id
      FROM ${appUsersTable} u
      JOIN ${deviceTokensTable} d ON d.user_id = u.id
      LEFT JOIN ${userNotificationPrefsTable} p ON p.user_id = u.id
     WHERE COALESCE(p.prefer_push, true) = true
  `);
  return ((rows as unknown as { rows?: Array<{ user_id: number }> }).rows ?? (rows as unknown as Array<{ user_id: number }>))
    .map(r => Number(r.user_id))
    .filter(Number.isFinite);
}

/**
 * Pre-runs the aggregation queries so the first real recap request hits warm
 * caches. Idempotent per window per process via `primedWindows`.
 *
 * Task #1842 — the warm-up now writes through `primeYearInGolfCache`, which
 * stores each result in the same in-memory recap cache (`getCachedYearInGolf`)
 * that every user-facing recap fetch reads from (public PNG, portal recap
 * JSON, portal card.png, portal video.mp4). That means the very first user
 * who taps the launch push notification skips the aggregation entirely
 * instead of paying a fresh DB round-trip seconds after the cron just
 * computed the same recap for them. The prime path uses a longer cache TTL
 * (see `RECAP_PRIME_CACHE_TTL_MS`) than the request-handler entry point so
 * the warmed entries survive the post-push tap spike rather than expiring
 * before most recipients get around to opening the recap.
 *
 * Results are still not persisted to a durable snapshot table — the
 * aggregator is fast enough at read time once the cache is warm, and a
 * stale stored snapshot would mis-represent late-arriving scores. See the
 * file header for the broader rationale.
 */
async function primeRecapAggregations(launch: LaunchWindow): Promise<void> {
  const key = `prime_${launch.year}_${launch.period}`;
  if (primedWindows.has(key)) return;
  const userIds = await eligibleUserIds();
  let ok = 0; let fail = 0;
  for (const uid of userIds) {
    try { await primeYearInGolfCache(uid, launch.year, launch.period); ok++; }
    catch (err) { fail++; logger.warn({ err, uid }, "[year-in-golf-cron] prime failed"); }
  }
  primedWindows.add(key);
  logger.info({ window: key, ok, fail }, "[year-in-golf-cron] recap aggregations primed into in-memory cache");
}

/**
 * Atomically claim the (year, period, day) slot for this broadcast. Returns
 * true if this caller acquired the claim (and must therefore perform the
 * send), false if another tick / a previous process had already claimed it.
 *
 * `recipients` is recorded best-effort at claim time; an exact post-send
 * count is not necessary for the dedup contract and trying to update it
 * after the send would re-introduce a race window on restart.
 */
async function claimBroadcastSlot(launch: LaunchWindow, recipients: number): Promise<boolean> {
  const inserted = await db
    .insert(recapBroadcastsTable)
    .values({
      year: launch.year,
      period: launch.period,
      day: launch.day,
      recipients,
    })
    .onConflictDoNothing()
    .returning({ year: recapBroadcastsTable.year });
  return inserted.length > 0;
}

async function sendLaunchBroadcastFor(launch: LaunchWindow): Promise<void> {
  // Reminder cadence: only fire on launch day + reminder days.
  if (!REMINDER_DAYS.has(launch.day)) return;

  const userIds = await eligibleUserIds();

  // Claim the slot BEFORE dispatching the push so a crash mid-send
  // cannot re-fire on the next tick / next process. We claim even
  // when there are no eligible recipients so the empty-window decision
  // is also persisted.
  const claimed = await claimBroadcastSlot(launch, userIds.length);
  if (!claimed) return;

  if (userIds.length === 0) return;

  logger.info({ event: launch.eventName, day: launch.day, recipients: userIds.length }, "[year-in-golf-cron] sending recap push");

  const launchTitle = launch.period === "year" ? `Your ${launch.label} in Golf is here 🏌️` : `Your ${launch.label} recap is ready 🏌️`;
  const reminderTitle = launch.period === "year" ? `Don't miss your ${launch.label} recap` : `${launch.label} recap — still waiting 👋`;
  const launchBody = launch.period === "year"
    ? `Tap to relive your year on the course — best round, longest drive, courses played and more.`
    : `Three months of golf, summed up. Best round, top courses & your handicap journey.`;
  const reminderBody = `It only takes a minute — swipe through your highlights and share your favourite cards.`;
  const isLaunchDay = launch.day === 1;
  const title = isLaunchDay ? launchTitle : reminderTitle;
  const body = isLaunchDay ? launchBody : reminderBody;

  const BATCH = 200;
  // Task #1240 — fire-and-forget broadcast: per-recipient delivery status
  // is intentionally not classified. The cron logs `recipients` in the
  // info log above (the count we attempted to fan out to) but the
  // PushDeliveryResult itself is discarded — recipients without a device
  // token simply do not receive the launch push, identical to how every
  // other broadcast in this file behaves. No `classifyPushDelivery`
  // mapping is needed because nothing downstream branches on `failed`.
  for (let i = 0; i < userIds.length; i += BATCH) {
    const slice = userIds.slice(i, i + BATCH);
    try {
      await sendPushToUsers(slice, title, body, { type: "year_in_golf_launch", year: String(launch.year), period: launch.period });
    } catch (err) {
      logger.warn({ err, batchStart: i }, "[year-in-golf-cron] push batch failed");
    }
  }

  // Task #2008 — branded `recap.year.ready` dispatch (email + digest fan-out
  // per recipient preference) layered on top of the bespoke push batches
  // above. The push batches above remain the primary delivery channel; this
  // adds the polished email + digest renders for users who opted out of push
  // but still want their recap notification. Same per-recipient `userIds`
  // list and same batching so digest fan-out stays bounded.
  try {
    const { notifyRecapYearReady } = await import("./brandedNotifications.js");
    for (let i = 0; i < userIds.length; i += BATCH) {
      const slice = userIds.slice(i, i + BATCH);
      void notifyRecapYearReady({
        userIds: slice,
        year: launch.year,
      });
    }
  } catch (err) {
    logger.warn({ err, event: launch.eventName }, "[year-in-golf-cron] branded recap notify failed (non-fatal)");
  }

  // Task #1496 — write per-recipient audit rows so the admin
  // /admin/recap-broadcasts/recipients drill-down can answer "did Jane in
  // club X actually get the recap?" without ops cross-referencing logs by
  // hand. Match the slot-claim contract: we write the audit rows AFTER the
  // slot is claimed but at attempt-time, mirroring `recipients` in the DB
  // claim above. The cron stays fire-and-forget at the push provider
  // level (Task #1240), so each row's `status` reflects the dispatch
  // attempt, not delivery confirmation. Failures here are non-fatal —
  // missing audit rows just mean the drill-down shows fewer recipients,
  // which is preferable to crashing the broadcast.
  try {
    const auditPayload = {
      year: launch.year,
      period: launch.period,
      day: launch.day,
      kind: isLaunchDay ? "launch" : "reminder",
      type: "year_in_golf_launch",
    } as const;
    // Bulk insert in chunks to avoid exceeding the postgres bind-param
    // limit (~32k) on very large recipient lists. 1000 rows per chunk
    // fits comfortably below that even with the JSON payload column.
    const AUDIT_CHUNK = 1000;
    for (let i = 0; i < userIds.length; i += AUDIT_CHUNK) {
      const slice = userIds.slice(i, i + AUDIT_CHUNK);
      await db.insert(notificationAuditLogTable).values(
        slice.map(uid => ({
          notificationKey: RECAP_NOTIFICATION_KEY,
          userId: uid,
          channel: "push",
          status: "sent",
          payload: auditPayload,
        })),
      );
    }
  } catch (err) {
    logger.warn({ err, event: launch.eventName }, "[year-in-golf-cron] audit log write failed");
  }
}

export async function tick(now: Date = new Date()): Promise<void> {
  const launches = pendingLaunches(now);
  if (launches.length === 0) return;
  for (const launch of launches) {
    // Warm snapshots once per window (cheap on subsequent ticks: gated by Set).
    await primeRecapAggregations(launch).catch((err: unknown) =>
      logger.warn({ err, launch: launch.eventName }, "[year-in-golf-cron] prime tick failed"),
    );
    await sendLaunchBroadcastFor(launch).catch((err: unknown) =>
      logger.warn({ err, launch: launch.eventName }, "[year-in-golf-cron] broadcast failed"),
    );
  }
}

/**
 * Test-only: clears the in-process `primedWindows` Set so a test can
 * simulate a process restart between cron ticks. The DB-backed dedup
 * (`recap_broadcasts`) is what guards against double-sends; this helper
 * exists purely so the dedup contract can be exercised in a single
 * Vitest process.
 */
export function _resetPrimedWindowsForTest(): void {
  primedWindows.clear();
}

export function startYearInGolfCron(): void {
  tick().catch((err: unknown) =>
    logger.warn({ err }, "[year-in-golf-cron] initial run failed"),
  );
  setInterval(() => {
    tick().catch((err: unknown) =>
      logger.warn({ err }, "[year-in-golf-cron] poll failed"),
    );
  }, POLL_INTERVAL_MS);
}
