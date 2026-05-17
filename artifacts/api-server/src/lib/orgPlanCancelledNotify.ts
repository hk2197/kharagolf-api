/**
 * Org subscription-cancellation + past-due confirmation emails
 * (Task #1540 + Task #1907).
 *
 * After Task #1309 the Stripe `customer.subscription.deleted` branch in
 * routes/webhooks.ts and the older Razorpay `subscription.cancelled` branch
 * in routes/onboarding.ts both downgrade an org back to Free silently. A
 * club admin who cancelled by mistake — or who was billed by Stripe
 * directly without realising it — has no audit trail in their inbox. We
 * already send transactional emails for member-level events (failed dues
 * payments, levy receipts, etc.) so the org-level subscription gap is a
 * noticeable parity miss.
 *
 * `notifyOrgAdminsOfPlanCancellation` resolves the set of admin recipients
 * for an org and sends each one a single branded confirmation email
 * naming the cancellation source, the new tier (Free), and a re-subscribe
 * link. It is idempotent in the sense that callers should invoke it
 * exactly once per cancellation event (i.e. after the DB downgrade has
 * been written) — it does not deduplicate across multiple webhook
 * deliveries on its own. The Stripe and Razorpay handlers each guard
 * their downgrade with the org-not-found / metadata-missing checks
 * already present, so this helper inherits that "one effective call per
 * cancellation" property.
 *
 * `notifyOrgAdminsOfPlanPastDue` (Task #1907) mirrors the same recipient
 * + branding resolution but covers the *failed-payment* paths that move
 * an org to `past_due` instead of `cancelled` (Stripe
 * `invoice.payment_failed`, Razorpay `subscription.halted` /
 * `payment.failed`). Until #1907, those branches silently flipped the
 * status with no email — so a club whose card simply expired had no
 * warning before being locked out of paid features. The email names the
 * billing failure reason (when the provider gave us one) and links to
 * the billing settings page so the admin can update their payment
 * method. Sent flow tag is `org_plan_past_due` so it is distinguishable
 * from the cancellation email in the mailer audit log.
 *
 * Recipient resolution mirrors the dual-source pattern used by
 * `getCommitteeMemberUserIds` (lib/handicap-cases.ts):
 *   1. `org_memberships` rows with role `org_admin` for the org.
 *   2. Legacy `app_users.role = 'org_admin'` AND `organization_id = orgId`.
 * The two are merged on user id so an admin present in both tables is
 * notified exactly once. Users without an email address on file are
 * silently skipped.
 *
 * Branding follows the same precedence as `resolveOrgBranding`
 * (lib/clubTheming.ts) so the cancellation email matches the look of
 * every other transactional email the club already sends.
 *
 * Failures are logged but never thrown: the DB downgrade has already
 * committed by the time we run, and a delivery glitch must not roll
 * Stripe / Razorpay back into a retry loop.
 */
import { db } from "@workspace/db";
import {
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { sendBroadcastEmail } from "./mailer";
import { resolveOrgBranding } from "./clubTheming";
import { logger as baseLogger } from "./logger";

const logger = baseLogger.child({ module: "orgPlanCancelledNotify" });

export type PlanCancelledSource = "stripe" | "razorpay";

export interface NotifyOrgAdminsOfPlanCancellationOptions {
  orgId: number;
  /** Which billing provider reported the cancellation. */
  source: PlanCancelledSource;
  /**
   * The org's previous (paid) tier slug, e.g. "pro" / "starter" /
   * "enterprise". Optional — only used to enrich the email copy.
   */
  previousTier?: string | null;
}

export interface NotifyOrgAdminsOfPlanCancellationResult {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  /** Number of admin recipients we successfully emailed. */
  sentCount: number;
  /** Number of admin user ids found, including those without an email. */
  recipientCount: number;
}

const ORG_ADMIN_ROLE = "org_admin";

function baseUrl(): string {
  return (
    process.env.APP_BASE_URL
    ?? process.env.PUBLIC_BASE_URL
    ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`
  ).replace(/\/$/, "");
}

function sourceLabel(source: PlanCancelledSource): string {
  return source === "stripe" ? "Stripe" : "Razorpay";
}

function tierLabel(tier?: string | null): string {
  if (!tier) return "paid";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

interface AdminRecipient {
  userId: number;
  email: string;
  name: string;
}

async function loadOrgAdmins(orgId: number): Promise<AdminRecipient[]> {
  const ids = new Set<number>();

  const memberRows = await db.select({ userId: orgMembershipsTable.userId })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.role, ORG_ADMIN_ROLE),
    ));
  for (const r of memberRows) ids.add(r.userId);

  const legacyRows = await db.select({ id: appUsersTable.id })
    .from(appUsersTable)
    .where(and(
      eq(appUsersTable.organizationId, orgId),
      eq(appUsersTable.role, ORG_ADMIN_ROLE),
    ));
  for (const r of legacyRows) ids.add(r.id);

  if (ids.size === 0) return [];

  const userRows = await db.select({
    id: appUsersTable.id,
    email: appUsersTable.email,
    displayName: appUsersTable.displayName,
    username: appUsersTable.username,
  })
    .from(appUsersTable)
    .where(inArray(appUsersTable.id, [...ids]));

  const out: AdminRecipient[] = [];
  for (const u of userRows) {
    const email = (u.email ?? "").trim();
    if (!email) continue;
    const name = (u.displayName ?? u.username ?? "").trim() || "Admin";
    out.push({ userId: u.id, email, name });
  }
  return out;
}

/**
 * Notify all admins of an org that their paid plan has been cancelled
 * and the org has been downgraded to Free. Safe to call from inside the
 * Stripe / Razorpay webhook handlers after the DB downgrade has been
 * written — never throws.
 */
export async function notifyOrgAdminsOfPlanCancellation(
  opts: NotifyOrgAdminsOfPlanCancellationOptions,
): Promise<NotifyOrgAdminsOfPlanCancellationResult> {
  const { orgId, source, previousTier } = opts;
  if (!Number.isInteger(orgId) || orgId <= 0) {
    return { status: "skipped", reason: "invalid_orgId", sentCount: 0, recipientCount: 0 };
  }

  try {
    const [org] = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId)).limit(1);
    if (!org) {
      return { status: "skipped", reason: "org_not_found", sentCount: 0, recipientCount: 0 };
    }

    const recipients = await loadOrgAdmins(orgId);
    if (recipients.length === 0) {
      return { status: "skipped", reason: "no_admins", sentCount: 0, recipientCount: 0 };
    }

    const branded = await resolveOrgBranding(orgId, org).catch(() => ({
      orgName: org.name ?? undefined,
      logoUrl: org.logoUrl ?? undefined,
      primaryColor: org.primaryColor ?? undefined,
    }));
    const orgName = branded.orgName ?? org.name ?? "your club";
    const resubscribeUrl = `${baseUrl()}/settings/billing`;

    const subject = "Your subscription has been cancelled";
    const body = [
      `${sourceLabel(source)} reported that your ${tierLabel(previousTier)} plan for ${orgName} has been cancelled, so we have downgraded the club back to the Free tier.`,
      "If you cancelled by mistake — or this was an automatic cancellation you didn't expect — you can re-subscribe any time:",
      resubscribeUrl,
      "If this cancellation was intentional, no further action is needed; the rest of your club data is unaffected.",
    ].join("\n\n");

    let sentCount = 0;
    for (const r of recipients) {
      try {
        await sendBroadcastEmail(
          r.email,
          r.name,
          subject,
          body,
          orgName,
          {
            logoUrl: branded.logoUrl,
            primaryColor: branded.primaryColor,
            orgName,
            orgId,
            flow: "org_plan_cancelled",
          },
        );
        sentCount += 1;
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), orgId, source, userId: r.userId },
          "[org-plan-cancelled-notify] email delivery failed for admin",
        );
      }
    }

    if (sentCount === 0) {
      return { status: "failed", reason: "all_sends_failed", sentCount, recipientCount: recipients.length };
    }

    logger.info(
      { orgId, source, sentCount, recipientCount: recipients.length },
      "[org-plan-cancelled-notify] sent cancellation confirmation",
    );
    return { status: "sent", sentCount, recipientCount: recipients.length };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), orgId, source },
      "[org-plan-cancelled-notify] failed",
    );
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
      sentCount: 0,
      recipientCount: 0,
    };
  }
}

export interface NotifyOrgAdminsOfPlanPastDueOptions {
  orgId: number;
  /** Which billing provider reported the failure. */
  source: PlanCancelledSource;
  /**
   * The org's current paid tier slug at the time of the failure, e.g.
   * "pro" / "starter" / "enterprise". Optional — only used to enrich the
   * email copy.
   */
  currentTier?: string | null;
  /**
   * Free-text reason from the provider, e.g. Stripe's
   * `last_finalization_error.message` ("Your card was declined.") or
   * Razorpay's `payment.entity.error_description`. Optional — when
   * absent we fall back to a generic "your payment couldn't be
   * processed" line so the email is still actionable.
   */
  failureReason?: string | null;
}

/**
 * Notify all admins of an org that their most recent subscription
 * payment failed and the org has been moved to `past_due`. Safe to call
 * from inside the Stripe / Razorpay webhook handlers after the DB
 * status flip has been written — never throws. (Task #1907)
 *
 * Recipient resolution + branding match
 * `notifyOrgAdminsOfPlanCancellation` exactly so the past-due email
 * looks like every other transactional email the club already sends.
 * The mailer flow tag is `org_plan_past_due` (vs `org_plan_cancelled`)
 * so the two are distinguishable in the audit log.
 *
 * Idempotency: callers should invoke this exactly once per failure
 * event delivery (i.e. after the DB UPDATE has been written). The
 * helper itself does not deduplicate across multiple webhook
 * deliveries — that mirrors the cancellation helper's contract.
 */
export async function notifyOrgAdminsOfPlanPastDue(
  opts: NotifyOrgAdminsOfPlanPastDueOptions,
): Promise<NotifyOrgAdminsOfPlanCancellationResult> {
  const { orgId, source, currentTier, failureReason } = opts;
  if (!Number.isInteger(orgId) || orgId <= 0) {
    return { status: "skipped", reason: "invalid_orgId", sentCount: 0, recipientCount: 0 };
  }

  try {
    const [org] = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId)).limit(1);
    if (!org) {
      return { status: "skipped", reason: "org_not_found", sentCount: 0, recipientCount: 0 };
    }

    const recipients = await loadOrgAdmins(orgId);
    if (recipients.length === 0) {
      return { status: "skipped", reason: "no_admins", sentCount: 0, recipientCount: 0 };
    }

    const branded = await resolveOrgBranding(orgId, org).catch(() => ({
      orgName: org.name ?? undefined,
      logoUrl: org.logoUrl ?? undefined,
      primaryColor: org.primaryColor ?? undefined,
    }));
    const orgName = branded.orgName ?? org.name ?? "your club";
    const billingUrl = `${baseUrl()}/settings/billing`;

    const reasonLine = failureReason && failureReason.trim().length > 0
      ? `Reason reported by ${sourceLabel(source)}: ${failureReason.trim()}`
      : `${sourceLabel(source)} did not give a specific reason for the failure.`;

    const subject = "Action required: we couldn't process your subscription payment";
    const body = [
      `${sourceLabel(source)} reported that the latest payment for your ${tierLabel(currentTier)} plan on ${orgName} could not be processed, so we have flagged the subscription as past due.`,
      reasonLine,
      "Please update your payment method to keep your paid features active — if the next retry also fails, the club will be downgraded to the Free tier:",
      billingUrl,
      "If you have already updated your card on file, you can ignore this email; the next retry will reactivate the plan automatically.",
    ].join("\n\n");

    let sentCount = 0;
    for (const r of recipients) {
      try {
        await sendBroadcastEmail(
          r.email,
          r.name,
          subject,
          body,
          orgName,
          {
            logoUrl: branded.logoUrl,
            primaryColor: branded.primaryColor,
            orgName,
            orgId,
            flow: "org_plan_past_due",
          },
        );
        sentCount += 1;
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), orgId, source, userId: r.userId },
          "[org-plan-past-due-notify] email delivery failed for admin",
        );
      }
    }

    if (sentCount === 0) {
      return { status: "failed", reason: "all_sends_failed", sentCount, recipientCount: recipients.length };
    }

    logger.info(
      { orgId, source, sentCount, recipientCount: recipients.length },
      "[org-plan-past-due-notify] sent past-due notice",
    );
    return { status: "sent", sentCount, recipientCount: recipients.length };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), orgId, source },
      "[org-plan-past-due-notify] failed",
    );
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
      sentCount: 0,
      recipientCount: 0,
    };
  }
}
