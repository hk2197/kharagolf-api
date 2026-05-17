/**
 * Task #784 — Shared (cluster-wide) token-bucket state for the public,
 * unauthenticated marketing-site endpoints.
 *
 * The original limiter (Task #626) lived in a per-process JavaScript Map
 * which is unsafe once the API runs more than one instance behind a load
 * balancer (a spammer effectively gets N× quota). This table backs the
 * limiter with Postgres so all API processes see the same bucket state.
 *
 * One row per logical bucket key (e.g. `photo:ip:1.2.3.4`,
 * `review:course:42`, `report:ip+review:1.2.3.4:99`). Rows are read &
 * mutated inside a single transaction with `SELECT … FOR UPDATE` so two
 * concurrent requests can't double-spend a token.
 */
import { pgTable, text, doublePrecision, timestamp, index } from "drizzle-orm/pg-core";

export const publicRateLimitBucketsTable = pgTable("public_rate_limit_buckets", {
  key: text("key").primaryKey(),
  tokens: doublePrecision("tokens").notNull(),
  lastRefillAt: timestamp("last_refill_at", { withTimezone: true }).notNull(),
}, (t) => [
  // Cron / opportunistic eviction of stale buckets walks by lastRefillAt.
  index("public_rate_limit_buckets_last_refill_at_idx").on(t.lastRefillAt),
]);
