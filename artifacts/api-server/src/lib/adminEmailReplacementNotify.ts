/**
 * Task #1549 — Notify a member when an admin uses the
 * "Re-enable + replace email" flow (POST /suppressions/:id/reenable;
 * Task #1311) to overwrite the contact email on their account.
 *
 * Today the suppression-recovery flow silently rewrites the address on
 * `app_users.email` (and matching `club_members.email` rows) without
 * telling the affected member. A member who later tries to recover their
 * password by entering their original email gets a "no such account"
 * error and has no idea why. Worse, an admin acting in bad faith could
 * silently redirect a member's contact channel.
 *
 * This helper is invoked AFTER the DB transaction in the reenable
 * handler commits. It writes:
 *   - one transactional email to the **new** address explaining what
 *     changed (always, since the member needs to know they may now have
 *     to sign in with a different email — this is a security-critical
 *     courtesy notice, not a marketing one). The email helper sets
 *     `bypassSuppression: true` so even if the new address is itself on
 *     the suppression list (e.g. a transient soft-bounce row) the notice
 *     still goes out.
 *   - one in-app `member_messages` row (always when a club_members row
 *     exists in the org) so the consent-trail surface in Member 360
 *     shows the change next to the existing audit row written by the
 *     route. The in-app row is used as the "no email channel preference"
 *     fallback when the recipient has set `preferEmail = false`, so they
 *     still see *something* in their portal even when transactional
 *     mail is suppressed at their request.
 *
 * Best-effort: every failure is caught and logged so the underlying
 * suppression-removal + email-rewrite (which has already committed) is
 * never retried or rolled back because of a delivery glitch. Mirrors
 * the contract of `adminCommPrefOverrideNotify.ts` (Task #1504).
 *
 * Self-actions (an admin re-enabling their own suppressed address) are
 * suppressed up-front — there's nothing to explain when the actor and
 * the affected member are the same person.
 */
import { db } from "@workspace/db";
import {
  appUsersTable,
  clubMembersTable,
  memberMessagesTable,
  organizationsTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  sendAccountEmailChangedByAdminEmail,
  type EmailBranding,
} from "./mailer";
import {
  buildEmailChangeDisputeUrl,
  issueEmailChangeDisputeToken,
} from "./email-change-dispute-token";
import { logger as baseLogger } from "./logger";

const logger = baseLogger.child({ module: "admin-email-replacement-notify" });

export type AdminEmailReplacementChannelStatus =
  | "sent"
  | "skipped"
  | "failed"
  | "opted_out"
  | "no_address";

export interface AdminEmailReplacementNotifyResult {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  email: { status: AdminEmailReplacementChannelStatus; error?: string };
  inApp: {
    status: AdminEmailReplacementChannelStatus;
    messageId?: number;
    error?: string;
  };
}

interface ActorLike {
  id: number;
  displayName?: string | null;
  username?: string | null;
  email?: string | null;
}

export interface AdminEmailReplacementNotifyOpts {
  organizationId: number;
  /** The user whose contact email was overwritten. */
  affectedUserId: number;
  /** The admin who triggered the re-enable + replace. */
  actor: ActorLike;
  /** The original suppressed address that was just replaced. */
  previousEmail: string;
  /** The new contact email now on file (also the delivery target). */
  newEmail: string;
  /** Stamp shown on the email + inbox row. Defaults to `now()`. */
  changedAt?: Date;
  /**
   * `member_audit_log.id` of the original `email_suppression`
   * `reenable_with_replacement` row written by the route. When provided,
   * the helper bakes a self-service dispute / revert deep link into the
   * in-app body and email so the affected member can act without having
   * to wait for the admin to respond. Omitting it (e.g. when the audit
   * insert silently failed) downgrades the notice to the original
   * "contact your admin" path — better than dropping the notice
   * entirely.
   */
  originalAuditId?: number | null;
}

function actorName(actor: ActorLike): string {
  const candidate = (actor.displayName ?? actor.username ?? actor.email ?? "")
    .toString()
    .trim();
  return candidate || "An administrator";
}

/**
 * Send the "your contact email was changed by an admin" notice to the
 * affected member at their NEW address. Idempotency guards live at the
 * call site (the route only invokes this after a successful commit and
 * only for users whose email row was actually rewritten).
 */
export async function notifyMemberOfAdminEmailReplacement(
  opts: AdminEmailReplacementNotifyOpts,
): Promise<AdminEmailReplacementNotifyResult> {
  const result: AdminEmailReplacementNotifyResult = {
    status: "skipped",
    email: { status: "skipped" },
    inApp: { status: "skipped" },
  };

  if (!Number.isInteger(opts.organizationId) || !Number.isInteger(opts.affectedUserId)) {
    result.reason = "invalid_input";
    return result;
  }
  // Self-action — admin re-enabled their own bounced address. Nothing
  // to explain.
  if (opts.actor.id === opts.affectedUserId) {
    result.reason = "self_action";
    return result;
  }
  const newEmail = (opts.newEmail ?? "").trim();
  const previousEmail = (opts.previousEmail ?? "").trim();
  if (!newEmail) {
    result.reason = "missing_new_email";
    return result;
  }

  try {
    const changedAt = opts.changedAt ?? new Date();

    // Resolve target profile, channel preference, org branding, and the
    // affected member's club_members row in parallel — keeps the
    // post-commit notify phase fast.
    const [targetUser, prefRow, org, derivedMember] = await Promise.all([
      db.select({
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
        preferredLanguage: appUsersTable.preferredLanguage,
      })
        .from(appUsersTable)
        .where(eq(appUsersTable.id, opts.affectedUserId))
        .limit(1)
        .then((rows) => rows[0]),
      db.select({ preferEmail: userNotificationPrefsTable.preferEmail })
        .from(userNotificationPrefsTable)
        .where(eq(userNotificationPrefsTable.userId, opts.affectedUserId))
        .limit(1)
        .then((rows) => rows[0]),
      db.select({
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
      })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, opts.organizationId))
        .limit(1)
        .then((rows) => rows[0]),
      db.select({ id: clubMembersTable.id })
        .from(clubMembersTable)
        .where(and(
          eq(clubMembersTable.organizationId, opts.organizationId),
          eq(clubMembersTable.userId, opts.affectedUserId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    if (!targetUser) {
      result.reason = "target_user_not_found";
      return result;
    }

    const memberName = (targetUser.displayName ?? targetUser.username ?? "").toString().trim();
    const adminDisplay = actorName(opts.actor);
    const orgName = org?.name ?? "KHARAGOLF";

    const branding: EmailBranding = {
      orgName,
      logoUrl: org?.logoUrl ?? undefined,
      primaryColor: org?.primaryColor ?? undefined,
      orgId: opts.organizationId,
    };

    // ── In-app inbox row ───────────────────────────────────────────────
    // Always written when a club_members row exists. The inbox is the
    // canonical consent-trail surface and is unaffected by the
    // per-channel email preference, so a member who opted out of
    // transactional email still sees the change in their portal.
    //
    // Task #1932 — the body must do more than say "contact your club
    // admin": it must tell the member **how** to revert an unwanted
    // change. We name the specific admin who made the change (and
    // surface their reply-to address when we have it), spell out the
    // exact ask the member should make, and point to a fallback
    // (any other admin, via the same suppressions screen) so a member
    // who can't reach the original actor isn't stranded. The original
    // address is suggested as the revert target when known, with the
    // explicit "or to a working address you control" hedge so a member
    // whose previous mailbox really is dead isn't sent in a circle.
    const inAppSubject = `An admin updated your contact email on ${orgName}`;
    const previousLine = previousEmail
      ? `Previous: ${previousEmail}`
      : "Previous: (suppressed bounce address)";
    const actorContactEmail = (opts.actor.email ?? "").toString().trim();
    const adminContactPhrase = actorContactEmail
      ? `Reply directly to ${adminDisplay} at ${actorContactEmail}`
      : `Reach out to ${adminDisplay} (the admin who made the change)`;
    const revertTarget = previousEmail
      ? `${previousEmail} (or to a working address you control)`
      : "an address you control";

    // Self-service dispute deep link. Built only when we have an audit
    // row id to bind it to: the public dispute / revert endpoints
    // require the original audit-row id to (a) link the dispute audit
    // entry back to the original re-enable, (b) dedup repeat presses,
    // and (c) prove the token was minted by us against a real change.
    let disputeUrl: string | null = null;
    if (
      typeof opts.originalAuditId === "number" &&
      Number.isInteger(opts.originalAuditId) &&
      previousEmail // a revert with no previous address to restore is meaningless
    ) {
      const token = issueEmailChangeDisputeToken({
        o: opts.organizationId,
        u: opts.affectedUserId,
        a: opts.originalAuditId,
        p: previousEmail,
        n: newEmail,
      });
      disputeUrl = buildEmailChangeDisputeUrl(token);
    }

    // The body intentionally leads with the one-click "this wasn't me"
    // link when we have one — it lets the member act without waiting on
    // a human admin — and falls back to the manual contact-the-admin
    // path either as a follow-up step or as the only path when the
    // deep link can't be issued (e.g. audit insert silently failed).
    const inAppBodyParts: string[] = [
      `${adminDisplay} updated the contact email on your account at ${orgName}.`,
      previousLine,
      `New: ${newEmail}`,
      `If you sign in with email, please use ${newEmail} from now on.`,
    ];
    if (disputeUrl) {
      inAppBodyParts.push(
        "If this wasn't expected, you have two ways to fix it:",
        `1. One-click revert (recommended): open ${disputeUrl} to restore your previous contact email and notify all admins at ${orgName}. The link is single-use and expires in 30 days.`,
        `2. Or, ${adminContactPhrase} and ask them to set your contact email back to ${revertTarget}. If you can't reach ${adminDisplay}, any other admin at ${orgName} can also revert this from the email suppressions page in the admin console.`,
        "Once your contact email is restored, sign in with that address and reset your password so the account is fully back under your control.",
      );
    } else {
      inAppBodyParts.push(
        "If this wasn't expected, here's how to revert it:",
        `1. ${adminContactPhrase} and ask them to set your contact email back to ${revertTarget}.`,
        `2. If you can't reach ${adminDisplay}, contact any other admin at ${orgName} — they can also revert this from the email suppressions page in the admin console.`,
        "3. Once your contact email is restored, sign in with that address and reset your password so the account is fully back under your control.",
      );
    }
    const inAppBody = inAppBodyParts.join("\n\n");

    if (derivedMember && derivedMember.id != null) {
      try {
        const [msg] = await db.insert(memberMessagesTable).values({
          organizationId: opts.organizationId,
          clubMemberId: derivedMember.id,
          senderUserId: opts.actor.id,
          channel: "in_app",
          subject: inAppSubject,
          body: inAppBody,
          status: "sent",
          relatedEntity: "account_email_changed_by_admin",
          relatedEntityId: opts.affectedUserId,
        }).returning({ id: memberMessagesTable.id });
        result.inApp.status = "sent";
        result.inApp.messageId = msg?.id;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        result.inApp.status = "failed";
        result.inApp.error = reason;
        logger.warn(
          {
            err,
            affectedUserId: opts.affectedUserId,
            organizationId: opts.organizationId,
          },
          "[admin-email-replacement-notify] in-app insert failed",
        );
      }
    } else {
      // No club_members row in this org — nothing to anchor the inbox
      // row to. The email path still fires below.
      result.inApp.status = "skipped";
    }

    // ── Email ──────────────────────────────────────────────────────────
    // Goes to the **new** address. Always attempted regardless of the
    // member's preferEmail flag because (a) this is a security-critical
    // courtesy notice, not a marketing send, and (b) the helper sets
    // `bypassSuppression: true` so it survives even if the new address
    // is itself on the suppression list. We still record `opted_out`
    // when preferEmail is explicitly false so audits show the member's
    // stated preference, but we deliver the notice anyway.
    const preferEmail = prefRow?.preferEmail ?? true;
    try {
      await sendAccountEmailChangedByAdminEmail({
        to: newEmail,
        memberName: memberName || null,
        adminName: adminDisplay,
        previousEmail: previousEmail || "(suppressed)",
        newEmail,
        preferredLanguage: targetUser.preferredLanguage ?? null,
        changedAt,
        branding,
      });
      result.email.status = preferEmail ? "sent" : "opted_out";
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.email.status = "failed";
      result.email.error = reason;
      logger.warn(
        {
          err,
          affectedUserId: opts.affectedUserId,
          organizationId: opts.organizationId,
        },
        "[admin-email-replacement-notify] email delivery failed",
      );
    }

    const statuses = [result.email.status, result.inApp.status];
    if (statuses.includes("sent") || statuses.includes("opted_out")) {
      result.status = "sent";
    } else if (statuses.includes("failed")) {
      result.status = "failed";
      result.reason = result.email.error ?? result.inApp.error;
    } else {
      result.status = "skipped";
    }
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      {
        err,
        affectedUserId: opts.affectedUserId,
        organizationId: opts.organizationId,
      },
      "[admin-email-replacement-notify] unexpected failure",
    );
    result.status = "failed";
    result.reason = reason;
    return result;
  }
}
