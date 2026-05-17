/**
 * Course-review admin-reply notification helper (Task #789).
 *
 * When an admin saves (or updates) a public reply to a course review via
 * PUT /api/organizations/:orgId/marketing-site/course-reviews/:reviewId/reply,
 * we send a one-shot email to the original reviewer letting them know that
 * the club has responded, and link them back to the public course page so
 * they can read it in context.
 *
 * Behaviour:
 *   - Only fires when the new reply value is non-null. Clearing the reply
 *     (PUT with reply: null / "") does NOT send an email.
 *   - Anonymous reviewers (no `reviewer_email` on file) are skipped silently
 *     — there's no address to deliver to.
 *   - Best-effort: any failure (DB lookup, mail transport) is logged but
 *     never thrown to the route handler. The reply itself is already
 *     persisted by the time we're called.
 */
import { db } from "@workspace/db";
import {
  courseReviewsTable,
  coursesTable,
  organizationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendBroadcastEmail, classifyMailerError } from "./mailer";
import { logger } from "./logger";

export type ReplyNotifyStatus = "sent" | "skipped" | "failed";

export interface CourseReviewReplyNotifyResult {
  status: ReplyNotifyStatus;
  reason?: string;
  error?: string;
}

/**
 * Resolve the public marketing-site base URL for the course-page link.
 * Mirrors the host preference used elsewhere in marketing-site.ts:
 * MARKETING_SITE_PUBLIC_URL → APP_BASE_URL → REPLIT_DEV_DOMAIN →
 * https://kharagolf.com (the production marketing host).
 */
function resolveMarketingBaseUrl(): string {
  const raw =
    process.env.MARKETING_SITE_PUBLIC_URL
    ?? process.env.APP_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "");
  return (raw || "https://kharagolf.com").replace(/\/$/, "");
}

export async function notifyCourseReviewReplyPosted(
  reviewId: number,
): Promise<CourseReviewReplyNotifyResult> {
  try {
    const [row] = await db
      .select({
        reviewerEmail: courseReviewsTable.reviewerEmail,
        reviewerDisplayName: courseReviewsTable.reviewerDisplayName,
        adminReply: courseReviewsTable.adminReply,
        courseSlug: coursesTable.slug,
        courseName: coursesTable.name,
        clubSlug: organizationsTable.slug,
        clubName: organizationsTable.name,
        clubLogoUrl: organizationsTable.logoUrl,
        clubPrimaryColor: organizationsTable.primaryColor,
      })
      .from(courseReviewsTable)
      .innerJoin(coursesTable, eq(coursesTable.id, courseReviewsTable.courseId))
      .innerJoin(organizationsTable, eq(organizationsTable.id, courseReviewsTable.organizationId))
      .where(eq(courseReviewsTable.id, reviewId))
      .limit(1);

    if (!row) return { status: "skipped", reason: "review_not_found" };
    if (!row.adminReply) return { status: "skipped", reason: "no_reply" };
    if (!row.reviewerEmail) return { status: "skipped", reason: "no_reviewer_email" };

    const baseUrl = resolveMarketingBaseUrl();
    const courseUrl = `${baseUrl}/clubs/${encodeURIComponent(row.clubSlug)}/courses/${encodeURIComponent(row.courseSlug)}`;
    const clubName = row.clubName || "the club";
    const recipientName = row.reviewerDisplayName?.trim() || "Golfer";

    const subject = `${clubName} replied to your review of ${row.courseName}`;
    const body = [
      `${clubName} just posted a public reply to the review you left for ${row.courseName}.`,
      `Their reply:\n\n"${row.adminReply}"`,
      `Read it in context on the course page: ${courseUrl}`,
    ].join("\n\n");

    await sendBroadcastEmail(
      row.reviewerEmail,
      recipientName,
      subject,
      body,
      clubName,
      {
        logoUrl: row.clubLogoUrl ?? undefined,
        primaryColor: row.clubPrimaryColor ?? undefined,
        orgName: clubName,
      },
    );
    return { status: "sent" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Provider misconfiguration → terminal `skipped` so the env issue
    // isn't logged as a per-review delivery failure.
    if (classifyMailerError(err) === "provider_unconfigured") {
      return { status: "skipped", reason: "provider_not_configured" };
    }
    logger.warn(
      { reviewId, errMsg: reason },
      "[course-review-reply-notify] failed to send reply email",
    );
    return { status: "failed", error: reason };
  }
}
