/**
 * Task #974 — Audit log of inbound Stripe webhook deliveries.
 *
 * The "Send test event" button (Task #829) proves the endpoint is reachable
 * right now, but does nothing to confirm whether *real* Stripe deliveries have
 * been arriving and succeeding. This table captures one row per call into
 * POST /api/webhooks/stripe so admins can see — without digging through
 * server logs — when Stripe last delivered, what type of event it was,
 * what HTTP status we returned, and whether we applied it.
 *
 * Old rows are not retained forever; the daily prune cron sweeps anything
 * older than 30 days (the admin UI only ever surfaces the last 10).
 */
import { pgTable, serial, integer, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const stripeWebhookDeliveriesTable = pgTable("stripe_webhook_deliveries", {
  id: serial("id").primaryKey(),
  // Stripe event id (`evt_…`). Nullable because malformed/forged requests may
  // not contain a parseable body, and we still want to log them.
  eventId: text("event_id"),
  eventType: text("event_type"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  // Best-effort client IP (req.ip after trust-proxy). Useful for spotting
  // deliveries coming from somewhere other than Stripe's documented ranges.
  sourceIp: text("source_ip"),
  // true = HMAC verified, false = signature header present but mismatched,
  // null = signature check skipped (dev-only, no STRIPE_WEBHOOK_SECRET set).
  signatureValid: boolean("signature_valid"),
  // Did the handler actually apply a settlement to a player/order/invoice/
  // member row? Distinguishes "received and acted" from "received and ignored
  // because no matching row was found".
  applied: boolean("applied").notNull().default(false),
  // HTTP status returned to Stripe.
  responseStatus: integer("response_status").notNull(),
  // Task #1126 — short machine-readable reason captured for non-2xx responses
  // so admins can see *why* a delivery failed (e.g. "signature_mismatch",
  // "missing_header", "missing_secret", "missing_body", "reconciliation_failed")
  // without grepping server logs. Always null for successful (2xx) deliveries.
  errorReason: text("error_reason"),
}, (t) => [
  index("stripe_webhook_deliveries_received_at_idx").on(t.receivedAt),
]);

/**
 * Task #1294 — Audit log of the daily `stripe_webhook_deliveries` retention
 * sweep (Task #1125). Each row records when the sweep ran and how many old
 * rows it removed, so the admin Stripe webhook audit page can surface the
 * latest sweep summary (timestamp + pruned-row count) without making admins
 * dig through server logs. Old rows here are pruned to ~90 days by the same
 * sweep job to keep the table bounded.
 */
export const stripeWebhookSweepRunsTable = pgTable("stripe_webhook_sweep_runs", {
  id: serial("id").primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  // Number of `stripe_webhook_deliveries` rows the sweep deleted. Zero is a
  // valid value (a healthy quiet day) so we still persist a row — the admin UI
  // wants to know that the sweep ran, not just that something was removed.
  removed: integer("removed").notNull(),
}, (t) => [
  index("stripe_webhook_sweep_runs_ran_at_idx").on(t.ranAt),
]);

/**
 * Task #1883 — Append-only audit log of every "the daily Stripe webhook
 * sweep has been silent for too long" notification email the watchdog
 * (`runStripeWebhookSweepStaleOpsAlertJob`) actually sent out.
 *
 * Two concerns rolled into one table:
 *
 *   1. Cross-restart, cross-replica debounce. The watchdog gates on the
 *      most recent `paged_at` in this table, so a sustained outage paged
 *      at 09:00 does not page again at 10:00, 11:00, ... — even across
 *      a deploy that lands inside the cooldown window or across multiple
 *      cron processes racing. Mirrors the singleton-cooldown pattern in
 *      `badge_share_rollup_ops_alerts` (Task #1814) but appends per page
 *      so we also get history.
 *
 *   2. Operator visibility. The admin Stripe webhook audit page (and
 *      future digest tooling) needs to render a "Last alert: 2h ago —
 *      paged 3 admins" line so admins can confirm the watchdog actually
 *      fired and to whom, without grepping inboxes or server logs.
 *
 * One row is inserted only when the watchdog actually sent at least one
 * email (i.e. the cooldown gate passed AND ≥1 recipient was reached).
 * Skipped runs (`not_stale`, `in_cooldown`, `no_recipients`,
 * `send_failed`) leave no row, so the banner only ever shows real pages.
 *
 * Retention is bounded by the same daily sweep that prunes
 * `stripe_webhook_sweep_runs` to ~90 days (see `cron.ts`), so the table
 * stays small even on long-running deployments.
 */
export const stripeWebhookSweepStaleAlertsTable = pgTable("stripe_webhook_sweep_stale_alerts", {
  id: serial("id").primaryKey(),
  pagedAt: timestamp("paged_at", { withTimezone: true }).notNull().defaultNow(),
  // Snapshot of the trigger condition at page time. `last_sweep_ran_at`
  // is null when the watchdog tripped because the sweep had *never* run
  // on this database (long uptime + no row in `stripe_webhook_sweep_runs`).
  lastSweepRanAt: timestamp("last_sweep_ran_at", { withTimezone: true }),
  // The stale threshold (in ms) that was in force when the page fired,
  // captured so a postmortem can answer "what was the threshold then?"
  // even if the constant is widened or narrowed later.
  staleThresholdMs: integer("stale_threshold_ms").notNull(),
  // Aggregate fan-out for the dashboard banner ("paged N admins"). We
  // also store the actual recipient address list so support can confirm
  // a specific person was reached without re-deriving the list.
  recipientCount: integer("recipient_count").notNull().default(0),
  recipientEmails: text("recipient_emails").array().notNull().default(sql`ARRAY[]::text[]`),
}, (t) => [
  index("stripe_webhook_sweep_stale_alerts_paged_at_idx").on(t.pagedAt),
]);

export type StripeWebhookSweepStaleAlert = typeof stripeWebhookSweepStaleAlertsTable.$inferSelect;
