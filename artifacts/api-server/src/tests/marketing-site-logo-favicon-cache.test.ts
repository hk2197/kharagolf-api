/**
 * Task #1250 — Cache external logos and favicons in our own object
 * storage so visitor pages don't depend on third-party hosts.
 *
 * The PUT /api/organizations/:orgId/marketing-site handler must, for
 * any http(s) `logoImageUrl` / `faviconUrl`:
 *   - Hand the verifier-captured bytes to ObjectStorageService so the
 *     image is rehosted under `marketing-cache/<orgId>/...`.
 *   - Mark the rehosted object as publicly visible (the same ACL that
 *     the existing /storage/objects/... route checks for unauth
 *     visitors).
 *   - Persist the internal `/api/storage/objects/...` URL to the DB
 *     instead of the original third-party URL, so the public mini-site
 *     never issues a request to the third-party host.
 *
 * `ObjectStorageService` is mocked so we can capture the saved bytes
 * and ACL policy without touching real GCS, and the external image
 * verifier is stubbed to return a tiny PNG buffer for any URL.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-marketing-logo-favicon-cache";
process.env.PRIVATE_OBJECT_DIR ||= "/test-bucket/private-marketing-cache";
process.env.API_PUBLIC_URL ||= "https://api.kharagolf.test";

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

const { mockState } = vi.hoisted(() => ({
  mockState: {
    saved: [] as Array<{ relativePath: string; buffer: Buffer; contentType: string }>,
    aclSet: [] as Array<{ rawPath: string; visibility: string; owner: string }>,
  },
}));

vi.mock("../lib/objectStorage.js", () => ({
  objectStorageClient: { bucket: () => ({ file: () => ({}) }) },
  ObjectStorageService: class {
    async saveRawBuffer(relativePath: string, buffer: Buffer, contentType: string): Promise<string> {
      mockState.saved.push({ relativePath, buffer, contentType });
      return `/objects/${relativePath}`;
    }
    async trySetObjectEntityAclPolicy(rawPath: string, policy: { owner: string; visibility: string }): Promise<string> {
      mockState.aclSet.push({ rawPath, visibility: policy.visibility, owner: policy.owner });
      return rawPath;
    }
    async getObjectEntityFile(): Promise<unknown> {
      throw new Error("not used in this test");
    }
    async getObjectEntityUploadURL(): Promise<string> {
      return "https://storage.googleapis.com/test-bucket/private-marketing-cache/uploads/x";
    }
    normalizeObjectEntityPath(uploadURL: string): string {
      const id = uploadURL.split("/").pop();
      return `/objects/uploads/${id}`;
    }
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
import {
  __setExternalImageVerifierForTests,
  type ExternalImageVerifyResult,
} from "../lib/externalImageVerifier.js";

let orgId: number;
let admin: TestUser;
const createdUserIds: number[] = [];
const URL = (id: number) => `/api/organizations/${id}/marketing-site`;

// 1×1 transparent PNG — small but non-empty, real image bytes.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const slug = `mkt-cache-${stamp}`.toLowerCase();
  const [org] = await db.insert(organizationsTable).values({
    name: `MktCache_${stamp}`,
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

  await db.insert(clubMarketingSitesTable).values({ organizationId: orgId });
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

beforeEach(() => {
  mockState.saved.length = 0;
  mockState.aclSet.length = 0;
});

afterEach(() => {
  __setExternalImageVerifierForTests(null);
});

describe("PUT /marketing-site — caps cached marketing image size (Task #1468)", () => {
  it("forwards the 1 MB marketing cap to the external image verifier", async () => {
    const seenOptions: Array<unknown> = [];
    __setExternalImageVerifierForTests(async (_url, options): Promise<ExternalImageVerifyResult> => {
      seenOptions.push(options);
      return { ok: true, buffer: PNG_BYTES, contentType: "image/png" };
    });

    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "https://cdn.example.com/cap-check.png",
    });
    expect(res.status).toBe(200);

    expect(seenOptions).toHaveLength(1);
    const opts = seenOptions[0] as { maxBytes?: number } | undefined;
    expect(opts?.maxBytes).toBe(1 * 1024 * 1024);
  });

  it("returns a clear admin error when the verifier reports the body exceeds the 1 MB marketing cap", async () => {
    __setExternalImageVerifierForTests(async (): Promise<ExternalImageVerifyResult> => ({
      ok: false,
      error: "image exceeds the 1 MB maximum size",
    }));

    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "https://cdn.example.com/oversize-logo.png",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/logoImageUrl/);
    expect(res.body.error).toMatch(/1 MB/);
    // The reject must short-circuit before any rehost happens — no
    // bytes should land in object storage if the verifier said no.
    expect(mockState.saved).toHaveLength(0);
    expect(mockState.aclSet).toHaveLength(0);
  });
});

describe("PUT /marketing-site — rehosts external logo/favicon bytes (Task #1250)", () => {
  it("rehosts logoImageUrl bytes into marketing-cache/<orgId>/logo-* and persists the internal URL", async () => {
    __setExternalImageVerifierForTests(async (): Promise<ExternalImageVerifyResult> => ({
      ok: true,
      buffer: PNG_BYTES,
      contentType: "image/png",
    }));

    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "https://cdn.example.com/club-logo.png",
    });
    expect(res.status).toBe(200);

    // Bytes were saved exactly once, under marketing-cache/<orgId>/logo-...
    expect(mockState.saved).toHaveLength(1);
    expect(mockState.saved[0].contentType).toBe("image/png");
    expect(mockState.saved[0].buffer.equals(PNG_BYTES)).toBe(true);
    expect(mockState.saved[0].relativePath).toMatch(
      new RegExp(`^marketing-cache/${orgId}/logo-[0-9a-f]+\\.png$`),
    );

    // Saved object was marked publicly readable (so the storage GET
    // route serves it without an authenticated session).
    expect(mockState.aclSet).toHaveLength(1);
    expect(mockState.aclSet[0].visibility).toBe("public");
    expect(mockState.aclSet[0].owner).toBe(`org:${orgId}`);
    expect(mockState.aclSet[0].rawPath).toBe(`/objects/${mockState.saved[0].relativePath}`);

    // The persisted URL must point at our own API server, not the
    // original third-party host.
    expect(res.body.logoImageUrl).toMatch(
      new RegExp(`^https://api\\.kharagolf\\.test/api/storage/objects/marketing-cache/${orgId}/logo-[0-9a-f]+\\.png$`),
    );
    expect(res.body.logoImageUrl).not.toContain("cdn.example.com");

    const row = await db.query.clubMarketingSitesTable.findFirst({
      where: eq(clubMarketingSitesTable.organizationId, orgId),
    });
    expect(row?.logoImageUrl).toBe(res.body.logoImageUrl);
  });

  it("rehosts faviconUrl bytes into marketing-cache/<orgId>/favicon-* and uses the right extension for ICO", async () => {
    const ICO_BYTES = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);
    __setExternalImageVerifierForTests(async () => ({
      ok: true,
      buffer: ICO_BYTES,
      contentType: "image/x-icon",
    }));

    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      faviconUrl: "https://cdn.example.com/club-favicon.ico",
    });
    expect(res.status).toBe(200);

    expect(mockState.saved).toHaveLength(1);
    expect(mockState.saved[0].contentType).toBe("image/x-icon");
    expect(mockState.saved[0].relativePath).toMatch(
      new RegExp(`^marketing-cache/${orgId}/favicon-[0-9a-f]+\\.ico$`),
    );
    expect(res.body.faviconUrl).toMatch(/\/api\/storage\/objects\/marketing-cache\//);
    expect(res.body.faviconUrl).not.toContain("cdn.example.com");
  });

  it("collapses identical bytes to a single object across re-saves (content-hashed key)", async () => {
    __setExternalImageVerifierForTests(async () => ({
      ok: true,
      buffer: PNG_BYTES,
      contentType: "image/png",
    }));

    const app = createTestApp(admin);
    await request(app).put(URL(orgId)).send({
      logoImageUrl: "https://cdn1.example.com/logo.png",
    });
    await request(app).put(URL(orgId)).send({
      logoImageUrl: "https://cdn2.example.com/another.png",
    });

    // Both saves landed at the same storage key — the content hash
    // is identical so we don't accumulate duplicates.
    expect(mockState.saved).toHaveLength(2);
    expect(mockState.saved[0].relativePath).toBe(mockState.saved[1].relativePath);
  });

  it("does not rehost when the value is null (clearing the override)", async () => {
    __setExternalImageVerifierForTests(async () => ({
      ok: true,
      buffer: PNG_BYTES,
      contentType: "image/png",
    }));

    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: null,
      faviconUrl: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.logoImageUrl).toBeNull();
    expect(res.body.faviconUrl).toBeNull();
    expect(mockState.saved).toHaveLength(0);
    expect(mockState.aclSet).toHaveLength(0);
  });

  it("does not rehost when the value is an internal /objects/... path", async () => {
    let verifierCalled = false;
    __setExternalImageVerifierForTests(async () => {
      verifierCalled = true;
      return { ok: true, buffer: PNG_BYTES, contentType: "image/png" };
    });
    const app = createTestApp(admin);
    // /objects/... validation goes through getObjectEntityFile which is
    // stubbed to throw — we only care here that we never fell through
    // to the verifier or to saveRawBuffer.
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "/objects/uploads/already-internal",
    });
    expect(res.status).toBe(400);
    expect(verifierCalled).toBe(false);
    expect(mockState.saved).toHaveLength(0);
  });

  it("returns 400 and skips persistence when storage save fails", async () => {
    // Override the save behaviour just for this test by appending an
    // entry to mockState that throws.
    const realSave = (await import("../lib/objectStorage.js")).ObjectStorageService.prototype.saveRawBuffer;
    (await import("../lib/objectStorage.js")).ObjectStorageService.prototype.saveRawBuffer =
      async function() { throw new Error("simulated GCS outage"); };

    __setExternalImageVerifierForTests(async () => ({
      ok: true,
      buffer: PNG_BYTES,
      contentType: "image/png",
    }));

    try {
      const app = createTestApp(admin);
      const res = await request(app).put(URL(orgId)).send({
        logoImageUrl: "https://cdn.example.com/storage-broken.png",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/logoImageUrl/);
      expect(res.body.error).toMatch(/cache image to storage/);
    } finally {
      (await import("../lib/objectStorage.js")).ObjectStorageService.prototype.saveRawBuffer = realSave;
    }
  });
});
