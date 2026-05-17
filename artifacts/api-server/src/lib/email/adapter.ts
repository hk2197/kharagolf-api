/**
 * Provider-agnostic transactional email adapter.
 *
 * Wave 0 / Task #935 — every transactional email in KHARAGOLF flows through
 * `sendTransactionalEmail()`. The actual delivery is delegated to a pluggable
 * `MailProvider`. The default provider is `gmail` (the existing nodemailer
 * Gmail SMTP transport), but switching to Postmark / Resend / SendGrid in the
 * future is a single env-var change (`EMAIL_PROVIDER=postmark`) — no call
 * sites need to change beyond their existing import.
 *
 * Architectural constraint (from task #935): existing call sites in
 * `mailer.ts` keep their signatures. Internally `mailer.ts#sendMail` now
 * routes through this adapter so that swapping the transport is a one-line
 * change.
 */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { db, emailSuppressionsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../logger";

export type EmailProviderName = "gmail" | "postmark" | "resend" | "sendgrid";

export interface TransactionalEmail {
  /** Recipient address (or comma-separated list — provider may split). */
  to: string;
  /** Optional explicit From override; defaults to `EMAIL_FROM` env or KHARAGOLF default. */
  from?: string;
  subject: string;
  html: string;
  text?: string;
  /** Optional Reply-To header (used by support flows). */
  replyTo?: string;
  /** Provider-agnostic tags — used for analytics + bounce/complaint attribution. */
  tags?: string[];
  /** Free-form metadata forwarded to providers that support it (Postmark/Resend). */
  metadata?: Record<string, string>;
  /**
   * Additional RFC 5322 headers (e.g. `List-Unsubscribe`,
   * `List-Unsubscribe-Post`) added verbatim to the outgoing message. Used by
   * one-click unsubscribe flows so mail clients (Gmail, Apple Mail, Outlook)
   * surface their native unsubscribe affordance. Provider stubs that do not
   * yet implement headers are free to ignore them.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Originating organization id for suppression scoping. When provided, the
   * suppression check (Task #1139) is scoped to that org; otherwise we treat
   * a suppression in *any* org as a signal that the address is bad and
   * short-circuit the send.
   */
  organizationId?: number;
  /**
   * Critical-security flows (e.g. password reset) opt out of the suppression
   * check via this flag so locked-out admins can still recover access even if
   * an earlier transient bounce parked them on the suppression list.
   */
  bypassSuppression?: boolean;
}

export interface SendResult {
  ok: boolean;
  provider: EmailProviderName;
  /** Provider-issued message id when available. */
  messageId?: string;
  error?: string;
  /**
   * True when the recipient was on the `email_suppressions` list and the
   * send was short-circuited (Task #1139). `ok` is still `true` because this
   * is the desired behaviour, not a delivery failure — but callers that want
   * to record `emailDelivered: false` can branch on this flag.
   */
  suppressed?: boolean;
}

export interface MailProvider {
  readonly name: EmailProviderName;
  /** Whether the provider has the credentials it needs to actually deliver. */
  isConfigured(): boolean;
  send(msg: TransactionalEmail): Promise<SendResult>;
}

// ───────────────────────────── Gmail (default) ────────────────────────────

const GMAIL_USER = process.env.GMAIL_USER ?? "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD ?? "";

let gmailTransport: Transporter | null = null;
function getGmailTransport(): Transporter {
  if (!gmailTransport) {
    gmailTransport = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return gmailTransport;
}

const gmailProvider: MailProvider = {
  name: "gmail",
  isConfigured() {
    return Boolean(GMAIL_USER && GMAIL_APP_PASSWORD);
  },
  async send(msg) {
    if (!this.isConfigured()) {
      return { ok: false, provider: "gmail", error: "GMAIL_USER / GMAIL_APP_PASSWORD not set" };
    }
    try {
      const info = await getGmailTransport().sendMail({
        from: msg.from ?? defaultFrom(),
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        replyTo: msg.replyTo,
        // Gmail does not natively support tags/metadata — preserved as headers
        // so future log scraping can correlate. `extraHeaders` (e.g.
        // List-Unsubscribe for one-click unsubscribe flows) are merged in
        // verbatim and override any same-named X-Email-* header above.
        headers:
          msg.tags?.length || msg.metadata || msg.extraHeaders
            ? {
                ...(msg.tags?.length ? { "X-Email-Tag": msg.tags.join(",") } : {}),
                ...(msg.metadata
                  ? Object.fromEntries(
                      Object.entries(msg.metadata).map(([k, v]) => [`X-Email-Meta-${k}`, String(v)]),
                    )
                  : {}),
                ...(msg.extraHeaders ?? {}),
              }
            : undefined,
      });
      return { ok: true, provider: "gmail", messageId: info.messageId };
    } catch (err) {
      const msgText = err instanceof Error ? err.message : String(err);
      return { ok: false, provider: "gmail", error: msgText };
    }
  },
};

// ─────────────────── Future providers (skeletons) ─────────────────────────
// These are intentionally minimal. They throw `not_implemented` until their
// envs are wired and a thin HTTP client is added. The shape is stable so the
// switchover is "set EMAIL_PROVIDER=resend + add RESEND_API_KEY" — no
// changes anywhere else.

function makeStubProvider(name: EmailProviderName, envKey: string): MailProvider {
  return {
    name,
    isConfigured() {
      return Boolean(process.env[envKey]);
    },
    async send() {
      return {
        ok: false,
        provider: name,
        error: `${name} provider not yet implemented — set EMAIL_PROVIDER=gmail or implement the ${name} adapter`,
      };
    },
  };
}

// ───────────────────────────── Postmark ───────────────────────────────────
//
// Real production provider. Wired up in Task #981.
//
// Config:
//   POSTMARK_SERVER_TOKEN   — required; the per-server API token from
//                             the Postmark dashboard. Without it the
//                             provider reports `isConfigured() === false`
//                             and `send()` returns an error.
//   POSTMARK_MESSAGE_STREAM — optional; defaults to "outbound" (Postmark's
//                             default transactional stream).
//
// Bounces, spam complaints and unsubscribes are surfaced via the bounce
// webhook at `POST /api/webhooks/postmark` (see `routes/webhooks.ts`).
// Each transactional email forwards `tags` and `metadata` so the webhook
// can attribute events back to the originating org.

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

interface PostmarkErrorBody {
  ErrorCode?: number;
  Message?: string;
  MessageID?: string;
}

interface PostmarkSuccessBody {
  ErrorCode: number;
  Message: string;
  MessageID: string;
  SubmittedAt?: string;
  To?: string;
}

const postmarkProvider: MailProvider = {
  name: "postmark",
  isConfigured() {
    return Boolean(process.env.POSTMARK_SERVER_TOKEN);
  },
  async send(msg) {
    const token = process.env.POSTMARK_SERVER_TOKEN;
    if (!token) {
      return { ok: false, provider: "postmark", error: "POSTMARK_SERVER_TOKEN not set" };
    }
    const stream = process.env.POSTMARK_MESSAGE_STREAM || "outbound";
    const payload: Record<string, unknown> = {
      From: msg.from ?? defaultFrom(),
      To: msg.to,
      Subject: msg.subject,
      HtmlBody: msg.html,
      MessageStream: stream,
    };
    if (msg.text) payload.TextBody = msg.text;
    if (msg.replyTo) payload.ReplyTo = msg.replyTo;
    if (msg.tags?.length) {
      // Postmark only supports a single Tag string; join multiple for
      // search-ability and forward the full list as Metadata as well.
      payload.Tag = msg.tags[0];
    }
    if (msg.metadata || msg.tags?.length) {
      const meta: Record<string, string> = {};
      if (msg.metadata) {
        for (const [k, v] of Object.entries(msg.metadata)) meta[k] = String(v);
      }
      if (msg.tags?.length) meta.tags = msg.tags.join(",");
      payload.Metadata = meta;
    }

    try {
      const res = await fetch(POSTMARK_API_URL, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": token,
        },
        body: JSON.stringify(payload),
      });
      const bodyText = await res.text();
      let body: PostmarkSuccessBody | PostmarkErrorBody | null = null;
      try { body = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON */ }
      if (!res.ok || (body && typeof body.ErrorCode === "number" && body.ErrorCode !== 0)) {
        const errMsg = body?.Message ?? `HTTP ${res.status}`;
        return { ok: false, provider: "postmark", error: errMsg };
      }
      const messageId = body && "MessageID" in body ? body.MessageID : undefined;
      return { ok: true, provider: "postmark", messageId };
    } catch (err) {
      const msgText = err instanceof Error ? err.message : String(err);
      return { ok: false, provider: "postmark", error: msgText };
    }
  },
};

/**
 * Task #1556 — fetch the rendered body / headers of a previously sent
 * Postmark message by its `MessageID`. Used by the Suppressions tab so an
 * admin can jump from a bounce row straight to the email that bounced
 * without logging into Postmark and searching by ID.
 *
 * The MessageID format is the UUID returned by Postmark on send and stored
 * in `email_suppressions.message_id`. The caller is responsible for
 * verifying that the requested MessageID actually belongs to the org
 * (we look it up against `email_suppressions` first).
 *
 * Returns `null` when the provider isn't configured or the message can't
 * be found / the API call failed; throws nothing so the route can render
 * a friendly 404 / 502 response.
 */
export interface PostmarkMessageDetails {
  messageId: string;
  to: Array<{ Email: string; Name?: string }>;
  cc: Array<{ Email: string; Name?: string }>;
  bcc: Array<{ Email: string; Name?: string }>;
  from: string;
  subject: string;
  htmlBody: string | null;
  textBody: string | null;
  status: string | null;
  receivedAt: string | null;
  tag: string | null;
  metadata: Record<string, string> | null;
  recipients: string[];
}

interface PostmarkMessageDetailsRaw {
  MessageID?: string;
  To?: Array<{ Email: string; Name?: string }>;
  Cc?: Array<{ Email: string; Name?: string }>;
  Bcc?: Array<{ Email: string; Name?: string }>;
  From?: string;
  Subject?: string;
  HtmlBody?: string;
  TextBody?: string;
  Status?: string;
  ReceivedAt?: string;
  Tag?: string;
  Metadata?: Record<string, string>;
  Recipients?: string[];
}

export async function fetchPostmarkMessageDetails(messageId: string): Promise<
  | { ok: true; details: PostmarkMessageDetails }
  | { ok: false; status: number; error: string }
> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) {
    return { ok: false, status: 503, error: "POSTMARK_SERVER_TOKEN not set" };
  }
  if (!messageId || typeof messageId !== "string") {
    return { ok: false, status: 400, error: "messageId is required" };
  }
  // Postmark MessageIDs are UUIDs. Reject anything else up-front to avoid
  // forwarding bogus path segments to api.postmarkapp.com.
  if (!/^[0-9a-f-]{8,}$/i.test(messageId)) {
    return { ok: false, status: 400, error: "messageId is not a valid Postmark MessageID" };
  }
  const url = `https://api.postmarkapp.com/messages/outbound/${encodeURIComponent(messageId)}/details`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Postmark-Server-Token": token,
      },
    });
    const bodyText = await res.text();
    let body: PostmarkMessageDetailsRaw | null = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      const errMsg = (body as PostmarkErrorBody | null)?.Message ?? `HTTP ${res.status}`;
      // 404 from Postmark → message has aged out (Postmark retains bodies
      // for ~45 days on most plans) or doesn't belong to this server token.
      const status = res.status === 404 ? 404 : 502;
      return { ok: false, status, error: errMsg };
    }
    if (!body) {
      return { ok: false, status: 502, error: "Postmark returned an empty response" };
    }
    return {
      ok: true,
      details: {
        messageId: body.MessageID ?? messageId,
        to: body.To ?? [],
        cc: body.Cc ?? [],
        bcc: body.Bcc ?? [],
        from: body.From ?? "",
        subject: body.Subject ?? "",
        htmlBody: body.HtmlBody ?? null,
        textBody: body.TextBody ?? null,
        status: body.Status ?? null,
        receivedAt: body.ReceivedAt ?? null,
        tag: body.Tag ?? null,
        metadata: body.Metadata ?? null,
        recipients: body.Recipients ?? [],
      },
    };
  } catch (err) {
    const msgText = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: msgText };
  }
}

const resendProvider = makeStubProvider("resend", "RESEND_API_KEY");
const sendgridProvider = makeStubProvider("sendgrid", "SENDGRID_API_KEY");

const PROVIDERS: Record<EmailProviderName, MailProvider> = {
  gmail: gmailProvider,
  postmark: postmarkProvider,
  resend: resendProvider,
  sendgrid: sendgridProvider,
};

// ───────────────────────────── Public API ─────────────────────────────────

function selectedProviderName(): EmailProviderName {
  const raw = (process.env.EMAIL_PROVIDER ?? "gmail").toLowerCase();
  if (raw === "postmark" || raw === "resend" || raw === "sendgrid" || raw === "gmail") {
    return raw;
  }
  logger.warn({ raw }, "[email/adapter] Unknown EMAIL_PROVIDER, falling back to gmail");
  return "gmail";
}

function defaultFrom(): string {
  const explicit = process.env.EMAIL_FROM;
  if (explicit) return explicit;
  const user = process.env.GMAIL_USER || "noreply@kharagolf.com";
  return `"KHARAGOLF" <${user}>`;
}

/** Returns the currently selected provider (respects EMAIL_PROVIDER). */
export function getActiveMailProvider(): MailProvider {
  return PROVIDERS[selectedProviderName()];
}

/**
 * The single entry point for transactional email. All `mailer.ts` helpers
 * funnel through this internally; new code should call this directly.
 */
/**
 * Task #1139 — short-circuit transactional sends to recipients we have
 * already classified as bad (hard bounce, spam complaint, unsubscribe). The
 * suppression list is populated by the Postmark webhook (Task #981) and the
 * marketing campaign UI. When `organizationId` is provided we scope the
 * lookup to that org; otherwise we treat any suppression as authoritative
 * because a hard bounce in one club still means the address is dead.
 *
 * Returns the matching suppression reason string when the send should be
 * skipped, or `null` when delivery may proceed. Failures of the lookup
 * itself (e.g. transient DB error) fail-open: we log and let the message
 * through rather than silently swallowing real traffic.
 */
async function findSuppressionReason(
  to: string,
  organizationId?: number,
): Promise<string | null> {
  const recipients = to
    .split(",")
    .map(s => s.trim())
    .map(s => {
      const m = s.match(/<([^>]+)>/);
      return (m ? m[1] : s).toLowerCase();
    })
    .filter(Boolean);
  if (recipients.length === 0) return null;
  try {
    const lowered = sql`lower(${emailSuppressionsTable.email})`;
    const where = organizationId !== undefined
      ? and(
          eq(emailSuppressionsTable.organizationId, organizationId),
          sql`${lowered} in ${recipients}`,
        )
      : sql`${lowered} in ${recipients}`;
    const rows = await db
      .select({ reason: emailSuppressionsTable.reason })
      .from(emailSuppressionsTable)
      .where(where)
      .limit(1);
    return rows.length > 0 ? (rows[0].reason ?? "suppressed") : null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[email/adapter] suppression check failed; allowing send",
    );
    return null;
  }
}

export async function sendTransactionalEmail(msg: TransactionalEmail): Promise<SendResult> {
  const provider = getActiveMailProvider();
  if (!msg.bypassSuppression) {
    const reason = await findSuppressionReason(msg.to, msg.organizationId);
    if (reason) {
      logger.info(
        { to: msg.to, subject: msg.subject, reason, orgId: msg.organizationId },
        "[email] suppressed — recipient on email_suppressions list, skipping send",
      );
      return { ok: true, provider: provider.name, suppressed: true };
    }
  }
  const result = await provider.send(msg);
  if (!result.ok) {
    logger.warn({ provider: result.provider, error: result.error, to: msg.to, subject: msg.subject }, "[email] send failed");
  } else {
    logger.debug({ provider: result.provider, messageId: result.messageId, to: msg.to }, "[email] sent");
  }
  return result;
}

/**
 * Logs a startup banner naming the active provider and whether it is wired.
 * Replaces the old `validateMailerConfig()` (which is kept as a thin wrapper
 * for backwards compatibility).
 */
export function logActiveProviderStatus(): boolean {
  const provider = getActiveMailProvider();
  const ok = provider.isConfigured();
  if (!ok) {
    logger.warn(
      { provider: provider.name },
      "[email/adapter] Active provider has no credentials — transactional email will fail until configured",
    );
  } else {
    logger.info({ provider: provider.name }, "[email/adapter] Transactional email provider configured");
  }
  return ok;
}
