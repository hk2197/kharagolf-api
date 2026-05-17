/**
 * Tests for Task #2224 — retention prune for `notification_audit_log`.
 *
 * The audit log is append-only and was never pruned; over time the
 * per-user `/api/portal/notification-audit` query (capped at 365 days)
 * would scan more rows than necessary and the table would grow without
 * bound, with personal data riding inside `payload` outliving the
 * erasure pipeline this audit log is meant to backstop. The cron now
 * deletes rows older than the configured retention window (365 days
 * by default; tunable via `NOTIFICATION_AUDIT_LOG_RETENTION_DAYS`).
 *
 * Covers:
 *   - Rows older than the cutoff are deleted; rows inside the window
 *     are preserved.
 *   - The custom retention override (in days) is honoured when passed
 *     directly, so tests don't have to mutate process.env.
 *   - When nothing crosses the cutoff the helper is a no-op (deleted=0).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db, notificationAuditLogTable, appUsersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  pruneNotificationAuditLog,
  DEFAULT_NOTIFICATION_AUDIT_LOG_RETENTION_DAYS,
} from "../lib/notifyDispatch.js";

let testUserId: number | null = null;

beforeAll(async () => {
  const tag = `notif-audit-prune-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: tag,
      username: tag,
      email: `${tag}@example.com`,
      role: "player",
      displayName: "Notification Audit Prune Tester",
    })
    .returning({ id: appUsersTable.id });
  testUserId = u.id;
});

afterAll(async () => {
  if (testUserId !== null) {
    // The FK from notification_audit_log → app_users is ON DELETE SET NULL,
    // so it's safe to tear the user down even if a row leaked through.
    await db
      .delete(notificationAuditLogTable)
      .where(eq(notificationAuditLogTable.userId, testUserId));
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
});

beforeEach(async () => {
  // Tests in this file own the table — clear leftovers belonging to
  // this user so each case starts from a known baseline. We scope by
  // userId so we don't disturb fixtures other suites might rely on.
  if (testUserId !== null) {
    await db
      .delete(notificationAuditLogTable)
      .where(eq(notificationAuditLogTable.userId, testUserId));
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("pruneNotificationAuditLog — Task #2224", () => {
  it("deletes rows older than the retention window and keeps fresh ones", async () => {
    const now = Date.now();
    const old1 = new Date(now - 400 * DAY_MS); // > 1y
    const old2 = new Date(now - 366 * DAY_MS); // just over the default
    const fresh1 = new Date(now - 364 * DAY_MS); // just inside
    const fresh2 = new Date(now - 1 * DAY_MS); // very recent

    const inserted = await db
      .insert(notificationAuditLogTable)
      .values([
        {
          notificationKey: "test.key",
          userId: testUserId,
          channel: "email",
          status: "skipped",
          reason: "event_opted_out",
          payload: {},
          createdAt: old1,
        },
        {
          notificationKey: "test.key",
          userId: testUserId,
          channel: "push",
          status: "skipped",
          reason: "event_opted_out",
          payload: {},
          createdAt: old2,
        },
        {
          notificationKey: "test.key",
          userId: testUserId,
          channel: "email",
          status: "sent",
          payload: {},
          createdAt: fresh1,
        },
        {
          notificationKey: "test.key",
          userId: testUserId,
          channel: "push",
          status: "sent",
          payload: {},
          createdAt: fresh2,
        },
      ])
      .returning({ id: notificationAuditLogTable.id });

    const result = await pruneNotificationAuditLog();
    expect(result.deleted).toBeGreaterThanOrEqual(2);
    expect(result.retentionDays).toBe(DEFAULT_NOTIFICATION_AUDIT_LOG_RETENTION_DAYS);

    const remaining = await db
      .select({ id: notificationAuditLogTable.id })
      .from(notificationAuditLogTable)
      .where(inArray(notificationAuditLogTable.id, inserted.map((r) => r.id)));
    expect(remaining).toHaveLength(2);
  });

  it("honours a caller-provided retention override (in days)", async () => {
    const now = Date.now();
    const day10 = new Date(now - 10 * DAY_MS);
    const day3 = new Date(now - 3 * DAY_MS);

    const inserted = await db
      .insert(notificationAuditLogTable)
      .values([
        {
          notificationKey: "test.key",
          userId: testUserId,
          channel: "email",
          status: "sent",
          payload: {},
          createdAt: day10,
        },
        {
          notificationKey: "test.key",
          userId: testUserId,
          channel: "email",
          status: "sent",
          payload: {},
          createdAt: day3,
        },
      ])
      .returning({ id: notificationAuditLogTable.id });

    // 7-day window — only the 10-day-old row should fall out.
    const result = await pruneNotificationAuditLog(7);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(result.retentionDays).toBe(7);

    const remaining = await db
      .select({ id: notificationAuditLogTable.id })
      .from(notificationAuditLogTable)
      .where(inArray(notificationAuditLogTable.id, inserted.map((r) => r.id)));
    expect(remaining).toHaveLength(1);
  });

  it("is a no-op when nothing has aged out", async () => {
    const recent = new Date(Date.now() - 5 * DAY_MS);
    const inserted = await db
      .insert(notificationAuditLogTable)
      .values({
        notificationKey: "test.key",
        userId: testUserId,
        channel: "email",
        status: "sent",
        payload: {},
        createdAt: recent,
      })
      .returning({ id: notificationAuditLogTable.id });

    const result = await pruneNotificationAuditLog();
    // Other suites may have inserted ancient rows under different user
    // ids; we only assert that *our* fresh row survives.
    const remaining = await db
      .select({ id: notificationAuditLogTable.id })
      .from(notificationAuditLogTable)
      .where(inArray(notificationAuditLogTable.id, inserted.map((r) => r.id)));
    expect(remaining).toHaveLength(1);
    expect(result.retentionDays).toBe(DEFAULT_NOTIFICATION_AUDIT_LOG_RETENTION_DAYS);
  });
});
