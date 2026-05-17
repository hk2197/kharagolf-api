/**
 * Hardcoded defaults for the manual-entry alert health ops page
 * (Task #1387). Mirrors the layout of `notifyExhaustionOpsAlert.constants.ts`.
 *
 * Pulled into their own module so `./opsAlertSettings.ts` (which the
 * alert depends on for its DB-backed tunables, Task #1664) can
 * reference them without importing back from
 * `./manualEntryAlertHealthOpsAlert.ts` and creating a circular
 * dependency.
 */
export const DEFAULT_MANUAL_ENTRY_ALERT_RATE_THRESHOLD_PCT = 80;
export const DEFAULT_MANUAL_ENTRY_ALERT_MIN_SAMPLE = 3;
export const DEFAULT_MANUAL_ENTRY_ALERT_CONSECUTIVE_ZERO = 5;
export const DEFAULT_MANUAL_ENTRY_ALERT_COOLDOWN_HOURS = 6;
/**
 * Task #2066 — per-org `org_muted` + `tournament_muted` row-count
 * threshold for the muted-skip pile-up breach. Picked at 10 because
 * single-digit muted skips per org per week are within the noise floor
 * of legitimate "we paused alerts during the round" usage; double
 * digits in a single org over 7 days almost always means the org-wide
 * toggle was left off after troubleshooting and on-call should reach
 * out to the TD before the backlog gets worse.
 */
export const DEFAULT_MANUAL_ENTRY_ALERT_MUTED_PILE_UP_THRESHOLD = 10;

/**
 * Task #2081 — three additional manual-entry alert tunables surfaced
 * in the super-admin Ops Alert card.
 *
 * - `LOOKBACK_HOURS` (168 = 7d): how far back the cron looks when
 *   querying the muted-skip pile-up signal. The 7d / 30d delivery-rate
 *   summaries are still computed by `getManualEntryAlertHealthSummary`
 *   over fixed windows, so this knob only affects the `since`
 *   parameter the cron passes to `getManualEntryNotifyMutedSkipsByOrg`.
 *
 * - `DRY_RUN` (false): when true, the cron evaluates breaches and
 *   logs / writes a page-history row but skips the email + chat
 *   dispatch. Lets ops dry-run a tightened threshold against
 *   production traffic without paging on-call.
 *
 * - `RECIPIENT_LOOKUP_LIMIT` (50): caps the deduplicated recipient
 *   list before the email send loop. 50 leaves comfortable headroom
 *   for a real ops list (super_admins + on-call) and matches the
 *   recipient-array cap already enforced on the DB-backed
 *   `OPS_ALERT_EMAILS` override.
 */
export const DEFAULT_MANUAL_ENTRY_ALERT_LOOKBACK_HOURS = 168;
export const DEFAULT_MANUAL_ENTRY_ALERT_DRY_RUN = false;
export const DEFAULT_MANUAL_ENTRY_ALERT_RECIPIENT_LOOKUP_LIMIT = 50;
