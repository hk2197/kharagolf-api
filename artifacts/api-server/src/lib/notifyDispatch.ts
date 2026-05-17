/**
 * Task #1005 — Central notification dispatch helper.
 *
 * Wraps `assertRegistered` + push delivery + email delivery + digest
 * queueing + audit logging into a single call site so every registered
 * notification key in `notificationRegistry.ts` has exactly one well-
 * understood path from "event happened" to "user got told".
 *
 * Behaviour for `dispatchNotification(key, recipients, payload)`:
 *
 *   1. Asserts the key is in the registry. Unknown keys throw.
 *   2. Looks up the registry row to read the spec
 *      (`digestable`, `defaultChannels`, `auditRequired`).
 *   3. For each recipient:
 *        a. Reads `userNotificationPrefsTable` (preferEmail / preferPush
 *           / digestMode). Missing row → defaults (email=true, push=true,
 *           digestMode=false).
 *        b. If `digestable` AND user has `digestMode=true` → enqueues a
 *           row in `notification_digest_queue` and returns. No push or
 *           email is sent now; the daily cron will batch them.
 *        c. Otherwise sends push (when `preferPush` and the spec
 *           includes `"push"`), and sends email (when `preferEmail`,
 *           the spec includes `"email"`, and the caller supplied
 *           `payload.emailHtml`).
 *      d. If the spec has `auditRequired = true`, writes an audit row
 *         per recipient + channel.
 *
 * All failures are caught and surfaced in the result; this helper never
 * throws on delivery failure (only on programmer error like dispatching
 * an unregistered key).
 */
import { db, notificationTypeRegistryTable, userNotificationPrefsTable, userNotificationKeyPrefsTable, notificationDigestQueueTable, notificationAuditLogTable, appUsersTable } from "@workspace/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import { assertRegistered } from "./notificationRegistry.js";
import { getNotificationSample } from "./notificationSamples.js";
import { sendPushToUsers, classifyPushDelivery, type PushDeliveryResult, type PushDeliveryStatus } from "./push.js";
import { sendNotificationEmail } from "./mailer.js";
import type { EmailBranding } from "./mailer.js";
import { renderNotificationEmail } from "./notificationEmailTemplates.js";
import {
  NOTIFICATION_EMAIL_LANGS,
  hasNotificationEmailTranslation,
  resolveNotificationEmailLang,
  type NotificationEmailLang,
} from "./notificationEmailI18n.js";
import { wrapCtaUrl, recordCtaSend } from "./emailCtaTracking.js";
import { signEventMuteToken } from "./bouncedDigestUnsubscribe.js";
import { logger } from "./logger.js";

export interface DispatchPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Optional HTML body for email channel. If omitted, the dispatcher
   *  consults `notificationEmailTemplates.ts` for a branded renderer
   *  registered under this key; if neither exists, email is skipped. */
  emailHtml?: string;
  /** Optional plain-text email body (falls back to `body`). */
  emailText?: string;
  /** Optional subject (falls back to `title`). */
  emailSubject?: string;
  /** Optional org branding (logo / primary colour / orgName) forwarded
   *  to the branded email renderer. Task #1171. */
  branding?: EmailBranding;
  /**
   * Task #1734 — When set AND the dispatch key has a per-event mute slug
   * registered in {@link EVENT_MUTE_SLUGS}, the email leg appends a
   * one-click "Mute this alert" footer link + RFC 2369 / RFC 8058
   * `List-Unsubscribe` headers. The link is HMAC-signed (token prefix
   * `pem1:` in `bouncedDigestUnsubscribe.ts`) per recipient and routes
   * to `/api/public/notification-event-mute`, which flips the matching
   * `userNotificationPrefs` column to false and writes a
   * `notification_audit_log` row with reason
   * `event_opted_out_via_email_link`. The orgId is carried only so the
   * confirmation page can name the club the alert came from — the
   * opt-out itself is user-scoped, mirroring the per-event opt-out
   * shipped in Task #1429.
   */
  eventMuteOrgId?: number;
}

export type DispatchChannel = "push" | "email" | "digest" | "skipped";

export interface DispatchPerUserResult {
  userId: number;
  channels: { channel: DispatchChannel; status: "sent" | "skipped" | "failed" | "queued"; reason?: string }[];
}

export interface DispatchResult {
  key: string;
  digestable: boolean;
  recipients: DispatchPerUserResult[];
}

interface CachedSpec {
  digestable: boolean;
  defaultChannels: string[];
  auditRequired: boolean;
}

const specCache = new Map<string, CachedSpec>();

async function loadSpec(key: string): Promise<CachedSpec> {
  const hit = specCache.get(key);
  if (hit) return hit;
  const [row] = await db.select({
    digestable: notificationTypeRegistryTable.digestable,
    defaultChannels: notificationTypeRegistryTable.defaultChannels,
    auditRequired: notificationTypeRegistryTable.auditRequired,
  }).from(notificationTypeRegistryTable)
    .where(eq(notificationTypeRegistryTable.key, key))
    .limit(1);
  const spec: CachedSpec = {
    digestable: row?.digestable ?? false,
    defaultChannels: (row?.defaultChannels as string[] | null) ?? ["email", "push"],
    auditRequired: row?.auditRequired ?? false,
  };
  specCache.set(key, spec);
  return spec;
}

/** Test-only: clear the in-memory spec cache. */
export function _clearSpecCacheForTests(): void {
  specCache.clear();
}

interface UserPref {
  userId: number;
  preferEmail: boolean;
  preferPush: boolean;
  digestMode: boolean;
  email: string | null;
  /**
   * Task #1429 — per-event opt-out flag (true = receive, false = audit-only).
   * Mirrors the per-event opt-out shipped for the coach payout-account admin
   * alert in Task #1224. When the dispatched key has no entry in
   * `PER_EVENT_OPT_OUT_COLUMNS`, this stays `true` so the recipient is
   * unaffected. When the key IS mapped, a `false` value short-circuits all
   * channels (push / email / digest enqueue) for this recipient and the
   * dispatcher writes a `skipped` audit row with reason `event_opted_out`
   * even if the key spec sets `auditRequired = false` (so administrators
   * can prove the alert was suppressed by user choice, not lost).
   */
  eventOptIn: boolean;
}

interface UserAddr {
  email: string | null;
  name: string | null;
  lang: string | null;
  /**
   * Task #2019 — Recipient's organisation at send time, captured here
   * so the email leg can stamp it into the CTA tracking token + the
   * per-(key, org) send counter without an extra round-trip.
   */
  organizationId: number | null;
}

/**
 * Task #1429 — Map of dispatch keys to the boolean column on
 * `user_notification_prefs` that gates them per-event. Mirrors Task #1224's
 * `notifyCoachPayoutAccountChanges` opt-out for the bespoke coach
 * payout-account admin notify path; everything that goes through
 * `dispatchNotification` shares this single registry instead of each call
 * site re-implementing the lookup.
 *
 * Adding a new admin-only event here is the only step needed to make it
 * silenceable independently — the dispatcher reads the column, the portal
 * GET/PATCH `/portal/notification-preferences` endpoint surfaces the
 * column, and the corresponding toggle row on
 * `PortalCommPrefs.tsx` exposes it to the user.
 *
 * Keys NOT listed here are unaffected (the dispatcher treats `eventOptIn`
 * as always-true for them).
 */
export const PER_EVENT_OPT_OUT_COLUMNS = {
  "wallet.refund.digest.failed": userNotificationPrefsTable.notifyWalletRefundDigestFailed,
  "side_game.receipt.digest.failed": userNotificationPrefsTable.notifySideGameReceiptDigestFailed,
  // Task #1449 — switched to the dedicated push-side column so a controller
  // opting out of the in-app/push digest no longer also silences the email
  // cron (which still honours `notifyErasureStorageDigest` on its own path
  // in `cron.ts → sendErasureStorageFailuresDigest`). Pre-1449 this entry
  // pointed at `notifyErasureStorageDigest`, which made the two channels
  // share a single mute and prevented controllers from picking email-only
  // or push-only.
  "privacy.erasure.storage_failures.controller_digest": userNotificationPrefsTable.notifyErasureStorageDigestPush,
  // Task #1762 — three new admin alerts wired in by Task #1444. All
  // three follow the same audit-only short-circuit semantics as the
  // wallet/side-game refund digest entries above so admins who already
  // monitor the run history dashboard can mute the email noise without
  // losing the audit trail. The dispatcher reads each column directly;
  // the matching field-name entries below let the public unsubscribe
  // route flip the same column from the inbox.
  "levy.ledger.digest.failed": userNotificationPrefsTable.notifyLevyLedgerDigestFailed,
  "levy.ledger.org.digest.failed": userNotificationPrefsTable.notifyLevyLedgerOrgDigestFailed,
  "levy.reminders.digest.failed": userNotificationPrefsTable.notifyLevyRemindersDigestFailed,
  // Task #1855 — super-admin fallback alert for the daily exhaustion
  // admin digest cron (`sendNotifyExhaustionAdminDigest`, lib/cron.ts).
  // Same audit-only short-circuit semantics as the entries above so a
  // super_admin who muted the alert still gets the audit row but no
  // email/push.
  "notify.exhaustion.admin_digest.failed": userNotificationPrefsTable.notifyExhaustionAdminDigestFailed,
  // Task #2040 — daily "you closed the gap" coaching encouragement push
  // (`coaching.gap.closed`, dispatched from
  // `runCoachingGapClosedDailySweep` in `lib/cron.ts`). Same audit-only
  // short-circuit semantics as the entries above so a player who muted
  // the nudge still gets the audit row but no push, without affecting
  // the global `preferPush` toggle.
  "coaching.gap.closed": userNotificationPrefsTable.notifyCoachingTipClosed,
} as const;

export function perEventOptOutColumn(key: string) {
  // Cast through `unknown` because the `as const` literal type narrows the
  // value type per-key, which TS won't widen to a uniform Record.
  return (PER_EVENT_OPT_OUT_COLUMNS as unknown as Record<string, typeof userNotificationPrefsTable.notifyWalletRefundDigestFailed | undefined>)[key];
}

/**
 * Drizzle's `.values()` / `.set()` keys are matched against the
 * SCHEMA-OBJECT FIELD NAMES (TS camelCase), not the underlying SQL
 * column names — so when the public mute endpoint flips a column
 * resolved at runtime via {@link perEventOptOutColumn}, it can't just
 * use `column.name` (which is snake_case). This map gives the route
 * the correct camelCase field name keyed by dispatch key. Kept in
 * lockstep with {@link PER_EVENT_OPT_OUT_COLUMNS} above.
 */
export const PER_EVENT_OPT_OUT_FIELD_NAMES: Record<
  string,
  | "notifyWalletRefundDigestFailed"
  | "notifySideGameReceiptDigestFailed"
  | "notifyErasureStorageDigestPush"
  | "notifyLevyLedgerDigestFailed"
  | "notifyLevyLedgerOrgDigestFailed"
  | "notifyLevyRemindersDigestFailed"
  | "notifyExhaustionAdminDigestFailed"
  | "notifyCoachingTipClosed"
  | undefined
> = {
  "wallet.refund.digest.failed": "notifyWalletRefundDigestFailed",
  "side_game.receipt.digest.failed": "notifySideGameReceiptDigestFailed",
  "privacy.erasure.storage_failures.controller_digest": "notifyErasureStorageDigestPush",
  // Task #1762 — keep in lockstep with PER_EVENT_OPT_OUT_COLUMNS above so
  // any future inbox-side mute link for these keys can resolve the
  // camelCase field name without a separate lookup.
  "levy.ledger.digest.failed": "notifyLevyLedgerDigestFailed",
  "levy.ledger.org.digest.failed": "notifyLevyLedgerOrgDigestFailed",
  "levy.reminders.digest.failed": "notifyLevyRemindersDigestFailed",
  // Task #1855 — super-admin fallback alert; same lockstep convention.
  "notify.exhaustion.admin_digest.failed": "notifyExhaustionAdminDigestFailed",
  // Task #2040 — daily player coaching encouragement push; same lockstep
  // convention so any future inbox-side mute link for this key can
  // resolve the camelCase field name without a separate lookup.
  "coaching.gap.closed": "notifyCoachingTipClosed",
};

export function perEventOptOutFieldName(key: string): string | undefined {
  return PER_EVENT_OPT_OUT_FIELD_NAMES[key];
}

/**
 * Task #1734 — Map of dispatch keys whose admin alert emails carry a
 * one-click "Mute this alert" footer link to a short slug. The slug is
 * embedded in the HMAC-signed token (token format `pem1:userId:slug:
 * orgId:iat:sig`, see `bouncedDigestUnsubscribe.ts`) so the public
 * unsubscribe handler can route back to the right key + per-event
 * opt-out column without exposing the full registry key in the URL.
 *
 * Only keys that ALSO appear in {@link PER_EVENT_OPT_OUT_COLUMNS} are
 * mute-able from the inbox; the dispatcher checks both maps before
 * minting a link. The erasure-storage controller digest is intentionally
 * excluded — it already has its own dedicated unsubscribe link route
 * (`/api/public/erasure-digest-unsubscribe`, Task #1242) tied to a
 * different prefs column (`notifyErasureStorageDigest`), and offering
 * two competing inbox-side links for one alert family would be
 * confusing.
 */
export const EVENT_MUTE_SLUGS = {
  "wallet.refund.digest.failed": "wrdf",
  "side_game.receipt.digest.failed": "srdf",
} as const;

export type EventMuteSlug = (typeof EVENT_MUTE_SLUGS)[keyof typeof EVENT_MUTE_SLUGS];

/** Reverse lookup so the public mute endpoint can resolve `slug → key`. */
export const EVENT_MUTE_KEY_FOR_SLUG: Record<string, keyof typeof EVENT_MUTE_SLUGS | undefined> = {
  wrdf: "wallet.refund.digest.failed",
  srdf: "side_game.receipt.digest.failed",
};

export function eventMuteSlugForKey(key: string): EventMuteSlug | undefined {
  return (EVENT_MUTE_SLUGS as unknown as Record<string, EventMuteSlug | undefined>)[key];
}

/**
 * Compute the public base URL the mute link should hang off. Mirrors
 * the env-var precedence used elsewhere (cron.ts, public.ts):
 *   1. `PUBLIC_BASE_URL` if explicitly set,
 *   2. else `https://${REPLIT_DEV_DOMAIN}` while developing on Replit,
 *   3. else the production domain.
 */
function publicBaseUrlForMuteLink(): string {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const dev = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (dev) return `https://${dev}`;
  return "https://kharagolf.com";
}

/**
 * Build the per-recipient HMAC-signed "mute this alert" URL for a
 * dispatch. Returns `undefined` when the key has no slug registered or
 * SESSION_SECRET is missing — the dispatcher treats that as "skip the
 * link" rather than "abort the email", so a misconfigured env can't
 * silently swallow an alert.
 */
function buildEventMuteUrl(key: string, userId: number, orgId: number): string | undefined {
  const slug = eventMuteSlugForKey(key);
  if (!slug) return undefined;
  try {
    const token = signEventMuteToken(userId, slug, orgId);
    return `${publicBaseUrlForMuteLink()}/api/public/notification-event-mute?token=${encodeURIComponent(token)}`;
  } catch (err) {
    logger.warn({ key, userId, orgId, err }, "[notify-dispatch] could not sign event-mute token; skipping footer link");
    return undefined;
  }
}

async function loadPrefs(
  userIds: number[],
  notificationKey: string,
): Promise<{ prefs: Map<number, UserPref>; addr: Map<number, UserAddr>; perKey: Map<number, "realtime" | "digest"> }> {
  const prefs = new Map<number, UserPref>();
  const addr = new Map<number, UserAddr>();
  const perKey = new Map<number, "realtime" | "digest">();
  for (const uid of userIds) {
    prefs.set(uid, { userId: uid, preferEmail: true, preferPush: true, digestMode: false, email: null, eventOptIn: true });
    addr.set(uid, { email: null, name: null, lang: null, organizationId: null });
  }
  if (userIds.length === 0) return { prefs, addr, perKey };
  // Task #1429 — when the dispatched key has a per-event opt-out column
  // mapped, pull it in the same select so we don't issue a second query
  // per dispatch. Unmapped keys default to a constant `true` (always opt-in)
  // so the recipient loop below never short-circuits for them.
  const optOutCol = perEventOptOutColumn(notificationKey);
  const baseSelect = {
    userId: userNotificationPrefsTable.userId,
    preferEmail: userNotificationPrefsTable.preferEmail,
    preferPush: userNotificationPrefsTable.preferPush,
    digestMode: userNotificationPrefsTable.digestMode,
  };
  const selection = optOutCol
    ? { ...baseSelect, eventOptIn: optOutCol }
    : baseSelect;
  const rows = await db.select(selection)
    .from(userNotificationPrefsTable)
    .where(inArray(userNotificationPrefsTable.userId, userIds));
  for (const r of rows) {
    const prev = prefs.get(r.userId);
    if (!prev) continue;
    prev.preferEmail = r.preferEmail;
    prev.preferPush = r.preferPush;
    prev.digestMode = r.digestMode;
    if (optOutCol && "eventOptIn" in r) {
      prev.eventOptIn = (r as { eventOptIn: boolean }).eventOptIn;
    }
  }
  // Task #1170 — per-notification-key delivery mode override. Only loaded
  // for the dispatched key; unset rows fall back to the global digestMode.
  const keyRows = await db.select({
    userId: userNotificationKeyPrefsTable.userId,
    deliveryMode: userNotificationKeyPrefsTable.deliveryMode,
  }).from(userNotificationKeyPrefsTable)
    .where(and(
      inArray(userNotificationKeyPrefsTable.userId, userIds),
      eq(userNotificationKeyPrefsTable.notificationKey, notificationKey),
    ));
  for (const r of keyRows) {
    if (r.deliveryMode === "realtime" || r.deliveryMode === "digest") {
      perKey.set(r.userId, r.deliveryMode);
    }
  }
  const addrRows = await db.select({
    id: appUsersTable.id,
    email: appUsersTable.email,
    displayName: appUsersTable.displayName,
    preferredLanguage: appUsersTable.preferredLanguage,
    // Task #2019 — pull the recipient's organisation in the same
    // SELECT so the email leg can stamp it into the CTA tracking
    // token + per-(key, org) send counter without a second round-trip.
    organizationId: appUsersTable.organizationId,
  }).from(appUsersTable).where(inArray(appUsersTable.id, userIds));
  for (const a of addrRows) {
    addr.set(a.id, {
      email: a.email ?? null,
      name: a.displayName ?? null,
      lang: a.preferredLanguage ?? null,
      organizationId: a.organizationId ?? null,
    });
  }
  return { prefs, addr, perKey };
}

async function audit(key: string, userId: number | null, channel: DispatchChannel, status: string, reason: string | undefined, payload: Record<string, unknown>): Promise<void> {
  try {
    await db.insert(notificationAuditLogTable).values({
      notificationKey: key,
      userId,
      channel,
      status,
      reason: reason ?? null,
      payload,
    });
  } catch (err) {
    logger.warn({ key, userId, channel, err }, "[notify-dispatch] audit insert failed");
  }
}

export async function dispatchNotification(
  key: string,
  userIds: number[],
  payload: DispatchPayload,
  opts?: { sendEmail?: (userId: number, subject: string, html: string, text?: string) => Promise<boolean> },
): Promise<DispatchResult> {
  assertRegistered(key);
  const spec = await loadSpec(key);
  const { prefs, addr, perKey } = await loadPrefs(userIds, key);
  const result: DispatchResult = { key, digestable: spec.digestable, recipients: [] };

  // Task #1171 — render the branded email template once per dispatch
  // (when one is registered for this key). The renderer is pure and
  // deterministic for a given payload, so all recipients share the same
  // subject / html / text. If the caller provides their own
  // `emailHtml` / `emailSubject`, those win over the template.
  // Task #1358 — the shared render uses no recipient-specific data, so
  // it stays in the template's default language (English). Each
  // recipient gets a re-render below in their own `preferredLanguage`.
  const branded = renderNotificationEmail(key, {
    title: payload.title,
    body: payload.body,
    branding: payload.branding,
    data: payload.data ?? {},
  });
  const finalEmailHtml = payload.emailHtml ?? branded?.html;
  const finalEmailText = payload.emailText ?? branded?.text ?? payload.body;
  const finalEmailSubject = payload.emailSubject ?? branded?.subject ?? payload.title;

  // Partition users into "send now" vs "enqueue digest".
  const pushTargets: number[] = [];
  const emailTargets: number[] = [];
  const digestTargets: number[] = [];
  const skipped: { uid: number; reason: string }[] = [];
  // Task #1429 — per-event opt-out short-circuits before the digest
  // partition so an admin who silenced the alert doesn't get it queued
  // into their daily summary either, mirroring `coachPayoutAccountChangeNotify`.
  // Tracked separately from `skipped` so the per-user result loop below
  // can stamp `event_opted_out` (rather than `all_channels_opted_out`)
  // and force an audit row even for keys whose spec sets
  // `auditRequired = false`.
  const eventOptedOut: number[] = [];

  for (const uid of userIds) {
    const p = prefs.get(uid)!;
    // Task #1429 — per-event opt-out wins over both digest mode and the
    // per-event push/email path. Recipient is recorded audit-only with
    // reason `event_opted_out`, matching Task #1224's behaviour.
    if (!p.eventOptIn) {
      eventOptedOut.push(uid);
      continue;
    }
    // Task #1170 — per-key delivery preference overrides the global
    // digestMode flag for digestable keys. `perKey` is only populated for
    // digestable keys; non-digestable keys ignore the override entirely
    // since they always send immediately.
    if (spec.digestable) {
      const override = perKey.get(uid);
      const wantsDigest = override ? override === "digest" : p.digestMode;
      if (wantsDigest) {
        digestTargets.push(uid);
        continue;
      }
    }
    let any = false;
    if (spec.defaultChannels.includes("push") && p.preferPush) {
      pushTargets.push(uid); any = true;
    }
    if (spec.defaultChannels.includes("email") && p.preferEmail && finalEmailHtml) {
      emailTargets.push(uid); any = true;
    }
    if (!any) skipped.push({ uid, reason: "all_channels_opted_out" });
  }

  // Enqueue digest rows.
  if (digestTargets.length > 0) {
    try {
      await db.insert(notificationDigestQueueTable).values(digestTargets.map(uid => ({
        userId: uid,
        notificationKey: key,
        title: payload.title,
        body: payload.body,
        data: payload.data ?? {},
      })));
    } catch (err) {
      logger.warn({ key, err }, "[notify-dispatch] digest enqueue failed");
    }
  }

  // Push delivery — issued per-user so each recipient's status is
  // accurate (rather than a misleading aggregate over the whole batch).
  // Task #1240 — `classifyPushDelivery` is the canonical top-level status:
  //   "sent"       → push delivered to ≥1 device (channel "sent").
  //   "failed"     → real provider/HTTP error (channel "failed").
  //   "no_address" → recipient has no Expo tokens, or every token was
  //                  non-Expo / invalid. This is benign and MUST NOT be
  //                  reported as a failure (the bug Task #1070 fixed).
  // The finer-grained `subReason` (no_device_token vs no_valid_device_token
  // vs push_provider_failed) is preserved only as audit metadata layered
  // on top of the canonical classifier — it never overrides the status.
  const pushStatus = new Map<number, { status: PushDeliveryStatus | "threw"; subReason?: string }>();
  for (const uid of pushTargets) {
    try {
      const r: PushDeliveryResult = await sendPushToUsers([uid], payload.title, payload.body, payload.data);
      const status = classifyPushDelivery(r);
      let subReason: string | undefined;
      if (status === "no_address") {
        subReason = r.invalid > 0 ? "no_valid_device_token" : "no_device_token";
      } else if (status === "failed") {
        subReason = "push_provider_failed";
      }
      pushStatus.set(uid, { status, subReason });
    } catch (err) {
      logger.warn({ key, uid, err }, "[notify-dispatch] push delivery threw");
      pushStatus.set(uid, { status: "threw", subReason: "push_threw" });
    }
  }

  // Email delivery — when the caller did not provide a custom template
  // callback we fall back to the shared `sendNotificationEmail` mailer
  // so every dispatch site actually sends mail, not just the ones with
  // bespoke templates.
  const emailStatus = new Map<number, { sent: boolean; reason?: string }>();
  // Task #1734 — when the dispatch key has a per-event mute slug
  // registered AND the caller passed `eventMuteOrgId`, mint a
  // per-recipient HMAC-signed unsubscribe URL so the email leg can
  // surface a one-click "Mute this alert" footer link + RFC 2369 /
  // 8058 List-Unsubscribe headers. Skipped silently when either
  // condition is unmet so callers that don't opt in are unaffected.
  const eventMuteSlug = eventMuteSlugForKey(key);
  const eventMuteEnabled = eventMuteSlug !== undefined && payload.eventMuteOrgId !== undefined;
  if (emailTargets.length > 0 && finalEmailHtml) {
    for (const uid of emailTargets) {
      const userAddr = addr.get(uid);
      // Task #1622 — bind the recipient's user id into the CTA wrapping
      // hook so each rendered email's CTA href routes through our click
      // tracker. We re-create this per-recipient (rather than once per
      // dispatch) so the token carries the correct `uid`.
      // Task #2019 — pass the recipient's organisation through to the
      // tracking token so the click row + send counter can be sliced
      // per-club in the admin CTR report.
      const recipientOrgId = userAddr?.organizationId ?? null;
      const wrapCtaHref = (k: string, href: string): string => wrapCtaUrl(k, uid, recipientOrgId, href);
      const muteUrl = eventMuteEnabled
        ? buildEventMuteUrl(key, uid, payload.eventMuteOrgId!)
        : undefined;
      if (opts?.sendEmail) {
        // Mirror the per-recipient personalisation that the default
        // mailer path uses below: when a branded template produced our
        // shared render and the caller did not provide their own
        // `payload.emailHtml`, re-render with this recipient's name so
        // the greeting reads "Hi <Name>" instead of "Hi there" in the
        // custom-callback path. Falls back to the shared render if the
        // template lookup fails for any reason.
        let cbSubject = finalEmailSubject;
        let cbHtml = finalEmailHtml;
        let cbText = finalEmailText;
        if (branded && !payload.emailHtml) {
          const personalised = renderNotificationEmail(key, {
            title: payload.title,
            body: payload.body,
            branding: payload.branding,
            data: payload.data ?? {},
            recipientName: userAddr?.name,
            recipientLang: userAddr?.lang,
            wrapCtaHref,
          });
          if (personalised) {
            cbSubject = personalised.subject;
            cbHtml = personalised.html;
            cbText = personalised.text;
          }
        }
        try {
          const ok = await opts.sendEmail(uid, cbSubject, cbHtml, cbText);
          emailStatus.set(uid, ok ? { sent: true } : { sent: false, reason: "email_send_failed" });
          // Task #1622 — only count successful sends in the CTR denominator.
          // Task #2019 — count under the recipient's organisation so each
          // club has its own CTR denominator.
          if (ok) await recordCtaSend(key, recipientOrgId);
        } catch (err) {
          logger.warn({ key, uid, err }, "[notify-dispatch] email send threw");
          emailStatus.set(uid, { sent: false, reason: "email_send_threw" });
        }
        continue;
      }
      if (!userAddr?.email) {
        emailStatus.set(uid, { sent: false, reason: "no_email_on_file" });
        continue;
      }
      try {
        // Branded templates already include the full club-branded shell
        // (header, footer, notification key). When a branded template
        // produced our `finalEmailHtml`, send it raw. Otherwise pass it
        // through `sendNotificationEmail`'s generic wrapper so callers
        // who supplied a snippet still get a branded shell around it.
        if (branded && !payload.emailHtml) {
          // Re-render with the per-recipient name so each greeting is
          // personalised even though the rest of the layout is shared.
          const personalised = renderNotificationEmail(key, {
            title: payload.title,
            body: payload.body,
            branding: payload.branding,
            data: payload.data ?? {},
            recipientName: userAddr.name,
            recipientLang: userAddr.lang,
            wrapCtaHref,
          });
          const html = personalised?.html ?? finalEmailHtml;
          const subject = personalised?.subject ?? finalEmailSubject;
          const text = personalised?.text ?? finalEmailText;
          await sendNotificationEmail({
            to: userAddr.email,
            name: userAddr.name,
            subject,
            html,
            text,
            notificationKey: key,
            preRendered: true,
            unsubscribeUrl: muteUrl,
          });
        } else {
          await sendNotificationEmail({
            to: userAddr.email,
            name: userAddr.name,
            subject: finalEmailSubject,
            html: finalEmailHtml,
            text: finalEmailText,
            notificationKey: key,
            unsubscribeUrl: muteUrl,
          });
        }
        emailStatus.set(uid, { sent: true });
        // Task #1622 — only count successful sends in the CTR denominator.
        // Task #2019 — count under the recipient's organisation so each
        // club has its own CTR denominator.
        await recordCtaSend(key, recipientOrgId);
      } catch (err) {
        logger.warn({ key, uid, err }, "[notify-dispatch] default email send failed");
        emailStatus.set(uid, { sent: false, reason: "email_send_failed" });
      }
    }
  }

  // Build per-user results + write audit rows.
  for (const uid of userIds) {
    const channels: DispatchPerUserResult["channels"] = [];
    // Task #1429 — audit-only short-circuit for per-event opt-out.
    // Recorded as a single `skipped` channel with reason `event_opted_out`,
    // and the audit row is forced (even on keys with auditRequired=false)
    // so administrators can prove the alert was suppressed by user choice.
    const isEventOptedOut = eventOptedOut.includes(uid);
    if (isEventOptedOut) {
      channels.push({ channel: "skipped", status: "skipped", reason: "event_opted_out" });
    } else if (digestTargets.includes(uid)) {
      channels.push({ channel: "digest", status: "queued" });
    } else {
      if (pushTargets.includes(uid)) {
        const ps = pushStatus.get(uid);
        // Task #1240 — canonical mapping derived from `classifyPushDelivery`:
        //   "sent"       → channel sent
        //   "failed" / "threw" → channel failed (real provider/IO problem)
        //   "no_address" → channel skipped (benign: nothing to deliver to)
        let chStatus: "sent" | "skipped" | "failed";
        let chReason: string | undefined;
        switch (ps?.status) {
          case "sent":
            chStatus = "sent";
            break;
          case "no_address":
            chStatus = "skipped";
            chReason = ps.subReason ?? "no_address";
            break;
          case "failed":
          case "threw":
            chStatus = "failed";
            chReason = ps.subReason ?? "push_delivery_failed";
            break;
          default:
            chStatus = "failed";
            chReason = "push_delivery_failed";
        }
        channels.push({ channel: "push", status: chStatus, reason: chReason });
      }
      if (emailTargets.includes(uid)) {
        const es = emailStatus.get(uid);
        channels.push({ channel: "email", status: es?.sent ? "sent" : "failed", reason: es?.sent ? undefined : (es?.reason ?? "email_skipped") });
      }
      if (channels.length === 0) {
        const sk = skipped.find(s => s.uid === uid);
        channels.push({ channel: "skipped", status: "skipped", reason: sk?.reason ?? "no_channels_selected" });
      }
    }
    result.recipients.push({ userId: uid, channels });

    // Task #1429 — force an audit row for per-event opt-out even on keys
    // whose spec sets `auditRequired = false`, so the dispatch trail
    // explains why a recipient received nothing. Other recipients still
    // only get audited when the spec opts in.
    if (spec.auditRequired || isEventOptedOut) {
      for (const c of channels) {
        await audit(key, uid, c.channel, c.status, c.reason, payload.data ?? {});
      }
    }
  }

  return result;
}

/**
 * Render a sample notification for the admin preview UI. Returns the
 * title/body/HTML the dispatcher *would* produce for a key, given a
 * canned set of placeholder values. Doesn't dispatch anything.
 *
 * Task #1648 — When the key has a branded renderer registered in
 * `notificationEmailTemplates.ts`, the preview now re-renders that
 * branded template through `renderNotificationEmail()` using the
 * caller-supplied language so admins can sanity-check translations
 * before a real player receives one. Unsupported / missing language
 * codes fall back to English via `resolveNotificationEmailLang()`.
 *
 * Keys WITHOUT a branded renderer keep the simple generic English
 * wrapper (one-liner body + HTML envelope) — there is nothing to
 * translate, and the language picker has no effect for them.
 *
 * The response always reports the resolved `lang`, the full list of
 * `availableLanguages`, and a `branded` flag so the admin UI can show
 * the picker only where it actually changes the output.
 */
export interface NotificationPreview {
  key: string;
  category: string;
  description: string;
  digestable: boolean;
  defaultChannels: string[];
  auditRequired: boolean;
  /** Whether the sample was produced by a branded i18n renderer
   *  (Task #1171) rather than the generic English wrapper. The admin
   *  UI hides the language picker when this is `false` because the
   *  fallback envelope has no per-language strings. */
  branded: boolean;
  /** Language used to render the sample. Always one of
   *  `availableLanguages`; unsupported / null inputs resolve to `"en"`. */
  lang: NotificationEmailLang;
  /** All languages with copy bundles registered for branded renderers,
   *  in the order they should appear in the picker. */
  availableLanguages: NotificationEmailLang[];
  /**
   * Task #2051 — Whether the rendered sample is the language pack
   * authored for `lang` (`"native"`) or the English fallback that
   * `getNotificationEmailBundle()` substitutes when no per-language
   * pack exists (`"fallback"`).
   *
   * `"native"` for English (the canonical source) and for any non-
   * English language with an entry in the canonical translation
   * registry (`KEY_BUNDLES[key][lang]`), even if that entry only
   * overrides a subset of fields. `"fallback"` when the requested
   * language has no pack at all — i.e. what the admin is staring at
   * is the English copy with a non-English label slapped on it.
   *
   * Always `"native"` for non-branded keys (the generic English
   * wrapper has no per-language strings to fall back from in the
   * first place — admins can't ship an "untranslated email" via that
   * path).
   */
  translationStatus: "native" | "fallback";
  sample: { title: string; body: string; html: string };
}

export async function previewNotificationTemplate(
  key: string,
  lang?: string | null,
): Promise<NotificationPreview | null> {
  const [row] = await db.select().from(notificationTypeRegistryTable)
    .where(eq(notificationTypeRegistryTable.key, key))
    .limit(1);
  if (!row) return null;
  const resolvedLang = resolveNotificationEmailLang(lang);
  // Task #2024 — every key registered in `notificationRegistry.ts`
  // SEED_TYPES ships a sibling sample in `notificationSamples.ts` so
  // the preview matches the real wording the dispatcher emits
  // (placeholders like {playerName}, {eventName} substituted with
  // realistic values). Out-of-tree keys registered via `register()`
  // without a sample fall back to the generic title-cased key + the
  // registry description so the dialog is still useful.
  const sample = getNotificationSample(key);
  const fallbackTitle = sample?.title ?? toTitleCase(key);
  const fallbackBody = sample?.body ?? row.description;
  const sampleData = sample?.data ?? {};

  // Task #1648 — prefer the branded renderer so the preview matches
  // what real recipients receive (and re-renders per-language). The
  // renderer is pure / DB-free so this stays cheap.
  const branded = renderNotificationEmail(key, {
    title: fallbackTitle,
    body: fallbackBody,
    data: sampleData,
    recipientLang: resolvedLang,
  });

  if (branded) {
    // Task #2051 — flag fallback renders so the admin preview UI can
    // warn reviewers when the apparently-translated copy they're
    // looking at is actually English. The flag derives from the
    // canonical translation registry (`KEY_BUNDLES`) so it stays
    // accurate as new language packs land — no separate list to keep
    // in sync.
    const translationStatus: "native" | "fallback"
      = hasNotificationEmailTranslation(resolvedLang, key) ? "native" : "fallback";
    return {
      key: row.key,
      category: row.category,
      description: row.description,
      digestable: row.digestable,
      defaultChannels: row.defaultChannels as string[],
      auditRequired: row.auditRequired,
      branded: true,
      lang: resolvedLang,
      availableLanguages: [...NOTIFICATION_EMAIL_LANGS],
      translationStatus,
      sample: {
        title: branded.subject,
        body: branded.text,
        html: branded.html,
      },
    };
  }

  const html = `<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;background:#0a0a0a;color:#fff;padding:24px;">
  <h2 style="margin:0 0 8px;font-size:18px;">${escapeHtml(fallbackTitle)}</h2>
  <p style="color:#9ca3af;line-height:1.5;margin:0 0 16px;">${escapeHtml(fallbackBody)}</p>
  <p style="color:#6b7280;font-size:12px;margin:24px 0 0;">Notification key: <code>${escapeHtml(key)}</code> · Category: ${escapeHtml(row.category)}</p>
</body></html>`;
  return {
    key: row.key,
    category: row.category,
    description: row.description,
    digestable: row.digestable,
    defaultChannels: row.defaultChannels as string[],
    auditRequired: row.auditRequired,
    branded: false,
    lang: resolvedLang,
    availableLanguages: [...NOTIFICATION_EMAIL_LANGS],
    // Task #2051 — non-branded keys have no per-language pack to fall
    // back from, so the generic English wrapper is always considered
    // "native" — there is no untranslated copy hiding here.
    translationStatus: "native",
    sample: { title: fallbackTitle, body: fallbackBody, html },
  };
}

function toTitleCase(key: string): string {
  return key.split(".").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Default retention window for `notification_audit_log` rows.
 *
 * Task #2224 — the audit log is append-only and was never pruned. The
 * `/api/portal/notification-audit` endpoint that surfaces these rows to
 * controllers caps its lookback at 365 days, so anything older than that
 * is never read by the product anyway. Personal data riding inside the
 * `payload` JSON also has to age out alongside the same erasure pipeline
 * this audit log is meant to backstop. The default retention window is
 * therefore 365 days — equal to the endpoint's hard cap so the portal
 * can never query a row that's already gone — and is tunable via the
 * `NOTIFICATION_AUDIT_LOG_RETENTION_DAYS` env var for ops who want to
 * shrink the window without a code change.
 */
export const DEFAULT_NOTIFICATION_AUDIT_LOG_RETENTION_DAYS = 365;

function resolveNotificationAuditRetentionDays(): number {
  const raw = process.env.NOTIFICATION_AUDIT_LOG_RETENTION_DAYS;
  if (!raw) return DEFAULT_NOTIFICATION_AUDIT_LOG_RETENTION_DAYS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(
      { value: raw },
      "[notify-dispatch] Invalid NOTIFICATION_AUDIT_LOG_RETENTION_DAYS; using default",
    );
    return DEFAULT_NOTIFICATION_AUDIT_LOG_RETENTION_DAYS;
  }
  return n;
}

/**
 * Delete `notification_audit_log` rows whose `createdAt` is older than the
 * configured retention window. Returns the number of rows deleted plus the
 * cutoff used so the cron caller can log a single structured summary.
 *
 * Designed to be invoked by the daily cron (see `cron.ts`). The existing
 * `(notificationKey, createdAt)` index makes the WHERE cheap even on a
 * backlog. We don't batch the delete because the expected per-day churn
 * is small (a handful of rows per audited dispatch) and a single DELETE
 * keeps the operation atomic — partial pruning would only confuse the
 * portal endpoint's "everything older than X is gone" invariant.
 *
 * @param retentionDays Optional override (must be > 0). When omitted,
 *   resolves from `NOTIFICATION_AUDIT_LOG_RETENTION_DAYS` env →
 *   {@link DEFAULT_NOTIFICATION_AUDIT_LOG_RETENTION_DAYS}.
 */
export async function pruneNotificationAuditLog(
  retentionDays?: number,
): Promise<{ deleted: number; cutoff: string; retentionDays: number }> {
  const days = typeof retentionDays === "number" && Number.isFinite(retentionDays) && retentionDays > 0
    ? retentionDays
    : resolveNotificationAuditRetentionDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(notificationAuditLogTable)
    .where(lt(notificationAuditLogTable.createdAt, cutoff))
    .returning({ id: notificationAuditLogTable.id });
  if (deleted.length > 0) {
    logger.info(
      { deleted: deleted.length, cutoff: cutoff.toISOString(), retentionDays: days },
      "[notify-dispatch] pruned old notification_audit_log rows",
    );
  }
  return { deleted: deleted.length, cutoff: cutoff.toISOString(), retentionDays: days };
}
