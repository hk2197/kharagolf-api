/**
 * Task #2219 — Registry of digest opt-outs that emit a one-time mute
 * confirmation email + signed 7-day revert link when a controller
 * silences them from the portal (PATCH
 * /portal/notification-preferences). Mirrors the pattern Task #1776
 * shipped for the stuck-erasure digest only.
 *
 * Each entry maps a short opcode (`slug`) to:
 *   - `prefField`: the boolean column on `userNotificationPrefs` that
 *     PATCH may flip true→false. The handler iterates this registry
 *     and emits one confirmation per digest that just transitioned
 *     true→false in the same request.
 *   - `notificationKey`: the registry key the digest was originally
 *     dispatched under. Surfaced in the audit row so the per-member
 *     comm-prefs audit history reads chronologically with the
 *     dispatcher's own per-event opt-out audit rows.
 *   - `subject`: the confirmation email's `Subject:` line.
 *   - `headlineHtml`: the bolded headline shown in the email body.
 *   - `digestNameHtml`: the human-readable label for the digest used
 *     inside the body sentence ("the daily X digest from <org>…").
 *   - `audience`: a one-line phrase describing why this controller
 *     receives the digest. Used to round out the body so the
 *     recipient remembers the context ("…you're receiving this
 *     because you are a billing admin…").
 *   - `revertHeadlineHtml`: the title shown on the public revert
 *     confirmation page after the controller clicks the link.
 *   - `revertBodyHtml`: a one-line description used on the public
 *     revert page ("The {digest} from <org> will resume…").
 *
 * The slug is what gets baked into the signed revert token (and the
 * `portal_digest_mute_confirmation_sends.digest_slug` rate-limit row),
 * so it must stay stable for the life of the token's TTL even when the
 * underlying registry key or pref column gets renamed.
 *
 * The stuck-erasure digest (`notifyErasureStorageDigest` /
 * `notifyErasureStorageDigestPush`) is intentionally NOT in this
 * registry: it ships its own per-channel revert token (`emr1:`),
 * its own watermark column on the prefs row, and its own
 * combined-channel mailer — touching it would invalidate the live
 * 7-day links already in inboxes. Sibling digests added here all share
 * the same generic `pdr1:` token shape and the
 * `portal_digest_mute_confirmation_sends` watermark table.
 */
import { userNotificationPrefsTable } from "@workspace/db";

export type PortalDigestMuteSlug =
  | "wrf"  // wallet.refund.digest.failed
  | "sgr"  // side_game.receipt.digest.failed
  | "lld"  // levy.ledger.digest.failed
  | "llo"  // levy.ledger.org.digest.failed
  | "lrd"  // levy.reminders.digest.failed
  | "ead"  // notify.exhaustion.admin_digest.failed
  | "sad"; // silent_alerts.digest

/**
 * The set of `userNotificationPrefs` boolean columns that this registry
 * covers. The PATCH handler reads and writes these via the typed prefs
 * row; we intersect with the registry to know which transitions to
 * emit confirmations for.
 */
export type PortalDigestMutePrefField =
  | "notifyWalletRefundDigestFailed"
  | "notifySideGameReceiptDigestFailed"
  | "notifyLevyLedgerDigestFailed"
  | "notifyLevyLedgerOrgDigestFailed"
  | "notifyLevyRemindersDigestFailed"
  | "notifyExhaustionAdminDigestFailed"
  | "notifySilentAlertsDigest";

export interface PortalDigestMuteSpec {
  /** Stable opcode baked into the signed revert token + watermark row. */
  slug: PortalDigestMuteSlug;
  /** Boolean column on `userNotificationPrefs` the PATCH handler may flip true→false. */
  prefField: PortalDigestMutePrefField;
  /** Drizzle column reference for selects/updates. */
  prefColumn:
    | typeof userNotificationPrefsTable.notifyWalletRefundDigestFailed
    | typeof userNotificationPrefsTable.notifySideGameReceiptDigestFailed
    | typeof userNotificationPrefsTable.notifyLevyLedgerDigestFailed
    | typeof userNotificationPrefsTable.notifyLevyLedgerOrgDigestFailed
    | typeof userNotificationPrefsTable.notifyLevyRemindersDigestFailed
    | typeof userNotificationPrefsTable.notifyExhaustionAdminDigestFailed
    | typeof userNotificationPrefsTable.notifySilentAlertsDigest;
  /** Notification registry key the digest was originally dispatched under. */
  notificationKey: string;
  /** Email subject line. */
  subject: string;
  /** Headline shown at the top of the email body (HTML-safe — no user input). */
  headlineHtml: string;
  /** Human-readable digest name used inline in the body sentence. */
  digestNameHtml: string;
  /** One-line audience reminder: "you're receiving this because…". */
  audienceHtml: string;
  /** Title shown on the public revert confirmation page. */
  revertHeadlineHtml: string;
  /** One-line description shown on the public revert confirmation page. */
  revertBodyHtml: string;
}

/**
 * The registry itself. New digests can be added by introducing a new
 * slug, picking the matching pref column, and supplying the human-
 * readable strings — no other call-site changes are required (the
 * portal handler, mailer, and public revert handler all iterate this
 * map).
 */
export const PORTAL_DIGEST_MUTE_REGISTRY: Record<PortalDigestMuteSlug, PortalDigestMuteSpec> = {
  wrf: {
    slug: "wrf",
    prefField: "notifyWalletRefundDigestFailed",
    prefColumn: userNotificationPrefsTable.notifyWalletRefundDigestFailed,
    notificationKey: "wallet.refund.digest.failed",
    subject: "You muted the wallet auto-refund failed alert — re-enable here",
    headlineHtml: "You muted the wallet auto-refund failed alert",
    digestNameHtml: "wallet auto-refund failed/paused",
    audienceHtml: "You are receiving this because you are an admin who handles wallet auto-refunds.",
    revertHeadlineHtml: "Alert re-enabled",
    revertBodyHtml:
      "The wallet auto-refund failed/paused alert will resume whenever there's something to act on.",
  },
  sgr: {
    slug: "sgr",
    prefField: "notifySideGameReceiptDigestFailed",
    prefColumn: userNotificationPrefsTable.notifySideGameReceiptDigestFailed,
    notificationKey: "side_game.receipt.digest.failed",
    subject: "You muted the stuck side-game receipts alert — re-enable here",
    headlineHtml: "You muted the stuck side-game receipts alert",
    digestNameHtml: "stuck side-game receipts digest failed/paused",
    audienceHtml: "You are receiving this because you are an admin who handles side-game receipts.",
    revertHeadlineHtml: "Alert re-enabled",
    revertBodyHtml:
      "The stuck side-game receipts failed/paused alert will resume whenever there's something to act on.",
  },
  lld: {
    slug: "lld",
    prefField: "notifyLevyLedgerDigestFailed",
    prefColumn: userNotificationPrefsTable.notifyLevyLedgerDigestFailed,
    notificationKey: "levy.ledger.digest.failed",
    subject: "You muted the per-levy ledger CSV digest alert — re-enable here",
    headlineHtml: "You muted the per-levy ledger CSV digest alert",
    digestNameHtml: "per-levy ledger CSV digest failed/paused",
    audienceHtml: "You are receiving this because you are a treasurer or membership secretary who handles levy ledgers.",
    revertHeadlineHtml: "Alert re-enabled",
    revertBodyHtml:
      "The per-levy ledger CSV digest failed/paused alert will resume whenever there's something to act on.",
  },
  llo: {
    slug: "llo",
    prefField: "notifyLevyLedgerOrgDigestFailed",
    prefColumn: userNotificationPrefsTable.notifyLevyLedgerOrgDigestFailed,
    notificationKey: "levy.ledger.org.digest.failed",
    subject: "You muted the club-wide levy ledger CSV digest alert — re-enable here",
    headlineHtml: "You muted the club-wide levy ledger CSV digest alert",
    digestNameHtml: "club-wide combined levy ledger CSV digest failed/paused",
    audienceHtml: "You are receiving this because you are a treasurer or membership secretary who handles levy ledgers.",
    revertHeadlineHtml: "Alert re-enabled",
    revertBodyHtml:
      "The club-wide levy ledger CSV digest failed/paused alert will resume whenever there's something to act on.",
  },
  lrd: {
    slug: "lrd",
    prefField: "notifyLevyRemindersDigestFailed",
    prefColumn: userNotificationPrefsTable.notifyLevyRemindersDigestFailed,
    notificationKey: "levy.reminders.digest.failed",
    subject: "You muted the bounced-levy reminders digest alert — re-enable here",
    headlineHtml: "You muted the bounced-levy reminders digest alert",
    digestNameHtml: "bounced-levy reminders digest failed/paused",
    audienceHtml: "You are receiving this because you are an admin who handles bounced-levy reminders.",
    revertHeadlineHtml: "Alert re-enabled",
    revertBodyHtml:
      "The bounced-levy reminders digest failed/paused alert will resume whenever there's something to act on.",
  },
  ead: {
    slug: "ead",
    prefField: "notifyExhaustionAdminDigestFailed",
    prefColumn: userNotificationPrefsTable.notifyExhaustionAdminDigestFailed,
    notificationKey: "notify.exhaustion.admin_digest.failed",
    subject: "You muted the admin-exhaustion fallback alert — re-enable here",
    headlineHtml: "You muted the admin-exhaustion fallback alert",
    digestNameHtml: "admin-exhaustion fallback alert",
    audienceHtml: "You are receiving this because you are a super admin who handles fallback delivery alerts.",
    revertHeadlineHtml: "Alert re-enabled",
    revertBodyHtml:
      "The admin-exhaustion fallback alert will resume whenever there's something to act on.",
  },
  sad: {
    slug: "sad",
    prefField: "notifySilentAlertsDigest",
    prefColumn: userNotificationPrefsTable.notifySilentAlertsDigest,
    notificationKey: "silent_alerts.digest",
    subject: "You muted the weekly silent-failures CSV digest — re-enable here",
    headlineHtml: "You muted the weekly silent-failures CSV digest",
    digestNameHtml: "weekly silent-failures CSV digest",
    audienceHtml: "You are receiving this because you are a super admin who reviews zero-delivery manual-entry alerts.",
    revertHeadlineHtml: "Digest re-enabled",
    revertBodyHtml:
      "The weekly silent-failures CSV digest will resume on its next scheduled run.",
  },
};

/** Iteration helper — every spec in registration order. */
export const PORTAL_DIGEST_MUTE_SPECS: ReadonlyArray<PortalDigestMuteSpec> = Object.values(PORTAL_DIGEST_MUTE_REGISTRY);

/** Lookup by slug; returns `undefined` for unknown slugs (e.g. forged tokens). */
export function getPortalDigestMuteSpec(slug: string): PortalDigestMuteSpec | undefined {
  return (PORTAL_DIGEST_MUTE_REGISTRY as Record<string, PortalDigestMuteSpec | undefined>)[slug];
}

/** True iff `slug` is a known registry key. */
export function isPortalDigestMuteSlug(slug: string): slug is PortalDigestMuteSlug {
  return slug in PORTAL_DIGEST_MUTE_REGISTRY;
}
