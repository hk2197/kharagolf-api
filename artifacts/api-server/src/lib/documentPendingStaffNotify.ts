/**
 * Task #1909 — Staff "new member document awaiting review" notification helper.
 *
 * When a member uploads a new document via the portal, we notify every
 * org_admin / membership_secretary who hasn't opted out via push and email.
 * This helper:
 *   1. Loads the member, organisation (incl. `defaultLanguage`) and staff
 *      recipients from the database.
 *   2. Composes the localised push title/body and email subject/body via
 *      `composeDocumentPendingStaffNotification` (EN fallback, 21 languages
 *      mirroring `adminEmailI18n.ts`).
 *   3. Best-effort fans the notice out — failures are logged but never
 *      thrown so the upload response is never blocked.
 *
 * Previously this lived inline in `portal.ts` with hardcoded English copy.
 */
import {
  db,
  appUsersTable,
  clubMembersTable,
  organizationsTable,
  orgMembershipsTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { sendBroadcastEmail } from "./mailer";
import { sendTransactionalPush } from "./comms";
import { resolveOrgBranding } from "./clubTheming.js";
import { composeDocumentPendingStaffNotification } from "./adminEmailI18n";
import { logger } from "./logger";

export interface NotifyDocumentPendingStaffOpts {
  organizationId: number;
  clubMemberId: number;
  documentId: number;
  documentType: string;
  /** Member-supplied document title (already trimmed by the caller). */
  title: string;
}

export interface NotifyDocumentPendingStaffResult {
  recipients: number;
  pushAttempted: boolean;
  emailsSent: number;
  emailsFailed: number;
}

export async function notifyDocumentPendingStaff(
  opts: NotifyDocumentPendingStaffOpts,
): Promise<NotifyDocumentPendingStaffResult> {
  const { organizationId, clubMemberId, documentId, documentType, title } = opts;

  const [member] = await db.select({
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
  }).from(clubMembersTable).where(eq(clubMembersTable.id, clubMemberId));

  const [org] = await db.select({
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    // Task #1909 — load defaultLanguage so the staff notification renders in
    // the club's configured language (EN fallback handled in the composer).
    defaultLanguage: organizationsTable.defaultLanguage,
  }).from(organizationsTable).where(eq(organizationsTable.id, organizationId));

  // Task #1758 — let the saved club_theming row override the legacy
  // `organizations.logo_url` column so the staff "new document awaiting
  // review" email uses the same logo the admin most recently picked.
  const branded = await resolveOrgBranding(organizationId, org);

  const staffRaw = await db.select({
    userId: orgMembershipsTable.userId,
    email: appUsersTable.email,
    displayName: appUsersTable.displayName,
    notifyMemberDocuments: userNotificationPrefsTable.notifyMemberDocuments,
  })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
    .leftJoin(userNotificationPrefsTable, eq(userNotificationPrefsTable.userId, orgMembershipsTable.userId))
    .where(and(
      eq(orgMembershipsTable.organizationId, organizationId),
      inArray(orgMembershipsTable.role, ["org_admin", "membership_secretary"]),
    ));

  // Honour per-staff opt-out (defaults to true when no prefs row exists).
  const staff = staffRaw.filter(s => s.notifyMemberDocuments !== false);

  const memberName = member
    ? `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim() || `Member #${clubMemberId}`
    : `Member #${clubMemberId}`;
  const orgName = org?.name ?? "your club";
  const orgLang = org?.defaultLanguage ?? null;
  const docTypeLabel = String(documentType).replace(/_/g, " ");
  const docLabel = title.trim();

  const notification = composeDocumentPendingStaffNotification({
    lang: orgLang,
    memberName,
    docTypeLabel,
    docLabel,
  });

  const userIds = staff.map(s => s.userId).filter((id): id is number => typeof id === "number");
  let pushAttempted = false;
  if (userIds.length > 0) {
    pushAttempted = true;
    // Task #1240 — fire-and-forget broadcast to org admins; the
    // PushDeliveryResult is discarded (failures are logged by the caller),
    // so no `classifyPushDelivery` mapping is needed. The email fan-out
    // below is the durable channel; admins without an Expo token quietly
    // miss the push.
    await sendTransactionalPush(
      userIds,
      notification.pushTitle,
      notification.pushBody,
      {
        type: "member_document_pending",
        memberId: String(clubMemberId),
        documentId: String(documentId),
        organizationId: String(organizationId),
      },
    );
  }

  let emailsSent = 0;
  let emailsFailed = 0;
  for (const s of staff) {
    if (!s.email) continue;
    try {
      // Task #1319 — pass `orgId` so member-document staff notification
      // bounces are tagged back to this club via the Postmark webhook
      // (Task #981) instead of falling through to the campaign /
      // membership scan.
      await sendBroadcastEmail(
        s.email,
        s.displayName ?? "",
        notification.emailSubject,
        notification.emailBody,
        orgName,
        { logoUrl: branded.logoUrl ?? undefined, orgName, orgId: organizationId },
      );
      emailsSent++;
    } catch (err) {
      emailsFailed++;
      logger.warn({ err, email: s.email }, "[member-documents] staff notification email failed");
    }
  }

  return {
    recipients: staff.length,
    pushAttempted,
    emailsSent,
    emailsFailed,
  };
}
