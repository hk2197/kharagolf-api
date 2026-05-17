/**
 * Tests for Task #1925 — retention prune for `ops_alert_settings_history`.
 *
 * The audit log appends one row per super-admin PATCH and was never
 * pruned; a misbehaving script (or noisy incident with frequent
 * toggles) would otherwise grow the table without bound. The cron now
 * deletes rows older than the configured retention window (1 year by
 * default; tunable via `OPS_ALERT_SETTINGS_HISTORY_RETENTION_DAYS`).
 *
 * Covers:
 *   - Rows older than the cutoff are deleted; rows inside the window
 *     are preserved.
 *   - The custom retention override (in days) is honoured when passed
 *     directly, so tests don't have to mutate process.env.
 *   - When nothing crosses the cutoff the helper is a no-op (deleted=0).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db, opsAlertSettingsHistoryTable, appUsersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  pruneOpsAlertSettingsHistory,
  DEFAULT_OPS_ALERT_SETTINGS_HISTORY_RETENTION_DAYS,
} from "../lib/opsAlertSettings.js";

let testUserId: number | null = null;

beforeAll(async () => {
  const tag = `ops-audit-prune-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: tag,
      username: tag,
      email: `${tag}@example.com`,
      role: "super_admin",
      displayName: "Ops Audit Prune Tester",
    })
    .returning({ id: appUsersTable.id });
  testUserId = u.id;
});

afterAll(async () => {
  if (testUserId !== null) {
    // Audit rows pointing at this user are cleared by the per-test
    // delete below, but the FK is ON DELETE SET NULL so it's safe to
    // tear down the user even if a row leaked through.
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
});

beforeEach(async () => {
  // Tests in this file own the table — clear any leftovers so each case
  // starts from a known baseline.
  await db.delete(opsAlertSettingsHistoryTable);
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("pruneOpsAlertSettingsHistory — Task #1925", () => {
  it("deletes rows older than the retention window and keeps fresh ones", async () => {
    const now = Date.now();
    const old1 = new Date(now - 400 * DAY_MS); // > 1y
    const old2 = new Date(now - 366 * DAY_MS); // just over the default
    const fresh1 = new Date(now - 364 * DAY_MS); // just inside
    const fresh2 = new Date(now - 1 * DAY_MS); // very recent

    const inserted = await db
      .insert(opsAlertSettingsHistoryTable)
      .values([
        { changedAt: old1, changedByUserId: testUserId, prevThreshold: 1, newThreshold: 2 },
        { changedAt: old2, changedByUserId: testUserId, prevThreshold: 2, newThreshold: 3 },
        { changedAt: fresh1, changedByUserId: testUserId, prevThreshold: 3, newThreshold: 4 },
        { changedAt: fresh2, changedByUserId: testUserId, prevThreshold: 4, newThreshold: 5 },
      ])
      .returning({ id: opsAlertSettingsHistoryTable.id, changedAt: opsAlertSettingsHistoryTable.changedAt });

    const result = await pruneOpsAlertSettingsHistory();
    expect(result.deleted).toBe(2);
    expect(result.retentionDays).toBe(DEFAULT_OPS_ALERT_SETTINGS_HISTORY_RETENTION_DAYS);

    const remaining = await db
      .select({ id: opsAlertSettingsHistoryTable.id })
      .from(opsAlertSettingsHistoryTable)
      .where(inArray(opsAlertSettingsHistoryTable.id, inserted.map((r) => r.id)));
    expect(remaining).toHaveLength(2);
  });

  it("honours a caller-provided retention override (in days)", async () => {
    const now = Date.now();
    const day10 = new Date(now - 10 * DAY_MS);
    const day3 = new Date(now - 3 * DAY_MS);

    await db.insert(opsAlertSettingsHistoryTable).values([
      { changedAt: day10, changedByUserId: testUserId, prevThreshold: 1, newThreshold: 2 },
      { changedAt: day3, changedByUserId: testUserId, prevThreshold: 2, newThreshold: 3 },
    ]);

    // 7-day window — only the 10-day-old row should fall out.
    const result = await pruneOpsAlertSettingsHistory(7);
    expect(result.deleted).toBe(1);
    expect(result.retentionDays).toBe(7);

    const after = await db.select({ id: opsAlertSettingsHistoryTable.id }).from(opsAlertSettingsHistoryTable);
    expect(after).toHaveLength(1);
  });

  it("is a no-op when nothing has aged out", async () => {
    const recent = new Date(Date.now() - 5 * DAY_MS);
    await db.insert(opsAlertSettingsHistoryTable).values({
      changedAt: recent,
      changedByUserId: testUserId,
      prevThreshold: 1,
      newThreshold: 2,
    });

    const result = await pruneOpsAlertSettingsHistory();
    expect(result.deleted).toBe(0);

    const after = await db.select({ id: opsAlertSettingsHistoryTable.id }).from(opsAlertSettingsHistoryTable);
    expect(after).toHaveLength(1);
  });
});
