/**
 * Document-unreject notification helper (Task 257).
 *
 * When staff withdraws a previous rejection on a member-uploaded document
 * (because the rejection was a mistake), we let the member know the prior
 * rejection has been cleared and the document is back in the pending queue:
 *   1. An in-app `member_messages` row is always written.
 *   2. A best-effort email is sent to the address on file.
 *   3. Push, SMS and WhatsApp are fanned out to members opted in to the
 *      `operations` category — same channel set used by the rejection notice
 *      itself, so members hear the correction on the same channels they
 *      heard the rejection on.
 *
 * Failures are logged but never thrown — the unreject itself is already
 * persisted and audited by the time we're called.
 *
 * Task #1538 — the in-app subject/body, push title/body, SMS body, and
 * WhatsApp body now render in the org's `defaultLanguage` (with English
 * fallback) via `composeDocumentUnrejectedNotification`. Previously every
 * channel rendered hardcoded English even on Hindi/Arabic/Spanish/etc.
 * clubs, mismatching the rest of the document-rejection flow that Task
 * #1267 had already localised.
 */
import {
  db,
  memberMessagesTable,
  memberCommPrefsTable,
  clubMembersTable,
  organizationsTable,
  type MemberDocument,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { sendBroadcastEmail, classifyMailerError } from "./mailer";
import { sendTransactionalPush, sendTransactionalSms, sendTransactionalWhatsapp } from "./comms";
import { composeDocumentUnrejectedNotification } from "./adminEmailI18n";
import { logger } from "./logger";

export type ChannelStatus =
  | "sent"
  | "failed"
  | "no_address"
  | "no_user"
  | "opted_out"
  | "skipped";

export interface NotifyDocumentUnrejectedResult {
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

async function loadOperationsOptIns(clubMemberId: number): Promise<{ email: boolean; push: boolean; sms: boolean; whatsapp: boolean }> {
  const rows = await db.select({
    emailEnabled: memberCommPrefsTable.emailEnabled,
    pushEnabled: memberCommPrefsTable.pushEnabled,
    smsEnabled: memberCommPrefsTable.smsEnabled,
    whatsappEnabled: memberCommPrefsTable.whatsappEnabled,
  }).from(memberCommPrefsTable).where(and(
    eq(memberCommPrefsTable.clubMemberId, clubMemberId),
    eq(memberCommPrefsTable.category, "operations"),
  )).limit(1);

  if (rows.length === 0) return { email: true, push: true, sms: false, whatsapp: false };
  return {
    email: Boolean(rows[0].emailEnabled),
    push: Boolean(rows[0].pushEnabled),
    sms: Boolean(rows[0].smsEnabled),
    whatsapp: Boolean(rows[0].whatsappEnabled),
  };
}

export async function notifyDocumentUnrejected(opts: {
  organizationId: number;
  clubMemberId: number;
  document: Pick<MemberDocument, "id" | "title" | "documentType">;
  reason?: string | null;
  senderUserId?: number | null;
}): Promise<NotifyDocumentUnrejectedResult> {
  const { organizationId, clubMemberId, document, reason, senderUserId } = opts;

  const [member] = await db.select({
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    email: clubMembersTable.email,
    phone: clubMembersTable.phone,
    userId: clubMembersTable.userId,
  }).from(clubMembersTable).where(eq(clubMembersTable.id, clubMemberId)).limit(1);

  const [org] = await db.select({
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
    // Task #1538 — load defaultLanguage so the notification copy renders
    // in the club's configured language (EN fallback handled in the
    // composer helper).
    defaultLanguage: organizationsTable.defaultLanguage,
  }).from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);

  const orgName = org?.name ?? "KHARAGOLF";
  const orgLang = org?.defaultLanguage ?? null;
  const memberName = member ? `${member.firstName} ${member.lastName}`.trim() : "there";
  const docLabel = document.title || document.documentType;

  // Task #1538 — compose the in-app subject/body, push title/body, SMS body,
  // and WhatsApp body in the org's `defaultLanguage` (EN fallback) so a
  // Hindi/Arabic/Spanish/etc. club no longer receives English-only copy on
  // any of the operations channels.
  const notification = composeDocumentUnrejectedNotification({
    lang: orgLang,
    memberName: memberName || "there",
    docLabel,
    orgName,
    reason,
  });
  const subject = notification.inAppSubject;
  const body = notification.inAppBody;

  const optIns = member ? await loadOperationsOptIns(clubMemberId) : { email: true, push: true, sms: false, whatsapp: false };

  let inAppMessageId: number | null = null;
  try {
    const [msgRow] = await db.insert(memberMessagesTable).values({
      organizationId,
      clubMemberId,
      senderUserId: senderUserId ?? null,
      channel: "in_app",
      subject,
      body,
      status: "sent",
    }).returning({ id: memberMessagesTable.id });
    inAppMessageId = msgRow?.id ?? null;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), docId: document.id }, "[doc-unrejected-notify] Failed to write in-app message");
  }

  let emailStatus: ChannelStatus;
  let emailError: string | undefined;
  if (!member?.email) {
    emailStatus = "no_address";
  } else if (!optIns.email) {
    emailStatus = "opted_out";
  } else {
    try {
      await sendBroadcastEmail(
        member.email,
        memberName || "Member",
        subject,
        body,
        orgName,
        (org?.logoUrl || org?.primaryColor)
          ? { logoUrl: org?.logoUrl ?? undefined, primaryColor: org?.primaryColor ?? undefined }
          : undefined,
      );
      emailStatus = "sent";
    } catch (err) {
      // Provider misconfiguration → terminal `skipped` so the audit
      // log isn't polluted (and admins aren't billed) for an env
      // issue. Mirrors the SMS/WhatsApp blocks below.
      if (classifyMailerError(err) === "provider_unconfigured") {
        emailStatus = "skipped";
        emailError = "provider_not_configured";
      } else {
        emailStatus = "failed";
        emailError = err instanceof Error ? err.message : String(err);
        logger.error({ errMsg: emailError, docId: document.id }, "[doc-unrejected-notify] Email failed");
      }
    }
  }

  let pushStatus: ChannelStatus = "skipped";
  let pushError: string | undefined;
  if (!member?.userId) {
    pushStatus = "no_user";
  } else if (!optIns.push) {
    pushStatus = "opted_out";
  } else {
    try {
      const result = await sendTransactionalPush(
        [member.userId],
        notification.pushTitle,
        notification.pushBody,
        { type: "document_unrejected", documentId: document.id },
      );
      if (result.sent > 0) pushStatus = "sent";
      else if (result.attempted === 0 || result.invalid === result.attempted) pushStatus = "no_address";
      else { pushStatus = "failed"; pushError = "push_delivery_failed"; }
    } catch (err) {
      pushStatus = "failed";
      pushError = err instanceof Error ? err.message : String(err);
      logger.error({ errMsg: pushError, docId: document.id }, "[doc-unrejected-notify] Push failed");
    }
  }

  let smsStatus: ChannelStatus = "skipped";
  let smsError: string | undefined;
  if (!optIns.sms) {
    smsStatus = "opted_out";
  } else if (!member?.phone) {
    smsStatus = "no_address";
  } else {
    try {
      await sendTransactionalSms(member.phone, notification.smsBody);
      smsStatus = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/SMS_PROVIDER not configured/i.test(msg)) {
        smsStatus = "skipped";
        smsError = "provider_not_configured";
      } else {
        smsStatus = "failed";
        smsError = msg;
        logger.error({ errMsg: msg, docId: document.id }, "[doc-unrejected-notify] SMS failed");
      }
    }
  }

  // WhatsApp — opt-in only, skipped silently when no provider configured.
  // Mirrors the SMS block: KYC document review is operational, so the
  // operations-category opt-in for WhatsApp gates this fan-out and the
  // member must have a phone on file. Provider-not-configured collapses to
  // `skipped` so dev environments don't show false-failed badges.
  let whatsappStatus: ChannelStatus = "skipped";
  let whatsappError: string | undefined;
  if (!optIns.whatsapp) {
    whatsappStatus = "opted_out";
  } else if (!member?.phone) {
    whatsappStatus = "no_address";
  } else {
    try {
      await sendTransactionalWhatsapp(member.phone, notification.whatsappBody);
      whatsappStatus = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/WHATSAPP_PROVIDER not configured/i.test(msg)) {
        whatsappStatus = "skipped";
        whatsappError = "provider_not_configured";
      } else {
        whatsappStatus = "failed";
        whatsappError = msg;
        logger.error({ errMsg: msg, docId: document.id }, "[doc-unrejected-notify] WhatsApp failed");
      }
    }
  }

  return { inAppMessageId, emailStatus, emailError, pushStatus, pushError, smsStatus, smsError, whatsappStatus, whatsappError };
}
