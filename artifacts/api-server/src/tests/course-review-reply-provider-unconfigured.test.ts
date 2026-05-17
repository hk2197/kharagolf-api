/**
 * Unit tests: `notifyCourseReviewReplyPosted` provider_unconfigured branch
 * (Task #1502, lib line 106). Companion to the route-level coverage in
 * `course-review-admin-reply.test.ts`, which mocks the helper and never
 * exercises the inner mailer flow.
 *
 * The helper sends a single one-shot email to the original reviewer
 * letting them know that the club has posted a public reply. When the
 * mailer throws an env-wide misconfiguration error
 * (e.g. `RESEND_API_KEY not set` / `SMTP host not configured`), the
 * helper must:
 *   1. Classify the error via `classifyMailerError === "provider_unconfigured"`
 *   2. Return `{ status: "skipped", reason: "provider_not_configured" }`
 *      so callers (the PUT reply route) can record the skip without
 *      surfacing a misleading "delivery failed" alert for an env issue.
 *   3. NOT emit the standard `[course-review-reply-notify] failed to
 *      send reply email` warn line (the silent-skip contract that keeps
 *      the on-call dashboard quiet during env misconfigs).
 *
 * Mailer is mocked so the tests don't touch real SMTP; the DB is real
 * so the helper exercises the same review/course/org join it uses in
 * production.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendBroadcastEmail: vi.fn(async () => undefined),
    // Default classifier maps generic errors to "transient"; individual
    // tests override per-call to exercise the provider_unconfigured branch.
    classifyMailerError: vi.fn(() => "transient"),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  courseReviewsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { notifyCourseReviewReplyPosted } from "../lib/courseReviewReplyNotify.js";
import { sendBroadcastEmail, classifyMailerError } from "../lib/mailer.js";
import { logger } from "../lib/logger.js";

const emailMock = vi.mocked(sendBroadcastEmail);
const classifyMailerErrorMock = vi.mocked(classifyMailerError);

let testOrgId: number;
let testCourseId: number;
const createdReviewIds: number[] = [];

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_CRReplyProvUnconf_${ts}`,
    slug: `test-cr-reply-prov-unconf-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Provider Unconfigured Course",
    slug: `prov-unconf-course-${ts}`,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;
});

afterAll(async () => {
  if (createdReviewIds.length > 0) {
    await db.delete(courseReviewsTable).where(inArray(courseReviewsTable.id, createdReviewIds));
  }
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  classifyMailerErrorMock.mockReset();
  classifyMailerErrorMock.mockReturnValue("transient");
});

async function insertReviewWithReply(): Promise<number> {
  const [row] = await db.insert(courseReviewsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    reviewerEmail: "reviewer@example.test",
    reviewerDisplayName: "Reviewer Name",
    rating: 4,
    body: "Great course",
    adminReply: "Thanks for the kind words!",
  }).returning({ id: courseReviewsTable.id });
  createdReviewIds.push(row.id);
  return row.id;
}

describe("notifyCourseReviewReplyPosted — provider_unconfigured branch (Task #1502)", () => {
  it("maps mailer-not-configured to skipped/provider_not_configured and suppresses warn", async () => {
    classifyMailerErrorMock.mockReturnValueOnce("provider_unconfigured");
    emailMock.mockRejectedValueOnce(new Error("RESEND_API_KEY not set"));
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    try {
      const reviewId = await insertReviewWithReply();
      const result = await notifyCourseReviewReplyPosted(reviewId);

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("provider_not_configured");
      // The send was attempted before the catch classified the env issue.
      expect(emailMock).toHaveBeenCalledTimes(1);
      // A failure-mode result should never surface a per-call error
      // string when the cause was an env-wide misconfig — we want the
      // skip to look terminal/uneventful to the caller.
      expect(result.error).toBeUndefined();

      // Silent-skip contract: the standard `failed to send reply email`
      // warn line must NOT fire for the env-misconfig branch.
      const sendFailureLog = warnSpy.mock.calls.find(args => {
        const msg = (typeof args[1] === "string" ? args[1] : "");
        return msg.includes("failed to send reply email");
      });
      expect(sendFailureLog).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("non-provider-unconfigured errors still flow through the failed path (control test)", async () => {
    // Default classifier mock returns "transient" so this confirms the
    // branch logic — only `provider_unconfigured` triggers the skipped
    // mapping; everything else still becomes `failed` with the message.
    emailMock.mockRejectedValueOnce(new Error("smtp 421 try again later"));

    const reviewId = await insertReviewWithReply();
    const result = await notifyCourseReviewReplyPosted(reviewId);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("smtp 421 try again later");
  });
});
