/**
 * Task #816 — Coverage for the marketing-site logo + favicon overrides
 * added in Task #666.
 *
 * Validates that:
 *   - PUT /api/organizations/:orgId/marketing-site accepts and persists
 *     logoImageUrl + faviconUrl.
 *   - Explicit null and "" reset the columns back to NULL.
 *   - A patch that omits the fields leaves the previously stored values
 *     untouched.
 *   - The public mini-site payload (both /clubs/:slug/site and
 *     /clubs/by-host/site) returns logoImageUrl + faviconUrl on the
 *     `site` object so the SPA can render them.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-marketing-logo-favicon";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMarketingSitesTable,
  orgRoleEnum,
} from "@workspace/db";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgId: number;
let orgSlug: string;
let customDomain: string;
let admin: TestUser;
const createdUserIds: number[] = [];

const URL = (id: number) => `/api/organizations/${id}/marketing-site`;

async function makeUser(orgIdArg: number, role: OrgRole): Promise<TestUser> {
  const tag = uid(role);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@example.com`,
    displayName: tag,
    role,
    organizationId: orgIdArg,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return { id: u.id, username: tag, displayName: tag, role, organizationId: orgIdArg };
}

async function loadSite() {
  return db.query.clubMarketingSitesTable.findFirst({
    where: eq(clubMarketingSitesTable.organizationId, orgId),
  });
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  orgSlug = `mkt-logofav-${stamp}`.toLowerCase();
  customDomain = `${orgSlug}.example.com`;
  const [org] = await db.insert(organizationsTable).values({
    name: `MktLogoFav_${stamp}`,
    slug: orgSlug,
    customDomain,
    isActive: true,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  admin = await makeUser(orgId, "org_admin");

  // Seed a published mini-site row so the public endpoints will respond.
  await db.insert(clubMarketingSitesTable).values({
    organizationId: orgId,
    isPublished: true,
    publishedAt: new Date(),
  });
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

describe("PUT /marketing-site — logo + favicon overrides (Task #666)", () => {
  it("persists logoImageUrl + faviconUrl when provided", async () => {
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "https://cdn.example.com/club-logo.png",
      faviconUrl: "https://cdn.example.com/club-favicon.ico",
    });
    expect(res.status).toBe(200);
    expect(res.body.logoImageUrl).toBe("https://cdn.example.com/club-logo.png");
    expect(res.body.faviconUrl).toBe("https://cdn.example.com/club-favicon.ico");

    const row = await loadSite();
    expect(row?.logoImageUrl).toBe("https://cdn.example.com/club-logo.png");
    expect(row?.faviconUrl).toBe("https://cdn.example.com/club-favicon.ico");
  });

  it("treats explicit null as a reset back to NULL", async () => {
    {
      const app = createTestApp(admin);
      await request(app).put(URL(orgId)).send({
        logoImageUrl: "https://cdn.example.com/seed-logo.png",
        faviconUrl: "https://cdn.example.com/seed-favicon.ico",
      });
    }
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: null,
      faviconUrl: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.logoImageUrl).toBeNull();
    expect(res.body.faviconUrl).toBeNull();

    const row = await loadSite();
    expect(row?.logoImageUrl).toBeNull();
    expect(row?.faviconUrl).toBeNull();
  });

  it("treats empty string as a reset back to NULL", async () => {
    {
      const app = createTestApp(admin);
      await request(app).put(URL(orgId)).send({
        logoImageUrl: "https://cdn.example.com/seed-logo-2.png",
        faviconUrl: "https://cdn.example.com/seed-favicon-2.ico",
      });
    }
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "",
      faviconUrl: "",
    });
    expect(res.status).toBe(200);
    expect(res.body.logoImageUrl).toBeNull();
    expect(res.body.faviconUrl).toBeNull();

    const row = await loadSite();
    expect(row?.logoImageUrl).toBeNull();
    expect(row?.faviconUrl).toBeNull();
  });

  it("rejects logoImageUrl that is not a well-formed http(s) URL (Task #948)", async () => {
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "not a url at all",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/logoImageUrl/);
  });

  it("rejects faviconUrl with a non-http protocol (Task #948)", async () => {
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      faviconUrl: "javascript:alert(1)",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/faviconUrl/);
  });

  it("rejects logoImageUrl that points at a non-existent /objects/ path (Task #948)", async () => {
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "/objects/uploads/does-not-exist-9999",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/logoImageUrl/);
  });

  it("rejects logoImageUrl that is not a string (Task #948)", async () => {
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: 12345,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/logoImageUrl/);
  });

  it("leaves logoImageUrl + faviconUrl untouched when the patch omits them", async () => {
    {
      const app = createTestApp(admin);
      await request(app).put(URL(orgId)).send({
        logoImageUrl: "https://cdn.example.com/keep-logo.png",
        faviconUrl: "https://cdn.example.com/keep-favicon.ico",
      });
    }
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({ heroTitle: "Hi" });
    expect(res.status).toBe(200);
    expect(res.body.logoImageUrl).toBe("https://cdn.example.com/keep-logo.png");
    expect(res.body.faviconUrl).toBe("https://cdn.example.com/keep-favicon.ico");
  });
});

describe("Public mini-site payload includes logoImageUrl + faviconUrl (Task #666)", () => {
  it("returns logoImageUrl + faviconUrl from GET /api/public/clubs/:slug/site", async () => {
    {
      const app = createTestApp(admin);
      await request(app).put(URL(orgId)).send({
        logoImageUrl: "https://cdn.example.com/public-logo.png",
        faviconUrl: "https://cdn.example.com/public-favicon.ico",
      });
    }
    const app = createTestApp();
    const res = await request(app).get(`/api/public/clubs/${orgSlug}/site`);
    expect(res.status).toBe(200);
    expect(res.body.site).toBeDefined();
    expect(res.body.site.logoImageUrl).toBe("https://cdn.example.com/public-logo.png");
    expect(res.body.site.faviconUrl).toBe("https://cdn.example.com/public-favicon.ico");
  });

  it("returns logoImageUrl + faviconUrl from GET /api/public/clubs/by-host/site", async () => {
    // Seed values inside this test so it doesn't depend on earlier-test state.
    {
      const app = createTestApp(admin);
      await request(app).put(URL(orgId)).send({
        logoImageUrl: "https://cdn.example.com/by-host-logo.png",
        faviconUrl: "https://cdn.example.com/by-host-favicon.ico",
      });
    }
    const app = createTestApp();
    const res = await request(app)
      .get("/api/public/clubs/by-host/site")
      .set("Host", customDomain);
    expect(res.status).toBe(200);
    expect(res.body.site.logoImageUrl).toBe("https://cdn.example.com/by-host-logo.png");
    expect(res.body.site.faviconUrl).toBe("https://cdn.example.com/by-host-favicon.ico");
  });

  it("returns null logoImageUrl + faviconUrl when the admin clears them", async () => {
    {
      const app = createTestApp(admin);
      await request(app).put(URL(orgId)).send({
        logoImageUrl: null,
        faviconUrl: null,
      });
    }
    const app = createTestApp();
    const res = await request(app).get(`/api/public/clubs/${orgSlug}/site`);
    expect(res.status).toBe(200);
    expect(res.body.site.logoImageUrl).toBeNull();
    expect(res.body.site.faviconUrl).toBeNull();
  });
});
