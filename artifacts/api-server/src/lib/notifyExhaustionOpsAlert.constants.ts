/**
 * Hardcoded defaults for the retry-exhaustion ops alert (Task #1305).
 *
 * Pulled into their own module so `./opsAlertSettings.ts` (which the
 * alert depends on for its DB-backed tunables) can reference them
 * without importing back from `./notifyExhaustionOpsAlert.ts` and
 * creating a circular dependency.
 */
export const DEFAULT_OPS_NOTIFY_EXHAUSTION_THRESHOLD = 5;
export const DEFAULT_OPS_NOTIFY_EXHAUSTION_WINDOW_HOURS = 24;
