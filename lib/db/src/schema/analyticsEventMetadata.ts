/**
 * Task #1318 — Per-org friendly names + colors for analytics events.
 *
 * The analytics dashboard auto-discovers event names from
 * `analytics_events` (Task #1143) so newly instrumented flows show up
 * without a code change. This table lets each org's admins assign a
 * human-readable label, description, and chart color to any event name
 * that has been emitted, so the dashboard reads naturally as more
 * flows get instrumented.
 *
 * Org-scoped from day one (multi-tenancy is not retrofitted later).
 * One row per (organizationId, eventName); upsert on conflict.
 *
 * The dashboard reads these via GET /events/metadata and falls back to
 * the raw event name + a deterministic hash-derived color when no row
 * exists.
 *
 * Task #1570 — Each row also records `updated_by_user_id` (the admin
 * who last edited it) and an append-only history table captures the
 * last few changes so teammates can see who customized an event and
 * when.
 */
import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { appUsersTable } from "./golf";

export const analyticsEventMetadataTable = pgTable(
  "analytics_event_metadata",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull(),
    eventName: text("event_name").notNull(),
    // Optional friendly label (e.g. "F&B Order Placed" for fb_order_placed).
    // Null/empty means the dashboard falls back to the raw event name.
    displayName: text("display_name"),
    // Optional admin-authored description. Surfaced as a hover/tooltip in
    // the dashboard so admins can explain what each event represents.
    description: text("description"),
    // Hex color (e.g. "#3b82f6") used in the chart legend, line stroke,
    // and totals tile dot. Null means the dashboard falls back to its
    // built-in color map / hash-derived palette.
    color: text("color"),
    // Optional category (e.g. "Bookings", "Payments", "Engagement") used
    // by the dashboard to group totals tiles, chart lines, and the
    // Customize tab rows. Free-text — the admin-managed list is just the
    // distinct set of categories already in use across this org's rows.
    // Null/empty means the event is shown in an "Uncategorized" bucket.
    // Task #1569.
    category: text("category"),
    // Task #1570 — Stamp the admin who last edited this row so the
    // Customize tab can render "Last edited by <name> on <date>" beside
    // each customized event. SET NULL on delete keeps the audit trail
    // intact if the editor's account is later erased.
    updatedByUserId: integer("updated_by_user_id").references(
      () => appUsersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("analytics_event_metadata_org_event_unique").on(
      t.organizationId,
      t.eventName,
    ),
  ],
);

/**
 * Task #1570 — Append-only audit log of admin edits to event metadata.
 *
 * One row per upsert/delete on `analytics_event_metadata`. The Customize
 * tab fetches the most recent few rows per (organizationId, eventName)
 * to render a "Recent changes" timeline so teammates can see who
 * relabelled or recolored an event and when.
 *
 * The row captures the *new* values applied by the change (or NULLs +
 * action='delete' when the override is removed) plus the editor. We do
 * not need a per-field diff for the dashboard's read pattern — a
 * compact "name → new label, by Alice, 3 days ago" line is enough to
 * point a teammate at the right person to ask.
 */
export const analyticsEventMetadataHistoryTable = pgTable(
  "analytics_event_metadata_history",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").notNull(),
    eventName: text("event_name").notNull(),
    // 'upsert' when admins create or update the override; 'delete' when
    // they reset back to the auto-generated label/color.
    action: text("action").notNull(),
    // New values written by this change. All NULL for action='delete'.
    displayName: text("display_name"),
    description: text("description"),
    color: text("color"),
    // Auto-generated FK constraint name would exceed Postgres's 63-char
    // identifier limit, so we declare the FK explicitly with a short
    // name (matches the style used in lib/db/src/schema/golf.ts —
    // see task #805).
    changedByUserId: integer("changed_by_user_id"),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "analytics_event_metadata_history_changed_by_user_fk",
      columns: [t.changedByUserId],
      foreignColumns: [appUsersTable.id],
    }).onDelete("set null"),
    index("analytics_event_metadata_history_org_event_idx").on(
      t.organizationId,
      t.eventName,
      t.changedAt,
    ),
  ],
);

export type AnalyticsEventMetadataRow =
  typeof analyticsEventMetadataTable.$inferSelect;
export type AnalyticsEventMetadataHistoryRow =
  typeof analyticsEventMetadataHistoryTable.$inferSelect;
