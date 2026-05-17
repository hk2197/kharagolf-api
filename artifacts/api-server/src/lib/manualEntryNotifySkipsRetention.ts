/**
 * Task #2067 — retention prune for `manual_entry_notify_skips`.
 *
 * `notifyManualEntryRound` writes one row per non-delivery to
 * `manual_entry_notify_skips` so the super-admin "why did rounds get
 * skipped?" dashboard can render a 7d / 30d breakdown chart. The
 * dashboard never queries beyond 30 days, so anything older is dead
 * weight on disk and on the `(reason, created_at)` index.
 *
 * A nightly cron deletes rows older than the configured retention
 * window (90 days by default — one full season + buffer; tunable via
 * the `MANUAL_ENTRY_NOTIFY_SKIPS_RETENTION_DAYS` env var).
 */
import { db, manualEntryNotifySkipsTable } from "@workspace/db";
import { lt } from "drizzle-orm";
import { logger } from "./logger";

export const DEFAULT_MANUAL_ENTRY_NOTIFY_SKIPS_RETENTION_DAYS = 90;

function resolveRetentionDays(): number {
  const raw = process.env.MANUAL_ENTRY_NOTIFY_SKIPS_RETENTION_DAYS;
  if (!raw) return DEFAULT_MANUAL_ENTRY_NOTIFY_SKIPS_RETENTION_DAYS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(
      { value: raw },
      "[manual-entry-notify-skips] Invalid MANUAL_ENTRY_NOTIFY_SKIPS_RETENTION_DAYS; using default",
    );
    return DEFAULT_MANUAL_ENTRY_NOTIFY_SKIPS_RETENTION_DAYS;
  }
  return n;
}

/**
 * Delete `manual_entry_notify_skips` rows whose `createdAt` is older
 * than the configured retention window. Returns the number of rows
 * deleted plus the cutoff used so the cron can log a single
 * structured summary.
 *
 * @param retentionDays Optional override (must be > 0). When omitted,
 *   resolves from `MANUAL_ENTRY_NOTIFY_SKIPS_RETENTION_DAYS` env →
 *   `DEFAULT_MANUAL_ENTRY_NOTIFY_SKIPS_RETENTION_DAYS`.
 */
export async function pruneManualEntryNotifySkips(
  retentionDays?: number,
): Promise<{ deleted: number; cutoff: string; retentionDays: number }> {
  const days = typeof retentionDays === "number" && Number.isFinite(retentionDays) && retentionDays > 0
    ? retentionDays
    : resolveRetentionDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(manualEntryNotifySkipsTable)
    .where(lt(manualEntryNotifySkipsTable.createdAt, cutoff))
    .returning({ id: manualEntryNotifySkipsTable.id });
  if (deleted.length > 0) {
    logger.info(
      { deleted: deleted.length, cutoff: cutoff.toISOString(), retentionDays: days },
      "[manual-entry-notify-skips] pruned old rows",
    );
  }
  return { deleted: deleted.length, cutoff: cutoff.toISOString(), retentionDays: days };
}
