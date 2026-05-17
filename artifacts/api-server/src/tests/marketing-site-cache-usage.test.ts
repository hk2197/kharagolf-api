/**
 * Task #1799 — Surface per-org marketing-cache storage usage in the
 * marketing-site admin endpoint.
 *
 * GET  /api/organizations/:orgId/marketing-site
 *   → response includes `marketingCacheUsage: { totalBytes, objectCount }`
 *     summed from objects under `marketing-cache/<orgId>/`.
 * PUT  /api/organizations/:orgId/marketing-site
 *   → response includes the refreshed `marketingCacheUsage` so the admin
 *     UI can update its "X KB used" hint without an extra round-trip.
 *
 * Also covers the best-effort fallback: if the storage backend throws
 * (e.g. sidecar briefly unreachable) the route returns
 * `marketingCacheUsage: null` instead of erroring out the whole load.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-marketing-cache-usage";
process.env.PRIVATE_OBJECT_DIR ||= "/test-bucket/private-marketing-cache-usage";
process.env.API_PUBLIC_URL ||= "https://api.kharagolf.test";

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { mockState } = vi.hoisted(() => ({
  mockState: {
    usageByPrefix: {} as Record<string, { totalBytes: number; objectCount: number }>,
    throwOnUsage: false as boolean | string,
    usageCalls: [] as string[],
  },
}));

vi.mock("../lib/objectStorage.js", () => ({
  objectStorageClient: { bucket: () => ({ file: () => ({}) }) },
  ObjectStorageService: class {
    async getStorageUsageByPrefix(
      relativePath: string,
    ): Promise<{ totalBytes: number; objectCount: number }> {
      mockState.usageCalls.push(relativePath);
      if (mockState.throwOnUsage) {
        throw new Error(
          typeof mockState.throwOnUsage === "string"
            ? mockState.throwOnUsage
            : "simulated GCS outage",
        );
      }
      return mockState.usageByPrefix[relativePath] ?? { totalBytes: 0, objectCount: 0 };
    }
    async saveRawBuffer(): Promise<string> {
      throw new Error("not used in this test");
    }
    async trySetObjectEntityAclPolicy(rawPath: string): Promise<string> {
      return rawPath;
    }
    async getObjectEntityFile(): Promise<unknown> {
      throw new Error("not used in this test");
    }
    async getObjectEntityUploadURL(): Promise<string> {
      return "https://storage.googleapis.com/test-bucket/private-marketing-cache-usage/uploads/x";
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

let orgId: number;
let admin: TestUser;
const createdUserIds: number[] = [];
const URL = (id: number) => `/api/organizations/${id}/marketing-site`;

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const slug = `mkt-usage-${stamp}`.toLowerCase();
  const [org] = await db.insert(organizationsTable).values({
    name: `MktUsage_${stamp}`,
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
  mockState.usageByPrefix = {};
  mockState.throwOnUsage = false;
  mockState.usageCalls.length = 0;
});

describe("GET /marketing-site — surfaces marketing-cache storage usage (Task #1799)", () => {
  it("returns marketingCacheUsage summed from marketing-cache/<orgId>/", async () => {
    mockState.usageByPrefix[`marketing-cache/${orgId}/`] = {
      totalBytes: 12_345,
      objectCount: 3,
    };

    const app = createTestApp(admin);
    const res = await request(app).get(URL(orgId));

    expect(res.status).toBe(200);
    expect(res.body.marketingCacheUsage).toEqual({
      totalBytes: 12_345,
      objectCount: 3,
    });
    // Helper was scoped to this org's prefix — not a global lookup.
    expect(mockState.usageCalls).toEqual([`marketing-cache/${orgId}/`]);
  });

  it("returns marketingCacheUsage with zeros for an org that has nothing cached", async () => {
    const app = createTestApp(admin);
    const res = await request(app).get(URL(orgId));

    expect(res.status).toBe(200);
    expect(res.body.marketingCacheUsage).toEqual({ totalBytes: 0, objectCount: 0 });
  });

  it("falls back to marketingCacheUsage: null when the storage backend errors", async () => {
    mockState.throwOnUsage = "sidecar unreachable";

    const app = createTestApp(admin);
    const res = await request(app).get(URL(orgId));

    // The whole admin page must still load — usage is best-effort.
    expect(res.status).toBe(200);
    expect(res.body.marketingCacheUsage).toBeNull();
    // The rest of the site row is still present.
    expect(typeof res.body.id).toBe("number");
  });
});

describe("PUT /marketing-site — refreshes marketingCacheUsage in the response (Task #1799)", () => {
  it("includes the post-save marketingCacheUsage so the UI hint updates without a refetch", async () => {
    mockState.usageByPrefix[`marketing-cache/${orgId}/`] = {
      totalBytes: 4_096,
      objectCount: 2,
    };

    const app = createTestApp(admin);
    // Touch a harmless field so the PUT validates and persists.
    const res = await request(app).put(URL(orgId)).send({ heroTitle: "Welcome" });

    expect(res.status).toBe(200);
    expect(res.body.marketingCacheUsage).toEqual({
      totalBytes: 4_096,
      objectCount: 2,
    });
  });
});
