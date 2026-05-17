/**
 * Task #450 — Persistent send-state for the Year-in-Golf launch broadcaster.
 *
 * The launch cron (`year-in-golf-cron.ts`) used to track already-sent
 * broadcasts in an in-process `Set`, which meant an API server restart
 * during a launch window (Jan 1–10 annual; 1st–7th of Apr/Jul/Oct/Jan
 * quarterly) could re-send the push to every opted-in user. This table
 * persists one row per fired (year, period, day) tuple so duplicates are
 * prevented across restarts.
 *
 * The cron claims a row via `INSERT ... ON CONFLICT DO NOTHING` BEFORE
 * dispatching the push batches. If the insert is a no-op (row already
 * exists) the broadcast is skipped, even on a freshly-booted process.
 */
import { pgTable, text, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";

export const recapBroadcastsTable = pgTable("recap_broadcasts", {
  // Recap year (e.g. 2025 for the 2025 annual recap, 2024 for the
  // Q4-2024 recap fired in early Jan 2025).
  year: integer("year").notNull(),
  // Recap period: 'year' | 'q1' | 'q2' | 'q3' | 'q4'. Stored as plain
  // text rather than an enum so the cron can stringify `RecapPeriod`
  // directly without an extra cast and so future periods (e.g. 'h1')
  // don't require a schema migration.
  period: text("period").notNull(),
  // Day-of-window (1-based) the broadcast fired on. The cron only
  // sends on launch day + reminder days (1, 4, 7); each of those is
  // a distinct row so a restart inside the window only suppresses the
  // already-fired sends, not the still-upcoming reminders.
  day: integer("day").notNull(),
  // Recipient count at claim time. Useful for ops and for the audit
  // trail when investigating "did everyone get the push?" later.
  recipients: integer("recipients").notNull().default(0),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "recap_broadcasts_pkey", columns: [t.year, t.period, t.day] }),
]);
