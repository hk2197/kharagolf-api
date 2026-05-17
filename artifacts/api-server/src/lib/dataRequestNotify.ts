/**
 * Privacy/data-request notification helper (Tasks 176, 187).
 *
 * Privacy-request acknowledgement and status notices are mandatory data-protection
 * communications. We:
 *   1. Always create an in-app `member_messages` row so the member sees the notice
 *      in the portal even if their email bounces or they have opted out of email.
 *   2. Attempt the email and capture the delivery outcome on the data-request row.
 *   3. Fan out to push and SMS for members who have opted in (per
 *      `member_comm_prefs`), so a single bounced email never becomes a
 *      regulatory gap. Each channel's status is recorded on the request row.
 */
import {
  db,
  memberMessagesTable,
  memberDataRequestsTable,
  memberCommPrefsTable,
  clubMembersTable,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  notificationAuditLogTable,
  type MemberDataRequest,
} from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomBytes } from "crypto";
import { sendDataRequestEmail, sendDataRequestHandlerAssignedEmail, classifyMailerError, type DataRequestEmailKind, type EmailBranding } from "./mailer";
import { sendTransactionalPush, sendTransactionalSms, sendTransactionalWhatsapp } from "./comms";
import { ObjectStorageService } from "./objectStorage";
import { logger } from "./logger";
import { resolveExportReminderUnsubLang } from "./exportReminderUnsubPageI18n";
import { translateDataExportEmail } from "./dataExportEmailI18n";
import { isEmailSuppressedForOrg, type EmailSuppressionHit } from "./digestRecipientPause.js";

/**
 * Task #1075 — public base URL used to build the one-click "stop reminding
 * me about this download" link embedded in the `completed_export` ready
 * email. Mirrors the precedence used elsewhere (sendBouncedLevyRemindersDigest,
 * etc.) so a single env vars covers all member-facing email links.
 */
function publicAppBaseUrl(): string {
  return (
    process.env.APP_BASE_URL
    ?? process.env.PUBLIC_BASE_URL
    ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`
  );
}

/**
 * Task #1075 — mint (or reuse) the per-request opaque token used in the
 * one-click "stop reminding me about this export" link rendered in the
 * `completed_export` ready email. Persisted on the data-request row so the
 * later `export_expiring` reminder can rebuild the same URL and so the
 * public unsubscribe endpoint can resolve it back to the row.
 */
async function ensureExpiringReminderUnsubToken(
  request: Pick<MemberDataRequest, "id" | "expiringReminderUnsubToken">,
): Promise<string> {
  if (request.expiringReminderUnsubToken) return request.expiringReminderUnsubToken;
  const token = randomBytes(24).toString("hex");
  await db.update(memberDataRequestsTable)
    .set({ expiringReminderUnsubToken: token })
    .where(and(
      eq(memberDataRequestsTable.id, request.id),
      isNull(memberDataRequestsTable.expiringReminderUnsubToken),
    ));
  // Re-read in case a concurrent caller minted the token first — the
  // unique index would otherwise let our local copy go stale.
  const [row] = await db.select({ token: memberDataRequestsTable.expiringReminderUnsubToken })
    .from(memberDataRequestsTable)
    .where(eq(memberDataRequestsTable.id, request.id))
    .limit(1);
  return row?.token ?? token;
}

function buildExpiringReminderUnsubUrl(token: string, lang?: string | null): string {
  // Task #1437 — append a `lang=` hint built from the recipient's preferred
  // language so the public confirmation page renders in the same language
  // as the email the link was clicked from. Only emit a lang param when the
  // code resolves to one of the supported languages; an unknown code is
  // silently dropped so the page falls back to English without a misleading
  // hint in the URL.
  const resolved = lang ? resolveExportReminderUnsubLang(lang) : null;
  const base = `${publicAppBaseUrl().replace(/\/$/, "")}/api/public/data-export-reminder-unsubscribe?token=${encodeURIComponent(token)}`;
  return resolved ? `${base}&lang=${encodeURIComponent(resolved)}` : base;
}

/**
 * Task #1124 — mint (or reuse) the per-request opaque tracking token used
 * to stamp open + click telemetry on the `export_expiring` reminder. Kept
 * deliberately separate from the Task #1075 unsubscribe token so the
 * public open/click endpoints can never be coerced into silencing a
 * member's reminder.
 */
async function ensureExpiringReminderTrackingToken(
  request: Pick<MemberDataRequest, "id" | "expiringReminderTrackingToken">,
): Promise<string> {
  if (request.expiringReminderTrackingToken) return request.expiringReminderTrackingToken;
  const token = randomBytes(24).toString("hex");
  await db.update(memberDataRequestsTable)
    .set({ expiringReminderTrackingToken: token })
    .where(and(
      eq(memberDataRequestsTable.id, request.id),
      isNull(memberDataRequestsTable.expiringReminderTrackingToken),
    ));
  const [row] = await db.select({ token: memberDataRequestsTable.expiringReminderTrackingToken })
    .from(memberDataRequestsTable)
    .where(eq(memberDataRequestsTable.id, request.id))
    .limit(1);
  return row?.token ?? token;
}

function buildExpiringReminderPixelUrl(token: string): string {
  return `${publicAppBaseUrl().replace(/\/$/, "")}/api/public/data-export-reminder-pixel?token=${encodeURIComponent(token)}`;
}

function buildExpiringReminderClickUrl(token: string): string {
  return `${publicAppBaseUrl().replace(/\/$/, "")}/api/public/data-export-reminder-click?token=${encodeURIComponent(token)}`;
}

/**
 * Task #618 — Self-serve data exports persist their archive at an
 * `/objects/...` path that isn't directly clickable. When the
 * `completed_export` notice fires we mint a 7-day signed URL so the
 * member can one-tap download from the email/push without first
 * re-authenticating in the app. 7 days is the GCS signed-URL maximum
 * and it matches the archive's own `DATA_EXPORT_VALID_DAYS` retention.
 */
const COMPLETED_EXPORT_SIGNED_URL_TTL_SEC = 7 * 24 * 60 * 60;

async function mintExportDownloadUrl(artifactPath: string | null | undefined, logContext?: Record<string, unknown>): Promise<string | null> {
  if (!artifactPath || !artifactPath.startsWith("/objects/")) return null;
  try {
    const svc = new ObjectStorageService();
    return await svc.getSignedDownloadUrl(artifactPath, COMPLETED_EXPORT_SIGNED_URL_TTL_SEC);
  } catch (err) {
    logger.warn(
      { ...logContext, errMsg: err instanceof Error ? err.message : String(err) },
      "[data-request-notify] Failed to mint signed export download URL — falling back to in-app download",
    );
    return null;
  }
}

const TYPE_LABELS: Record<string, string> = {
  access: "Access (copy of your data)",
  export: "Data export (portability)",
  portability: "Data portability",
  erasure: "Erasure (right to be forgotten)",
  rectification: "Rectification (correct your data)",
  restrict: "Restriction of processing",
  object: "Objection to processing",
};

function buildSubjectAndBody(
  kind: DataRequestEmailKind,
  request: Pick<MemberDataRequest, "id" | "requestType" | "requestedAt" | "dueBy" | "notes" | "artifactUrl">,
  orgName: string,
  /** Optional pre-minted download URL (e.g. signed object-storage URL) used by `completed_export`. */
  downloadUrl?: string | null,
  /** Task #1075 — optional one-click "stop reminding me" URL embedded in the
   * `completed_export` ready email so members who deliberately let the link
   * expire don't get the 24h-before nudge. */
  unsubUrl?: string | null,
  /** Task #2168 — recipient context used to localise the `completed_export`
   * and `export_expiring` push subject/body and the persisted in-app
   * message body. The other (non-export) kinds remain English-only here
   * — they're sent over channels other than email through this helper
   * but localising those bodies is outside the scope of Task #2168.
   * `lang` falls back to English when missing or unsupported; `memberName`
   * defaults to the same generic salutation the email uses. */
  recipient?: { lang?: string | null; memberName?: string | null } | null,
): { subject: string; body: string } {
  const typeLabel = TYPE_LABELS[request.requestType] ?? request.requestType;
  const ref = `#${request.id}`;
  const dueByStr = request.dueBy
    ? new Date(request.dueBy).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" })
    : null;
  const requestedStr = new Date(request.requestedAt).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });

  switch (kind) {
    case "filed":
      return {
        subject: `Privacy request received — ${orgName} (${ref})`,
        body: [
          `We have received your data-protection request (${typeLabel}) and logged it under reference ${ref}.`,
          `Filed on ${requestedStr}.`,
          dueByStr
            ? `In line with applicable data-protection regulations (GDPR / DPDP), we will respond no later than ${dueByStr}.`
            : `In line with applicable data-protection regulations (GDPR / DPDP), we will respond within 30 days.`,
        ].join("\n\n"),
      };
    case "in_progress":
      return {
        subject: `Privacy request update — in progress (${ref})`,
        body: [
          `Our team has begun working on your data-protection request (${typeLabel}, reference ${ref}).`,
          dueByStr ? `We still aim to complete it by ${dueByStr}.` : `We will be in touch once it is resolved.`,
        ].join("\n\n"),
      };
    case "completed":
      return {
        subject: `Privacy request completed (${ref})`,
        body: [
          `Your data-protection request (${typeLabel}, reference ${ref}) has been resolved.`,
          request.artifactUrl ? `Materials related to your request are available here: ${request.artifactUrl}` : null,
        ].filter(Boolean).join("\n\n"),
      };
    case "completed_export":
    case "export_expiring": {
      // Task #2168 — Localise the push subject/body and the persisted
      // in-app message body so a Hindi/Arabic/etc. recipient gets a
      // notification that matches the language of the email Task #1745
      // already localised. The translation pack is the same one the
      // mailer uses (`translateDataExportEmail`), so the three channels
      // stay phrase-for-phrase aligned. `name` and `orgName` are passed
      // *unescaped* — these strings are persisted as plain text on
      // `member_messages.body` and forwarded as plain text to the push
      // provider; the email path applies its own HTML escaping before
      // rendering.
      const name = recipient?.memberName?.trim() || "there";
      const t = translateDataExportEmail(recipient?.lang ?? null, kind, {
        name,
        orgName,
        ref: request.id,
      });
      const linkParagraph = downloadUrl
        ? `${t.bodyWithLinkLead}\n${downloadUrl}`
        : t.bodyNoLink;
      let optOutParagraph: string | null = null;
      if (unsubUrl) {
        // Stitch the localised opt-out sentence back together. For the
        // ready notice the pack carries an `optOutLead` preamble + a
        // trailing fragment ("if you'd rather skip it."); the reminder
        // pack omits both (just the linkText). Mirrors the email's
        // `${lead}<a>linkText</a>${trailing}` rendering, only flattened
        // to plain text with the URL on its own line.
        const lead = t.optOutLead ? `${t.optOutLead} ` : "";
        const trailing = t.optOutTrailing ? ` ${t.optOutTrailing}` : "";
        optOutParagraph = `${lead}${t.optOutLinkText}${trailing}\n${unsubUrl}`;
      }
      return {
        subject: t.subject,
        body: [t.intro, linkParagraph, optOutParagraph].filter(Boolean).join("\n\n"),
      };
    }
    case "rejected":
      return {
        subject: `Privacy request — outcome (${ref})`,
        body: [
          `After review we are unable to fulfil your data-protection request (${typeLabel}, reference ${ref}) as submitted.`,
          request.notes ? `Reason from our team:\n${request.notes}` : `Please reply to this notice or contact your club administrator if you would like to discuss the decision or appeal it.`,
        ].join("\n\n"),
      };
  }
}

/** Per-channel delivery outcome. */
export type ChannelStatus =
  | "sent"
  | "failed"
  | "no_address" // missing email/phone on the member record
  | "no_user"    // member is not linked to an app user (no push token possible)
  | "opted_out"  // member has not opted in to this channel in member_comm_prefs
  | "skipped";

export interface NotifyDataRequestResult {
  inAppMessageId: number | null;
  emailStatus: ChannelStatus;
  emailError?: string;
  pushStatus: ChannelStatus;
  pushError?: string;
  smsStatus: ChannelStatus;
  smsError?: string;
  whatsappStatus: ChannelStatus;
  whatsappError?: string;
}

/**
 * Privacy notices are mandatory regulatory communications, but the additional
 * push/SMS fan-out is governed by the member's dedicated `privacy` category in
 * `member_comm_prefs` (Task 190). Members can explicitly opt in or out of push
 * and SMS for privacy notices without affecting their other category prefs.
 *
 * If the member has no `privacy` row yet we fall back to the schema defaults
 * (push on, SMS off) so existing members continue to receive push by default
 * and admins are not surprised by silent regressions when this category is
 * first introduced.
 *
 * The in-app message and email are always sent regardless of this preference
 * (see notifyDataRequest below) — those are the regulatory floor.
 */
async function loadOptIns(clubMemberId: number): Promise<{ push: boolean; sms: boolean; whatsapp: boolean; hasRows: boolean }> {
  const rows = await db.select({
    pushEnabled: memberCommPrefsTable.pushEnabled,
    smsEnabled: memberCommPrefsTable.smsEnabled,
    whatsappEnabled: memberCommPrefsTable.whatsappEnabled,
  }).from(memberCommPrefsTable).where(and(
    eq(memberCommPrefsTable.clubMemberId, clubMemberId),
    eq(memberCommPrefsTable.category, "privacy"),
  )).limit(1);

  if (rows.length === 0) {
    return { push: true, sms: false, whatsapp: false, hasRows: false };
  }
  return {
    push: Boolean(rows[0].pushEnabled),
    sms: Boolean(rows[0].smsEnabled),
    whatsapp: Boolean(rows[0].whatsappEnabled),
    hasRows: true,
  };
}

/**
 * Task #2168 — Best-effort lookup of an app user's `preferredLanguage`,
 * shared by `notifyDataRequest` and the per-channel retry helpers so the
 * Hindi/Arabic/etc. recipient sees the same language across the email,
 * the in-app message, the push notification, the SMS, and the WhatsApp
 * for the data-export `completed_export` / `export_expiring` kinds.
 *
 * Returns `null` when the lookup fails (which the translation helper
 * then resolves as English) so a transient DB hiccup never blocks the
 * regulatory-bound notification.
 */
async function loadRecipientPreferredLanguage(
  userId: number,
  logContext?: Record<string, unknown>,
): Promise<string | null> {
  try {
    const [u] = await db
      .select({ preferredLanguage: appUsersTable.preferredLanguage })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, userId))
      .limit(1);
    return u?.preferredLanguage ?? null;
  } catch (langErr) {
    logger.warn(
      { ...logContext, errMsg: langErr instanceof Error ? langErr.message : String(langErr) },
      "[data-request-notify] preferred-language lookup failed — defaulting to English",
    );
    return null;
  }
}

/**
 * Send a privacy-request notification across the in-app channel (always),
 * email (best-effort), and push + SMS for opted-in members. Updates the
 * request row with per-channel delivery telemetry.
 */
export async function notifyDataRequest(opts: {
  organizationId: number;
  request: MemberDataRequest;
  kind: DataRequestEmailKind;
  /** Optional sender for the in-app message (admin/staff or system). */
  senderUserId?: number | null;
  logContext?: Record<string, unknown>;
}): Promise<NotifyDataRequestResult> {
  const { organizationId, request, kind, senderUserId, logContext } = opts;

  const [member] = await db.select({
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    email: clubMembersTable.email,
    phone: clubMembersTable.phone,
    userId: clubMembersTable.userId,
  }).from(clubMembersTable).where(eq(clubMembersTable.id, request.clubMemberId)).limit(1);

  const [org] = await db.select({
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
  }).from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);

  const orgName = org?.name ?? "KHARAGOLF";
  const memberName = member ? `${member.firstName} ${member.lastName}`.trim() : "there";
  const branding: EmailBranding = { orgName, logoUrl: org?.logoUrl ?? undefined, primaryColor: org?.primaryColor ?? undefined };

  // Task #618: for the self-serve data export "ready" notice we mint a
  // 7-day signed object-storage URL so the email + push CTA is one-tap.
  // The signed URL is also passed through to the email template so it
  // replaces the unclickable `/objects/...` artifactUrl.
  const exportDownloadUrl = (kind === "completed_export" || kind === "export_expiring")
    ? await mintExportDownloadUrl(request.artifactUrl, { ...logContext, requestId: request.id })
    : null;

  // Task #1437 — look up the recipient's preferred language so the public
  // unsubscribe confirmation page matches the language of the email the
  // link came from. Task #2168 then reuses the same value to localise
  // the push subject/body and the persisted in-app message body.
  // Lookup is best-effort: if the member isn't linked to an app user
  // (or the lookup fails), the URL omits the lang hint and the in-app
  // / push fall back to English.
  const recipientLang = (kind === "completed_export" || kind === "export_expiring") && member?.userId
    ? await loadRecipientPreferredLanguage(member.userId, { ...logContext, requestId: request.id })
    : null;

  // Task #1075 — for the ready notice and the follow-up reminder, mint (or
  // reuse) the per-request opt-out token so the email body can carry a
  // one-click "stop reminding me about this download" link.
  let expiringReminderUnsubUrl: string | null = null;
  if (kind === "completed_export" || kind === "export_expiring") {
    try {
      const token = await ensureExpiringReminderUnsubToken(request);
      // Task #1437 — carry the recipient's preferred language as a `lang=`
      // hint so the public confirmation page renders in their language.
      expiringReminderUnsubUrl = buildExpiringReminderUnsubUrl(token, recipientLang);
    } catch (err) {
      logger.warn(
        { ...logContext, requestId: request.id, errMsg: err instanceof Error ? err.message : String(err) },
        "[data-request-notify] Failed to mint expiring-reminder unsub token — falling back to no opt-out link",
      );
    }
  }

  // Task #1124 — for the `export_expiring` reminder specifically, mint the
  // open/click telemetry token and build the pixel + click-tracking URLs.
  // The cron only fires this notice once per request, so we reset any
  // previously-stamped opens/clicks back to NULL to keep the per-request
  // counters in sync with the most recent notice.
  let expiringReminderPixelUrl: string | null = null;
  let expiringReminderClickRedirectUrl: string | null = null;
  if (kind === "export_expiring") {
    try {
      const token = await ensureExpiringReminderTrackingToken(request);
      expiringReminderPixelUrl = buildExpiringReminderPixelUrl(token);
      expiringReminderClickRedirectUrl = buildExpiringReminderClickUrl(token);
      await db.update(memberDataRequestsTable)
        .set({
          expiringReminderEmailOpenedAt: null,
          expiringReminderEmailClickedAt: null,
        })
        .where(eq(memberDataRequestsTable.id, request.id));
    } catch (err) {
      logger.warn(
        { ...logContext, requestId: request.id, errMsg: err instanceof Error ? err.message : String(err) },
        "[data-request-notify] Failed to mint expiring-reminder tracking token — falling back to no open/click telemetry",
      );
    }
  }

  const { subject, body } = buildSubjectAndBody(
    kind,
    request,
    orgName,
    exportDownloadUrl,
    expiringReminderUnsubUrl,
    // Task #2168 — flow the recipient's preferred language and display
    // name through so the persisted in-app `member_messages` row and the
    // push subject/body for `completed_export` / `export_expiring`
    // render in the same language as the email Task #1745 already
    // localised. `recipientLang` is only populated for the export-related
    // kinds; the helper falls back to English for all other kinds.
    { lang: recipientLang, memberName },
  );

  // 1) Always persist an in-app message — mandatory privacy notice fallback.
  const [msgRow] = await db.insert(memberMessagesTable).values({
    organizationId,
    clubMemberId: request.clubMemberId,
    senderUserId: senderUserId ?? null,
    channel: "in_app",
    subject,
    body,
    status: "sent",
  }).returning({ id: memberMessagesTable.id });
  const inAppMessageId = msgRow?.id ?? null;
  const inAppAt = new Date();

  // 2) Best-effort email.
  const recipient = member?.email ?? null;
  let emailStatus: ChannelStatus;
  let emailError: string | undefined;
  let emailAt: Date | null = null;
  // Track the classified provider error so the persist block can short-circuit
  // straight to "exhausted" on a hard SMTP bounce, instead of consuming all 5
  // retries and flooding internal logs with re-bounces (Task #1279).
  let emailErrorClass: ReturnType<typeof classifyMailerError> | null = null;
  // Task #2230 — Suppression pre-check. When the recipient address is on the
  // org's `email_suppressions` list (any reason: hard_bounce, complaint,
  // unsubscribed, etc.) we skip the SMTP attempt entirely. The address is
  // known-bad org-wide and a fresh first-attempt bounce would burn one of
  // the per-row retry slots, generate a re-bounce in our logs, and trigger
  // an admin exhaustion alert that can never resolve from the alert itself.
  // The skip is recorded as a terminal `skipped` row (matching the
  // `provider_unconfigured` short-circuit) so the cron does not re-pick it.
  let emailSuppressionHit: EmailSuppressionHit | null = null;
  if (recipient) {
    emailSuppressionHit = await isEmailSuppressedForOrg({
      organizationId,
      email: recipient,
      logScope: "data-request-notify",
    });
  }

  if (!recipient) {
    emailStatus = "no_address";
    logger.warn({ ...logContext, requestId: request.id }, "[data-request-notify] No email on file; in-app message only");
  } else if (emailSuppressionHit) {
    // Task #2230 — known-bad address; skip the SMTP attempt outright. We
    // still stamp `lastEmailAt` so the resend-history popover can show
    // *when* the system decided not to attempt this notice. `emailAttempts`
    // stays at 0 so the suppression is visibly distinct from a regular
    // first-attempt failure (which would record attempts=1).
    emailStatus = "skipped";
    emailError = `address_suppressed:${emailSuppressionHit.reason}`;
    emailAt = new Date();
    logger.info(
      {
        ...logContext,
        requestId: request.id,
        suppressionReason: emailSuppressionHit.reason,
        bounceType: emailSuppressionHit.bounceType,
      },
      "[data-request-notify] recipient address is on the org suppression list; skipping email send",
    );
  } else {
    try {
      await sendDataRequestEmail({
        to: recipient,
        memberName,
        kind,
        requestType: request.requestType,
        requestId: request.id,
        requestedAt: request.requestedAt,
        dueBy: request.dueBy,
        notes: request.notes,
        // For completed_export, swap in the signed one-tap download URL.
        // For other kinds we keep the historical artifactUrl pass-through.
        // Task #1124 — for `export_expiring` we wrap the download CTA in
        // the click-tracking redirect so taps stamp `expiringReminderEmail
        // ClickedAt` before bouncing the member to the freshly re-minted
        // signed download URL.
        artifactUrl: kind === "export_expiring"
          ? (expiringReminderClickRedirectUrl ?? exportDownloadUrl)
          : (kind === "completed_export" ? exportDownloadUrl : request.artifactUrl),
        // Task #1075 — render the one-click "stop reminding me" link.
        unsubUrl: expiringReminderUnsubUrl,
        // Task #1124 — render the 1x1 open-tracking pixel.
        trackingPixelUrl: expiringReminderPixelUrl,
        // Task #1745 — flow the recipient's preferred language to the
        // mailer so the `completed_export` ready email and the
        // `export_expiring` reminder render in the same language as the
        // public confirmation page their unsub link lands on.
        lang: recipientLang,
        branding,
      });
      emailStatus = "sent";
      emailAt = new Date();
    } catch (err) {
      // Classify once: `provider_unconfigured` (Task #1502) is terminal
      // `skipped`; everything else marks the row `failed` so the cron
      // re-attempts on the bounded schedule. Surface `emailErrorClass`
      // to the persist block so a hard SMTP bounce (Task #1279) can
      // short-circuit straight to exhausted instead of consuming the
      // remaining 4 retries.
      const errClass = classifyMailerError(err);
      if (errClass === "provider_unconfigured") {
        emailStatus = "skipped";
        emailError = "provider_not_configured";
      } else {
        emailStatus = "failed";
        emailError = err instanceof Error ? err.message : String(err);
        emailErrorClass = errClass;
        logger.error({ ...logContext, requestId: request.id, errMsg: emailError, errClass }, "[data-request-notify] Failed to send email");
      }
      emailAt = new Date();
    }
  }

  // 3) Push and SMS fan-out for opted-in members.
  const optIns = member ? await loadOptIns(request.clubMemberId) : { push: false, sms: false, whatsapp: false, hasRows: false };

  // -- Push --
  let pushStatus: ChannelStatus = "skipped";
  let pushError: string | undefined;
  let pushAt: Date | null = null;

  if (!member?.userId) {
    pushStatus = "no_user";
  } else if (!optIns.push) {
    pushStatus = "opted_out";
  } else {
    try {
      const result = await sendTransactionalPush(
        [member.userId],
        subject,
        // Push body limit is generally short; trim to 200 chars.
        body.length > 200 ? body.slice(0, 197) + "..." : body,
        {
          type: "data_request",
          requestId: request.id,
          kind,
          // Task #618: include the one-tap download URL in the push payload
          // so the mobile app can route members straight to the download
          // when they tap the "Your data export is ready" notification.
          ...(exportDownloadUrl ? { downloadUrl: exportDownloadUrl } : {}),
        },
      );
      if (result.sent > 0) {
        pushStatus = "sent";
      } else if (result.attempted === 0 || result.invalid === result.attempted) {
        // No registered devices for this user, or all tokens invalid.
        pushStatus = "no_address";
      } else {
        pushStatus = "failed";
        pushError = "push_delivery_failed";
      }
      pushAt = new Date();
    } catch (err) {
      pushStatus = "failed";
      pushError = err instanceof Error ? err.message : String(err);
      pushAt = new Date();
      logger.error({ ...logContext, requestId: request.id, errMsg: pushError }, "[data-request-notify] Failed to send push");
    }
  }

  // -- SMS --
  let smsStatus: ChannelStatus = "skipped";
  let smsError: string | undefined;
  let smsAt: Date | null = null;

  if (!optIns.sms) {
    smsStatus = "opted_out";
  } else if (!member?.phone) {
    smsStatus = "no_address";
  } else {
    try {
      // Subject + body keeps the notice useful even when the SMS is split across segments.
      const smsBody = `${subject}\n${body}`.slice(0, 480);
      await sendTransactionalSms(member.phone, smsBody);
      smsStatus = "sent";
      smsAt = new Date();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If the SMS provider isn't configured, mark as skipped rather than failed
      // so admins aren't alarmed in environments without an SMS provider.
      if (/SMS_PROVIDER not configured/i.test(msg)) {
        smsStatus = "skipped";
        smsError = "provider_not_configured";
      } else {
        smsStatus = "failed";
        smsError = msg;
        logger.error({ ...logContext, requestId: request.id, errMsg: msg }, "[data-request-notify] Failed to send SMS");
      }
      smsAt = new Date();
    }
  }

  // -- WhatsApp --
  // Task 297: WhatsApp is the most reliable contact channel for many Indian
  // members. Honour the dedicated `privacy.whatsapp_enabled` opt-in and skip
  // gracefully when the WHATSAPP_PROVIDER env isn't set so admins aren't
  // alarmed in environments without a WhatsApp provider.
  let whatsappStatus: ChannelStatus = "skipped";
  let whatsappError: string | undefined;
  let whatsappAt: Date | null = null;
  let whatsappMessageId: string | null = null;

  if (!optIns.whatsapp) {
    whatsappStatus = "opted_out";
  } else if (!member?.phone) {
    whatsappStatus = "no_address";
  } else {
    try {
      const waBody = `${subject}\n${body}`.slice(0, 1500);
      whatsappMessageId = await sendTransactionalWhatsapp(member.phone, waBody);
      whatsappStatus = "sent";
      whatsappAt = new Date();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/WHATSAPP_PROVIDER not configured/i.test(msg)) {
        whatsappStatus = "skipped";
        whatsappError = "provider_not_configured";
      } else {
        whatsappStatus = "failed";
        whatsappError = msg;
        logger.error({ ...logContext, requestId: request.id, errMsg: msg }, "[data-request-notify] Failed to send WhatsApp");
      }
      whatsappAt = new Date();
    }
  }

  // 4) Persist delivery telemetry on the request row.
  // Reset attempt counters on each fresh notification: the retry cron only
  // re-attempts the *current* notice, not historical ones. If push/SMS was
  // actually attempted (sent or failed) we record attempt #1; the retry
  // counters on the row track subsequent re-attempts performed by the cron.
  const pushAttempted = pushStatus === "sent" || pushStatus === "failed";
  const smsAttempted = smsStatus === "sent" || smsStatus === "failed";
  const emailAttempted = emailStatus === "sent" || emailStatus === "failed";
  const whatsappAttempted = whatsappStatus === "sent" || whatsappStatus === "failed";
  // Task #1279 — hard SMTP bounce on the first attempt must NOT consume the
  // 5-retry budget: jump straight to exhausted so the cron stops re-firing
  // this row and the admin gets a single regulatory alert below. The
  // address can never accept the message — re-trying just floods our
  // internal logs with re-bounces.
  const emailExhaustedNow = emailStatus === "failed" && emailErrorClass === "hard_bounce";
  const persistedEmailAttempts = emailAttempted
    ? (emailExhaustedNow ? DATA_REQUEST_MAX_EMAIL_ATTEMPTS : 1)
    : 0;
  const now = new Date();
  await db.update(memberDataRequestsTable).set({
    lastNotificationKind: kind,
    lastNotifiedAt: inAppAt,
    lastEmailStatus: emailStatus,
    lastEmailAt: emailAt,
    lastEmailError: emailError ?? null,
    lastInAppMessageId: inAppMessageId,
    lastInAppAt: inAppAt,
    lastPushStatus: pushStatus,
    lastPushAt: pushAt,
    lastPushError: pushError ?? null,
    lastSmsStatus: smsStatus,
    lastSmsAt: smsAt,
    lastSmsError: smsError ?? null,
    lastWhatsappStatus: whatsappStatus,
    lastWhatsappAt: whatsappAt,
    lastWhatsappError: whatsappError ?? null,
    // Task 347: persist provider message id so async delivery webhooks can
    // map status callbacks back to this notice. Reset to null on every
    // fresh notification so a stale id from a prior notice can't get its
    // delivery callback applied to the wrong notification.
    lastWhatsappMessageId: whatsappMessageId,
    pushAttempts: pushAttempted ? 1 : 0,
    smsAttempts: smsAttempted ? 1 : 0,
    emailAttempts: persistedEmailAttempts,
    whatsappAttempts: whatsappAttempted ? 1 : 0,
    lastPushRetryAt: null,
    lastSmsRetryAt: null,
    lastEmailRetryAt: null,
    lastWhatsappRetryAt: null,
    pushRetryExhaustedAt: null,
    smsRetryExhaustedAt: null,
    emailRetryExhaustedAt: emailExhaustedNow ? now : null,
    whatsappRetryExhaustedAt: null,
    // Task 238 / Task 261 / Task 297: a fresh notification resets the retry
    // and dedup state so a future exhaustion of *this* notice can re-alert
    // admins on each channel independently.
    emailExhaustionNotifiedAt: null,
    pushExhaustionNotifiedAt: null,
    smsExhaustionNotifiedAt: null,
    whatsappExhaustionNotifiedAt: null,
  }).where(eq(memberDataRequestsTable.id, request.id));

  // Task #1279 — page admins once on a first-attempt hard-bounce
  // exhaustion. The helper itself dedups via `emailExhaustionNotifiedAt`,
  // which we just reset above so this exhaustion alerts cleanly.
  if (emailExhaustedNow) {
    try {
      const [reloaded] = await db.select()
        .from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.id, request.id))
        .limit(1);
      if (reloaded) {
        await notifyAdminsOfRetryExhaustion({
          channel: "email",
          request: reloaded,
          logContext: { ...logContext, source: "notifyMember", reason: "hard_bounce" },
        });
      }
    } catch (err) {
      logger.warn(
        { ...logContext, requestId: request.id, errMsg: err instanceof Error ? err.message : String(err) },
        "[data-request-notify] Admin hard-bounce alert dispatch failed",
      );
    }
  }

  // Task #2230 — Persist a `notification_audit_log` skip row when the email
  // was suppressed up-front. Mirrors the shape the dispatcher writes for
  // `event_opted_out` skips (Task #1224 / #1775) so the controller-facing
  // "Suppressed notifications" portal page can surface this skip alongside
  // user-mute skips. We classify with a non-`event_opted_out` reason so the
  // /api/portal/notification-audit endpoint tags it as `system_suppressed`.
  if (emailSuppressionHit && emailStatus === "skipped") {
    await writeDataRequestSuppressionAudit({
      kind,
      request,
      member,
      hit: emailSuppressionHit,
      logContext,
    });
  }

  return {
    inAppMessageId,
    emailStatus,
    emailError,
    pushStatus,
    pushError,
    smsStatus,
    smsError,
    whatsappStatus,
    whatsappError,
  };
}

/**
 * Task #2230 — Write a single `notification_audit_log` row capturing a
 * suppression-driven email skip. Best-effort: an audit-write failure must
 * not surface as a notification-pipeline failure (the `lastEmailStatus`
 * column on the request row is the source of truth for retry decisions).
 *
 * The row shape matches what the standard dispatcher writes for
 * `event_opted_out` skips so the controller-facing "Suppressed
 * notifications" portal page (Task #1775) can render both kinds uniformly.
 * `userId` is set when we have a linked app user — anonymous member
 * requests get a row with `userId = null` (the table allows null) so the
 * controller-side query naturally excludes them, while back-office tools
 * can still see them via the notification key.
 */
async function writeDataRequestSuppressionAudit(opts: {
  kind: DataRequestEmailKind;
  request: MemberDataRequest;
  member: { userId: number | null; email: string | null } | null;
  hit: EmailSuppressionHit;
  logContext?: Record<string, unknown>;
}): Promise<void> {
  const { kind, request, member, hit, logContext } = opts;
  try {
    await db.insert(notificationAuditLogTable).values({
      notificationKey: `privacy.data_request.${kind}`,
      userId: member?.userId ?? null,
      channel: "email",
      status: "skipped",
      reason: `address_suppressed:${hit.reason}`,
      payload: {
        requestId: request.id,
        requestType: request.requestType,
        kind,
        suppressionReason: hit.reason,
        bounceType: hit.bounceType,
        description: hit.description,
        // Surface the obfuscated address (local-part suffix only) so
        // controllers can recognise "yes, that's the bouncing address" from
        // the portal without leaking the full email into a long-lived audit
        // payload.
        emailSuffix: maskEmailForAudit(member?.email ?? null),
      },
    });
  } catch (err) {
    logger.warn(
      {
        ...logContext,
        requestId: request.id,
        errMsg: err instanceof Error ? err.message : String(err),
      },
      "[data-request-notify] Failed to persist suppression audit row; the skip is still recorded on the request row",
    );
  }
}

/**
 * Mask an email for inclusion in a long-lived audit payload. Returns a
 * shape like `j***@example.com` so a controller can recognise the address
 * without the audit row accidentally becoming a directory of bouncing
 * addresses for any insider with read access to the audit table.
 */
function maskEmailForAudit(email: string | null): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!local || !domain) return null;
  const head = local.slice(0, 1);
  return `${head}***@${domain}`.toLowerCase();
}

/**
 * Maximum delivery attempts per channel for a single notification (initial
 * attempt + retries). Once a channel reaches this cap the cron stops
 * re-attempting that channel and stamps `*RetryExhaustedAt` on the row.
 */
export const DATA_REQUEST_MAX_PUSH_ATTEMPTS = 5;
export const DATA_REQUEST_MAX_SMS_ATTEMPTS = 5;
export const DATA_REQUEST_MAX_EMAIL_ATTEMPTS = 5;
// Task #296: per-surface cap for the WhatsApp channel. The WhatsApp fan-out
// itself (and its retry helper) is added by the privacy-notices surface task
// — this constant is exported here in the foundation task so all surfaces
// can compile against the shared cap pattern without further coordination.
export const DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS = 5;

export interface RetryChannelResult {
  channel: "push" | "sms" | "email" | "whatsapp";
  status: ChannelStatus;
  error?: string;
  attempts: number;
  exhausted: boolean;
}

/**
 * Re-attempt a previously failed push delivery for a single privacy-request
 * notice. Looks up the member, rebuilds the notification body for the stored
 * `lastNotificationKind`, fires push, and updates the request row with the
 * new status/attempt count. Returns `null` if the row is no longer eligible
 * for retry (e.g. status is no longer `failed`, the cap has already been
 * reached, or the member has since been deleted).
 */
export async function retryDataRequestPush(opts: {
  request: MemberDataRequest;
  logContext?: Record<string, unknown>;
}): Promise<RetryChannelResult | null> {
  const { request, logContext } = opts;

  if (request.lastPushStatus !== "failed") return null;
  const currentAttempts = request.pushAttempts ?? 0;
  if (currentAttempts >= DATA_REQUEST_MAX_PUSH_ATTEMPTS) return null;
  const kind = (request.lastNotificationKind as DataRequestEmailKind | null) ?? "filed";

  const [member] = await db.select({
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    userId: clubMembersTable.userId,
  }).from(clubMembersTable).where(eq(clubMembersTable.id, request.clubMemberId)).limit(1);

  const [org] = await db.select({ name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, request.organizationId)).limit(1);
  const orgName = org?.name ?? "KHARAGOLF";

  // Task #618: re-mint the signed download URL for export-ready retries so
  // the deep link in the retried push payload stays one-tap clickable.
  const exportDownloadUrl = (kind === "completed_export" || kind === "export_expiring")
    ? await mintExportDownloadUrl(request.artifactUrl, { ...logContext, requestId: request.id, retry: true })
    : null;

  // Task #2168 — for the export-related kinds, look up the recipient's
  // preferred language so the retried push subject/body renders in the
  // same language as the first-attempt push (and the email Task #1745
  // already localised). Best-effort: missing user link or DB error
  // falls back to English. Other (non-export) kinds keep the English
  // copy already produced by `buildSubjectAndBody`.
  const memberName = member ? `${member.firstName} ${member.lastName}`.trim() : "there";
  const recipientLang = (kind === "completed_export" || kind === "export_expiring") && member?.userId
    ? await loadRecipientPreferredLanguage(member.userId, { ...logContext, requestId: request.id, retry: "push" })
    : null;

  const { subject, body } = buildSubjectAndBody(
    kind,
    request,
    orgName,
    exportDownloadUrl,
    null,
    { lang: recipientLang, memberName },
  );

  const nextAttempts = currentAttempts + 1;
  const now = new Date();
  let status: ChannelStatus;
  let error: string | undefined;

  if (!member?.userId) {
    status = "no_user";
  } else {
    try {
      const result = await sendTransactionalPush(
        [member.userId],
        subject,
        body.length > 200 ? body.slice(0, 197) + "..." : body,
        {
          type: "data_request",
          requestId: request.id,
          kind,
          retry: true,
          ...(exportDownloadUrl ? { downloadUrl: exportDownloadUrl } : {}),
        },
      );
      if (result.sent > 0) {
        status = "sent";
      } else if (result.attempted === 0 || result.invalid === result.attempted) {
        status = "no_address";
      } else {
        status = "failed";
        error = "push_delivery_failed";
      }
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
      logger.error({ ...logContext, requestId: request.id, attempt: nextAttempts, errMsg: error }, "[data-request-notify] Push retry failed");
    }
  }

  const exhausted = status === "failed" && nextAttempts >= DATA_REQUEST_MAX_PUSH_ATTEMPTS;
  await db.update(memberDataRequestsTable).set({
    lastPushStatus: status,
    lastPushAt: now,
    lastPushError: error ?? null,
    pushAttempts: nextAttempts,
    lastPushRetryAt: now,
    pushRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(memberDataRequestsTable.id, request.id));

  return { channel: "push", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Re-attempt a previously failed SMS delivery for a single privacy-request
 * notice. Mirrors {@link retryDataRequestPush}; returns `null` when the row
 * is no longer eligible for retry.
 */
export async function retryDataRequestSms(opts: {
  request: MemberDataRequest;
  logContext?: Record<string, unknown>;
}): Promise<RetryChannelResult | null> {
  const { request, logContext } = opts;

  if (request.lastSmsStatus !== "failed") return null;
  const currentAttempts = request.smsAttempts ?? 0;
  if (currentAttempts >= DATA_REQUEST_MAX_SMS_ATTEMPTS) return null;
  const kind = (request.lastNotificationKind as DataRequestEmailKind | null) ?? "filed";

  const [member] = await db.select({
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    userId: clubMembersTable.userId,
    phone: clubMembersTable.phone,
  }).from(clubMembersTable).where(eq(clubMembersTable.id, request.clubMemberId)).limit(1);

  const [org] = await db.select({ name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, request.organizationId)).limit(1);
  const orgName = org?.name ?? "KHARAGOLF";

  // Task #2168 — localise the SMS body for the export-related kinds so
  // the retry matches the language of the first-attempt SMS (and the
  // localised email/in-app/push the rest of the fan-out already produces).
  const memberName = member ? `${member.firstName} ${member.lastName}`.trim() : "there";
  const recipientLang = (kind === "completed_export" || kind === "export_expiring") && member?.userId
    ? await loadRecipientPreferredLanguage(member.userId, { ...logContext, requestId: request.id, retry: "sms" })
    : null;

  const { subject, body } = buildSubjectAndBody(
    kind,
    request,
    orgName,
    null,
    null,
    { lang: recipientLang, memberName },
  );

  const nextAttempts = currentAttempts + 1;
  const now = new Date();
  let status: ChannelStatus;
  let error: string | undefined;

  if (!member?.phone) {
    status = "no_address";
  } else {
    try {
      const smsBody = `${subject}\n${body}`.slice(0, 480);
      await sendTransactionalSms(member.phone, smsBody);
      status = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/SMS_PROVIDER not configured/i.test(msg)) {
        // Provider unconfigured — flip status to `skipped` (terminal,
        // non-failed) so the cron stops re-selecting this row every 15 min.
        // An admin can resend manually once the provider is configured.
        const nowSkip = new Date();
        await db.update(memberDataRequestsTable).set({
          lastSmsStatus: "skipped",
          lastSmsAt: nowSkip,
          lastSmsError: "provider_not_configured",
          lastSmsRetryAt: nowSkip,
        }).where(eq(memberDataRequestsTable.id, request.id));
        return { channel: "sms", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      logger.error({ ...logContext, requestId: request.id, attempt: nextAttempts, errMsg: msg }, "[data-request-notify] SMS retry failed");
    }
  }

  const exhausted = status === "failed" && nextAttempts >= DATA_REQUEST_MAX_SMS_ATTEMPTS;
  await db.update(memberDataRequestsTable).set({
    lastSmsStatus: status,
    lastSmsAt: now,
    lastSmsError: error ?? null,
    smsAttempts: nextAttempts,
    lastSmsRetryAt: now,
    smsRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(memberDataRequestsTable.id, request.id));

  return { channel: "sms", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Re-attempt a previously failed email delivery for a single privacy-request
 * notice. Mirrors {@link retryDataRequestPush}; returns `null` when the row
 * is no longer eligible for retry (status is not `failed`, the cap has been
 * reached, or the member has since been deleted).
 *
 * Email is the primary regulatory channel, so a transient mail-provider
 * bounce should not become a regulatory gap. The retry cron uses this on a
 * bounded schedule until either the email succeeds or the per-request cap
 * (`DATA_REQUEST_MAX_EMAIL_ATTEMPTS`) is reached.
 */
export async function retryDataRequestEmail(opts: {
  request: MemberDataRequest;
  logContext?: Record<string, unknown>;
}): Promise<RetryChannelResult | null> {
  const { request, logContext } = opts;

  if (request.lastEmailStatus !== "failed") return null;
  const currentAttempts = request.emailAttempts ?? 0;
  if (currentAttempts >= DATA_REQUEST_MAX_EMAIL_ATTEMPTS) return null;
  const kind = (request.lastNotificationKind as DataRequestEmailKind | null) ?? "filed";

  const [member] = await db.select({
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    email: clubMembersTable.email,
    userId: clubMembersTable.userId,
  }).from(clubMembersTable).where(eq(clubMembersTable.id, request.clubMemberId)).limit(1);

  const [org] = await db.select({
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
  }).from(organizationsTable).where(eq(organizationsTable.id, request.organizationId)).limit(1);
  const orgName = org?.name ?? "KHARAGOLF";
  const branding: EmailBranding = { orgName, logoUrl: org?.logoUrl ?? undefined, primaryColor: org?.primaryColor ?? undefined };
  const memberName = member ? `${member.firstName} ${member.lastName}`.trim() : "there";

  const nextAttempts = currentAttempts + 1;
  const now = new Date();
  let status: ChannelStatus;
  let error: string | undefined;

  // Task #618: re-mint the signed download URL for export-ready retries so
  // the email link stays one-tap clickable instead of falling back to the
  // unclickable internal `/objects/...` path.
  const exportDownloadUrl = (kind === "completed_export" || kind === "export_expiring")
    ? await mintExportDownloadUrl(request.artifactUrl, { ...logContext, requestId: request.id, retry: true })
    : null;

  // Task #1437 / #1745 — for the export-related kinds, look up the
  // recipient's preferred language so the retry both:
  //   1. embeds the matching `lang=` hint in the unsubscribe URL (the
  //      first-attempt behaviour), and
  //   2. translates the email subject + body itself (Task #1745).
  // Best-effort: a missing user link or DB error falls back to English.
  let recipientLang: string | null = null;
  if ((kind === "completed_export" || kind === "export_expiring") && member?.userId) {
    try {
      const [u] = await db
        .select({ preferredLanguage: appUsersTable.preferredLanguage })
        .from(appUsersTable)
        .where(eq(appUsersTable.id, member.userId))
        .limit(1);
      recipientLang = u?.preferredLanguage ?? null;
    } catch (langErr) {
      logger.warn(
        { ...logContext, requestId: request.id, errMsg: langErr instanceof Error ? langErr.message : String(langErr) },
        "[data-request-notify] preferred-language lookup failed on retry — defaulting to English",
      );
    }
  }

  // Task #1075 — re-render the per-request opt-out link on retries.
  const expiringReminderUnsubUrl = (kind === "completed_export" || kind === "export_expiring") && request.expiringReminderUnsubToken
    ? buildExpiringReminderUnsubUrl(request.expiringReminderUnsubToken, recipientLang)
    : null;

  // Task #2230 — Suppression pre-check on retry. If the recipient address
  // landed on the org suppression list since the previous attempt (e.g. the
  // first attempt soft-bounced and a subsequent send hard-bounced under a
  // different request, surfacing the address via the bounce webhook), we
  // skip this retry and stamp the row as terminal so the cron stops
  // re-picking it. Without this, every 15-minute cron tick would keep
  // re-burning the SMTP attempt against an address we already know is bad
  // org-wide.
  if (member?.email) {
    const retrySuppressionHit = await isEmailSuppressedForOrg({
      organizationId: request.organizationId,
      email: member.email,
      logScope: "data-request-retry",
    });
    if (retrySuppressionHit) {
      const suppressedError = `address_suppressed:${retrySuppressionHit.reason}`;
      // Stamp `emailRetryExhaustedAt` so the cron treats this row as
      // terminal in the same way it treats hard-bounce exhaustion. We do
      // NOT increment `emailAttempts`: the suppression skip is a routing
      // decision, not a delivery attempt, so the count stays at the
      // previous value (matching the `provider_unconfigured` precedent
      // immediately below in the catch block).
      await db.update(memberDataRequestsTable).set({
        lastEmailStatus: "skipped",
        lastEmailAt: now,
        lastEmailError: suppressedError,
        lastEmailRetryAt: now,
        emailRetryExhaustedAt: now,
      }).where(eq(memberDataRequestsTable.id, request.id));
      await writeDataRequestSuppressionAudit({
        kind,
        request,
        member,
        hit: retrySuppressionHit,
        logContext: { ...logContext, source: "retryDataRequestEmail" },
      });
      logger.info(
        {
          ...logContext,
          requestId: request.id,
          attempt: nextAttempts,
          suppressionReason: retrySuppressionHit.reason,
          bounceType: retrySuppressionHit.bounceType,
        },
        "[data-request-notify] retry skipped — recipient address is on the org suppression list",
      );
      return {
        channel: "email",
        status: "skipped",
        error: suppressedError,
        attempts: currentAttempts,
        exhausted: false,
      };
    }
  }

  // Task #1279 — track whether the latest provider error is a hard SMTP
  // bounce so we can short-circuit straight to exhausted instead of
  // consuming the rest of the budget.
  let hardBounce = false;
  if (!member?.email) {
    status = "no_address";
  } else {
    try {
      await sendDataRequestEmail({
        to: member.email,
        memberName,
        kind,
        requestType: request.requestType,
        requestId: request.id,
        requestedAt: request.requestedAt,
        dueBy: request.dueBy,
        notes: request.notes,
        artifactUrl: (kind === "completed_export" || kind === "export_expiring") ? exportDownloadUrl : request.artifactUrl,
        unsubUrl: expiringReminderUnsubUrl,
        // Task #1745 — translate the retried email body into the
        // recipient's preferred language, matching the first-attempt
        // behaviour (`notifyDataRequest` above).
        lang: recipientLang,
        branding,
      });
      status = "sent";
    } catch (err) {
      // Provider misconfiguration → terminal `skipped` so the cron
      // stops re-selecting this row and the per-channel exhaustion
      // alert never fires for an env issue admins can't action from
      // the alert itself. Don't increment attempts: it's not a
      // delivery failure, it's an environment issue.
      if (classifyMailerError(err) === "provider_unconfigured") {
        await db.update(memberDataRequestsTable).set({
          lastEmailStatus: "skipped",
          lastEmailAt: now,
          lastEmailError: "provider_not_configured",
          lastEmailRetryAt: now,
        }).where(eq(memberDataRequestsTable.id, request.id));
        return { channel: "email", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
      const errClass = classifyMailerError(err);
      if (errClass === "hard_bounce") {
        hardBounce = true;
      }
      logger.error({ ...logContext, requestId: request.id, attempt: nextAttempts, errMsg: error, errClass }, "[data-request-notify] Email retry failed");
    }
  }

  // Task #1279 — a hard SMTP bounce flips the row to exhausted on this very
  // attempt, regardless of how many slots remain in the budget; the address
  // can never accept the message so re-trying just floods our internal logs.
  const exhausted = status === "failed" && (hardBounce || nextAttempts >= DATA_REQUEST_MAX_EMAIL_ATTEMPTS);
  const persistedAttempts = exhausted && hardBounce
    ? DATA_REQUEST_MAX_EMAIL_ATTEMPTS
    : nextAttempts;
  await db.update(memberDataRequestsTable).set({
    lastEmailStatus: status,
    lastEmailAt: now,
    lastEmailError: error ?? null,
    emailAttempts: persistedAttempts,
    lastEmailRetryAt: now,
    emailRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(memberDataRequestsTable.id, request.id));

  return { channel: "email", status, error, attempts: persistedAttempts, exhausted };
}

/**
 * Task 297 — Re-attempt a previously failed WhatsApp delivery for a single
 * privacy-request notice. Mirrors {@link retryDataRequestSms}; returns
 * `null` when the row is no longer eligible for retry. Treats a missing
 * WHATSAPP_PROVIDER as a terminal `skipped` outcome so the cron stops
 * picking the row up every 15 minutes in environments with no provider.
 */
export async function retryDataRequestWhatsapp(opts: {
  request: MemberDataRequest;
  logContext?: Record<string, unknown>;
}): Promise<RetryChannelResult | null> {
  const { request, logContext } = opts;

  if (request.lastWhatsappStatus !== "failed") return null;
  const currentAttempts = request.whatsappAttempts ?? 0;
  if (currentAttempts >= DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS) return null;
  const kind = (request.lastNotificationKind as DataRequestEmailKind | null) ?? "filed";

  const [member] = await db.select({
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    userId: clubMembersTable.userId,
    phone: clubMembersTable.phone,
  }).from(clubMembersTable).where(eq(clubMembersTable.id, request.clubMemberId)).limit(1);

  const [org] = await db.select({ name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, request.organizationId)).limit(1);
  const orgName = org?.name ?? "KHARAGOLF";

  // Task #2168 — localise the WhatsApp body for the export-related kinds
  // so the retry matches the language of the first-attempt WhatsApp.
  const memberName = member ? `${member.firstName} ${member.lastName}`.trim() : "there";
  const recipientLang = (kind === "completed_export" || kind === "export_expiring") && member?.userId
    ? await loadRecipientPreferredLanguage(member.userId, { ...logContext, requestId: request.id, retry: "whatsapp" })
    : null;

  const { subject, body } = buildSubjectAndBody(
    kind,
    request,
    orgName,
    null,
    null,
    { lang: recipientLang, memberName },
  );

  const nextAttempts = currentAttempts + 1;
  const now = new Date();
  let status: ChannelStatus;
  let error: string | undefined;
  let messageId: string | null = null;

  if (!member?.phone) {
    status = "no_address";
  } else {
    try {
      const waBody = `${subject}\n${body}`.slice(0, 1500);
      messageId = await sendTransactionalWhatsapp(member.phone, waBody);
      status = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/WHATSAPP_PROVIDER not configured/i.test(msg)) {
        const nowSkip = new Date();
        await db.update(memberDataRequestsTable).set({
          lastWhatsappStatus: "skipped",
          lastWhatsappAt: nowSkip,
          lastWhatsappError: "provider_not_configured",
          lastWhatsappRetryAt: nowSkip,
        }).where(eq(memberDataRequestsTable.id, request.id));
        return { channel: "whatsapp", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      logger.error({ ...logContext, requestId: request.id, attempt: nextAttempts, errMsg: msg }, "[data-request-notify] WhatsApp retry failed");
    }
  }

  const exhausted = status === "failed" && nextAttempts >= DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS;
  await db.update(memberDataRequestsTable).set({
    lastWhatsappStatus: status,
    lastWhatsappAt: now,
    lastWhatsappError: error ?? null,
    // Task 347: refresh provider message id on every retry so a delivery
    // webhook can map a status callback to the most recent send. Clear it
    // on failed sends so a stale id from a prior attempt isn't applied.
    lastWhatsappMessageId: status === "sent" ? messageId : null,
    whatsappAttempts: nextAttempts,
    lastWhatsappRetryAt: now,
    whatsappRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(memberDataRequestsTable.id, request.id));

  return { channel: "whatsapp", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Task 238 / Task 261 / Task 297 — Notify org admins when a privacy-notice
 * retry on any single channel (email, push, SMS or WhatsApp) gives up.
 *
 * Privacy notices are mandatory regulatory comms. Once the bounded retry
 * cap for a channel is hit, admins must take a manual action (post a copy,
 * phone the member, etc.) before the regulatory deadline. We surface this
 * proactively per channel via:
 *   1. A push to all org admins (and the assigned handler) so the failure
 *      doesn't sit unnoticed until someone happens to open Member 360.
 *   2. An in-app message attached to the affected member's record (visible
 *      on the Member 360 timeline) that links back to the privacy request
 *      so admins can jump straight to the failed notice.
 *
 * De-duplication: stamps the matching `*ExhaustionNotifiedAt` column on
 * the request row. If it's already set we no-op so the same exhaustion
 * isn't announced twice across cron passes. The stamps are reset to NULL
 * whenever a fresh `notifyDataRequest` is sent (see step 4 of
 * `notifyDataRequest`), so a future exhaustion of *this* notice can
 * re-alert admins on each channel independently.
 */
type RetryExhaustionChannel = "email" | "push" | "sms" | "whatsapp";

interface ChannelAlertConfig {
  cap: number;
  /** Column to flip for atomic dedup. */
  stampColumn:
    | typeof memberDataRequestsTable.emailExhaustionNotifiedAt
    | typeof memberDataRequestsTable.pushExhaustionNotifiedAt
    | typeof memberDataRequestsTable.smsExhaustionNotifiedAt
    | typeof memberDataRequestsTable.whatsappExhaustionNotifiedAt;
  channelLabel: string; // "email" / "push" / "SMS" — used in subject/body
  contactKind: string;  // "Email" / "Push" / "SMS" — capitalised for headings
  relatedEntity: string; // member_messages.related_entity tag
  pushNotifType: string; // push payload `type`
  pushTitle: (ref: string) => string;
  lastErrorOf: (req: MemberDataRequest) => string | null | undefined;
  /** What to display as the recipient address line. */
  addressOf: (member: { email: string | null; phone: string | null } | null) => string;
}

const CHANNEL_ALERT_CONFIG: Record<RetryExhaustionChannel, ChannelAlertConfig> = {
  email: {
    cap: DATA_REQUEST_MAX_EMAIL_ATTEMPTS,
    stampColumn: memberDataRequestsTable.emailExhaustionNotifiedAt,
    channelLabel: "email",
    contactKind: "Email",
    relatedEntity: "data_request_email_exhausted",
    pushNotifType: "data_request_email_exhausted",
    pushTitle: (ref) => `⚠️ Privacy email retries exhausted (${ref})`,
    lastErrorOf: (r) => r.lastEmailError,
    addressOf: (m) => m?.email ?? "(no email on file)",
  },
  push: {
    cap: DATA_REQUEST_MAX_PUSH_ATTEMPTS,
    stampColumn: memberDataRequestsTable.pushExhaustionNotifiedAt,
    channelLabel: "push notification",
    contactKind: "Push",
    relatedEntity: "data_request_push_exhausted",
    pushNotifType: "data_request_push_exhausted",
    pushTitle: (ref) => `⚠️ Privacy push retries exhausted (${ref})`,
    lastErrorOf: (r) => r.lastPushError,
    addressOf: () => "(member's registered devices)",
  },
  sms: {
    cap: DATA_REQUEST_MAX_SMS_ATTEMPTS,
    stampColumn: memberDataRequestsTable.smsExhaustionNotifiedAt,
    channelLabel: "SMS",
    contactKind: "SMS",
    relatedEntity: "data_request_sms_exhausted",
    pushNotifType: "data_request_sms_exhausted",
    pushTitle: (ref) => `⚠️ Privacy SMS retries exhausted (${ref})`,
    lastErrorOf: (r) => r.lastSmsError,
    addressOf: (m) => m?.phone ?? "(no phone on file)",
  },
  whatsapp: {
    cap: DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS,
    stampColumn: memberDataRequestsTable.whatsappExhaustionNotifiedAt,
    channelLabel: "WhatsApp",
    contactKind: "WhatsApp",
    relatedEntity: "data_request_whatsapp_exhausted",
    pushNotifType: "data_request_whatsapp_exhausted",
    pushTitle: (ref) => `⚠️ Privacy WhatsApp retries exhausted (${ref})`,
    lastErrorOf: (r) => r.lastWhatsappError,
    addressOf: (m) => m?.phone ?? "(no phone on file)",
  },
};

export async function notifyAdminsOfRetryExhaustion(opts: {
  channel: RetryExhaustionChannel;
  request: MemberDataRequest;
  logContext?: Record<string, unknown>;
}): Promise<{ notified: boolean; recipients: number }> {
  const { channel, request, logContext } = opts;
  const cfg = CHANNEL_ALERT_CONFIG[channel];

  const [member] = await db.select({
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    email: clubMembersTable.email,
    phone: clubMembersTable.phone,
  }).from(clubMembersTable).where(eq(clubMembersTable.id, request.clubMemberId)).limit(1);

  const memberName = member ? `${member.firstName} ${member.lastName}`.trim() : `member #${request.clubMemberId}`;
  const ref = `#${request.id}`;
  const typeLabel = TYPE_LABELS[request.requestType] ?? request.requestType;
  const dueByStr = request.dueBy
    ? new Date(request.dueBy).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" })
    : null;

  const subject = `Privacy ${cfg.channelLabel} delivery failed — ${memberName} (${ref})`;
  const body = [
    `The system has stopped retrying the privacy notice ${cfg.channelLabel} for ${memberName}'s ${typeLabel} request (${ref}) after ${cfg.cap} failed attempts.`,
    `Last delivery error: ${cfg.lastErrorOf(request) ?? "unknown"}.`,
    `${cfg.contactKind} address on file: ${cfg.addressOf(member ?? null)}.`,
    dueByStr
      ? `This notice is regulated and must be resolved by ${dueByStr}. Please contact the member through another channel (post, phone, in person) before the deadline.`
      : `Please contact the member through another channel (post, phone, in person) before the regulatory deadline.`,
    `Open the request in Member 360 to record what action you took.`,
  ].join("\n\n");

  // 1) Atomic dedup + in-app message: stamp the per-channel `*ExhaustionNotifiedAt`
  //    (only if still NULL) and insert the in-app message in the same
  //    transaction. Stamping in the same UPDATE prevents two concurrent
  //    cron passes from both winning; doing it transactionally with the
  //    insert prevents a partial failure (stamp succeeds, insert throws)
  //    from suppressing the alert forever.
  const winner = await db.transaction(async (tx) => {
    const stamped = await tx.update(memberDataRequestsTable)
      .set({ [channel === "email" ? "emailExhaustionNotifiedAt" : channel === "push" ? "pushExhaustionNotifiedAt" : channel === "sms" ? "smsExhaustionNotifiedAt" : "whatsappExhaustionNotifiedAt"]: new Date() })
      .where(and(
        eq(memberDataRequestsTable.id, request.id),
        isNull(cfg.stampColumn),
      ))
      .returning({ id: memberDataRequestsTable.id });
    if (stamped.length === 0) return false;
    await tx.insert(memberMessagesTable).values({
      organizationId: request.organizationId,
      clubMemberId: request.clubMemberId,
      senderUserId: null,
      channel: "in_app",
      subject,
      body,
      status: "sent",
      relatedEntity: cfg.relatedEntity,
      relatedEntityId: request.id,
    });
    return true;
  });

  if (!winner) {
    return { notified: false, recipients: 0 };
  }

  // 2) Push to org admins (direct app_users.role='org_admin' for this org +
  //    org_memberships admin/secretary roles), plus the assigned handler if
  //    they're not already in that set.
  const directAdmins = await db
    .select({ userId: appUsersTable.id })
    .from(appUsersTable)
    .where(and(eq(appUsersTable.organizationId, request.organizationId), eq(appUsersTable.role, "org_admin")));
  const memberAdmins = await db
    .select({ userId: appUsersTable.id })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
    .where(and(
      eq(orgMembershipsTable.organizationId, request.organizationId),
      inArray(orgMembershipsTable.role, ["org_admin", "competition_secretary"]),
    ));

  const userIds = new Set<number>();
  for (const a of directAdmins) userIds.add(a.userId);
  for (const a of memberAdmins) userIds.add(a.userId);
  if (request.handlerUserId) userIds.add(request.handlerUserId);

  const recipients = [...userIds];
  if (recipients.length > 0) {
    try {
      await sendTransactionalPush(
        recipients,
        cfg.pushTitle(ref),
        `${cfg.contactKind} to ${memberName} permanently failed. Manual follow-up required before the regulatory deadline.`,
        { type: cfg.pushNotifType, requestId: request.id, clubMemberId: request.clubMemberId },
      );
    } catch (err) {
      logger.warn(
        { ...logContext, requestId: request.id, channel, errMsg: err instanceof Error ? err.message : String(err) },
        "[data-request-notify] Admin exhaustion push failed",
      );
    }
  }

  logger.info(
    { ...logContext, requestId: request.id, channel, recipients: recipients.length },
    `[data-request-notify] Admins alerted: ${channel} retry exhausted`,
  );

  return { notified: true, recipients: recipients.length };
}

/**
 * Task 249 — Notify a staff member when a privacy request is assigned to them.
 *
 * A newly-assigned handler has no way of knowing about the assignment until
 * they happen to refresh the dashboard. Mirroring the member-facing privacy
 * notice plumbing, we:
 *   1. Persist an in-app message on the affected member's record (channel
 *      `in_app`, related entity `data_request_handler_assigned`) so the
 *      assignment is visible on the Member 360 timeline as a record of the
 *      notice that was sent.
 *   2. Push to the assigned handler's device(s) with a deep-link payload that
 *      points to the Member 360 Data tab for the request.
 *
 * Caller is responsible for skipping no-op transitions (unassign, no change,
 * self-assignment) — this function will perform the notification whenever
 * invoked. Returns delivery telemetry suitable for an audit-log entry.
 */
export interface NotifyHandlerAssignedResult {
  inAppMessageId: number | null;
  pushStatus: ChannelStatus;
  pushError?: string;
  emailStatus: ChannelStatus;
  emailError?: string;
  emailRecipient?: string | null;
  deepLink: string;
}

export async function notifyHandlerAssigned(opts: {
  request: MemberDataRequest;
  newHandlerUserId: number;
  /** Optional sender — the admin who performed the assignment. */
  senderUserId?: number | null;
  logContext?: Record<string, unknown>;
}): Promise<NotifyHandlerAssignedResult> {
  const { request, newHandlerUserId, senderUserId, logContext } = opts;

  const [member] = await db.select({
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
  }).from(clubMembersTable).where(eq(clubMembersTable.id, request.clubMemberId)).limit(1);

  const [org] = await db.select({
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
  }).from(organizationsTable).where(eq(organizationsTable.id, request.organizationId)).limit(1);

  const [handler] = await db.select({
    email: appUsersTable.email,
    displayName: appUsersTable.displayName,
    username: appUsersTable.username,
  }).from(appUsersTable).where(eq(appUsersTable.id, newHandlerUserId)).limit(1);

  const memberName = member ? `${member.firstName} ${member.lastName}`.trim() : `member #${request.clubMemberId}`;
  const orgName = org?.name ?? "KHARAGOLF";
  const branding: EmailBranding = { orgName, logoUrl: org?.logoUrl ?? undefined, primaryColor: org?.primaryColor ?? undefined };
  const ref = `#${request.id}`;
  const typeLabel = TYPE_LABELS[request.requestType] ?? request.requestType;
  const dueByDate = request.dueBy ? new Date(request.dueBy) : null;
  const dueByStr = dueByDate
    ? dueByDate.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" })
    : null;
  const deepLink = `/member-360/${request.clubMemberId}?tab=data`;
  // Build an absolute deep-link for the email button when we know the public
  // origin. Falls back to a relative path which the email renders as plain
  // text instructions when no origin is configured (e.g. in tests).
  const publicOrigin = process.env.PUBLIC_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null);
  const absoluteDeepLink = publicOrigin ? `${publicOrigin.replace(/\/$/, "")}${deepLink}` : null;

  const subject = `Privacy request assigned to you — ${memberName} (${ref})`;
  const body = [
    `You have been assigned ${memberName}'s ${typeLabel} privacy request (${ref}) at ${orgName}.`,
    dueByStr
      ? `This notice is regulated and must be resolved by ${dueByStr}.`
      : `This notice is regulated; please resolve it before the regulatory deadline.`,
    `Open the request in Member 360 → Data to take action.`,
  ].join("\n\n");

  // 1) In-app message attached to the member's record (mirrors the
  //    member-facing privacy plumbing). Visible on the Member 360 timeline
  //    as proof that the assigned handler was notified.
  let inAppMessageId: number | null = null;
  try {
    const [msgRow] = await db.insert(memberMessagesTable).values({
      organizationId: request.organizationId,
      clubMemberId: request.clubMemberId,
      senderUserId: senderUserId ?? null,
      channel: "in_app",
      subject,
      body,
      status: "sent",
      relatedEntity: "data_request_handler_assigned",
      relatedEntityId: request.id,
    }).returning({ id: memberMessagesTable.id });
    inAppMessageId = msgRow?.id ?? null;
  } catch (err) {
    logger.error(
      { ...logContext, requestId: request.id, errMsg: err instanceof Error ? err.message : String(err) },
      "[data-request-notify] Failed to persist handler-assigned in-app message",
    );
  }

  // 2) Best-effort transactional email so handlers who aren't actively in the
  //    app (or on a registered device) still find out about the assignment in
  //    their inbox. Includes member name, request type, deadline and a deep
  //    link back to the Member 360 Data tab.
  let emailStatus: ChannelStatus;
  let emailError: string | undefined;
  const emailRecipient = handler?.email ?? null;
  if (!emailRecipient) {
    emailStatus = "no_address";
    logger.warn(
      { ...logContext, requestId: request.id, handlerUserId: newHandlerUserId },
      "[data-request-notify] Assigned handler has no email on file; skipping handler-assigned email",
    );
  } else {
    try {
      await sendDataRequestHandlerAssignedEmail({
        to: emailRecipient,
        staffName: handler?.displayName ?? handler?.username ?? "there",
        memberName,
        requestId: request.id,
        requestType: request.requestType,
        dueBy: dueByDate,
        deepLinkUrl: absoluteDeepLink,
        branding,
      });
      emailStatus = "sent";
    } catch (err) {
      // Provider misconfiguration → audit-log `skipped` so handler
      // assignment isn't blocked on (and logged as a delivery failure
      // for) an env issue. Handler still gets the in-app + push.
      if (classifyMailerError(err) === "provider_unconfigured") {
        emailStatus = "skipped";
        emailError = "provider_not_configured";
      } else {
        emailStatus = "failed";
        emailError = err instanceof Error ? err.message : String(err);
        logger.error(
          { ...logContext, requestId: request.id, handlerUserId: newHandlerUserId, errMsg: emailError },
          "[data-request-notify] Failed to send handler-assigned email",
        );
      }
    }
  }

  // 3) Push to the assigned handler's device(s).
  let pushStatus: ChannelStatus = "skipped";
  let pushError: string | undefined;
  try {
    const result = await sendTransactionalPush(
      [newHandlerUserId],
      `Privacy request assigned (${ref})`,
      `${memberName}: ${typeLabel}${dueByStr ? ` · due ${dueByStr}` : ""}`,
      {
        type: "data_request_assigned",
        requestId: request.id,
        clubMemberId: request.clubMemberId,
        route: deepLink,
      },
    );
    if (result.sent > 0) {
      pushStatus = "sent";
    } else if (result.attempted === 0 || result.invalid === result.attempted) {
      pushStatus = "no_address";
    } else {
      pushStatus = "failed";
      pushError = "push_delivery_failed";
    }
  } catch (err) {
    pushStatus = "failed";
    pushError = err instanceof Error ? err.message : String(err);
    logger.error(
      { ...logContext, requestId: request.id, handlerUserId: newHandlerUserId, errMsg: pushError },
      "[data-request-notify] Failed to push handler-assigned notice",
    );
  }

  logger.info(
    { ...logContext, requestId: request.id, handlerUserId: newHandlerUserId, inAppMessageId, pushStatus, emailStatus },
    "[data-request-notify] Handler assigned — notification dispatched",
  );

  return { inAppMessageId, pushStatus, pushError, emailStatus, emailError, emailRecipient, deepLink };
}

/**
 * @deprecated Use {@link notifyAdminsOfRetryExhaustion} with `channel: "email"`.
 * Kept as a thin shim so existing callers/tests continue to work.
 */
export async function notifyAdminsOfEmailRetryExhaustion(opts: {
  request: MemberDataRequest;
  logContext?: Record<string, unknown>;
}): Promise<{ notified: boolean; recipients: number }> {
  return notifyAdminsOfRetryExhaustion({ channel: "email", request: opts.request, logContext: opts.logContext });
}
