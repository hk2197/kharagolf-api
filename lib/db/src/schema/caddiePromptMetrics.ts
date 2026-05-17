/**
 * Task #845 — Durable AI Caddie prompt-size metrics.
 *
 * The original tracking (Task #687) lived in a per-process ring buffer of the
 * last 1,000 measurements. Restarts wiped it and each replica had its own
 * slice, so trending prompt size and cost over weeks/months was impossible.
 *
 * One row per /portal/caddie/ask invocation. Aggregates are computed at read
 * time over rolling windows (24h / 7d / 30d). A daily cron sweeps rows older
 * than 90 days.
 */
import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";

export const caddiePromptMetricsTable = pgTable("caddie_prompt_metrics", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  contextMode: text("context_mode").notNull(), // 'shots' | 'rounds'
  estimatedInputTokens: integer("estimated_input_tokens").notNull(),
  totalTrackedShots: integer("total_tracked_shots").notNull(),
  roundCount: integer("round_count").notNull(),
  shotLineCount: integer("shot_line_count").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Aggregations and prune scans walk by timestamp.
  index("caddie_prompt_metrics_created_at_idx").on(t.createdAt),
]);
