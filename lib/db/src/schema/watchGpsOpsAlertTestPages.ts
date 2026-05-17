/**
 * Task #2056 — Audit log of super-admin "Send test page" clicks for the
 * watch GPS spike alert wiring.
 *
 * Task #1653 added the button that fires a clearly-labelled test page
 * through the same Slack / PagerDuty senders the real alert uses, but
 * the only record of who fired it was a single info log line. This
 * table captures one row per click so leadership can see how often the
 * paging wiring is exercised, prove "we test our paging weekly" during
 * incident reviews, and chart the cadence over the last 30 days.
 *
 * One row per POST /super-admin/watch-position-metrics/test-ops-alert-chat.
 * Per-channel `attempted` / `ok` / `error` fields mirror the response
 * body the dashboard already shows in the toast, so the table can be
 * read back without re-running the test.
 */
import { pgTable, serial, integer, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

export const watchGpsOpsAlertTestPagesTable = pgTable("watch_gps_ops_alert_test_pages", {
  id: serial("id").primaryKey(),
  // Actor user id (`app_users.id`). Nullable because the audit insert
  // is best-effort: if the route somehow lost the principal between the
  // requireSuperAdmin check and the audit write we still want the row,
  // not a 500 that hides the wiring-test outcome from the operator.
  // No FK reference — we don't want a deleted super-admin user to wipe
  // historical audit rows that prove paging was tested.
  actorUserId: integer("actor_user_id"),
  // Cached `displayName ?? username` at insert time so the dashboard can
  // render "Last test page: 3h ago by Asha" without joining `app_users`,
  // and so the audit row survives even if the user later changes their
  // displayName. Mirrors the same pattern as `member_audit_log.actor_name`.
  actorName: text("actor_name"),
  // Per-channel outcome — same shape as `WatchGpsOpsAlertChatTestResult`
  // returned by the route. `attempted` is false when the channel wasn't
  // configured at all (no env var set); when `attempted` is true,
  // `ok` reflects whether the underlying sender resolved successfully
  // and `error` carries the error message on failure.
  slackAttempted: boolean("slack_attempted").notNull().default(false),
  slackOk: boolean("slack_ok").notNull().default(false),
  slackError: text("slack_error"),
  pagerDutyAttempted: boolean("pager_duty_attempted").notNull().default(false),
  pagerDutyOk: boolean("pager_duty_ok").notNull().default(false),
  pagerDutyError: text("pager_duty_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // History/series queries walk by timestamp.
  index("watch_gps_ops_alert_test_pages_created_at_idx").on(t.createdAt),
]);
