/**
 * Task #790 — Server-side coverage for the admin-reply flow on course reviews.
 *
 * Pins the contract of:
 *   PUT  /api/organizations/:orgId/marketing-site/course-reviews/:reviewId/reply
 *   GET  /api/public/clubs/:slug/courses/:courseSlug
 *   GET  /api/public/clubs/:slug/courses/:courseSlug/reviews
 *
 * Specifically:
 *   - The reply endpoint requires a site-admin role; players get 403,
 *     unauthenticated callers get 401, and admins from a different org
 *     hit the org-mismatch 403.
 *   - A whitespace-padded reply is trimmed; replies longer than the 2000-char
 *     cap are truncated; the response includes the new adminReply, an
 *     adminReplyAt timestamp, and stamps adminReplyByUserId with the caller.
 *   - Sending `null` (or an empty / whitespace-only string) clears the reply
 *     and zeroes adminReplyAt + adminReplyByUserId.
 *   - Non-string, non-null bodies are rejected with 400.
 *   - The public single-course endpoint surfaces adminReply / adminReplyAt
 *     under reviewSummary.recent for every approved review.
 *   - The public paginated reviews endpoint surfaces the same fields.
 *
 * The downstream email helper (notifyCourseReviewReplyPosted) is mocked
 * because we don't want this test to touch the mail transport.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/courseReviewReplyNotify", () => ({
  notifyCourseReviewReplyPosted: vi.fn(async () => "skipped" as const),
}));

import {
  db,
  organizationsTable,
  coursesTable,
  courseReviewsTable,
  appUsersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
import { notifyCourseReviewReplyPosted } from "../lib/courseReviewReplyNotify";

let orgId: number;
let otherOrgId: number;
let courseId: number;
let clubSlug: string;
let courseSlug: string;
let adminUserId: number;
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const reviewIds: number[] = [];

async function seedReview(opts: { status?: string; adminReply?: string | null } = {}) {
  const [row] = await db.insert(courseReviewsTable).values({
    organizationId: orgId,
    courseId,
    reviewerDisplayName: "Riley Reviewer",
    reviewerEmail: `r_${stamp}_${reviewIds.length}@reviewers.test`,
    displayMode: "public",
    rating: 4,
    title: `Reply test review ${reviewIds.length}`,
    body: "Body of the review.",
    status: opts.status ?? "approved",
    adminReply: opts.adminReply ?? null,
    adminReplyAt: opts.adminReply ? new Date() : null,
    abuseReportCount: 0,
  }).returning({ id: courseReviewsTable.id });
  reviewIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  clubSlug = `t790-club-${stamp}`;
  courseSlug = `t790-course-${stamp}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `T790 Club ${stamp}`,
    slug: clubSlug,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [other] = await db.insert(organizationsTable).values({
    name: `T790 Other ${stamp}`,
    slug: `t790-other-${stamp}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = other.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T790 Course",
    slug: courseSlug,
    holes: 18,
    par: 72,
    isPublic: true,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `t790-admin-${stamp}`,
    username: `t790_admin_${stamp}`,
    email: `admin_${stamp}@t790.test`,
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = admin.id;
});

afterAll(async () => {
  if (reviewIds.length > 0) {
    await db.delete(courseReviewsTable).where(inArray(courseReviewsTable.id, reviewIds));
  }
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgId, otherOrgId]));
});

function adminApp() {
  return createTestApp({
    id: adminUserId,
    username: `t790_admin_${stamp}`,
    role: "org_admin",
    organizationId: orgId,
  });
}

const replyUrl = (id: number) =>
  `/api/organizations/${orgId}/marketing-site/course-reviews/${id}/reply`;

describe("PUT /marketing-site/course-reviews/:reviewId/reply — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    const id = await seedReview();
    const res = await request(createTestApp()).put(replyUrl(id)).send({ reply: "hi" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a player role", async () => {
    const id = await seedReview();
    const app = createTestApp({
      id: 99, username: "p", role: "player", organizationId: orgId,
    });
    const res = await request(app).put(replyUrl(id)).send({ reply: "hi" });
    expect(res.status).toBe(403);
  });

  it("returns 403 for an org_admin from a different org", async () => {
    const id = await seedReview();
    const app = createTestApp({
      id: 100, username: "other", role: "org_admin", organizationId: otherOrgId,
    });
    const res = await request(app).put(replyUrl(id)).send({ reply: "hi" });
    expect(res.status).toBe(403);
  });

  it("returns 404 when the review does not belong to the org", async () => {
    const res = await request(adminApp()).put(replyUrl(99999999)).send({ reply: "hi" });
    expect(res.status).toBe(404);
  });
});

describe("PUT /marketing-site/course-reviews/:reviewId/reply — body handling", () => {
  it("trims whitespace, persists adminReply + adminReplyAt + adminReplyByUserId, and notifies", async () => {
    const id = await seedReview();
    const before = Date.now();
    const res = await request(adminApp())
      .put(replyUrl(id))
      .send({ reply: "  Thanks for the feedback!  " });
    expect(res.status).toBe(200);
    expect(res.body.adminReply).toBe("Thanks for the feedback!");
    expect(res.body.adminReplyAt).toBeTruthy();
    expect(new Date(res.body.adminReplyAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(res.body.adminReplyByUserId).toBe(adminUserId);

    const [row] = await db
      .select({
        adminReply: courseReviewsTable.adminReply,
        adminReplyAt: courseReviewsTable.adminReplyAt,
        adminReplyByUserId: courseReviewsTable.adminReplyByUserId,
      })
      .from(courseReviewsTable)
      .where(eq(courseReviewsTable.id, id));
    expect(row.adminReply).toBe("Thanks for the feedback!");
    expect(row.adminReplyAt).toBeInstanceOf(Date);
    expect(row.adminReplyByUserId).toBe(adminUserId);

    expect(notifyCourseReviewReplyPosted).toHaveBeenCalledWith(id);
  });

  it("caps the reply at 2000 characters", async () => {
    const id = await seedReview();
    const long = "x".repeat(2500);
    const res = await request(adminApp()).put(replyUrl(id)).send({ reply: long });
    expect(res.status).toBe(200);
    expect(res.body.adminReply).toHaveLength(2000);
    expect(res.body.adminReply).toBe("x".repeat(2000));
  });

  it("clears the reply when sent null", async () => {
    const id = await seedReview({ adminReply: "Old reply" });
    (notifyCourseReviewReplyPosted as ReturnType<typeof vi.fn>).mockClear();
    const res = await request(adminApp()).put(replyUrl(id)).send({ reply: null });
    expect(res.status).toBe(200);
    expect(res.body.adminReply).toBeNull();
    expect(res.body.adminReplyAt).toBeNull();
    expect(res.body.adminReplyByUserId).toBeNull();

    const [row] = await db
      .select({
        adminReply: courseReviewsTable.adminReply,
        adminReplyAt: courseReviewsTable.adminReplyAt,
        adminReplyByUserId: courseReviewsTable.adminReplyByUserId,
      })
      .from(courseReviewsTable)
      .where(eq(courseReviewsTable.id, id));
    expect(row.adminReply).toBeNull();
    expect(row.adminReplyAt).toBeNull();
    expect(row.adminReplyByUserId).toBeNull();

    // Cleared replies must NOT trigger an email.
    expect(notifyCourseReviewReplyPosted).not.toHaveBeenCalled();
  });

  it("clears the reply when sent an empty / whitespace-only string", async () => {
    const id = await seedReview({ adminReply: "Old reply" });
    (notifyCourseReviewReplyPosted as ReturnType<typeof vi.fn>).mockClear();
    const res = await request(adminApp()).put(replyUrl(id)).send({ reply: "   " });
    expect(res.status).toBe(200);
    expect(res.body.adminReply).toBeNull();
    expect(res.body.adminReplyAt).toBeNull();
    expect(notifyCourseReviewReplyPosted).not.toHaveBeenCalled();
  });

  it("rejects non-string, non-null reply bodies with 400", async () => {
    const id = await seedReview();
    const res = await request(adminApp()).put(replyUrl(id)).send({ reply: 42 });
    expect(res.status).toBe(400);
  });
});

describe("Public course endpoints surface adminReply / adminReplyAt", () => {
  it("includes adminReply + adminReplyAt under reviewSummary.recent on the single-course endpoint", async () => {
    const id = await seedReview();
    const post = await request(adminApp())
      .put(replyUrl(id))
      .send({ reply: "Glad you enjoyed it." });
    expect(post.status).toBe(200);

    const res = await request(createTestApp())
      .get(`/api/public/clubs/${clubSlug}/courses/${courseSlug}`);
    expect(res.status).toBe(200);
    const recent = res.body.reviewSummary.recent as Array<{
      id: number; adminReply: string | null; adminReplyAt: string | null;
    }>;
    const seeded = recent.find(r => r.id === id);
    expect(seeded).toBeDefined();
    expect(seeded!.adminReply).toBe("Glad you enjoyed it.");
    expect(seeded!.adminReplyAt).toBeTruthy();
  });

  it("includes adminReply + adminReplyAt on the paginated reviews endpoint", async () => {
    const id = await seedReview();
    const post = await request(adminApp())
      .put(replyUrl(id))
      .send({ reply: "Thanks for visiting." });
    expect(post.status).toBe(200);

    const res = await request(createTestApp())
      .get(`/api/public/clubs/${clubSlug}/courses/${courseSlug}/reviews`);
    expect(res.status).toBe(200);
    const reviews = res.body.reviews as Array<{
      id: number; adminReply: string | null; adminReplyAt: string | null;
    }>;
    const seeded = reviews.find(r => r.id === id);
    expect(seeded).toBeDefined();
    expect(seeded!.adminReply).toBe("Thanks for visiting.");
    expect(seeded!.adminReplyAt).toBeTruthy();
  });

  it("returns adminReply: null on the public endpoints when no reply has been posted", async () => {
    const id = await seedReview();
    const res = await request(createTestApp())
      .get(`/api/public/clubs/${clubSlug}/courses/${courseSlug}/reviews`);
    expect(res.status).toBe(200);
    const reviews = res.body.reviews as Array<{
      id: number; adminReply: string | null; adminReplyAt: string | null;
    }>;
    const seeded = reviews.find(r => r.id === id);
    expect(seeded).toBeDefined();
    expect(seeded!.adminReply).toBeNull();
    expect(seeded!.adminReplyAt).toBeNull();
  });
});
