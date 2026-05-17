/**
 * Integration tests: Bulk-moderating pending course photos (Task #629 / #788).
 *
 * Covers POST /api/organizations/:orgId/marketing-site/course-photos/moderate-bulk:
 *   - happy path (action="approve"): every supplied id flips approved=true and
 *     is reported in the success list.
 *   - happy path (action="reject"): every supplied id is hard-deleted from the
 *     mediaTable (matching the per-row reject UX) and reported in the success
 *     list with its courseId so the UI can refresh the right caches.
 *   - mixed batch (approve): per-row failures for already-approved, wrong-org,
 *     and missing photos are surfaced individually while valid rows still
 *     update (and wrong-org rows stay untouched, confirming org-scoping).
 *   - mixed batch (reject): per-row "not found" failures for wrong-org and
 *     missing rows still let valid rows be deleted.
 *   - input validation: missing/empty photoIds, > 200 ids, no valid numeric
 *     ids, missing/unknown action all 400.
 *   - authorization: unauthenticated 401, player role 403, wrong-org admin 403.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  coursesTable,
  mediaTable,
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
  `/api/organizations/${orgAId}/marketing-site/course-photos/moderate-bulk`;

async function insertPhoto(opts: {
  orgId: number;
  courseId: number;
  approved?: boolean;
}): Promise<number> {
  const [row] = await db.insert(mediaTable).values({
    organizationId: opts.orgId,
    courseId: opts.courseId,
    objectPath: `/test-photo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`,
    mediaType: "image",
    approved: opts.approved ?? false,
    uploaderName: "Test Uploader",
    caption: "Caption",
  }).returning({ id: mediaTable.id });
  return row.id;
}

async function clearPhotos() {
  await db.delete(mediaTable)
    .where(inArray(mediaTable.organizationId, [orgAId, orgBId]));
}

beforeAll(async () => {
  const stamp = Date.now();
  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_BulkPhotoModA_${stamp}`,
    slug: `test-bulk-photo-mod-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_BulkPhotoModB_${stamp}`,
    slug: `test-bulk-photo-mod-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [courseA] = await db.insert(coursesTable).values({
    organizationId: orgAId,
    name: "Bulk Photo Mod Course A",
    slug: `bulk-photo-course-a-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseAId = courseA.id;

  const [courseB] = await db.insert(coursesTable).values({
    organizationId: orgBId,
    name: "Bulk Photo Mod Course B",
    slug: `bulk-photo-course-b-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseBId = courseB.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-bulk-photo-admin-${stamp}`,
    username: `bulk_photo_admin_${stamp}`,
    email: `bulk_photo_admin_${stamp}@example.com`,
    displayName: "Bulk Photo Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [playerRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-bulk-photo-player-${stamp}`,
    username: `bulk_photo_player_${stamp}`,
    email: `bulk_photo_player_${stamp}@example.com`,
    displayName: "Player",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  playerUserId = playerRow.id;

  const [otherAdminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-bulk-photo-other-admin-${stamp}`,
    username: `bulk_photo_other_admin_${stamp}`,
    email: `bulk_photo_other_admin_${stamp}@example.com`,
    displayName: "Other Org Admin",
    role: "org_admin",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  otherOrgAdminUserId = otherAdminRow.id;

  admin = {
    id: adminUserId,
    username: `bulk_photo_admin_${stamp}`,
    role: "org_admin",
    organizationId: orgAId,
  };
  player = {
    id: playerUserId,
    username: `bulk_photo_player_${stamp}`,
    role: "player",
    organizationId: orgAId,
  };
  otherOrgAdmin = {
    id: otherOrgAdminUserId,
    username: `bulk_photo_other_admin_${stamp}`,
    role: "org_admin",
    organizationId: orgBId,
  };
});

afterAll(async () => {
  await clearPhotos();
  if (courseAId) await db.delete(coursesTable).where(eq(coursesTable.id, courseAId));
  if (courseBId) await db.delete(coursesTable).where(eq(coursesTable.id, courseBId));
  for (const id of [adminUserId, playerUserId, otherOrgAdminUserId]) {
    if (id) await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

beforeEach(async () => {
  await clearPhotos();
});

describe("POST /course-photos/moderate-bulk — approve happy path", () => {
  it("flips approved=true on every supplied photo and reports counts", async () => {
    const app = createTestApp(admin);
    const ids = [
      await insertPhoto({ orgId: orgAId, courseId: courseAId }),
      await insertPhoto({ orgId: orgAId, courseId: courseAId }),
      await insertPhoto({ orgId: orgAId, courseId: courseAId }),
    ];

    const res = await request(app).post(BULK_URL()).send({ photoIds: ids, action: "approve" });
    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(3);
    expect(res.body.errorCount).toBe(0);
    expect(res.body.errors).toEqual([]);
    expect(res.body.action).toBe("approve");
    expect(res.body.updated.map((u: { id: number }) => u.id).sort()).toEqual([...ids].sort());
    for (const u of res.body.updated) {
      expect(u.courseId).toBe(courseAId);
    }

    const rows = await db.select().from(mediaTable)
      .where(inArray(mediaTable.id, ids));
    for (const r of rows) {
      expect(r.approved).toBe(true);
    }
  });
});

describe("POST /course-photos/moderate-bulk — reject (delete) happy path", () => {
  it("hard-deletes every supplied photo and reports counts", async () => {
    const app = createTestApp(admin);
    const ids = [
      await insertPhoto({ orgId: orgAId, courseId: courseAId }),
      await insertPhoto({ orgId: orgAId, courseId: courseAId }),
    ];

    const res = await request(app).post(BULK_URL()).send({ photoIds: ids, action: "reject" });
    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(2);
    expect(res.body.errorCount).toBe(0);
    expect(res.body.action).toBe("reject");
    expect(res.body.updated.map((u: { id: number }) => u.id).sort()).toEqual([...ids].sort());

    const remaining = await db.select({ id: mediaTable.id }).from(mediaTable)
      .where(inArray(mediaTable.id, ids));
    expect(remaining).toEqual([]);
  });
});

describe("POST /course-photos/moderate-bulk — mixed batch (approve)", () => {
  it("returns partial errors for already-approved, wrong-org, and missing photos", async () => {
    const app = createTestApp(admin);
    const okId = await insertPhoto({ orgId: orgAId, courseId: courseAId });
    const alreadyApprovedId = await insertPhoto({ orgId: orgAId, courseId: courseAId, approved: true });
    const wrongOrgId = await insertPhoto({ orgId: orgBId, courseId: courseBId });
    const missingId = 99_999_999;

    const res = await request(app).post(BULK_URL()).send({
      photoIds: [okId, alreadyApprovedId, wrongOrgId, missingId],
      action: "approve",
    });
    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(1);
    expect(res.body.errorCount).toBe(3);
    expect(res.body.updated).toEqual([
      expect.objectContaining({ id: okId, courseId: courseAId }),
    ]);

    const errMap = new Map<number, string>(
      res.body.errors.map((e: { photoId: number; error: string }) => [e.photoId, e.error]),
    );
    expect(errMap.get(alreadyApprovedId)).toMatch(/already approved/i);
    expect(errMap.get(wrongOrgId)).toMatch(/not found/i);
    expect(errMap.get(missingId)).toMatch(/not found/i);

    // Wrong-org photo still unapproved — confirms org-scoping.
    const [wrongOrgRow] = await db.select().from(mediaTable)
      .where(eq(mediaTable.id, wrongOrgId));
    expect(wrongOrgRow.approved).toBe(false);
  });
});

describe("POST /course-photos/moderate-bulk — mixed batch (reject)", () => {
  it("deletes valid rows but reports wrong-org and missing rows as not-found", async () => {
    const app = createTestApp(admin);
    const okId = await insertPhoto({ orgId: orgAId, courseId: courseAId });
    const wrongOrgId = await insertPhoto({ orgId: orgBId, courseId: courseBId });
    const missingId = 99_999_998;

    const res = await request(app).post(BULK_URL()).send({
      photoIds: [okId, wrongOrgId, missingId],
      action: "reject",
    });
    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(1);
    expect(res.body.errorCount).toBe(2);
    expect(res.body.updated).toEqual([
      expect.objectContaining({ id: okId, courseId: courseAId }),
    ]);

    const errMap = new Map<number, string>(
      res.body.errors.map((e: { photoId: number; error: string }) => [e.photoId, e.error]),
    );
    expect(errMap.get(wrongOrgId)).toMatch(/not found/i);
    expect(errMap.get(missingId)).toMatch(/not found/i);

    // The valid row is gone; the wrong-org row survives untouched.
    const survivors = await db.select({ id: mediaTable.id }).from(mediaTable)
      .where(inArray(mediaTable.id, [okId, wrongOrgId]));
    expect(survivors.map((s) => s.id)).toEqual([wrongOrgId]);
  });
});

describe("POST /course-photos/moderate-bulk — input validation", () => {
  it("rejects an empty body with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app).post(BULK_URL()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/photoIds/i);
  });

  it("rejects an empty photoIds array with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app).post(BULK_URL()).send({ photoIds: [], action: "approve" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/photoIds/i);
  });

  it("rejects more than 200 ids with 400", async () => {
    const app = createTestApp(admin);
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    const res = await request(app).post(BULK_URL()).send({ photoIds: ids, action: "approve" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/200/);
  });

  it("rejects an array of only invalid ids with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app).post(BULK_URL())
      .send({ photoIds: ["not-a-number", null, -3, 0], action: "approve" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no valid/i);
  });

  it("rejects a missing action with 400", async () => {
    const app = createTestApp(admin);
    const id = await insertPhoto({ orgId: orgAId, courseId: courseAId });
    const res = await request(app).post(BULK_URL()).send({ photoIds: [id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/action/i);
  });

  it("rejects an unknown action with 400", async () => {
    const app = createTestApp(admin);
    const id = await insertPhoto({ orgId: orgAId, courseId: courseAId });
    const res = await request(app).post(BULK_URL()).send({ photoIds: [id], action: "totally-not-real" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/action/i);

    // Photo must remain unapproved AND undeleted.
    const [row] = await db.select().from(mediaTable).where(eq(mediaTable.id, id));
    expect(row).toBeDefined();
    expect(row.approved).toBe(false);
  });
});

describe("POST /course-photos/moderate-bulk — authorization", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const id = await insertPhoto({ orgId: orgAId, courseId: courseAId });
    const res = await request(app).post(BULK_URL()).send({ photoIds: [id], action: "approve" });
    expect(res.status).toBe(401);

    const [row] = await db.select().from(mediaTable).where(eq(mediaTable.id, id));
    expect(row.approved).toBe(false);
  });

  it("returns 403 when caller has player role", async () => {
    const app = createTestApp(player);
    const id = await insertPhoto({ orgId: orgAId, courseId: courseAId });
    const res = await request(app).post(BULK_URL()).send({ photoIds: [id], action: "approve" });
    expect(res.status).toBe(403);
  });

  it("returns 403 for an org_admin from a different org, even on reject", async () => {
    const app = createTestApp(otherOrgAdmin);
    const id = await insertPhoto({ orgId: orgAId, courseId: courseAId });
    const res = await request(app).post(BULK_URL()).send({ photoIds: [id], action: "reject" });
    expect(res.status).toBe(403);

    // Photo must still exist (not deleted).
    const [row] = await db.select().from(mediaTable).where(eq(mediaTable.id, id));
    expect(row).toBeDefined();
  });
});
