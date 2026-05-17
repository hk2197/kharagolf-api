/**
 * Task #437 / #583 — Coverage for the marketing-site preview-token flow.
 *
 *   - POST /api/organizations/:orgId/marketing-site/preview-token
 *       401 unauthenticated, 403 non-admin, 403 cross-org, success path
 *   - GET  /api/public/clubs/:slug/site?preview=<token>
 *       returns the unpublished draft when the token is valid + bound to
 *       the same org, ignores expired/forged/wrong-org tokens (404),
 *       responds with `Cache-Control: private, no-store`.
 *
 * Uses the real test DB. SESSION_SECRET is set before any module that
 * reads it at import time is loaded, so token signing is deterministic.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-marketing-preview";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
import {
  issueMarketingPreviewToken,
  MARKETING_PREVIEW_TOKEN_TTL_MS,
} from "../lib/marketing-preview-token.js";

let orgAId: number;
let orgBId: number;
let orgASlug: string;
let orgBSlug: string;
let admin: TestUser;
let outsider: TestUser;
let crossOrgAdmin: TestUser;
let superAdmin: TestUser;
const createdUserIds: number[] = [];

const TOKEN_URL = (orgId: number) =>
  `/api/organizations/${orgId}/marketing-site/preview-token`;
const PUBLIC_URL = (slug: string, q: string = "") =>
  `/api/public/clubs/${slug}/site${q}`;

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

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  orgASlug = `mkt-preview-a-${stamp}`.toLowerCase();
  orgBSlug = `mkt-preview-b-${stamp}`.toLowerCase();

  const [orgA] = await db.insert(organizationsTable).values({
    name: `MktPreviewA_${stamp}`,
    slug: orgASlug,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `MktPreviewB_${stamp}`,
    slug: orgBSlug,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  admin = await makeUser(orgAId, "org_admin");
  outsider = await makeUser(orgAId, "player");
  crossOrgAdmin = await makeUser(orgBId, "org_admin");
  superAdmin = await makeUser(null, "super_admin");
});

afterAll(async () => {
  await db.delete(clubMarketingSitesTable).where(
    inArray(clubMarketingSitesTable.organizationId, [orgAId, orgBId]),
  );
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  await db.delete(organizationsTable).where(
    inArray(organizationsTable.id, [orgAId, orgBId]),
  );
});

describe("POST /marketing-site/preview-token — auth", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).post(TOKEN_URL(orgAId));
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not a site admin (player role)", async () => {
    const app = createTestApp(outsider);
    const res = await request(app).post(TOKEN_URL(orgAId));
    expect(res.status).toBe(403);
  });

  it("returns 403 when an org admin tries to issue a token for another org", async () => {
    const app = createTestApp(crossOrgAdmin);
    const res = await request(app).post(TOKEN_URL(orgAId));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/org/i);
  });

  it("returns a token + ttl for the org's own admin and creates a draft row", async () => {
    // Make sure no draft row exists yet so we exercise the auto-create path.
    await db.delete(clubMarketingSitesTable).where(
      eq(clubMarketingSitesTable.organizationId, orgAId),
    );

    const app = createTestApp(admin);
    const res = await request(app).post(TOKEN_URL(orgAId));
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.length).toBeGreaterThan(20);
    expect(res.body.token).toContain(".");
    expect(res.body.expiresInMs).toBe(MARKETING_PREVIEW_TOKEN_TTL_MS);

    const draft = await db.query.clubMarketingSitesTable.findFirst({
      where: eq(clubMarketingSitesTable.organizationId, orgAId),
    });
    expect(draft).toBeTruthy();
    expect(draft!.isPublished).toBe(false);
  });

  it("super_admin may issue a token for any org", async () => {
    const app = createTestApp(superAdmin);
    const res = await request(app).post(TOKEN_URL(orgBId));
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
  });
});

describe("GET /public/clubs/:slug/site?preview=<token>", () => {
  beforeAll(async () => {
    // Ensure both orgs have an *unpublished* draft with distinctive copy
    // we can assert against in the preview response.
    for (const [id, label] of [[orgAId, "A"], [orgBId, "B"]] as const) {
      const existing = await db.query.clubMarketingSitesTable.findFirst({
        where: eq(clubMarketingSitesTable.organizationId, id),
      });
      const values = {
        organizationId: id,
        heroTitle: `Draft Hero ${label}`,
        heroSubtitle: `Draft subtitle ${label}`,
        isPublished: false,
        publishedAt: null,
      };
      if (existing) {
        await db.update(clubMarketingSitesTable)
          .set({ heroTitle: values.heroTitle, heroSubtitle: values.heroSubtitle, isPublished: false, publishedAt: null })
          .where(eq(clubMarketingSitesTable.organizationId, id));
      } else {
        await db.insert(clubMarketingSitesTable).values(values);
      }
    }
  });

  it("returns 404 with no preview token when the site is unpublished", async () => {
    const app = createTestApp();
    const res = await request(app).get(PUBLIC_URL(orgASlug));
    expect(res.status).toBe(404);
  });

  it("serves the unpublished draft when a valid token is supplied", async () => {
    const app = createTestApp();
    const token = issueMarketingPreviewToken(orgAId);
    const res = await request(app).get(
      PUBLIC_URL(orgASlug, `?preview=${encodeURIComponent(token)}`),
    );
    expect(res.status).toBe(200);
    expect(res.body.organization?.slug).toBe(orgASlug);
    expect(res.body.site?.heroTitle).toBe("Draft Hero A");
    // Preview responses must never be cached by shared caches/browsers.
    expect(String(res.headers["cache-control"]).toLowerCase()).toContain("no-store");
    expect(String(res.headers["cache-control"]).toLowerCase()).toContain("private");
  });

  it("ignores a token bound to a different org (cross-org leak protection)", async () => {
    const app = createTestApp();
    const tokenForB = issueMarketingPreviewToken(orgBId);
    const res = await request(app).get(
      PUBLIC_URL(orgASlug, `?preview=${encodeURIComponent(tokenForB)}`),
    );
    // Site A is unpublished and the token is for a *different* org, so the
    // public route falls back to the "not published" 404.
    expect(res.status).toBe(404);
  });

  it("ignores a forged / tampered token and returns 404", async () => {
    const app = createTestApp();
    const real = issueMarketingPreviewToken(orgAId);
    const [payload] = real.split(".");
    const forged = `${payload}.deadbeefdeadbeef`;
    const res = await request(app).get(
      PUBLIC_URL(orgASlug, `?preview=${encodeURIComponent(forged)}`),
    );
    expect(res.status).toBe(404);
  });

  it("ignores an expired token and returns 404", async () => {
    const app = createTestApp();
    // Issue a token "in the past" by stubbing Date.now during signing.
    const realNow = Date.now;
    try {
      vi.spyOn(Date, "now").mockReturnValue(
        realNow() - MARKETING_PREVIEW_TOKEN_TTL_MS - 60_000,
      );
      const expired = issueMarketingPreviewToken(orgAId);
      vi.restoreAllMocks();
      const res = await request(app).get(
        PUBLIC_URL(orgASlug, `?preview=${encodeURIComponent(expired)}`),
      );
      expect(res.status).toBe(404);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not require a token once the site is published, and skips no-store", async () => {
    await db.update(clubMarketingSitesTable)
      .set({ isPublished: true, publishedAt: new Date() })
      .where(eq(clubMarketingSitesTable.organizationId, orgAId));
    try {
      const app = createTestApp();
      const res = await request(app).get(PUBLIC_URL(orgASlug));
      expect(res.status).toBe(200);
      expect(res.body.site?.heroTitle).toBe("Draft Hero A");
      expect(String(res.headers["cache-control"]).toLowerCase()).not.toContain("no-store");
    } finally {
      await db.update(clubMarketingSitesTable)
        .set({ isPublished: false, publishedAt: null })
        .where(eq(clubMarketingSitesTable.organizationId, orgAId));
    }
  });
});
