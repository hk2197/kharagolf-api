/**
 * Tests for Task #2067 — retention prune for `manual_entry_notify_skips`.
 *
 * `notifyManualEntryRound` writes one row per non-delivery so the
 * super-admin "why did rounds get skipped?" dashboard can render its
 * 7d / 30d breakdown. The dashboard never queries beyond 30 days, so
 * a nightly cron prunes rows older than the configured retention
 * window (90 days by default — one full season + buffer; tunable via
 * `MANUAL_ENTRY_NOTIFY_SKIPS_RETENTION_DAYS`).
 *
 * Covers:
 *   - The 89-vs-91-day boundary: a 91-day-old row falls out, an
 *     89-day-old row is preserved.
 *   - The custom retention override (in days) is honoured when passed
 *     directly, so tests don't have to mutate process.env.
 *   - When nothing crosses the cutoff the helper is a no-op (deleted=0).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db, manualEntryNotifySkipsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  pruneManualEntryNotifySkips,
  DEFAULT_MANUAL_ENTRY_NOTIFY_SKIPS_RETENTION_DAYS,
} from "../lib/manualEntryNotifySkipsRetention.js";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  // Tests in this file own the table — clear any leftovers so each case
  // starts from a known baseline.
  await db.delete(manualEntryNotifySkipsTable);
});

describe("pruneManualEntryNotifySkips — Task #2067", () => {
  it("default 90d window: prunes the 91-day-old row, keeps the 89-day-old row", async () => {
    const now = Date.now();
    // The boundary case the task explicitly calls out: 89 days old must
    // survive (still inside the 90-day window), 91 days old must be
    // deleted (just past the cutoff).
    const day91 = new Date(now - 91 * DAY_MS);
    const day89 = new Date(now - 89 * DAY_MS);
    const day1 = new Date(now - 1 * DAY_MS);

    const inserted = await db
      .insert(manualEntryNotifySkipsTable)
      .values([
        { submissionId: 9001, status: "skipped", reason: "below_threshold", createdAt: day91 },
        { submissionId: 9002, status: "skipped", reason: "no_recipients", createdAt: day89 },
        { submissionId: 9003, status: "failed", reason: "org_lookup_failed", createdAt: day1 },
      ])
      .returning({ id: manualEntryNotifySkipsTable.id, submissionId: manualEntryNotifySkipsTable.submissionId });

    const result = await pruneManualEntryNotifySkips();
    expect(result.deleted).toBe(1);
    expect(result.retentionDays).toBe(DEFAULT_MANUAL_ENTRY_NOTIFY_SKIPS_RETENTION_DAYS);

    const remaining = await db
      .select({ id: manualEntryNotifySkipsTable.id, submissionId: manualEntryNotifySkipsTable.submissionId })
      .from(manualEntryNotifySkipsTable)
      .where(inArray(manualEntryNotifySkipsTable.id, inserted.map((r) => r.id)));
    expect(remaining.map((r) => r.submissionId).sort()).toEqual([9002, 9003]);
  });

  it("honours a caller-provided retention override (in days)", async () => {
    const now = Date.now();
    const day10 = new Date(now - 10 * DAY_MS);
    const day3 = new Date(now - 3 * DAY_MS);

    await db.insert(manualEntryNotifySkipsTable).values([
      { submissionId: 9101, status: "skipped", reason: "below_threshold", createdAt: day10 },
      { submissionId: 9102, status: "skipped", reason: "below_threshold", createdAt: day3 },
    ]);

    // 7-day window — only the 10-day-old row should fall out.
    const result = await pruneManualEntryNotifySkips(7);
    expect(result.deleted).toBe(1);
    expect(result.retentionDays).toBe(7);

    const after = await db
      .select({ submissionId: manualEntryNotifySkipsTable.submissionId })
      .from(manualEntryNotifySkipsTable);
    expect(after.map((r) => r.submissionId)).toEqual([9102]);
  });

  it("is a no-op when nothing has aged out", async () => {
    const recent = new Date(Date.now() - 5 * DAY_MS);
    await db.insert(manualEntryNotifySkipsTable).values({
      submissionId: 9201,
      status: "skipped",
      reason: "below_threshold",
      createdAt: recent,
    });

    const result = await pruneManualEntryNotifySkips();
    expect(result.deleted).toBe(0);

    const after = await db
      .select({ id: manualEntryNotifySkipsTable.id })
      .from(manualEntryNotifySkipsTable);
    expect(after).toHaveLength(1);
  });
});
