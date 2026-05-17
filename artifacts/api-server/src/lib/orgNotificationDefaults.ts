// Task #1673 — Single source of truth for org-wide notification defaults
// that are mirrored on a per-tournament toggle. The four
// /organizations/:orgId/notification-defaults/* endpoints (GET defaults,
// PATCH defaults, GET tournaments, POST apply-to-tournaments) all iterate
// this registry so adding a future flag (e.g. schedule-change digests,
// score-correction alerts) means: 1) add the org + tournament boolean
// columns to lib/db/src/schema/golf.ts, 2) append a single entry here.
// No bespoke endpoint pair, no new route handler, no new validation
// branch. The web client has a parallel registry that maps the same
// keys to user-facing labels and copy.
//
// We deliberately keep this list narrow: only flags whose concept is
// "org-wide default that seeds a per-tournament toggle and can be bulk-
// applied back across existing events" belong here. Per-user prefs
// (`user_notification_prefs.notify*`) are unrelated and stay on the
// portal endpoints.

import {
  organizationsTable,
  tournamentsTable,
} from "@workspace/db";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export type OrgNotificationDefaultKey =
  | "notifyManualEntryAlerts"
  | "notifyScheduleChanges"
  | "notifyScoreCorrections";

export interface OrgNotificationDefaultSpec {
  /** Stable wire key — also the column name on both tables today. */
  key: OrgNotificationDefaultKey;
  /** Drizzle column on `organizations` that stores the org-wide value. */
  orgColumn: AnyPgColumn;
  /** Matching column on `tournaments` for the per-event override. */
  tournamentColumn: AnyPgColumn;
  /** Short label used only in API error messages — UI labels live web-side. */
  label: string;
}

export const ORG_NOTIFICATION_DEFAULT_SPECS: readonly OrgNotificationDefaultSpec[] = [
  {
    key: "notifyManualEntryAlerts",
    orgColumn: organizationsTable.notifyManualEntryAlerts,
    tournamentColumn: tournamentsTable.notifyManualEntryAlerts,
    label: "manual-entry alerts",
  },
  {
    key: "notifyScheduleChanges",
    orgColumn: organizationsTable.notifyScheduleChanges,
    tournamentColumn: tournamentsTable.notifyScheduleChanges,
    label: "schedule-change alerts",
  },
  {
    key: "notifyScoreCorrections",
    orgColumn: organizationsTable.notifyScoreCorrections,
    tournamentColumn: tournamentsTable.notifyScoreCorrections,
    label: "score-correction alerts",
  },
] as const;

const SPEC_BY_KEY = new Map<OrgNotificationDefaultKey, OrgNotificationDefaultSpec>(
  ORG_NOTIFICATION_DEFAULT_SPECS.map(s => [s.key, s]),
);

export function isOrgNotificationDefaultKey(value: unknown): value is OrgNotificationDefaultKey {
  return typeof value === "string" && SPEC_BY_KEY.has(value as OrgNotificationDefaultKey);
}

export function getOrgNotificationDefaultSpec(
  key: OrgNotificationDefaultKey,
): OrgNotificationDefaultSpec {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) throw new Error(`Unknown org notification default key: ${key}`);
  return spec;
}
