/**
 * Task #1005 — Daily notification digest delivery.
 *
 * `runNotificationDigest()` drains the `notification_digest_queue`:
 *   1. Selects every undelivered row.
 *   2. Groups them by user.
 *   3. For each user with email enabled, sends one summary email
 *      listing every queued notification (title + body), then marks
 *      every drained row `deliveredAt = now()`.
 *   4. Users with no email address (or with `preferEmail = false`) get
 *      their queue cleared with a `deliveredAt` stamp + a "skipped" log
 *      so the queue does not grow unbounded.
 *
 * The cron in `lib/cron.ts` invokes this once per day. Safe to call
 * repeatedly: rows already marked `deliveredAt IS NOT NULL` are skipped
 * by the `IS NULL` predicate.
 */
import { db, notificationDigestQueueTable, appUsersTable, userNotificationPrefsTable } from "@workspace/db";
import { and, eq, gte, inArray, isNotNull, isNull, max } from "drizzle-orm";
import { sendDigestSummaryEmail } from "./mailer.js";
import { logger } from "./logger.js";

/** Per-user idempotency window: do not send a second digest within this many hours. */
const DIGEST_MIN_INTERVAL_HOURS = 20;

export interface DigestRunResult {
  usersProcessed: number;
  emailsSent: number;
  rowsDelivered: number;
  rowsSkipped: number;
}

export async function runNotificationDigest(): Promise<DigestRunResult> {
  const out: DigestRunResult = { usersProcessed: 0, emailsSent: 0, rowsDelivered: 0, rowsSkipped: 0 };
  const queued = await db.select()
    .from(notificationDigestQueueTable)
    .where(isNull(notificationDigestQueueTable.deliveredAt))
    .limit(10000);
  if (queued.length === 0) return out;

  const byUser = new Map<number, typeof queued>();
  for (const row of queued) {
    const arr = byUser.get(row.userId) ?? [];
    arr.push(row);
    byUser.set(row.userId, arr);
  }

  const userIds = Array.from(byUser.keys());

  // Per-user/day idempotency: skip any user who already received a
  // digest within the last DIGEST_MIN_INTERVAL_HOURS. This guarantees
  // at most one digest per user per day even if the cron is invoked
  // again (e.g. process restart, manual run, drift).
  const cutoff = new Date(Date.now() - DIGEST_MIN_INTERVAL_HOURS * 60 * 60 * 1000);
  const recentRows = await db.select({
    userId: notificationDigestQueueTable.userId,
    last: max(notificationDigestQueueTable.deliveredAt),
  }).from(notificationDigestQueueTable)
    .where(and(
      inArray(notificationDigestQueueTable.userId, userIds),
      isNotNull(notificationDigestQueueTable.deliveredAt),
      gte(notificationDigestQueueTable.deliveredAt, cutoff),
    ))
    .groupBy(notificationDigestQueueTable.userId);
  const recentlyDelivered = new Set(recentRows.map(r => r.userId));

  const userRows = await db.select({
    id: appUsersTable.id,
    email: appUsersTable.email,
    displayName: appUsersTable.displayName,
  }).from(appUsersTable).where(inArray(appUsersTable.id, userIds));
  const userInfo = new Map(userRows.map(u => [u.id, u]));

  const prefRows = await db.select({
    userId: userNotificationPrefsTable.userId,
    preferEmail: userNotificationPrefsTable.preferEmail,
  }).from(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, userIds));
  const prefMap = new Map(prefRows.map(p => [p.userId, p.preferEmail]));

  for (const [uid, rows] of byUser) {
    out.usersProcessed += 1;
    const u = userInfo.get(uid);
    const wantsEmail = prefMap.get(uid) ?? true;
    const ids = rows.map(r => r.id);
    if (recentlyDelivered.has(uid)) {
      // Already received a digest within the idempotency window — leave
      // these rows queued for the next eligible run.
      logger.info({ uid, queued: ids.length }, "[notification-digest] skipping; recent digest already sent");
      out.rowsSkipped += ids.length;
      continue;
    }
    if (u?.email && wantsEmail) {
      try {
        await sendDigestSummaryEmail({
          to: u.email,
          name: u.displayName ?? "there",
          items: rows.map(r => ({ key: r.notificationKey, title: r.title, body: r.body })),
        });
        out.emailsSent += 1;
        out.rowsDelivered += ids.length;
      } catch (err) {
        logger.warn({ uid, err }, "[notification-digest] email send failed");
        out.rowsSkipped += ids.length;
        continue;
      }
    } else {
      out.rowsSkipped += ids.length;
    }
    await db.update(notificationDigestQueueTable)
      .set({ deliveredAt: new Date() })
      .where(inArray(notificationDigestQueueTable.id, ids));
  }
  return out;
}
