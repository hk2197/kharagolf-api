/**
 * Integration tests: Bulk-moderating pending course reviews (Task #629 / #788).
 *
 * Covers POST /api/organizations/:orgId/marketing-site/course-reviews/moderate-bulk:
 *   - happy path: every supplied id is updated to the requested status and
 *     moderatedByUserId / moderatedAt are persisted.
 *   - mixed batch: per-row failures for already-target-status rows, wrong-org
 *     rows, and missing ids are surfaced individually while valid rows still
 *     update (and wrong-org rows stay untouched, confirming org-scoping).
 *   - input validation: missing/empty reviewIds, > 200 ids, no valid numeric
 *     ids, missing/unknown status all 400.
 *   - authorization: unauthenticated 401, player role 403, wrong-org admin 403.
 *
 * Uses the real PostgreSQL database (DATABASE_URL). Fixtures are created in
 * beforeAll, refreshed before each test, and torn down in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  coursesTable,
  courseReviewsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgAId: number;
let orgBId: number;
let courseAId: number;
let courseBId: number;
let adminUserId: number;
let playerUserId: number;
let otherOrgAdminUserId: number;
let admin: TestUser;
let player: TestUser;
let otherOrgAdmin: TestUser;

const BULK_URL = () =>
  `/api/organizations/${orgAId}/marketing-site/course-reviews/moderate-bulk`;

async function insertReview(opts: {
  orgId: number;
  courseId: number;
  status?: "pending" | "approved" | "rejected" | "hidden";
  title?: string;
}): Promise<number> {
  const [row] = await db.insert(courseReviewsTable).values({
    organizationId: opts.orgId,
    courseId: opts.courseId,
    reviewerDisplayName: "Test Reviewer",
    reviewerEmail: "rev@example.com",
    displayMode: "public",
    rating: 4,
    title: opts.title ?? `Review_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    body: "Body of the review",
    status: opts.status ?? "pending",
    abuseReportCount: 0,
  }).returning({ id: courseReviewsTable.id });
  return row.id;
}

async function clearReviews() {
  await db.delete(courseReviewsTable)
    .where(inArray(courseReviewsTable.organizationId, [orgAId, orgBId]));
}

beforeAll(async () => {
  const stamp = Date.now();
  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_BulkReviewModA_${stamp}`,
    slug: `test-bulk-review-mod-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_BulkReviewModB_${stamp}`,
    slug: `test-bulk-review-mod-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [courseA] = await db.insert(coursesTable).values({
    organizationId: orgAId,
    name: "Bulk Review Mod Course A",
    slug: `bulk-review-course-a-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseAId = courseA.id;

  const [courseB] = await db.insert(coursesTable).values({
    organizationId: orgBId,
    name: "Bulk Review Mod Course B",
    slug: `bulk-review-course-b-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseBId = courseB.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-bulk-rev-admin-${stamp}`,
    username: `bulk_rev_admin_${stamp}`,
    email: `bulk_rev_admin_${stamp}@example.com`,
    displayName: "Bulk Review Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [playerRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-bulk-rev-player-${stamp}`,
    username: `bulk_rev_player_${stamp}`,
    email: `bulk_rev_player_${stamp}@example.com`,
    displayName: "Player",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  playerUserId = playerRow.id;

  const [otherAdminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-bulk-rev-other-admin-${stamp}`,
    username: `bulk_rev_other_admin_${stamp}`,
    email: `bulk_rev_other_admin_${stamp}@example.com`,
    displayName: "Other Org Admin",
    role: "org_admin",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  otherOrgAdminUserId = otherAdminRow.id;

  admin = {
    id: adminUserId,
    username: `bulk_rev_admin_${stamp}`,
    role: "org_admin",
    organizationId: orgAId,
  };
  player = {
    id: playerUserId,
    username: `bulk_rev_player_${stamp}`,
    role: "player",
    organizationId: orgAId,
  };
  otherOrgAdmin = {
    id: otherOrgAdminUserId,
    username: `bulk_rev_other_admin_${stamp}`,
    role: "org_admin",
    organizationId: orgBId,
  };
});

afterAll(async () => {
  await clearReviews();
  if (courseAId) await db.delete(coursesTable).where(eq(coursesTable.id, courseAId));
  if (courseBId) await db.delete(coursesTable).where(eq(coursesTable.id, courseBId));
  for (const id of [adminUserId, playerUserId, otherOrgAdminUserId]) {
    if (id) await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

beforeEach(async () => {
  await clearReviews();
});

describe("POST /course-reviews/moderate-bulk — happy path", () => {
  it("approves every supplied review, persists moderator + timestamp, and reports counts", async () => {
    const app = createTestApp(admin);
    const ids = [
      await insertReview({ orgId: orgAId, courseId: courseAId }),
      await insertReview({ orgId: orgAId, courseId: courseAId }),
      await insertReview({ orgId: orgAId, courseId: courseAId }),
    ];

    const res = await request(app).post(BULK_URL()).send({ reviewIds: ids, status: "approved" });
    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(3);
    expect(res.body.errorCount).toBe(0);
    expect(res.body.errors).toEqual([]);
    expect(res.body.status).toBe("approved");
    expect(res.body.updated.map((u: { id: number }) => u.id).sort()).toEqual([...ids].sort());
    for (const u of res.body.updated) {
      expect(u.courseId).toBe(courseAId);
      expect(u.status).toBe("approved");
    }

    const rows = await db.select().from(courseReviewsTable)
      .where(inArray(courseReviewsTable.id, ids));
    for (const r of rows) {
      expect(r.status).toBe("approved");
      expect(r.moderatedByUserId).toBe(adminUserId);
      expect(r.moderatedAt).not.toBeNull();
    }
  });

  it("supports the 'rejected' and 'hidden' status values too", async () => {
    const app = createTestApp(admin);
    const rejectId = await insertReview({ orgId: orgAId, courseId: courseAId });
    const hideId = await insertReview({ orgId: orgAId, courseId: courseAId });

    const r1 = await request(app).post(BULK_URL()).send({ reviewIds: [rejectId], status: "rejected" });
    expect(r1.status).toBe(200);
    expect(r1.body.updatedCount).toBe(1);

    const r2 = await request(app).post(BULK_URL()).send({ reviewIds: [hideId], status: "hidden" });
    expect(r2.status).toBe(200);
    expect(r2.body.updatedCount).toBe(1);

    const [rejected] = await db.select().from(courseReviewsTable).where(eq(courseReviewsTable.id, rejectId));
    expect(rejected.status).toBe("rejected");
    const [hidden] = await db.select().from(courseReviewsTable).where(eq(courseReviewsTable.id, hideId));
    expect(hidden.status).toBe("hidden");
  });
});

describe("POST /course-reviews/moderate-bulk — mixed batch", () => {
  it("returns partial errors for already-target-status, wrong-org, and missing reviews", async () => {
    const app = createTestApp(admin);
    const okId = await insertReview({ orgId: orgAId, courseId: courseAId });
    const alreadyApprovedId = await insertReview({
      orgId: orgAId, courseId: courseAId, status: "approved",
    });
    const wrongOrgId = await insertReview({ orgId: orgBId, courseId: courseBId });
    const missingId = 99_999_999;

    const res = await request(app).post(BULK_URL()).send({
      reviewIds: [okId, alreadyApprovedId, wrongOrgId, missingId],
      status: "approved",
    });

    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(1);
    expect(res.body.errorCount).toBe(3);
    expect(res.body.updated).toEqual([
      expect.objectContaining({ id: okId, courseId: courseAId, status: "approved" }),
    ]);

    const errMap = new Map<number, string>(
      res.body.errors.map((e: { reviewId: number; error: string }) => [e.reviewId, e.error]),
    );
    expect(errMap.get(alreadyApprovedId)).toMatch(/already approved/i);
    expect(errMap.get(wrongOrgId)).toMatch(/not found/i);
    expect(errMap.get(missingId)).toMatch(/not found/i);

    // Wrong-org review must NOT have been touched — confirms org-scoping.
    const [wrongOrgRow] = await db.select().from(courseReviewsTable)
      .where(eq(courseReviewsTable.id, wrongOrgId));
    expect(wrongOrgRow.status).toBe("pending");
    expect(wrongOrgRow.moderatedByUserId).toBeNull();
  });
});

describe("POST /course-reviews/moderate-bulk — input validation", () => {
  it("rejects an empty body with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app).post(BULK_URL()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reviewIds/i);
  });

  it("rejects an empty reviewIds array with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app).post(BULK_URL()).send({ reviewIds: [], status: "approved" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reviewIds/i);
  });

  it("rejects more than 200 ids with 400", async () => {
    const app = createTestApp(admin);
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    const res = await request(app).post(BULK_URL()).send({ reviewIds: ids, status: "approved" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/200/);
  });

  it("rejects an array of only invalid ids with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app).post(BULK_URL())
      .send({ reviewIds: ["not-a-number", null, -3, 0], status: "approved" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no valid/i);
  });

  it("rejects an unknown status value with 400 (guards the enum the UI sends)", async () => {
    const app = createTestApp(admin);
    const id = await insertReview({ orgId: orgAId, courseId: courseAId });
    const res = await request(app).post(BULK_URL()).send({ reviewIds: [id], status: "totally-not-real" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);

    // Review must remain pending and unmoderated.
    const [row] = await db.select().from(courseReviewsTable).where(eq(courseReviewsTable.id, id));
    expect(row.status).toBe("pending");
    expect(row.moderatedByUserId).toBeNull();
  });

  it("rejects a missing status with 400", async () => {
    const app = createTestApp(admin);
    const id = await insertReview({ orgId: orgAId, courseId: courseAId });
    const res = await request(app).post(BULK_URL()).send({ reviewIds: [id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);
  });
});

describe("POST /course-reviews/moderate-bulk — authorization", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const id = await insertReview({ orgId: orgAId, courseId: courseAId });
    const res = await request(app).post(BULK_URL()).send({ reviewIds: [id], status: "approved" });
    expect(res.status).toBe(401);

    const [row] = await db.select().from(courseReviewsTable).where(eq(courseReviewsTable.id, id));
    expect(row.status).toBe("pending");
  });

  it("returns 403 when caller has player role", async () => {
    const app = createTestApp(player);
    const id = await insertReview({ orgId: orgAId, courseId: courseAId });
    const res = await request(app).post(BULK_URL()).send({ reviewIds: [id], status: "approved" });
    expect(res.status).toBe(403);
  });

  it("returns 403 for an org_admin from a different org", async () => {
    const app = createTestApp(otherOrgAdmin);
    const id = await insertReview({ orgId: orgAId, courseId: courseAId });
    const res = await request(app).post(BULK_URL()).send({ reviewIds: [id], status: "approved" });
    expect(res.status).toBe(403);

    const [row] = await db.select().from(courseReviewsTable).where(eq(courseReviewsTable.id, id));
    expect(row.status).toBe("pending");
  });
});
