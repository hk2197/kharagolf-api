/**
 * Tests for Task #1546 — audit log for ops alert tunable changes.
 *
 * The singleton `ops_alert_settings` row only keeps the *latest* override
 * values + last-editor metadata. To let ops reconstruct decisions during
 * postmortems we now append a row to `ops_alert_settings_history` on every
 * PATCH, capturing the prev/new values for both tunables and the editor.
 *
 * Covers:
 *   - Each successful `updateOpsAlertSettings` writes one history row.
 *   - The audit row records the actual prev/new state of *both* fields,
 *     even when the PATCH only touched one of them (the untouched field's
 *     "new" is mirrored from "prev" so the row reflects the post-update
 *     reality, not a misleading NULL).
 *   - Validation failures do NOT write a history row.
 *   - `listOpsAlertSettingsHistory` returns entries newest-first, capped,
 *     and joins the editor's display name when present.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db, opsAlertSettingsTable, opsAlertSettingsHistoryTable, appUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  updateOpsAlertSettings,
  listOpsAlertSettingsHistory,
  resolveOpsAlertConfig,
  countOpsAlertSettingsHistory,
  _resetOpsAlertSettingsCacheForTest,
  OPS_ALERT_HISTORY_MAX_LIMIT,
} from "../lib/opsAlertSettings.js";

let testUserId: number | null = null;

beforeAll(async () => {
  const tag = `ops-audit-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [u] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: tag,
      username: tag,
      email: `${tag}@example.com`,
      role: "super_admin",
      displayName: "Ops Audit Tester",
    })
    .returning({ id: appUsersTable.id });
  testUserId = u.id;
});

afterAll(async () => {
  if (testUserId !== null) {
    // History rows pointing at this user become NULL via FK ON DELETE
    // SET NULL, so we can clean up the user without orphaning audit rows
    // (and we tear those down separately below).
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
});

beforeEach(async () => {
  _resetOpsAlertSettingsCacheForTest();
  // Reset the singleton row + clear history so tests start from a known
  // baseline. We're the only writers in this test file so a full delete
  // is safe.
  await db.delete(opsAlertSettingsHistoryTable);
  await db
    .update(opsAlertSettingsTable)
    .set({
      notifyExhaustionThreshold: null,
      notifyExhaustionWindowHours: null,
      // Task #1664 — also clear the four manual-entry columns so a
      // previous test's PATCH doesn't leak into the next one.
      manualEntryRateThresholdPct: null,
      manualEntryMinSample: null,
      manualEntryConsecutiveZero: null,
      manualEntryCooldownHours: null,
      // Task #2081 — three additional manual-entry tunables. Reset
      // alongside the four legacy ones so every test starts from a
      // clean "everything inheriting from env / default" baseline.
      manualEntryLookbackHours: null,
      manualEntryDryRun: null,
      manualEntryRecipientLookupLimit: null,
      // Task #1910 — recipient override must also be cleared between
      // tests, otherwise an earlier test's `["override-a@…"]` leaks
      // into a "prev should be null" assertion further down the file.
      notifyExhaustionRecipients: null,
      updatedByUserId: null,
    })
    .where(eq(opsAlertSettingsTable.id, 1));
});

describe("ops_alert_settings_history — Task #1546", () => {
  it("writes one history row per successful PATCH with prev/new for both fields", async () => {
    const r1 = await updateOpsAlertSettings({
      notifyExhaustionThreshold: 7,
      notifyExhaustionWindowHours: 36,
      userId: testUserId,
    });
    expect(r1.ok).toBe(true);

    const after1 = await listOpsAlertSettingsHistory(10);
    expect(after1).toHaveLength(1);
    expect(after1[0]).toMatchObject({
      changedByUserId: testUserId,
      prevThreshold: null,
      newThreshold: 7,
      prevWindowHours: null,
      newWindowHours: 36,
    });

    // PATCH that only edits the threshold — window's new value should
    // mirror the previously-stored 36, not get reset to NULL.
    const r2 = await updateOpsAlertSettings({
      notifyExhaustionThreshold: 9,
      userId: testUserId,
    });
    expect(r2.ok).toBe(true);

    const after2 = await listOpsAlertSettingsHistory(10);
    expect(after2).toHaveLength(2);
    // Newest first.
    expect(after2[0]).toMatchObject({
      prevThreshold: 7,
      newThreshold: 9,
      prevWindowHours: 36,
      newWindowHours: 36,
    });
    expect(after2[1]).toMatchObject({
      prevThreshold: null,
      newThreshold: 7,
    });

    // Explicit-null clear of the window is a real change and must be
    // recorded as 36 → null.
    const r3 = await updateOpsAlertSettings({
      notifyExhaustionWindowHours: null,
      userId: testUserId,
    });
    expect(r3.ok).toBe(true);

    const after3 = await listOpsAlertSettingsHistory(10);
    expect(after3).toHaveLength(3);
    expect(after3[0]).toMatchObject({
      prevThreshold: 9,
      newThreshold: 9,
      prevWindowHours: 36,
      newWindowHours: null,
    });
  });

  it("does not write a history row when validation rejects the PATCH", async () => {
    const r = await updateOpsAlertSettings({
      notifyExhaustionThreshold: 0,
      userId: testUserId,
    });
    expect(r.ok).toBe(false);

    const entries = await listOpsAlertSettingsHistory(10);
    expect(entries).toHaveLength(0);
  });

  // Task #1923 — the singleton card's "Last edited by …" line was
  // showing a bare numeric ID. The resolved config now joins
  // `app_users` so the UI can render the editor's display name (with
  // username fallback) instead, matching the audit list directly below.
  it("resolveOpsAlertConfig exposes the editor's display name + username", async () => {
    const r = await updateOpsAlertSettings({
      notifyExhaustionThreshold: 8,
      userId: testUserId,
    });
    expect(r.ok).toBe(true);

    _resetOpsAlertSettingsCacheForTest();
    const cfg = await resolveOpsAlertConfig();
    expect(cfg.updatedByUserId).toBe(testUserId);
    expect(cfg.updatedByDisplayName).toBe("Ops Audit Tester");
    // The seeded fixture username is the random tag we used at insert,
    // we just assert it round-trips as a non-empty string so the UI
    // fallback path has something to render.
    expect(typeof cfg.updatedByUsername).toBe("string");
    expect(cfg.updatedByUsername && cfg.updatedByUsername.length > 0).toBe(true);
  });

  // Task #1923 — guards against the regression that the explicit
  // projection added for the app_users join silently drops the
  // recipient-override column. If the projection ever forgets
  // `notifyExhaustionRecipients` again, `resolveRecipients` will see
  // `undefined`, force the source back to "env", and silently disable
  // the DB override (Task #1910). This test pins both behaviours
  // together so the join refactor and the recipient override stay
  // wired up.
  it("resolveOpsAlertConfig still honours a DB recipient override after the app_users join", async () => {
    const r = await updateOpsAlertSettings({
      notifyExhaustionRecipients: ["override-a@example.com", "override-b@example.com"],
      userId: testUserId,
    });
    expect(r.ok).toBe(true);

    _resetOpsAlertSettingsCacheForTest();
    const cfg = await resolveOpsAlertConfig();
    expect(cfg.recipients.source).toBe("org_override");
    expect(cfg.recipients.dbList).toEqual(["override-a@example.com", "override-b@example.com"]);
    expect(cfg.recipients.effective).toEqual(["override-a@example.com", "override-b@example.com"]);
  });

  it("listOpsAlertSettingsHistory caps at the requested limit and returns the editor name", async () => {
    for (let i = 1; i <= 12; i++) {
      const r = await updateOpsAlertSettings({
        notifyExhaustionThreshold: i,
        userId: testUserId,
      });
      expect(r.ok).toBe(true);
    }
    const top10 = await listOpsAlertSettingsHistory(10);
    expect(top10).toHaveLength(10);
    // Newest entry corresponds to the last write (threshold=12).
    expect(top10[0].newThreshold).toBe(12);
    expect(top10[0].prevThreshold).toBe(11);
    expect(top10[0].changedByDisplayName).toBe("Ops Audit Tester");
  });
});

// Task #1664 — the singleton + history rows now also carry the four
// manual-entry alert health tunables. Same validation + audit-mirroring
// rules as the original two fields.
describe("ops_alert_settings — manual-entry tunables (Task #1664)", () => {
  it("persists each manual-entry override and audits the change", async () => {
    const r = await updateOpsAlertSettings({
      manualEntryRateThresholdPct: 90,
      manualEntryMinSample: 5,
      manualEntryConsecutiveZero: 4,
      manualEntryCooldownHours: 12,
      userId: testUserId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.manualEntry.rateThresholdPct).toBe(90);
    expect(r.config.manualEntry.minSample).toBe(5);
    expect(r.config.manualEntry.consecutiveZero).toBe(4);
    expect(r.config.manualEntry.cooldownHours).toBe(12);
    expect(r.config.manualEntry.source.rateThresholdPct).toBe("db");
    expect(r.config.manualEntry.source.cooldownHours).toBe("db");

    const [entry] = await listOpsAlertSettingsHistory(1);
    expect(entry).toMatchObject({
      prevManualEntryRateThresholdPct: null,
      newManualEntryRateThresholdPct: 90,
      prevManualEntryMinSample: null,
      newManualEntryMinSample: 5,
      prevManualEntryConsecutiveZero: null,
      newManualEntryConsecutiveZero: 4,
      prevManualEntryCooldownHours: null,
      newManualEntryCooldownHours: 12,
    });
  });

  it("a partial PATCH leaves untouched manual-entry fields alone (audit mirrors prev → new)", async () => {
    const r1 = await updateOpsAlertSettings({
      manualEntryRateThresholdPct: 70,
      manualEntryMinSample: 10,
      userId: testUserId,
    });
    expect(r1.ok).toBe(true);

    // Edit only the cooldown — rate / min sample stored values must be
    // preserved, and the audit row must mirror them so the history is
    // self-describing.
    const r2 = await updateOpsAlertSettings({
      manualEntryCooldownHours: 24,
      userId: testUserId,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.config.manualEntry.dbRateThresholdPct).toBe(70);
    expect(r2.config.manualEntry.dbMinSample).toBe(10);
    expect(r2.config.manualEntry.dbCooldownHours).toBe(24);

    const [latest] = await listOpsAlertSettingsHistory(1);
    expect(latest).toMatchObject({
      prevManualEntryRateThresholdPct: 70,
      newManualEntryRateThresholdPct: 70,
      prevManualEntryMinSample: 10,
      newManualEntryMinSample: 10,
      prevManualEntryCooldownHours: null,
      newManualEntryCooldownHours: 24,
    });
  });

  it("rejects out-of-range manual-entry rate threshold (must be 1..100)", async () => {
    const above = await updateOpsAlertSettings({
      manualEntryRateThresholdPct: 101,
      userId: testUserId,
    });
    expect(above.ok).toBe(false);
    if (!above.ok) {
      expect(above.error.kind).toBe("invalid_manual_entry_rate_threshold_pct");
    }
    const zero = await updateOpsAlertSettings({
      manualEntryRateThresholdPct: 0,
      userId: testUserId,
    });
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect(zero.error.kind).toBe("invalid_manual_entry_rate_threshold_pct");
    }
    const fractional = await updateOpsAlertSettings({
      manualEntryRateThresholdPct: 50.5,
      userId: testUserId,
    });
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) {
      expect(fractional.error.kind).toBe("invalid_manual_entry_rate_threshold_pct");
    }
    // Edge values pass.
    const ok = await updateOpsAlertSettings({
      manualEntryRateThresholdPct: 100,
      userId: testUserId,
    });
    expect(ok.ok).toBe(true);
  });

  it("paginates with offset + limit and returns the matching total via countOpsAlertSettingsHistory (Task #1924)", async () => {
    // Seed 12 rows so we can verify offset paging across two pages.
    for (let i = 1; i <= 12; i++) {
      const r = await updateOpsAlertSettings({
        notifyExhaustionThreshold: i,
        userId: testUserId,
      });
      expect(r.ok).toBe(true);
    }

    const total = await countOpsAlertSettingsHistory();
    expect(total).toBe(12);

    // Page 1 of 5 (newest first → 12, 11, 10, 9, 8).
    const page1 = await listOpsAlertSettingsHistory({ limit: 5, offset: 0 });
    expect(page1).toHaveLength(5);
    expect(page1.map(r => r.newThreshold)).toEqual([12, 11, 10, 9, 8]);

    // Page 2 of 5 (7..3).
    const page2 = await listOpsAlertSettingsHistory({ limit: 5, offset: 5 });
    expect(page2).toHaveLength(5);
    expect(page2.map(r => r.newThreshold)).toEqual([7, 6, 5, 4, 3]);

    // Final partial page (2..1).
    const page3 = await listOpsAlertSettingsHistory({ limit: 5, offset: 10 });
    expect(page3).toHaveLength(2);
    expect(page3.map(r => r.newThreshold)).toEqual([2, 1]);

    // Past-end offset just returns an empty array, not an error.
    const empty = await listOpsAlertSettingsHistory({ limit: 5, offset: 100 });
    expect(empty).toEqual([]);
  });

  it("clamps limit to OPS_ALERT_HISTORY_MAX_LIMIT and floors negative offset to 0 (Task #1924)", async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await updateOpsAlertSettings({
        notifyExhaustionThreshold: i,
        userId: testUserId,
      });
      expect(r.ok).toBe(true);
    }
    // A wildly oversized limit must cap at the documented max — we
    // can't actually verify the SQL LIMIT directly, but the cap is
    // exposed on the function signature and the row count never
    // exceeds it. With only 3 rows in the table, the obvious sanity
    // check is just "we get 3 rows back without erroring".
    const all = await listOpsAlertSettingsHistory({ limit: 10_000 });
    expect(all.length).toBe(3);
    expect(OPS_ALERT_HISTORY_MAX_LIMIT).toBeGreaterThanOrEqual(100);

    // Negative offset clamps to 0 — the row at index 0 is still the
    // newest, not "out of range".
    const negOffset = await listOpsAlertSettingsHistory({ limit: 1, offset: -50 });
    expect(negOffset).toHaveLength(1);
    expect(negOffset[0].newThreshold).toBe(3);
  });

  it("filters by changedBy userId / 'system' and by date range (Task #1924)", async () => {
    // Make a second editor so the editor filter has two distinct
    // attribution buckets to choose between.
    const tag = `ops-audit-test-2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [u2] = await db
      .insert(appUsersTable)
      .values({
        replitUserId: tag,
        username: tag,
        email: `${tag}@example.com`,
        role: "super_admin",
        displayName: "Second Editor",
      })
      .returning({ id: appUsersTable.id });
    try {
      // Two writes by the original test user, one by the second
      // editor, one with userId=null (system / unattributed).
      const r1 = await updateOpsAlertSettings({ notifyExhaustionThreshold: 11, userId: testUserId });
      expect(r1.ok).toBe(true);
      const r2 = await updateOpsAlertSettings({ notifyExhaustionThreshold: 22, userId: testUserId });
      expect(r2.ok).toBe(true);
      const r3 = await updateOpsAlertSettings({ notifyExhaustionThreshold: 33, userId: u2.id });
      expect(r3.ok).toBe(true);
      const r4 = await updateOpsAlertSettings({ notifyExhaustionThreshold: 44, userId: null });
      expect(r4.ok).toBe(true);

      // Filter to the original editor's two writes.
      const mine = await listOpsAlertSettingsHistory({
        limit: 50,
        editorUserId: testUserId!,
      });
      expect(mine.map(r => r.newThreshold)).toEqual([22, 11]);
      expect(await countOpsAlertSettingsHistory({ editorUserId: testUserId! })).toBe(2);

      // Filter to the second editor's single write.
      const theirs = await listOpsAlertSettingsHistory({ limit: 50, editorUserId: u2.id });
      expect(theirs).toHaveLength(1);
      expect(theirs[0].newThreshold).toBe(33);

      // Filter to system / unattributed rows.
      const system = await listOpsAlertSettingsHistory({ limit: 50, editorUserId: null });
      expect(system).toHaveLength(1);
      expect(system[0].changedByUserId).toBeNull();
      expect(system[0].newThreshold).toBe(44);
      expect(await countOpsAlertSettingsHistory({ editorUserId: null })).toBe(1);

      // Date-range: an upper bound that excludes the most recent row
      // must drop it from both the list and the count. We anchor the
      // bound on r3's `changedAt` because r4 was written strictly
      // afterwards.
      const r3Row = await listOpsAlertSettingsHistory({ limit: 50, editorUserId: u2.id });
      const cutoff = new Date(r3Row[0].changedAt);
      const upToR3 = await listOpsAlertSettingsHistory({ limit: 50, toDate: cutoff });
      // Must contain r1, r2, r3 — but not r4 (which is strictly later).
      const thresholds = upToR3.map(r => r.newThreshold);
      expect(thresholds).toContain(11);
      expect(thresholds).toContain(22);
      expect(thresholds).toContain(33);
      expect(thresholds).not.toContain(44);
      expect(await countOpsAlertSettingsHistory({ toDate: cutoff })).toBe(thresholds.length);

      // A from-date strictly after every row returns an empty list.
      const future = new Date(Date.now() + 60_000);
      expect(await listOpsAlertSettingsHistory({ limit: 50, fromDate: future })).toEqual([]);
      expect(await countOpsAlertSettingsHistory({ fromDate: future })).toBe(0);
    } finally {
      await db.delete(appUsersTable).where(eq(appUsersTable.id, u2.id));
    }
  });

  it("rejects non-positive integers for min sample / consecutive zero / cooldown hours", async () => {
    const cases: Array<{
      payload: Parameters<typeof updateOpsAlertSettings>[0];
      kind: string;
    }> = [
      { payload: { manualEntryMinSample: 0, userId: testUserId }, kind: "invalid_manual_entry_min_sample" },
      { payload: { manualEntryConsecutiveZero: -1, userId: testUserId }, kind: "invalid_manual_entry_consecutive_zero" },
      { payload: { manualEntryCooldownHours: 1.5, userId: testUserId }, kind: "invalid_manual_entry_cooldown_hours" },
    ];
    for (const c of cases) {
      const res = await updateOpsAlertSettings(c.payload);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe(c.kind);
    }
    // No history rows should have been written.
    const entries = await listOpsAlertSettingsHistory(10);
    expect(entries).toHaveLength(0);
  });
});

// Task #1910 — DB-backed override of the retry-exhaustion ops-alert
// recipient list. Same audit-mirroring contract as the numeric tunables:
// every successful PATCH writes a history row whose prev/new pair
// describes the post-update reality of the recipients column, not just
// the field that happened to be touched. Empty array / NULL semantics
// also live here because they're the riskiest part of the change (a
// silenced recipient list would silence the breach email entirely).
describe("ops_alert_settings — recipient list override (Task #1910)", () => {
  it("normalizes (lowercase + dedupe + trim) and audits the prev/new pair", async () => {
    const r = await updateOpsAlertSettings({
      // Mixed case + duplicates + leading/trailing whitespace — server
      // must canonicalize before persisting so the audit + cron see a
      // stable list and the email provider doesn't get the same address
      // twice.
      notifyExhaustionRecipients: [
        "  Ops@Example.COM ",
        "ops@example.com",
        "oncall@example.com",
      ],
      userId: testUserId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.config.recipients.source).toBe("org_override");
    expect(r.config.recipients.dbList).toEqual(["ops@example.com", "oncall@example.com"]);
    expect(r.config.recipients.effective).toEqual(["ops@example.com", "oncall@example.com"]);

    const [entry] = await listOpsAlertSettingsHistory(1);
    expect(entry).toMatchObject({
      prevNotifyExhaustionRecipients: null,
      newNotifyExhaustionRecipients: ["ops@example.com", "oncall@example.com"],
    });
  });

  it("treats explicit empty array as 'clear the override' and falls back to env", async () => {
    // Seed an override so we have something to clear.
    const seed = await updateOpsAlertSettings({
      notifyExhaustionRecipients: ["seed@example.com"],
      userId: testUserId,
    });
    expect(seed.ok).toBe(true);

    // Now save an empty list — semantically "fall back to env".
    const cleared = await updateOpsAlertSettings({
      notifyExhaustionRecipients: [],
      userId: testUserId,
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.config.recipients.dbList).toBeNull();
    expect(cleared.config.recipients.source).toBe("env");

    // Audit row should record the actual prev/new transition so a
    // postmortem can see who silenced (or restored) the override.
    const [latest] = await listOpsAlertSettingsHistory(1);
    expect(latest).toMatchObject({
      prevNotifyExhaustionRecipients: ["seed@example.com"],
      newNotifyExhaustionRecipients: null,
    });
  });

  it("rejects malformed email addresses without writing a history row", async () => {
    const r = await updateOpsAlertSettings({
      notifyExhaustionRecipients: ["ops@example.com", "not-an-email"],
      userId: testUserId,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("invalid_notify_exhaustion_recipients");
    }

    const entries = await listOpsAlertSettingsHistory(10);
    expect(entries).toHaveLength(0);
  });

  it("partial PATCH mirrors recipients prev → new when the field is untouched", async () => {
    const r1 = await updateOpsAlertSettings({
      notifyExhaustionRecipients: ["one@example.com"],
      userId: testUserId,
    });
    expect(r1.ok).toBe(true);

    // Touch a numeric tunable only — recipients column must be carried
    // through the audit so the row reflects post-update reality.
    const r2 = await updateOpsAlertSettings({
      notifyExhaustionThreshold: 9,
      userId: testUserId,
    });
    expect(r2.ok).toBe(true);

    const [latest] = await listOpsAlertSettingsHistory(1);
    expect(latest).toMatchObject({
      prevNotifyExhaustionRecipients: ["one@example.com"],
      newNotifyExhaustionRecipients: ["one@example.com"],
      prevThreshold: null,
      newThreshold: 9,
    });
  });
});
