/**
 * Integration tests: Course Moderation flows
 *
 * The /course-moderation admin page (artifacts/kharagolf-web/src/pages/course-moderation.tsx)
 * has been live for a while without automated coverage. These tests pin the underlying
 * marketing-site admin endpoints that the page (and its sidebar badge) depend on, so
 * regressions like a renamed status enum, a changed response shape, or a permission
 * tweak break CI before they break admins.
 *
 * Covers:
 *   - GET    /course-reviews?status=pending   (list shape, only-pending filter)
 *   - PATCH  /course-reviews/:id { status }   (approve/reject removes from pending)
 *   - GET    /course-photos?status=pending    (list shape, only-pending filter)
 *   - PATCH  /course-photos/:id { approved }  (approve removes from pending)
 *   - DELETE /course-photos/:id               (delete removes from pending)
 *   - 401 when unauthenticated, 403 for player role, 403 for wrong-org admin
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  courseReviewsTable,
  courseReviewReportsTable,
  mediaTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
import { _resetRateLimiterForTests } from "../lib/publicRateLimit.js";

let testOrgId: number;
let otherOrgId: number;
let testCourseId: number;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_CourseModeration_${stamp}`,
    slug: `test-course-mod-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [other] = await db.insert(organizationsTable).values({
    name: `TestOrg_CourseModeration_other_${stamp}`,
    slug: `test-course-mod-other-${stamp}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = other.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Moderation Test Course",
    slug: `mod-test-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;
});

afterAll(async () => {
  await db.delete(courseReviewsTable).where(eq(courseReviewsTable.organizationId, testOrgId));
  await db.delete(mediaTable).where(eq(mediaTable.organizationId, testOrgId));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

function adminApp() {
  return createTestApp({
    id: 1,
    username: "course_mod_admin",
    role: "org_admin",
    organizationId: testOrgId,
  });
}

async function seedPendingReview(): Promise<number> {
  const [row] = await db.insert(courseReviewsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    reviewerDisplayName: "Test Reviewer",
    reviewerEmail: "reviewer@example.com",
    displayMode: "public",
    rating: 4,
    title: `PendingReview_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    body: "Pending review body",
    status: "pending",
    abuseReportCount: 0,
  }).returning({ id: courseReviewsTable.id });
  return row.id;
}

async function seedPendingPhoto(): Promise<number> {
  const [row] = await db.insert(mediaTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    objectPath: `/test-photo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`,
    mediaType: "image",
    approved: false,
    uploaderName: "Test Uploader",
    caption: "Pending caption",
  }).returning({ id: mediaTable.id });
  return row.id;
}

describe("GET /marketing-site/course-reviews?status=pending", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(createTestApp())
      .get(`/api/organizations/${testOrgId}/marketing-site/course-reviews?status=pending`);
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller has player role", async () => {
    const app = createTestApp({
      id: 99, username: "p", role: "player", organizationId: testOrgId,
    });
    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/marketing-site/course-reviews?status=pending`);
    expect(res.status).toBe(403);
  });

  it("returns 403 for an org_admin from a different org", async () => {
    const app = createTestApp({
      id: 100, username: "other_admin", role: "org_admin", organizationId: otherOrgId,
    });
    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/marketing-site/course-reviews?status=pending`);
    expect(res.status).toBe(403);
  });

  it("lists only pending reviews and exposes the badge fields the UI relies on", async () => {
    const reviewId = await seedPendingReview();
    try {
      const res = await request(adminApp())
        .get(`/api/organizations/${testOrgId}/marketing-site/course-reviews?status=pending`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const seeded = res.body.find((r: { id: number }) => r.id === reviewId);
      expect(seeded).toBeDefined();
      // Fields the moderation page (+ sidebar badge count) reads off the row.
      expect(seeded).toMatchObject({
        id: reviewId,
        courseId: testCourseId,
        status: "pending",
        rating: 4,
        displayMode: "public",
      });
      expect(seeded).toHaveProperty("abuseReportCount");
      expect(seeded).toHaveProperty("createdAt");
    } finally {
      await db.delete(courseReviewsTable).where(eq(courseReviewsTable.id, reviewId));
    }
  });
});

describe("POST /public/course-reviews/:id/report (abuse flag)", () => {
  beforeEach(async () => {
    await _resetRateLimiterForTests();
  });

  it("inserts a report row and increments abuseReportCount on the review", async () => {
    const reviewId = await seedPendingReview();
    try {
      const r1 = await request(createTestApp())
        .post(`/api/public/course-reviews/${reviewId}/report`)
        .set("X-Forwarded-For", "10.0.0.1")
        .send({ reason: "Looks like spam" });
      expect(r1.status).toBe(202);
      expect(r1.body).toMatchObject({ ok: true });

      const r2 = await request(createTestApp())
        .post(`/api/public/course-reviews/${reviewId}/report`)
        .set("X-Forwarded-For", "10.0.0.2")
        .send({ reason: "Offensive language", reporterEmail: "r@example.com" });
      expect(r2.status).toBe(202);

      const reports = await db
        .select({ id: courseReviewReportsTable.id })
        .from(courseReviewReportsTable)
        .where(eq(courseReviewReportsTable.reviewId, reviewId));
      expect(reports.length).toBe(2);

      const [row] = await db
        .select({ abuseReportCount: courseReviewsTable.abuseReportCount })
        .from(courseReviewsTable)
        .where(eq(courseReviewsTable.id, reviewId));
      expect(row.abuseReportCount).toBe(2);

      // The moderation list should expose the bumped count to the UI badge.
      const list = await request(adminApp())
        .get(`/api/organizations/${testOrgId}/marketing-site/course-reviews?status=pending`);
      expect(list.status).toBe(200);
      const seeded = list.body.find((r: { id: number }) => r.id === reviewId);
      expect(seeded).toBeDefined();
      expect(seeded.abuseReportCount).toBe(2);
    } finally {
      await db.delete(courseReviewReportsTable).where(eq(courseReviewReportsTable.reviewId, reviewId));
      await db.delete(courseReviewsTable).where(eq(courseReviewsTable.id, reviewId));
    }
  });

  it("rejects an empty reason with 400 and does not touch the count", async () => {
    const reviewId = await seedPendingReview();
    try {
      const res = await request(createTestApp())
        .post(`/api/public/course-reviews/${reviewId}/report`)
        .set("X-Forwarded-For", "10.0.0.3")
        .send({});
      expect(res.status).toBe(400);

      const [row] = await db
        .select({ abuseReportCount: courseReviewsTable.abuseReportCount })
        .from(courseReviewsTable)
        .where(eq(courseReviewsTable.id, reviewId));
      expect(row.abuseReportCount).toBe(0);
    } finally {
      await db.delete(courseReviewsTable).where(eq(courseReviewsTable.id, reviewId));
    }
  });

  it("returns 404 when reporting a non-existent review", async () => {
    const res = await request(createTestApp())
      .post(`/api/public/course-reviews/99999999/report`)
      .set("X-Forwarded-For", "10.0.0.4")
      .send({ reason: "missing" });
    expect(res.status).toBe(404);
  });
});

describe("GET /marketing-site/course-reviews?status=pending ordering", () => {
  beforeEach(async () => {
    await _resetRateLimiterForTests();
  });

  it("orders pending rows by abuseReportCount desc, then createdAt desc", async () => {
    // Seed four pending reviews with distinct creation timestamps so we can
    // assert *both* the primary sort (abuseReportCount desc) and the
    // createdAt-desc tie-breaker. Two of the four will end up with the
    // same flag count to exercise the secondary sort directly.
    const idHigh = await seedPendingReview();        // count = 2
    await new Promise(r => setTimeout(r, 5));
    const idTieOld = await seedPendingReview();      // count = 1, older
    await new Promise(r => setTimeout(r, 5));
    const idTieNew = await seedPendingReview();      // count = 1, newer
    await new Promise(r => setTimeout(r, 5));
    const idZero = await seedPendingReview();        // count = 0

    try {
      for (let i = 0; i < 2; i++) {
        const res = await request(createTestApp())
          .post(`/api/public/course-reviews/${idHigh}/report`)
          .set("X-Forwarded-For", `10.1.0.${i + 1}`)
          .send({ reason: `flag ${i}` });
        expect(res.status).toBe(202);
      }
      const tieOldRes = await request(createTestApp())
        .post(`/api/public/course-reviews/${idTieOld}/report`)
        .set("X-Forwarded-For", "10.1.0.50")
        .send({ reason: "tie old" });
      expect(tieOldRes.status).toBe(202);
      const tieNewRes = await request(createTestApp())
        .post(`/api/public/course-reviews/${idTieNew}/report`)
        .set("X-Forwarded-For", "10.1.0.51")
        .send({ reason: "tie new" });
      expect(tieNewRes.status).toBe(202);

      const list = await request(adminApp())
        .get(`/api/organizations/${testOrgId}/marketing-site/course-reviews?status=pending`);
      expect(list.status).toBe(200);

      const ours = (list.body as Array<{ id: number; abuseReportCount: number }>)
        .filter(r => [idHigh, idTieOld, idTieNew, idZero].includes(r.id));
      // Primary: high count first. Tie-breaker: among rows tied at count=1,
      // the newer createdAt comes before the older one.
      expect(ours.map(r => r.id)).toEqual([idHigh, idTieNew, idTieOld, idZero]);
      expect(ours.map(r => r.abuseReportCount)).toEqual([2, 1, 1, 0]);
    } finally {
      const ids = [idHigh, idTieOld, idTieNew, idZero];
      await db.delete(courseReviewReportsTable).where(inArray(courseReviewReportsTable.reviewId, ids));
      await db.delete(courseReviewsTable).where(inArray(courseReviewsTable.id, ids));
    }
  });
});

describe("PATCH /marketing-site/course-reviews/:id", () => {
  it("approving a review drops it from the pending list and persists the new status", async () => {
    const reviewId = await seedPendingReview();
    try {
      const patch = await request(adminApp())
        .patch(`/api/organizations/${testOrgId}/marketing-site/course-reviews/${reviewId}`)
        .send({ status: "approved" });
      expect(patch.status).toBe(200);
      expect(patch.body.status).toBe("approved");

      const list = await request(adminApp())
        .get(`/api/organizations/${testOrgId}/marketing-site/course-reviews?status=pending`);
      expect(list.status).toBe(200);
      expect(list.body.find((r: { id: number }) => r.id === reviewId)).toBeUndefined();

      const [row] = await db.select({ status: courseReviewsTable.status })
        .from(courseReviewsTable).where(eq(courseReviewsTable.id, reviewId));
      expect(row.status).toBe("approved");
    } finally {
      await db.delete(courseReviewsTable).where(eq(courseReviewsTable.id, reviewId));
    }
  });

  it("rejecting a review also removes it from pending", async () => {
    const reviewId = await seedPendingReview();
    try {
      const patch = await request(adminApp())
        .patch(`/api/organizations/${testOrgId}/marketing-site/course-reviews/${reviewId}`)
        .send({ status: "rejected" });
      expect(patch.status).toBe(200);
      expect(patch.body.status).toBe("rejected");

      const list = await request(adminApp())
        .get(`/api/organizations/${testOrgId}/marketing-site/course-reviews?status=pending`);
      expect(list.body.find((r: { id: number }) => r.id === reviewId)).toBeUndefined();
    } finally {
      await db.delete(courseReviewsTable).where(eq(courseReviewsTable.id, reviewId));
    }
  });

  it("rejects unknown status values with 400 (guards the enum the UI sends)", async () => {
    const reviewId = await seedPendingReview();
    try {
      const res = await request(adminApp())
        .patch(`/api/organizations/${testOrgId}/marketing-site/course-reviews/${reviewId}`)
        .send({ status: "totally-not-a-real-status" });
      expect(res.status).toBe(400);
    } finally {
      await db.delete(courseReviewsTable).where(eq(courseReviewsTable.id, reviewId));
    }
  });

  it("returns 404 when the review does not belong to the org", async () => {
    const res = await request(adminApp())
      .patch(`/api/organizations/${testOrgId}/marketing-site/course-reviews/99999999`)
      .send({ status: "approved" });
    expect(res.status).toBe(404);
  });

  it("hiding a review persists status='hidden', drops it from pending, and records the moderator", async () => {
    const reviewId = await seedPendingReview();
    try {
      const patch = await request(adminApp())
        .patch(`/api/organizations/${testOrgId}/marketing-site/course-reviews/${reviewId}`)
        .send({ status: "hidden", moderationNote: "Trolling" });
      expect(patch.status).toBe(200);
      expect(patch.body.status).toBe("hidden");
      expect(patch.body.moderationNote).toBe("Trolling");
      expect(patch.body.moderatedByUserId).toBe(1);
      expect(patch.body.moderatedAt).toBeTruthy();

      const list = await request(adminApp())
        .get(`/api/organizations/${testOrgId}/marketing-site/course-reviews?status=pending`);
      expect(list.status).toBe(200);
      expect(list.body.find((r: { id: number }) => r.id === reviewId)).toBeUndefined();

      const [row] = await db
        .select({
          status: courseReviewsTable.status,
          moderationNote: courseReviewsTable.moderationNote,
          moderatedByUserId: courseReviewsTable.moderatedByUserId,
        })
        .from(courseReviewsTable)
        .where(eq(courseReviewsTable.id, reviewId));
      expect(row.status).toBe("hidden");
      expect(row.moderationNote).toBe("Trolling");
      expect(row.moderatedByUserId).toBe(1);
    } finally {
      await db.delete(courseReviewsTable).where(eq(courseReviewsTable.id, reviewId));
    }
  });
});

describe("GET /marketing-site/course-photos?status=pending", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(createTestApp())
      .get(`/api/organizations/${testOrgId}/marketing-site/course-photos?status=pending`);
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller has player role", async () => {
    const app = createTestApp({
      id: 99, username: "p", role: "player", organizationId: testOrgId,
    });
    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/marketing-site/course-photos?status=pending`);
    expect(res.status).toBe(403);
  });

  it("lists only unapproved course-attached photos", async () => {
    const photoId = await seedPendingPhoto();
    try {
      const res = await request(adminApp())
        .get(`/api/organizations/${testOrgId}/marketing-site/course-photos?status=pending`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const seeded = res.body.find((p: { id: number }) => p.id === photoId);
      expect(seeded).toBeDefined();
      expect(seeded).toMatchObject({
        id: photoId,
        courseId: testCourseId,
        approved: false,
        mediaType: "image",
      });
      expect(seeded).toHaveProperty("objectPath");
      expect(seeded).toHaveProperty("createdAt");
    } finally {
      await db.delete(mediaTable).where(eq(mediaTable.id, photoId));
    }
  });
});

describe("PATCH /marketing-site/course-photos/:id", () => {
  it("approving a photo removes it from the pending list and persists approved=true", async () => {
    const photoId = await seedPendingPhoto();
    try {
      const patch = await request(adminApp())
        .patch(`/api/organizations/${testOrgId}/marketing-site/course-photos/${photoId}`)
        .send({ approved: true });
      expect(patch.status).toBe(200);
      expect(patch.body.approved).toBe(true);

      const list = await request(adminApp())
        .get(`/api/organizations/${testOrgId}/marketing-site/course-photos?status=pending`);
      expect(list.status).toBe(200);
      expect(list.body.find((p: { id: number }) => p.id === photoId)).toBeUndefined();

      const [row] = await db.select({ approved: mediaTable.approved })
        .from(mediaTable).where(eq(mediaTable.id, photoId));
      expect(row.approved).toBe(true);
    } finally {
      await db.delete(mediaTable).where(eq(mediaTable.id, photoId));
    }
  });

  it("returns 404 for a photo not owned by the org", async () => {
    const res = await request(adminApp())
      .patch(`/api/organizations/${testOrgId}/marketing-site/course-photos/99999999`)
      .send({ approved: true });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /marketing-site/course-photos/:id", () => {
  it("removes the row from the DB and from the pending list", async () => {
    const photoId = await seedPendingPhoto();

    const del = await request(adminApp())
      .delete(`/api/organizations/${testOrgId}/marketing-site/course-photos/${photoId}`);
    expect(del.status).toBe(204);

    const list = await request(adminApp())
      .get(`/api/organizations/${testOrgId}/marketing-site/course-photos?status=pending`);
    expect(list.body.find((p: { id: number }) => p.id === photoId)).toBeUndefined();

    const remaining = await db.select({ id: mediaTable.id })
      .from(mediaTable).where(eq(mediaTable.id, photoId));
    expect(remaining.length).toBe(0);
  });

  it("returns 404 when deleting a photo that does not belong to the org", async () => {
    const res = await request(adminApp())
      .delete(`/api/organizations/${testOrgId}/marketing-site/course-photos/99999999`);
    expect(res.status).toBe(404);
  });
});
