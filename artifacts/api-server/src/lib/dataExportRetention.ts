/**
 * Shared retention policy for self-serve data exports (Task #468 / #619).
 *
 * - The /portal/my-data-export routes use this to compute the `expired`
 *   computed status returned to members.
 * - The daily cron worker `purgeExpiredDataExportArchives` uses this to
 *   decide which archives have aged out of retention and should be deleted
 *   from object storage.
 *
 * Centralising the constant prevents the two callers from drifting apart
 * (which would let the dashboard show "ready" for archives the cron has
 * already deleted, or vice-versa).
 */
export const DATA_EXPORT_VALID_DAYS = 7;
