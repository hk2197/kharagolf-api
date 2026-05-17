import type { Transporter } from "nodemailer";
import { logger } from "./logger";
import { getCustomDomainEmailStrings, fmtTemplate } from "./customDomainEmailI18n";
import { getEmailStrings as getAdminEmailStringsFor } from "./adminEmailI18n";
import { translateWalletTopupRefundDigest } from "./walletTopupRefundDigestI18n";
import { translateSideGameReceiptDigest } from "./sideGameReceiptDigestI18n";
import { sendTransactionalEmail, logActiveProviderStatus, getActiveMailProvider, fetchPostmarkMessageDetails } from "./email/adapter";
import { getNotificationEmailBundle, fmtNotificationEmail } from "./notificationEmailI18n";
import {
  translateDataExportEmail,
  resolveDataExportEmailLang,
  formatDataExportEmailDate,
} from "./dataExportEmailI18n";
import { translateDataRequestEmail } from "./dataRequestEmailI18n";

// Re-export so callers that already import from `lib/mailer` (the
// historical entry point for outbound email) can reach the Postmark
// message-details lookup without depending on the adapter directly.
export { fetchPostmarkMessageDetails };
export type { PostmarkMessageDetails } from "./email/adapter";

const GMAIL_USER = process.env.GMAIL_USER ?? "";
const FROM = `"KHARAGOLF" <${GMAIL_USER || "noreply@kharagolf.com"}>`;

/**
 * Wave 0 / Task #935 — every transactional email now flows through the
 * provider-agnostic adapter (`lib/email/adapter.ts`). Switching from Gmail
 * SMTP to Postmark / Resend / SendGrid is a one-line env change
 * (`EMAIL_PROVIDER=resend` + the corresponding API key) — call sites in
 * this file keep their existing signatures.
 */
export function validateMailerConfig(): boolean {
  return logActiveProviderStatus();
}

/**
 * Internal helper used by every per-flow `send*Email()` function below.
 * The shape mirrors `nodemailer`'s `sendMail()` for backwards compatibility,
 * but the actual transport is the active provider behind `sendTransactionalEmail`.
 * Throws when delivery fails so callers can persist `emailDelivered: false`,
 * matching the previous behaviour exactly.
 */
/**
 * Optional per-call delivery hints. `bypassSuppression` is set by critical
 * security flows (password reset, etc.) so a hard-bounced address can still
 * receive recovery mail. `organizationId` scopes the suppression check to a
 * single org when the caller knows it.
 */
interface SendMailHints {
  bypassSuppression?: boolean;
  organizationId?: number;
  /**
   * Task #1140 — free-form metadata forwarded to providers that support it
   * (Postmark/Resend) and serialised into `X-Email-Meta-*` headers for
   * Gmail. The Postmark bounce webhook (Task #981) reads `Metadata.orgId`
   * to attribute bounces / spam complaints / unsubscribes back to the
   * originating club without scanning campaigns or memberships.
   */
  metadata?: Record<string, string>;
}

/**
 * Task #1140 — derive a `SendMailHints` carrying `metadata: { orgId }` (and
 * `organizationId` for suppression-list scoping) from an org id. Used by
 * every transactional `send*Email()` helper that has access to a club via
 * its `EmailBranding.orgId` or an explicit opts field.
 *
 * Returns `undefined` when no org id is available (signup verification,
 * super-admin digests, ops alerts) so the call site degrades to the
 * existing anonymous-send behaviour and the Postmark webhook falls back
 * to scanning campaigns / memberships.
 */
function orgHints(
  orgId: number | null | undefined,
  extra?: Partial<SendMailHints>,
): SendMailHints | undefined {
  if (orgId === null || orgId === undefined || !Number.isFinite(orgId)) {
    return extra && Object.keys(extra).length > 0 ? { ...extra } : undefined;
  }
  return {
    organizationId: orgId,
    ...extra,
    metadata: { orgId: String(orgId), ...(extra?.metadata ?? {}) },
  };
}

/**
 * Task #1310 — derive `SendMailHints` carrying the originating
 * transactional flow name (e.g. "dues_receipt", "tournament_invite",
 * "password_reset") plus the standard `orgId` metadata. The Postmark
 * bounce webhook reads `Metadata.flow` (with `Tag` as a fallback) to
 * attribute each suppression row back to a specific transactional flow
 * so admins can pinpoint a misconfigured template without scanning logs.
 *
 * Flow names should be short, snake_case, and stable — they are stored
 * verbatim on `email_suppressions.triggered_by_flow` and shown in the
 * Suppressions tab.
 */
function flowHints(
  orgId: number | null | undefined,
  flow: string,
  extra?: Partial<SendMailHints>,
): SendMailHints | undefined {
  return orgHints(orgId, {
    ...extra,
    metadata: { flow, ...(extra?.metadata ?? {}) },
  });
}

async function sendMail(
  mailOptions: Parameters<Transporter["sendMail"]>[0],
  hints?: SendMailHints,
): Promise<void> {
  if (!getActiveMailProvider().isConfigured()) {
    throw new Error("[MAILER] Active email provider is not configured");
  }
  const to = Array.isArray(mailOptions.to)
    ? mailOptions.to.map((v) => (typeof v === "string" ? v : v.address)).join(",")
    : typeof mailOptions.to === "object" && mailOptions.to !== null && "address" in mailOptions.to
      ? (mailOptions.to as { address: string }).address
      : String(mailOptions.to ?? "");
  const from = typeof mailOptions.from === "string"
    ? mailOptions.from
    : typeof mailOptions.from === "object" && mailOptions.from !== null && "address" in mailOptions.from
      ? `"${(mailOptions.from as { name?: string }).name ?? ""}" <${(mailOptions.from as { address: string }).address}>`
      : undefined;
  const replyTo = typeof mailOptions.replyTo === "string"
    ? mailOptions.replyTo
    : typeof mailOptions.replyTo === "object" && mailOptions.replyTo !== null && "address" in mailOptions.replyTo
      ? (mailOptions.replyTo as { address: string }).address
      : undefined;
  // Pass through caller-supplied RFC 5322 headers (e.g. `List-Unsubscribe`,
  // `List-Unsubscribe-Post` for one-click unsubscribe flows). Nodemailer
  // accepts a wide range of values for `headers`; we only forward the simple
  // `Record<string, string>` shape since that is all our adapter accepts.
  const rawHeaders = (mailOptions as { headers?: unknown }).headers;
  let extraHeaders: Record<string, string> | undefined;
  if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    const acc: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof v === "string") acc[k] = v;
    }
    if (Object.keys(acc).length > 0) extraHeaders = acc;
  }
  const result = await sendTransactionalEmail({
    to,
    from,
    subject: String(mailOptions.subject ?? ""),
    html: typeof mailOptions.html === "string" ? mailOptions.html : "",
    text: typeof mailOptions.text === "string" ? mailOptions.text : undefined,
    replyTo,
    extraHeaders,
    organizationId: hints?.organizationId,
    bypassSuppression: hints?.bypassSuppression,
    metadata: hints?.metadata,
  });
  // Task #1139 — a `suppressed` short-circuit is the desired behaviour for
  // bad addresses, not a delivery failure. We swallow it here (no throw) so
  // callers don't surface a confusing error to admins; the adapter has
  // already logged it. If a future caller needs to record
  // `emailDelivered: false`, switch to calling `sendTransactionalEmail`
  // directly and branch on `result.suppressed`.
  if (!result.ok && !result.suppressed) {
    throw new Error(`[MAILER] ${result.provider} send failed: ${result.error ?? "unknown"}`);
  }
}

/**
 * Task #1279 — classify a `sendMail()` failure (raw error from any of the
 * `send*Email` helpers) as one of:
 *
 *   - `"hard_bounce"`         — the SMTP / API provider has signalled a
 *                               permanent delivery failure (5xx response,
 *                               "InvalidEmailRequest", "InactiveRecipient",
 *                               "BounceMailbox", "BadRecipientAddress",
 *                               "user unknown", "no such user", "mailbox
 *                               unavailable", "address rejected", "550",
 *                               "551", "552", "553", "554"). Retrying will
 *                               never succeed, so the wallet-withdrawal
 *                               retry pipeline stops re-attempting on the
 *                               first attempt and pages the org admin
 *                               instead of consuming all 5 retries.
 *   - `"provider_unconfigured"`— the active mail provider has no
 *                               credentials wired (see `sendMail`'s
 *                               "[MAILER] Active email provider is not
 *                               configured" sentinel + the per-provider
 *                               "X not set" / "not configured" patterns).
 *                               These flip the row to terminal `skipped`
 *                               so the cron stops re-selecting it.
 *   - `"transient"`            — anything else (timeouts, 4xx codes,
 *                               connection refused, DNS hiccups). The
 *                               normal exponential-backoff retry path
 *                               applies.
 */
export type MailerErrorClass = "hard_bounce" | "provider_unconfigured" | "transient";

const HARD_BOUNCE_PATTERNS: RegExp[] = [
  // SMTP 5xx response codes — covers Gmail / generic SMTP / nodemailer
  // verbatim error strings ("550 5.1.1 The email account that you tried
  // to reach does not exist", "554 5.7.1 …" etc.). Tightened to require a
  // word boundary or non-digit after the code so a transient "5500ms
  // timeout" doesn't get misclassified.
  /\b(5[0-9]{2})\b(?!\d)/,
  // Postmark ErrorCode-textual sentinels. Postmark's bounce webhook also
  // carries these on the inbound side, so the classification here matches
  // what later lands on the suppression list.
  /InvalidEmailRequest/i,
  /InactiveRecipient/i,
  /BounceMailbox/i,
  /BadRecipientAddress/i,
  // Generic English bounce phrases that Gmail's SMTP responses (and most
  // other SMTP servers) include in the body of a 5xx rejection. These give
  // us a backstop when the raw 5xx code was stripped by an upstream layer.
  /user unknown/i,
  /no such user/i,
  /mailbox (unavailable|not found|disabled)/i,
  /address (rejected|not found)/i,
  /recipient (rejected|address rejected)/i,
];

const PROVIDER_UNCONFIGURED_PATTERNS: RegExp[] = [
  /SMTP.*not configured/i,
  /MAIL_PROVIDER not configured/i,
  /EMAIL_PROVIDER not configured/i,
  /mailer.*not configured/i,
  /Active email provider is not configured/i,
  // Per-provider "credentials not set" messages from `sendMail()`'s
  // wrapper, e.g. "[MAILER] gmail send failed: GMAIL_USER /
  // GMAIL_APP_PASSWORD not set" or "POSTMARK_SERVER_TOKEN not set".
  /\b(GMAIL_USER|GMAIL_APP_PASSWORD|POSTMARK_SERVER_TOKEN|RESEND_API_KEY|SENDGRID_API_KEY)\b.*not set/i,
];

export function classifyMailerError(err: unknown): MailerErrorClass {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (!msg) return "transient";
  for (const re of PROVIDER_UNCONFIGURED_PATTERNS) {
    if (re.test(msg)) return "provider_unconfigured";
  }
  for (const re of HARD_BOUNCE_PATTERNS) {
    if (re.test(msg)) return "hard_bounce";
  }
  return "transient";
}

/** Branding options passed by callers that look up org settings. */
export interface EmailBranding {
  orgName?: string;
  logoUrl?: string;
  primaryColor?: string;
  /**
   * Task #1140 — when present, propagated as `metadata.orgId` on the
   * outgoing transactional email so the Postmark bounce webhook
   * (Task #981) can attribute bounces / spam complaints / unsubscribes
   * back to the originating club instantly. Callers that load branding
   * from the `organizations` table should select `id` alongside
   * `name`/`logoUrl`/`primaryColor` and pass it through here.
   */
  orgId?: number;
}

/** Renders the email header block with optional logo + org branding. */
export function renderBrandedHeaderHtml(branding?: EmailBranding, subtitle?: string): string {
  return headerHtml(branding, subtitle);
}

function headerHtml(branding?: EmailBranding, subtitle?: string): string {
  const color = /^#[0-9a-fA-F]{3,6}$/.test(branding?.primaryColor ?? "") ? branding!.primaryColor! : "#1e4d2b";
  const textColor = branding?.primaryColor ? "#ffffff" : "#4ade80";
  // Task #1887 — HTML-escape the brand name before injecting it into the
  // `<h1>` (and the logo `alt` attribute, which lives inside the same
  // header strip). A club whose name contains `<`, `>`, `&`, or `"`
  // would otherwise render as raw HTML in the email header — and could
  // even break out of the `alt=""` attribute. This helper is shared by
  // every transactional email so fixing it here protects the entire
  // outbound mail surface, not just the side-game receipt digest that
  // motivated the bug (see `side-game-receipt-digest-email-content.test.ts`).
  const name = branding?.orgName ?? "KHARAGOLF";
  const safeName = escapeHtml(name);
  const logoImg = branding?.logoUrl
    ? `<img src="${branding.logoUrl}" alt="${safeName}" style="height:44px;width:auto;object-fit:contain;display:block;margin-bottom:8px;"/>`
    : "";
  return `<div style="background:${color};padding:32px 40px;">
    ${logoImg}
    <h1 style="margin:0;font-size:24px;letter-spacing:4px;font-weight:900;color:#ffffff;">${safeName}</h1>
    ${subtitle ? `<p style="margin:4px 0 0;font-size:11px;letter-spacing:3px;color:${textColor};text-transform:uppercase;">${subtitle}</p>` : ""}
  </div>`;
}

export async function sendVerificationEmail(to: string, name: string, token: string, baseUrl: string, branding?: EmailBranding) {
  const link = `${baseUrl}/portal?token=${token}`;
  await sendMail({
    from: FROM,
    to,
    subject: `Verify your ${branding?.orgName ?? "KHARAGOLF"} account`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Enterprise")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Welcome, ${name}!</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 32px;">
            Thanks for registering. Please verify your email address to activate your player account.
          </p>
          <a href="${link}" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
            Verify Email Address
          </a>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            This link expires in 24 hours. If you didn't create an account, please ignore this email.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "email_verification"));
}

export async function sendPasswordResetEmail(to: string, name: string, token: string, baseUrl: string, branding?: EmailBranding) {
  const link = `${baseUrl}/portal/reset-password?token=${token}`;
  // Task #1139 — password reset is a critical security flow. Bypass the
  // suppression check so a previously bounced/unsubscribed address can still
  // recover account access (e.g. an admin who marked a now-fixed mailbox as
  // a hard bounce should not be permanently locked out).
  await sendMail({
    from: FROM,
    to,
    subject: `Reset your ${branding?.orgName ?? "KHARAGOLF"} password`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Enterprise")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Password Reset Request</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${name},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 32px;">
            We received a request to reset your password. Click the button below to set a new password.
          </p>
          <a href="${link}" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
            Reset Password
          </a>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            This link expires in 1 hour. If you did not request this, please ignore this email — your password will not change.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "password_reset", { bypassSuppression: true }));
}

export async function sendMemberInviteEmail(
  to: string,
  name: string,
  orgName: string,
  token: string,
  baseUrl: string,
  branding?: EmailBranding,
): Promise<void> {
  const link = `${baseUrl}/portal?action=claim&token=${token}`;
  const effectiveBranding: EmailBranding = { orgName, ...branding };
  await sendMail({
    from: FROM,
    to,
    subject: `You've been invited to join the ${orgName} Player Portal`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding, "Member Portal")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">You're Invited!</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${name},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 32px;">
            <strong style="color:#fff">${orgName}</strong> has invited you to create your Player Portal account.
            Click the button below to set your password and access your tournament history, handicap, and membership details.
          </p>
          <a href="${link}" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
            Claim Your Account
          </a>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            This invite link expires in 7 days. If you didn't expect this email, please ignore it.
          </p>
        </div>
      </div>
    `,
  }, flowHints(effectiveBranding.orgId, "member_invite"));
}

export async function sendInvitationEmail(
  to: string,
  recipientName: string,
  eventName: string,
  eventType: "tournament" | "league",
  inviteUrl: string,
  orgName: string,
  branding?: EmailBranding,
): Promise<void> {
  const effectiveBranding: EmailBranding = { orgName, ...branding };
  await sendMail({
    from: FROM,
    to,
    subject: `You're invited to ${eventName} — ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">You've been invited!</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${recipientName || "Golfer"},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">
            <strong style="color:#fff">${orgName}</strong> has invited you to join the ${eventType}:
          </p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:20px;margin:24px 0;">
            <p style="margin:0;font-size:20px;font-weight:700;color:#4ade80;">${eventName}</p>
            <p style="margin:4px 0 0;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:2px;">${eventType}</p>
          </div>
          <a href="${inviteUrl}" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
            Accept Invitation &amp; Register
          </a>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            This invitation expires in 30 days. If you did not expect this email, please ignore it.
          </p>
        </div>
      </div>
    `,
  }, flowHints(effectiveBranding.orgId, eventType === "tournament" ? "tournament_invite" : "league_invite"));
}

export async function sendPeerReviewRequestEmail(opts: {
  to: string;
  reviewerName: string;
  subjectName: string;
  caseKind: string;
  caseDetails: string;
  responseUrl: string;
  orgName: string;
  branding?: EmailBranding;
}): Promise<void> {
  const branding: EmailBranding = { orgName: opts.orgName, ...opts.branding };
  await sendMail({
    from: FROM,
    to: opts.to,
    subject: `[${opts.orgName}] Handicap committee — peer review requested`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Peer Review Requested")}
        <div style="padding:40px;">
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${opts.reviewerName || "Reviewer"},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            The <strong style="color:#fff">${opts.orgName}</strong> handicap committee is reviewing
            <strong style="color:#fff">${opts.subjectName}</strong>'s recent activity
            (case kind: <em>${opts.caseKind}</em>) and would like your peer comment.
          </p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:16px;margin:0 0 24px;color:#e5e7eb;line-height:1.6;font-size:14px;">
            ${opts.caseDetails || "(no additional details provided)"}
          </div>
          <a href="${opts.responseUrl}" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
            Submit Peer Comment
          </a>
          <p style="color:#6b7280;font-size:12px;margin:24px 0 0;">
            This focused link does not require a login. It expires in 14 days.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding.orgId, "peer_review_request"));
}

export async function sendCommitteePeerResponseDigestEmail(opts: {
  to: string;
  recipientName: string;
  orgName: string;
  sinceIso: string;
  responses: Array<{
    caseId: number;
    caseKind: string;
    subjectName: string | null;
    reviewerName: string | null;
    recommendation: string | null;
    comment: string | null;
    respondedAt: Date;
  }>;
}): Promise<void> {
  const branding: EmailBranding = { orgName: opts.orgName };
  const since = new Date(opts.sinceIso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
  const rows = opts.responses.map(r => {
    const verb = (r.recommendation ?? "(no recommendation)").replace(/_/g, " ");
    const reviewer = escapeHtml(r.reviewerName || "A peer reviewer");
    const subject = escapeHtml(r.subjectName || "a player");
    const kind = escapeHtml(r.caseKind);
    const comment = r.comment ? `<div style="margin-top:6px;color:#9ca3af;font-size:13px;line-height:1.5;">"${escapeHtml(r.comment)}"</div>` : "";
    const when = r.respondedAt.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #1f2937;">
      <div style="color:#fff;font-weight:600;">Case #${r.caseId} — ${kind}</div>
      <div style="color:#9ca3af;font-size:13px;">${reviewer} responded <strong style="color:#4ade80;">${escapeHtml(verb)}</strong> on ${subject} · ${when}</div>
      ${comment}
    </td></tr>`;
  }).join("");
  await sendMail({
    from: FROM,
    to: opts.to,
    subject: `[${opts.orgName}] Handicap committee — peer response digest (${opts.responses.length})`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Peer Response Digest")}
        <div style="padding:32px 40px;">
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${escapeHtml(opts.recipientName)},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            ${opts.responses.length} new peer review ${opts.responses.length === 1 ? "response was" : "responses were"} recorded since ${since}.
          </p>
          <table style="width:100%;border-collapse:collapse;">${rows}</table>
          <p style="color:#6b7280;font-size:12px;margin:24px 0 0;">
            Sign in to the committee tools to assign, decide, or close these cases.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding.orgId, "peer_review_digest"));
}

export async function sendBroadcastEmail(
  to: string,
  recipientName: string,
  subject: string,
  body: string,
  eventName: string,
  opts?: {
    logoUrl?: string;
    primaryColor?: string;
    orgName?: string;
    /**
     * Task #1310 — when set, the marketing campaign id is forwarded as
     * `Metadata.campaignId` to Postmark so the bounce webhook can
     * attribute any resulting suppression back to the originating
     * campaign and surface a clickable campaign link in the
     * Suppressions tab. Omit for non-campaign broadcasts.
     */
    campaignId?: number;
    /**
     * Task #1555 — when the campaign was built from a saved template
     * in the marketing template library, the template id is forwarded
     * as `Metadata.templateId` so the bounce webhook can attribute
     * the suppression back to the originating *template* (not just
     * the campaign), and admins can click straight through to the
     * template editor to fix the typo at source.
     *
     * The webhook re-validates the template's org ownership before
     * persisting (see `parseTemplateIdFromMetadata` + the
     * `templateOwnerOrgId` check in webhooks.ts) so a forged or
     * stale id can never link a suppression to a template another
     * org owns.
     */
    templateId?: number;
    /**
     * Task #1310 — overrides the default "broadcast" flow tag. The
     * marketing campaign dispatcher uses "campaign" so admins can
     * filter the Suppressions tab by transactional vs campaign
     * traffic; ad-hoc broadcasts keep the default.
     */
    flow?: string;
    /**
     * Task #1319 — propagated as `metadata.orgId` on the outgoing email
     * (via `branding.orgId` → `flowHints`) so the Postmark bounce
     * webhook (Task #981) can attribute bounces back to the originating
     * club without scanning campaigns or memberships.
     */
    orgId?: number;
  },
): Promise<void> {
  // Task #1319 — `orgId` flows through `branding.orgId` into `flowHints`,
  // ensuring `metadata.orgId` is set on every send.
  const branding: EmailBranding = {
    orgName: opts?.orgName ?? eventName,
    logoUrl: opts?.logoUrl,
    primaryColor: opts?.primaryColor,
    orgId: opts?.orgId,
  };
  const flow = opts?.flow ?? "broadcast";
  const extraMetadata: Record<string, string> = {};
  if (opts?.campaignId !== undefined && Number.isFinite(opts.campaignId)) {
    extraMetadata.campaignId = String(opts.campaignId);
  }
  // Task #1555 — when this send originated from a saved template,
  // forward the id so the bounce webhook can attribute the
  // resulting suppression back to the template (Postmark stores
  // metadata as strings, mirroring the campaignId convention).
  if (opts?.templateId !== undefined && Number.isFinite(opts.templateId)) {
    extraMetadata.templateId = String(opts.templateId);
  }
  await sendMail({
    from: FROM,
    to,
    subject: `[${eventName}] ${subject}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, subject)}
        <div style="padding:40px;">
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${recipientName || "Golfer"},</p>
          <div style="color:#e5e7eb;line-height:1.8;white-space:pre-wrap;">${body}</div>
        </div>
      </div>
    `,
  }, flowHints(branding.orgId, flow, Object.keys(extraMetadata).length > 0 ? { metadata: extraMetadata } : undefined));
}

export async function sendTournamentRegistrationEmail(
  to: string,
  name: string,
  tournamentName: string,
  orgName: string,
  startDate: Date | string | null,
  branding?: EmailBranding,
): Promise<void> {
  const dateStr = startDate ? new Date(startDate).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }) : "TBD";
  const effectiveBranding: EmailBranding = { orgName, ...branding };
  await sendMail({
    from: FROM,
    to,
    subject: `Registration confirmed: ${tournamentName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding, orgName)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">You're registered, ${name}!</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">
            Your registration for the following tournament has been confirmed:
          </p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:20px;margin:24px 0;">
            <p style="margin:0;font-size:20px;font-weight:700;color:#4ade80;">${tournamentName}</p>
            <p style="margin:8px 0 0;color:#9ca3af;font-size:14px;">📅 ${dateStr}</p>
          </div>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            We'll send you a reminder 24 hours before the tournament begins. Good luck!
          </p>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            Questions? Contact your tournament organizer or reach us at ${GMAIL_USER || "support@kharagolf.com"}
          </p>
        </div>
      </div>
    `,
  }, flowHints(effectiveBranding.orgId, "tournament_registration"));
}

export async function sendPaymentReceiptEmail(opts: {
  to: string;
  name: string;
  eventName: string;
  eventType: "tournament" | "league";
  amountSubunit: number;
  currency: string;
  currencySymbol: string;
  paymentId: string;
  receiptUrl?: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, name, eventName, eventType, amountSubunit, currency, currencySymbol, paymentId, receiptUrl, branding } = opts;
  const amountDisplay = `${currencySymbol}${(amountSubunit / 100).toFixed(2)}`;
  const receiptButton = receiptUrl
    ? `<div style="text-align:center;margin:24px 0 0;">
        <a href="${receiptUrl}" style="display:inline-block;background:#1e4d2b;color:#4ade80;font-weight:700;font-size:13px;padding:12px 28px;border-radius:8px;text-decoration:none;letter-spacing:1px;">⬇ Download PDF Receipt</a>
      </div>`
    : "";
  const effectiveBranding: EmailBranding = { orgName: eventName, ...branding };
  await sendMail({
    from: FROM,
    to,
    subject: `Payment Confirmed — ${eventName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding, "Enterprise")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#4ade80;">✅ Payment Confirmed</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">Hi ${name}, your ${eventType} entry fee has been received.</p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${eventType === "tournament" ? "Tournament" : "League"}</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${eventName}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Amount Paid</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;font-size:18px;">${amountDisplay}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Currency</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:12px;">${currency}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Payment ID</td><td style="padding:6px 0;text-align:right;color:#6b7280;font-size:11px;word-break:break-all;">${paymentId}</td></tr>
            </table>
          </div>
          ${receiptButton}
          <p style="color:#6b7280;font-size:12px;margin:${receiptUrl ? "24px" : "0"} 0 0;">Thank you for registering. See you on the course! 🏌️</p>
        </div>
      </div>
    `,
  }, flowHints(effectiveBranding.orgId, "payment_receipt"));
}

export async function sendShopOrderReceiptMail(opts: {
  to: string;
  buyerName: string;
  orderRef: string;
  lineItems: Array<{ description: string; quantity: number }>;
  totalDisplay: string;
  paymentId: string;
  pdfBuffer: Buffer;
  pdfFilename: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, buyerName, orderRef, lineItems, totalDisplay, paymentId, pdfBuffer, pdfFilename, branding } = opts;
  const orgName = branding?.orgName ?? "Club Shop";
  const effectiveBranding: EmailBranding = { orgName, ...branding };
  const itemsHtml = lineItems
    .map(li => `<li style="color:#e5e7eb;line-height:1.7;">${li.description} <span style="color:#9ca3af;">× ${li.quantity}</span></li>`)
    .join("");
  await sendMail({
    from: FROM,
    to,
    subject: `Order Confirmed — ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding, "Order Confirmation")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#4ade80;">✅ Order Confirmed</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">Hi ${buyerName || "there"}, thank you for your order!</p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:20px;margin:0 0 24px;">
            <p style="margin:0 0 12px;color:#9ca3af;font-size:13px;">${orderRef}</p>
            <ul style="margin:0;padding-left:18px;">${itemsHtml}</ul>
            <p style="margin:16px 0 0;color:#4ade80;font-weight:700;font-size:18px;">Total: ${totalDisplay}</p>
            <p style="margin:6px 0 0;color:#6b7280;font-size:11px;word-break:break-all;">Payment ID: ${paymentId}</p>
          </div>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">A PDF receipt is attached for your records. We'll email tracking once your items ship.</p>
          <p style="color:#6b7280;font-size:12px;margin:24px 0 0;">Thank you!</p>
        </div>
      </div>
    `,
    attachments: [{ filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" }],
  }, flowHints(effectiveBranding.orgId, "shop_order_receipt"));
}

export async function sendDuesReceiptMail(opts: {
  to: string;
  memberName: string;
  invoiceNumber: string;
  totalDisplay: string;
  paymentId: string;
  pdfBuffer: Buffer;
  pdfFilename: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, memberName, invoiceNumber, totalDisplay, paymentId, pdfBuffer, pdfFilename, branding } = opts;
  const orgName = branding?.orgName ?? "Your Club";
  const effectiveBranding: EmailBranding = { orgName, ...branding };
  await sendMail({
    from: FROM,
    to,
    subject: `Membership Dues Receipt — ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding, "Dues Receipt")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#4ade80;">✅ Payment Received</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">Hi ${memberName || "there"}, we've received your membership dues payment.</p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Invoice</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${invoiceNumber}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Amount</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;font-size:18px;">${totalDisplay}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Payment ID</td><td style="padding:6px 0;text-align:right;color:#6b7280;font-size:11px;word-break:break-all;">${paymentId}</td></tr>
            </table>
          </div>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">A PDF receipt is attached for your records and expense reports.</p>
          <p style="color:#6b7280;font-size:12px;margin:24px 0 0;">Thank you for your continued membership!</p>
        </div>
      </div>
    `,
    attachments: [{ filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" }],
  }, flowHints(effectiveBranding.orgId, "dues_receipt"));
}

export async function sendPaymentReminderEmail(opts: {
  to: string;
  name: string;
  eventName: string;
  eventType: "tournament" | "league";
  currencySymbol: string;
  amount: string;
  paymentUrl?: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, name, eventName, eventType, currencySymbol, amount, paymentUrl, branding } = opts;
  const effectiveBranding: EmailBranding = { orgName: eventName, ...branding };
  await sendMail({
    from: FROM,
    to,
    subject: `Payment Reminder — ${eventName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding, "Enterprise")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">⏰ Payment Reminder</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">Hi ${name}, you have an outstanding entry fee for <strong style="color:#fff;">${eventName}</strong>.</p>
          <div style="background:#1a2e1a;border:1px solid #f59e0b33;border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${eventType === "tournament" ? "Tournament" : "League"}</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${eventName}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Amount Due</td><td style="padding:6px 0;text-align:right;color:#f59e0b;font-weight:700;font-size:18px;">${currencySymbol}${amount}</td></tr>
            </table>
          </div>
          ${paymentUrl ? `<a href="${paymentUrl}" style="display:inline-block;background:#22c55e;color:#000;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:15px;">Pay Now</a>` : ""}
          <p style="color:#6b7280;font-size:12px;margin:24px 0 0;">Please complete your payment to secure your spot. If you have any questions, contact your club admin.</p>
        </div>
      </div>
    `,
  }, flowHints(effectiveBranding.orgId, "payment_reminder"));
}

export async function sendWelcomeEmail(to: string, name: string, branding?: EmailBranding) {
  await sendMail({
    from: FROM,
    to,
    subject: `Welcome to ${branding?.orgName ?? "KHARAGOLF"} Enterprise!`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Enterprise")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Your account is active, ${name}!</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Welcome to ${branding?.orgName ?? "KHARAGOLF"} Enterprise — your professional golf tournament management platform.
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 32px;">
            You can now view your upcoming tournaments, track your scores, and follow league standings through the Player Portal.
          </p>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            If you have any questions, contact us at ${GMAIL_USER || "support@kharagolf.com"}
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "welcome"));
}

export async function sendWithdrawalConfirmationEmail(
  to: string,
  playerName: string,
  tournamentName: string,
  refundPending: boolean,
): Promise<void> {
  await sendMail({
    from: FROM,
    to,
    subject: `Withdrawal confirmed — ${tournamentName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="background:#1e4d2b;padding:32px 40px;">
          <h1 style="margin:0;font-size:24px;letter-spacing:4px;font-weight:900;">KHARAGOLF</h1>
          <p style="margin:4px 0 0;font-size:11px;letter-spacing:3px;color:#4ade80;text-transform:uppercase;">Enterprise</p>
        </div>
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Withdrawal Confirmed</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${playerName},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            You have been successfully withdrawn from <strong style="color:#fff">${tournamentName}</strong>.
          </p>
          ${refundPending ? `
          <div style="background:#2d1f0a;border:1px solid #f59e0b44;border-radius:8px;padding:20px;margin:0 0 24px;">
            <p style="margin:0;color:#fbbf24;font-weight:600;">Refund Pending</p>
            <p style="margin:4px 0 0;color:#9ca3af;font-size:13px;line-height:1.5;">
              Your payment is eligible for a refund. Our team will process it within 5–10 business days and you will receive a separate confirmation once it has been issued.
            </p>
          </div>` : ""}
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            If you believe this was a mistake, please contact your tournament organiser as soon as possible. Withdrawals cannot be reversed through the portal.
          </p>
        </div>
      </div>
    `,
  });
}

export async function sendCoachPayoutPaidEmail(opts: {
  to: string;
  coachName: string;
  amountPaise: number;
  reference: string;
  notes?: string | null;
  branding?: EmailBranding;
  /** Task #1099 — render the email in the org's default language with EN fallback. */
  lang?: string | null;
}): Promise<void> {
  const { to, coachName, amountPaise, reference, notes, branding, lang } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const amountDisplay = `₹${(amountPaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const safeRef = escapeHtml(reference);
  const safeNotes = notes ? escapeHtml(notes) : null;
  const strings = getAdminEmailStringsFor(lang, "payoutNotify");
  const subject = fmtTemplate(strings.subject, { amount: amountDisplay, orgName });
  const greeting = fmtTemplate(strings.greeting, {
    coachName: escapeHtml(coachName) || "Coach",
    orgName: escapeHtml(orgName),
  });
  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, strings.headerTag)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#4ade80;">${escapeHtml(strings.heading)}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">${greeting}</p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(strings.amountLabel)}</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;font-size:20px;">${amountDisplay}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(strings.referenceLabel)}</td><td style="padding:6px 0;text-align:right;color:#fff;font-size:12px;word-break:break-all;">${safeRef}</td></tr>
              ${safeNotes ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;">${escapeHtml(strings.notesLabel)}</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;white-space:pre-wrap;">${safeNotes}</td></tr>` : ""}
            </table>
          </div>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">${escapeHtml(strings.eta)}</p>
          <p style="color:#6b7280;font-size:12px;margin:24px 0 0;">${escapeHtml(strings.footer)}</p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "coach_payout_paid"));
}

/**
 * Task #915 — Notify the coach when their payout account is created or
 * updated. Sends a security-style alert with masked account details, who
 * made the change (self vs admin), the change time, and the originating
 * IP, plus a link back to the workspace history list.
 */
export async function sendCoachPayoutAccountChangedEmail(opts: {
  to: string;
  coachName: string;
  changeKind: "created" | "updated";
  method: "upi" | "bank_account";
  accountHolderName: string | null;
  upiVpaMasked: string | null;
  bankAccountLast4: string | null;
  bankIfsc: string | null;
  changedByName: string;
  changedByRole: "coach" | "admin";
  changedAt: Date;
  ipAddress: string | null;
  historyUrl: string;
  branding?: EmailBranding;
}): Promise<void> {
  const {
    to, coachName, changeKind, method, accountHolderName, upiVpaMasked,
    bankAccountLast4, bankIfsc, changedByName, changedByRole, changedAt,
    ipAddress, historyUrl, branding,
  } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const action = changeKind === "created" ? "added" : "updated";
  const methodLabel = method === "upi" ? "UPI" : "Bank account";
  const safeHolder = escapeHtml(accountHolderName ?? "—");
  const safeChangedBy = escapeHtml(changedByName || "Someone");
  const byLabel = changedByRole === "coach"
    ? "you (signed in to the coach workspace)"
    : `a ${orgName} administrator (${safeChangedBy})`;
  const detailsRow = method === "upi"
    ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">UPI ID</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;font-family:monospace;">${escapeHtml(upiVpaMasked ?? "—")}</td></tr>`
    : `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Account ending</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;font-family:monospace;">•••• ${escapeHtml(bankAccountLast4 ?? "----")}</td></tr>
       <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">IFSC</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;font-family:monospace;">${escapeHtml(bankIfsc ?? "—")}</td></tr>`;
  const whenStr = changedAt.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
  const safeIp = escapeHtml(ipAddress ?? "unknown");
  const safeHistoryUrl = safeHttpsUrl(historyUrl) ?? historyUrl;
  await sendMail({
    from: FROM,
    to,
    subject: `Payout account ${action} — ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Payout Security Alert")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#4ade80;">Payout account ${action}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 20px;">
            Hi ${escapeHtml(coachName) || "Coach"}, the payout account on your <strong style="color:#fff;">${escapeHtml(orgName)}</strong> coach profile was ${action} by ${byLabel}.
            We're letting you know so you can spot any unauthorised changes quickly.
          </p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Method</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${methodLabel}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Account holder</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safeHolder}</td></tr>
              ${detailsRow}
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Changed by</td><td style="padding:6px 0;text-align:right;color:#fff;font-size:13px;">${safeChangedBy} <span style="color:#6b7280;">(${escapeHtml(changedByRole)})</span></td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">When</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;">${escapeHtml(whenStr)}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">From IP</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;font-family:monospace;">${safeIp}</td></tr>
            </table>
          </div>
          <div style="text-align:center;margin:0 0 24px;">
            <a href="${safeHistoryUrl}" style="display:inline-block;background:#22c55e;color:#0a0a0a;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
              Review payout history
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;line-height:1.6;">
            If you didn't make this change (and weren't expecting an admin to make it on your behalf),
            sign in to your coach workspace immediately and update your account, then contact ${orgName} support.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "coach_payout_account_changed"));
}

/**
 * Task #1736 — Heads-up to the player when an Apple/Google account was just
 * linked to their KHARAGOLF profile. Mirrors the existing payout
 * security-alert style: timestamp, originating IP / device, and a CTA back
 * to the Privacy screen where the new link can be removed.
 *
 * Sent right after a successful `POST /api/portal/me/social-links/{apple|google}`
 * (Task #1432). If a session was hijacked, this is the out-of-band signal
 * that lets the genuine owner spot the silent attachment and undo it.
 */
export async function sendSocialLinkAddedSecurityEmail(opts: {
  to: string;
  recipientName: string;
  provider: "apple" | "google";
  linkedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  privacyUrl: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, recipientName, provider, linkedAt, ipAddress, userAgent, privacyUrl, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const providerLabel = provider === "apple" ? "Apple ID" : "Google account";
  const safeName = escapeHtml(recipientName) || "there";
  const safeProvider = escapeHtml(providerLabel);
  const whenStr = linkedAt.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
  const safeWhen = escapeHtml(whenStr);
  const safeIp = escapeHtml(ipAddress ?? "unknown");
  const safeUa = escapeHtml(userAgent ?? "unknown device");
  const safePrivacyUrl = safeHttpsUrl(privacyUrl) ?? privacyUrl;
  await sendMail({
    from: FROM,
    to,
    subject: `${providerLabel} linked to your ${orgName} account`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Security Alert")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#4ade80;">${safeProvider} linked</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 20px;">
            Hi ${safeName}, a new <strong style="color:#fff;">${safeProvider}</strong> was just linked to your
            <strong style="color:#fff;">${escapeHtml(orgName)}</strong> account. From now on, signing in with that
            ${safeProvider} will give access to this profile.
          </p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Provider</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safeProvider}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">When</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;">${safeWhen}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">From IP</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;font-family:monospace;">${safeIp}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;">Device</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;word-break:break-word;">${safeUa}</td></tr>
            </table>
          </div>
          <div style="text-align:center;margin:0 0 24px;">
            <a href="${safePrivacyUrl}" style="display:inline-block;background:#22c55e;color:#0a0a0a;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
              Review &amp; unlink
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;line-height:1.6;">
            If this wasn't you, sign in to ${escapeHtml(orgName)} immediately, unlink the ${safeProvider} from your
            Privacy screen, and change your password. Anyone who can sign in with that ${safeProvider} can now reach
            this account.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "social_link_added"));
}

/**
 * Task #2149 — Mirror of `sendSocialLinkAddedSecurityEmail` for the
 * symmetric attack: an attacker inside the session who *unlinks* the
 * genuine owner's Apple/Google to lock them out of the recovery path.
 *
 * Sent right after a successful
 * `DELETE /api/portal/me/social-links/{apple|google}` so the real owner
 * gets an out-of-band heads-up with timestamp, originating IP / device,
 * and a CTA back to the Privacy screen where the link can be re-added
 * (or to contact support if they didn't perform the unlink).
 */
export async function sendSocialLinkRemovedSecurityEmail(opts: {
  to: string;
  recipientName: string;
  provider: "apple" | "google";
  unlinkedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  privacyUrl: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, recipientName, provider, unlinkedAt, ipAddress, userAgent, privacyUrl, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const providerLabel = provider === "apple" ? "Apple ID" : "Google account";
  const safeName = escapeHtml(recipientName) || "there";
  const safeProvider = escapeHtml(providerLabel);
  const whenStr = unlinkedAt.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
  const safeWhen = escapeHtml(whenStr);
  const safeIp = escapeHtml(ipAddress ?? "unknown");
  const safeUa = escapeHtml(userAgent ?? "unknown device");
  const safePrivacyUrl = safeHttpsUrl(privacyUrl) ?? privacyUrl;
  await sendMail({
    from: FROM,
    to,
    subject: `${providerLabel} unlinked from your ${orgName} account`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Security Alert")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f87171;">${safeProvider} unlinked</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 20px;">
            Hi ${safeName}, the <strong style="color:#fff;">${safeProvider}</strong> previously linked to your
            <strong style="color:#fff;">${escapeHtml(orgName)}</strong> account was just removed. Signing in with that
            ${safeProvider} will no longer reach this profile.
          </p>
          <div style="background:#2e1a1a;border:1px solid #f8717133;border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Provider</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safeProvider}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">When</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;">${safeWhen}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">From IP</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;font-family:monospace;">${safeIp}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;">Device</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;word-break:break-word;">${safeUa}</td></tr>
            </table>
          </div>
          <div style="text-align:center;margin:0 0 24px;">
            <a href="${safePrivacyUrl}" style="display:inline-block;background:#22c55e;color:#0a0a0a;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
              Review &amp; re-link
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;line-height:1.6;">
            If this wasn't you, sign in to ${escapeHtml(orgName)} immediately, re-link the ${safeProvider} from your
            Privacy screen, change your password, and contact support. Removing a recovery method can be a sign that
            someone else has access to your account.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "social_link_removed"));
}

/**
 * Task #1060 — Admin-facing version of the coach payout-account-changed
 * security alert. Sent to org admin / finance contacts whenever a coach's
 * payout account is created or updated, so unauthorised swaps (especially
 * on-behalf-of changes by another admin) are caught quickly. Mirrors the
 * coach email's masked-detail format and links to the admin payout-history
 * view rather than the coach workspace.
 */
export async function sendCoachPayoutAccountChangedAdminEmail(opts: {
  to: string;
  recipientName: string | null;
  coachName: string;
  proId: number;
  changeKind: "created" | "updated";
  method: "upi" | "bank_account";
  accountHolderName: string | null;
  upiVpaMasked: string | null;
  bankAccountLast4: string | null;
  bankIfsc: string | null;
  changedByName: string;
  changedByRole: "coach" | "admin";
  changedAt: Date;
  ipAddress: string | null;
  adminHistoryUrl: string;
  branding?: EmailBranding;
}): Promise<void> {
  const {
    to, recipientName, coachName, proId, changeKind, method, accountHolderName,
    upiVpaMasked, bankAccountLast4, bankIfsc, changedByName, changedByRole,
    changedAt, ipAddress, adminHistoryUrl, branding,
  } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const action = changeKind === "created" ? "added" : "updated";
  const methodLabel = method === "upi" ? "UPI" : "Bank account";
  const safeCoach = escapeHtml(coachName || `Coach #${proId}`);
  const safeHolder = escapeHtml(accountHolderName ?? "—");
  const safeChangedBy = escapeHtml(changedByName || "Someone");
  const byLabel = changedByRole === "coach"
    ? `the coach themselves (${safeChangedBy})`
    : `a ${escapeHtml(orgName)} administrator (${safeChangedBy})`;
  const detailsRow = method === "upi"
    ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">UPI ID</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;font-family:monospace;">${escapeHtml(upiVpaMasked ?? "—")}</td></tr>`
    : `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Account ending</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;font-family:monospace;">•••• ${escapeHtml(bankAccountLast4 ?? "----")}</td></tr>
       <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">IFSC</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;font-family:monospace;">${escapeHtml(bankIfsc ?? "—")}</td></tr>`;
  const whenStr = changedAt.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
  const safeIp = escapeHtml(ipAddress ?? "unknown");
  const safeHistoryUrl = safeHttpsUrl(adminHistoryUrl) ?? adminHistoryUrl;
  const greeting = recipientName?.trim() ? `Hi ${escapeHtml(recipientName.trim())},` : "Hi,";
  await sendMail({
    from: FROM,
    to,
    subject: `[Admin] Payout account ${action} for ${coachName || `coach #${proId}`} — ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Payout Security Alert · Admin")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#fbbf24;">Coach payout account ${action}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 20px;">
            ${greeting} the payout account for <strong style="color:#fff;">${safeCoach}</strong>
            on <strong style="color:#fff;">${escapeHtml(orgName)}</strong> was ${action} by ${byLabel}.
            You're receiving this as an org admin so unauthorised account swaps can be caught early.
          </p>
          <div style="background:#1a1a1a;border:1px solid #fbbf2433;border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Coach</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safeCoach}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Method</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${methodLabel}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Account holder</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safeHolder}</td></tr>
              ${detailsRow}
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Changed by</td><td style="padding:6px 0;text-align:right;color:#fff;font-size:13px;">${safeChangedBy} <span style="color:#6b7280;">(${escapeHtml(changedByRole)})</span></td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">When</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;">${escapeHtml(whenStr)}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">From IP</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;font-family:monospace;">${safeIp}</td></tr>
            </table>
          </div>
          <div style="text-align:center;margin:0 0 24px;">
            <a href="${safeHistoryUrl}" style="display:inline-block;background:#fbbf24;color:#0a0a0a;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
              Review payout history
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;line-height:1.6;">
            If this change wasn't expected, open the audit log and follow up with the coach (and the admin
            who made the change, if any) before the next payout cycle.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "coach_payout_account_changed_admin"));
}

/**
 * Task #913 — A scheduled re-validation of a coach's saved Razorpay fund
 * account failed (the VPA is deactivated, the bank account is closed,
 * etc.). The coach is asked to re-verify the account before the next
 * payout cycle so we don't disburse to a dead account.
 */
export async function sendCoachPayoutAccountNeedsAttentionEmail(opts: {
  to: string;
  coachName: string;
  method: "upi" | "bank_account";
  accountLabel: string;
  failureReason: string;
  reverifyUrl?: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, coachName, method, accountLabel, failureReason, reverifyUrl, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeReverifyUrl = safeHttpsUrl(reverifyUrl);
  const methodLabel = method === "upi" ? "UPI ID" : "bank account";
  await sendMail({
    from: FROM,
    to,
    subject: `Action needed — re-verify your payout ${methodLabel}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Payout Account")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#facc15;">⚠️ Re-verify your payout account</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">Hi ${escapeHtml(coachName) || "Coach"}, we tried to re-verify the ${methodLabel} on file for your <strong style="color:#fff;">${escapeHtml(orgName)}</strong> coach payouts and the bank reported it as no longer valid:</p>
          <div style="background:#2a1f0a;border:1px solid #facc1533;border-radius:8px;padding:16px 20px;margin:0 0 20px;">
            <div style="color:#6b7280;font-size:13px;margin-bottom:6px;">${methodLabel === "UPI ID" ? "UPI ID" : "Bank account"}</div>
            <div style="color:#fff;font-weight:600;font-size:15px;margin-bottom:10px;">${escapeHtml(accountLabel)}</div>
            <div style="color:#fbbf24;font-size:13px;">${escapeHtml(failureReason)}</div>
          </div>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 20px;">Until you re-verify, your next payout will be parked instead of disbursed. You can fix this in a minute by re-saving your payout details — we'll re-validate them with the bank as part of the save.</p>
          ${safeReverifyUrl ? `<p style="margin:0 0 24px;"><a href="${safeReverifyUrl}" style="display:inline-block;background:#facc15;color:#0a0a0a;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:8px;">Re-verify payout account</a></p>` : ""}
          <p style="color:#6b7280;font-size:12px;margin:24px 0 0;">If you've recently changed banks or VPA providers this is normal — just re-save your details. If the account on file is still active, contact your bank to make sure it accepts incoming UPI / RTGS transfers.</p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "coach_payout_needs_attention"));
}

/**
 * Task #1428 — An organisation admin manually re-verified the coach's
 * saved payout account (e.g. after a support ticket). Sends a short
 * transactional notice attributing the re-check to the admin, with the
 * date and the resulting verification status, so the coach has a paper
 * trail for any change to their account they didn't initiate. Fires for
 * both `verified` and `needs_attention` outcomes — the latter complements
 * the existing `sendCoachPayoutAccountNeedsAttentionEmail` (which
 * doesn't say *who* triggered the re-check) so the coach can correlate
 * the failure with the admin action that surfaced it.
 */
export async function sendCoachPayoutAccountReverifiedByAdminEmail(opts: {
  to: string;
  coachName: string;
  method: "upi" | "bank_account";
  accountLabel: string;
  outcome: "verified" | "needs_attention";
  reason?: string | null;
  reverifiedAt: Date;
  branding?: EmailBranding;
  /** Task #1723 — render the email in the coach's preferred language with EN fallback. */
  lang?: string | null;
}): Promise<void> {
  const { to, coachName, method, accountLabel, outcome, reason, reverifiedAt, branding, lang } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeOrg = escapeHtml(orgName);
  const strings = getAdminEmailStringsFor(lang, "payoutAccountReverifiedByAdmin");
  const methodInline = method === "upi" ? strings.upiInlineLabel : strings.bankInlineLabel;
  const methodRowLabel = method === "upi" ? strings.upiRowLabel : strings.bankRowLabel;
  const whenStr = reverifiedAt.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
  const ok = outcome === "verified";
  const statusLabel = ok ? strings.statusValueVerified : strings.statusValueNeedsAttention;
  const statusColor = ok ? "#4ade80" : "#facc15";
  const statusBg = ok ? "#1a2e1a" : "#2a1f0a";
  const statusBorder = ok ? "#22c55e33" : "#facc1533";
  const headline = ok ? strings.headingVerified : strings.headingNeedsAttention;
  const subjectTpl = ok ? strings.subjectVerified : strings.subjectNeedsAttention;
  const subject = fmtTemplate(subjectTpl, { orgName, methodLabel: methodInline });
  const introTpl = ok ? strings.introVerified : strings.introNeedsAttention;
  const intro = fmtTemplate(introTpl, { orgName: safeOrg, methodLabel: methodInline });
  const greeting = fmtTemplate(strings.greeting, { coachName: escapeHtml(coachName) || "Coach" });
  const reasonRow = !ok && reason
    ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top;">${escapeHtml(strings.reasonLabel)}</td><td style="padding:6px 0;text-align:right;color:#fbbf24;font-size:13px;">${escapeHtml(reason)}</td></tr>`
    : "";
  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, strings.headerTag)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:${statusColor};">${escapeHtml(headline)}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 20px;">${greeting} ${intro}</p>
          <div style="background:${statusBg};border:1px solid ${statusBorder};border-radius:8px;padding:16px 20px;margin:0 0 20px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(methodRowLabel)}</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;font-family:monospace;">${escapeHtml(accountLabel)}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(strings.reverifiedOnLabel)}</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${escapeHtml(whenStr)}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(strings.statusLabel)}</td><td style="padding:6px 0;text-align:right;color:${statusColor};font-weight:700;">${escapeHtml(statusLabel)}</td></tr>
              ${reasonRow}
            </table>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:24px 0 0;line-height:1.6;">${escapeHtml(strings.footer)}</p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "coach_payout_account_reverified_by_admin"));
}

/**
 * Task #1119 — A scheduled re-validation of a member's saved wallet
 * payout account failed (the UPI ID was retired, the bank account was
 * closed, etc.). Asks the member to re-save the account so withdrawals
 * can resume — the existing save flow re-runs the bank-side validation
 * automatically. Mirrors `sendCoachPayoutAccountNeedsAttentionEmail`
 * but with member-friendly copy.
 */
export async function sendMemberPayoutAccountNeedsAttentionEmail(opts: {
  to: string;
  memberName: string;
  method: "upi" | "bank_account";
  accountLabel: string;
  failureReason: string;
  reverifyUrl?: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, memberName, method, accountLabel, failureReason, reverifyUrl, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeReverifyUrl = safeHttpsUrl(reverifyUrl);
  const methodLabel = method === "upi" ? "UPI ID" : "bank account";
  await sendMail({
    from: FROM,
    to,
    subject: `Action needed — re-verify your wallet payout ${methodLabel}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Wallet Payout")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#facc15;">⚠️ Re-verify your payout account</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">Hi ${escapeHtml(memberName) || "there"}, we tried to re-verify the ${methodLabel} on file for your <strong style="color:#fff;">${escapeHtml(orgName)}</strong> wallet withdrawals and the bank reported it as no longer valid:</p>
          <div style="background:#2a1f0a;border:1px solid #facc1533;border-radius:8px;padding:16px 20px;margin:0 0 20px;">
            <div style="color:#6b7280;font-size:13px;margin-bottom:6px;">${methodLabel === "UPI ID" ? "UPI ID" : "Bank account"}</div>
            <div style="color:#fff;font-weight:600;font-size:15px;margin-bottom:10px;">${escapeHtml(accountLabel)}</div>
            <div style="color:#fbbf24;font-size:13px;">${escapeHtml(failureReason)}</div>
          </div>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 20px;">Until you re-verify, the Withdraw button in your wallet is disabled. You can fix this in a minute by re-saving your payout details — we'll re-validate them with the bank as part of the save.</p>
          ${safeReverifyUrl ? `<p style="margin:0 0 24px;"><a href="${safeReverifyUrl}" style="display:inline-block;background:#facc15;color:#0a0a0a;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:8px;">Re-verify payout account</a></p>` : ""}
          <p style="color:#6b7280;font-size:12px;margin:24px 0 0;">If you've recently changed banks or VPA providers this is normal — just re-save your details. If the account on file is still active, contact your bank to make sure it accepts incoming UPI / RTGS transfers.</p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "member_payout_needs_attention"));
}

const DATA_REQUEST_TYPE_LABELS: Record<string, string> = {
  access: "Access (copy of your data)",
  export: "Data export (portability)",
  portability: "Data portability",
  erasure: "Erasure (right to be forgotten)",
  rectification: "Rectification (correct your data)",
  restrict: "Restriction of processing",
  object: "Objection to processing",
};

export type DataRequestEmailKind = "filed" | "in_progress" | "completed" | "rejected" | "completed_export" | "export_expiring";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHttpsUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function sendDataRequestEmail(opts: {
  to: string;
  memberName: string;
  kind: DataRequestEmailKind;
  requestType: string;
  requestId: number;
  requestedAt: Date;
  dueBy: Date | null;
  notes?: string | null;
  artifactUrl?: string | null;
  /** Task #1075 — one-click "stop reminding me about this export" URL for
   * the `completed_export` ready email and the `export_expiring` reminder. */
  unsubUrl?: string | null;
  /** Task #1124 — when set (only for `export_expiring`), a 1x1 open-tracking
   * pixel is rendered at the end of the email body. The pixel endpoint
   * stamps `expiringReminderEmailOpenedAt` on the data-request row the
   * first time it's hit so admins can see the read-rate of the courtesy
   * notice. */
  trackingPixelUrl?: string | null;
  /** Task #1745 + Task #2167 — recipient's preferred language code
   * (one of `SUPPORTED_LANGUAGES`). Drives the subject + body
   * translation for every `DataRequestEmailKind` arm: Task #1745
   * shipped translations for `completed_export` / `export_expiring`,
   * and Task #2167 closed the gap by translating the four remaining
   * notices (`filed`, `in_progress`, `completed` non-export,
   * `rejected`) into the same 21-language matrix. Unknown / missing
   * codes fall back to English. */
  lang?: string | null;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, memberName, kind, requestType, requestId, requestedAt, dueBy, notes, artifactUrl, unsubUrl, trackingPixelUrl, lang, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeMemberName = escapeHtml(memberName);
  const safeNotes = notes ? escapeHtml(notes).replace(/\n/g, "<br/>") : null;
  const safeArtifactUrl = safeHttpsUrl(artifactUrl);
  const safeUnsubUrl = safeHttpsUrl(unsubUrl);
  const safeTrackingPixelUrl = safeHttpsUrl(trackingPixelUrl);

  let subject: string;
  let heading: string;
  let intro: string;
  let bodyExtra = "";
  let headerTag = "Data Protection";
  let typeLabel = escapeHtml(DATA_REQUEST_TYPE_LABELS[requestType] ?? requestType);
  let labelReference = "Reference";
  let labelRequestType = "Request type";
  let labelFiledOn = "Filed on";
  let labelDueBy = "Due by";
  let footerNote = `If you have questions about this request, reply to this email or contact ${escapeHtml(orgName)} directly.`;
  let requestedStr = requestedAt.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });
  let dueByStr = dueBy ? dueBy.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" }) : null;
  let dir: "ltr" | "rtl" = "ltr";
  let htmlLang = "en";

  switch (kind) {
    case "filed": {
      // Task #2167 — translate the "We've received your privacy
      // request" acknowledgement using the recipient's preferred
      // language (EN fallback). Mirrors the export-related arms
      // below: pull labels/header/footer/htmlLang/dir from the
      // shared shell, re-format the metadata-table dates in the
      // recipient's locale, and substitute the localised "Data
      // export (portability)" type label only when applicable.
      const t = translateDataRequestEmail(lang, "filed", {
        name: safeMemberName,
        orgName: escapeHtml(orgName),
        ref: requestId,
      });
      headerTag = t.headerTag;
      dir = t.dir;
      htmlLang = t.htmlLang;
      subject = t.subject;
      heading = t.heading;
      intro = t.intro;
      labelReference = t.labelReference;
      labelRequestType = t.labelRequestType;
      labelFiledOn = t.labelFiledOn;
      labelDueBy = t.labelDueBy;
      footerNote = t.footerNote;
      const langCode = resolveDataExportEmailLang(lang);
      requestedStr = formatDataExportEmailDate(requestedAt, langCode);
      dueByStr = dueBy ? formatDataExportEmailDate(dueBy, langCode) : null;
      if (requestType === "export" || requestType === "portability") {
        typeLabel = escapeHtml(t.typeLabelExport);
      }
      // The localised due-date sentence carries a `{dueByStr}`
      // placeholder; wrap the formatted date in `<strong>` (matching
      // the prior English template's bold styling) before substituting
      // it into the translation.
      if (dueByStr) {
        const dueByStrong = `<strong style="color:#fff;">${dueByStr}</strong>`;
        bodyExtra = `<p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">${t.filed.bodyDueBy.replace("{dueByStr}", dueByStrong)}</p>`;
      } else {
        bodyExtra = `<p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">${t.filed.bodyNoDueBy}</p>`;
      }
      break;
    }
    case "in_progress": {
      // Task #2167 — translate the "Your privacy request is being
      // processed" update. The body sentence is only rendered when a
      // due-by date is set, matching the prior English template.
      const t = translateDataRequestEmail(lang, "in_progress", {
        name: safeMemberName,
        orgName: escapeHtml(orgName),
        ref: requestId,
      });
      headerTag = t.headerTag;
      dir = t.dir;
      htmlLang = t.htmlLang;
      subject = t.subject;
      heading = t.heading;
      intro = t.intro;
      labelReference = t.labelReference;
      labelRequestType = t.labelRequestType;
      labelFiledOn = t.labelFiledOn;
      labelDueBy = t.labelDueBy;
      footerNote = t.footerNote;
      const langCode = resolveDataExportEmailLang(lang);
      requestedStr = formatDataExportEmailDate(requestedAt, langCode);
      dueByStr = dueBy ? formatDataExportEmailDate(dueBy, langCode) : null;
      if (requestType === "export" || requestType === "portability") {
        typeLabel = escapeHtml(t.typeLabelExport);
      }
      if (dueByStr) {
        const dueByStrong = `<strong style="color:#fff;">${dueByStr}</strong>`;
        bodyExtra = `<p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">${t.inProgress.bodyDueBy.replace("{dueByStr}", dueByStrong)}</p>`;
      } else {
        bodyExtra = "";
      }
      break;
    }
    case "completed": {
      // Task #2167 — translate the non-export "Your privacy request
      // is complete" notice. The CTA button is only rendered when
      // an `artifactUrl` is supplied (e.g. an admin-uploaded
      // response document); otherwise the body is empty as in the
      // prior English template.
      const t = translateDataRequestEmail(lang, "completed", {
        name: safeMemberName,
        orgName: escapeHtml(orgName),
        ref: requestId,
      });
      headerTag = t.headerTag;
      dir = t.dir;
      htmlLang = t.htmlLang;
      subject = t.subject;
      heading = t.heading;
      intro = t.intro;
      labelReference = t.labelReference;
      labelRequestType = t.labelRequestType;
      labelFiledOn = t.labelFiledOn;
      labelDueBy = t.labelDueBy;
      footerNote = t.footerNote;
      const langCode = resolveDataExportEmailLang(lang);
      requestedStr = formatDataExportEmailDate(requestedAt, langCode);
      dueByStr = dueBy ? formatDataExportEmailDate(dueBy, langCode) : null;
      if (requestType === "export" || requestType === "portability") {
        typeLabel = escapeHtml(t.typeLabelExport);
      }
      bodyExtra = safeArtifactUrl
        ? `<p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">${escapeHtml(t.completed.bodyWithLinkLead)}</p>
           <p style="margin:0 0 24px;"><a href="${safeArtifactUrl}" style="display:inline-block;background:#22c55e;color:#000;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:15px;">${escapeHtml(t.completed.bodyButtonLabel)}</a></p>`
        : "";
      break;
    }
    case "completed_export":
    case "export_expiring": {
      // Task #1745 — translate subject + body for both export-related
      // notices using the recipient's preferred language. Falls back to
      // English when `lang` is missing or unknown. Mirrors the
      // confirmation-page localisation already done in Task #1437 so the
      // email and the page the unsub link lands on speak the same language.
      const t = translateDataExportEmail(lang, kind, {
        name: safeMemberName,
        orgName: escapeHtml(orgName),
        ref: requestId,
      });
      headerTag = t.headerTag;
      dir = t.dir;
      htmlLang = t.htmlLang;
      subject = t.subject;
      heading = t.heading;
      intro = t.intro;
      labelReference = t.labelReference;
      labelRequestType = t.labelRequestType;
      labelFiledOn = t.labelFiledOn;
      labelDueBy = t.labelDueBy;
      footerNote = t.footerNote;
      // Re-format the metadata-table dates in the recipient's locale so
      // "Filed on" and "Due by" don't read as English long-form among
      // otherwise-translated copy.
      const langCode = resolveDataExportEmailLang(lang);
      requestedStr = formatDataExportEmailDate(requestedAt, langCode);
      dueByStr = dueBy ? formatDataExportEmailDate(dueBy, langCode) : null;
      // Only "export" requests trigger these notices — but if a future
      // caller fires them for another type we leave the existing English
      // label in place rather than mis-translate it as "Data export".
      if (requestType === "export" || requestType === "portability") {
        typeLabel = escapeHtml(t.typeLabelExport);
      }
      // Button colour mirrors the prior English template: green for the
      // ready notice, amber for the 24h reminder.
      const buttonBg = kind === "completed_export" ? "#22c55e" : "#f59e0b";
      bodyExtra = safeArtifactUrl
        ? `<p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">${escapeHtml(t.bodyWithLinkLead)}</p>
           <p style="margin:0 0 24px;"><a href="${safeArtifactUrl}" style="display:inline-block;background:${buttonBg};color:#000;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:15px;">${escapeHtml(t.bodyButtonLabel)}</a></p>
           <p style="color:#6b7280;font-size:12px;margin:0 0 16px;">${escapeHtml(t.bodyFallbackHint)}</p>`
        : `<p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">${escapeHtml(t.bodyNoLink)}</p>`;
      // Task #1075 — one-click opt-out link rendered in both notices.
      if (safeUnsubUrl) {
        const lead = t.optOutLead ? `${escapeHtml(t.optOutLead)} ` : "";
        const trailing = t.optOutTrailing ? ` ${escapeHtml(t.optOutTrailing)}` : ".";
        bodyExtra += `<p style="color:#6b7280;font-size:12px;margin:16px 0 0;border-top:1px solid rgba(255,255,255,0.08);padding-top:16px;">${lead}<a href="${safeUnsubUrl}" style="color:#9ca3af;text-decoration:underline;">${escapeHtml(t.optOutLinkText)}</a>${trailing}</p>`;
      }
      break;
    }
    case "rejected": {
      // Task #2167 — translate the "Update on your privacy request"
      // rejection notice. Operator-supplied `notes` are always
      // HTML-escaped and rendered verbatim under the localised
      // "Reason from our team:" label; when no notes are present we
      // fall back to the localised appeal hint.
      const t = translateDataRequestEmail(lang, "rejected", {
        name: safeMemberName,
        orgName: escapeHtml(orgName),
        ref: requestId,
      });
      headerTag = t.headerTag;
      dir = t.dir;
      htmlLang = t.htmlLang;
      subject = t.subject;
      heading = t.heading;
      intro = t.intro;
      labelReference = t.labelReference;
      labelRequestType = t.labelRequestType;
      labelFiledOn = t.labelFiledOn;
      labelDueBy = t.labelDueBy;
      footerNote = t.footerNote;
      const langCode = resolveDataExportEmailLang(lang);
      requestedStr = formatDataExportEmailDate(requestedAt, langCode);
      dueByStr = dueBy ? formatDataExportEmailDate(dueBy, langCode) : null;
      if (requestType === "export" || requestType === "portability") {
        typeLabel = escapeHtml(t.typeLabelExport);
      }
      bodyExtra = safeNotes
        ? `<p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;"><strong style="color:#fff;">${escapeHtml(t.rejected.bodyReasonLabel)}</strong><br/>${safeNotes}</p>`
        : `<p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">${escapeHtml(t.rejected.bodyAppealHint)}</p>`;
      break;
    }
  }

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div lang="${htmlLang}" dir="${dir}" style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, headerTag)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">${heading}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">${intro}</p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${labelReference}</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">#${requestId}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${labelRequestType}</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${typeLabel}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${labelFiledOn}</td><td style="padding:6px 0;text-align:right;color:#9ca3af;">${requestedStr}</td></tr>
              ${dueByStr ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${labelDueBy}</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;">${dueByStr}</td></tr>` : ""}
            </table>
          </div>
          ${bodyExtra}
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            ${footerNote}
          </p>
          ${safeTrackingPixelUrl ? `<img src="${safeTrackingPixelUrl}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />` : ""}
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "data_request"));
}

/**
 * Task 283 — Notify a staff member by email when a privacy/data-protection
 * request is assigned to them.
 *
 * Mirrors the in-app + push notice already dispatched by `notifyHandlerAssigned`
 * so handlers who aren't actively in the app or on a registered device still
 * find out about the assignment in their inbox. Includes the member name,
 * request type, deadline and a deep-link to the Member 360 Data tab.
 */
export async function sendDataRequestHandlerAssignedEmail(opts: {
  to: string;
  staffName: string;
  memberName: string;
  requestId: number;
  requestType: string;
  dueBy: Date | null;
  /** Absolute deep-link to the Member 360 Data tab. Optional: rendered as text when missing. */
  deepLinkUrl?: string | null;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, staffName, memberName, requestId, requestType, dueBy, deepLinkUrl, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeStaffName = escapeHtml(staffName);
  const safeMemberName = escapeHtml(memberName);
  const typeLabel = escapeHtml(DATA_REQUEST_TYPE_LABELS[requestType] ?? requestType);
  const dueByStr = dueBy ? dueBy.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" }) : null;
  const safeDeepLink = safeHttpsUrl(deepLinkUrl);

  const subject = `Privacy request assigned to you — ${memberName} (#${requestId})`;
  const ctaButton = safeDeepLink
    ? `<p style="margin:0 0 24px;"><a href="${safeDeepLink}" style="display:inline-block;background:#22c55e;color:#000;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:15px;">Open in Member 360</a></p>`
    : `<p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">Open the ${orgName} admin console and go to <strong style="color:#fff;">Member 360 → Data</strong> for ${safeMemberName} to action this request.</p>`;

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Data Protection")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Privacy request assigned to you</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">Hi ${safeStaffName}, you have been assigned a member's data-protection request at ${orgName}. This notice is regulated and must be resolved by the statutory deadline.</p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Reference</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">#${requestId}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Member</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safeMemberName}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Request type</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${typeLabel}</td></tr>
              ${dueByStr ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Due by</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;">${dueByStr}</td></tr>` : ""}
            </table>
          </div>
          ${ctaButton}
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            You're receiving this because an administrator assigned this privacy request to you. Other staff have not been notified.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "data_request_handler_assigned"));
}

export async function sendDataRequestDeadlineAlertEmail(opts: {
  to: string;
  staffName: string;
  kind: "approaching" | "overdue";
  requestId: number;
  requestType: string;
  memberName: string;
  requestedAt: Date;
  dueBy: Date;
  daysUntilDue: number;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, staffName, kind, requestId, requestType, memberName, requestedAt, dueBy, daysUntilDue, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeStaffName = escapeHtml(staffName);
  const safeMemberName = escapeHtml(memberName);
  const typeLabel = escapeHtml(DATA_REQUEST_TYPE_LABELS[requestType] ?? requestType);
  const requestedStr = requestedAt.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });
  const dueByStr = dueBy.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });

  const isOverdue = kind === "overdue";
  const subject = isOverdue
    ? `⚠️ OVERDUE: Privacy request #${requestId} past statutory deadline`
    : `⏰ Privacy request #${requestId} due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}`;
  const heading = isOverdue
    ? "Privacy request is past its statutory deadline"
    : `Privacy request approaching its ${daysUntilDue}-day deadline`;
  const accent = isOverdue ? "#ef4444" : "#f59e0b";
  const intro = isOverdue
    ? `Hi ${safeStaffName}, the privacy / data-protection request below has now <strong style="color:#fff;">passed its 30-day statutory deadline</strong> and is still open. Immediate action is required to maintain GDPR / DPDP compliance.`
    : `Hi ${safeStaffName}, the privacy / data-protection request below is approaching its statutory response deadline. Please action it before the due date.`;
  const overdueBy = isOverdue ? Math.max(1, Math.abs(daysUntilDue)) : 0;

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Data Protection")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;color:${accent};">${heading}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">${intro}</p>
          <div style="background:#111;border:1px solid ${accent}33;border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Reference</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">#${requestId}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Member</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safeMemberName}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Request type</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${typeLabel}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Filed on</td><td style="padding:6px 0;text-align:right;color:#9ca3af;">${requestedStr}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${isOverdue ? "Was due by" : "Due by"}</td><td style="padding:6px 0;text-align:right;color:${accent};font-weight:700;">${dueByStr}</td></tr>
              ${isOverdue
                ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Overdue by</td><td style="padding:6px 0;text-align:right;color:${accent};font-weight:700;">${overdueBy} day${overdueBy === 1 ? "" : "s"}</td></tr>`
                : `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Days remaining</td><td style="padding:6px 0;text-align:right;color:${accent};font-weight:700;">${daysUntilDue}</td></tr>`}
            </table>
          </div>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">Open the ${orgName} admin console and resolve the request (mark as in progress, completed, or rejected) to stop further reminders.</p>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            This is an automated compliance reminder from ${orgName}. You are receiving it because you are an organisation administrator or the assigned handler for this request.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "data_request_deadline_alert"));
}

/**
 * Daily admin digest of unresolved bounced levy reminders (Task #242).
 *
 * Mirrors the dashboard banner so admins who don't open the dashboard daily
 * still find out when retry attempts are piling up. Each row links back to
 * /club-members?openLevy=<id> — the same deep-link the in-app banner uses, so
 * clicking through opens the levy detail dialog where the retry CTA lives.
 */
/**
 * Task #1099 — Localised member-document rejection email. Replaces the
 * generic `sendBroadcastEmail` call site so members receive the rejection
 * notice in the club's `defaultLanguage` (with EN fallback) and the same
 * dark-themed transactional shell used by the other admin notices.
 */
export async function sendDocumentRejectedEmail(opts: {
  to: string;
  memberName: string;
  docLabel: string;
  reason: string;
  branding?: EmailBranding;
  lang?: string | null;
}): Promise<void> {
  const { to, memberName, docLabel, reason, branding, lang } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeMember = escapeHtml(memberName || "there");
  const safeDoc = escapeHtml(docLabel);
  const safeReason = escapeHtml(reason).replace(/\n/g, "<br/>");
  const strings = getAdminEmailStringsFor(lang, "documentRejected");
  const subject = fmtTemplate(strings.subject, { docLabel });
  const greeting = fmtTemplate(strings.greeting, { memberName: safeMember });
  const intro = fmtTemplate(strings.intro, { docLabel: safeDoc, orgName: escapeHtml(orgName) });
  await sendMail({
    from: FROM,
    to,
    subject: `[${orgName}] ${subject}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, strings.headerTag)}
        <div style="padding:40px;">
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">${greeting}</p>
          <p style="color:#e5e7eb;line-height:1.7;margin:0 0 16px;">${intro}</p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:0 0 24px;">
            <p style="margin:0 0 4px;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;">${escapeHtml(strings.reasonLabel)}</p>
            <p style="margin:0;color:#e5e7eb;line-height:1.6;font-size:14px;">${safeReason}</p>
          </div>
          <p style="color:#9ca3af;line-height:1.6;margin:0;">${escapeHtml(strings.reupload)}</p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "document_rejected"));
}

export async function sendBouncedLevyDigestEmail(opts: {
  to: string;
  staffName: string;
  baseUrl: string;
  totalBounced: number;
  levies: Array<{
    levyId: number;
    name: string;
    currency: string;
    unresolvedFailedCount: number;
    channels: Record<string, number>;
    latestFailureAt: string | null;
    sampleError: string | null;
  }>;
  branding?: EmailBranding;
  /** Task #1099 — render the email in the org's default language with EN fallback. */
  lang?: string | null;
}): Promise<void> {
  const { to, staffName, baseUrl, totalBounced, levies, branding, lang } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeStaffName = escapeHtml(staffName);
  const safeOrg = escapeHtml(orgName);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const strings = getAdminEmailStringsFor(lang, "bouncedDigest");
  const subjectTpl = totalBounced === 1 ? strings.subjectOne : strings.subjectMany;
  const subject = fmtTemplate(subjectTpl, { count: String(totalBounced), orgName });
  const introTpl = totalBounced === 1 ? strings.introOne : strings.introMany;
  const intro = fmtTemplate(introTpl, {
    staff: safeStaffName,
    count: String(totalBounced),
    leviesCount: String(levies.length),
    orgName: safeOrg,
  });
  const footer = fmtTemplate(strings.footer, { orgName: safeOrg });

  const rowsHtml = levies.map(l => {
    const channelsLabel = Object.entries(l.channels)
      .map(([ch, n]) => `${escapeHtml(ch)}: ${n}`)
      .join(" · ");
    const latestStr = l.latestFailureAt
      ? new Date(l.latestFailureAt).toLocaleString("en", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "—";
    const errorLine = l.sampleError
      ? `<div style="margin-top:6px;color:#9ca3af;font-size:12px;font-style:italic;">${escapeHtml(l.sampleError).slice(0, 240)}</div>`
      : "";
    const link = `${trimmedBase}/club-members?openLevy=${l.levyId}`;
    return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #1f2937;vertical-align:top;">
          <div style="color:#fff;font-weight:600;font-size:14px;">
            <a href="${link}" style="color:#4ade80;text-decoration:none;">${escapeHtml(l.name)}</a>
          </div>
          <div style="color:#9ca3af;font-size:12px;margin-top:2px;">${escapeHtml(strings.latestFailureLabel)}: ${latestStr}${channelsLabel ? ` · ${channelsLabel}` : ""}</div>
          ${errorLine}
        </td>
        <td style="padding:12px 0;border-bottom:1px solid #1f2937;text-align:right;color:#f59e0b;font-weight:700;font-size:16px;vertical-align:top;">
          ${l.unresolvedFailedCount}
        </td>
      </tr>
    `;
  }).join("");

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, strings.headerTag)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">${escapeHtml(strings.heading)}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            ${intro}
          </p>
          <table style="width:100%;border-collapse:collapse;margin:8px 0 0;">
            <thead>
              <tr>
                <th style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:2px;padding:0 0 8px;border-bottom:1px solid #1f2937;">${escapeHtml(strings.levyHeader)}</th>
                <th style="text-align:right;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:2px;padding:0 0 8px;border-bottom:1px solid #1f2937;">${escapeHtml(strings.bouncedHeader)}</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            ${footer}
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "bounced_levy_digest"));
}

/**
 * Task #1078 — daily digest emailed to controllers (org_admin /
 * membership_secretary / treasurer) when one or more members have leftover
 * object-storage files after their account erasure ran. Suppressed by the
 * cron on days the count is zero, so this template assumes count > 0.
 *
 * The body links straight to the org's privacy dashboard (where the org-wide
 * "Stuck erasure cleanup" widget lives) and lists each affected member so
 * the controller can drill in and re-run cleanup with a single click.
 */
export async function sendErasureStorageFailuresDigestEmail(opts: {
  to: string;
  staffName: string;
  baseUrl: string;
  count: number;
  totalFailedFiles: number;
  pendingStorageDeletions?: { total: number; exhausted: number };
  items: Array<{
    clubMemberId: number;
    auditId: number;
    completedAt: string;
    objectStorageFilesFailed: number;
    memberFirstName: string | null;
    memberLastName: string | null;
    memberNumber: string | null;
    memberDeleted: boolean;
  }>;
  branding?: EmailBranding;
  // Task #1242 — per-recipient one-click opt-out link. When provided, a
  // footer line is rendered with this URL and the same URL is also
  // surfaced in the RFC 2369 `List-Unsubscribe` header so mail clients
  // (Gmail, Apple Mail, Outlook) expose their native unsubscribe
  // affordance. Flips `userNotificationPrefs.notifyErasureStorageDigest`
  // off; other org-admin emails are unaffected.
  unsubscribeUrl?: string;
}): Promise<void> {
  const { to, staffName, baseUrl, count, totalFailedFiles, items, pendingStorageDeletions, branding, unsubscribeUrl } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeStaffName = escapeHtml(staffName);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const dashboardUrl = `${trimmedBase}/privacy?panel=erasure-storage-failures`;
  const subject = `⚠️ ${count} stuck erasure cleanup${count === 1 ? "" : "s"} need attention — ${orgName}`;

  const rowsHtml = items.slice(0, 50).map(it => {
    const nameParts = [it.memberFirstName, it.memberLastName].filter(Boolean).join(" ").trim();
    const label = nameParts || (it.memberDeleted ? "Deleted member" : `Member #${it.clubMemberId}`);
    const memberNumberLabel = it.memberNumber
      ? ` <span style="color:#6b7280;">(#${escapeHtml(it.memberNumber)})</span>`
      : "";
    const completed = new Date(it.completedAt).toLocaleString("en", {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    const memberLink = `${trimmedBase}/members/${it.clubMemberId}?panel=erasure-history`;
    return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #1f2937;vertical-align:top;">
          <div style="color:#fff;font-weight:600;font-size:14px;">
            <a href="${memberLink}" style="color:#4ade80;text-decoration:none;">${escapeHtml(label)}</a>${memberNumberLabel}
          </div>
          <div style="color:#9ca3af;font-size:12px;margin-top:2px;">Erasure completed ${completed}</div>
        </td>
        <td style="padding:12px 0;border-bottom:1px solid #1f2937;text-align:right;color:#f59e0b;font-weight:700;font-size:16px;vertical-align:top;">
          ${it.objectStorageFilesFailed}
        </td>
      </tr>
    `;
  }).join("");

  const truncatedNote = items.length > 50
    ? `<p style="color:#6b7280;font-size:12px;margin:12px 0 0;">Showing the first 50 of ${items.length} affected members. Open the privacy dashboard for the full list.</p>`
    : "";

  const pendingNote = pendingStorageDeletions && pendingStorageDeletions.total > 0
    ? `<p style="color:#9ca3af;line-height:1.6;margin:16px 0 0;font-size:13px;">
         The auto-retry queue still holds ${pendingStorageDeletions.total} pending file${pendingStorageDeletions.total === 1 ? "" : "s"}${
        pendingStorageDeletions.exhausted > 0
          ? `, of which <strong style="color:#f59e0b;">${pendingStorageDeletions.exhausted}</strong> ${pendingStorageDeletions.exhausted === 1 ? "has" : "have"} exhausted the bounded backoff and need operator review`
          : ""
      }.
       </p>`
    : "";

  // Task #1242 — render the per-recipient unsubscribe footer when the
  // caller minted a signed link. The same URL is also surfaced via the
  // RFC 2369 `List-Unsubscribe` header (and RFC 8058 one-click POST hint)
  // so Gmail / Apple Mail / Outlook expose their native unsubscribe
  // affordance without the controller having to scroll to the bottom.
  const safeUnsub = unsubscribeUrl ? escapeHtml(unsubscribeUrl) : null;
  const safeOrg = escapeHtml(orgName);
  const unsubFooter = safeUnsub
    ? `<p style="color:#6b7280;font-size:11px;line-height:1.6;margin:16px 0 0;border-top:1px solid #1f2937;padding-top:16px;">
         Don't want this digest? You'll keep getting other ${safeOrg} admin emails.
         <a href="${safeUnsub}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe with one click</a>.
       </p>`
    : "";
  const headers = unsubscribeUrl
    ? {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
    : undefined;

  await sendMail({
    from: FROM,
    to,
    subject,
    headers,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Privacy & Data Protection")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">Stuck erasure cleanup — daily digest</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Hi ${safeStaffName}, ${count} member${count === 1 ? "'s" : "s'"} account erasure for ${safeOrg}
            left ${totalFailedFiles} object-storage file${totalFailedFiles === 1 ? "" : "s"} behind. Each row below links to
            the member's erasure history where you can re-run the cleanup. You can also jump straight to the org's
            <a href="${dashboardUrl}" style="color:#4ade80;text-decoration:none;">privacy dashboard</a>.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:8px 0 0;">
            <thead>
              <tr>
                <th style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:2px;padding:0 0 8px;border-bottom:1px solid #1f2937;">Member</th>
                <th style="text-align:right;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:2px;padding:0 0 8px;border-bottom:1px solid #1f2937;">Files left</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          ${truncatedNote}
          ${pendingNote}
          <div style="margin-top:24px;">
            <a href="${dashboardUrl}" style="display:inline-block;background:#1e4d2b;color:#4ade80;font-weight:600;font-size:13px;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:0.5px;">
              Open privacy dashboard →
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            This digest only goes out on days with stuck erasure cleanups. You are receiving it because you are a controller
            (org admin, membership secretary or treasurer) for ${safeOrg}.
          </p>
          ${unsubFooter}
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "erasure_storage_failures_digest"));
}

/**
 * Task #1776 — One-time confirmation email sent when a controller mutes
 * the daily stuck-erasure cleanup digest from the in-portal toggle
 * (PATCH /portal/notification-preferences). Restores parity with the
 * unsubscribe-by-email path (Task #1242), which has always emitted a
 * confirmation page when its link is clicked: until now the in-portal
 * toggle silently flipped the row with no record, so a mis-click or a
 * shared session could mute the digest invisibly.
 *
 * The body names which channels were just muted (email, push, or both)
 * and embeds a one-click revert link signed with
 * {@link import("./bouncedDigestUnsubscribe.js").signErasureDigestMuteRevertToken}
 * so the controller can restore the digest without logging in.
 *
 * Same `List-Unsubscribe` / `List-Unsubscribe-Post` header pattern as
 * the digest itself so mail clients that show a "this is just a
 * confirmation, you didn't intend it" affordance can surface the revert
 * link inline. The header points at the same revert URL the body button
 * uses — clicking either flips the muted channel(s) back to true.
 */
export async function sendErasureStorageDigestMutedConfirmationEmail(opts: {
  to: string;
  staffName: string;
  baseUrl: string;
  /** Which channels were just toggled off in the portal. */
  mutedChannels: { email: boolean; push: boolean };
  /** Signed revert link valid for ~7 days (token TTL enforced server-side). */
  revertUrl: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, staffName, baseUrl, mutedChannels, revertUrl, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeStaffName = escapeHtml(staffName);
  const safeOrg = escapeHtml(orgName);
  const safeRevert = escapeHtml(revertUrl);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const portalUrl = `${trimmedBase}/portal/notification-preferences`;

  // Build a human-readable summary of what was muted so the recipient
  // can tell at a glance whether they actually intended the mute (or
  // someone else with the same session toggled it on their behalf).
  const channelLabel = mutedChannels.email && mutedChannels.push
    ? "email and in-app / push"
    : mutedChannels.email
      ? "email"
      : "in-app / push";
  const channelLabelSafe = escapeHtml(channelLabel);

  const subject = mutedChannels.email && mutedChannels.push
    ? `You muted the stuck-erasure digest — re-enable here`
    : mutedChannels.email
      ? `You muted the stuck-erasure digest email — re-enable here`
      : `You muted the stuck-erasure digest push — re-enable here`;

  // RFC 2369 / 8058 — same one-click semantics as the digest itself.
  // Mail clients (Gmail, Apple Mail, Outlook) expose a native
  // "unsubscribe / undo" affordance that POSTs to this URL; the public
  // revert handler accepts both GET (link click) and POST (one-click
  // header) and is idempotent.
  const headers = {
    "List-Unsubscribe": `<${revertUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  await sendMail({
    from: FROM,
    to,
    subject,
    headers,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Privacy & Data Protection")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">You muted the stuck-erasure digest</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Hi ${safeStaffName}, just confirming that the daily "stuck erasure cleanup" digest from
            <strong style="color:#fff;">${safeOrg}</strong> was just silenced on the
            <strong style="color:#fff;">${channelLabelSafe}</strong> channel from your portal notification
            preferences.
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            If that was you, no action is needed — you'll keep getting other ${safeOrg} controller
            emails, and the in-app inbox is unaffected. If a shared session toggled this on your
            behalf, or you clicked it by accident, you can restore the digest with one click below.
          </p>
          <div style="margin-top:24px;">
            <a href="${safeRevert}" style="display:inline-block;background:#1e4d2b;color:#4ade80;font-weight:600;font-size:13px;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:0.5px;">
              Re-enable the digest →
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            This revert link is valid for 7 days. After that, you can re-enable the digest from
            <a href="${portalUrl}" style="color:#9ca3af;text-decoration:underline;">your portal notification preferences</a>.
            We send this confirmation only once per short window to avoid spamming you when the
            toggle is flipped back-and-forth.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "erasure_storage_digest_mute_confirmation"));
}

/**
 * Task #2219 — One-time confirmation email sent when a controller mutes
 * one of the sibling controller digests (wallet auto-refund failed,
 * stuck side-game receipts, per-levy or org-wide ledger CSV digest,
 * bounced-levy reminders, admin-exhaustion fallback, weekly silent-
 * failures CSV) from the in-portal toggle (PATCH
 * /portal/notification-preferences). Restores parity with the
 * unsubscribe-by-email path: until now the in-portal toggle silently
 * flipped the row with no record, so a mis-click or a shared session
 * could mute one of these digests invisibly.
 *
 * Generalises the Task #1776 stuck-erasure-only mailer above
 * (`sendErasureStorageDigestMutedConfirmationEmail`) — same body shape,
 * same `List-Unsubscribe` / `List-Unsubscribe-Post` header pair, same
 * 7-day signed revert link contract — but takes a `digest` descriptor
 * (subject + headline + audience strings) so a single mailer can serve
 * every entry in
 * {@link import("./portalDigestMuteRegistry.js").PORTAL_DIGEST_MUTE_REGISTRY}
 * without forcing the caller to spell out a per-digest mailer for each
 * sibling. The stuck-erasure mailer stays separate because it has its
 * own combined-channel (email/push) semantics that the sibling digests
 * do not share — every sibling digest is email-only.
 */
export async function sendPortalDigestMutedConfirmationEmail(opts: {
  to: string;
  staffName: string;
  baseUrl: string;
  /** Per-digest copy (subject, headline, body labels). */
  digest: {
    subject: string;
    headlineHtml: string;
    digestNameHtml: string;
    audienceHtml: string;
  };
  /** Signed revert link valid for ~7 days (token TTL enforced server-side). */
  revertUrl: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, staffName, baseUrl, digest, revertUrl, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeStaffName = escapeHtml(staffName);
  const safeOrg = escapeHtml(orgName);
  const safeRevert = escapeHtml(revertUrl);
  // The headline / digest-name / audience strings come from the registry
  // (no user input) so we trust them as-is — they're the only source of
  // per-digest copy that varies between siblings.
  const safeHeadline = digest.headlineHtml;
  const safeDigestName = digest.digestNameHtml;
  const safeAudience = digest.audienceHtml;
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const portalUrl = `${trimmedBase}/portal/notification-preferences`;

  // RFC 2369 / 8058 — same one-click semantics as the stuck-erasure
  // confirmation. Mail clients (Gmail, Apple Mail, Outlook) expose a
  // native "unsubscribe / undo" affordance that POSTs to this URL; the
  // public revert handler accepts both GET (link click) and POST
  // (one-click header) and is idempotent.
  const headers = {
    "List-Unsubscribe": `<${revertUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  await sendMail({
    from: FROM,
    to,
    subject: digest.subject,
    headers,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Notification preferences")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">${safeHeadline}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Hi ${safeStaffName}, just confirming that the
            <strong style="color:#fff;">${safeDigestName}</strong> alert from
            <strong style="color:#fff;">${safeOrg}</strong> was just silenced from your portal
            notification preferences.
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            If that was you, no action is needed — you'll keep getting other ${safeOrg} controller
            emails. If a shared session toggled this on your behalf, or you clicked it by accident,
            you can restore the alert with one click below.
          </p>
          <div style="margin-top:24px;">
            <a href="${safeRevert}" style="display:inline-block;background:#1e4d2b;color:#4ade80;font-weight:600;font-size:13px;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:0.5px;">
              Re-enable the alert →
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            This revert link is valid for 7 days. After that, you can re-enable the alert from
            <a href="${portalUrl}" style="color:#9ca3af;text-decoration:underline;">your portal notification preferences</a>.
            We send this confirmation only once per short window to avoid spamming you when the
            toggle is flipped back-and-forth. ${safeAudience}
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "portal_digest_mute_confirmation"));
}

/**
 * Task #1489 — Monthly per-org "member notification preferences"
 * controller digest. Emails org_admins / membership_secretaries /
 * treasurers a downloadable CSV snapshot of every member's per-channel
 * and per-category notify preferences once a calendar month so finance
 * / outreach can audit who is opted in to what without logging in.
 *
 * Same email-side opt-out + List-Unsubscribe pattern as
 * `sendErasureStorageFailuresDigestEmail` (Task #1242):
 *   - When `unsubscribeUrl` is provided, the CSV-attachment email
 *     renders a one-click footer link AND surfaces the same URL via
 *     RFC 2369 `List-Unsubscribe` + RFC 8058 one-click POST headers so
 *     mail clients (Gmail / Apple Mail / Outlook) expose their native
 *     unsubscribe affordance.
 *   - The link flips
 *     `userNotificationPrefs.notifyMemberPrefsDigest` off via the
 *     `mpd1:`-prefixed signed token; other org-admin emails are
 *     unaffected.
 *
 * The `period` string is the month label ("April 2026"); `rowCount` is
 * the number of members included in the CSV (header excluded). Both are
 * surfaced in the body so the recipient can verify the file at a glance
 * without opening the attachment.
 */
export async function sendMemberPrefsDigestEmail(opts: {
  to: string;
  staffName: string;
  baseUrl: string;
  period: string;
  rowCount: number;
  filename: string;
  csv: string;
  branding?: EmailBranding;
  unsubscribeUrl?: string;
}): Promise<void> {
  const { to, staffName, baseUrl, period, rowCount, filename, csv, branding, unsubscribeUrl } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeStaffName = escapeHtml(staffName);
  const safeOrg = escapeHtml(orgName);
  const safePeriod = escapeHtml(period);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const dashboardUrl = `${trimmedBase}/admin/members?panel=notification-prefs`;
  const subject = `${orgName} — Monthly member notification-preferences digest (${period})`;

  const safeUnsub = unsubscribeUrl ? escapeHtml(unsubscribeUrl) : null;
  const unsubFooter = safeUnsub
    ? `<p style="color:#6b7280;font-size:11px;line-height:1.6;margin:16px 0 0;border-top:1px solid #1f2937;padding-top:16px;">
         Don't want this digest? You'll keep getting other ${safeOrg} admin emails.
         <a href="${safeUnsub}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe with one click</a>.
       </p>`
    : "";
  const headers = unsubscribeUrl
    ? {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
    : undefined;

  await sendMail({
    from: FROM,
    to,
    subject,
    headers,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Member notification preferences")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;">Monthly digest attached</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Hi ${safeStaffName}, please find attached this month's snapshot of every member's notification preferences
            at <strong style="color:#fff;">${safeOrg}</strong>. Each row covers per-channel toggles
            (email / push / SMS / WhatsApp) plus the per-category opt-outs for documents, side-game receipts,
            manual-entry alerts, payout-account changes, data-export expiry, and the stuck-erasure-cleanup digest.
          </p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Period</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safePeriod}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Cadence</td><td style="padding:6px 0;text-align:right;color:#fff;">monthly</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Members in this file</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;">${rowCount}</td></tr>
            </table>
          </div>
          <div style="margin-top:8px;">
            <a href="${dashboardUrl}" style="display:inline-block;background:#1e4d2b;color:#4ade80;font-weight:600;font-size:13px;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:0.5px;">
              Open notification preferences →
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            You are receiving this monthly digest because you are a controller (org admin, membership secretary or
            treasurer) for ${safeOrg}.
          </p>
          ${unsubFooter}
        </div>
      </div>
    `,
    attachments: [{ filename, content: csv, contentType: "text/csv; charset=utf-8" }],
  }, flowHints(branding?.orgId, "member_prefs_digest"));
}

/**
 * Task #1663 — Weekly super-admin "silent failures" CSV digest.
 *
 * Sent every 7 days to every super_admin who has not opted out of the
 * digest (`user_notification_prefs.notify_silent_alerts_digest = true`).
 * The body summarises the previous 7 days of zero-delivery manual-entry
 * alerts (rows where `recipientCount > 0` AND `pushSent + emailSent = 0`,
 * i.e. the alert was supposed to fan out but landed in nobody's inbox /
 * device) and the dashboard CTA deep-links to
 * `/super-admin/manual-entry-alerts?sinceDays=7&zeroDeliveryOnly=1` with
 * the matching filters pre-applied. The full row dump is attached as a
 * CSV (same column shape as the dashboard's CSV export — see
 * `buildManualEntryAlertsCsv`) so ops can pivot, share, or hand off to
 * engineering without copy-pasting from the inbox.
 *
 * Parallel structure with `sendMemberPrefsDigestEmail` (Task #1489): a
 * batched CSV attachment plus a single CTA button. The unsubscribe link
 * is optional — production callers always provide it so the dashboard
 * opt-out toggle stays in lockstep with the email-only opt-out semantics
 * mirrored in `user_notification_prefs.notify_silent_alerts_digest`.
 */
export async function sendSilentAlertsDigestEmail(opts: {
  to: string;
  staffName: string;
  baseUrl: string;
  /** ISO timestamp of the start of the 7-day window (inclusive). */
  windowStart: string;
  /** ISO timestamp of the end of the 7-day window (exclusive). */
  windowEnd: string;
  /** Number of zero-delivery alert rows in the attached CSV (header excluded). */
  rowCount: number;
  filename: string;
  csv: string;
  /** Optional per-recipient unsubscribe URL (one-click List-Unsubscribe-Post). */
  unsubscribeUrl?: string;
}): Promise<void> {
  const { to, staffName, baseUrl, windowStart, windowEnd, rowCount, filename, csv, unsubscribeUrl } = opts;
  const safeStaffName = escapeHtml(staffName);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  // Deep-link with the same filters the cron used so the recipient sees
  // exactly the rows from the attached CSV when they open the dashboard.
  const dashboardUrl = `${trimmedBase}/super-admin/manual-entry-alerts?sinceDays=7&zeroDeliveryOnly=1`;
  const fmt = (iso: string) => new Date(iso).toLocaleString("en", {
    year: "numeric", month: "short", day: "numeric",
  });
  const safeWindow = `${escapeHtml(fmt(windowStart))} → ${escapeHtml(fmt(windowEnd))}`;
  const subject = `KHARAGOLF — Weekly silent-failure alerts (${rowCount} row${rowCount === 1 ? "" : "s"})`;

  const safeUnsub = unsubscribeUrl ? escapeHtml(unsubscribeUrl) : null;
  const unsubFooter = safeUnsub
    ? `<p style="color:#6b7280;font-size:11px;line-height:1.6;margin:16px 0 0;border-top:1px solid #1f2937;padding-top:16px;">
         Don't want this digest? You'll keep getting other super-admin emails.
         <a href="${safeUnsub}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe with one click</a>.
       </p>`
    : "";
  const headers = unsubscribeUrl
    ? {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
    : undefined;

  await sendMail({
    from: FROM,
    to,
    subject,
    headers,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(undefined, "Super Admin")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">Weekly silent-failure alerts</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Hi ${safeStaffName}, here's the weekly snapshot of manual-entry alerts that
            had at least one intended recipient but landed nowhere — neither push
            nor email left the building. These are the inboxes / device tokens
            most worth investigating.
          </p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Window</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safeWindow}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Cadence</td><td style="padding:6px 0;text-align:right;color:#fff;">weekly</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Silent alerts in this file</td><td style="padding:6px 0;text-align:right;color:${rowCount > 0 ? "#f59e0b" : "#4ade80"};font-weight:700;">${rowCount}</td></tr>
            </table>
          </div>
          <div style="margin-top:8px;">
            <a href="${dashboardUrl}" style="display:inline-block;background:#1e4d2b;color:#4ade80;font-weight:600;font-size:13px;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:0.5px;">
              Open in dashboard →
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            You are receiving this weekly digest because you are a super admin.
            Toggle it off any time from your portal notification preferences.
          </p>
          ${unsubFooter}
        </div>
      </div>
    `,
    attachments: [{ filename, content: csv, contentType: "text/csv; charset=utf-8" }],
  }, flowHints(undefined, "silent_alerts_digest"));
}

/**
 * Task #1244 — per-member alert emailed to controllers when the bounded
 * cron auto-retry (Task #1079) hits its attempt cap on a stuck erasure
 * cleanup. Sent at most once per (member, retry-chain) — a manual
 * controller retry resets the cron-attempt count, so the next time the
 * cap is reached the controllers get re-alerted. Body links straight to
 * the per-member 360 erasure-history panel where the manual retry button
 * lives.
 *
 * Distinct from `sendErasureStorageFailuresDigestEmail` (daily aggregate
 * across the whole org) and `sendErasureStorageFailureExhaustedEmail`
 * (per orphan-path inside the pending_storage_deletions queue):
 * this email fires per-member the first time auto-retry gives up.
 */
export async function sendErasureAutoRetryCappedEmail(opts: {
  to: string;
  staffName: string;
  baseUrl: string;
  clubMemberId: number;
  memberLabel: string;
  attempts: number;
  filesFailed: number;
  failedPaths: string[];
  branding?: EmailBranding;
}): Promise<void> {
  const { to, staffName, baseUrl, clubMemberId, memberLabel, attempts, filesFailed, failedPaths, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeStaffName = escapeHtml(staffName);
  const safeMemberLabel = escapeHtml(memberLabel);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const memberUrl = `${trimmedBase}/members/${clubMemberId}?panel=erasure-history`;
  const subject = `⚠️ Erasure cleanup stuck — auto-retry exhausted for ${memberLabel}`;

  // Surface up to the first 5 paths so the controller has concrete
  // pointers when triaging without bloating the email past one screen.
  const previewPaths = failedPaths.slice(0, 5);
  const pathsBlock = previewPaths.length > 0
    ? `<div style="margin:16px 0 0;">
         <strong style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Outstanding object${previewPaths.length === 1 ? "" : "s"}</strong>
         <ul style="margin:8px 0 0;padding:0 0 0 20px;color:#4ade80;font-size:13px;line-height:1.6;">
           ${previewPaths.map(p => `<li><code style="color:#4ade80;font-size:12px;word-break:break-all;">${escapeHtml(p)}</code></li>`).join("")}
         </ul>
         ${failedPaths.length > previewPaths.length
           ? `<p style="color:#6b7280;font-size:12px;margin:8px 0 0;">…and ${failedPaths.length - previewPaths.length} more — see the per-member erasure history for the full list.</p>`
           : ""}
       </div>`
    : "";

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Privacy & Data Protection")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">Auto-retry cap reached on a stuck erasure</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Hi ${safeStaffName}, the bounded auto-retry queue for ${escapeHtml(orgName)} has now tried
            ${attempts} times to finish the object-storage cleanup for <strong style="color:#fff;">${safeMemberLabel}</strong>
            and given up. ${filesFailed} file${filesFailed === 1 ? "" : "s"} ${filesFailed === 1 ? "is" : "are"} still
            sitting in the bucket. Until a controller acts, no further automatic retries will run for this member.
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 0;">
            Open the member's erasure-history panel to inspect the failed paths and click <em>Retry storage cleanup</em>
            once the underlying issue (typically an IAM / lifecycle policy or a moved bucket) is fixed. A successful
            manual retry will also reset the auto-retry budget so transient failures resume self-healing.
          </p>
          ${pathsBlock}
          <div style="margin-top:24px;">
            <a href="${memberUrl}" style="display:inline-block;background:#1e4d2b;color:#4ade80;font-weight:600;font-size:13px;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:0.5px;">
              Open member 360 →
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            You are receiving this because you are a controller (org admin, membership secretary or treasurer)
            for ${escapeHtml(orgName)}. This alert fires once per member per retry-chain — kicking off a manual
            retry resets the budget and re-arms the alert if the cap is reached again.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "erasure_auto_retry_capped"));
}

/**
 * Task #1127 — instant alert emailed to org admins the moment a single
 * pending_storage_deletions row crosses the bounded-retry exhaustion
 * threshold. Distinct from the daily aggregate digest above:
 *   - fires once per row (dedup via pendingStorageDeletions.exhaustionNotifiedAt)
 *   - identifies the specific orphan path so on-call can grep audit history
 *   - links straight to the storage-failures admin view
 */
export async function sendErasureStorageFailureExhaustedEmail(opts: {
  to: string;
  staffName: string;
  baseUrl: string;
  orphanPath: string;
  attempts: number;
  lastError: string | null;
  clubMemberId: number | null;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, staffName, baseUrl, orphanPath, attempts, lastError, clubMemberId, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeStaffName = escapeHtml(staffName);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const dashboardUrl = `${trimmedBase}/privacy?panel=erasure-storage-failures`;
  const subject = `⚠️ Orphan file stuck after ${attempts} retries — manual cleanup needed`;

  const memberLine = clubMemberId
    ? `Originally enqueued during the erasure of <strong>member #${clubMemberId}</strong>.`
    : `The originating member record has already been removed.`;

  const errorBlock = lastError
    ? `<pre style="background:#1f2937;color:#f87171;padding:12px;border-radius:6px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:12px 0 0;">${escapeHtml(lastError)}</pre>`
    : "";

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Privacy & Data Protection")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">Orphan file cleanup exhausted retries</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Hi ${safeStaffName}, the auto-retry queue for ${escapeHtml(orgName)} has hit its bounded backoff cap on a
            file that should have been removed during a member account erasure. Because the row is past the
            ${attempts}-attempt threshold, a human now needs to investigate the underlying storage backend
            (typically an IAM / lifecycle issue) and clear the orphan manually.
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">${memberLine}</p>
          <p style="color:#fff;line-height:1.6;margin:8px 0 0;">
            <strong style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Path</strong><br/>
            <code style="color:#4ade80;font-size:13px;word-break:break-all;">${escapeHtml(orphanPath)}</code>
          </p>
          ${errorBlock}
          <div style="margin-top:24px;">
            <a href="${dashboardUrl}" style="display:inline-block;background:#1e4d2b;color:#4ade80;font-weight:600;font-size:13px;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:0.5px;">
              Open storage-failures view →
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            You are receiving this because you are an org admin for ${escapeHtml(orgName)}. The alert fires
            once per orphan file regardless of how many subsequent retry ticks the row sits through.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "erasure_storage_failure_exhausted"));
}

/**
 * Task #1249 — Background re-verification of saved external marketing-site
 * logo / favicon URLs. After the cron has seen N consecutive failures
 * against the live host (default 3 ≈ 3 days at the daily cadence) it
 * auto-clears the broken override and emails the org admins with the
 * dropped URL plus the most recent verifier error so they can paste a
 * working replacement. The public mini-site immediately falls back to
 * the org's generic logo / platform default favicon, so visitors stop
 * loading the broken reference even before any human acts.
 */
export async function sendMarketingImageBrokenEmail(opts: {
  to: string;
  staffName: string;
  baseUrl: string;
  /** "logo" or "favicon" — drives the subject line and copy. */
  imageKind: "logo" | "favicon";
  /** The URL that was just auto-cleared. */
  clearedUrl: string;
  /** Number of consecutive failed verifications that tripped the auto-clear. */
  consecutiveFailures: number;
  /** Most recent verifier error message (e.g. "image host returned HTTP 404"). */
  lastError: string | null;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, staffName, baseUrl, imageKind, clearedUrl, consecutiveFailures, lastError, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeStaffName = escapeHtml(staffName);
  const safeOrg = escapeHtml(orgName);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const editorUrl = `${trimmedBase}/marketing-site`;
  const kindLabel = imageKind === "logo" ? "Marketing logo" : "Favicon";
  const fallbackLine = imageKind === "logo"
    ? `Your public mini-site has switched back to the org's generic logo so visitors don't see a broken image while you investigate.`
    : `Your public mini-site has switched back to the platform default favicon so visitors don't see a broken icon while you investigate.`;
  const subject = `⚠️ ${kindLabel} on your KHARAGOLF mini-site stopped loading — auto-cleared`;

  const errorBlock = lastError
    ? `<pre style="background:#1f2937;color:#f87171;padding:12px;border-radius:6px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:12px 0 0;">${escapeHtml(lastError)}</pre>`
    : "";

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Marketing Site")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">${escapeHtml(kindLabel)} stopped loading</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Hi ${safeStaffName}, the ${escapeHtml(kindLabel.toLowerCase())} URL on your ${safeOrg} marketing site has failed
            ${consecutiveFailures} consecutive background re-checks against the live host. We've cleared the override
            so the public site stops trying to load it.
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">${fallbackLine}</p>
          <p style="color:#fff;line-height:1.6;margin:16px 0 0;">
            <strong style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Cleared URL</strong><br/>
            <code style="color:#4ade80;font-size:13px;word-break:break-all;">${escapeHtml(clearedUrl)}</code>
          </p>
          ${errorBlock}
          <div style="margin-top:24px;">
            <a href="${editorUrl}" style="display:inline-block;background:#1e4d2b;color:#4ade80;font-weight:600;font-size:13px;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:0.5px;">
              Open marketing-site editor →
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            You are receiving this because you are an org admin for ${safeOrg}. The alert fires once per
            URL when the auto-clear threshold is reached; pasting a new URL through the editor resets the
            re-check counter.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "marketing_image_broken"));
}

/**
 * Task #2259 — Email org admins when the periodic refresh job
 * (`refreshCachedMarketingImages`, Task #1467) has failed to re-download
 * a marketing-site `logoSourceUrl` / `faviconSourceUrl` for N consecutive
 * runs. Unlike `sendMarketingImageBrokenEmail` (Task #1249) the cached
 * copy is NOT cleared — the public mini-site keeps rendering — but the
 * upstream source has gone stale, so the cache will keep serving an
 * out-of-date image forever until an admin pastes a working URL. This
 * notice tells admins what host failed and what the verifier said so
 * they can re-paste a working URL (which both rotates the cache and
 * re-arms the failure counter for the next streak).
 */
export async function sendMarketingImageRefreshFailingEmail(opts: {
  to: string;
  staffName: string;
  baseUrl: string;
  /** "logo" or "favicon" — drives the subject line and copy. */
  imageKind: "logo" | "favicon";
  /** The source URL whose periodic re-download has been failing. */
  sourceUrl: string;
  /** Number of consecutive failed refresh attempts that tripped the alert. */
  consecutiveFailures: number;
  /** Most recent verifier error message (e.g. "image host returned HTTP 404"). */
  lastError: string | null;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, staffName, baseUrl, imageKind, sourceUrl, consecutiveFailures, lastError, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeStaffName = escapeHtml(staffName);
  const safeOrg = escapeHtml(orgName);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const editorUrl = `${trimmedBase}/marketing-site`;
  const kindLabel = imageKind === "logo" ? "Marketing logo" : "Favicon";
  let host: string;
  try {
    host = new URL(sourceUrl).host;
  } catch {
    host = sourceUrl;
  }
  const safeHost = escapeHtml(host);
  const subject = `⚠️ ${kindLabel} on your ${orgName} mini-site can no longer be refreshed from ${host}`;

  const errorBlock = lastError
    ? `<pre style="background:#1f2937;color:#f87171;padding:12px;border-radius:6px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:12px 0 0;">${escapeHtml(lastError)}</pre>`
    : "";

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Marketing Site")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">${escapeHtml(kindLabel)} cache is going stale</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Hi ${safeStaffName}, the ${escapeHtml(kindLabel.toLowerCase())} on your ${safeOrg} marketing site has failed
            ${consecutiveFailures} consecutive background refresh attempts against <strong style="color:#fff;">${safeHost}</strong>.
            We're still serving the cached copy so visitors don't see a broken image, but it will keep going stale until
            the upstream source comes back or you paste a fresh URL.
          </p>
          <p style="color:#fff;line-height:1.6;margin:16px 0 0;">
            <strong style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Source URL</strong><br/>
            <code style="color:#4ade80;font-size:13px;word-break:break-all;">${escapeHtml(sourceUrl)}</code>
          </p>
          ${errorBlock}
          <div style="margin-top:24px;">
            <a href="${editorUrl}" style="display:inline-block;background:#1e4d2b;color:#4ade80;font-weight:600;font-size:13px;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:0.5px;">
              Open marketing-site editor →
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            You are receiving this because you are an org admin for ${safeOrg}. The alert fires once per source URL when
            the consecutive-refresh-failure threshold is reached; pasting a new URL through the editor (or the source
            host coming back online) re-arms the counter for the next streak.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "marketing_image_refresh_failing"));
}

/**
 * Task #1975 — Digest emailed to org admins after the
 * `recheckLegacyVideoDurations` cron auto-flags one or more videos as
 * unverifiable in a single pass. Mirrors the per-admin pattern used by
 * `sendMarketingImageBrokenEmail` but lists every newly-flagged row in
 * a single message so admins aren't spammed with one email per video.
 *
 * Each row carries the object path (so admins can correlate against
 * storage), the uploader (so they know who to chase for a re-upload),
 * and the cron's reason (`object_missing` or `permanently_unverifiable`).
 */
export async function sendLegacyVideoUnverifiableDigestEmail(opts: {
  to: string;
  staffName: string;
  baseUrl: string;
  rows: Array<{
    mediaId: number;
    objectPath: string;
    uploaderName: string | null;
    reason: "object_missing" | "permanently_unverifiable";
  }>;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, staffName, baseUrl, rows, branding } = opts;
  if (rows.length === 0) return;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeStaffName = escapeHtml(staffName);
  const safeOrg = escapeHtml(orgName);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const dashboardUrl = `${trimmedBase}/media-admin`;
  const count = rows.length;
  const subject = `⚠️ ${count} video${count === 1 ? "" : "s"} auto-flagged as unverifiable on ${orgName}`;

  const reasonLabel = (r: "object_missing" | "permanently_unverifiable"): string =>
    r === "object_missing" ? "File missing from storage" : "Could not read duration";

  const rowsHtml = rows.map(r => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #1f2937;color:#fff;font-size:13px;vertical-align:top;">
        <code style="color:#4ade80;font-size:12px;word-break:break-all;">${escapeHtml(r.objectPath)}</code>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #1f2937;color:#9ca3af;font-size:13px;vertical-align:top;">
        ${escapeHtml(r.uploaderName ?? "Unknown uploader")}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #1f2937;color:${r.reason === "object_missing" ? "#f87171" : "#fbbf24"};font-size:12px;vertical-align:top;">
        ${escapeHtml(reasonLabel(r.reason))}
      </td>
    </tr>
  `).join("");

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:720px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Video Cleanup")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">${count} video${count === 1 ? "" : "s"} auto-flagged as unverifiable</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Hi ${safeStaffName}, the background re-check for ${safeOrg} gave up on the video${count === 1 ? "" : "s"} below after the
            auto-retry cap was reached. Each row will stay on the unverifiable-videos page until an admin either
            asks the uploader for a fresh file or removes the row.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0 0;background:#0f0f0f;border-radius:8px;overflow:hidden;">
            <thead>
              <tr>
                <th style="text-align:left;padding:10px 12px;background:#111827;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Object path</th>
                <th style="text-align:left;padding:10px 12px;background:#111827;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Uploader</th>
                <th style="text-align:left;padding:10px 12px;background:#111827;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Reason</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <div style="margin-top:24px;">
            <a href="${dashboardUrl}" style="display:inline-block;background:#1e4d2b;color:#4ade80;font-weight:600;font-size:13px;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:0.5px;">
              Open video cleanup →
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            You are receiving this because you are an org admin for ${safeOrg}. The digest fires once per row when
            the auto-retry cap is reached; rows already included in a previous digest are not re-sent.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "legacy_video_unverifiable_digest"));
}

/**
 * Task #1313 — Render the small "first surfaced X ago" line under each
 * digest row. Returns the empty string when no `firstDigestedAt` is
 * provided (e.g. older callers / tests, or when the persistence write
 * failed and we degraded gracefully).
 *
 * Buckets:
 *   - <1h           → "first surfaced just now"   (grey)
 *   - <24h          → "first surfaced N hours ago"(grey)
 *   - <7 days       → "first surfaced N days ago" (amber — needs triage)
 *   - >=7 days      → "first surfaced N days ago" (red — clearly stale)
 */
function renderFirstSurfacedLine(firstDigestedAt: string | null): string {
  if (!firstDigestedAt) return "";
  const ts = new Date(firstDigestedAt).getTime();
  if (!Number.isFinite(ts)) return "";
  const diffMs = Math.max(0, Date.now() - ts);
  const oneHour = 60 * 60 * 1000;
  const oneDay = 24 * oneHour;

  let label: string;
  if (diffMs < oneHour) {
    label = "first surfaced just now";
  } else if (diffMs < oneDay) {
    const hours = Math.floor(diffMs / oneHour);
    label = `first surfaced ${hours} hour${hours === 1 ? "" : "s"} ago`;
  } else {
    const days = Math.floor(diffMs / oneDay);
    label = `first surfaced ${days} day${days === 1 ? "" : "s"} ago`;
  }

  // Stale-row colour ramp — keeps the grey baseline for "fresh" rows so
  // the new line doesn't shout when nothing is actually old.
  const colour = diffMs >= 7 * oneDay
    ? "#f87171" // red — definitely stale
    : diffMs >= oneDay
      ? "#fbbf24" // amber — a day-plus old, worth surfacing
      : "#9ca3af"; // grey — fresh, matches the existing meta line

  return `<div style="color:${colour};font-size:12px;margin-top:2px;">⏱ ${escapeHtml(label)}</div>`;
}

/**
 * Notify super admins when the legacy plan-tier migration (Task #514) has
 * unacknowledged audit rows — i.e. clubs that were silently reset to Free
 * because their stored tier slug was unrecognised. Linked directly to the
 * Super Admin → Plan Migration Audit panel so one click triages.
 *
 * Task #980 — each row also carries a one-click "Acknowledge" link signed
 * with a short-lived super-admin-only token (`plan-migration-ack-token.ts`).
 * Hitting it stamps the audit metadata as acknowledged without requiring
 * re-login. Tokens are per (auditId, recipient userId) and the route only
 * stamps rows that are still unacknowledged, so a leaked / re-clicked link
 * cannot cause duplicate or impersonated acks.
 *
 * Task #1313 — each row also carries a "first surfaced X ago" line so
 * recipients can see at a glance how long an unacknowledged row has been
 * sitting across digest cycles.
 */
/**
 * Task #1906 — categorical trigger that flows from the super-admin
 * notifier into the email subject + per-row chip so plan-cancellation
 * emails are distinguishable from unknown-tier auto-resets at a glance.
 *
 * Re-declared here as a string literal union (rather than imported from
 * `planMigrationDigest`) because mailer.ts is imported BY
 * planMigrationDigest.ts at module load — pulling a runtime value back
 * the other way would create a circular value-import. The two
 * declarations are deliberately kept identical; if you add a variant in
 * one place, mirror it in the other.
 */
type PlanMigrationTriggerReason = "cancelled" | "unknown_tier" | "manual";

/**
 * Task #1906 — subject line that varies by trigger so a super admin
 * scanning their inbox can tell genuine churn (`'cancelled'`) from a
 * slug-mapping bug (`'unknown_tier'`) without opening the message.
 *
 * Mirrors the push-title mapping in
 * `artifacts/api-server/src/lib/planMigrationDigest.ts`
 * (`planMigrationPushTitle`) so both channels stay coherent.
 */
export function planMigrationEmailSubject(
  totalUnacknowledged: number,
  triggerReason: PlanMigrationTriggerReason | null,
): string {
  const plural = totalUnacknowledged === 1 ? "" : "s";
  switch (triggerReason) {
    case "cancelled":
      return totalUnacknowledged === 1
        ? "⚠️ Club cancelled paid plan — review needed"
        : `⚠️ ${totalUnacknowledged} clubs cancelled paid plans — review needed`;
    case "unknown_tier":
      return totalUnacknowledged === 1
        ? "⚠️ Club auto-reset (unknown tier) — review needed"
        : `⚠️ ${totalUnacknowledged} clubs auto-reset (unknown tier) — review needed`;
    case "manual":
      return totalUnacknowledged === 1
        ? "Club plan re-migrated by super admin — review needed"
        : `${totalUnacknowledged} clubs re-migrated by super admin — review needed`;
    default:
      return `⚠️ ${totalUnacknowledged} club${plural} auto-reset to Free — review needed`;
  }
}

/**
 * Task #1906 — per-row chip rendered next to the tier-change line so the
 * cron digest (which can mix triggers across rows) is still self-evident.
 * Returns an empty string for null triggers so legacy / pre-Task #1906
 * rows don't render an empty placeholder.
 */
function renderTriggerReasonChip(triggerReason: PlanMigrationTriggerReason | null): string {
  if (!triggerReason) return "";
  // Colours mirror the panel chip in artifacts/kharagolf-web/src/pages/super-admin.tsx
  // so inbox-triage and panel-triage carry the same visual signal.
  const config: Record<PlanMigrationTriggerReason, { label: string; bg: string; fg: string; border: string }> = {
    cancelled:    { label: "Cancellation",  bg: "#3b1e1e", fg: "#fca5a5", border: "#b91c1c" },
    unknown_tier: { label: "Unknown tier",  bg: "#3a2e0e", fg: "#fbbf24", border: "#b45309" },
    manual:       { label: "Manual",        bg: "#1e293b", fg: "#93c5fd", border: "#1d4ed8" },
  };
  const { label, bg, fg, border } = config[triggerReason];
  return `<span style="display:inline-block;background:${bg};color:${fg};border:1px solid ${border};font-size:10px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;padding:2px 6px;border-radius:4px;margin-left:6px;vertical-align:middle;">${escapeHtml(label)}</span>`;
}

export async function sendPlanMigrationDigestEmail(opts: {
  to: string;
  staffName: string;
  baseUrl: string;
  totalUnacknowledged: number;
  rows: Array<{
    id: number;
    organizationId: number | null;
    orgName: string | null;
    orgSlug: string | null;
    fromTier: string | null;
    toTier: string | null;
    createdAt: string;
    /**
     * Pre-signed one-click acknowledge URL for this row, scoped to the
     * recipient super admin. Optional so older callers / tests don't break,
     * but the dispatcher always provides it in production.
     */
    acknowledgeUrl?: string;
    /**
     * Task #1313 — ISO timestamp of the first digest dispatch that surfaced
     * this row to super admins. Rendered as a "first surfaced X days ago"
     * line so recipients can spot stale, unacknowledged rows that have sat
     * across multiple digest cycles. Optional so older callers / tests don't
     * break; when absent or null the age line is omitted.
     */
    firstDigestedAt?: string | null;
    /**
     * Task #1906 — per-row trigger so cron digests with mixed triggers
     * still render an unambiguous chip next to each row. Optional so
     * older callers / tests don't break; legacy rows render no chip.
     */
    triggerReason?: PlanMigrationTriggerReason | null;
  }>;
  /**
   * Task #1145 — Optional summary of rows acknowledged since the previous
   * digest. Rendered as a small footer line so recipients see their prior
   * clicks reflected in the inbox even though those rows are correctly
   * filtered out of the unacknowledged list above.
   */
  recentlyAcknowledged?: {
    count: number;
    lastAcknowledgedAt: string | null;
  };
  /**
   * Task #1906 — when the realtime path knows the single trigger that
   * fired the dispatch, it passes it here so the subject line is
   * specialised. Cron digests can also pass this when every queued row
   * shares one trigger; otherwise leave `null` for the generic subject.
   */
  triggerReason?: PlanMigrationTriggerReason | null;
}): Promise<void> {
  const { to, staffName, baseUrl, totalUnacknowledged, rows, recentlyAcknowledged, triggerReason } = opts;
  const safeStaffName = escapeHtml(staffName);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const panelUrl = `${trimmedBase}/super-admin?panel=plan-migration-audit`;
  const subject = planMigrationEmailSubject(totalUnacknowledged, triggerReason ?? null);

  const rowsHtml = rows.map(r => {
    const orgLabel = r.orgName ?? `Org #${r.organizationId ?? "?"}`;
    const slugLabel = r.orgSlug ? ` <span style="color:#6b7280;">(${escapeHtml(r.orgSlug)})</span>` : "";
    const created = new Date(r.createdAt).toLocaleString("en", {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    // Task #1313 — show how long this row has been sitting unacknowledged
    // across digest cycles so stale rows stand out. Colour ramps from
    // grey (fresh) → amber (>=1 day) → red (>=7 days) for at-a-glance triage.
    const firstSurfacedHtml = renderFirstSurfacedLine(r.firstDigestedAt ?? null);
    const ackButton = r.acknowledgeUrl
      ? `<div style="margin-top:8px;">
          <a href="${r.acknowledgeUrl}" style="display:inline-block;background:#1e4d2b;color:#4ade80;font-weight:600;font-size:12px;padding:6px 14px;border-radius:6px;text-decoration:none;letter-spacing:0.5px;">
            ✓ Acknowledge
          </a>
        </div>`
      : "";
    // Task #1906 — chip the trigger reason next to the org name so the
    // cron digest (which can mix triggers) is unambiguous per row even
    // when the subject falls back to the generic "auto-reset to Free".
    const triggerChip = renderTriggerReasonChip(r.triggerReason ?? null);
    return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #1f2937;vertical-align:top;">
          <div style="color:#fff;font-weight:600;font-size:14px;">${escapeHtml(orgLabel)}${slugLabel}${triggerChip}</div>
          <div style="color:#9ca3af;font-size:12px;margin-top:2px;">
            Reset ${escapeHtml(String(r.fromTier ?? "unknown"))} → ${escapeHtml(String(r.toTier ?? "free"))} · ${created}
          </div>
          ${firstSurfacedHtml}
          ${ackButton}
        </td>
      </tr>
    `;
  }).join("");

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(undefined, "Super Admin")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">Plan migration audit — review needed</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Hi ${safeStaffName}, ${totalUnacknowledged} club${totalUnacknowledged === 1 ? " was" : "s were"} auto-reset to the Free plan
            by the legacy tier migration and ${totalUnacknowledged === 1 ? "has" : "have"} not yet been acknowledged in the Plan Migration Audit panel.
            Paying clubs left on Free will not be re-charged until you fix this.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:8px 0 0;">
            <tbody>${rowsHtml}</tbody>
          </table>
          <p style="margin:32px 0 0;">
            <a href="${panelUrl}" style="display:inline-block;background:#4ade80;color:#0a0a0a;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">
              Open Plan Migration Audit
            </a>
          </p>
          ${
            recentlyAcknowledged && recentlyAcknowledged.count > 0
              ? `<p style="color:#9ca3af;font-size:12px;margin:24px 0 0;border-top:1px solid #1f2937;padding-top:16px;">
                   ✓ ${recentlyAcknowledged.count} row${recentlyAcknowledged.count === 1 ? " was" : "s were"} already acknowledged since the last digest${
                     recentlyAcknowledged.lastAcknowledgedAt
                       ? ` (last on ${escapeHtml(new Date(recentlyAcknowledged.lastAcknowledgedAt).toLocaleString("en", {
                           year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                         }))})`
                       : ""
                   } — those are no longer listed above.
                 </p>`
              : ""
          }
          <p style="color:#6b7280;font-size:12px;margin:24px 0 0;">
            You are receiving this because you are a super admin. The digest stops as soon as every row is acknowledged.
          </p>
        </div>
      </div>
    `,
  }, flowHints(undefined, "plan_migration_digest"));
}

/**
 * Sent to every recipient of the bounced-levy reminders digest whenever an
 * admin changes its schedule (frequency / hour / timezone) on the club
 * settings page. Helps admin teams stay aligned and catch accidental edits
 * (e.g. someone moves the digest to 03:00 by mistake). Task #319.
 */
export async function sendBouncedDigestScheduleChangedEmail(opts: {
  to: string;
  recipientName: string;
  changedByName: string;
  oldSchedule: { frequency: string; hourLocal: number | null; timezone: string | null };
  newSchedule: { frequency: string; hourLocal: number | null; timezone: string | null };
  baseUrl: string;
  /** Per-recipient one-click opt-out link (Task #387). */
  unsubscribeUrl?: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, recipientName, changedByName, oldSchedule, newSchedule, baseUrl, unsubscribeUrl, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const subject = `Bounced-reminders digest schedule updated — ${orgName}`;

  function describe(s: { frequency: string; hourLocal: number | null; timezone: string | null }): string {
    const freqLabel = s.frequency === "weekday"
      ? "Weekdays only"
      : s.frequency === "weekly"
        ? "Weekly (Mondays)"
        : "Daily";
    const hourLabel = s.hourLocal === null
      ? "first cron tick of the day"
      : `${String(s.hourLocal).padStart(2, "0")}:00`;
    const tzLabel = s.timezone ?? "UTC";
    return `${freqLabel} at ${hourLabel} (${tzLabel})`;
  }

  const oldLine = escapeHtml(describe(oldSchedule));
  const newLine = escapeHtml(describe(newSchedule));
  const safeRecipient = escapeHtml(recipientName);
  const safeChangedBy = escapeHtml(changedByName);
  const safeOrg = escapeHtml(orgName);
  const settingsLink = `${trimmedBase}/club-settings`;

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Levy Reminders")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#4ade80;">Digest schedule updated</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 20px;">
            Hi ${safeRecipient}, ${safeChangedBy} just updated the bounced-levy reminders
            digest schedule for ${safeOrg}. You're receiving this confirmation because you
            currently get the digest.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:8px 0 16px;">
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid #1f2937;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:2px;">Previous</td>
              <td style="padding:10px 0;border-bottom:1px solid #1f2937;color:#9ca3af;text-align:right;">${oldLine}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid #1f2937;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:2px;">New</td>
              <td style="padding:10px 0;border-bottom:1px solid #1f2937;color:#4ade80;font-weight:600;text-align:right;">${newLine}</td>
            </tr>
          </table>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            If this wasn't you or it looks wrong, an org admin can adjust it on the club settings page.
          </p>
          <a href="${settingsLink}" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;letter-spacing:1px;">
            Open club settings
          </a>
          ${unsubscribeUrl ? `
          <p style="color:#6b7280;font-size:11px;line-height:1.6;margin:32px 0 0;border-top:1px solid #1f2937;padding-top:16px;">
            Don't want these schedule-change notifications? You'll keep getting the
            regular digest itself.
            <a href="${unsubscribeUrl}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe from schedule-change emails</a>.
          </p>` : ""}
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "bounced_digest_schedule_changed"));
}

// Task #668 — Notify club admins when their custom-domain HTTPS provisioning
// transitions to 'active' (so they can announce the new URL) or 'failed' (so
// they can fix DNS). De-duplication is enforced by the caller via the
// custom_domain_cert_notified_(status|host) columns on the organizations row.
export async function sendCustomDomainHttpsActiveEmail(opts: {
  to: string;
  recipientName: string;
  host: string;
  baseUrl: string;
  branding?: EmailBranding;
  /** Task #817 — render the email in the org's default language with EN fallback. */
  lang?: string | null;
}): Promise<void> {
  const { to, recipientName, host, baseUrl, branding, lang } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const safeHost = escapeHtml(host);
  const safeRecipient = escapeHtml(recipientName);
  const safeOrg = escapeHtml(orgName);
  const liveUrl = `https://${host}`;
  const settingsLink = `${trimmedBase}/club-settings`;
  const strings = getCustomDomainEmailStrings(lang);
  const subject = fmtTemplate(strings.active.subject, { host, orgName });
  const greeting = fmtTemplate(strings.active.greeting, {
    recipient: safeRecipient,
    host: safeHost,
    orgName: safeOrg,
  });
  const ctaText = fmtTemplate(strings.active.cta, { host: safeHost });
  const footer = fmtTemplate(strings.active.footer, {
    settingsLinkOpen: `<a href="${settingsLink}" style="color:#9ca3af;text-decoration:underline;">`,
    settingsLinkClose: "</a>",
  });

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, strings.headerTag)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#4ade80;">${escapeHtml(strings.active.heading)}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 20px;">
            ${greeting}
          </p>
          <p style="margin:0 0 24px;">
            <a href="${escapeHtml(liveUrl)}" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;letter-spacing:1px;">
              ${ctaText}
            </a>
          </p>
          <p style="color:#6b7280;font-size:12px;line-height:1.6;margin:24px 0 0;border-top:1px solid #1f2937;padding-top:16px;">
            ${footer}
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "custom_domain_https_active"));
}

export async function sendCustomDomainHttpsFailedEmail(opts: {
  to: string;
  recipientName: string;
  host: string;
  errorMessage: string | null;
  baseUrl: string;
  branding?: EmailBranding;
  /** Task #817 — render the email in the org's default language with EN fallback. */
  lang?: string | null;
  /**
   * Task #1255 — When provided, render a one-line ETA telling the admin
   * when the next re-nudge will land if they don't fix the cert. Caller
   * computes this from `CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS` so the
   * date stays in sync with the threshold + the in-app panel line added
   * by Task #1100.
   */
  nextReminderAt?: Date | null;
  /**
   * Task #1262 — When provided, render a one-line header above the body
   * acknowledging that the admin's snooze just elapsed and re-nudges have
   * resumed. Only set by callers that know this re-nudge fired because
   * the snooze window ended (vs simply because the threshold passed).
   */
  previouslySnoozedUntil?: Date | null;
}): Promise<void> {
  const { to, recipientName, host, errorMessage, baseUrl, branding, lang, nextReminderAt, previouslySnoozedUntil } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const safeHost = escapeHtml(host);
  const safeRecipient = escapeHtml(recipientName);
  const safeOrg = escapeHtml(orgName);
  const settingsLink = `${trimmedBase}/club-settings`;
  const strings = getCustomDomainEmailStrings(lang);
  const subject = fmtTemplate(strings.failed.subject, { host, orgName });
  const greeting = fmtTemplate(strings.failed.greeting, {
    recipient: safeRecipient,
    host: safeHost,
  });
  const retry = fmtTemplate(strings.failed.retry, { orgName: safeOrg });
  // Provider-error fallback copy is also localised so the whole email stays
  // in the recipient's language even when the upstream provider returns null.
  const safeError = escapeHtml(errorMessage ?? strings.failed.noReason);

  // Helper: format a Date in the recipient's language using
  // Intl.DateTimeFormat (long style); if the locale has no ICU data Node
  // gracefully falls back to English so the email still renders fine.
  const formatLocalisedDate = (d: Date): string => {
    try {
      return new Intl.DateTimeFormat(lang ?? "en", { dateStyle: "long" }).format(d);
    } catch {
      return new Intl.DateTimeFormat("en", { dateStyle: "long" }).format(d);
    }
  };

  // Task #1255 — Render the localised "next reminder on <date>" line below
  // the retry sentence.
  let nextReminderHtml = "";
  if (nextReminderAt instanceof Date && !isNaN(nextReminderAt.getTime())) {
    const nextReminderText = fmtTemplate(strings.failed.nextReminder, {
      date: escapeHtml(formatLocalisedDate(nextReminderAt)),
    });
    nextReminderHtml = `
          <p style="color:#6b7280;line-height:1.6;margin:0 0 24px;font-size:13px;">
            ${nextReminderText}
          </p>`;
  }

  // Task #1262 — Render the localised "you snoozed this until X — that
  // snooze has now ended" header at the top of the email body so admins
  // immediately see why the re-nudge is back. Only set by the re-nudge
  // job when the snooze window just elapsed (not on the initial failed
  // transition or on threshold-only re-nudges).
  let snoozeEndedHtml = "";
  if (previouslySnoozedUntil instanceof Date && !isNaN(previouslySnoozedUntil.getTime())) {
    const snoozeEndedText = fmtTemplate(strings.failed.snoozeEnded, {
      date: escapeHtml(formatLocalisedDate(previouslySnoozedUntil)),
    });
    snoozeEndedHtml = `
          <div style="background:#1e1b00;border:1px solid #422006;border-radius:8px;padding:12px 14px;margin:0 0 20px;">
            <p style="margin:0;color:#fde68a;font-size:13px;line-height:1.5;">
              ${snoozeEndedText}
            </p>
          </div>`;
  }

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, strings.headerTag)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f87171;">${escapeHtml(strings.failed.heading)}</h2>${snoozeEndedHtml}
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 20px;">
            ${greeting}
          </p>
          <div style="background:#1f1300;border:1px solid #422006;border-radius:8px;padding:14px 16px;margin:0 0 20px;">
            <p style="margin:0;color:#fbbf24;font-size:12px;text-transform:uppercase;letter-spacing:2px;">${escapeHtml(strings.failed.providerErrorLabel)}</p>
            <p style="margin:6px 0 0;color:#fde68a;font-size:13px;line-height:1.5;">${safeError}</p>
          </div>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            ${retry}
          </p>${nextReminderHtml}
          <a href="${settingsLink}" style="display:inline-block;background:#ef4444;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;letter-spacing:1px;">
            ${escapeHtml(strings.failed.cta)}
          </a>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "custom_domain_https_failed"));
}

export async function sendPairingsEmail(opts: {
  to: string;
  name: string;
  tournamentName: string;
  teeTime: Date;
  startingHole: number;
  partners: string[];
  /** Task #1140 — optional org id forwarded as `metadata.orgId` for bounce attribution. */
  orgId?: number;
}): Promise<void> {
  const { to, name, tournamentName, teeTime, startingHole, partners } = opts;
  const timeStr = teeTime.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
  const dateStr = teeTime.toLocaleDateString("en", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const partnersHtml = partners.length > 0
    ? `<p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">You will play with: <strong style="color:#fff">${partners.join(", ")}</strong></p>`
    : "";
  await sendMail({
    from: FROM,
    to,
    subject: `⛳ Tee Times Published — ${tournamentName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="background:#1e4d2b;padding:32px 40px;">
          <h1 style="margin:0;font-size:24px;letter-spacing:4px;font-weight:900;">KHARAGOLF</h1>
          <p style="margin:4px 0 0;font-size:11px;letter-spacing:3px;color:#4ade80;text-transform:uppercase;">Enterprise</p>
        </div>
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;">⛳ Tee Times are Published!</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">Hi ${name},</p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:24px;margin-bottom:24px;">
            <p style="margin:0 0 4px;font-size:13px;color:#9ca3af;text-transform:uppercase;letter-spacing:2px;">Your Tee Time</p>
            <p style="margin:0;font-size:28px;font-weight:800;color:#C9A84C;">${timeStr}</p>
            <p style="margin:4px 0 0;font-size:14px;color:#9ca3af;">${dateStr}</p>
            <p style="margin:12px 0 0;font-size:15px;color:#fff;">Starting Hole: <strong>#${startingHole}</strong></p>
          </div>
          ${partnersHtml}
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            This is an automated notification from KHARAGOLF Enterprise for ${tournamentName}.
          </p>
        </div>
      </div>
    `,
  }, flowHints(opts.orgId, "pairings"));
}

export async function sendTournamentResultsEmail(opts: {
  to: string;
  name: string;
  tournamentName: string;
  orgName: string;
  results: { position: number; playerName: string; gross: number; net?: number | null; toPar?: number | null; points?: number | null }[];
  leaderboardUrl: string;
  /** Task #1140 — optional org id forwarded as `metadata.orgId` for bounce attribution. */
  orgId?: number;
}): Promise<void> {
  const { to, name, tournamentName, orgName, results, leaderboardUrl } = opts;
  const podiumRows = results.slice(0, 3).map(r => {
    const medal = r.position === 1 ? "🥇" : r.position === 2 ? "🥈" : "🥉";
    const score = r.points != null ? `${r.points} pts` : r.net != null ? `${r.gross} / Net ${r.net}` : `${r.gross}`;
    const toPar = r.toPar != null ? (r.toPar === 0 ? "E" : r.toPar > 0 ? `+${r.toPar}` : `${r.toPar}`) : "";
    return `<tr>
      <td style="padding:12px 16px;font-size:20px;">${medal}</td>
      <td style="padding:12px 16px;font-size:15px;font-weight:700;color:#fff;">${r.playerName}</td>
      <td style="padding:12px 16px;font-size:15px;color:#C9A84C;font-weight:700;text-align:right;">${score}${toPar ? ` (${toPar})` : ""}</td>
    </tr>`;
  }).join("");
  await sendMail({
    from: FROM,
    to,
    subject: `🏆 Results: ${results[0]?.playerName ?? "Results"} wins ${tournamentName}!`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="background:#1e4d2b;padding:32px 40px;">
          <h1 style="margin:0;font-size:24px;letter-spacing:4px;font-weight:900;">KHARAGOLF</h1>
          <p style="margin:4px 0 0;font-size:11px;letter-spacing:3px;color:#4ade80;text-transform:uppercase;">Enterprise · ${orgName}</p>
        </div>
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:22px;">🏆 Final Results</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">${tournamentName} has concluded. Here are the final standings:</p>
          <table style="width:100%;border-collapse:collapse;background:#111;border-radius:12px;overflow:hidden;margin-bottom:24px;">
            <tbody>${podiumRows}</tbody>
          </table>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 32px;">
            Full leaderboard and statistics are available on the tournament page.
          </p>
          <a href="${leaderboardUrl}" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
            View Full Leaderboard
          </a>
        </div>
      </div>
    `,
  }, flowHints(opts.orgId, "tournament_results"));
}

export async function sendShopOrderConfirmationEmail(opts: {
  to: string;
  name: string;
  orderNumber: string;
  totalAmount: number;
  currency: string;
  items: { name: string; quantity: number; price: number }[];
  branding?: EmailBranding;
}): Promise<void> {
  const { to, name, orderNumber, totalAmount, currency, items, branding } = opts;
  const itemsHtml = items.map(item => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #ffffff10;">
        <p style="margin:0;color:#fff;font-weight:600;">${item.name}</p>
        <p style="margin:4px 0 0;color:#6b7280;font-size:12px;">Qty: ${item.quantity}</p>
      </td>
      <td style="padding:12px 0;text-align:right;vertical-align:top;border-bottom:1px solid #ffffff10;color:#fff;font-weight:600;">
        ${currency} ${(item.price * item.quantity).toFixed(2)}
      </td>
    </tr>
  `).join("");

  await sendMail({
    from: FROM,
    to,
    subject: `Order Confirmed — #${orderNumber}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Club Shop")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#4ade80;">Order Confirmed!</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">Hi ${name}, thank you for your order. We're getting it ready for you.</p>
          
          <div style="background:#111;border-radius:12px;padding:24px;margin-bottom:24px;">
            <p style="margin:0 0 16px;font-size:13px;color:#9ca3af;text-transform:uppercase;letter-spacing:2px;">Order Summary #${orderNumber}</p>
            <table style="width:100%;border-collapse:collapse;">
              ${itemsHtml}
              <tr>
                <td style="padding:16px 0 0;color:#9ca3af;font-weight:600;">Total</td>
                <td style="padding:16px 0 0;text-align:right;color:#4ade80;font-size:20px;font-weight:900;">${currency} ${totalAmount.toFixed(2)}</td>
              </tr>
            </table>
          </div>

          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            You will receive another email once your order has been fulfilled.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "shop_order_confirmation"));
}

export async function sendShopOrderUpdateEmail(opts: {
  to: string;
  name: string;
  orderNumber: string;
  status: "fulfilled" | "cancelled";
  branding?: EmailBranding;
}): Promise<void> {
  const { to, name, orderNumber, status, branding } = opts;
  const isFulfilled = status === "fulfilled";
  const statusColor = isFulfilled ? "#4ade80" : "#ef4444";
  const statusText = isFulfilled ? "Fulfilled" : "Cancelled";
  const bodyText = isFulfilled 
    ? "Great news! Your order has been fulfilled and is ready."
    : "We're sorry, but your order has been cancelled. If you've already been charged, a refund will be processed shortly.";

  await sendMail({
    from: FROM,
    to,
    subject: `Order Update — #${orderNumber}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Club Shop")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:${statusColor};">Order ${statusText}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">Hi ${name},</p>
          <p style="color:#e5e7eb;line-height:1.6;margin:0 0 24px;">${bodyText}</p>
          <div style="background:#111;border:1px solid ${statusColor}33;border-radius:8px;padding:16px;">
            <p style="margin:0;color:#9ca3af;font-size:13px;">Order Number: <strong style="color:#fff;">#${orderNumber}</strong></p>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            If you have any questions, please contact the club shop.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "shop_order_update"));
}

export async function sendNoticeBoardEmail(opts: {
  to: string;
  name: string;
  title: string;
  content: string;
  orgName: string;
  authorName?: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, name, title, content, orgName, authorName, branding } = opts;
  await sendMail({
    from: FROM,
    to,
    subject: `New Notice: ${title} — ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Notice Board")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 24px;font-size:22px;color:#fff;">${title}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">Hi ${name},</p>
          <div style="color:#e5e7eb;line-height:1.8;white-space:pre-wrap;margin:0 0 32px;">${content}</div>
          <div style="border-top:1px solid #ffffff10;padding-top:24px;">
            <p style="margin:0;color:#6b7280;font-size:12px;">Posted by ${authorName || "Club Admin"}</p>
            <p style="margin:4px 0 0;color:#6b7280;font-size:12px;">${orgName}</p>
          </div>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "notice_board"));
}

export async function sendLockerReminderEmail(
  to: string,
  name: string,
  type: "30_days" | "7_days" | "available",
  opts?: { lockerNumber?: string; expiryDate?: string; paymentUrl?: string; branding?: EmailBranding },
) {
  const { lockerNumber, expiryDate, paymentUrl, branding } = opts ?? {};

  const subjects: Record<string, string> = {
    "30_days": `Locker Renewal Reminder — 30 days to go`,
    "7_days": `Urgent: Locker Renewal Due in 7 Days`,
    "available": `A Locker is Available for You`,
  };

  const bodies: Record<string, string> = {
    "30_days": `Your locker${lockerNumber ? ` <strong style="color:#fff">${lockerNumber}</strong>` : ""} rental expires on <strong style="color:#fff">${expiryDate ?? "soon"}</strong>. You have 30 days to renew.`,
    "7_days": `<strong style="color:#e11d48;">Action required:</strong> Your locker${lockerNumber ? ` <strong style="color:#fff">${lockerNumber}</strong>` : ""} rental expires on <strong style="color:#fff">${expiryDate ?? "soon"}</strong> — only 7 days left!`,
    "available": `Great news! A locker has become available at your club. Contact the club office or visit the member portal to secure your spot.`,
  };

  const ctaHtml = paymentUrl
    ? `<a href="${paymentUrl}" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;margin-top:24px;">
        Pay Renewal Fee
       </a>`
    : "";

  await sendMail({
    from: FROM,
    to,
    subject: subjects[type] ?? subjects["30_days"],
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Locker Management")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Hi ${name},</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">${bodies[type]}</p>
          ${ctaHtml}
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            If you have already renewed, please disregard this email. Contact the club office for queries.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "locker_reminder"));
}

// ─── TASK #109: EVENT & BANQUET EMAILS ────────────────────────────────────────

export async function sendEventEnquiryAck(
  to: string,
  organiserName: string,
  eventName: string,
  branding?: EmailBranding,
): Promise<void> {
  const orgName = branding?.orgName ?? "KHARAGOLF";
  await sendMail({
    from: FROM,
    to,
    subject: `Enquiry received — ${eventName} | ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Events & Functions")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Thank you for your enquiry!</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${organiserName},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            We have received your function enquiry for <strong style="color:#fff">${eventName}</strong>.
            Our events team will review the details and get back to you with a personalised quote within 2 business days.
          </p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:20px;margin:0 0 24px;">
            <p style="margin:0;color:#4ade80;font-size:13px;font-weight:600;">What happens next?</p>
            <ol style="margin:12px 0 0;padding-left:20px;color:#9ca3af;line-height:2;">
              <li>Our team reviews your requirements</li>
              <li>We check space availability for your date</li>
              <li>A detailed quote is prepared and sent to you</li>
              <li>You confirm and we lock in your booking</li>
            </ol>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;">
            If you need to reach us sooner, please contact the club directly.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "event_enquiry_ack"));
}

export async function sendEventQuote(
  to: string,
  organiserName: string,
  eventName: string,
  branding?: EmailBranding,
): Promise<void> {
  const orgName = branding?.orgName ?? "KHARAGOLF";
  await sendMail({
    from: FROM,
    to,
    subject: `Your function quote — ${eventName} | ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Events & Functions")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Your Quote is Ready</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${organiserName},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            We are delighted to provide a quote for <strong style="color:#fff">${eventName}</strong>.
            Please find the details in the attached quote or contact our events team to discuss further.
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            To confirm your booking, simply reply to this email or contact the club directly. 
            We look forward to hosting your event!
          </p>
          <p style="color:#6b7280;font-size:12px;margin:0;">
            Quotes are valid for 14 days. Availability is subject to change until a deposit is received.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "event_quote"));
}

export async function sendEventConfirmation(
  to: string,
  organiserName: string,
  eventName: string,
  eventDate: Date,
  branding?: EmailBranding,
): Promise<void> {
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const dateStr = eventDate.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  await sendMail({
    from: FROM,
    to,
    subject: `Booking confirmed — ${eventName} | ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Events & Functions")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Your Booking is Confirmed!</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${organiserName},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            We're thrilled to confirm your function booking with <strong style="color:#fff">${orgName}</strong>.
          </p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:20px;margin:0 0 24px;">
            <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#4ade80;">${eventName}</p>
            <p style="margin:0;color:#9ca3af;font-size:14px;">📅 ${dateStr}</p>
          </div>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            Our events coordinator will be in touch with you closer to the date to confirm final guest numbers,
            seating arrangements, and any last-minute details.
          </p>
          <p style="color:#6b7280;font-size:12px;margin:0;">
            Please retain this confirmation for your records. We look forward to seeing you!
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "event_confirmation"));
}

export async function sendEventInvoice(
  to: string,
  organiserName: string,
  eventName: string,
  invoiceNumber: string,
  totalAmount: string,
  currency: string,
  dueDate: Date | null | undefined,
  branding?: EmailBranding,
): Promise<void> {
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const dueDateStr = dueDate ? dueDate.toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" }) : "On request";
  await sendMail({
    from: FROM,
    to,
    subject: `Invoice ${invoiceNumber} — ${eventName} | ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Events & Functions")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Invoice ${invoiceNumber}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${organiserName},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            Please find your invoice for <strong style="color:#fff">${eventName}</strong> below.
          </p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr>
                <td style="color:#9ca3af;padding:4px 0;font-size:13px;">Invoice Number</td>
                <td style="color:#fff;text-align:right;font-size:13px;font-weight:600;">${invoiceNumber}</td>
              </tr>
              <tr>
                <td style="color:#9ca3af;padding:4px 0;font-size:13px;">Total Amount</td>
                <td style="color:#4ade80;text-align:right;font-size:18px;font-weight:700;">${currency} ${parseFloat(totalAmount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
              </tr>
              <tr>
                <td style="color:#9ca3af;padding:4px 0;font-size:13px;">Due Date</td>
                <td style="color:#fff;text-align:right;font-size:13px;">${dueDateStr}</td>
              </tr>
            </table>
          </div>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            Please make payment by the due date. Contact us if you have any queries about this invoice.
          </p>
          <p style="color:#6b7280;font-size:12px;margin:0;">
            ${orgName} — Events & Functions
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "event_invoice"));
}

export async function sendEventReminder(
  to: string,
  organiserName: string,
  eventName: string,
  eventDate: Date,
  daysUntil: number,
  branding?: EmailBranding,
): Promise<void> {
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const dateStr = eventDate.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  await sendMail({
    from: FROM,
    to,
    subject: `Reminder: ${eventName} is in ${daysUntil} day${daysUntil !== 1 ? "s" : ""} | ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Events & Functions")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Event Reminder</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${organiserName},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            This is a friendly reminder that your event is coming up soon!
          </p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:20px;margin:0 0 24px;">
            <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#4ade80;">${eventName}</p>
            <p style="margin:0;color:#9ca3af;font-size:14px;">📅 ${dateStr}</p>
            <p style="margin:8px 0 0;color:#fff;font-size:14px;font-weight:600;">⏰ ${daysUntil} day${daysUntil !== 1 ? "s" : ""} to go!</p>
          </div>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            If you have any last-minute changes to guest numbers, catering requirements, or other details,
            please contact our events team as soon as possible.
          </p>
          <p style="color:#6b7280;font-size:12px;margin:0;">
            We look forward to hosting your event. See you soon!
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "event_reminder"));
}

// ─── MEMBERSHIP APPLICATION EMAILS ───────────────────────────────────────────

export async function sendApplicationReceivedEmail(
  to: string,
  name: string,
  orgName: string,
  referenceCode: string,
  branding?: EmailBranding,
): Promise<void> {
  await sendMail({
    from: FROM,
    to,
    subject: `Your membership application has been received — ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Membership Application")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Application Received</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${name},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            Thank you for applying to join <strong style="color:#fff">${orgName}</strong>. 
            Your application has been received and is now under review. 
            We'll be in touch with updates as your application progresses.
          </p>
          <div style="background:#1a1a2e;border-radius:8px;padding:20px;margin:0 0 24px;">
            <p style="color:#6b7280;font-size:12px;margin:0 0 4px;text-transform:uppercase;letter-spacing:1px;">Reference Code</p>
            <p style="color:#22c55e;font-size:24px;font-weight:700;margin:0;letter-spacing:2px;">${referenceCode}</p>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;">
            Please keep your reference code safe. You may need it if you contact the club about your application.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "application_received"));
}

export async function sendApplicationStageChangeEmail(
  to: string,
  name: string,
  orgName: string,
  newStage: string,
  referenceCode: string,
  branding?: EmailBranding,
): Promise<void> {
  const stageLabels: Record<string, string> = {
    under_review: "Under Review",
    pending_committee: "Pending Committee Decision",
  };
  const stageLabel = stageLabels[newStage] ?? newStage.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const stageMessages: Record<string, string> = {
    under_review: "Our membership team has begun reviewing your application. We may contact you for additional information.",
    pending_committee: "Your application has been referred to the membership committee for final consideration.",
  };
  const message = stageMessages[newStage] ?? "Your application has moved to the next stage of our review process.";

  await sendMail({
    from: FROM,
    to,
    subject: `Membership application update — ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Membership Application")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Application Update</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${name},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            Your membership application with <strong style="color:#fff">${orgName}</strong> has been updated.
          </p>
          <div style="background:#1a1a2e;border-radius:8px;padding:20px;margin:0 0 24px;">
            <p style="color:#6b7280;font-size:12px;margin:0 0 4px;text-transform:uppercase;letter-spacing:1px;">New Status</p>
            <p style="color:#f59e0b;font-size:18px;font-weight:700;margin:0 0 8px;">${stageLabel}</p>
            <p style="color:#9ca3af;font-size:14px;margin:0;">${message}</p>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;">Reference: <strong>${referenceCode}</strong></p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "application_stage_change"));
}

export async function sendApplicationApprovedEmail(
  to: string,
  name: string,
  orgName: string,
  referenceCode: string,
  branding?: EmailBranding,
): Promise<void> {
  await sendMail({
    from: FROM,
    to,
    subject: `Congratulations — your membership application has been approved`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Membership Application")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Application Approved!</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${name},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            We are delighted to inform you that your application for membership at 
            <strong style="color:#fff">${orgName}</strong> has been <strong style="color:#22c55e">approved</strong>.
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            Your member record has been created. The club team will be in touch shortly with next steps 
            regarding your membership dues and portal access.
          </p>
          <p style="color:#6b7280;font-size:12px;margin:0;">Reference: <strong>${referenceCode}</strong></p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "application_approved"));
}

export async function sendMarketplaceBookingEmail(opts: {
  to: string;
  name: string;
  bookingId?: number;
  orgName?: string;
  slotDate?: Date;
  players?: number;
  amountPaise?: number;
  pending?: boolean;
  branding?: EmailBranding;
}): Promise<void> {
  const dateStr = opts.slotDate
    ? opts.slotDate.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
    : "";
  await sendMail({
    from: FROM,
    to: opts.to,
    subject: opts.pending ? `Tee Time Booking Pending — ${dateStr}` : `Tee Time Booking Confirmed — ${dateStr}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(opts.branding, opts.pending ? "Booking Pending" : "Booking Confirmed")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">${opts.pending ? "Booking Pending" : "Booking Confirmed"}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">Hi ${opts.name}, your tee time booking${opts.orgName ? ` at <strong style="color:#fff">${opts.orgName}</strong>` : ""}${dateStr ? ` on <strong style="color:#fff">${dateStr}</strong>` : ""} is ${opts.pending ? "pending confirmation" : "confirmed"}.</p>
        </div>
      </div>
    `,
  }, flowHints(opts.branding?.orgId, "marketplace_booking"));
}

/**
 * Task #1504 — A member's notification preference was changed by an admin
 * on their behalf (e.g. an org_admin / tournament_director flipping the
 * member's `notifySideGameReceipts` flag via the admin members endpoint).
 *
 * Sent to the affected member as a security/consent-style notice so the
 * change is never silent. The body names the admin who made the change,
 * the preference label, the new value, and (when the admin supplied one)
 * the reason text. A deep link points back to the member's portal
 * preferences screen so they can verify or revert the change themselves.
 *
 * Self-service flips (member toggling via the portal) MUST NOT use this —
 * the call site in `routes/members.ts` skips when actor === target.
 */
export async function sendNotificationPrefAdminOverrideEmail(opts: {
  to: string;
  memberName: string;
  prefLabel: string;
  newValue: boolean;
  previousValue: boolean;
  adminName: string;
  reason: string | null;
  changedAt: Date;
  prefsUrl: string;
  branding?: EmailBranding;
}): Promise<void> {
  const {
    to, memberName, prefLabel, newValue, previousValue,
    adminName, reason, changedAt, prefsUrl, branding,
  } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const newLabel = newValue ? "ON" : "OFF";
  const prevLabel = previousValue ? "ON" : "OFF";
  const safeAdmin = escapeHtml(adminName || "An administrator");
  const safePref = escapeHtml(prefLabel);
  const safeMember = escapeHtml(memberName || "there");
  const safeOrg = escapeHtml(orgName);
  const safePrefsUrl = safeHttpsUrl(prefsUrl) ?? prefsUrl;
  const whenStr = changedAt.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
  const reasonBlock = reason && reason.trim().length > 0
    ? `<div style="background:#1a1a1a;border-left:3px solid #6b7280;padding:12px 16px;margin:0 0 24px;border-radius:4px;">
         <p style="margin:0 0 4px;color:#6b7280;font-size:11px;letter-spacing:1px;text-transform:uppercase;">Reason given</p>
         <p style="margin:0;color:#e5e7eb;line-height:1.6;white-space:pre-wrap;">${escapeHtml(reason.trim())}</p>
       </div>`
    : "";
  await sendMail({
    from: FROM,
    to,
    subject: `Your notification preferences were changed by an admin — ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Notification Preferences")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#fbbf24;">Preference changed on your behalf</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 20px;">
            Hi ${safeMember}, ${safeAdmin} (an administrator at <strong style="color:#fff;">${safeOrg}</strong>)
            changed one of your notification preferences. We're letting you know so you can confirm
            or revert the change yourself.
          </p>
          <div style="background:#1a2a1a;border:1px solid #fbbf2433;border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Preference</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safePref}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Was</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-family:monospace;">${prevLabel}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Now</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:700;font-family:monospace;">${newLabel}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Changed by</td><td style="padding:6px 0;text-align:right;color:#fff;font-size:13px;">${safeAdmin}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">When</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;">${escapeHtml(whenStr)}</td></tr>
            </table>
          </div>
          ${reasonBlock}
          <div style="text-align:center;margin:0 0 24px;">
            <a href="${safePrefsUrl}" style="display:inline-block;background:#22c55e;color:#0a0a0a;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
              Review my preferences
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;line-height:1.6;">
            If this change wasn't expected, sign in to your portal and toggle the preference back —
            you can override admin changes at any time.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "notification_pref_admin_override"));
  }

  /**
   * Task #1549 — A club admin used the "Re-enable + replace email" flow
   * (Task #1311) to overwrite a member's contact email. We send a courtesy
   * transactional notice to the **new** address so the affected member knows
   * their sign-in address has changed and isn't silently locked out the next
   * time they try to log in by email. CAN-SPAM-friendly courtesy notice.
   *
   * Localised via the per-key `notificationEmailI18n` bundle keyed
   * `account.email_changed_by_admin`. English is the canonical source with
   * per-field fallback for partial translations.
   */
  export async function sendAccountEmailChangedByAdminEmail(opts: {
    /** New address to send the notice to (the just-replaced contact email). */
    to: string;
    /** Display name of the affected member (defaults to the language-specific
     *  greeting fallback when blank). */
    memberName: string | null;
    /** Display name of the admin who made the change. */
    adminName: string;
    /** The previous (suppressed) email address that was just replaced. */
    previousEmail: string;
    /** The new email address now on file. Same as `to`. */
    newEmail: string;
    /** Recipient's preferred language (BCP-47-ish, e.g. "en", "es", "hi"). */
    preferredLanguage?: string | null;
    /** Wall-clock time of the change for the audit row in the email. */
    changedAt: Date;
    branding?: EmailBranding;
  }): Promise<void> {
    const bundle = getNotificationEmailBundle(opts.preferredLanguage, "account.email_changed_by_admin");
    // Defensive — bundle must exist for a key we registered above. Treat a
    // missing bundle as a programmer error so it surfaces in tests, but
    // also fall back to English so production never silently drops the
    // notice on a typo.
    if (!bundle) {
      logger.warn(
        { preferredLanguage: opts.preferredLanguage },
        "[mailer] account.email_changed_by_admin bundle missing — falling back to English",
      );
    }
    const { common, key: kb } = bundle ?? getNotificationEmailBundle("en", "account.email_changed_by_admin")!;
    const orgName = opts.branding?.orgName?.trim() || common.clubFallback;
    const recipient = (opts.memberName ?? "").trim() || common.thereFallback;
    const actor = (opts.adminName ?? "").trim() || "an administrator";
    const safeRecipient = escapeHtml(recipient);
    const safeActor = escapeHtml(actor);
    const safeOrg = escapeHtml(orgName);
    const safePrev = escapeHtml(opts.previousEmail);
    const safeNew = escapeHtml(opts.newEmail);
    const safeChangedBy = escapeHtml(actor);
    const whenStr = opts.changedAt.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
    const subject = fmtNotificationEmail(kb.subject, { club: orgName, recipient, actor, newEmail: opts.newEmail });
    const intro = fmtNotificationEmail(kb.intro, { recipient: safeRecipient, club: safeOrg, actor: safeActor, newEmail: safeNew });
    const closing = fmtNotificationEmail(kb.closing, { recipient: safeRecipient, club: safeOrg, actor: safeActor, newEmail: safeNew });
    const text = fmtNotificationEmail(kb.text, { club: orgName, actor, newEmail: opts.newEmail, recipient });
    const labelPrev = kb.labels?.previousEmail ?? "Previous email";
    const labelNew = kb.labels?.newEmail ?? "New email";
    const labelBy = kb.labels?.changedBy ?? "Updated by";
    await sendMail({
      from: FROM,
      to: opts.to,
      subject,
      text: `${common.hi} ${recipient},\n\n${text}\n\n— ${orgName}`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
          ${headerHtml(opts.branding, kb.subtitle)}
          <div style="padding:32px 40px;">
            <h2 style="margin:0 0 12px;font-size:20px;color:#fbbf24;">${escapeHtml(kb.subtitle)}</h2>
            <p style="color:#e5e7eb;line-height:1.6;margin:0 0 20px;font-size:14px;">${intro}</p>
            <div style="background:#1a2a1a;border:1px solid #fbbf2433;border-radius:8px;padding:18px 20px;margin:0 0 20px;">
              <table style="width:100%;border-collapse:collapse;">
                <tr>
                  <td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(labelPrev)}</td>
                  <td style="padding:6px 0;text-align:right;color:#9ca3af;font-family:monospace;font-size:13px;word-break:break-all;">${safePrev}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(labelNew)}</td>
                  <td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;font-family:monospace;font-size:13px;word-break:break-all;">${safeNew}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(labelBy)}</td>
                  <td style="padding:6px 0;text-align:right;color:#fff;font-size:13px;">${safeChangedBy}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#6b7280;font-size:13px;">When</td>
                  <td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;">${escapeHtml(whenStr)}</td>
                </tr>
              </table>
            </div>
            <p style="color:#9ca3af;line-height:1.6;margin:0;font-size:13px;">${closing}</p>
          </div>
        </div>
      `,
    }, flowHints(opts.branding?.orgId, "account_email_changed_by_admin", { bypassSuppression: true }));
  }

  export async function sendTeeCancellationEmail(opts: {
  to: string;
  name: string;
  bookingId?: number;
  orgName?: string;
  slotDate?: Date;
  slotTime?: string;
  reason?: string | null;
  branding?: EmailBranding;
}): Promise<void> {
  const dateStr = opts.slotDate
    ? opts.slotDate.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
    : "";
  await sendMail({
    from: FROM,
    to: opts.to,
    subject: `Tee Time Booking Cancelled${dateStr ? ` — ${dateStr}` : ""}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(opts.branding, "Booking Cancelled")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Booking Cancelled</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">Hi ${opts.name}, your tee time booking${dateStr ? ` on <strong style="color:#fff">${dateStr}</strong>` : ""} has been cancelled.</p>
          ${opts.reason ? `<p style="color:#9ca3af;">Reason: ${opts.reason}</p>` : ""}
        </div>
      </div>
    `,
  }, flowHints(opts.branding?.orgId, "tee_cancellation"));
}

export async function sendLockerRenewalReminderEmail(
  to: string,
  name: string,
  label: string,
  opts?: { lockerNumber?: string; expiryDate?: string; paymentUrl?: string },
  branding?: EmailBranding,
): Promise<void> {
  const lockerNum = opts?.lockerNumber ?? "your locker";
  const expiryDate = opts?.expiryDate ?? "";
  await sendMail({
    from: FROM,
    to,
    subject: `Locker Renewal Reminder — ${lockerNum}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Locker Renewal")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Locker Renewal Due</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">Hi ${name}, your locker <strong style="color:#fff">${lockerNum}</strong> renewal is due${expiryDate ? ` on <strong style="color:#fff">${expiryDate}</strong>` : ""}.</p>
          ${opts?.paymentUrl ? `<a href="${opts.paymentUrl}" style="display:inline-block;padding:12px 24px;background:#22c55e;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Renew Now</a>` : ""}
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "locker_renewal_reminder"));
}

export async function sendTeeReminderEmail(opts: {
  to: string;
  name: string;
  bookingId?: number;
  orgName?: string;
  slotDate?: Date;
  slotTime?: string;
  horizonLabel?: string;
  players?: number;
  branding?: EmailBranding;
}): Promise<void> {
  const teeDisplay = opts.slotDate
    ? opts.slotDate.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })
    : "";
  await sendMail({
    from: FROM,
    to: opts.to,
    subject: `Tee Time Reminder${teeDisplay ? ` — ${teeDisplay}` : ""}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(opts.branding, "Tee Time Reminder")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Tee Time Reminder</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">Hi ${opts.name}, reminder that your tee time is <strong style="color:#fff">${opts.horizonLabel ?? ""}</strong>${opts.slotTime ? ` at <strong style="color:#fff">${opts.slotTime}</strong>` : ""}${opts.orgName ? ` at <strong style="color:#fff">${opts.orgName}</strong>` : ""}.</p>
        </div>
      </div>
    `,
  }, flowHints(opts.branding?.orgId, "tee_reminder"));
}
export async function sendApplicationRejectedEmail(
  to: string,
  name: string,
  orgName: string,
  reason: string | null,
  branding?: EmailBranding,
): Promise<void> {
  await sendMail({
    from: FROM,
    to,
    subject: `Membership application update — ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Membership Application")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">Application Update</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${name},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            Thank you for your interest in joining <strong style="color:#fff">${orgName}</strong>. 
            After careful consideration, we are unable to offer membership at this time.
          </p>
          ${reason ? `
          <div style="background:#1a1a2e;border-radius:8px;padding:20px;margin:0 0 24px;">
            <p style="color:#6b7280;font-size:12px;margin:0 0 4px;text-transform:uppercase;letter-spacing:1px;">Reason</p>
            <p style="color:#9ca3af;font-size:14px;margin:0;">${reason}</p>
          </div>` : ""}
          <p style="color:#6b7280;font-size:12px;margin:0;">
            If you believe this decision was made in error or would like further information, 
            please contact the club office.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "application_rejected"));
}

export interface RangeBookingEmailDetails {
  bookingId: number;
  bayNumber: number;
  bayLabel?: string | null;
  slotDate: string;
  slotTime: string;
  durationMinutes: number;
  totalAmount: string;
  currency: string;
  qrToken: string;
  bucketsIncluded: number;
  ballsPerBucket: number;
}

export async function sendRangeBookingConfirmation(
  to: string,
  name: string,
  details: RangeBookingEmailDetails,
  branding?: EmailBranding,
): Promise<void> {
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const bayLabel = details.bayLabel ? ` — ${details.bayLabel}` : "";
  const amountStr = parseFloat(details.totalAmount) > 0
    ? `${details.currency} ${parseFloat(details.totalAmount).toFixed(2)}`
    : "Complimentary";
  const tokensRow = details.bucketsIncluded > 0
    ? `<tr><td style="padding:8px 0;color:#9ca3af;font-size:13px;">Ball Tokens</td><td style="padding:8px 0;text-align:right;color:#4ade80;font-size:13px;">${details.bucketsIncluded} bucket(s) × ${details.ballsPerBucket} balls</td></tr>`
    : "";

  await sendMail({
    from: FROM,
    to,
    subject: `Driving Range Booking Confirmed — Bay ${details.bayNumber} at ${details.slotTime}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Driving Range")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:22px;color:#4ade80;">Booking Confirmed!</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">Hi ${name}, your driving range bay has been reserved at ${orgName}.</p>

          <div style="background:#111;border:1px solid #1e4d2b;border-radius:10px;padding:24px;margin-bottom:24px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:8px 0;color:#9ca3af;font-size:13px;">Bay</td>
                <td style="padding:8px 0;text-align:right;font-weight:700;font-size:14px;">Bay ${details.bayNumber}${bayLabel}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#9ca3af;font-size:13px;">Date</td>
                <td style="padding:8px 0;text-align:right;font-weight:700;font-size:14px;">${details.slotDate}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#9ca3af;font-size:13px;">Time</td>
                <td style="padding:8px 0;text-align:right;font-weight:700;font-size:14px;">${details.slotTime} (${details.durationMinutes} min)</td>
              </tr>
              ${tokensRow}
              <tr style="border-top:1px solid #1e4d2b;">
                <td style="padding:12px 0 0;color:#9ca3af;font-size:13px;">Amount</td>
                <td style="padding:12px 0 0;text-align:right;font-weight:700;font-size:15px;color:#4ade80;">${amountStr}</td>
              </tr>
            </table>
          </div>

          <div style="background:#0d1f0d;border:1px solid #22c55e55;border-radius:10px;padding:20px;text-align:center;margin-bottom:24px;">
            <p style="margin:0 0 12px;font-size:11px;letter-spacing:2px;color:#6b7280;text-transform:uppercase;">QR Check-In Code</p>
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(`KHGF:range:${details.bookingId}:${details.qrToken}`)}" alt="QR Code" style="width:160px;height:160px;border-radius:8px;display:block;margin:0 auto 12px;" />
            <p style="margin:0;font-family:monospace;font-size:11px;color:#6b7280;word-break:break-all;">${details.qrToken.slice(0, 20)}...</p>
            <p style="margin:8px 0 0;font-size:12px;color:#6b7280;">Present this QR code at the range desk for check-in</p>
          </div>

          <p style="color:#6b7280;font-size:12px;margin:0;">
            Booking Ref: #${details.bookingId} &bull; ${orgName}<br/>
            Need to cancel or reschedule? Log in to your Player Portal before the cut-off window.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "range_booking_confirmation"));
}

// ─── WAITLIST PROMOTION ───────────────────────────────────────────────────────

export async function sendWaitlistPromotionEmail(
  to: string,
  name: string,
  tournamentName: string,
  portalUrl: string,
  branding?: EmailBranding,
): Promise<void> {
  await sendMail({
    from: FROM,
    to,
    subject: `Good news — you've been moved off the waitlist for ${tournamentName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Tournament Update")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">You're In!</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${name},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            A spot has opened up in <strong style="color:#fff">${tournamentName}</strong> and you have been
            promoted from the waitlist. You are now registered for the event.
          </p>
          <a href="${portalUrl}" style="display:inline-block;background:#22c55e;color:#000;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;">
            View Your Registration
          </a>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "waitlist_promotion"));
}

// ─── TOURNAMENT RECAP ─────────────────────────────────────────────────────────

export async function sendTournamentRecapEmail(opts: {
  to: string;
  name: string;
  tournamentName: string;
  orgName: string;
  branding?: EmailBranding;
  top10?: { position: number; playerName: string; score: string }[];
  prizeWinners?: { category: string; playerName: string }[];
  personalResult?: {
    position: number | null;
    positionDisplay?: string | null;
    grossScore?: number | null;
    netScore?: number | null;
    scoreToPar?: number | null;
    netToPar?: number | null;
    stablefordPoints?: number | null;
  } | null;
  leaderboardUrl?: string;
}): Promise<void> {
  const { to, name, tournamentName, orgName, branding, top10 = [], prizeWinners = [], personalResult, leaderboardUrl } = opts;
  const top10Html = top10.slice(0, 5).map(r => `<tr><td style="padding:4px 8px;color:#9ca3af;">${r.position}</td><td style="padding:4px 8px;color:#fff;">${r.playerName}</td><td style="padding:4px 8px;color:#22c55e;">${r.score}</td></tr>`).join("");
  await sendMail({
    from: FROM,
    to,
    subject: `Results: ${tournamentName} — ${orgName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding ?? { orgName }, "Tournament Results")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;">${tournamentName}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${name},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            Thank you for participating in <strong style="color:#fff">${tournamentName}</strong>. Here are the results.
          </p>
          ${personalResult ? `
          <div style="background:#1a1a2e;border-radius:8px;padding:16px;margin:0 0 20px;">
            <p style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;">Your Result</p>
            <p style="color:#22c55e;font-size:20px;font-weight:700;margin:0 0 4px;">${personalResult.positionDisplay ?? (personalResult.position ? `#${personalResult.position}` : "—")}</p>
            ${personalResult.grossScore ? `<p style="color:#9ca3af;font-size:13px;margin:0;">Gross: ${personalResult.grossScore}</p>` : ""}
          </div>` : ""}
          ${top10.length > 0 ? `
          <p style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;">Top 5</p>
          <table style="width:100%;border-collapse:collapse;margin:0 0 20px;"><tbody>${top10Html}</tbody></table>` : ""}
          ${leaderboardUrl ? `<a href="${leaderboardUrl}" style="display:inline-block;background:#22c55e;color:#000;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;">View Full Leaderboard</a>` : ""}
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "tournament_recap"));
}

export type LevyReceiptKind = "payment" | "partial_payment" | "refund" | "waiver";

export async function sendLevyReceiptEmail(opts: {
  to: string;
  memberName: string;
  kind: LevyReceiptKind;
  levyName: string;
  currency: string;
  currencySymbol: string;
  amount: string;
  newBalance: string;
  note?: string | null;
  branding?: EmailBranding;
  /** Task #1099 — render the email in the org's default language with EN fallback. */
  lang?: string | null;
}): Promise<void> {
  const { to, memberName, kind, levyName, currency, currencySymbol, amount, newBalance, note, branding, lang } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeMemberName = escapeHtml(memberName || "there");
  const safeLevyName = escapeHtml(levyName);
  const safeCurrency = escapeHtml(currency);
  const safeNote = note ? escapeHtml(note).replace(/\n/g, "<br/>") : null;

  const strings = getAdminEmailStringsFor(lang, "levyReceipt");
  const kindStrings =
    kind === "payment" ? strings.payment :
    kind === "partial_payment" ? strings.partialPayment :
    kind === "refund" ? strings.refund :
    strings.waiver;
  const amountColor =
    kind === "payment" || kind === "partial_payment" ? "#4ade80" :
    kind === "refund" ? "#60a5fa" :
    "#fbbf24";
  const subject = fmtTemplate(kindStrings.subject, { levyName, orgName });
  const heading = kindStrings.heading;
  const intro = fmtTemplate(kindStrings.intro, { memberName: safeMemberName, levyName: safeLevyName });
  const amountLabel = kindStrings.amountLabel;
  const footer = fmtTemplate(strings.footer, { orgName: escapeHtml(orgName) });

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, strings.headerTag)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:${amountColor};">${escapeHtml(heading)}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">${intro}</p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(strings.levyLabel)}</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safeLevyName}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(amountLabel)}</td><td style="padding:6px 0;text-align:right;color:${amountColor};font-weight:700;font-size:18px;">${currencySymbol}${amount}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(strings.newBalanceLabel)}</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${currencySymbol}${newBalance}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(strings.currencyLabel)}</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:12px;">${safeCurrency}</td></tr>
            </table>
          </div>
          ${safeNote ? `<div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:0 0 24px;">
            <p style="margin:0 0 4px;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;">${escapeHtml(strings.noteLabel)}</p>
            <p style="margin:0;color:#e5e7eb;line-height:1.6;font-size:14px;">${safeNote}</p>
          </div>` : ""}
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            ${footer}
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "levy_receipt"));
}

/**
 * Levy ledger CSV scheduled email (Task #229).
 * Treasurers configure a weekly/monthly schedule and the cron emails the
 * previous period's CSV as an attachment so reconciliation doesn't require
 * anyone to log in.
 */
export async function sendLevyLedgerScheduleEmail(opts: {
  to: string | string[];
  orgName: string;
  levyName: string;
  frequency: "weekly" | "monthly";
  periodStart: Date | null;
  periodEnd: Date;
  rowCount: number;
  csv: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, orgName, levyName, frequency, periodStart, periodEnd, rowCount, csv, branding } = opts;
  const safeOrg = escapeHtml(orgName);
  const safeLevy = escapeHtml(levyName);
  const fmt = (d: Date | null) => (d ? d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" }) : "—");
  const periodLabel = `${fmt(periodStart)} → ${fmt(periodEnd)}`;
  const safePeriod = escapeHtml(periodLabel);
  const fileBase = `levy-ledger-${levyName.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "") || "export"}`;
  const filename = `${fileBase}-${periodEnd.toISOString().slice(0, 10)}.csv`;
  const effectiveBranding: EmailBranding = { orgName, ...branding };

  await sendMail({
    from: FROM,
    to,
    subject: `${orgName} — ${frequency === "weekly" ? "Weekly" : "Monthly"} levy ledger (${levyName})`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding, "Levy ledger")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;">${frequency === "weekly" ? "Weekly" : "Monthly"} ledger attached</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Please find attached the levy ledger for <strong style="color:#fff;">${safeLevy}</strong> at ${safeOrg}.
          </p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Period</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safePeriod}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Cadence</td><td style="padding:6px 0;text-align:right;color:#fff;">${frequency}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Rows in this file</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;">${rowCount}</td></tr>
            </table>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;">
            Generated automatically by KHARAGOLF — to change recipients or pause this schedule, open the levy in Member 360 → Levies.
          </p>
        </div>
      </div>
    `,
    attachments: [{ filename, content: csv, contentType: "text/csv; charset=utf-8" }],
  }, flowHints(effectiveBranding.orgId, "levy_ledger_schedule"));
}

/**
 * On-demand levy ledger PDF email (Task #270).
 * Sends the same paginated PDF auditors receive from the manual download as
 * an attachment, with the period and per-event-type totals summarised in the
 * email body so the recipient can verify the file at a glance.
 */
export async function sendLevyLedgerPdfEmail(opts: {
  to: string | string[];
  orgName: string;
  levyName: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  rowCount: number;
  totals: { payment: number; refund: number; waive: number };
  currency: string | null;
  pdf: Buffer;
  filename: string;
  message?: string | null;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, orgName, levyName, periodStart, periodEnd, rowCount, totals, currency, pdf, filename, message, branding } = opts;
  const safeOrg = escapeHtml(orgName);
  const safeLevy = escapeHtml(levyName ?? "All levies");
  const safeMessage = message ? escapeHtml(message).replace(/\n/g, "<br/>") : null;
  const fmt = (d: Date | null) => (d ? d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" }) : "—");
  const periodLabel = periodStart || periodEnd ? `${fmt(periodStart)} → ${fmt(periodEnd)}` : "All dates";
  const safePeriod = escapeHtml(periodLabel);
  const cur = currency ? `${escapeHtml(currency)} ` : "";
  const fmtAmt = (n: number) => n.toFixed(2);
  const net = totals.payment - totals.refund;
  const effectiveBranding: EmailBranding = { orgName, ...branding };

  await sendMail({
    from: FROM,
    to,
    subject: `${orgName} — Levy ledger (${levyName ?? "All levies"})`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding, "Levy ledger")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;">Signed ledger attached</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Please find attached the levy ledger for <strong style="color:#fff;">${safeLevy}</strong> at ${safeOrg}.
          </p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Period</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safePeriod}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Rows in this file</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;">${rowCount}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Payments</td><td style="padding:6px 0;text-align:right;color:#fff;">${cur}${fmtAmt(totals.payment)}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Refunds</td><td style="padding:6px 0;text-align:right;color:#fff;">${cur}${fmtAmt(totals.refund)}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Waives</td><td style="padding:6px 0;text-align:right;color:#fff;">${cur}${fmtAmt(totals.waive)}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;font-weight:600;">Net cash</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;">${cur}${fmtAmt(net)}</td></tr>
            </table>
          </div>
          ${safeMessage ? `<div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:0 0 24px;">
            <p style="margin:0 0 4px;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Message</p>
            <p style="margin:0;color:#e5e7eb;line-height:1.6;font-size:14px;">${safeMessage}</p>
          </div>` : ""}
          <p style="color:#6b7280;font-size:12px;margin:0;">
            Generated on demand from Member 360 → Export ledger. Reply to this email if anything looks incorrect.
          </p>
        </div>
      </div>
    `,
    attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
  }, flowHints(effectiveBranding.orgId, "levy_ledger_pdf"));
}

/**
 * Per-currency revenue & tax pivot CSV scheduled email (Task #669).
 * Treasurers configure a weekly/monthly cadence and the cron emails the
 * elapsed-period CSV — one row per (currency, event_type) — as an
 * attachment so reconciliation can happen entirely from the inbox.
 */
export function buildRevenueByCurrencyScheduleEmailContent(opts: {
  orgName: string;
  frequency: "weekly" | "monthly";
  periodStart: Date | null;
  periodEnd: Date;
  rowCount: number;
  currencyCount: number;
  branding?: EmailBranding;
}): { subject: string; html: string; filename: string } {
  const { orgName, frequency, periodStart, periodEnd, rowCount, currencyCount, branding } = opts;
  const safeOrg = escapeHtml(orgName);
  const fmt = (d: Date | null) => (d ? d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" }) : "—");
  const periodLabel = `${fmt(periodStart)} → ${fmt(periodEnd)}`;
  const safePeriod = escapeHtml(periodLabel);
  const dateStamp = periodEnd.toISOString().slice(0, 10);
  const filename = `revenue-by-currency-${dateStamp}.csv`;
  const effectiveBranding: EmailBranding = { orgName, ...branding };
  const subject = `${orgName} — ${frequency === "weekly" ? "Weekly" : "Monthly"} revenue & tax by currency`;
  const html = `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding, "Revenue by currency")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;">${frequency === "weekly" ? "Weekly" : "Monthly"} pivot attached</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Please find attached the per-currency revenue &amp; tax pivot for <strong style="color:#fff;">${safeOrg}</strong> covering the elapsed period.
          </p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Period</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safePeriod}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Cadence</td><td style="padding:6px 0;text-align:right;color:#fff;">${frequency}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Currencies in this file</td><td style="padding:6px 0;text-align:right;color:#fff;">${currencyCount}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Rows in this file</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;">${rowCount}</td></tr>
            </table>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;">
            Generated automatically by KHARAGOLF — to change recipients or pause this schedule, open Finance → Revenue &amp; tax by currency.
          </p>
        </div>
      </div>
    `;
  return { subject, html, filename };
}

export async function sendRevenueByCurrencyScheduleEmail(opts: {
  to: string | string[];
  orgName: string;
  frequency: "weekly" | "monthly";
  periodStart: Date | null;
  periodEnd: Date;
  rowCount: number;
  currencyCount: number;
  csv: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, csv } = opts;
  const { subject, html, filename } = buildRevenueByCurrencyScheduleEmailContent(opts);

  await sendMail({
    from: FROM,
    to,
    subject,
    html,
    attachments: [{ filename, content: csv, contentType: "text/csv; charset=utf-8" }],
  }, flowHints(opts.branding?.orgId, "revenue_by_currency_schedule"));
}

/**
 * Forecast accuracy CSV scheduled email (Task #1254).
 * Admins configure a weekly/monthly cadence and the cron emails the
 * elapsed-period CSV — same columns as the manual download in the
 * Forecast Accuracy tab — as an attachment so finance teams can
 * reconcile entirely from the inbox without logging into the admin.
 *
 * Date formatting uses the org's timezone (when known) so the period
 * label matches the org-local interpretation of the forecast windows
 * the CSV rows already use.
 */
export function buildForecastAccuracyScheduleEmailContent(opts: {
  orgName: string;
  frequency: "daily" | "weekly" | "monthly";
  periodStart: Date | null;
  periodEnd: Date;
  rowCount: number;
  /** Task #1476 — number of per-day rows in the companion sheet. */
  perDayRowCount?: number;
  branding?: EmailBranding;
  /** IANA timezone (e.g. "Asia/Kolkata"); defaults to UTC. */
  timezone?: string | null;
}): { subject: string; html: string; filename: string; perDayFilename: string } {
  const { orgName, frequency, periodStart, periodEnd, rowCount, perDayRowCount, branding, timezone } = opts;
  const safeOrg = escapeHtml(orgName);
  const tz = (timezone && typeof timezone === "string" && timezone.trim()) ? timezone : "UTC";
  const fmt = (d: Date | null) => {
    if (!d) return "—";
    try {
      return d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric", timeZone: tz });
    } catch {
      return d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });
    }
  };
  // Use org-tz to derive the file's date stamp so a Monday-night cron in
  // Asia/Kolkata doesn't label the file with the previous day's UTC date.
  const dateStamp = (() => {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz,
      }).formatToParts(periodEnd);
      const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
      return `${get("year")}-${get("month")}-${get("day")}`;
    } catch {
      return periodEnd.toISOString().slice(0, 10);
    }
  })();
  const periodLabel = `${fmt(periodStart)} → ${fmt(periodEnd)}`;
  const safePeriod = escapeHtml(periodLabel);
  const filename = `forecast-accuracy-${dateStamp}.csv`;
  // Task #1476 — companion per-day sheet attached alongside the
  // rolled-up CSV; date-stamped to the same period so the two files
  // sort together in admins' inboxes.
  const perDayFilename = `forecast-accuracy-per-day-${dateStamp}.csv`;
  const effectiveBranding: EmailBranding = { orgName, ...branding };
  const cadenceLabel = frequency === "daily" ? "Daily" : frequency === "weekly" ? "Weekly" : "Monthly";
  const subject = `${orgName} — ${cadenceLabel} forecast accuracy`;
  const perDayRow = (perDayRowCount != null && perDayRowCount >= 0)
    ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Per-day rows in companion sheet</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;">${perDayRowCount}</td></tr>`
    : "";
  const html = `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding, "Forecast accuracy")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;">${cadenceLabel} forecast accuracy attached</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Please find attached the forecast accuracy CSV for <strong style="color:#fff;">${safeOrg}</strong> covering the elapsed period — the same columns as the Forecast Accuracy tab download. A companion per-day sheet (<code style="color:#fff;">${perDayFilename}</code>) breaks each forecast window into its day-level projected vs actual revenue so you can spot which days drove the gap without opening the dashboard drill-down.
          </p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Period</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safePeriod}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Cadence</td><td style="padding:6px 0;text-align:right;color:#fff;">${frequency}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Forecast windows in this file</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;">${rowCount}</td></tr>
              ${perDayRow}
            </table>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;">
            Generated automatically by KHARAGOLF — to change recipients or pause this schedule, open Dynamic Pricing → Forecast Accuracy.
          </p>
        </div>
      </div>
    `;
  return { subject, html, filename, perDayFilename };
}

export async function sendForecastAccuracyScheduleEmail(opts: {
  to: string | string[];
  orgName: string;
  frequency: "daily" | "weekly" | "monthly";
  periodStart: Date | null;
  periodEnd: Date;
  rowCount: number;
  csv: string;
  /** Task #1476 — companion per-day projected vs actual sheet. */
  perDayCsv?: string;
  perDayRowCount?: number;
  branding?: EmailBranding;
  timezone?: string | null;
}): Promise<void> {
  const { to, csv, perDayCsv } = opts;
  const { subject, html, filename, perDayFilename } = buildForecastAccuracyScheduleEmailContent(opts);

  const attachments: Array<{ filename: string; content: string; contentType: string }> = [
    { filename, content: csv, contentType: "text/csv; charset=utf-8" },
  ];
  if (perDayCsv && perDayCsv.length > 0) {
    attachments.push({ filename: perDayFilename, content: perDayCsv, contentType: "text/csv; charset=utf-8" });
  }

  await sendMail({
    from: FROM,
    to,
    subject,
    html,
    attachments,
  }, flowHints(opts.branding?.orgId, "forecast_accuracy_schedule"));
}

/**
 * Wallet auto-refund weekly/monthly digest email (Task #1073).
 * Finance teams configure a per-org cadence and the cron emails the
 * elapsed-period CSV — same payload as `/admin/wallet-topup-refunds.csv` —
 * as an attachment so reconciliation happens entirely from the inbox.
 *
 * Task #1232 — subject + body are translated into the org's
 * `defaultLanguage` (with EN fallback) via `walletTopupRefundDigestI18n.ts`,
 * mirroring the locale-resolution pattern used by Task #1099's admin email
 * helpers. The period date range is also formatted with a locale derived
 * from the resolved language so digit/month conventions match.
 */
export function buildWalletTopupRefundScheduleEmailContent(opts: {
  orgName: string;
  frequency: "weekly" | "monthly";
  periodStart: Date | null;
  periodEnd: Date;
  rowCount: number;
  currencyCount: number;
  branding?: EmailBranding;
  /** Task #1232 — recipient/org language (EN fallback for unsupported codes). */
  lang?: string | null;
}): { subject: string; html: string; filename: string } {
  const { orgName, frequency, periodStart, periodEnd, rowCount, currencyCount, branding, lang } = opts;
  const safeOrg = escapeHtml(orgName);
  const tx = translateWalletTopupRefundDigest(lang, { orgName, frequency });
  const fmt = (d: Date | null) => {
    if (!d) return "—";
    try {
      return d.toLocaleDateString(tx.dateLocale, { year: "numeric", month: "long", day: "numeric" });
    } catch {
      return d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });
    }
  };
  const periodLabel = `${fmt(periodStart)} → ${fmt(periodEnd)}`;
  const safePeriod = escapeHtml(periodLabel);
  const dateStamp = periodEnd.toISOString().slice(0, 10);
  const filename = `wallet-topup-refunds-${dateStamp}.csv`;
  const effectiveBranding: EmailBranding = { orgName, ...branding };
  const subject = tx.subject;
  // HTML-escape the intro template (which still contains the literal
  // `{orgName}` placeholder, safe to keep) and substitute the placeholder
  // with an HTML-escaped + `<strong>`-wrapped name — same visual emphasis
  // the original Task #1073 English copy used.
  const introHtml = escapeHtml(tx.introTemplate)
    .replace("{orgName}", `<strong style="color:#fff;">${safeOrg}</strong>`);
  const html = `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding, tx.headerLabel)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;">${escapeHtml(tx.heading)}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            ${introHtml}
          </p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(tx.labelPeriod)}</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safePeriod}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(tx.labelCadence)}</td><td style="padding:6px 0;text-align:right;color:#fff;">${escapeHtml(tx.cadenceLabel)}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(tx.labelCurrencies)}</td><td style="padding:6px 0;text-align:right;color:#fff;">${currencyCount}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(tx.labelRefunds)}</td><td style="padding:6px 0;text-align:right;color:#f87171;font-weight:700;">${rowCount}</td></tr>
            </table>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;">
            ${escapeHtml(tx.footer)}
          </p>
        </div>
      </div>
    `;
  return { subject, html, filename };
}

export async function sendWalletTopupRefundScheduleEmail(opts: {
  to: string | string[];
  orgName: string;
  frequency: "weekly" | "monthly";
  periodStart: Date | null;
  periodEnd: Date;
  rowCount: number;
  currencyCount: number;
  csv: string;
  branding?: EmailBranding;
  /** Task #1232 — recipient/org language (EN fallback for unsupported codes). */
  lang?: string | null;
}): Promise<void> {
  const { to, csv } = opts;
  const { subject, html, filename } = buildWalletTopupRefundScheduleEmailContent(opts);

  await sendMail({
    from: FROM,
    to,
    subject,
    html,
    attachments: [{ filename, content: csv, contentType: "text/csv; charset=utf-8" }],
  }, flowHints(opts.branding?.orgId, "wallet_topup_refund_schedule"));
}

/**
 * Stuck side-game receipt deliveries daily/weekly digest (Task #1290).
 *
 * Mirrors `buildWalletTopupRefundScheduleEmailContent` (Task #1073). Org
 * admins configure a per-org cadence + recipient list and the cron emails
 * the elapsed-period CSV of stuck side-game receipts (rows whose retry
 * budget is exhausted OR whose channel is permanently `skipped` /
 * `no_address` / `opted_out` / `no_user`) so support can follow up
 * without anyone having to remember to log in to the admin dashboard.
 *
 * Task #1522 — subject + body are translated into the org's
 * `defaultLanguage` (with EN fallback) via `sideGameReceiptDigestI18n.ts`,
 * matching the locale-resolution pattern used by Task #1232's wallet
 * auto-refund digest. The period date range is also formatted with a
 * locale derived from the resolved language so digit/month conventions
 * match what admins see elsewhere in the localized dashboard.
 */
export function buildSideGameReceiptDigestEmailContent(opts: {
  orgName: string;
  frequency: "daily" | "weekly";
  periodStart: Date | null;
  periodEnd: Date;
  rowCount: number;
  exhaustedCount: number;
  skippedCount: number;
  branding?: EmailBranding;
  /** Task #1522 — recipient/org language (EN fallback for unsupported codes). */
  lang?: string | null;
}): { subject: string; html: string; filename: string } {
  const { orgName, frequency, periodStart, periodEnd, rowCount, exhaustedCount, skippedCount, branding, lang } = opts;
  const safeOrg = escapeHtml(orgName);
  const tx = translateSideGameReceiptDigest(lang, { orgName, frequency, rowCount });
  const fmt = (d: Date | null) => {
    if (!d) return "—";
    try {
      return d.toLocaleDateString(tx.dateLocale, { year: "numeric", month: "long", day: "numeric" });
    } catch {
      return d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });
    }
  };
  const periodLabel = `${fmt(periodStart)} → ${fmt(periodEnd)}`;
  const safePeriod = escapeHtml(periodLabel);
  const dateStamp = periodEnd.toISOString().slice(0, 10);
  const filename = `stuck-side-game-receipts-${dateStamp}.csv`;
  const effectiveBranding: EmailBranding = { orgName, ...branding };
  // Task #1878 — visibly distinguish a clean digest (rowCount === 0) from
  // a stuck-row digest in the inbox itself, mirroring the dashboard's
  // clean-vs-stuck history-row tone (Task #1523). Subject gets a stable
  // `[clean]` prefix so admins can email-filter on it; the body card
  // switches accent (sky/emerald reassurance), drops the alarming
  // exhausted/skipped/total rows whose values would all be 0, and lets
  // the existing translated "Good news — none stuck" intro carry the
  // copy. A non-empty digest keeps today's amber/red tone unchanged.
  const isClean = rowCount === 0;
  const subject = isClean ? `[clean] ${tx.subject}` : tx.subject;
  // HTML-escape the intro template (which still contains the literal
  // `{orgName}` placeholder, safe to keep) and substitute the placeholder
  // with an HTML-escaped + `<strong>`-wrapped name — same visual emphasis
  // the original Task #1290 English copy used.
  const introHtml = escapeHtml(tx.introTemplate)
    .replace("{orgName}", `<strong style="color:#fff;">${safeOrg}</strong>`);
  const cardStyle = isClean
    // Sky/emerald accent strip + tinted card so a clean week reads as
    // reassuring at a glance, even before the recipient parses the copy.
    ? "background:#0b1f1a;border:1px solid rgba(52,211,153,0.35);border-left:4px solid #34d399;border-radius:8px;padding:16px;margin:0 0 24px;"
    : "background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:0 0 24px;";
  const headingColor = isClean ? "#a7f3d0" : "#fff";
  const countsRows = isClean
    ? ""
    : `
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(tx.labelExhausted)}</td><td style="padding:6px 0;text-align:right;color:#f87171;">${exhaustedCount}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(tx.labelSkipped)}</td><td style="padding:6px 0;text-align:right;color:#fbbf24;">${skippedCount}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(tx.labelTotal)}</td><td style="padding:6px 0;text-align:right;color:#f87171;font-weight:700;">${rowCount}</td></tr>`;
  // Clean-week badge replaces the alarming counts. The "0" value is
  // language-neutral (digit only); the surrounding label stays in the
  // already-translated `tx.labelTotal` so the row reads correctly in
  // every locale without inventing a new string.
  const cleanRow = isClean
    ? `
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(tx.labelTotal)}</td><td style="padding:6px 0;text-align:right;color:#34d399;font-weight:700;" data-clean-week="true">✓ 0</td></tr>`
    : "";
  const html = `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;" data-clean-week="${isClean ? "true" : "false"}">
        ${headerHtml(effectiveBranding, tx.headerLabel)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:${headingColor};">${escapeHtml(tx.heading)}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">${introHtml}</p>
          <div style="${cardStyle}">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(tx.labelPeriod)}</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safePeriod}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(tx.labelCadence)}</td><td style="padding:6px 0;text-align:right;color:#fff;">${escapeHtml(tx.cadenceLabel)}</td></tr>${countsRows}${cleanRow}
            </table>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;">
            ${escapeHtml(tx.footer)}
          </p>
        </div>
      </div>
    `;
  return { subject, html, filename };
}

export async function sendSideGameReceiptDigestEmail(opts: {
  to: string | string[];
  orgName: string;
  frequency: "daily" | "weekly";
  periodStart: Date | null;
  periodEnd: Date;
  rowCount: number;
  exhaustedCount: number;
  skippedCount: number;
  csv: string;
  branding?: EmailBranding;
  /** Task #1522 — recipient/org language (EN fallback for unsupported codes). */
  lang?: string | null;
}): Promise<void> {
  const { to, csv } = opts;
  const { subject, html, filename } = buildSideGameReceiptDigestEmailContent(opts);
  await sendMail({
    from: FROM,
    to,
    subject,
    html,
    attachments: [{ filename, content: csv, contentType: "text/csv; charset=utf-8" }],
  }, flowHints(opts.branding?.orgId, "side_game_receipt_digest"));
}

/**
 * Club-wide combined levy ledger CSV scheduled email (Task #278).
 * Sends one rolled-up file containing every levy's ledger entries for the
 * elapsed period so a treasurer with many active levies receives a single
 * digest per cadence instead of one email per levy.
 */
export function buildOrgLevyLedgerScheduleEmailContent(opts: {
  orgName: string;
  frequency: "weekly" | "monthly";
  periodStart: Date | null;
  periodEnd: Date;
  rowCount: number;
  levyCount: number;
  deliveryFormat?: "combined" | "per_levy_zip" | "both";
  branding?: EmailBranding;
}): { subject: string; html: string; combinedFilename: string; zipFilename: string } {
  const { orgName, frequency, periodStart, periodEnd, rowCount, levyCount, branding } = opts;
  const deliveryFormat = opts.deliveryFormat ?? "combined";
  const safeOrg = escapeHtml(orgName);
  const fmt = (d: Date | null) => (d ? d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" }) : "—");
  const periodLabel = `${fmt(periodStart)} → ${fmt(periodEnd)}`;
  const safePeriod = escapeHtml(periodLabel);
  const dateStamp = periodEnd.toISOString().slice(0, 10);
  const effectiveBranding: EmailBranding = { orgName, ...branding };

  const formatLabel = deliveryFormat === "combined"
    ? "Combined CSV"
    : deliveryFormat === "per_levy_zip"
      ? "Per-levy CSV pack (ZIP)"
      : "Combined CSV + per-levy ZIP";
  const bodyIntro = deliveryFormat === "combined"
    ? `A combined ledger covering every active levy at <strong style="color:#fff;">${safeOrg}</strong> is attached.`
    : deliveryFormat === "per_levy_zip"
      ? `A ZIP containing one CSV per levy at <strong style="color:#fff;">${safeOrg}</strong> is attached so each fundraiser stays in its own file.`
      : `Both the combined ledger and a ZIP with one CSV per levy at <strong style="color:#fff;">${safeOrg}</strong> are attached.`;

  const subject = `${orgName} — ${frequency === "weekly" ? "Weekly" : "Monthly"} club-wide levy ledger`;
  const html = `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding, "Club-wide levy ledger")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;">${frequency === "weekly" ? "Weekly" : "Monthly"} digest attached</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            ${bodyIntro}
          </p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Period</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safePeriod}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Cadence</td><td style="padding:6px 0;text-align:right;color:#fff;">${frequency}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Delivery format</td><td style="padding:6px 0;text-align:right;color:#fff;">${escapeHtml(formatLabel)}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Levies covered</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${levyCount}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${deliveryFormat === "combined" ? "Rows in this file" : "Rows in this digest"}</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;">${rowCount}</td></tr>
            </table>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:0;">
            Generated automatically by KHARAGOLF — to change recipients, delivery format, or pause this digest, open the Levies tab in Member Management.
          </p>
        </div>
      </div>
    `;
  return {
    subject,
    html,
    combinedFilename: `levy-ledger-all-${dateStamp}.csv`,
    zipFilename: `levy-ledger-per-levy-${dateStamp}.zip`,
  };
}

export async function sendOrgLevyLedgerScheduleEmail(opts: {
  to: string | string[];
  orgName: string;
  frequency: "weekly" | "monthly";
  periodStart: Date | null;
  periodEnd: Date;
  rowCount: number;
  levyCount: number;
  /** Combined CSV across every levy. Omit (or null) when deliveryFormat is "per_levy_zip". */
  csv?: string | null;
  /** ZIP archive containing one CSV per levy. Required when deliveryFormat is "per_levy_zip" or "both". */
  zip?: Buffer | null;
  /** Task #322: combined / per-levy zip / both. Defaults to "combined" for backwards compat. */
  deliveryFormat?: "combined" | "per_levy_zip" | "both";
  branding?: EmailBranding;
}): Promise<void> {
  const { to, csv, zip } = opts;
  const deliveryFormat = opts.deliveryFormat ?? "combined";
  const { subject, html, combinedFilename, zipFilename } = buildOrgLevyLedgerScheduleEmailContent(opts);

  const attachments: Array<{ filename: string; content: string | Buffer; contentType: string }> = [];
  if (deliveryFormat === "combined" || deliveryFormat === "both") {
    if (typeof csv !== "string") {
      throw new Error("sendOrgLevyLedgerScheduleEmail: csv is required for deliveryFormat 'combined' or 'both'");
    }
    attachments.push({
      filename: combinedFilename,
      content: csv,
      contentType: "text/csv; charset=utf-8",
    });
  }
  if (deliveryFormat === "per_levy_zip" || deliveryFormat === "both") {
    if (!zip) {
      throw new Error("sendOrgLevyLedgerScheduleEmail: zip is required for deliveryFormat 'per_levy_zip' or 'both'");
    }
    attachments.push({
      filename: zipFilename,
      content: zip,
      contentType: "application/zip",
    });
  }

  await sendMail({
    from: FROM,
    to,
    subject,
    html,
    attachments,
  }, flowHints(opts.branding?.orgId, "org_levy_ledger_schedule"));
}

export async function sendSurveyEmail(opts: {
  to: string;
  name: string;
  orgName: string;
  surveyTitle: string;
  surveyDescription?: string;
  surveyUrl: string;
  /** Task #1140 — optional org id forwarded as `metadata.orgId` for bounce attribution. */
  orgId?: number;
}): Promise<void> {
  const { to, name, orgName, surveyTitle, surveyDescription, surveyUrl } = opts;
  await sendMail({
    from: FROM,
    to,
    subject: `${orgName} — ${surveyTitle}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="background:#1e4d2b;padding:32px 40px;">
          <h1 style="margin:0;font-size:24px;letter-spacing:4px;font-weight:900;">${orgName}</h1>
          <p style="margin:4px 0 0;font-size:11px;letter-spacing:3px;color:#4ade80;text-transform:uppercase;">Post-Event Survey</p>
        </div>
        <div style="padding:40px;">
          <h2 style="margin:0 0 16px;font-size:20px;">${surveyTitle}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${name},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 ${surveyDescription ? "8px" : "32px"};">
            Thank you for participating in our event. We'd love to hear your feedback — it only takes a minute.
          </p>
          ${surveyDescription ? `<p style="color:#9ca3af;line-height:1.6;margin:0 0 32px;">${surveyDescription}</p>` : ""}
          <a href="${surveyUrl}" style="display:inline-block;background:#22c55e;color:#000;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
            Complete Survey
          </a>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            This link is unique to you and expires when the survey closes. If you did not participate in this event, please ignore this email.
          </p>
        </div>
      </div>
    `,
  }, flowHints(opts.orgId, "survey"));
}

/**
 * Task #501 — End-of-tournament prediction game results email.
 *
 * Sent once per submission after the tournament transitions to "completed"
 * and `scorePredictionsForTournament` has finished. Idempotency is enforced
 * by the caller via `tournament_predictions.results_email_sent_at`.
 */
export async function sendPredictionResultsEmail(opts: {
  to: string;
  name: string;
  tournamentName: string;
  score: number;
  rank: number;
  totalEntries: number;
  breakdown: { winner: number; top5: number; lowRound: number };
  leaderboardUrl: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, name, tournamentName, score, rank, totalEntries, breakdown, leaderboardUrl, branding } = opts;
  const safeName = escapeHtml(name || "Golfer");
  const safeTournament = escapeHtml(tournamentName);
  const ordinal = (n: number) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
  };
  const rankSuffix = ordinal(rank);
  const effectiveBranding: EmailBranding = { orgName: tournamentName, ...branding };
  await sendMail({
    from: FROM,
    to,
    subject: `Your prediction results — ${tournamentName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(effectiveBranding, "Prediction Game")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:22px;color:#4ade80;">🏆 Final results are in!</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">Hi ${safeName},</p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            Thanks for playing the prediction game on <strong style="color:#fff">${safeTournament}</strong>. Here is how your picks shook out.
          </p>
          <div style="background:#1a2e1a;border:1px solid #22c55e33;border-radius:8px;padding:24px;margin:0 0 24px;text-align:center;">
            <p style="margin:0;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:2px;">Your Score</p>
            <p style="margin:6px 0 0;font-size:42px;font-weight:900;color:#4ade80;line-height:1;">${score}<span style="font-size:18px;color:#9ca3af;font-weight:600;"> pts</span></p>
            <p style="margin:14px 0 0;color:#e5e7eb;font-size:14px;">
              You finished <strong style="color:#fff">${rankSuffix}</strong> out of <strong style="color:#fff">${totalEntries}</strong> ${totalEntries === 1 ? "entry" : "entries"}.
            </p>
          </div>
          <div style="background:#0f1a10;border:1px solid #1f3322;border-radius:8px;padding:16px 20px;margin:0 0 24px;">
            <p style="margin:0 0 10px;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:2px;">Breakdown</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr>
                <td style="padding:6px 0;color:#9ca3af;">Winner pick</td>
                <td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${breakdown.winner} pts</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#9ca3af;">Top-5 picks</td>
                <td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${breakdown.top5} pts</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#9ca3af;">Low-round guess</td>
                <td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${breakdown.lowRound} pts</td>
              </tr>
            </table>
          </div>
          <a href="${leaderboardUrl}" style="display:inline-block;background:#22c55e;color:#000;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
            View Full Leaderboard
          </a>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            For entertainment only — this is a fun prediction game with no monetary stakes. See you next tournament!
          </p>
        </div>
      </div>
    `,
  }, flowHints(effectiveBranding.orgId, "prediction_results"));
}

/**
 * Side-game settlement receipt email (Task #771).
 *
 * Sent to the recipient of a side-game debt when the payer marks it paid
 * (Razorpay verify, Razorpay webhook, wallet pay, or the legacy /pay
 * endpoint). Mirrors the look and feel of `sendLevyReceiptEmail` so receipts
 * across the platform feel consistent.
 */
export async function sendSideGameSettlementReceiptEmail(opts: {
  to: string;
  recipientName: string;
  payerName: string;
  gameLabel: string;
  currency: string;
  currencySymbol: string;
  amount: string;
  paymentMethod?: string | null;
  paymentRef?: string | null;
  paidAt?: Date | null;
  branding?: EmailBranding;
  /**
   * Task #1105 — when present, render a one-line discoverability footer
   * deep-linking members to the dedicated "Side-game payment receipts"
   * toggle (Task #962) so they can opt out of *just* these emails instead
   * of the entire billing category.
   */
  commPrefsUrl?: string;
  /**
   * Task #1271 — render the opt-out footer in the recipient's preferred
   * language with English fallback, mirroring the round-robin tie-break
   * email (Task #1044). The header, body, and table copy remain English
   * for now; only the localised opt-out footer string is swapped in.
   */
  lang?: string | null;
}): Promise<void> {
  const { to, recipientName, payerName, gameLabel, currency, currencySymbol, amount, paymentMethod, paymentRef, paidAt, branding, commPrefsUrl, lang } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeRecipient = escapeHtml(recipientName || "there");
  const safePayer = escapeHtml(payerName || "A player");
  const safeGame = escapeHtml(gameLabel);
  const safeCurrency = escapeHtml(currency);
  const safeMethod = paymentMethod ? escapeHtml(paymentMethod.replace(/_/g, " ")) : null;
  const safeRef = paymentRef ? escapeHtml(paymentRef) : null;
  const paidAtStr = paidAt ? paidAt.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }) : null;
  const safeOrg = escapeHtml(orgName);
  const i18n = getCustomDomainEmailStrings(lang);
  const optOutFooterHtml = commPrefsUrl
    ? fmtTemplate(i18n.sideGameReceipt.optOutFooter, {
        linkOpen: `<a href="${escapeHtml(commPrefsUrl)}" style="color:#9ca3af;text-decoration:underline;">`,
        linkClose: "</a>",
        orgName: safeOrg,
      })
    : "";
  // Task #1488 — render the heading, greeting, table column labels, and
  // boilerplate paragraph in the recipient's preferred language with English
  // fallback. Task #1271 only localised the opt-out footer, so non-English
  // members previously saw the rest of the receipt in English.
  const sgr = i18n.sideGameReceipt;
  const safeAmount = escapeHtml(amount);
  const safeCurrencySymbol = escapeHtml(currencySymbol);
  const headingText = fmtTemplate(sgr.heading, {
    recipient: safeRecipient,
    payer: safePayer,
    gameLabel: safeGame,
    currencySymbol: safeCurrencySymbol,
    amount: safeAmount,
    orgName: safeOrg,
  });
  const greetingHtml = fmtTemplate(sgr.greeting, {
    recipient: safeRecipient,
    payer: safePayer,
    gameLabel: safeGame,
    currencySymbol: safeCurrencySymbol,
    amount: safeAmount,
    orgName: safeOrg,
  });
  const boilerplateHtml = fmtTemplate(sgr.boilerplate, {
    recipient: safeRecipient,
    payer: safePayer,
    gameLabel: safeGame,
    currencySymbol: safeCurrencySymbol,
    amount: safeAmount,
    orgName: safeOrg,
  });

  // Task #1827 — render the subject line in the recipient's preferred
  // language with English fallback. Tasks #1271/#1488 localised the body
  // and table labels but the inbox preview still showed the hard-coded
  // English subject, so non-English members saw an English subject before
  // the localised body.
  const subject = fmtTemplate(sgr.subject, {
    currencySymbol,
    amount,
    gameLabel,
    orgName,
  });

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Side-Game Receipt")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#4ade80;">${escapeHtml(headingText)}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            ${greetingHtml}
          </p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(sgr.labelSideGame)}</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safeGame}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(sgr.labelFrom)}</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safePayer}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(sgr.labelAmount)}</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;font-size:18px;">${currencySymbol}${amount}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(sgr.labelCurrency)}</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:12px;">${safeCurrency}</td></tr>
              ${safeMethod ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(sgr.labelMethod)}</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:12px;text-transform:capitalize;">${safeMethod}</td></tr>` : ""}
              ${safeRef ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(sgr.labelReference)}</td><td style="padding:6px 0;text-align:right;color:#6b7280;font-size:11px;word-break:break-all;">${safeRef}</td></tr>` : ""}
              ${paidAtStr ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(sgr.labelPaidAt)}</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:12px;">${escapeHtml(paidAtStr)}</td></tr>` : ""}
            </table>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            ${boilerplateHtml}
          </p>
          ${optOutFooterHtml ? `<p style="color:#6b7280;font-size:12px;margin:8px 0 0;">
            ${optOutFooterHtml}
          </p>` : ""}
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "side_game_settlement_receipt"));
}

/**
 * Manual-entry round alert (Task #870).
 *
 * Sent to tournament directors / org admins / committee members when a
 * player's round closes with more than half of its captured shots
 * recorded as `manual` source. Mirrors the amber data-quality banner on
 * the Players tab so TDs catch unreliable rounds even if they never open
 * the dashboard.
 */
export async function sendManualEntryAlertEmail(opts: {
  to: string;
  recipientName: string;
  tournamentName: string;
  playerName: string;
  round: number;
  manualPct: number;
  manualShots: number;
  totalShots: number;
  reviewUrl: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, recipientName, tournamentName, playerName, round, manualPct, manualShots, totalShots, reviewUrl, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeRecipient = escapeHtml(recipientName || "Director");
  const safeTournament = escapeHtml(tournamentName);
  const safePlayer = escapeHtml(playerName);
  const safeOrg = escapeHtml(orgName);
  const safePct = manualPct.toFixed(1);
  const subject = `[${orgName}] Manual-entry round flagged — ${playerName} R${round} (${safePct}%)`;

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Data Quality Alert")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">⚠ Manual-entry round flagged</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Hi ${safeRecipient}, a round in <strong style="color:#fff;">${safeTournament}</strong> just closed with most of its shots hand-keyed instead of captured by the watch, phone, or scorer station. The numbers below are less reliable for strokes-gained and dispersion analytics.
          </p>
          <div style="background:#1f1404;border:1px solid #f59e0b55;border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#9ca3af;font-size:13px;">Player</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${safePlayer}</td></tr>
              <tr><td style="padding:6px 0;color:#9ca3af;font-size:13px;">Round</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">R${round}</td></tr>
              <tr><td style="padding:6px 0;color:#9ca3af;font-size:13px;">Manual entries</td><td style="padding:6px 0;text-align:right;color:#f59e0b;font-weight:700;font-size:18px;">${safePct}%</td></tr>
              <tr><td style="padding:6px 0;color:#9ca3af;font-size:13px;">Shots</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:12px;">${manualShots} of ${totalShots} hand-entered</td></tr>
            </table>
          </div>
          <a href="${reviewUrl}" style="display:inline-block;background:#f59e0b;color:#0a0a0a;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
            Review on Players Tab
          </a>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            You're receiving this because you are listed as a tournament director or committee member for ${safeOrg}.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "manual_entry_alert"));
}

/**
 * Round-robin tie-break required alert (Task #898).
 *
 * Sent to tournament directors / org admins when `notifyRoundRobinTieBreak`
 * fires because the top of a round-robin standings list is tied and a fresh
 * tie-break match has been auto-generated. Directors who don't have the
 * mobile app installed (and therefore no Expo push token) would otherwise
 * only see the alert by manually opening the portal inbox — this email
 * gives them a third durable channel.
 */
export async function sendRoundRobinTieBreakAlertEmail(opts: {
  to: string;
  recipientName: string;
  tournamentName: string;
  matchUrl: string;
  branding?: EmailBranding;
  /** Task #1044 — render the email in the recipient's preferred language with EN fallback. */
  lang?: string | null;
  // Task #1045 — per-recipient one-click unsubscribe link. When provided,
  // a footer line is rendered with this URL and the same URL is also
  // surfaced in the RFC 2369 `List-Unsubscribe` header so mail clients
  // (Gmail, Apple Mail, Outlook) expose their native unsubscribe affordance.
  unsubscribeUrl?: string;
}): Promise<void> {
  const { to, recipientName, tournamentName, matchUrl, branding, lang, unsubscribeUrl } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeRecipient = escapeHtml(recipientName || "Director");
  const safeOrg = escapeHtml(orgName);
  const strings = getCustomDomainEmailStrings(lang);
  const subject = fmtTemplate(strings.tieBreak.subject, {
    orgName,
    tournamentName,
  });
  const greeting = fmtTemplate(strings.tieBreak.greeting, {
    recipient: safeRecipient,
    tournamentName: escapeHtml(tournamentName),
  });
  const footer = fmtTemplate(strings.tieBreak.footer, { orgName: safeOrg });
  const safeUnsub = unsubscribeUrl ? escapeHtml(unsubscribeUrl) : null;
  const unsubFooter = safeUnsub
    ? `<p style="color:#6b7280;font-size:12px;margin:8px 0 0;">
        Don't want these tie-break alerts?
        <a href="${safeUnsub}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe with one click</a>.
        Other ${safeOrg} emails are unaffected.
       </p>`
    : "";
  // RFC 2369 / RFC 8058 one-click headers — only added when we have a
  // signed unsubscribe URL for this exact recipient.
  const headers = unsubscribeUrl
    ? {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
    : undefined;

  await sendMail({
    from: FROM,
    to,
    subject,
    headers,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, strings.tieBreak.headerTag)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#4ade80;">${escapeHtml(strings.tieBreak.heading)}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            ${greeting}
          </p>
          <a href="${matchUrl}" style="display:inline-block;background:#22c55e;color:#0a0a0a;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:1px;">
            ${escapeHtml(strings.tieBreak.cta)}
          </a>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            ${footer}
          </p>
          ${unsubFooter}
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "round_robin_tie_break_alert"));
}

/**
 * Wallet withdrawal processed (Task #964).
 *
 * Sent when a member's wallet withdrawal is confirmed `processed` by the
 * RazorpayX webhook — the bank has paid out the money. Closes the loop
 * so the member sees confirmation (with the UTR + destination) instead
 * of having to re-open the wallet to find out.
 */
export async function sendWalletWithdrawalProcessedEmail(opts: {
  to: string;
  recipientName: string;
  currency: string;
  currencySymbol: string;
  amount: string;
  utr: string | null;
  destination: string;
  withdrawalId: number;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, recipientName, currency, currencySymbol, amount, utr, destination, withdrawalId, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeRecipient = escapeHtml(recipientName || "there");
  const safeCurrency = escapeHtml(currency);
  const safeUtr = utr ? escapeHtml(utr) : null;
  const safeDest = escapeHtml(destination);
  const safeOrg = escapeHtml(orgName);
  const subject = `Withdrawal of ${currencySymbol}${amount} paid (${orgName})`;

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Wallet Withdrawal")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#4ade80;">Your withdrawal has landed</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            Hi ${safeRecipient}, your withdrawal of
            <strong style="color:#fff;">${currencySymbol}${amount}</strong> from your
            ${safeOrg} wallet has been paid to ${safeDest}.
          </p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Amount</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;font-size:18px;">${currencySymbol}${amount}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Currency</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:12px;">${safeCurrency}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Destination</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:12px;">${safeDest}</td></tr>
              ${safeUtr ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">UTR</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:12px;word-break:break-all;">${safeUtr}</td></tr>` : ""}
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Reference</td><td style="padding:6px 0;text-align:right;color:#6b7280;font-size:11px;">#${withdrawalId}</td></tr>
            </table>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            Funds typically arrive in your bank within a few minutes. If you don't see
            them after a few hours, please contact ${safeOrg} with the UTR above.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "wallet_withdrawal_processed"));
}

/**
 * Wallet withdrawal failed / reversed (Task #964).
 *
 * Sent when a member's wallet withdrawal is marked `failed` or `reversed`
 * by the RazorpayX webhook. The wallet has already been refunded
 * automatically by `refundWithdrawal` — this email reassures the member
 * that the money is back in their wallet.
 */
export async function sendWalletWithdrawalFailedEmail(opts: {
  to: string;
  recipientName: string;
  currency: string;
  currencySymbol: string;
  amount: string;
  destination: string;
  withdrawalId: number;
  reason: string;
  reversed: boolean;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, recipientName, currency, currencySymbol, amount, destination, withdrawalId, reason, reversed, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeRecipient = escapeHtml(recipientName || "there");
  const safeCurrency = escapeHtml(currency);
  const safeDest = escapeHtml(destination);
  const safeReason = escapeHtml(reason);
  const safeOrg = escapeHtml(orgName);
  const verb = reversed ? "reversed" : "could not be processed";
  const subject = `Withdrawal of ${currencySymbol}${amount} ${reversed ? "reversed" : "failed"} — refunded to your wallet (${orgName})`;

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Wallet Withdrawal")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#fbbf24;">We couldn't complete your withdrawal</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            Hi ${safeRecipient}, your withdrawal of
            <strong style="color:#fff;">${currencySymbol}${amount}</strong> to ${safeDest}
            ${verb}. The full amount has been
            <strong style="color:#4ade80;">refunded to your ${safeOrg} wallet</strong> —
            you can try again or use a different payout account.
          </p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Amount refunded</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;font-size:18px;">${currencySymbol}${amount}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Currency</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:12px;">${safeCurrency}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Attempted to</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:12px;">${safeDest}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Reason</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:12px;word-break:break-word;">${safeReason}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">Reference</td><td style="padding:6px 0;text-align:right;color:#6b7280;font-size:11px;">#${withdrawalId}</td></tr>
            </table>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            Sorry for the inconvenience — your wallet balance is up to date. If you
            think this was an error, please contact ${safeOrg} with reference #${withdrawalId}.
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "wallet_withdrawal_failed"));
}

/**
 * Wallet top-up auto-refund notice (Task #919).
 *
 * Sent when the daily reconciliation cron (`refundOrphanedWalletTopups`)
 * issues a refund for a wallet top-up where the bank charged the member
 * but the wallet credit never landed. Closes the loop so the member sees
 * the money is on its way back instead of opening a support ticket.
 */
export async function sendWalletTopupAutoRefundedEmail(opts: {
  to: string;
  recipientName: string;
  currency: string;
  /** Locale-formatted, ready-to-render currency string (e.g. "₹1,234.56"). */
  amount: string;
  refundId: string | null;
  paymentId: string;
  branding?: EmailBranding;
  /**
   * Pre-translated copy for the recipient's preferred language (Task #1069).
   * Composed by `walletRefundI18n.ts` so this template stays language-agnostic.
   * The `{name}` and `{orgName}` placeholders inside `introHtml` are
   * substituted here with HTML-escaped values.
   */
  i18n: {
    subject: string;
    headerLabel: string;
    h2: string;
    /** May contain `{name}` and `{orgName}` placeholders. */
    introHtml: string;
    labelAmount: string;
    labelCurrency: string;
    labelOriginalPayment: string;
    labelRefundReference: string;
    /** May contain a `{orgName}` placeholder. */
    footer: string;
  };
}): Promise<void> {
  const { to, recipientName, currency, amount, refundId, paymentId, branding, i18n } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeRecipient = escapeHtml(recipientName || "there");
  const safeOrg = escapeHtml(orgName);
  const safeCurrency = escapeHtml(currency);
  const safeAmount = escapeHtml(amount);
  const safeRefund = refundId ? escapeHtml(refundId) : null;
  const safePayment = escapeHtml(paymentId);

  const introHtml = i18n.introHtml
    .replace(/\{name\}/g, safeRecipient)
    .replace(/\{orgName\}/g, safeOrg);
  const footer = escapeHtml(i18n.footer.replace(/\{orgName\}/g, orgName));
  const subject = i18n.subject;

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, i18n.headerLabel)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#fbbf24;">${escapeHtml(i18n.h2)}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            ${introHtml}
          </p>
          <div style="background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:20px;margin:0 0 24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(i18n.labelAmount)}</td><td style="padding:6px 0;text-align:right;color:#fbbf24;font-weight:700;font-size:18px;">${safeAmount}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(i18n.labelCurrency)}</td><td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:12px;">${safeCurrency}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(i18n.labelOriginalPayment)}</td><td style="padding:6px 0;text-align:right;color:#6b7280;font-size:11px;word-break:break-all;">${safePayment}</td></tr>
              ${safeRefund ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;">${escapeHtml(i18n.labelRefundReference)}</td><td style="padding:6px 0;text-align:right;color:#6b7280;font-size:11px;word-break:break-all;">${safeRefund}</td></tr>` : ""}
            </table>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            ${footer}
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "wallet_topup_auto_refunded"));
}

// ─── Task #1005 — Generic notification email (default channel sender) ───────
/**
 * Default email sender used by `dispatchNotification` when a feature
 * module hasn't supplied its own template callback. Renders a minimal
 * branded wrapper around the dispatch payload's title/body/HTML.
 */
export async function sendNotificationEmail(opts: {
  to: string;
  name: string | null;
  subject: string;
  html: string;
  text?: string;
  notificationKey: string;
  /**
   * Task #1171 — when set, the caller already wrapped `html` in the
   * full club-branded shell (header + footer + notification key) via
   * `notificationEmailTemplates.ts`. Skip the generic envelope so we
   * don't double-render headers and footers.
   */
  preRendered?: boolean;
  /**
   * Task #1734 — Optional one-click "mute this alert" URL. When set,
   *   - a "Mute this alert" anchor is appended to the footer (or
   *     spliced under the pre-rendered html), and
   *   - RFC 2369 `List-Unsubscribe` + RFC 8058 `List-Unsubscribe-Post`
   *     headers are attached so mail clients (Gmail, Apple Mail) can
   *     surface their native one-click unsubscribe button alongside
   *     the in-body link.
   * The URL is HMAC-signed by the dispatcher; this helper does no
   * additional validation. Both the plain-text body and the in-body
   * link include the URL so mute-from-inbox works in both rendering
   * modes.
   */
  unsubscribeUrl?: string;
}): Promise<void> {
  const { to, name, subject, html, text, notificationKey, preRendered, unsubscribeUrl } = opts;
  const greetingName = name?.trim() ? name.trim() : "there";
  // Task #1734 — small standalone footer block we splice into both the
  // pre-rendered and generic-envelope branches. Keep the markup minimal
  // so it renders the same regardless of whether the surrounding
  // template uses dark or light styling.
  const muteFooterHtml = unsubscribeUrl
    ? `
      <div style="padding:12px 40px 24px;color:#6b7280;font-size:11px;line-height:1.6;">
        Don't want this alert? <a href="${unsubscribeUrl}" style="color:#60a5fa;text-decoration:underline;">Mute this alert</a> with one click — your other notifications are unaffected.
      </div>
    `
    : "";
  const finalHtml = preRendered
    ? html + muteFooterHtml
    : `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="padding:24px 40px 0;">
          <div style="color:#22c55e;font-size:11px;letter-spacing:1px;text-transform:uppercase;">KHARAGOLF</div>
          <h1 style="margin:8px 0 0;font-size:22px;color:#fff;">Hi ${greetingName},</h1>
        </div>
        <div style="padding:16px 40px 8px;color:#e5e7eb;font-size:14px;line-height:1.55;">
          ${html}
        </div>
        ${muteFooterHtml}
        <div style="padding:16px 40px 32px;color:#6b7280;font-size:11px;border-top:1px solid rgba(255,255,255,0.05);margin-top:16px;">
          Notification: <code style="color:#9ca3af;">${notificationKey}</code>
        </div>
      </div>
    `;
  // Task #1734 — also surface the mute link in the plain-text body for
  // recipients viewing in text-only mail clients. Falls back to the
  // subject when no caller-provided text exists, mirroring the
  // pre-1734 behaviour.
  const baseText = text ?? subject;
  const finalText = unsubscribeUrl
    ? `${baseText}\n\n— Don't want this alert? Mute it: ${unsubscribeUrl}`
    : baseText;
  await sendMail({
    from: FROM,
    to,
    subject,
    text: finalText,
    html: finalHtml,
    // Task #1734 — RFC 2369 List-Unsubscribe + RFC 8058 one-click POST
    // headers so mail clients can offer their native unsubscribe UI.
    // The public mute endpoint accepts both GET (link click) and POST
    // (one-click), and the flag flip is naturally idempotent so a
    // double-tap is harmless.
    ...(unsubscribeUrl
      ? {
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }
      : {}),
  });
}

// ─── Task #1005 — Notification digest summary ────────────────────────────────
export async function sendDigestSummaryEmail(opts: {
  to: string;
  name: string;
  items: Array<{ key: string; title: string; body: string }>;
}): Promise<void> {
  const { to, name, items } = opts;
  const itemsHtml = items.map(i => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <div style="color:#fff;font-weight:600;font-size:14px;margin-bottom:4px;">${i.title}</div>
        <div style="color:#9ca3af;font-size:13px;line-height:1.5;">${i.body}</div>
        <div style="color:#4b5563;font-size:11px;margin-top:4px;">${i.key}</div>
      </td>
    </tr>`).join("");
  await sendMail({
    from: FROM,
    to,
    subject: `Your daily KHARAGOLF summary (${items.length} update${items.length === 1 ? "" : "s"})`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="padding:24px 40px 0;">
          <div style="color:#22c55e;font-size:11px;letter-spacing:1px;text-transform:uppercase;">Daily Summary</div>
          <h1 style="margin:8px 0 0;font-size:22px;color:#fff;">Hi ${name},</h1>
          <p style="color:#9ca3af;font-size:13px;margin:8px 0 0;">Here is what you missed in the last 24 hours.</p>
        </div>
        <div style="padding:16px 40px 32px;">
          <table style="width:100%;border-collapse:collapse;">${itemsHtml}</table>
        </div>
      </div>
    `,
  });
}


/**
 * Task #1130 — ops alert email when notification retry exhaustions cross
 * the configured threshold in the lookback window. Plain (non-org-branded)
 * because this is an engineering signal rather than a member-facing
 * communication. Body lists the per-table per-channel breakdown and the
 * window so on-call has the context they need before opening the DB.
 */
export async function sendNotifyRetryExhaustionOpsAlertEmail(opts: {
  to: string;
  summary: {
    windowHours: number;
    threshold: number;
    coachPayout: { push: number; sms: number; rows: number };
    levyReceipt: { push: number; sms: number; rows: number };
    totalRows: number;
  };
  since: Date;
  now: Date;
  /**
   * Task #1547 — when true, the email is clearly labelled as a manually
   * triggered TEST so on-call doesn't mistake it for a live incident.
   * Driven by the "Send test alert" button on the super-admin ops alert
   * card; the synthetic summary is generated by
   * {@link runNotifyExhaustionOpsAlertJob} when `isTest` is set.
   */
  isTest?: boolean;
}): Promise<void> {
  const { to, summary, since, now, isTest } = opts;
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const subject = isTest
    ? `[TEST] Ops alert delivery check — ${summary.totalRows} synthetic exhausted row${summary.totalRows === 1 ? "" : "s"}`
    : `⚠️ ${summary.totalRows} notification delivery row${summary.totalRows === 1 ? "" : "s"} permanently failed in the last ${summary.windowHours}h`;
  const rows = [
    { label: "Coach payout — push", value: summary.coachPayout.push },
    { label: "Coach payout — SMS", value: summary.coachPayout.sms },
    { label: "Levy receipt — push", value: summary.levyReceipt.push },
    { label: "Levy receipt — SMS", value: summary.levyReceipt.sms },
  ];
  const rowsHtml = rows.map(r => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">${r.label}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:${r.value > 0 ? "#f59e0b" : "#6b7280"};text-align:right;font-weight:600;">${r.value}</td>
    </tr>
  `).join("");
  const text = [
    isTest
      ? "[TEST] This is a manually triggered delivery check from the super-admin Ops Alert card — no real exhaustions occurred. The numbers below are synthetic. If you received this email, the OPS_ALERT_EMAILS recipient list and provider are wired correctly."
      : `${summary.totalRows} notification delivery row(s) hit the bounded retry cap between ${fmt(since)} and ${fmt(now)}.`,
    `Threshold: ${summary.threshold}. Window: ${summary.windowHours}h.`,
    "",
    `Coach payout push:  ${summary.coachPayout.push}`,
    `Coach payout SMS:   ${summary.coachPayout.sms}`,
    `Levy receipt push:  ${summary.levyReceipt.push}`,
    `Levy receipt SMS:   ${summary.levyReceipt.sms}`,
    "",
    isTest
      ? "No action required — this email exists so an admin can confirm the alert pipeline still works before tuning the threshold or window."
      : "A spike usually indicates a systemic outage — FCM/APNs key revoked, Twilio account suspended, or SMS_PROVIDER unset in prod. Investigate the provider configuration and replay the affected rows once the underlying issue is resolved.",
  ].join("\n");
  await sendMail({
    from: FROM,
    to,
    subject,
    text,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="padding:24px 40px;background:${isTest ? "#1e3a8a" : "#111827"};border-bottom:1px solid #1f2937;">
          <div style="color:${isTest ? "#93c5fd" : "#f59e0b"};font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">${isTest ? "Test ops alert" : "Ops alert"}</div>
          <h1 style="margin:8px 0 0;font-size:20px;color:#fff;">${isTest ? "Delivery check — synthetic data" : "Notification retries exhausted"}</h1>
        </div>
        <div style="padding:32px 40px;">
          ${isTest ? `
          <div style="margin:0 0 16px;padding:12px 16px;background:#1e293b;border-left:3px solid #3b82f6;border-radius:6px;color:#dbeafe;font-size:13px;line-height:1.5;">
            <strong style="color:#fff;">This is a test email.</strong> An admin clicked
            <em>Send test alert</em> on the super-admin Ops Alert card to verify that
            <code style="color:#fbbf24;">OPS_ALERT_EMAILS</code> recipients receive ops alerts.
            The numbers below are synthetic — no real exhaustions occurred and no live
            incident is in progress.
          </div>
          ` : ""}
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;font-size:14px;">
            ${isTest
              ? `<strong style="color:#93c5fd;">${summary.totalRows}</strong> synthetic exhausted row${summary.totalRows === 1 ? "" : "s"} (test payload)`
              : `<strong style="color:#f59e0b;">${summary.totalRows}</strong> notification delivery row${summary.totalRows === 1 ? "" : "s"} hit the bounded retry cap`}
            between <strong style="color:#e5e7eb;">${fmt(since)}</strong> and <strong style="color:#e5e7eb;">${fmt(now)}</strong>
            (threshold ${summary.threshold}, window ${summary.windowHours}h).
          </p>
          <table style="width:100%;border-collapse:collapse;margin:8px 0 16px;background:#0f172a;border-radius:8px;overflow:hidden;">
            <thead>
              <tr>
                <th style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:2px;padding:10px 12px;border-bottom:1px solid #1f2937;">Pipeline / channel</th>
                <th style="text-align:right;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:2px;padding:10px 12px;border-bottom:1px solid #1f2937;">Exhausted</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <p style="color:#9ca3af;line-height:1.6;margin:0;font-size:13px;">
            ${isTest
              ? "No action required — this email exists so an admin can confirm the alert pipeline still works before tuning the threshold or window."
              : `A spike usually indicates a systemic outage — FCM/APNs key revoked, Twilio account suspended, or
              <code style="color:#fbbf24;">SMS_PROVIDER</code> unset in prod. Investigate the provider configuration
              and replay the affected rows once the underlying issue is resolved.`}
          </p>
        </div>
      </div>
    `,
  });
}

/**
 * Task #1863 — ops alert email when wallet-topup-refund SMS / WhatsApp
 * retry budgets keep burning out for one or more organizations inside
 * a short window (default 1h). Sibling of
 * {@link sendNotifyRetryExhaustionOpsAlertEmail}, but per-org and
 * focused on a single product flow rather than the cross-pipeline
 * push/SMS rollup. Embeds sample provider error strings so on-call can
 * tell a Twilio outage apart from a misconfigured `SMS_PROVIDER`
 * without having to query the DB.
 */
export interface WalletTopupRefundRetryExhaustionEmailOrgRow {
  organizationId: number;
  organizationName: string | null;
  smsExhausted: number;
  whatsappExhausted: number;
  rowsExhausted: number;
  sampleErrors: Array<{
    channel: "sms" | "whatsapp";
    exhaustedAt: string;
    message: string | null;
  }>;
}

export async function sendWalletTopupRefundRetryExhaustionOpsAlertEmail(opts: {
  to: string;
  threshold: number;
  windowHours: number;
  cooldownHours: number;
  since: Date;
  now: Date;
  /** Orgs whose `rowsExhausted >= threshold`. Always non-empty when
   *  this function is called; callers gate on `breachedBreakdown.length > 0`. */
  breached: WalletTopupRefundRetryExhaustionEmailOrgRow[];
}): Promise<void> {
  const { to, threshold, windowHours, cooldownHours, since, now, breached } = opts;
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const fmtIso = (iso: string) => iso.replace("T", " ").slice(0, 19) + " UTC";
  const totalRows = breached.reduce((acc, b) => acc + b.rowsExhausted, 0);
  const orgWord = breached.length === 1 ? "org" : "orgs";
  const subject = `⚠️ Wallet refund SMS/WhatsApp retries permanently dropped — ${totalRows} row${totalRows === 1 ? "" : "s"} across ${breached.length} ${orgWord}`;

  const orgTextBlocks = breached.map((b) => {
    const orgLabel = b.organizationName
      ? `${b.organizationName} (id ${b.organizationId})`
      : `org id ${b.organizationId}`;
    const sampleLines = b.sampleErrors.length === 0
      ? ["    (no provider error message captured)"]
      : b.sampleErrors.map((s) => {
          const msg = (s.message ?? "(no provider error message captured)").slice(0, 240);
          return `    • [${s.channel}] @ ${fmtIso(s.exhaustedAt)} — ${msg}`;
        });
    return [
      `  • ${orgLabel}`,
      `      rows exhausted:      ${b.rowsExhausted}  (threshold ${threshold})`,
      `      SMS exhausted:       ${b.smsExhausted}`,
      `      WhatsApp exhausted:  ${b.whatsappExhausted}`,
      `      sample provider errors:`,
      ...sampleLines,
    ].join("\n");
  }).join("\n\n");

  const text = [
    `${totalRows} wallet-topup-refund notify row(s) burned through their SMS / WhatsApp retry budget for ${breached.length} ${orgWord} between ${fmt(since)} and ${fmt(now)}.`,
    `Per-org threshold: ${threshold}. Window: ${windowHours}h.`,
    "",
    `Members in these orgs have been refunded but never received the SMS/WhatsApp confirmation. A spike across multiple refunds inside ${windowHours}h almost always means a systemic outage — Twilio account suspended, WhatsApp Business token expired, or SMS_PROVIDER unset in prod — rather than isolated bad phone numbers.`,
    "",
    `Breached organizations:`,
    "",
    orgTextBlocks,
    "",
    `Repeat alerts are suppressed for ${cooldownHours}h while the issue persists.`,
  ].join("\n");

  const orgRowsHtml = breached.map((b) => {
    const orgLabel = b.organizationName
      ? `${escapeHtml(b.organizationName)} <span style="color:#6b7280;font-weight:400;">(id ${b.organizationId})</span>`
      : `org id ${b.organizationId}`;
    const sampleHtml = b.sampleErrors.length === 0
      ? `<li style="color:#9ca3af;font-style:italic;">(no provider error message captured)</li>`
      : b.sampleErrors.map((s) => {
          const msg = s.message ?? "(no provider error message captured)";
          return `<li style="color:#fca5a5;font-family:monospace;font-size:12px;word-break:break-word;line-height:1.5;">
            <span style="display:inline-block;min-width:64px;color:#fbbf24;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:1px;">${s.channel}</span>
            <span style="color:#9ca3af;">${escapeHtml(fmtIso(s.exhaustedAt))}</span>
            — ${escapeHtml(msg).slice(0, 480)}
          </li>`;
        }).join("");
    return `
      <div style="margin:0 0 18px;padding:14px 18px;background:#0f172a;border-radius:8px;border-left:3px solid #f59e0b;">
        <div style="font-size:14px;color:#fff;font-weight:600;margin:0 0 8px;">${orgLabel}</div>
        <table style="width:100%;border-collapse:collapse;margin:0 0 10px;">
          <tbody>
            <tr>
              <td style="padding:4px 0;color:#9ca3af;font-size:12px;">Rows exhausted</td>
              <td style="padding:4px 0;text-align:right;color:#f59e0b;font-weight:600;font-size:13px;">${b.rowsExhausted}<span style="color:#6b7280;font-weight:400;font-size:11px;"> / ${threshold}</span></td>
            </tr>
            <tr>
              <td style="padding:4px 0;color:#9ca3af;font-size:12px;">SMS exhausted</td>
              <td style="padding:4px 0;text-align:right;color:#e5e7eb;font-weight:600;font-size:13px;">${b.smsExhausted}</td>
            </tr>
            <tr>
              <td style="padding:4px 0;color:#9ca3af;font-size:12px;">WhatsApp exhausted</td>
              <td style="padding:4px 0;text-align:right;color:#e5e7eb;font-weight:600;font-size:13px;">${b.whatsappExhausted}</td>
            </tr>
          </tbody>
        </table>
        <div style="color:#9ca3af;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:8px 0 6px;">Sample provider errors</div>
        <ul style="margin:0;padding-left:18px;">${sampleHtml}</ul>
      </div>
    `;
  }).join("");

  await sendMail({
    from: FROM,
    to,
    subject,
    text,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:720px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="padding:24px 40px;background:#111827;border-bottom:1px solid #1f2937;">
          <div style="color:#f59e0b;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Ops alert</div>
          <h1 style="margin:8px 0 0;font-size:20px;color:#fff;">Wallet refund SMS/WhatsApp retries permanently dropped</h1>
        </div>
        <div style="padding:32px 40px;">
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 12px;font-size:14px;">
            <strong style="color:#f59e0b;">${totalRows}</strong> wallet-topup-refund notify row${totalRows === 1 ? "" : "s"} burned through the
            5-attempt SMS / WhatsApp retry budget across
            <strong style="color:#e5e7eb;">${breached.length}</strong> ${orgWord}
            between <strong style="color:#e5e7eb;">${escapeHtml(fmt(since))}</strong>
            and <strong style="color:#e5e7eb;">${escapeHtml(fmt(now))}</strong>
            (per-org threshold ${threshold}, window ${windowHours}h).
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 20px;font-size:13px;">
            Members in these orgs have been refunded but never received the SMS/WhatsApp confirmation. A spike across multiple refunds inside ${windowHours}h almost always means a systemic outage —
            <code style="color:#fbbf24;">Twilio</code> account suspended, WhatsApp Business token expired, or
            <code style="color:#fbbf24;">SMS_PROVIDER</code> unset in prod — rather than isolated bad phone numbers.
          </p>
          <h2 style="font-size:13px;color:#9ca3af;margin:0 0 12px;text-transform:uppercase;letter-spacing:1px;">Breached organizations</h2>
          ${orgRowsHtml}
          <p style="color:#6b7280;line-height:1.6;margin:0;font-size:12px;">
            Repeat alerts are suppressed for ${cooldownHours}h per replica while the issue persists.
          </p>
        </div>
      </div>
    `,
  });
}

/**
 * Task #1189 — ops alert email when the in-process watch GPS message-rate
 * trend detector in `watchPositionMetrics.ts` flags a spike (a regression
 * of Task #722's client-side debounce). Plain (non-org-branded) because
 * this is an engineering signal, sent in addition to the existing
 * `logger.warn` so on-call doesn't have to be tailing the log stream.
 *
 * The cooldown that gates the warn log also gates this email — a
 * sustained spike fires at most once per cooldown window per replica.
 */
export async function sendWatchPositionTrendOpsAlertEmail(opts: {
  to: string;
  recentAvg: number;
  baselineAvg: number;
  windowSize: number;
  multiplier: number;
  cooldownMinutes: number;
  now: Date;
}): Promise<void> {
  const { to, recentAvg, baselineAvg, windowSize, multiplier, cooldownMinutes, now } = opts;
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const ratio = baselineAvg > 0 ? Math.round((recentAvg / baselineAvg) * 100) / 100 : null;
  const subject = `⚠️ Watch GPS message rate spiking — ${recentAvg.toFixed(2)} msgs/session-minute (baseline ${baselineAvg.toFixed(2)})`;
  const text = [
    `Watch GPS message-rate trend detector fired at ${fmt(now)}.`,
    "",
    `Recent ${windowSize}-bucket avg:   ${recentAvg.toFixed(2)} msgs/session-minute`,
    `Baseline ${windowSize}-bucket avg: ${baselineAvg.toFixed(2)} msgs/session-minute`,
    ratio !== null ? `Ratio:                       ${ratio}× (threshold ${multiplier}×)` : "",
    "",
    "This usually means Task #722's client-side debounce on the watch is no longer suppressing redundant `position` pings. Recent watch / mobile / api-server changes are the most likely culprits — bisect from the most recent deploy.",
    "",
    `Repeat alerts are suppressed for ${cooldownMinutes} minute(s) per replica while the spike persists.`,
  ].filter(Boolean).join("\n");
  await sendMail({
    from: FROM,
    to,
    subject,
    text,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="padding:24px 40px;background:#111827;border-bottom:1px solid #1f2937;">
          <div style="color:#f59e0b;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Ops alert</div>
          <h1 style="margin:8px 0 0;font-size:20px;color:#fff;">Watch GPS message rate spiking</h1>
        </div>
        <div style="padding:32px 40px;">
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;font-size:14px;">
            The in-process trend detector flagged a sustained increase in watch
            <code style="color:#fbbf24;">position</code> message volume at
            <strong style="color:#e5e7eb;">${fmt(now)}</strong>.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:8px 0 16px;background:#0f172a;border-radius:8px;overflow:hidden;">
            <tbody>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Recent ${windowSize}-bucket avg</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#f59e0b;text-align:right;font-weight:600;">${recentAvg.toFixed(2)}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Baseline ${windowSize}-bucket avg</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#9ca3af;text-align:right;font-weight:600;">${baselineAvg.toFixed(2)}</td>
              </tr>
              ${ratio !== null ? `<tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Ratio (threshold ${multiplier}×)</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#f59e0b;text-align:right;font-weight:600;">${ratio}×</td>
              </tr>` : ""}
            </tbody>
          </table>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 12px;font-size:13px;">
            This usually means Task #722's client-side debounce on the watch is no longer
            suppressing redundant <code style="color:#fbbf24;">position</code> pings. Recent
            watch / mobile / api-server changes are the most likely culprits — bisect from the
            most recent deploy.
          </p>
          <p style="color:#6b7280;line-height:1.6;margin:0;font-size:12px;">
            Repeat alerts are suppressed for ${cooldownMinutes} minute(s) per replica while the spike persists.
          </p>
        </div>
      </div>
    `,
  });
}

/**
 * Task #1387 — ops alert email when manual-entry alert delivery health
 * crosses a configured threshold (push-or-email delivery rate < N% over
 * the last 7 days, OR the last N consecutive alerts all reached zero
 * recipients). Plain (non-org-branded) because this is an engineering
 * signal sent to super-admins + the on-call inbox.
 *
 * The body lists each detected breach with the underlying counts so
 * on-call has the context they need before opening the dashboard.
 */
export async function sendManualEntryAlertHealthOpsAlertEmail(opts: {
  to: string;
  breaches: {
    /**
     * Task #2066 added `muted_pile_up` for the auto-page rule that
     * fires when a single org accumulates >= N
     * `org_muted` / `tournament_muted` skips in the 7d window. The
     * email renders the offending orgs/tournaments inline (see
     * `mutedPileUpOrgs` below) so on-call can reach the tournament
     * director without opening the dashboard.
     */
    kind: "delivery_rate" | "consecutive_zero" | "muted_pile_up";
    detail: string;
  }[];
  summary7d: {
    alertCount: number;
    pushDeliveryRate: number;
    emailDeliveryRate: number;
    anyDeliveryRate: number;
    zeroDeliveryCount: number;
    silentRecipientTotal: number;
  };
  thresholdPct: number;
  minSample: number;
  consecutiveZero: number;
  cooldownHours: number;
  dashboardUrl: string;
  now: Date;
  /**
   * Task #2066 — when the muted-skip pile-up rule fires, list the
   * offending orgs (and their per-tournament breakdown) inline in the
   * email. Optional so existing callers without this signal don't have
   * to construct an empty list. The "Stuck-muted orgs" section is only
   * rendered when this is non-empty.
   */
  mutedPileUpThreshold?: number;
  mutedPileUpOrgs?: Array<{
    organizationId: number | null;
    organizationName: string | null;
    totalCount: number;
    orgMutedCount: number;
    tournamentMutedCount: number;
    tournaments: Array<{
      tournamentId: number | null;
      tournamentName: string | null;
      count: number;
      orgMutedCount: number;
      tournamentMutedCount: number;
    }>;
  }>;
  /**
   * Task #2079 — when set, mark the email as a synthetic wiring test
   * fired manually from the super-admin dashboard. The subject is
   * prefixed with [TEST], the header banner switches colour, and a
   * leading paragraph spells out that the data is synthetic so a
   * recipient on the on-call list doesn't open an incident page.
   */
  isTest?: boolean;
}): Promise<void> {
  const {
    to,
    breaches,
    summary7d,
    thresholdPct,
    minSample,
    consecutiveZero,
    cooldownHours,
    dashboardUrl,
    now,
    mutedPileUpThreshold,
    mutedPileUpOrgs,
    isTest,
  } = opts;
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  // Task #2066 — extend the subject-headline mapping for the new
  // `muted_pile_up` kind so the inbox preview names the actual rule
  // that fired instead of the raw kind string.
  const breachKindLabel = (k: typeof breaches[number]["kind"]): string => {
    switch (k) {
      case "delivery_rate":
        return "delivery rate";
      case "consecutive_zero":
        return "consecutive silent alerts";
      case "muted_pile_up":
        return "muted skip pile-up";
    }
  };
  const headlineKinds = breaches.map((b) => breachKindLabel(b.kind)).join(" + ");
  // Task #2079 — synthetic wiring tests fired from the dashboard get a
  // `[TEST]` subject so a recipient on the on-call list doesn't open
  // an incident; real breach pages keep the warning-emoji subject
  // line so they sort to the top of an on-call inbox.
  const subject = isTest
    ? `[TEST] Manual-entry alert delivery health page (synthetic wiring check)`
    : `⚠️ Manual-entry alert delivery health breached (${headlineKinds})`;
  const breachLinesText = breaches.map((b) => `• ${b.detail}`).join("\n");
  const orgLabel = (
    o: NonNullable<typeof mutedPileUpOrgs>[number],
  ): string =>
    o.organizationName
      ? `${o.organizationName} (#${o.organizationId ?? "?"})`
      : o.organizationId != null
        ? `org #${o.organizationId}`
        : "(unknown organization)";
  const tournamentLabel = (
    t: NonNullable<typeof mutedPileUpOrgs>[number]["tournaments"][number],
  ): string =>
    t.tournamentName
      ? `${t.tournamentName} (#${t.tournamentId ?? "?"})`
      : t.tournamentId != null
        ? `tournament #${t.tournamentId}`
        : "(unknown tournament)";
  const mutedPileUpTextLines: string[] = [];
  if (mutedPileUpOrgs && mutedPileUpOrgs.length > 0) {
    mutedPileUpTextLines.push("");
    mutedPileUpTextLines.push(
      `Stuck-muted orgs (>= ${mutedPileUpThreshold ?? "?"} muted skips in 7d):`,
    );
    for (const o of mutedPileUpOrgs) {
      mutedPileUpTextLines.push(
        `  • ${orgLabel(o)} — ${o.totalCount} muted skip(s)` +
          ` (org_muted=${o.orgMutedCount}, tournament_muted=${o.tournamentMutedCount})`,
      );
      for (const t of o.tournaments) {
        mutedPileUpTextLines.push(`      ◦ ${tournamentLabel(t)} — ${t.count}`);
      }
    }
  }
  const text = [
    isTest
      ? `[TEST] Synthetic wiring check fired by a super-admin from the dashboard at ${fmt(now)} — no real outage. Confirms the on-call distribution list, Resend config, and OPS_ALERT_EMAILS env are all reachable.`
      : `Manual-entry alert delivery health crossed the configured threshold at ${fmt(now)}.`,
    "",
    "Breaches:",
    breachLinesText,
    ...mutedPileUpTextLines,
    "",
    `7-day window:`,
    `  Alerts:                 ${summary7d.alertCount}`,
    `  Any-delivery rate:      ${summary7d.anyDeliveryRate}% (threshold ${thresholdPct}%, min sample ${minSample})`,
    `  Push delivery rate:     ${summary7d.pushDeliveryRate}%`,
    `  Email delivery rate:    ${summary7d.emailDeliveryRate}%`,
    `  Zero-delivery alerts:   ${summary7d.zeroDeliveryCount}`,
    `  Silent recipient total: ${summary7d.silentRecipientTotal}`,
    "",
    `Investigate the dashboard for which tournaments / orgs are affected: ${dashboardUrl}`,
    "",
    "A spike usually indicates an APNs/FCM cert outage, a bouncing tournament-director inbox, or an SMTP misconfiguration. A muted-skip pile-up usually means an org-wide alert toggle was left off after troubleshooting.",
    "",
    `Repeat alerts are suppressed for ${cooldownHours}h while the breach persists.`,
  ].join("\n");
  const breachKindHtmlLabel = (k: typeof breaches[number]["kind"]): string => {
    switch (k) {
      case "delivery_rate":
        return "Delivery rate";
      case "consecutive_zero":
        return "Consecutive zero";
      case "muted_pile_up":
        return "Muted pile-up";
    }
  };
  const escapeHtml = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const breachRowsHtml = breaches.map((b) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#f59e0b;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:1px;white-space:nowrap;">${breachKindHtmlLabel(b.kind)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;font-size:13px;">${escapeHtml(b.detail)}</td>
    </tr>
  `).join("");
  // Task #2066 — render the offending org/tournament list as a nested
  // table so on-call can scan it from the email without expanding raw
  // JSON. Only emitted when the muted-pile-up rule has matches; the
  // pre-#2066 layout is preserved verbatim otherwise.
  const mutedPileUpHtml = mutedPileUpOrgs && mutedPileUpOrgs.length > 0
    ? `
      <h2 style="font-size:13px;color:#9ca3af;text-transform:uppercase;letter-spacing:2px;margin:24px 0 8px;">
        Stuck-muted orgs (≥ ${mutedPileUpThreshold ?? "?"} muted skips in 7d)
      </h2>
      <table style="width:100%;border-collapse:collapse;margin:0 0 20px;background:#0f172a;border-radius:8px;overflow:hidden;">
        <thead>
          <tr>
            <th style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:2px;padding:10px 12px;border-bottom:1px solid #1f2937;">Organization / Tournament</th>
            <th style="text-align:right;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:2px;padding:10px 12px;border-bottom:1px solid #1f2937;">Muted skips</th>
            <th style="text-align:right;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:2px;padding:10px 12px;border-bottom:1px solid #1f2937;">org / tnmt</th>
          </tr>
        </thead>
        <tbody>
          ${mutedPileUpOrgs.map((o) => `
            <tr>
              <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#f59e0b;font-weight:600;font-size:13px;">${escapeHtml(orgLabel(o))}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#f59e0b;text-align:right;font-weight:700;">${o.totalCount}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#9ca3af;text-align:right;font-size:12px;">${o.orgMutedCount} / ${o.tournamentMutedCount}</td>
            </tr>
            ${o.tournaments.map((t) => `
              <tr>
                <td style="padding:6px 12px 6px 32px;border-bottom:1px solid #1f2937;color:#9ca3af;font-size:12px;">${escapeHtml(tournamentLabel(t))}</td>
                <td style="padding:6px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;text-align:right;font-size:12px;">${t.count}</td>
                <td style="padding:6px 12px;border-bottom:1px solid #1f2937;color:#6b7280;text-align:right;font-size:11px;">${t.orgMutedCount} / ${t.tournamentMutedCount}</td>
              </tr>
            `).join("")}
          `).join("")}
        </tbody>
      </table>
    `
    : "";
  await sendMail({
    from: FROM,
    to,
    subject,
    text,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="padding:24px 40px;background:${isTest ? "#1e3a8a" : "#111827"};border-bottom:1px solid #1f2937;">
          <div style="color:${isTest ? "#93c5fd" : "#f59e0b"};font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">${isTest ? "Test ops alert" : "Ops alert"}</div>
          <h1 style="margin:8px 0 0;font-size:20px;color:#fff;">${isTest ? "Manual-entry alert delivery health — synthetic wiring check" : "Manual-entry alert delivery health"}</h1>
        </div>
        <div style="padding:32px 40px;">
          ${isTest ? `
          <p style="background:#1e3a8a;color:#dbeafe;border:1px solid #3b82f6;border-radius:8px;padding:12px 16px;margin:0 0 16px;font-size:13px;line-height:1.6;">
            <strong>This is a test page</strong> — fired by a super-admin from the dashboard at <strong>${fmt(now)}</strong> to confirm the on-call distribution list, Resend config, and OPS_ALERT_EMAILS env are all reachable. No real outage. Disregard the breach details below; they are synthetic.
          </p>
          ` : `
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;font-size:14px;">
            Manual-entry alert delivery health crossed the configured threshold at
            <strong style="color:#e5e7eb;">${fmt(now)}</strong>.
          </p>
          `}
          <table style="width:100%;border-collapse:collapse;margin:8px 0 20px;background:#0f172a;border-radius:8px;overflow:hidden;">
            <thead>
              <tr>
                <th style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:2px;padding:10px 12px;border-bottom:1px solid #1f2937;">Breach</th>
                <th style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:2px;padding:10px 12px;border-bottom:1px solid #1f2937;">Detail</th>
              </tr>
            </thead>
            <tbody>${breachRowsHtml}</tbody>
          </table>
          ${mutedPileUpHtml}
          <h2 style="font-size:13px;color:#9ca3af;text-transform:uppercase;letter-spacing:2px;margin:24px 0 8px;">7-day window</h2>
          <table style="width:100%;border-collapse:collapse;margin:0 0 20px;background:#0f172a;border-radius:8px;overflow:hidden;">
            <tbody>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Alerts</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;text-align:right;font-weight:600;">${summary7d.alertCount}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Any-delivery rate (threshold ${thresholdPct}%, min sample ${minSample})</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:${summary7d.anyDeliveryRate < thresholdPct ? "#f59e0b" : "#22c55e"};text-align:right;font-weight:600;">${summary7d.anyDeliveryRate}%</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Push delivery rate</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;text-align:right;font-weight:600;">${summary7d.pushDeliveryRate}%</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Email delivery rate</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;text-align:right;font-weight:600;">${summary7d.emailDeliveryRate}%</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Zero-delivery alerts</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:${summary7d.zeroDeliveryCount > 0 ? "#f59e0b" : "#9ca3af"};text-align:right;font-weight:600;">${summary7d.zeroDeliveryCount}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;color:#e5e7eb;">Silent recipient total</td>
                <td style="padding:8px 12px;color:${summary7d.silentRecipientTotal > 0 ? "#f59e0b" : "#9ca3af"};text-align:right;font-weight:600;">${summary7d.silentRecipientTotal}</td>
              </tr>
            </tbody>
          </table>
          <p style="margin:0 0 20px;">
            <a href="${dashboardUrl}" style="display:inline-block;padding:10px 18px;background:#22c55e;color:#0a0a0a;font-weight:700;border-radius:8px;text-decoration:none;font-size:13px;">Open delivery health dashboard</a>
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 12px;font-size:13px;">
            A spike usually indicates an APNs/FCM cert outage, a bouncing tournament-director inbox, or an SMTP misconfiguration.
            The dashboard shows which tournaments and recipient orgs are most affected.
          </p>
          <p style="color:#6b7280;line-height:1.6;margin:0;font-size:12px;">
            Repeat alerts are suppressed for ${cooldownHours}h while the breach persists. Last N considered: ${consecutiveZero}.
          </p>
        </div>
      </div>
    `,
  });
}

/**
 * Task #1478 — ops alert email when the daily badge-share rollup
 * (Task #1096) has not run for at least `STALE_RUN_WARNING_MS` AND
 * the raw `badge_share_events` table has rows waiting to be rolled
 * up. Plain (non-org-branded) because this is an engineering signal
 * sent to super-admins + the on-call inbox.
 */
export async function sendBadgeShareRollupStaleOpsAlertEmail(opts: {
  to: string;
  summary: {
    lastRun: {
      ranAt: string;
      rolledUpEvents: number;
      upsertedAggregateRows: number;
      prunedAggregateRows: number;
    } | null;
    currentRawEventCount: number;
    currentAggregateRowCount: number;
    isStale: boolean;
    staleThresholdMs: number;
    rollupAgeMs: number;
    generatedAt: string;
  };
  cooldownHours: number;
  dashboardUrl: string;
  now: Date;
}): Promise<void> {
  const { to, summary, cooldownHours, dashboardUrl, now } = opts;
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const fmtIso = (iso: string) => iso.replace("T", " ").slice(0, 19) + " UTC";
  const staleThresholdHours = Math.round(summary.staleThresholdMs / (60 * 60 * 1000));
  const lastRanText = summary.lastRun
    ? fmtIso(summary.lastRun.ranAt)
    : "never (no successful run on this database)";
  const ageText = summary.lastRun
    ? `${Math.round((now.getTime() - new Date(summary.lastRun.ranAt).getTime()) / (60 * 60 * 1000))}h ago`
    : "—";
  const subject = `⚠️ Badge-share rollup is stale (last ran ${ageText})`;
  const text = [
    `The badge-share rollup cron has not completed in over ${staleThresholdHours}h, and there are ${summary.currentRawEventCount} raw badge_share_events row(s) waiting to be rolled up.`,
    "",
    `Last successful run: ${lastRanText}`,
    `Raw badge_share_events rows:        ${summary.currentRawEventCount}`,
    `Daily aggregate rows:               ${summary.currentAggregateRowCount}`,
    `Stale threshold:                    ${staleThresholdHours}h`,
    `Generated at:                       ${fmt(now)}`,
    "",
    `Investigate the dashboard: ${dashboardUrl}`,
    "",
    "Common causes: deploy regression, container OOM-killed mid-run, a long-running transaction blocking the rollup query, or the cron loop crashing without restart.",
    "",
    `Repeat alerts are suppressed for ${cooldownHours}h while the issue persists.`,
  ].join("\n");
  await sendMail({
    from: FROM,
    to,
    subject,
    text,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="padding:24px 40px;background:#111827;border-bottom:1px solid #1f2937;">
          <div style="color:#f59e0b;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Ops alert</div>
          <h1 style="margin:8px 0 0;font-size:20px;color:#fff;">Badge-share rollup is stale</h1>
        </div>
        <div style="padding:32px 40px;">
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;font-size:14px;">
            The badge-share rollup cron has not completed in over
            <strong style="color:#e5e7eb;">${staleThresholdHours}h</strong>, and
            <strong style="color:#f59e0b;">${summary.currentRawEventCount}</strong>
            raw <code style="color:#e5e7eb;">badge_share_events</code> row(s) are waiting to be rolled up.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:8px 0 20px;background:#0f172a;border-radius:8px;overflow:hidden;">
            <tbody>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Last successful run</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:${summary.lastRun ? "#e5e7eb" : "#f59e0b"};text-align:right;font-weight:600;">${lastRanText}${summary.lastRun ? ` (${ageText})` : ""}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Raw <code>badge_share_events</code> rows</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#f59e0b;text-align:right;font-weight:600;">${summary.currentRawEventCount}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Daily aggregate rows</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;text-align:right;font-weight:600;">${summary.currentAggregateRowCount}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Stale threshold</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;text-align:right;font-weight:600;">${staleThresholdHours}h</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;color:#e5e7eb;">Generated at</td>
                <td style="padding:8px 12px;color:#e5e7eb;text-align:right;font-weight:600;">${fmt(now)}</td>
              </tr>
            </tbody>
          </table>
          <p style="margin:0 0 20px;">
            <a href="${dashboardUrl}" style="display:inline-block;padding:10px 18px;background:#22c55e;color:#0a0a0a;font-weight:700;border-radius:8px;text-decoration:none;font-size:13px;">Open badge-share rollup dashboard</a>
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 12px;font-size:13px;">
            Common causes: deploy regression, container OOM-killed mid-run, a long-running transaction blocking the rollup query, or the cron loop crashing without restart.
          </p>
          <p style="color:#6b7280;line-height:1.6;margin:0;font-size:12px;">
            Repeat alerts are suppressed for ${cooldownHours}h while the issue persists.
          </p>
        </div>
      </div>
    `,
  });
}

/**
 * Task #1883 — ops alert email when the daily Stripe-webhook retention
 * sweep (`sweepOldStripeWebhookDeliveries` in cron.ts) has been silent
 * for longer than `STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS` (~36h). Mirrors
 * `sendBadgeShareRollupStaleOpsAlertEmail` (Task #1478) so on-call sees
 * the same shape for both stale-cron outages. Plain (non-org-branded)
 * because this is an engineering signal sent to super-admins + the
 * on-call inbox.
 */
export async function sendStripeWebhookSweepStaleOpsAlertEmail(opts: {
  to: string;
  /**
   * The most recent recorded sweep, or `null` when no sweep has ever
   * landed on this database (long-uptime + never-fired case).
   */
  status: { ranAt: string; removed: number } | null;
  staleThresholdMs: number;
  cooldownHours: number;
  dashboardUrl: string;
  now: Date;
}): Promise<void> {
  const { to, status, staleThresholdMs, cooldownHours, dashboardUrl, now } = opts;
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const fmtIso = (iso: string) => iso.replace("T", " ").slice(0, 19) + " UTC";
  const staleThresholdHours = Math.round(staleThresholdMs / (60 * 60 * 1000));
  const lastRanText = status
    ? fmtIso(status.ranAt)
    : "never (no recorded sweep on this database)";
  const ageHours = status
    ? Math.round(
        (now.getTime() - new Date(status.ranAt).getTime()) / (60 * 60 * 1000),
      )
    : null;
  const ageText = ageHours != null ? `${ageHours}h ago` : "—";
  const subject = `⚠️ Stripe webhook sweep is stale (last ran ${ageText})`;
  const text = [
    `The daily Stripe webhook retention sweep (sweepOldStripeWebhookDeliveries) has not completed in over ${staleThresholdHours}h.`,
    "",
    `Last successful sweep: ${lastRanText}`,
    `Rows removed last run: ${status ? status.removed : "—"}`,
    `Stale threshold:       ${staleThresholdHours}h`,
    `Generated at:          ${fmt(now)}`,
    "",
    `Investigate the dashboard: ${dashboardUrl}`,
    "",
    "Until the sweep runs again, stripe_webhook_deliveries will keep growing past its 30-day retention horizon. Common causes: deploy regression, container OOM-killed mid-run, a long-running transaction blocking the prune query, or the cron loop crashing without restart.",
    "",
    `Repeat alerts are suppressed for ${cooldownHours}h while the issue persists.`,
  ].join("\n");
  await sendMail({
    from: FROM,
    to,
    subject,
    text,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="padding:24px 40px;background:#111827;border-bottom:1px solid #1f2937;">
          <div style="color:#f59e0b;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Ops alert</div>
          <h1 style="margin:8px 0 0;font-size:20px;color:#fff;">Stripe webhook sweep is stale</h1>
        </div>
        <div style="padding:32px 40px;">
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;font-size:14px;">
            The daily Stripe webhook retention sweep
            (<code style="color:#e5e7eb;">sweepOldStripeWebhookDeliveries</code>)
            has not completed in over
            <strong style="color:#e5e7eb;">${staleThresholdHours}h</strong>.
            Until it runs again,
            <code style="color:#e5e7eb;">stripe_webhook_deliveries</code>
            will keep growing past its 30-day retention horizon.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:8px 0 20px;background:#0f172a;border-radius:8px;overflow:hidden;">
            <tbody>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Last successful sweep</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:${status ? "#e5e7eb" : "#f59e0b"};text-align:right;font-weight:600;">${lastRanText}${status ? ` (${ageText})` : ""}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Rows removed last run</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;text-align:right;font-weight:600;">${status ? status.removed : "—"}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Stale threshold</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;text-align:right;font-weight:600;">${staleThresholdHours}h</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;color:#e5e7eb;">Generated at</td>
                <td style="padding:8px 12px;color:#e5e7eb;text-align:right;font-weight:600;">${fmt(now)}</td>
              </tr>
            </tbody>
          </table>
          <p style="margin:0 0 20px;">
            <a href="${dashboardUrl}" style="display:inline-block;padding:10px 18px;background:#22c55e;color:#0a0a0a;font-weight:700;border-radius:8px;text-decoration:none;font-size:13px;">Open Stripe webhook audit dashboard</a>
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 12px;font-size:13px;">
            Common causes: deploy regression, container OOM-killed mid-run, a long-running transaction blocking the prune query, or the cron loop crashing without restart.
          </p>
          <p style="color:#6b7280;line-height:1.6;margin:0;font-size:12px;">
            Repeat alerts are suppressed for ${cooldownHours}h while the issue persists.
          </p>
        </div>
      </div>
    `,
  });
}

/**
 * Task #1813 — ops alert email when the daily profile-share rollup
 * (Task #1259) has not run for at least `STALE_RUN_WARNING_MS` AND
 * the raw `profile_share_events` table has rows waiting to be rolled
 * up. Plain (non-org-branded) because this is an engineering signal
 * sent to super-admins + the on-call inbox. Mirrors
 * `sendBadgeShareRollupStaleOpsAlertEmail` (Task #1478) so on-call
 * sees the same shape for both rollup outages.
 */
export async function sendProfileShareRollupStaleOpsAlertEmail(opts: {
  to: string;
  summary: {
    lastRun: {
      ranAt: string;
      rolledUpEvents: number;
      upsertedAggregateRows: number;
      prunedAggregateRows: number;
    } | null;
    currentRawEventCount: number;
    currentAggregateRowCount: number;
    isStale: boolean;
    staleThresholdMs: number;
    rollupAgeMs: number;
    generatedAt: string;
  };
  cooldownHours: number;
  dashboardUrl: string;
  now: Date;
}): Promise<void> {
  const { to, summary, cooldownHours, dashboardUrl, now } = opts;
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const fmtIso = (iso: string) => iso.replace("T", " ").slice(0, 19) + " UTC";
  const staleThresholdHours = Math.round(summary.staleThresholdMs / (60 * 60 * 1000));
  const lastRanText = summary.lastRun
    ? fmtIso(summary.lastRun.ranAt)
    : "never (no successful run on this database)";
  const ageText = summary.lastRun
    ? `${Math.round((now.getTime() - new Date(summary.lastRun.ranAt).getTime()) / (60 * 60 * 1000))}h ago`
    : "—";
  const subject = `⚠️ Profile-share rollup is stale (last ran ${ageText})`;
  const text = [
    `The profile-share rollup cron has not completed in over ${staleThresholdHours}h, and there are ${summary.currentRawEventCount} raw profile_share_events row(s) waiting to be rolled up.`,
    "",
    `Last successful run: ${lastRanText}`,
    `Raw profile_share_events rows:      ${summary.currentRawEventCount}`,
    `Daily aggregate rows:               ${summary.currentAggregateRowCount}`,
    `Stale threshold:                    ${staleThresholdHours}h`,
    `Generated at:                       ${fmt(now)}`,
    "",
    `Investigate the dashboard: ${dashboardUrl}`,
    "",
    "Common causes: deploy regression, container OOM-killed mid-run, a long-running transaction blocking the rollup query, or the cron loop crashing without restart.",
    "",
    `Repeat alerts are suppressed for ${cooldownHours}h while the issue persists.`,
  ].join("\n");
  await sendMail({
    from: FROM,
    to,
    subject,
    text,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="padding:24px 40px;background:#111827;border-bottom:1px solid #1f2937;">
          <div style="color:#f59e0b;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Ops alert</div>
          <h1 style="margin:8px 0 0;font-size:20px;color:#fff;">Profile-share rollup is stale</h1>
        </div>
        <div style="padding:32px 40px;">
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;font-size:14px;">
            The profile-share rollup cron has not completed in over
            <strong style="color:#e5e7eb;">${staleThresholdHours}h</strong>, and
            <strong style="color:#f59e0b;">${summary.currentRawEventCount}</strong>
            raw <code style="color:#e5e7eb;">profile_share_events</code> row(s) are waiting to be rolled up.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:8px 0 20px;background:#0f172a;border-radius:8px;overflow:hidden;">
            <tbody>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Last successful run</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:${summary.lastRun ? "#e5e7eb" : "#f59e0b"};text-align:right;font-weight:600;">${lastRanText}${summary.lastRun ? ` (${ageText})` : ""}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Raw <code>profile_share_events</code> rows</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#f59e0b;text-align:right;font-weight:600;">${summary.currentRawEventCount}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Daily aggregate rows</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;text-align:right;font-weight:600;">${summary.currentAggregateRowCount}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Stale threshold</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;text-align:right;font-weight:600;">${staleThresholdHours}h</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;color:#e5e7eb;">Generated at</td>
                <td style="padding:8px 12px;color:#e5e7eb;text-align:right;font-weight:600;">${fmt(now)}</td>
              </tr>
            </tbody>
          </table>
          <p style="margin:0 0 20px;">
            <a href="${dashboardUrl}" style="display:inline-block;padding:10px 18px;background:#22c55e;color:#0a0a0a;font-weight:700;border-radius:8px;text-decoration:none;font-size:13px;">Open profile-share rollup dashboard</a>
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 12px;font-size:13px;">
            Common causes: deploy regression, container OOM-killed mid-run, a long-running transaction blocking the rollup query, or the cron loop crashing without restart.
          </p>
          <p style="color:#6b7280;line-height:1.6;margin:0;font-size:12px;">
            Repeat alerts are suppressed for ${cooldownHours}h while the issue persists.
          </p>
        </div>
      </div>
    `,
  });
}

/**
 * Task #1704 — ops alert email when the daily fps-probe retention sweep
 * (Task #1412) observes a `failed` row backlog at or above the
 * configured threshold. Plain (non-org-branded) because this is an
 * engineering signal sent to super-admins + the on-call inbox.
 *
 * Embeds a sample of the most recent failed rows (swing_video_id,
 * timestamp, error_message) so the recipient can start triaging
 * without having to query the DB.
 */
export async function sendSwingFpsProbeFailureOpsAlertEmail(opts: {
  to: string;
  failedRetained: number;
  threshold: number;
  cooldownHours: number;
  /** Number of *new* `failed` rows observed inside the lookback window
   *  (the run-over-run growth signal). */
  growthCount: number;
  /** Configured minimum growth that triggers the growth alert. */
  growthDelta: number;
  /** Configured lookback window (hours) for the growth signal. */
  growthLookbackHours: number;
  /** Which trigger(s) caused the alert. At least one is true. Both can
   *  be true when a sustained backlog is also still actively growing. */
  trigger: { thresholdBreached: boolean; growthBreached: boolean };
  recentFailures: Array<{
    swingVideoId: number;
    completedAt: string | null;
    errorMessage: string | null;
  }>;
  dashboardUrl: string;
  now: Date;
}): Promise<void> {
  const {
    to,
    failedRetained,
    threshold,
    cooldownHours,
    growthCount,
    growthDelta,
    growthLookbackHours,
    trigger,
    recentFailures,
    dashboardUrl,
    now,
  } = opts;
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const fmtIso = (iso: string) => iso.replace("T", " ").slice(0, 19) + " UTC";
  const sampleCount = recentFailures.length;

  // Subject + lede vary by trigger so an inbox preview tells ops what
  // changed: a spike in absolute count, a fast-growing backlog, or
  // both.
  const triggerLabel = trigger.thresholdBreached && trigger.growthBreached
    ? `count + growth`
    : trigger.thresholdBreached
      ? `count`
      : `growth`;
  const subject = `⚠️ Swing fps-probe failures piling up (${failedRetained}, ${triggerLabel})`;

  const ledeLines: string[] = [];
  if (trigger.thresholdBreached) {
    ledeLines.push(
      `The daily swing-video fps-probe retention sweep just observed ${failedRetained} row(s) in 'failed' state, which meets/exceeds the alert threshold of ${threshold}.`,
    );
  }
  if (trigger.growthBreached) {
    ledeLines.push(
      `${trigger.thresholdBreached ? "Additionally, " : ""}${growthCount} new failure(s) landed in the last ${growthLookbackHours}h, which meets/exceeds the growth alert delta of ${growthDelta}.`,
    );
  }

  const sampleTextLines = recentFailures.length === 0
    ? ["  (no recent failed rows could be loaded)"]
    : recentFailures.map((r) => {
        const when = r.completedAt ? fmtIso(r.completedAt) : "—";
        const msg = (r.errorMessage ?? "(no error message captured)").slice(0, 240);
        return `  • swing_video_id=${r.swingVideoId} @ ${when} — ${msg}`;
      });

  const text = [
    ...ledeLines,
    "",
    `'failed' rows are deliberately retained by the sweep so persistent failures stay visible. A growing backlog usually means a bad ffprobe deploy, a storage outage corrupting some objects, or a regression in the worker — not isolated bad uploads.`,
    "",
    `Failed row count:           ${failedRetained}  (threshold ${threshold})`,
    `New failures in last ${String(growthLookbackHours).padStart(2, " ")}h:    ${growthCount}  (growth delta ${growthDelta})`,
    `Generated at:               ${fmt(now)}`,
    "",
    `Most recent ${sampleCount} failure(s):`,
    ...sampleTextLines,
    "",
    `Investigate the dashboard: ${dashboardUrl}`,
    "",
    `Repeat alerts are suppressed for ${cooldownHours}h while the issue persists.`,
  ].join("\n");

  const sampleRowsHtml = recentFailures.length === 0
    ? `<tr><td colspan="3" style="padding:12px;color:#9ca3af;font-style:italic;text-align:center;">(no recent failed rows could be loaded)</td></tr>`
    : recentFailures.map((r) => {
        const when = r.completedAt ? fmtIso(r.completedAt) : "—";
        const msg = r.errorMessage ?? "(no error message captured)";
        return `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;font-family:monospace;">${r.swingVideoId}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#9ca3af;white-space:nowrap;">${escapeHtml(when)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#fca5a5;font-family:monospace;font-size:12px;word-break:break-word;">${escapeHtml(msg).slice(0, 480)}</td>
          </tr>
        `;
      }).join("");

  await sendMail({
    from: FROM,
    to,
    subject,
    text,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:720px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="padding:24px 40px;background:#111827;border-bottom:1px solid #1f2937;">
          <div style="color:#f59e0b;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Ops alert · ${escapeHtml(triggerLabel)}</div>
          <h1 style="margin:8px 0 0;font-size:20px;color:#fff;">Swing fps-probe failures piling up</h1>
        </div>
        <div style="padding:32px 40px;">
          ${trigger.thresholdBreached ? `
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 12px;font-size:14px;">
            The daily fps-probe retention sweep just observed
            <strong style="color:#f59e0b;">${failedRetained}</strong>
            row(s) in <code style="color:#e5e7eb;">'failed'</code> state, which meets/exceeds the alert threshold of
            <strong style="color:#e5e7eb;">${threshold}</strong>.
          </p>` : ``}
          ${trigger.growthBreached ? `
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 12px;font-size:14px;">
            ${trigger.thresholdBreached ? `Additionally, ` : `The daily fps-probe retention sweep just saw `}<strong style="color:#f59e0b;">${growthCount}</strong>
            new failure(s) land in the last <strong style="color:#e5e7eb;">${growthLookbackHours}h</strong>,
            which meets/exceeds the growth alert delta of <strong style="color:#e5e7eb;">${growthDelta}</strong>.
          </p>` : ``}
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;font-size:13px;">
            <code>failed</code> rows are deliberately retained so persistent failures stay visible. A growing backlog usually means a bad ffprobe deploy, a storage outage corrupting some objects, or a regression in the worker — not isolated bad uploads.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:8px 0 20px;background:#0f172a;border-radius:8px;overflow:hidden;">
            <tbody>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">Failed row count</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:${trigger.thresholdBreached ? "#f59e0b" : "#e5e7eb"};text-align:right;font-weight:600;">${failedRetained}<span style="color:#6b7280;font-weight:400;font-size:11px;"> / ${threshold}</span></td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">New failures (last ${growthLookbackHours}h)</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:${trigger.growthBreached ? "#f59e0b" : "#e5e7eb"};text-align:right;font-weight:600;">${growthCount}<span style="color:#6b7280;font-weight:400;font-size:11px;"> / ${growthDelta}</span></td>
              </tr>
              <tr>
                <td style="padding:8px 12px;color:#e5e7eb;">Generated at</td>
                <td style="padding:8px 12px;color:#e5e7eb;text-align:right;font-weight:600;">${escapeHtml(fmt(now))}</td>
              </tr>
            </tbody>
          </table>
          <h2 style="font-size:14px;color:#e5e7eb;margin:24px 0 8px;">Most recent ${sampleCount} failure(s)</h2>
          <table style="width:100%;border-collapse:collapse;margin:0 0 20px;background:#0f172a;border-radius:8px;overflow:hidden;">
            <thead>
              <tr>
                <th style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#9ca3af;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;">swing_video_id</th>
                <th style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#9ca3af;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;">completed_at</th>
                <th style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#9ca3af;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;">error_message</th>
              </tr>
            </thead>
            <tbody>${sampleRowsHtml}</tbody>
          </table>
          <p style="margin:0 0 20px;">
            <a href="${dashboardUrl}" style="display:inline-block;padding:10px 18px;background:#22c55e;color:#0a0a0a;font-weight:700;border-radius:8px;text-decoration:none;font-size:13px;">Open swing-video diagnostics</a>
          </p>
          <p style="color:#6b7280;line-height:1.6;margin:0;font-size:12px;">
            Repeat alerts are suppressed for ${cooldownHours}h while the issue persists.
          </p>
        </div>
      </div>
    `,
  });
}

/**
 * Task #1507 — daily org-admin digest of wallet-topup-refund + coach
 * payout-account-change notify rows whose email/push retry budget burned
 * out in the last 24h. The underlying refund / account swap has already
 * landed; this digest tells the org admins which members never got the
 * heads-up so support can reach out manually.
 *
 * One row per exhausted notice. Each row shows:
 *   - kind ("Wallet refund" or "Coach payout account change")
 *   - identifier (paymentId for wallet, coach name for payout change)
 *   - which channel(s) gave up (email / push / both)
 *   - the last delivery error captured before exhaustion, if any
 */
export async function sendNotifyExhaustionAdminDigestEmail(opts: {
  to: string;
  staffName: string;
  baseUrl: string;
  walletItems: Array<{
    paymentId: string;
    refundId: string | null;
    currency: string;
    amount: string;
    channels: string[]; // e.g. ["email", "push"]
    lastError: string | null;
    exhaustedAt: string;
  }>;
  coachItems: Array<{
    historyId: number;
    proId: number;
    coachName: string;
    changeKind: string;
    method: string;
    channels: string[];
    lastError: string | null;
    exhaustedAt: string;
  }>;
  branding?: EmailBranding;
}): Promise<void> {
  const { to, staffName, baseUrl, walletItems, coachItems, branding } = opts;
  const orgName = branding?.orgName ?? "KHARAGOLF";
  const safeStaffName = escapeHtml(staffName);
  const safeOrg = escapeHtml(orgName);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const total = walletItems.length + coachItems.length;
  const subject = `⚠️ ${total} member notice${total === 1 ? "" : "s"} never delivered — ${orgName}`;

  function formatWhen(iso: string): string {
    return new Date(iso).toLocaleString("en", {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  const walletRowsHtml = walletItems.map(it => {
    const channelsLabel = it.channels.map(escapeHtml).join(" · ");
    const errorLine = it.lastError
      ? `<div style="margin-top:6px;color:#9ca3af;font-size:12px;font-style:italic;">${escapeHtml(it.lastError).slice(0, 240)}</div>`
      : "";
    const refundLine = it.refundId
      ? ` · refund <code style="color:#9ca3af;">${escapeHtml(it.refundId)}</code>`
      : "";
    return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #1f2937;vertical-align:top;">
          <div style="color:#fff;font-weight:600;font-size:14px;">
            <code style="color:#4ade80;">${escapeHtml(it.paymentId)}</code>
            <span style="color:#9ca3af;font-weight:400;"> · ${escapeHtml(it.currency)} ${escapeHtml(it.amount)}${refundLine}</span>
          </div>
          <div style="color:#9ca3af;font-size:12px;margin-top:2px;">
            Exhausted ${formatWhen(it.exhaustedAt)}${channelsLabel ? ` · ${channelsLabel}` : ""}
          </div>
          ${errorLine}
        </td>
      </tr>
    `;
  }).join("");

  const coachRowsHtml = coachItems.map(it => {
    const channelsLabel = it.channels.map(escapeHtml).join(" · ");
    const errorLine = it.lastError
      ? `<div style="margin-top:6px;color:#9ca3af;font-size:12px;font-style:italic;">${escapeHtml(it.lastError).slice(0, 240)}</div>`
      : "";
    return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #1f2937;vertical-align:top;">
          <div style="color:#fff;font-weight:600;font-size:14px;">
            ${escapeHtml(it.coachName)}
            <span style="color:#9ca3af;font-weight:400;"> · ${escapeHtml(it.changeKind)} (${escapeHtml(it.method)})</span>
          </div>
          <div style="color:#9ca3af;font-size:12px;margin-top:2px;">
            Exhausted ${formatWhen(it.exhaustedAt)}${channelsLabel ? ` · ${channelsLabel}` : ""}
          </div>
          ${errorLine}
        </td>
      </tr>
    `;
  }).join("");

  const walletSection = walletItems.length === 0 ? "" : `
    <h3 style="margin:24px 0 4px;font-size:14px;color:#f59e0b;text-transform:uppercase;letter-spacing:2px;">
      Wallet auto-refunds (${walletItems.length})
    </h3>
    <p style="color:#9ca3af;line-height:1.5;margin:0 0 8px;font-size:13px;">
      Bank charge has already been refunded; the member just never got the in-app/email confirmation.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:0;"><tbody>${walletRowsHtml}</tbody></table>
  `;

  const coachSection = coachItems.length === 0 ? "" : `
    <h3 style="margin:24px 0 4px;font-size:14px;color:#f59e0b;text-transform:uppercase;letter-spacing:2px;">
      Coach payout-account changes (${coachItems.length})
    </h3>
    <p style="color:#9ca3af;line-height:1.5;margin:0 0 8px;font-size:13px;">
      The coach's payout destination was changed but the security alert never reached them. Confirm the change was authorised.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:0;"><tbody>${coachRowsHtml}</tbody></table>
  `;

  await sendMail({
    from: FROM,
    to,
    subject,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, "Admin alert")}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#f59e0b;">Member notices that never delivered</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 8px;">
            Hi ${safeStaffName},
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            ${total === 1 ? "1 notice from" : `${total} notices from`} ${safeOrg} burned through every retry in the last 24 hours
            without reaching the member. The underlying action (refund or coach payout change) succeeded;
            only the heads-up email/push to the member failed. Please reach out manually.
          </p>
          ${walletSection}
          ${coachSection}
          <p style="color:#6b7280;font-size:12px;margin:32px 0 0;">
            Each row is included in this digest exactly once — once you act on it, it won't reappear tomorrow.
            Direct link: <a href="${trimmedBase}/admin/notify-exhaustion" style="color:#4ade80;">${trimmedBase}/admin/notify-exhaustion</a>
          </p>
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, "notify_exhaustion_admin_digest"));
}

/**
 * Admin re-subscribed alert (Task #1692).
 *
 * Sent to a director/member when an org_admin / tournament_director clears
 * their tie-break or bounced-digest schedule-change opt-out via the admin
 * DELETE endpoints (Tasks #1208 / #512). The corresponding inbox row
 * (Task #1401) only reaches users who open the mobile app or web portal —
 * a director who only checks email would otherwise start receiving the
 * alerts again with no warning.
 *
 * Subject + body intentionally mirror the inbox row, and the unsubscribe
 * URL is the same HMAC-signed token the email helpers already use, so
 * the recipient can re-silence the email with one click without involving
 * any admin. The `List-Unsubscribe` / `List-Unsubscribe-Post` headers
 * surface the native unsubscribe affordance in Gmail, Apple Mail, and
 * Outlook.
 *
 * Task #2114 — Subject, heading, body sentence, CTA, and unsubscribe
 * footer are localised via the per-key `notificationEmailI18n` bundles
 * keyed `admin.resubscribed.tie_break` and
 * `admin.resubscribed.bounced_digest_schedule`. The recipient's
 * `appUsersTable.preferredLanguage` (passed in by the call site)
 * selects the language pack with English as the canonical fallback.
 * The optional `subject`/`heading`/`alertSentence` opts are used as a
 * last-resort fallback if the i18n bundle is missing.
 */
export async function sendAdminResubscribedAlertEmail(opts: {
  to: string;
  recipientName: string;
  actorName: string;
  orgName: string;
  /** Fallback summary of which alert the admin just turned back on (used when the i18n bundle is missing). */
  alertSentence: string;
  /** Fallback headline rendered inside the email body (used when the i18n bundle is missing). */
  heading: string;
  /** Fallback subject line (used when the i18n bundle is missing). */
  subject: string;
  /** HMAC-signed one-click opt-out URL. */
  unsubscribeUrl?: string;
  /** Distinguishes the two flows in `flowHints` for the bounce webhook. */
  flow: "tie_break_admin_resubscribed" | "bounced_digest_schedule_admin_resubscribed";
  branding?: EmailBranding;
  /**
   * Task #2114 — Recipient's preferred language (BCP-47-ish, e.g. "en",
   * "es", "hi"). Resolved via `notificationEmailI18n` to pick the
   * subject/heading/body/CTA/footer strings; English is the canonical
   * fallback.
   */
  preferredLanguage?: string | null;
}): Promise<void> {
  const {
    to,
    recipientName,
    actorName,
    orgName,
    alertSentence,
    heading,
    subject,
    unsubscribeUrl,
    flow,
    branding,
    preferredLanguage,
  } = opts;

  // Map flow → i18n key. Both flows share the same bundle shape so the
  // renderer below is identical regardless of which one fired.
  const i18nKey = flow === "tie_break_admin_resubscribed"
    ? "admin.resubscribed.tie_break"
    : "admin.resubscribed.bounced_digest_schedule";
  const bundle = getNotificationEmailBundle(preferredLanguage, i18nKey)
    // Bundle should always exist for keys we register; the fallback is a
    // belt-and-braces guard so a future typo doesn't drop a real send.
    ?? getNotificationEmailBundle("en", i18nKey);
  if (!bundle) {
    logger.warn(
      { preferredLanguage, flow, i18nKey },
      "[mailer] admin.resubscribed bundle missing — falling back to caller-supplied English copy",
    );
  }

  const recipientForGreeting = (recipientName || "").trim()
    || (bundle?.common.thereFallback ?? "there");
  const orgForCopy = (orgName || "").trim()
    || (bundle?.common.clubFallback ?? "your club");
  const actorForCopy = (actorName || "").trim() || "An administrator";

  const safeRecipient = escapeHtml(recipientForGreeting);
  const safeActor = escapeHtml(actorForCopy);
  const safeOrg = escapeHtml(orgForCopy);

  // Subject / heading / alert sentence: prefer the bundle, fall back to
  // the caller-supplied English strings if the bundle was somehow missing.
  const subjectTpl = bundle?.key.subject ?? subject;
  const headingTpl = bundle?.key.labels?.heading ?? bundle?.key.subject ?? heading;
  const alertTpl = bundle?.key.intro ?? `{actor} ({club}) ${alertSentence}`;
  const ctaLabel = bundle?.key.ctaLabel ?? "Unsubscribe again";
  const subtitle = bundle?.key.subtitle ?? "Notification preferences";
  const greeting = bundle?.common.hi ?? "Hi";
  const footerPrefix = bundle?.key.labels?.footerPrefix ?? "Prefer to stay opted out?";
  const footerLinkLabel = bundle?.key.labels?.footerLinkLabel ?? "Unsubscribe with one click";
  const footerSuffixTpl = bundle?.key.labels?.footerSuffix ?? "Other {club} emails are unaffected.";

  const renderedSubject = fmtNotificationEmail(subjectTpl, {
    actor: actorForCopy,
    club: orgForCopy,
    recipient: recipientForGreeting,
  });
  const renderedHeading = escapeHtml(fmtNotificationEmail(headingTpl, {
    actor: actorForCopy,
    club: orgForCopy,
    recipient: recipientForGreeting,
  }));
  // intro is rendered as already-escaped HTML; both placeholders feed in
  // pre-escaped values so callers can't inject markup through actor/club.
  const renderedAlert = fmtNotificationEmail(alertTpl, {
    actor: safeActor,
    club: safeOrg,
    recipient: safeRecipient,
  });
  const renderedFooterSuffix = escapeHtml(fmtNotificationEmail(footerSuffixTpl, {
    club: orgForCopy,
  }));

  const safeUnsub = unsubscribeUrl ? escapeHtml(unsubscribeUrl) : null;
  const ctaButton = safeUnsub
    ? `<a href="${safeUnsub}" style="display:inline-block;background:#22c55e;color:#0a0a0a;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;letter-spacing:1px;">
         ${escapeHtml(ctaLabel)}
       </a>`
    : "";
  const unsubFooter = safeUnsub
    ? `<p style="color:#6b7280;font-size:12px;margin:24px 0 0;">
         ${escapeHtml(footerPrefix)}
         <a href="${safeUnsub}" style="color:#9ca3af;text-decoration:underline;">${escapeHtml(footerLinkLabel)}</a>.
         ${renderedFooterSuffix}
       </p>`
    : "";
  const headers = unsubscribeUrl
    ? {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
    : undefined;

  await sendMail({
    from: FROM,
    to,
    subject: renderedSubject,
    headers,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(branding, subtitle)}
        <div style="padding:40px;">
          <h2 style="margin:0 0 8px;font-size:20px;color:#4ade80;">${renderedHeading}</h2>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;">
            ${escapeHtml(greeting)} ${safeRecipient},
          </p>
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">
            ${renderedAlert}
          </p>
          ${ctaButton}
          ${unsubFooter}
        </div>
      </div>
    `,
  }, flowHints(branding?.orgId, flow));
}

/**
 * Task #1927 — Notify the admin who recently re-enabled an email address
 * (via the Suppressions "Re-enable" / "Re-enable + replace" flow) when the
 * same address bounces again. Surfaces the re-bounce promptly so the actor
 * can follow up without having to re-open the Marketing dashboard.
 *
 * The send is best-effort and rate-limited at the call site (one email
 * per actor+address per re-enable cycle); failures are logged by the
 * caller. The notice always opens with the address that bounced again
 * and shows the freshest bounce metadata Postmark gave us, so the admin
 * can decide whether to escalate (e.g. ask the member for a new address)
 * without having to dig through the Marketing dashboard first. The
 * `Open suppressions →` CTA deep-links back to the dashboard for any
 * follow-up action (e.g. resend, replace).
 */
export async function sendReBouncedAfterReenableAdminEmail(opts: {
  /** Admin's email address (from `app_users.email` of the audit row's actor). */
  to: string;
  /** Admin's display name (best effort; falls back to "there"). */
  adminName: string | null;
  /** The address that just bounced again. */
  reboundedEmail: string;
  /** Postmark Type field (e.g. "HardBounce", "BadMailbox"); may be null. */
  bounceType: string | null;
  /** Postmark Description / fallback bounce-summary text; may be null. */
  description: string | null;
  /** When the original re-enable was performed (from the audit row). */
  reenabledAt: Date;
  /** Whether the re-enable also replaced the contact email. */
  reenableHadReplacement: boolean;
  /** When the new bounce arrived (defaults to now()). */
  bouncedAt: Date;
  /** Deep-link back to the Marketing dashboard's Suppressions tab. */
  suppressionsUrl: string;
  branding?: EmailBranding;
}): Promise<void> {
  const safeAdminName = escapeHtml((opts.adminName ?? "").trim() || "there");
  const safeAddress = escapeHtml(opts.reboundedEmail);
  const safeBounceType = escapeHtml(opts.bounceType ?? "Hard bounce");
  const safeDescription = opts.description ? escapeHtml(opts.description) : null;
  const safeOrg = escapeHtml(opts.branding?.orgName?.trim() || "your club");
  const safeUrl = escapeHtml(safeHttpsUrl(opts.suppressionsUrl) ?? opts.suppressionsUrl);
  const reenabledStr = opts.reenabledAt.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
  const bouncedStr = opts.bouncedAt.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
  const subject = `Re-enabled address bounced again: ${opts.reboundedEmail}`;
  const action = opts.reenableHadReplacement ? "re-enabled and replaced" : "re-enabled";

  await sendMail({
    from: FROM,
    to: opts.to,
    subject,
    text: [
      `Hi ${(opts.adminName ?? "").trim() || "there"},`,
      "",
      `An address you recently ${action} on ${opts.branding?.orgName ?? "your club"} has bounced again:`,
      "",
      `Address:   ${opts.reboundedEmail}`,
      `Bounce:    ${opts.bounceType ?? "Hard bounce"}`,
      ...(opts.description ? [`Detail:    ${opts.description}`] : []),
      `Re-enabled at: ${reenabledStr}`,
      `Re-bounced at: ${bouncedStr}`,
      "",
      `The address is back on the suppression list. Open the Marketing dashboard to follow up:`,
      opts.suppressionsUrl,
      "",
      `You're receiving this once per address — repeat bounces of the same address won't email you again unless you re-enable it again.`,
    ].join("\n"),
    html: `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        ${headerHtml(opts.branding, "Marketing alert")}
        <div style="padding:32px 40px;">
          <h2 style="margin:0 0 12px;font-size:20px;color:#f87171;">Re-enabled address bounced again</h2>
          <p style="color:#e5e7eb;line-height:1.6;margin:0 0 20px;font-size:14px;">
            Hi ${safeAdminName}, an address you recently ${action} on ${safeOrg} has bounced again and is back on the suppression list.
          </p>
          <div style="background:#1a1a1a;border:1px solid #f8717133;border-radius:8px;padding:18px 20px;margin:0 0 20px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr>
                <td style="padding:6px 0;color:#6b7280;font-size:13px;">Address</td>
                <td style="padding:6px 0;text-align:right;color:#fff;font-family:monospace;font-size:13px;word-break:break-all;">${safeAddress}</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#6b7280;font-size:13px;">Bounce</td>
                <td style="padding:6px 0;text-align:right;color:#f87171;font-weight:600;font-size:13px;">${safeBounceType}</td>
              </tr>
              ${safeDescription ? `<tr>
                <td style="padding:6px 0;color:#6b7280;font-size:13px;">Detail</td>
                <td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;">${safeDescription}</td>
              </tr>` : ""}
              <tr>
                <td style="padding:6px 0;color:#6b7280;font-size:13px;">Re-enabled</td>
                <td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;">${escapeHtml(reenabledStr)}</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#6b7280;font-size:13px;">Re-bounced</td>
                <td style="padding:6px 0;text-align:right;color:#9ca3af;font-size:13px;">${escapeHtml(bouncedStr)}</td>
              </tr>
            </table>
          </div>
          <p style="margin:0 0 20px;">
            <a href="${safeUrl}" style="display:inline-block;background:#1e4d2b;color:#4ade80;font-weight:600;font-size:13px;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:0.5px;">
              Open suppressions →
            </a>
          </p>
          <p style="color:#6b7280;font-size:12px;margin:24px 0 0;line-height:1.5;">
            You're receiving this once per address — repeat bounces of the same address won't email you again unless you re-enable it again.
          </p>
        </div>
      </div>
    `,
  }, flowHints(opts.branding?.orgId, "rebounce_after_reenable_admin", { bypassSuppression: true }));
}

/**
 * Task #2002 — ops alert email when the daily round-weather-cache
 * backfill cron has been failing or stalling for several consecutive
 * passes (Open-Meteo outage, API contract change, the cron itself
 * throwing for >24h, etc.). Plain (non-org-branded) — this is an
 * engineering signal, not a member-facing communication.
 *
 * Body lays out the breach reasons + a trailing per-pass history table
 * so on-call can tell at a glance whether the system is errored,
 * piling up failed fetches, or has stopped catching up on pending rows
 * before opening the dashboard / DB.
 */
export async function sendRoundWeatherBackfillOpsAlertEmail(opts: {
  to: string;
  breaches: Array<{ kind: string; detail: string }>;
  windowHistory: Array<
    | {
        kind: "completed";
        at: Date;
        filled: number;
        stillPending: number;
        failed: number;
        total: number;
      }
    | { kind: "errored"; at: Date; message: string }
  >;
  failedThreshold: number;
  pendingThreshold: number;
  consecutivePasses: number;
  cooldownHours: number;
  dashboardUrl: string;
  now: Date;
}): Promise<void> {
  const {
    to,
    breaches,
    windowHistory,
    failedThreshold,
    pendingThreshold,
    consecutivePasses,
    cooldownHours,
    dashboardUrl,
    now,
  } = opts;
  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";

  // Subject summarises the trigger(s) so the inbox preview tells ops
  // what changed without opening the email.
  const breachLabels = breaches
    .map((b) =>
      b.kind === "errored_streak"
        ? "errored"
        : b.kind === "failed_streak"
          ? "failed"
          : b.kind === "pending_streak"
            ? "stuck"
            : b.kind,
    )
    .join(" + ");
  const subject = `⚠️ Round-weather backfill cron persistently ${breachLabels} (${consecutivePasses}× in a row)`;

  const breachTextLines = breaches.map((b) => `  • ${b.detail}`);

  const historyTextLines = windowHistory.length === 0
    ? ["  (no pass history captured yet)"]
    : windowHistory.map((h) =>
        h.kind === "completed"
          ? `  • ${fmt(h.at)} — completed: filled=${h.filled} stillPending=${h.stillPending} failed=${h.failed} total=${h.total}`
          : `  • ${fmt(h.at)} — errored: ${h.message.slice(0, 240)}`,
      );

  const text = [
    `The daily round-weather-cache backfill cron has tripped one or more streak detectors (${consecutivePasses} consecutive passes).`,
    "",
    `Breaches:`,
    ...breachTextLines,
    "",
    `Configured thresholds:`,
    `  failedThreshold:    ${failedThreshold}  (per-pass failed-row count that counts as "failed")`,
    `  pendingThreshold:   ${pendingThreshold}  (per-pass stillPending count that counts as "stuck")`,
    `  consecutivePasses:  ${consecutivePasses}  (passes in a row required to page)`,
    "",
    `Most recent ${windowHistory.length} pass(es):`,
    ...historyTextLines,
    "",
    `A persistent failed/errored streak almost always means an upstream issue — Open-Meteo is down, the archive's API contract changed, or a recent deploy broke the backfill loop. A persistent stillPending streak means the archive itself has stopped catching up.`,
    "",
    `Investigate: ${dashboardUrl}`,
    "",
    `Generated at: ${fmt(now)}`,
    `Repeat alerts are suppressed for ${cooldownHours}h while the issue persists.`,
  ].join("\n");

  const breachRowsHtml = breaches.map((b) => {
    const label = b.kind === "errored_streak"
      ? "Cron errored"
      : b.kind === "failed_streak"
        ? "Failed fetches"
        : b.kind === "pending_streak"
          ? "Pending pile-up"
          : b.kind;
    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#f59e0b;font-weight:600;white-space:nowrap;">${escapeHtml(label)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">${escapeHtml(b.detail)}</td>
      </tr>
    `;
  }).join("");

  const historyRowsHtml = windowHistory.length === 0
    ? `<tr><td colspan="3" style="padding:12px;color:#9ca3af;font-style:italic;text-align:center;">(no pass history captured yet)</td></tr>`
    : windowHistory.map((h) => {
        if (h.kind === "completed") {
          return `
            <tr>
              <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#9ca3af;font-family:monospace;white-space:nowrap;">${escapeHtml(fmt(h.at))}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#22c55e;text-transform:uppercase;font-size:11px;letter-spacing:1px;">completed</td>
              <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;font-family:monospace;font-size:12px;">filled=${h.filled} · stillPending=${h.stillPending} · failed=${h.failed} · total=${h.total}</td>
            </tr>
          `;
        }
        return `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#9ca3af;font-family:monospace;white-space:nowrap;">${escapeHtml(fmt(h.at))}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#fca5a5;text-transform:uppercase;font-size:11px;letter-spacing:1px;">errored</td>
            <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#fca5a5;font-family:monospace;font-size:12px;word-break:break-word;">${escapeHtml(h.message).slice(0, 480)}</td>
          </tr>
        `;
      }).join("");

  await sendMail({
    from: FROM,
    to,
    subject,
    text,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:720px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
        <div style="padding:24px 40px;background:#111827;border-bottom:1px solid #1f2937;">
          <div style="color:#f59e0b;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Ops alert · weather backfill</div>
          <h1 style="margin:8px 0 0;font-size:20px;color:#fff;">Round-weather backfill cron is unhealthy</h1>
        </div>
        <div style="padding:32px 40px;">
          <p style="color:#9ca3af;line-height:1.6;margin:0 0 16px;font-size:14px;">
            The daily round-weather-cache backfill cron has tripped one or more streak detectors
            (<strong style="color:#e5e7eb;">${consecutivePasses}</strong> consecutive passes). A persistent
            failed/errored streak almost always means an upstream issue — Open-Meteo is down, the archive's
            API contract changed, or a recent deploy broke the backfill loop. A persistent
            <code style="color:#e5e7eb;">stillPending</code> streak means the archive itself has stopped
            catching up.
          </p>
          <h2 style="font-size:14px;color:#e5e7eb;margin:24px 0 8px;">Breaches</h2>
          <table style="width:100%;border-collapse:collapse;margin:0 0 20px;background:#0f172a;border-radius:8px;overflow:hidden;">
            <tbody>${breachRowsHtml}</tbody>
          </table>
          <h2 style="font-size:14px;color:#e5e7eb;margin:24px 0 8px;">Most recent ${windowHistory.length} pass(es)</h2>
          <table style="width:100%;border-collapse:collapse;margin:0 0 20px;background:#0f172a;border-radius:8px;overflow:hidden;">
            <thead>
              <tr>
                <th style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#9ca3af;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;">when</th>
                <th style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#9ca3af;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;">status</th>
                <th style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#9ca3af;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;">details</th>
              </tr>
            </thead>
            <tbody>${historyRowsHtml}</tbody>
          </table>
          <table style="width:100%;border-collapse:collapse;margin:0 0 20px;background:#0f172a;border-radius:8px;overflow:hidden;">
            <tbody>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">failedThreshold (per pass)</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;text-align:right;font-weight:600;">${failedThreshold}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;">pendingThreshold (per pass)</td>
                <td style="padding:8px 12px;border-bottom:1px solid #1f2937;color:#e5e7eb;text-align:right;font-weight:600;">${pendingThreshold}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;color:#e5e7eb;">consecutivePasses</td>
                <td style="padding:8px 12px;color:#e5e7eb;text-align:right;font-weight:600;">${consecutivePasses}</td>
              </tr>
            </tbody>
          </table>
          <p style="margin:0 0 20px;">
            <a href="${dashboardUrl}" style="display:inline-block;padding:10px 18px;background:#22c55e;color:#0a0a0a;font-weight:700;border-radius:8px;text-decoration:none;font-size:13px;">Open round-weather diagnostics</a>
          </p>
          <p style="color:#6b7280;line-height:1.6;margin:0;font-size:12px;">
            Generated at ${escapeHtml(fmt(now))}. Repeat alerts are suppressed for ${cooldownHours}h while the issue persists.
          </p>
        </div>
      </div>
    `,
  });
}
