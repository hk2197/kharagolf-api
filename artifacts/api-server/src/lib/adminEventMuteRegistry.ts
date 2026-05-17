import { userNotificationPrefsTable } from "@workspace/db";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Task #1733 — Single registry of admin-only per-event opt-out columns
 * surfaced on the head-of-ops admin dashboard at `/admin/event-mutes`.
 *
 * Each entry maps a stable `id` (used in URL paths and audit messages) to
 * a boolean column on `user_notification_prefs`. The column convention is
 * `false = muted, true = receive`, so a row with the column set to `false`
 * means the user has opted out of that admin alert. Users with no row at
 * all are treated as opted-in (the schema default is `true`).
 *
 * Adding a new admin-event opt-out means one extra entry here plus the
 * matching column in `lib/db/src/schema/golf.ts`. The dispatcher map in
 * `notifyDispatch.ts` (`PER_EVENT_OPT_OUT_COLUMNS`) is a *strict subset*
 * of this registry — it only lists the keys the central
 * `dispatchNotification` path is allowed to short-circuit. Bespoke cron
 * paths (e.g. the email-side erasure-storage digest, the monthly
 * member-prefs CSV digest, the manual-entry alert direct-email path)
 * still honour their own column reads, but they all share the same
 * underlying `user_notification_prefs` boolean — which is what makes
 * a unified ops dashboard feasible.
 *
 * `category` groups rows visually on the dashboard. `notificationKeys`
 * is the array of dispatcher / cron keys the entry corresponds to so the
 * "recent audit rows" panel on the same page can join cleanly to
 * `notification_audit_log` rows that mention `event_opted_out`.
 */
export interface AdminEventMuteEntry {
  id: string;
  label: string;
  description: string;
  category: "Billing" | "Coaching" | "Privacy" | "Operations" | "Super-admin";
  column: PgColumn;
  columnName: string;
  notificationKeys: readonly string[];
}

export const ADMIN_EVENT_MUTE_REGISTRY: readonly AdminEventMuteEntry[] = [
  {
    id: "wallet_refund_digest_failed",
    label: "Wallet auto-refund digest failed/paused",
    description:
      "Admin alert when the wallet auto-refund digest fails to deliver or is paused due to bounced recipients.",
    category: "Billing",
    column: userNotificationPrefsTable.notifyWalletRefundDigestFailed,
    columnName: "notify_wallet_refund_digest_failed",
    notificationKeys: ["wallet.refund.digest.failed"],
  },
  {
    id: "side_game_receipt_digest_failed",
    label: "Side-game receipts digest failed/paused",
    description:
      "Admin alert when the stuck side-game receipts digest fails to deliver or is paused due to bounced recipients.",
    category: "Billing",
    column: userNotificationPrefsTable.notifySideGameReceiptDigestFailed,
    columnName: "notify_side_game_receipt_digest_failed",
    notificationKeys: ["side_game.receipt.digest.failed"],
  },
  // Task #1762 — surface the three Task #1444 levy/reminders digest-
  // failed alerts on the same head-of-ops dashboard so an admin can
  // mute them per-user from one place. The dispatcher map in
  // `notifyDispatch.ts` (`PER_EVENT_OPT_OUT_COLUMNS`) lists the same
  // three keys so `dispatchNotification` honours these flags
  // automatically; no bespoke cron-side read is required here.
  {
    id: "levy_ledger_digest_failed",
    label: "Per-levy ledger CSV digest failed/paused",
    description:
      "Admin alert when a per-levy ledger CSV digest schedule fails to deliver or is paused due to bounced recipients.",
    category: "Billing",
    column: userNotificationPrefsTable.notifyLevyLedgerDigestFailed,
    columnName: "notify_levy_ledger_digest_failed",
    notificationKeys: ["levy.ledger.digest.failed"],
  },
  {
    id: "levy_ledger_org_digest_failed",
    label: "Club-wide combined levy ledger CSV digest failed/paused",
    description:
      "Admin alert when the club-wide combined levy ledger CSV digest fails to deliver or is paused due to bounced recipients.",
    category: "Billing",
    column: userNotificationPrefsTable.notifyLevyLedgerOrgDigestFailed,
    columnName: "notify_levy_ledger_org_digest_failed",
    notificationKeys: ["levy.ledger.org.digest.failed"],
  },
  {
    id: "levy_reminders_digest_failed",
    label: "Bounced-levy reminders digest failed/paused",
    description:
      "Admin alert when the bounced-levy reminders cron digest fails to deliver or every admin recipient is bouncing.",
    category: "Billing",
    column: userNotificationPrefsTable.notifyLevyRemindersDigestFailed,
    columnName: "notify_levy_reminders_digest_failed",
    notificationKeys: ["levy.reminders.digest.failed"],
  },
  {
    id: "coach_payout_account_changes",
    label: "Coach payout account changed (admin oversight)",
    description:
      "Admin oversight alert when a coach's payout account is created or updated.",
    category: "Coaching",
    column: userNotificationPrefsTable.notifyCoachPayoutAccountChanges,
    columnName: "notify_coach_payout_account_changes",
    notificationKeys: ["coach.payout.account.changed.admin"],
  },
  {
    id: "manual_entry_alerts",
    label: "Manual-entry data-quality alert",
    description:
      "Tournament-director alert when a round is recorded via manual entry instead of through a verified scoring path.",
    category: "Operations",
    column: userNotificationPrefsTable.notifyManualEntryAlerts,
    columnName: "notify_manual_entry_alerts",
    notificationKeys: ["manual_entry.round.alert"],
  },
  {
    id: "erasure_storage_digest_email",
    label: "Stuck erasure cleanup — daily controller digest (email)",
    description:
      "Email-side opt-out for the daily controller digest of erasure cleanups still failing.",
    category: "Privacy",
    column: userNotificationPrefsTable.notifyErasureStorageDigest,
    columnName: "notify_erasure_storage_digest",
    notificationKeys: ["privacy.erasure.storage_failures.controller_digest"],
  },
  {
    id: "erasure_storage_digest_push",
    label: "Stuck erasure cleanup — daily controller digest (push / in-app)",
    description:
      "Push and in-app side opt-out for the daily controller digest of erasure cleanups still failing.",
    category: "Privacy",
    column: userNotificationPrefsTable.notifyErasureStorageDigestPush,
    columnName: "notify_erasure_storage_digest_push",
    notificationKeys: ["privacy.erasure.storage_failures.controller_digest"],
  },
  {
    id: "member_prefs_digest",
    label: "Monthly member-prefs CSV controller digest",
    description:
      "Monthly per-org controller digest of every member's notification-preference state, for finance/outreach audit.",
    category: "Privacy",
    column: userNotificationPrefsTable.notifyMemberPrefsDigest,
    columnName: "notify_member_prefs_digest",
    notificationKeys: ["privacy.member_prefs.controller_digest"],
  },
  {
    id: "notify_exhaustion_admin_digest_failed",
    label: "Daily exhaustion admin digest failed (super-admin fallback)",
    description:
      "Super-admin fallback alert when every admin recipient for an org bounces / is on the suppression list / fails the SMTP send during the daily wallet-refund + coach-payout exhaustion admin digest cron (Task #1855).",
    category: "Super-admin",
    column: userNotificationPrefsTable.notifyExhaustionAdminDigestFailed,
    columnName: "notify_exhaustion_admin_digest_failed",
    notificationKeys: ["notify.exhaustion.admin_digest.failed"],
  },
  {
    id: "silent_alerts_digest",
    label: "Weekly silent-failures CSV super-admin digest",
    description:
      "Super-admin only: weekly CSV digest of zero-delivery manual-entry alerts so ops can spot recipients/devices that aren't getting through.",
    category: "Super-admin",
    column: userNotificationPrefsTable.notifySilentAlertsDigest,
    columnName: "notify_silent_alerts_digest",
    notificationKeys: ["ops.silent_alerts.super_admin_digest"],
  },
];

export function getAdminEventMuteEntry(id: string): AdminEventMuteEntry | undefined {
  return ADMIN_EVENT_MUTE_REGISTRY.find(e => e.id === id);
}

/** Notification keys that any admin-event opt-out can short-circuit into
 * an `event_opted_out` audit row. Used by the audit-log surface on the
 * ops page to filter `notification_audit_log` to the relevant rows. */
export function adminEventNotificationKeys(): string[] {
  const seen = new Set<string>();
  for (const e of ADMIN_EVENT_MUTE_REGISTRY) {
    for (const k of e.notificationKeys) seen.add(k);
  }
  return Array.from(seen);
}
