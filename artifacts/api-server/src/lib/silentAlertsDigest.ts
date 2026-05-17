/**
 * Task #1663 — Weekly super-admin "silent failures" CSV digest.
 *
 * The super-admin dashboard exposes a row-level health view of every
 * manual-entry alert (`/super-admin/manual-entry-alerts`, Task #1388).
 * Catching silent failures from that page requires someone to remember
 * to open it — so this cron mails every super_admin a CSV of the
 * previous 7 days of zero-delivery alerts every week, with a deep-link
 * that pre-applies the same filters when they open the dashboard.
 *
 * Behaviour:
 *   - `sendSilentAlertsDigestToSuperAdmins()` queries the previous 7
 *     days of `manual_entry_alerts` rows where `recipientCount > 0` AND
 *     `pushSent + emailSent = 0` (i.e. the alert was supposed to fan
 *     out but landed in nobody's inbox / device).
 *   - Recipients are every super_admin with an email AND
 *     `user_notification_prefs.notify_silent_alerts_digest = true`
 *     (default). The cron skips opted-out users — see
 *     `routes/portal.ts` GET/PATCH /portal/notification-preferences.
 *   - The CSV body is built via
 *     `buildManualEntryAlertsCsv(rows)` so the format stays in
 *     lockstep with the dashboard's CSV export route (Task #1388).
 *   - Dedup uses a 6.5-day floor persisted on a marker
 *     `member_audit_log` row (entity = "silent_alerts_digest", action
 *     = "send"). The cron can tick daily without spamming inboxes:
 *     reading `MAX(createdAt)` of the marker rows survives process
 *     restarts and re-deploys, mirroring the pattern in
 *     `planMigrationDigest.ts` (Task #1551).
 *
 * Parallel structure with `planMigrationDigest.ts`:
 *   - `MIN_GAP_MS` is the persisted dedup floor.
 *   - `_resetSilentAlertsDigestDedupForTest` lets the tests simulate a
 *     fresh install. Must be awaited.
 */

import { db } from "@workspace/db";
import {
  memberAuditLogTable,
  appUsersTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendSilentAlertsDigestEmail } from "./mailer";
import {
  listManualEntryAlertRows,
  buildManualEntryAlertsCsv,
  MANUAL_ENTRY_ALERT_CSV_MAX_ROWS,
  type ManualEntryAlertRow,
} from "./manualEntryAlertHealth";

/**
 * 6.5-day floor — a daily cron tick will skip until ~weekly cadence
 * resumes. Slightly under 7 days so a tick that drifts an hour late
 * doesn't postpone the next dispatch by a full day. Mirrors the
 * 23h/24h split used by `planMigrationDigest.ts` (Task #835).
 */
const MIN_GAP_MS = 6.5 * 24 * 60 * 60 * 1000;

/** 7-day rolling window for the CSV. */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Marker row predicate used for both the dedup floor read and the
 * test-only reset. We persist a single audit row per dispatch (entity
 * = "silent_alerts_digest", action = "send") so the dedup query is a
 * cheap MAX(createdAt) over a handful of rows.
 */
const MARKER_PREDICATE = and(
  eq(memberAuditLogTable.entity, "silent_alerts_digest"),
  eq(memberAuditLogTable.action, "send"),
);

/**
 * Returns the most-recent persisted dispatch timestamp (ms since
 * epoch), or `null` if no digest has ever been dispatched.
 */
async function getLastDispatchAtMs(): Promise<number | null> {
  try {
    const [row] = await db
      .select({
        lastAt: sql<Date | null>`MAX(${memberAuditLogTable.createdAt})`,
      })
      .from(memberAuditLogTable)
      .where(MARKER_PREDICATE);
    if (!row?.lastAt) return null;
    const ms = row.lastAt instanceof Date ? row.lastAt.getTime() : Date.parse(String(row.lastAt));
    return Number.isFinite(ms) ? ms : null;
  } catch (err) {
    // If the DB read fails we degrade by treating it as "no prior
    // dispatch". The downside is a possible duplicate digest in a
    // transient-failure window; the upside is we never silently skip
    // a real digest because the dedup query was unavailable.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[silent-alerts-digest] failed to read persisted dedup floor — assuming no prior dispatch",
    );
    return null;
  }
}

/**
 * Test-only: clear the persisted dedup so a test can simulate a fresh
 * install. Removes every marker audit row this module has written.
 * Must be awaited.
 */
export async function _resetSilentAlertsDigestDedupForTest() {
  await db.delete(memberAuditLogTable).where(MARKER_PREDICATE);
}

type SuperAdminRecipient = {
  id: number;
  email: string;
  displayName: string | null;
  username: string | null;
};

/**
 * Load every super_admin with an email AND
 * `notify_silent_alerts_digest = true`. Users without a prefs row are
 * INCLUDED (the column defaults to true, matching the migration).
 */
async function loadOptedInSuperAdmins(): Promise<SuperAdminRecipient[]> {
  const rows = await db
    .select({
      id: appUsersTable.id,
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      notifySilentAlertsDigest: userNotificationPrefsTable.notifySilentAlertsDigest,
    })
    .from(appUsersTable)
    .leftJoin(
      userNotificationPrefsTable,
      eq(userNotificationPrefsTable.userId, appUsersTable.id),
    )
    .where(eq(appUsersTable.role, "super_admin"));

  const recipients: SuperAdminRecipient[] = [];
  for (const r of rows) {
    if (!r.email) continue;
    // No prefs row = column default (true). Explicit false = opted out.
    if (r.notifySilentAlertsDigest === false) continue;
    recipients.push({
      id: r.id,
      email: r.email,
      displayName: r.displayName,
      username: r.username,
    });
  }
  return recipients;
}

function resolveBaseUrl(): string {
  return process.env.APP_BASE_URL
    ?? process.env.PUBLIC_BASE_URL
    ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`;
}

function csvFilename(windowEnd: Date): string {
  const stamp = windowEnd.toISOString().slice(0, 10); // YYYY-MM-DD
  return `silent-alerts-${stamp}.csv`;
}

/**
 * Persist a marker row so the next cron tick reads a fresh
 * `MAX(createdAt)` and skips the duplicate dispatch within the 6.5-day
 * floor. Stamping is best-effort: a write failure is logged but does
 * not throw, so a transient DB hiccup never silently skips a real
 * digest by dropping the dispatch entirely.
 */
async function stampDispatchMarker(opts: {
  rowCount: number;
  recipientsAttempted: number;
  recipientsEmailed: number;
  windowStart: string;
  windowEnd: string;
}): Promise<void> {
  try {
    await db.insert(memberAuditLogTable).values({
      organizationId: null,
      entity: "silent_alerts_digest",
      entityId: null,
      action: "send",
      reason: "Task #1663 weekly silent-failures digest",
      metadata: {
        rowCount: opts.rowCount,
        recipientsAttempted: opts.recipientsAttempted,
        recipientsEmailed: opts.recipientsEmailed,
        windowStart: opts.windowStart,
        windowEnd: opts.windowEnd,
      } as Record<string, unknown>,
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[silent-alerts-digest] failed to persist dispatch marker — dedup floor not advanced",
    );
  }
}

export type SendSilentAlertsDigestResult = {
  rowCount: number;
  recipientsAttempted: number;
  recipientsEmailed: number;
  skipped?: "deduped" | "no-rows" | "no-recipients";
};

/**
 * Email every opted-in super_admin a CSV of the previous 7 days of
 * zero-delivery manual-entry alerts. No-op when there are no silent
 * alert rows in the window or when the dedup floor has not elapsed.
 */
export async function sendSilentAlertsDigestToSuperAdmins(): Promise<SendSilentAlertsDigestResult> {
  // 1. Dedup gate — short-circuit cheap before pulling alert rows.
  const now = Date.now();
  const lastAtMs = await getLastDispatchAtMs();
  if (lastAtMs != null && now - lastAtMs < MIN_GAP_MS) {
    return {
      rowCount: 0,
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      skipped: "deduped",
    };
  }

  // 2. Pull the 7-day zero-delivery slice. Cap at the same upper bound
  //    as the route's CSV export so the email attachment stays bounded
  //    even if a stale filter pulls a giant window.
  const windowEnd = new Date(now);
  const windowStart = new Date(now - WINDOW_MS);
  const data = await listManualEntryAlertRows({
    sinceDays: 7,
    zeroDeliveryOnly: true,
    limit: MANUAL_ENTRY_ALERT_CSV_MAX_ROWS,
    offset: 0,
    maxLimit: MANUAL_ENTRY_ALERT_CSV_MAX_ROWS,
  });
  const rows: ManualEntryAlertRow[] = data.rows;

  if (rows.length === 0) {
    // Stamp the marker anyway so a quiet week does not bunch up two
    // mid-week ticks once a non-zero row finally appears. Same dedup
    // semantics as planMigrationDigest's "no-rows" short-circuit, but
    // here we DO want to advance the floor — otherwise every daily
    // tick would run the heavy query.
    await stampDispatchMarker({
      rowCount: 0,
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    });
    return {
      rowCount: 0,
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      skipped: "no-rows",
    };
  }

  // 3. Recipients (super_admins with email + opted in).
  const recipients = await loadOptedInSuperAdmins();
  if (recipients.length === 0) {
    logger.warn(
      { rowCount: rows.length },
      "[silent-alerts-digest] no opted-in super_admin recipients — skipping",
    );
    return {
      rowCount: rows.length,
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      skipped: "no-recipients",
    };
  }

  // 4. Build the CSV once and reuse the same body for every recipient.
  const csv = buildManualEntryAlertsCsv(rows);
  const filename = csvFilename(windowEnd);
  const baseUrl = resolveBaseUrl();
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();

  let emailed = 0;
  for (const rec of recipients) {
    try {
      await sendSilentAlertsDigestEmail({
        to: rec.email,
        staffName: rec.displayName ?? rec.username ?? "Super Admin",
        baseUrl,
        windowStart: windowStartIso,
        windowEnd: windowEndIso,
        rowCount: rows.length,
        filename,
        csv,
      });
      emailed += 1;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), recipient: rec.email },
        "[silent-alerts-digest] email failed",
      );
    }
  }

  // 5. Stamp the dedup marker even if some sends failed — that keeps
  //    inboxes safe when SMTP is broken (we'd rather miss a digest
  //    than spam a working inbox 24× while the queue retries).
  await stampDispatchMarker({
    rowCount: rows.length,
    recipientsAttempted: recipients.length,
    recipientsEmailed: emailed,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
  });

  logger.info(
    {
      rowCount: rows.length,
      recipientsAttempted: recipients.length,
      recipientsEmailed: emailed,
    },
    "[silent-alerts-digest] dispatched",
  );

  return {
    rowCount: rows.length,
    recipientsAttempted: recipients.length,
    recipientsEmailed: emailed,
  };
}

// Re-export the marker predicate for tests that need to clean up rows
// the cron writes outside of `_resetSilentAlertsDigestDedupForTest`
// (e.g. tracking marker rows for `inArray` deletes in afterAll).
export { MARKER_PREDICATE as _SILENT_ALERTS_DIGEST_MARKER_PREDICATE };
