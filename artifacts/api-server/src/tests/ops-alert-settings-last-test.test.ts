/**
 * Tests for Task #1916 — record when the last "Send test alert" was
 * fired so the super-admin Ops Alert card can display
 * "Last test sent <relative time> ago to N recipient(s)" beside the
 * button (and stop encouraging duplicate test sends).
 *
 * Covers:
 *   - `recordOpsAlertTestSent` stamps the singleton row with the
 *     provided timestamp + recipient count + editor user id.
 *   - The stamp does NOT touch any of the six override columns or the
 *     `updated_*` audit fields (a test send is not a tunable change).
 *   - The stamp does NOT append a row to `ops_alert_settings_history`.
 *   - `resolveOpsAlertConfig` surfaces the new fields (timestamp,
 *     recipient count, and joined editor display name / username).
 *   - Calling `recordOpsAlertTestSent` when no singleton row exists yet
 *     creates one with NULL overrides, so a brand-new deploy can stamp
 *     successfully without a prior PATCH.
 *   - Repeated calls overwrite the previous stamp (we only ever care
 *     about the *most recent* test).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  db,
  opsAlertSettingsTable,
  opsAlertSettingsHistoryTable,
  appUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  recordOpsAlertTestSent,
  resolveOpsAlertConfig,
  updateOpsAlertSettings,
  _resetOpsAlertSettingsCacheForTest,
} from "../lib/opsAlertSettings.js";

let testUserId: number | null = null;

beforeAll(async () => {
  const tag = `ops-last-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: tag,
      username: tag,
      email: `${tag}@example.com`,
      role: "super_admin",
      displayName: "Ops Last-Test Tester",
    })
    .returning({ id: appUsersTable.id });
  testUserId = u.id;
});

afterAll(async () => {
  if (testUserId !== null) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
});

beforeEach(async () => {
  _resetOpsAlertSettingsCacheForTest();
  await db.delete(opsAlertSettingsHistoryTable);
  // Reset the singleton row to the all-NULL baseline so each test
  // starts from the same place.
  await db
    .update(opsAlertSettingsTable)
    .set({
      notifyExhaustionThreshold: null,
      notifyExhaustionWindowHours: null,
      manualEntryRateThresholdPct: null,
      manualEntryMinSample: null,
      manualEntryConsecutiveZero: null,
      manualEntryCooldownHours: null,
      // Task #2081 — three additional manual-entry tunables. Reset
      // alongside the four legacy ones so each test starts from the
      // documented "everything inheriting from env / default" baseline.
      manualEntryLookbackHours: null,
      manualEntryDryRun: null,
      manualEntryRecipientLookupLimit: null,
      lastTestSentAt: null,
      lastTestSentByUserId: null,
      lastTestRecipientCount: null,
      updatedByUserId: null,
    })
    .where(eq(opsAlertSettingsTable.id, 1));
});

describe("recordOpsAlertTestSent — Task #1916", () => {
  it("stamps last_test_sent_at + recipient count + editor on the singleton row", async () => {
    expect(testUserId).not.toBeNull();
    const now = new Date("2026-04-30T12:34:56.789Z");

    await recordOpsAlertTestSent({ recipientCount: 3, userId: testUserId, now });

    const [row] = await db
      .select()
      .from(opsAlertSettingsTable)
      .where(eq(opsAlertSettingsTable.id, 1));
    expect(row.lastTestSentAt?.toISOString()).toBe(now.toISOString());
    expect(row.lastTestRecipientCount).toBe(3);
    expect(row.lastTestSentByUserId).toBe(testUserId);
  });

  it("does NOT touch the six tunable override columns or updated_* audit fields", async () => {
    // Seed a real PATCH first so all six columns + updated_at are
    // populated, then assert the test-stamp doesn't disturb them.
    await updateOpsAlertSettings({
      notifyExhaustionThreshold: 12,
      notifyExhaustionWindowHours: 36,
      manualEntryRateThresholdPct: 40,
      manualEntryMinSample: 25,
      manualEntryConsecutiveZero: 4,
      manualEntryCooldownHours: 8,
      userId: testUserId,
    });
    const [before] = await db
      .select()
      .from(opsAlertSettingsTable)
      .where(eq(opsAlertSettingsTable.id, 1));

    await recordOpsAlertTestSent({
      recipientCount: 2,
      userId: testUserId,
      now: new Date(),
    });

    const [after] = await db
      .select()
      .from(opsAlertSettingsTable)
      .where(eq(opsAlertSettingsTable.id, 1));
    expect(after.notifyExhaustionThreshold).toBe(before.notifyExhaustionThreshold);
    expect(after.notifyExhaustionWindowHours).toBe(before.notifyExhaustionWindowHours);
    expect(after.manualEntryRateThresholdPct).toBe(before.manualEntryRateThresholdPct);
    expect(after.manualEntryMinSample).toBe(before.manualEntryMinSample);
    expect(after.manualEntryConsecutiveZero).toBe(before.manualEntryConsecutiveZero);
    expect(after.manualEntryCooldownHours).toBe(before.manualEntryCooldownHours);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(after.updatedByUserId).toBe(before.updatedByUserId);
  });

  it("does NOT append a row to ops_alert_settings_history", async () => {
    await recordOpsAlertTestSent({
      recipientCount: 1,
      userId: testUserId,
      now: new Date(),
    });

    const history = await db.select().from(opsAlertSettingsHistoryTable);
    expect(history).toHaveLength(0);
  });

  it("creates the singleton row when it doesn't exist yet (fresh deploy)", async () => {
    // Hard-delete the singleton row to simulate a brand-new env where
    // no admin has saved an override yet — the first stamp must still
    // land cleanly and not error.
    await db.delete(opsAlertSettingsTable).where(eq(opsAlertSettingsTable.id, 1));

    const now = new Date("2026-04-30T13:00:00.000Z");
    await recordOpsAlertTestSent({ recipientCount: 4, userId: testUserId, now });

    const [row] = await db
      .select()
      .from(opsAlertSettingsTable)
      .where(eq(opsAlertSettingsTable.id, 1));
    expect(row).toBeDefined();
    expect(row.lastTestSentAt?.toISOString()).toBe(now.toISOString());
    expect(row.lastTestRecipientCount).toBe(4);
    expect(row.notifyExhaustionThreshold).toBeNull();
    expect(row.notifyExhaustionWindowHours).toBeNull();
  });

  it("overwrites the previous stamp on a subsequent call", async () => {
    const t1 = new Date("2026-04-30T10:00:00.000Z");
    const t2 = new Date("2026-04-30T11:00:00.000Z");
    await recordOpsAlertTestSent({ recipientCount: 2, userId: testUserId, now: t1 });
    await recordOpsAlertTestSent({ recipientCount: 5, userId: null, now: t2 });

    const [row] = await db
      .select()
      .from(opsAlertSettingsTable)
      .where(eq(opsAlertSettingsTable.id, 1));
    expect(row.lastTestSentAt?.toISOString()).toBe(t2.toISOString());
    expect(row.lastTestRecipientCount).toBe(5);
    expect(row.lastTestSentByUserId).toBeNull();
  });

  it("normalises a negative or fractional recipient count to a clean non-negative integer", async () => {
    // Defensive: the DB CHECK already rejects negative values, so this
    // also documents that the helper clamps before INSERT to keep the
    // call site simple.
    await recordOpsAlertTestSent({
      recipientCount: -3,
      userId: testUserId,
      now: new Date(),
    });
    const [row] = await db
      .select()
      .from(opsAlertSettingsTable)
      .where(eq(opsAlertSettingsTable.id, 1));
    expect(row.lastTestRecipientCount).toBe(0);
  });

  it("ignores a non-finite userId (treats as null) so stray NaN doesn't violate the FK", async () => {
    await recordOpsAlertTestSent({
      recipientCount: 1,
      userId: Number.NaN,
      now: new Date(),
    });
    const [row] = await db
      .select()
      .from(opsAlertSettingsTable)
      .where(eq(opsAlertSettingsTable.id, 1));
    expect(row.lastTestSentByUserId).toBeNull();
  });
});

describe("resolveOpsAlertConfig — Task #1916 last-test fields", () => {
  it("returns null fields when no test has ever been recorded", async () => {
    const cfg = await resolveOpsAlertConfig();
    expect(cfg.lastTestSentAt).toBeNull();
    expect(cfg.lastTestSentByUserId).toBeNull();
    expect(cfg.lastTestSentByDisplayName).toBeNull();
    expect(cfg.lastTestSentByUsername).toBeNull();
    expect(cfg.lastTestRecipientCount).toBeNull();
  });

  it("surfaces the stamped timestamp + recipient count + joined editor display name", async () => {
    expect(testUserId).not.toBeNull();
    const now = new Date("2026-04-30T15:00:00.000Z");
    await recordOpsAlertTestSent({ recipientCount: 7, userId: testUserId, now });

    _resetOpsAlertSettingsCacheForTest();
    const cfg = await resolveOpsAlertConfig();
    expect(cfg.lastTestSentAt).toBe(now.toISOString());
    expect(cfg.lastTestRecipientCount).toBe(7);
    expect(cfg.lastTestSentByUserId).toBe(testUserId);
    expect(cfg.lastTestSentByDisplayName).toBe("Ops Last-Test Tester");
    expect(cfg.lastTestSentByUsername).not.toBeNull();
  });

  it("surfaces null editor labels when the test was stamped by the system (no userId)", async () => {
    const now = new Date("2026-04-30T16:00:00.000Z");
    await recordOpsAlertTestSent({ recipientCount: 1, userId: null, now });

    _resetOpsAlertSettingsCacheForTest();
    const cfg = await resolveOpsAlertConfig();
    expect(cfg.lastTestSentAt).toBe(now.toISOString());
    expect(cfg.lastTestSentByUserId).toBeNull();
    expect(cfg.lastTestSentByDisplayName).toBeNull();
    expect(cfg.lastTestSentByUsername).toBeNull();
  });
});
