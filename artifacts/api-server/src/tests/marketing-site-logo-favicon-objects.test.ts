/**
 * Task #948 — Validate stored object metadata for marketing-site
 * `logoImageUrl` / `faviconUrl` overrides whose value is an internal
 * `/objects/<entityId>` path.
 *
 * The PUT /api/organizations/:orgId/marketing-site handler must:
 *   - Reject objects whose stored content-type is missing.
 *   - Reject objects whose stored content-type is not in the image
 *     allow-list (e.g. text/html, application/pdf).
 *   - Reject objects larger than the marketing logo/favicon size cap
 *     (Task #1468 — 1 MB, deliberately tighter than the 10 MB cap
 *     direct gallery / hero uploads use).
 *   - Accept objects with an allow-listed content-type and acceptable
 *     size, persisting the `/objects/...` path verbatim.
 *
 * `ObjectStorageService` is mocked so we can drive the metadata returned
 * for any given path without touching real GCS.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-marketing-logo-favicon-objects";
process.env.PRIVATE_OBJECT_DIR ||= "/test-bucket/private-marketing";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const { mockState } = vi.hoisted(() => ({
  mockState: {
    objects: new Map<string, { contentType: string | undefined; size: number }>(),
  },
}));

vi.mock("../lib/objectStorage.js", () => ({
  objectStorageClient: { bucket: () => ({ file: () => ({}) }) },
  ObjectStorageService: class {
    async getObjectEntityUploadURL(): Promise<string> {
      return "https://storage.googleapis.com/test-bucket/private-marketing/uploads/x";
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
    async trySetObjectEntityAclPolicy() { return undefined; }
  },
}));

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMarketingSitesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgId: number;
let admin: TestUser;
const createdUserIds: number[] = [];

const URL = (id: number) => `/api/organizations/${id}/marketing-site`;

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const slug = `mkt-logofav-obj-${stamp}`.toLowerCase();
  const [org] = await db.insert(organizationsTable).values({
    name: `MktLogoFavObj_${stamp}`,
    slug,
    isActive: true,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const tag = uid("org_admin");
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@example.com`,
    displayName: tag,
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  admin = { id: u.id, username: tag, displayName: tag, role: "org_admin", organizationId: orgId };
});

afterAll(async () => {
  await db.delete(clubMarketingSitesTable).where(
    eq(clubMarketingSitesTable.organizationId, orgId),
  );
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("PUT /marketing-site — /objects/... metadata validation (Task #948)", () => {
  it("accepts an /objects/... path with an allow-listed image content-type and OK size", async () => {
    const path = "/objects/uploads/good-png";
    mockState.objects.set(path, { contentType: "image/png", size: 12_345 });

    const res = await request(createTestApp(admin)).put(URL(orgId)).send({
      logoImageUrl: path,
    });
    expect(res.status).toBe(200);
    expect(res.body.logoImageUrl).toBe(path);
  });

  it("normalizes content-type casing/whitespace before checking the allow-list", async () => {
    const path = "/objects/uploads/messy-ct";
    mockState.objects.set(path, { contentType: "  IMAGE/JPEG  ", size: 100 });

    const res = await request(createTestApp(admin)).put(URL(orgId)).send({
      faviconUrl: path,
    });
    expect(res.status).toBe(200);
    expect(res.body.faviconUrl).toBe(path);
  });

  it("rejects an /objects/... path whose content-type is not allow-listed", async () => {
    const path = "/objects/uploads/bad-html";
    mockState.objects.set(path, { contentType: "text/html", size: 1_000 });

    const res = await request(createTestApp(admin)).put(URL(orgId)).send({
      logoImageUrl: path,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/logoImageUrl/);
    expect(res.body.error).toMatch(/unsupported image type/i);
  });

  it("rejects an /objects/... path whose content-type metadata is missing", async () => {
    const path = "/objects/uploads/missing-ct";
    mockState.objects.set(path, { contentType: undefined, size: 1_000 });

    const res = await request(createTestApp(admin)).put(URL(orgId)).send({
      faviconUrl: path,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/faviconUrl/);
    expect(res.body.error).toMatch(/unsupported image type/i);
  });

  it("rejects an /objects/... path larger than the 1 MB marketing-image cap (Task #1468)", async () => {
    const path = "/objects/uploads/oversize";
    mockState.objects.set(path, { contentType: "image/png", size: 2 * 1024 * 1024 });

    const res = await request(createTestApp(admin)).put(URL(orgId)).send({
      logoImageUrl: path,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/logoImageUrl/);
    expect(res.body.error).toMatch(/1 MB/);
    expect(res.body.error).toMatch(/marketing logos and favicons/i);
  });

  it("accepts an /objects/... path comfortably under the 1 MB marketing-image cap (Task #1468)", async () => {
    const path = "/objects/uploads/under-cap";
    mockState.objects.set(path, { contentType: "image/png", size: 256 * 1024 });

    const res = await request(createTestApp(admin)).put(URL(orgId)).send({
      faviconUrl: path,
    });
    expect(res.status).toBe(200);
    expect(res.body.faviconUrl).toBe(path);
  });
});
