/**
 * Task #1959 — Per-org admin-controlled order for analytics event
 * categories.
 *
 * The Customize tab and trends chart group events by category (Task
 * #1569). Admins can now drag categories into a deliberate order
 * (e.g. Bookings before Marketing before Engagement) so the
 * dashboard reads the way they think about the business. This table
 * persists that order — one row per (organizationId, category) with
 * a 0-based `position`. Categories without a row fall back to
 * alphabetical, "Uncategorized" stays pinned last.
 *
 * Org-scoped from day one. The `category` is free-text and matches
 * the `category` column on `analytics_event_metadata`. Stale rows
 * for categories no longer in use don't hurt — the dashboard simply
 * ignores them when building the ordered list.
 */
import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const analyticsEventCategoryOrderTable = pgTable(
  "analytics_event_category_order",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull(),
    category: text("category").notNull(),
    position: integer("position").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("analytics_event_category_order_org_category_unique").on(
      t.organizationId,
      t.category,
    ),
  ],
);

export type AnalyticsEventCategoryOrderRow =
  typeof analyticsEventCategoryOrderTable.$inferSelect;
