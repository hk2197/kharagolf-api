/**
 * Unified communications abstraction.
 *
 * Supported channels and their readiness:
 *   email    — Gmail SMTP via mailer.ts (fully operational)
 *   push     — Expo Push Notifications via push.ts (fully operational)
 *   sms      — gracefully skipped when SMS_PROVIDER_API_KEY is absent;
 *              set SMS_PROVIDER=msg91 or SMS_PROVIDER=twilio and supply credentials
 *              to activate (see sendSms implementation below)
 *   whatsapp — gracefully skipped when WHATSAPP_PROVIDER_API_KEY is absent;
 *              set WHATSAPP_PROVIDER=msg91 or WHATSAPP_PROVIDER=twilio and supply
 *              credentials to activate (see sendWhatsApp implementation below).
 *              In KHARAGOLF production WhatsApp is dispatched via MSG91 — the
 *              same provider already configured for SMS — so no additional env
 *              vars need to be introduced for per-surface WhatsApp fan-out
 *              (Task #296). Per-surface notify helpers should treat a
 *              "WHATSAPP_PROVIDER not configured" error as terminal-skipped
 *              exactly like the SMS retry pattern, so the retry cron does not
 *              loop on environments without WhatsApp credentials.
 *
 * All channels record per-recipient send/fail counts into DeliveryStats,
 * which callers persist to messageLogsTable.deliveryStats.
 */

import { sendBroadcastEmail, sendInvitationEmail } from "./mailer";
import { sendPushToUsers, registerDeviceToken, unregisterDeviceToken, type PushDeliveryResult } from "./push";
export type { PushDeliveryResult };

export type Channel = "email" | "push" | "sms" | "whatsapp";

export interface Recipient {
  email?: string | null;
  phone?: string | null;
  firstName: string;
  lastName: string;
  userId?: number | null;
  /** Optional: the channels this recipient has opted in to. If present, the broadcast channels
   * are intersected with these preferences so opted-out recipients are skipped per channel. */
  preferredChannels?: Channel[] | null;
}

export interface BroadcastOptions {
  subject?: string;
  body: string;
  channels: Channel[];
  eventName: string;
  tournamentId?: number | null;
  leagueId?: number | null;
  /** Club branding — passed to the HTML email template when available */
  logoUrl?: string | null;
  primaryColor?: string | null;
  /**
   * Task #1319 — when present, propagated as `metadata.orgId` on the
   * outgoing email so the Postmark bounce webhook (Task #981) attributes
   * bounces / spam complaints / unsubscribes back to the originating club
   * instantly, instead of falling back to scanning campaigns / memberships.
   * Callers that already know the club id (most transactional broadcasts)
   * should pass it here.
   */
  organizationId?: number | null;
}

export type DeliveryStats = Record<string, { sent: number; failed: number; reason?: string }>;

/**
 * Send a broadcast message to a list of recipients via the specified channels.
 * Returns per-channel delivery stats for persistence in the message log.
 * All channel errors are caught individually — a failure on one channel does
 * not abort delivery on others.
 */
export async function sendBroadcast(recipients: Recipient[], opts: BroadcastOptions): Promise<DeliveryStats> {
  const { subject, body, channels, eventName, tournamentId, leagueId, logoUrl, primaryColor, organizationId } = opts;
  // Task #1319 — forward `organizationId` so the per-recipient broadcast email
  // carries `metadata.orgId` and the Postmark bounce webhook can tag the
  // resulting bounce/complaint back to the originating club without scanning.
  const orgIdNum = typeof organizationId === "number" && Number.isFinite(organizationId) ? organizationId : undefined;
  const emailBranding = (logoUrl || primaryColor || orgIdNum !== undefined)
    ? { logoUrl: logoUrl ?? undefined, primaryColor: primaryColor ?? undefined, orgId: orgIdNum }
    : undefined;

  const stats: DeliveryStats = {};
  const track = (ch: string, success: boolean, reason?: string) => {
    if (!stats[ch]) stats[ch] = { sent: 0, failed: 0 };
    if (success) {
      stats[ch].sent++;
    } else {
      stats[ch].failed++;
      if (reason && !stats[ch].reason) stats[ch].reason = reason;
    }
  };

  for (const r of recipients) {
    const fullName = `${r.firstName} ${r.lastName}`.trim();
    // If this recipient has stated preferences, intersect with the requested channels.
    // A null/undefined preferredChannels means "no stored preference → honour all channels".
    const recipientChannels = r.preferredChannels
      ? channels.filter(c => r.preferredChannels!.includes(c))
      : channels;

    if (recipientChannels.includes("email") && r.email) {
      try {
        await sendBroadcastEmail(r.email, fullName, subject || `Message from ${eventName}`, body, eventName, emailBranding);
        track("email", true);
      } catch (err) {
        console.warn("[comms] email delivery failed for", r.email, err);
        track("email", false, err instanceof Error ? err.message : "smtp_error");
      }
    }

    if (recipientChannels.includes("sms") && r.phone) {
      try {
        await sendSms(r.phone, body);
        track("sms", true);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "sms_error";
        console.warn("[comms] sms delivery failed for", r.phone, reason);
        track("sms", false, reason);
      }
    }

    if (recipientChannels.includes("whatsapp") && r.phone) {
      try {
        await sendWhatsApp(r.phone, body);
        track("whatsapp", true);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "whatsapp_error";
        console.warn("[comms] whatsapp delivery failed for", r.phone, reason);
        track("whatsapp", false, reason);
      }
    }
  }

  if (channels.includes("push")) {
    // For push, only include recipients who prefer push (or have no stored preference)
    const userIds = recipients
      .filter(r => !r.preferredChannels || r.preferredChannels.includes("push"))
      .map(r => r.userId)
      .filter((id): id is number => typeof id === "number" && id > 0);

    if (userIds.length > 0) {
      const result = await sendPushToUsers(userIds, subject || eventName, body, { type: "broadcast", tournamentId, leagueId });
      stats["push"] = {
        sent: result.sent,
        failed: result.failed + result.invalid,
        ...(result.failed + result.invalid > 0 ? { reason: result.invalid > 0 ? "invalid_tokens" : "push_error" } : {}),
      };
    }
  }

  return stats;
}

export interface InviteOptions {
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  recipientName: string;
  eventName: string;
  eventType: "tournament" | "league";
  inviteUrl: string;
  orgName: string;
  channels?: Channel[];
  /**
   * Task #1319 — propagated as `metadata.orgId` on the outgoing invitation
   * email so the Postmark bounce webhook (Task #981) can attribute bounces
   * back to the originating club without scanning campaigns / memberships.
   */
  organizationId?: number | null;
}

/**
 * Send an invitation via all selected channels.
 * Email is dispatched via SMTP. SMS and WhatsApp are dispatched when provider
 * credentials are configured via environment variables; otherwise the channel
 * is skipped silently and callers should surface a "channel not configured"
 * warning in their response payload.
 */
export async function sendInvite(opts: InviteOptions): Promise<DeliveryStats> {
  const channels = opts.channels ?? ["email"];
  const stats: DeliveryStats = {};
  const track = (ch: string, success: boolean, reason?: string) => {
    if (!stats[ch]) stats[ch] = { sent: 0, failed: 0 };
    if (success) { stats[ch].sent++; } else { stats[ch].failed++; if (reason) stats[ch].reason = reason; }
  };

  if (channels.includes("email") && opts.recipientEmail) {
    try {
      // Task #1319 — when the caller knows the club id, forward it via the
      // `branding` arg so the outgoing invite carries `metadata.orgId` and
      // the Postmark bounce webhook attributes a hard bounce back to this
      // club instantly.
      const orgIdNum = typeof opts.organizationId === "number" && Number.isFinite(opts.organizationId) ? opts.organizationId : undefined;
      await sendInvitationEmail(
        opts.recipientEmail,
        opts.recipientName,
        opts.eventName,
        opts.eventType,
        opts.inviteUrl,
        opts.orgName,
        orgIdNum !== undefined ? { orgId: orgIdNum } : undefined,
      );
      track("email", true);
    } catch (err) {
      track("email", false, err instanceof Error ? err.message : "smtp_error");
    }
  }

  const inviteBody = `You have been invited to ${opts.eventName}. Join here: ${opts.inviteUrl}`;

  if (channels.includes("sms") && opts.recipientPhone) {
    try {
      await sendSms(opts.recipientPhone, inviteBody);
      track("sms", true);
    } catch (err) {
      track("sms", false, err instanceof Error ? err.message : "sms_error");
    }
  }

  if (channels.includes("whatsapp") && opts.recipientPhone) {
    try {
      await sendWhatsApp(opts.recipientPhone, inviteBody);
      track("whatsapp", true);
    } catch (err) {
      track("whatsapp", false, err instanceof Error ? err.message : "whatsapp_error");
    }
  }

  return stats;
}

/**
 * Send a transactional push notification to specific user IDs.
 * Used for event-driven triggers: registration confirmed, tee time assigned,
 * score verified/rejected, results published, standings updated, invitation received.
 */
export async function sendTransactionalPush(
  userIds: number[],
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<PushDeliveryResult> {
  if (userIds.length === 0) return { attempted: 0, sent: 0, failed: 0, invalid: 0 };
  return sendPushToUsers(userIds, title, body, data ?? {});
}

/**
 * Send a transactional SMS to a single recipient. Used for event-driven
 * notices (privacy-request acknowledgements, payment receipts) where the
 * caller wants to surface the provider error directly rather than aggregate
 * it into broadcast deliveryStats.
 *
 * Throws when SMS_PROVIDER is not configured or the upstream call fails.
 */
export async function sendTransactionalSms(phone: string, body: string): Promise<void> {
  return sendSms(phone, body);
}

/**
 * Send a transactional WhatsApp message to a single recipient. Used for
 * event-driven notices (privacy-request acknowledgements, levy receipts,
 * levy reminders, document-rejection alerts) where the caller wants to
 * surface the provider error directly rather than aggregate it into
 * broadcast deliveryStats. Mirrors {@link sendTransactionalSms}.
 *
 * Throws when WHATSAPP_PROVIDER is not configured or the upstream call
 * fails. The error message for the unconfigured case is stable
 * ("WHATSAPP_PROVIDER not configured ...") so per-surface retry helpers
 * can detect it (e.g. by matching /WHATSAPP_PROVIDER not configured/) and
 * flip the row to terminal `skipped` instead of looping the cron forever,
 * mirroring the existing SMS retry pattern.
 *
 * Returns the provider-issued message id (Twilio Message SID, MSG91
 * request_id) when available so callers can persist it and later correlate
 * asynchronous delivery webhooks (Task 347). Returns `null` when the
 * provider response did not include an id (e.g. during local stub runs).
 */
export async function sendTransactionalWhatsapp(phone: string, body: string): Promise<string | null> {
  return sendWhatsApp(phone, body);
}

/**
 * Send an SMS message.
 *
 * Providers supported (configure via environment variables):
 *   MSG91:  set SMS_PROVIDER=msg91, MSG91_AUTH_KEY, MSG91_SENDER_ID, MSG91_TEMPLATE_ID
 *   Twilio: set SMS_PROVIDER=twilio, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *
 * When no provider is configured the function throws ChannelNotConfiguredError
 * so callers can record the failure reason in deliveryStats without crashing.
 */
async function sendSms(phone: string, body: string): Promise<void> {
  const provider = process.env.SMS_PROVIDER?.toLowerCase();

  if (provider === "msg91") {
    const authKey = process.env.MSG91_AUTH_KEY;
    const senderId = process.env.MSG91_SENDER_ID;
    if (!authKey || !senderId) throw new Error("MSG91_AUTH_KEY or MSG91_SENDER_ID not configured");

    const res = await fetch("https://api.msg91.com/api/v5/flow/", {
      method: "POST",
      headers: { "Content-Type": "application/json", authkey: authKey },
      body: JSON.stringify({
        flow_id: process.env.MSG91_TEMPLATE_ID,
        sender: senderId,
        mobiles: phone.replace(/\D/g, ""),
        VAR1: body.substring(0, 160),
      }),
    });
    if (!res.ok) throw new Error(`MSG91 error: ${res.status} ${await res.text()}`);
    return;
  }

  if (provider === "twilio") {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!sid || !token || !from) throw new Error("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_FROM_NUMBER not configured");

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      },
      body: new URLSearchParams({ From: from, To: phone, Body: body }).toString(),
    });
    if (!res.ok) throw new Error(`Twilio error: ${res.status} ${await res.text()}`);
    return;
  }

  throw new Error("SMS_PROVIDER not configured. Set SMS_PROVIDER=msg91 or SMS_PROVIDER=twilio with required credentials.");
}

/**
 * Send a WhatsApp message.
 *
 * Providers supported:
 *   MSG91:  set WHATSAPP_PROVIDER=msg91, MSG91_WHATSAPP_AUTH_KEY, MSG91_WHATSAPP_INTEGRATED_NUMBER
 *   Twilio: set WHATSAPP_PROVIDER=twilio, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
 *
 * Throws ChannelNotConfiguredError when no provider credentials are present.
 */
async function sendWhatsApp(phone: string, body: string): Promise<string | null> {
  const provider = process.env.WHATSAPP_PROVIDER?.toLowerCase();

  if (provider === "msg91") {
    const authKey = process.env.MSG91_WHATSAPP_AUTH_KEY;
    const integratedNumber = process.env.MSG91_WHATSAPP_INTEGRATED_NUMBER;
    if (!authKey || !integratedNumber) throw new Error("MSG91_WHATSAPP_AUTH_KEY or MSG91_WHATSAPP_INTEGRATED_NUMBER not configured");

    const res = await fetch("https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/", {
      method: "POST",
      headers: { "Content-Type": "application/json", authkey: authKey },
      body: JSON.stringify({
        integrated_number: integratedNumber,
        content_type: "template",
        payload: {
          to: [{ user_whatsapp_number: phone.replace(/\D/g, "") }],
          type: "text",
          header: { type: "text", text: "KHARAGOLF" },
          text: { body },
        },
      }),
    });
    if (!res.ok) throw new Error(`MSG91 WhatsApp error: ${res.status} ${await res.text()}`);
    // MSG91 returns a `request_id` we can later correlate to webhook callbacks.
    try {
      const json = await res.json() as { request_id?: string; data?: { request_id?: string } };
      return json?.request_id ?? json?.data?.request_id ?? null;
    } catch {
      return null;
    }
  }

  if (provider === "twilio") {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_WHATSAPP_FROM;
    if (!sid || !token || !from) throw new Error("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_WHATSAPP_FROM not configured");

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      },
      body: new URLSearchParams({ From: `whatsapp:${from}`, To: `whatsapp:${phone}`, Body: body }).toString(),
    });
    if (!res.ok) throw new Error(`Twilio WhatsApp error: ${res.status} ${await res.text()}`);
    // Twilio returns the Message SID we use to map status callbacks back to
    // the originating notice (Task 347).
    try {
      const json = await res.json() as { sid?: string };
      return json?.sid ?? null;
    } catch {
      return null;
    }
  }

  throw new Error("WHATSAPP_PROVIDER not configured. Set WHATSAPP_PROVIDER=msg91 or WHATSAPP_PROVIDER=twilio with required credentials.");
}

export { registerDeviceToken, unregisterDeviceToken };
