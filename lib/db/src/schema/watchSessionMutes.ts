/**
 * Task #1679 — Persistent block list for the "mute a runaway watch session"
 * super-admin action.
 *
 * Task #1393 introduced an in-process `Map<sessionId, expiresAtMs>` inside
 * `watchPositionMetrics.ts` so ops could silence a flooding watch from the
 * dashboard. That works for the common case (the watch reconnects within
 * seconds and gets a fresh sessionId, which auto-clears the mute), but every
 * API-server restart or deploy silently lifts every active mute without
 * re-emitting an audit event. For a 4-hour mute on a runaway watch during a
 * tournament that's a real regression.
 *
 * This sibling table is the persisted source of truth: one row per active
 * mute, keyed by `session_id`. The in-process Map is hydrated from it on
 * boot, and every mute / unmute / TTL prune writes through here too. Old
 * rows past their `expires_at` are reaped by the same daily prune cron that
 * trims `watch_position_metrics`.
 */
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const watchSessionMutesTable = pgTable("watch_session_mutes", {
  // The watch's per-socket sessionId (mirrors `watch_position_metrics.session_id`).
  // One mute per session — re-muting the same session overwrites the existing
  // row's `expires_at` via ON CONFLICT.
  sessionId: text("session_id").primaryKey(),
  // Wall-clock expiry (UTC). The cron prune deletes rows where now() >= this.
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Supports the periodic "delete WHERE expires_at < now()" sweep without a
  // sequential scan once the table accumulates many short-lived rows.
  index("watch_session_mutes_expires_at_idx").on(t.expiresAt),
]);
