/**
 * Task #579 — Coverage for the marketing-site image library endpoints.
 *
 *   - GET    /api/organizations/:orgId/marketing-site/library
 *       lists every previously-uploaded image for the club, scoped by org,
 *       gated to site admins, sorted newest-first.
 *   - DELETE /api/organizations/:orgId/marketing-site/library/:imageId
 *       removes a row from the library, scoped by org, gated to site admins.
 *
 * These tests insert rows directly so they don't depend on real object
 * storage. The GET/DELETE handlers themselves don't touch storage on
 * the happy path beyond a best-effort `.delete({ ignoreNotFound: true })`
 * that swallows ObjectNotFoundError, so this is safe.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-marketing-library";
process.env.PRIVATE_OBJECT_DIR ||= "/test-bucket/private";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMarketingSitesTable,
  clubMarketingSiteImagesTable,
  coursesTable,
  orgRoleEnum,
} from "@workspace/db";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgAId: number;
let orgBId: number;
let admin: TestUser;
let outsider: TestUser;
let crossOrgAdmin: TestUser;
let superAdmin: TestUser;
const createdUserIds: number[] = [];
const seededImageIds: number[] = [];

const LIB_URL = (orgId: number) =>
  `/api/organizations/${orgId}/marketing-site/library`;

async function makeUser(orgId: number | null, role: OrgRole): Promise<TestUser> {
  const tag = uid(role);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@example.com`,
    displayName: tag,
    role,
    organizationId: orgId ?? undefined,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return {
    id: u.id,
    username: tag,
    displayName: tag,
    role,
    organizationId: orgId ?? undefined,
  };
}

async function seedImage(orgId: number, suffix: string) {
  const [row] = await db.insert(clubMarketingSiteImagesTable).values({
    organizationId: orgId,
    objectPath: `/objects/test-${suffix}.jpg`,
    url: `https://example.com/test-${suffix}.jpg`,
    contentType: "image/jpeg",
    sizeBytes: 1234,
  }).returning({ id: clubMarketingSiteImagesTable.id });
  seededImageIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const [orgA] = await db.insert(organizationsTable).values({
    name: `MktLibA_${stamp}`, slug: `mkt-lib-a-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;
  const [orgB] = await db.insert(organizationsTable).values({
    name: `MktLibB_${stamp}`, slug: `mkt-lib-b-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  admin = await makeUser(orgAId, "org_admin");
  outsider = await makeUser(orgAId, "player");
  crossOrgAdmin = await makeUser(orgBId, "org_admin");
  superAdmin = await makeUser(null, "super_admin");
});

afterAll(async () => {
  if (seededImageIds.length) {
    await db.delete(clubMarketingSiteImagesTable)
      .where(inArray(clubMarketingSiteImagesTable.id, seededImageIds));
  }
  await db.delete(clubMarketingSitesTable)
    .where(inArray(clubMarketingSitesTable.organizationId, [orgAId, orgBId]));
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  await db.delete(organizationsTable)
    .where(inArray(organizationsTable.id, [orgAId, orgBId]));
});

describe("GET /marketing-site/library", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).get(LIB_URL(orgAId));
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin role", async () => {
    const app = createTestApp(outsider);
    const res = await request(app).get(LIB_URL(orgAId));
    expect(res.status).toBe(403);
  });

  it("returns 403 when an org admin asks about another org", async () => {
    const app = createTestApp(crossOrgAdmin);
    const res = await request(app).get(LIB_URL(orgAId));
    expect(res.status).toBe(403);
  });

  it("returns only the calling org's images, newest first", async () => {
    const aId1 = await seedImage(orgAId, "a1");
    // Slight delay so createdAt strictly increases for ordering assertion.
    await new Promise(r => setTimeout(r, 10));
    const aId2 = await seedImage(orgAId, "a2");
    await seedImage(orgBId, "b1"); // must NOT appear in org A's list

    const app = createTestApp(admin);
    const res = await request(app).get(LIB_URL(orgAId));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = res.body.map((r: { id: number }) => r.id);
    expect(ids).toContain(aId1);
    expect(ids).toContain(aId2);
    // Newest first: aId2 (inserted second) precedes aId1.
    expect(ids.indexOf(aId2)).toBeLessThan(ids.indexOf(aId1));
    // Cross-org leak check.
    for (const row of res.body) {
      expect(row.url).not.toMatch(/test-b1/);
    }
  });

  it("super_admin may list any org's library", async () => {
    const app = createTestApp(superAdmin);
    const res = await request(app).get(LIB_URL(orgBId));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // Task #749 — Each row must include a `usage` array describing where
  // on the marketing site the image is currently referenced. Unused
  // images must come back with `usage: []`.
  it("annotates each image with its current usage on the site", async () => {
    const heroSuffix = `usage-hero-${Math.random().toString(36).slice(2, 7)}`;
    const gallerySuffix = `usage-gal-${Math.random().toString(36).slice(2, 7)}`;
    const ogSuffix = `usage-og-${Math.random().toString(36).slice(2, 7)}`;
    const logoSuffix = `usage-logo-${Math.random().toString(36).slice(2, 7)}`;
    const faviconSuffix = `usage-fav-${Math.random().toString(36).slice(2, 7)}`;
    const courseSuffix = `usage-course-${Math.random().toString(36).slice(2, 7)}`;
    const unusedSuffix = `usage-unused-${Math.random().toString(36).slice(2, 7)}`;
    const heroId = await seedImage(orgAId, heroSuffix);
    const galleryId = await seedImage(orgAId, gallerySuffix);
    const ogId = await seedImage(orgAId, ogSuffix);
    const logoId = await seedImage(orgAId, logoSuffix);
    const faviconId = await seedImage(orgAId, faviconSuffix);
    const courseHeroId = await seedImage(orgAId, courseSuffix);
    const unusedId = await seedImage(orgAId, unusedSuffix);

    const heroUrl = `https://example.com/test-${heroSuffix}.jpg`;
    const galleryUrl = `https://example.com/test-${gallerySuffix}.jpg`;
    const ogUrl = `https://example.com/test-${ogSuffix}.jpg`;
    const logoUrl = `https://example.com/test-${logoSuffix}.jpg`;
    const faviconUrl = `https://example.com/test-${faviconSuffix}.jpg`;
    const courseHeroUrl = `https://example.com/test-${courseSuffix}.jpg`;

    // Ensure a site row exists so we can wire references to it.
    await db.insert(clubMarketingSitesTable).values({
      organizationId: orgAId,
      heroImageUrl: heroUrl,
      seoOgImageUrl: ogUrl,
      logoImageUrl: logoUrl,
      faviconUrl,
      galleryImages: [{ url: galleryUrl, caption: null }],
    }).onConflictDoUpdate({
      target: clubMarketingSitesTable.organizationId,
      set: {
        heroImageUrl: heroUrl,
        seoOgImageUrl: ogUrl,
        logoImageUrl: logoUrl,
        faviconUrl,
        galleryImages: [{ url: galleryUrl, caption: null }],
      },
    });

    const courseSlug = `lib-usage-${Math.random().toString(36).slice(2, 7)}`;
    const [course] = await db.insert(coursesTable).values({
      organizationId: orgAId,
      name: "Library Usage Course",
      slug: courseSlug,
      holes: 18,
      par: 72,
      heroImageUrl: courseHeroUrl,
      isPublic: true,
    }).returning({ id: coursesTable.id });

    try {
      const app = createTestApp(admin);
      const res = await request(app).get(LIB_URL(orgAId));
      expect(res.status).toBe(200);
      const byId = new Map(
        res.body.map((r: { id: number; usage: { kind: string; label: string }[] }) => [r.id, r.usage]),
      );
      // Task #900 — Each usage row carries deep-link hints so the
      // picker's detail panel can jump straight to the editor section
      // that references the image. Same-page sections set
      // `targetTestId`; off-page (course pages) set `href` + `courseId`.
      expect(byId.get(heroId)).toEqual([
        { kind: "hero", label: "Hero banner", targetTestId: "input-hero-image-url" },
      ]);
      expect(byId.get(galleryId)).toEqual([
        { kind: "gallery", label: "Gallery photo #1", targetTestId: "gallery-row-0" },
      ]);
      expect(byId.get(ogId)).toEqual([
        { kind: "og", label: "Social share image", targetTestId: "input-og-image-url" },
      ]);
      expect(byId.get(logoId)).toEqual([
        { kind: "logo", label: "Marketing logo", targetTestId: "input-logo-image-url" },
      ]);
      expect(byId.get(faviconId)).toEqual([
        { kind: "favicon", label: "Favicon", targetTestId: "input-favicon-url" },
      ]);
      expect(byId.get(courseHeroId)).toEqual([
        {
          kind: "course",
          label: "Course: Library Usage Course",
          courseId: course.id,
          href: `/courses?courseId=${course.id}`,
        },
      ]);
      expect(byId.get(unusedId)).toEqual([]);
    } finally {
      await db.delete(coursesTable).where(eq(coursesTable.id, course.id));
    }
  });
});

describe("DELETE /marketing-site/library/:imageId", () => {
  it("returns 401 when unauthenticated", async () => {
    const id = await seedImage(orgAId, `del-anon-${Math.random()}`);
    const app = createTestApp();
    const res = await request(app).delete(`${LIB_URL(orgAId)}/${id}`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin", async () => {
    const id = await seedImage(orgAId, `del-player-${Math.random()}`);
    const app = createTestApp(outsider);
    const res = await request(app).delete(`${LIB_URL(orgAId)}/${id}`);
    expect(res.status).toBe(403);
  });

  it("returns 404 when the image belongs to another org", async () => {
    const id = await seedImage(orgBId, `del-cross-${Math.random()}`);
    const app = createTestApp(admin); // admin of org A trying to delete org B image
    const res = await request(app).delete(`${LIB_URL(orgAId)}/${id}`);
    expect(res.status).toBe(404);

    // Row must still exist.
    const still = await db.query.clubMarketingSiteImagesTable.findFirst({
      where: eq(clubMarketingSiteImagesTable.id, id),
    });
    expect(still).toBeTruthy();
  });

  it("deletes the row for an authorized admin and returns 204", async () => {
    const id = await seedImage(orgAId, `del-ok-${Math.random()}`);
    const app = createTestApp(admin);
    const res = await request(app).delete(`${LIB_URL(orgAId)}/${id}`);
    expect(res.status).toBe(204);

    const gone = await db.query.clubMarketingSiteImagesTable.findFirst({
      where: eq(clubMarketingSiteImagesTable.id, id),
    });
    expect(gone).toBeUndefined();
  });

  it("returns 400 when imageId is not a number", async () => {
    const app = createTestApp(admin);
    const res = await request(app).delete(`${LIB_URL(orgAId)}/not-a-number`);
    expect(res.status).toBe(400);
  });
});
