/**
 * Task #627 — Coverage for the public course photo submission flow added in Task #475.
 *
 *   POST /api/public/clubs/:slug/courses/:courseSlug/photos/upload-url
 *   POST /api/public/clubs/:slug/courses/:courseSlug/photos
 *
 * The handlers depend on `ObjectStorageService` (presigned URLs, stored object
 * metadata, ACL) so we mock that module — the database side is exercised
 * against the real test DB.
 */
process.env.SESSION_SECRET ||= "test-session-secret-public-photos";
process.env.PRIVATE_OBJECT_DIR ||= "/test-bucket/private-photos";

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { mockState } = vi.hoisted(() => ({
  mockState: {
    counter: 0,
    objects: new Map<string, { contentType: string; size: number }>(),
    aclFailures: new Set<string>(),
  },
}));

vi.mock("../lib/objectStorage.js", () => ({
  objectStorageClient: { bucket: () => ({ file: () => ({}) }) },
  ObjectStorageService: class {
    async getObjectEntityUploadURL(): Promise<string> {
      mockState.counter += 1;
      return `https://storage.googleapis.com/test-bucket/private-photos/uploads/test-${mockState.counter}`;
    }
    normalizeObjectEntityPath(uploadURL: string): string {
      const id = uploadURL.split("/").pop();
      return `/objects/uploads/${id}`;
    }
    async getObjectEntityFile(objectPath: string) {
      const meta = mockState.objects.get(objectPath);
      if (!meta) throw new Error("ObjectNotFoundError");
      return {
        async getMetadata() {
          return [{ contentType: meta.contentType, size: meta.size }];
        },
      };
    }
    async trySetObjectEntityAclPolicy(objectPath: string, _policy: unknown) {
      if (mockState.aclFailures.has(objectPath)) throw new Error("acl failed");
      return undefined;
    }
  },
}));

import request from "supertest";
import { createHmac } from "crypto";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  coursesTable,
  mediaTable,
  orgRoleEnum,
} from "@workspace/db";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgId: number;
let publicCourseId: number;
let privateCourseId: number;
let clubSlug: string;
let publicCourseSlug: string;
let privateCourseSlug: string;
let admin: TestUser;
let player: TestUser;
const createdUserIds: number[] = [];
const createdMediaIds: number[] = [];

function signToken(objectPath: string): string {
  return createHmac("sha256", process.env.PRIVATE_OBJECT_DIR!)
    .update(objectPath)
    .digest("hex");
}

async function makeUser(orgIdForUser: number | null, role: OrgRole): Promise<TestUser> {
  const tag = uid(role);
  const [u] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: tag,
      username: tag,
      email: `${tag}@example.com`,
      displayName: tag,
      role,
      organizationId: orgIdForUser ?? undefined,
    })
    .returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return {
    id: u.id,
    username: tag,
    displayName: tag,
    role,
    organizationId: orgIdForUser ?? undefined,
  };
}

async function getUploadCredentials(slug: string, courseSlugVal: string, body: Record<string, unknown> = {}) {
  const app = createTestApp();
  const res = await request(app)
    .post(`/api/public/clubs/${slug}/courses/${courseSlugVal}/photos/upload-url`)
    .send(body);
  return res;
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  clubSlug = `pubphotos-${stamp}`.toLowerCase();
  publicCourseSlug = `pub-course-${stamp}`.toLowerCase();
  privateCourseSlug = `priv-course-${stamp}`.toLowerCase();

  const [org] = await db
    .insert(organizationsTable)
    .values({ name: `PubPhotos_${stamp}`, slug: clubSlug })
    .returning({ id: organizationsTable.id });
  orgId = org.id;

  const [pc] = await db
    .insert(coursesTable)
    .values({
      organizationId: orgId,
      name: `Pub Course ${stamp}`,
      slug: publicCourseSlug,
      holes: 18,
      par: 72,
      isPublic: true,
    })
    .returning({ id: coursesTable.id });
  publicCourseId = pc.id;

  const [hc] = await db
    .insert(coursesTable)
    .values({
      organizationId: orgId,
      name: `Priv Course ${stamp}`,
      slug: privateCourseSlug,
      holes: 18,
      par: 72,
      isPublic: false,
    })
    .returning({ id: coursesTable.id });
  privateCourseId = hc.id;

  admin = await makeUser(orgId, "org_admin");
  player = await makeUser(orgId, "player");
});

afterAll(async () => {
  if (createdMediaIds.length) {
    await db.delete(mediaTable).where(inArray(mediaTable.id, createdMediaIds));
  }
  await db.delete(mediaTable).where(eq(mediaTable.organizationId, orgId));
  await db.delete(coursesTable).where(inArray(coursesTable.id, [publicCourseId, privateCourseId]));
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(() => {
  mockState.objects.clear();
  mockState.aclFailures.clear();
});

describe("POST /api/public/clubs/:slug/courses/:courseSlug/photos/upload-url", () => {
  it("returns 404 when the club slug is unknown", async () => {
    const res = await getUploadCredentials("does-not-exist-club", publicCourseSlug);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the course slug is unknown", async () => {
    const res = await getUploadCredentials(clubSlug, "does-not-exist-course");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the course is not public", async () => {
    const res = await getUploadCredentials(clubSlug, privateCourseSlug);
    expect(res.status).toBe(404);
  });

  it("returns 400 when contentType is not an allowed image type", async () => {
    const res = await getUploadCredentials(clubSlug, publicCourseSlug, {
      contentType: "application/pdf",
      size: 1024,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported image type/i);
  });

  it("returns 400 when the declared size exceeds the 10 MB limit", async () => {
    const res = await getUploadCredentials(clubSlug, publicCourseSlug, {
      contentType: "image/jpeg",
      size: 11 * 1024 * 1024,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
  });

  it("returns a presigned URL, object path, and matching upload token (happy path)", async () => {
    const res = await getUploadCredentials(clubSlug, publicCourseSlug, {
      contentType: "image/jpeg",
      size: 50_000,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.uploadURL).toBe("string");
    expect(res.body.uploadURL).toMatch(/^https?:\/\//);
    expect(typeof res.body.objectPath).toBe("string");
    expect(res.body.objectPath).toMatch(/^\/objects\/uploads\//);
    expect(typeof res.body.uploadToken).toBe("string");
    // The token must be the HMAC of the objectPath under PRIVATE_OBJECT_DIR.
    expect(res.body.uploadToken).toBe(signToken(res.body.objectPath));
  });
});

describe("POST /api/public/clubs/:slug/courses/:courseSlug/photos", () => {
  async function getCreds(extra: Record<string, unknown> = { contentType: "image/jpeg", size: 50_000 }) {
    const r = await getUploadCredentials(clubSlug, publicCourseSlug, extra);
    expect(r.status).toBe(200);
    return r.body as { objectPath: string; uploadToken: string; uploadURL: string };
  }

  function trackMedia(id: number) {
    createdMediaIds.push(id);
  }

  it("returns 404 when the club is unknown", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/public/clubs/no-such-club/courses/${publicCourseSlug}/photos`)
      .send({ objectPath: "/objects/uploads/x", uploadToken: "x", uploaderName: "Anon" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the course is unknown / not public", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/public/clubs/${clubSlug}/courses/${privateCourseSlug}/photos`)
      .send({ objectPath: "/objects/uploads/x", uploadToken: "x", uploaderName: "Anon" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when objectPath is missing", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/public/clubs/${clubSlug}/courses/${publicCourseSlug}/photos`)
      .send({ uploadToken: "x", uploaderName: "Anon" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/objectPath/i);
  });

  it("returns 403 when the upload token does not match the objectPath", async () => {
    const { objectPath } = await getCreds();
    mockState.objects.set(objectPath, { contentType: "image/jpeg", size: 1234 });
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/public/clubs/${clubSlug}/courses/${publicCourseSlug}/photos`)
      .send({ objectPath, uploadToken: "totally-bogus-token", uploaderName: "Anon" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Invalid.*upload token/i);
  });

  it("returns 404 when the uploaded object cannot be found in storage", async () => {
    const { objectPath, uploadToken } = await getCreds();
    // Note: NOT seeding mockState.objects → getObjectEntityFile throws.
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/public/clubs/${clubSlug}/courses/${publicCourseSlug}/photos`)
      .send({ objectPath, uploadToken, uploaderName: "Anon" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Uploaded object not found/i);
  });

  it("returns 400 when the stored image exceeds the 10 MB maximum", async () => {
    const { objectPath, uploadToken } = await getCreds();
    mockState.objects.set(objectPath, {
      contentType: "image/jpeg",
      size: 11 * 1024 * 1024,
    });
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/public/clubs/${clubSlug}/courses/${publicCourseSlug}/photos`)
      .send({ objectPath, uploadToken, uploaderName: "Anon" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds the 10 MB/i);
  });

  it("returns 400 when the stored content-type is not an allowed image type", async () => {
    const { objectPath, uploadToken } = await getCreds();
    mockState.objects.set(objectPath, { contentType: "application/pdf", size: 1234 });
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/public/clubs/${clubSlug}/courses/${publicCourseSlug}/photos`)
      .send({ objectPath, uploadToken, uploaderName: "Anon" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported image type/i);
  });

  it("returns 400 when an anonymous submitter does not provide a name", async () => {
    const { objectPath, uploadToken } = await getCreds();
    mockState.objects.set(objectPath, { contentType: "image/jpeg", size: 4096 });
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/public/clubs/${clubSlug}/courses/${publicCourseSlug}/photos`)
      .send({ objectPath, uploadToken });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uploaderName is required/i);
  });

  it("returns 400 when holeNumber is out of range for this course", async () => {
    const { objectPath, uploadToken } = await getCreds();
    mockState.objects.set(objectPath, { contentType: "image/jpeg", size: 4096 });
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/public/clubs/${clubSlug}/courses/${publicCourseSlug}/photos`)
      .send({ objectPath, uploadToken, uploaderName: "Anon", holeNumber: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/holeNumber must be between 1 and 18/i);
  });

  it("creates a pending media row for an anonymous submitter (happy path)", async () => {
    const { objectPath, uploadToken } = await getCreds();
    mockState.objects.set(objectPath, { contentType: "image/jpeg", size: 6789 });
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/public/clubs/${clubSlug}/courses/${publicCourseSlug}/photos`)
      .send({
        objectPath,
        uploadToken,
        uploaderName: "Course Visitor",
        caption: "Lovely view from the 5th tee",
        holeNumber: 5,
      });
    expect(res.status).toBe(201);
    expect(res.body.approved).toBe(false);
    expect(res.body.status).toBe("pending");
    expect(typeof res.body.id).toBe("number");
    trackMedia(res.body.id);

    const [row] = await db.select().from(mediaTable).where(eq(mediaTable.id, res.body.id));
    expect(row).toBeTruthy();
    expect(row.organizationId).toBe(orgId);
    expect(row.courseId).toBe(publicCourseId);
    expect(row.approved).toBe(false);
    expect(row.uploaderName).toBe("Course Visitor");
    expect(row.caption).toBe("Lovely view from the 5th tee");
    expect(row.holeNumber).toBe(5);
    expect(row.uploadedByUserId).toBeNull();
  });

  it("auto-approves when an authenticated club admin submits", async () => {
    const { objectPath, uploadToken } = await getCreds();
    mockState.objects.set(objectPath, { contentType: "image/png", size: 4096 });
    const app = createTestApp(admin);
    const res = await request(app)
      .post(`/api/public/clubs/${clubSlug}/courses/${publicCourseSlug}/photos`)
      .send({ objectPath, uploadToken, uploaderName: "Admin", caption: "From admin" });
    expect(res.status).toBe(201);
    expect(res.body.approved).toBe(true);
    expect(res.body.status).toBe("approved");
    trackMedia(res.body.id);

    const [row] = await db.select().from(mediaTable).where(eq(mediaTable.id, res.body.id));
    expect(row.approved).toBe(true);
    expect(row.uploadedByUserId).toBe(admin.id);
  });

  it("does NOT auto-approve a non-admin authenticated player", async () => {
    const { objectPath, uploadToken } = await getCreds();
    mockState.objects.set(objectPath, { contentType: "image/webp", size: 2048 });
    const app = createTestApp(player);
    const res = await request(app)
      .post(`/api/public/clubs/${clubSlug}/courses/${publicCourseSlug}/photos`)
      .send({ objectPath, uploadToken });
    expect(res.status).toBe(201);
    expect(res.body.approved).toBe(false);
    expect(res.body.status).toBe("pending");
    trackMedia(res.body.id);

    const [row] = await db.select().from(mediaTable).where(eq(mediaTable.id, res.body.id));
    expect(row.approved).toBe(false);
    expect(row.uploadedByUserId).toBe(player.id);
  });

  it("returns 500 when ACL setup fails", async () => {
    const { objectPath, uploadToken } = await getCreds();
    mockState.objects.set(objectPath, { contentType: "image/jpeg", size: 4096 });
    mockState.aclFailures.add(objectPath);
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/public/clubs/${clubSlug}/courses/${publicCourseSlug}/photos`)
      .send({ objectPath, uploadToken, uploaderName: "Anon" });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to mark image as public/i);
  });
});
