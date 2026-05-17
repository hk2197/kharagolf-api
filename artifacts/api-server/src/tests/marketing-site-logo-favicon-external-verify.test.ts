/**
 * Task #1089 — Stop external logo and favicon URLs from blocking the
 * page if the host is slow or down.
 *
 * The PUT /api/organizations/:orgId/marketing-site handler now calls
 * `verifyExternalImageUrl` for any http(s) URL passed for
 * `logoImageUrl` / `faviconUrl`. The verifier confirms the host is
 * reachable, returns an HTTP 2xx with an image content-type, and
 * keeps the body within the 10 MB cap. We exercise that wiring here
 * by installing a deterministic stub via the test override hook.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-marketing-logo-verify";

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
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
  __setExternalImageVerifierForTests,
  type ExternalImageVerifyResult,
} from "../lib/externalImageVerifier.js";

let orgId: number;
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

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const slug = `mkt-extverify-${stamp}`.toLowerCase();
  const [org] = await db.insert(organizationsTable).values({
    name: `MktExtVerify_${stamp}`,
    slug,
    isActive: true,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  admin = await makeUser(orgId, "org_admin");
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

afterEach(() => {
  __setExternalImageVerifierForTests(null);
});

describe("PUT /marketing-site — external logo/favicon reachability check (Task #1089)", () => {
  it("rejects logoImageUrl when the external host times out / is unreachable", async () => {
    __setExternalImageVerifierForTests(async (): Promise<ExternalImageVerifyResult> => ({
      ok: false,
      error: "image host did not respond within 8s",
    }));
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "https://slow.example.com/logo.png",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/logoImageUrl/);
    expect(res.body.error).toMatch(/did not respond/);
  });

  it("rejects faviconUrl when the host returns a non-image content-type", async () => {
    __setExternalImageVerifierForTests(async () => ({
      ok: false,
      error: 'unsupported image content-type "text/html"',
    }));
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      faviconUrl: "https://broken.example.com/not-really-an-image",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/faviconUrl/);
    expect(res.body.error).toMatch(/content-type/);
  });

  it("rejects logoImageUrl when the host responds with a non-2xx status", async () => {
    __setExternalImageVerifierForTests(async () => ({
      ok: false,
      error: "image host returned HTTP 404",
    }));
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "https://cdn.example.com/missing.png",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/HTTP 404/);
  });

  it("rejects logoImageUrl when the body exceeds the 10 MB cap", async () => {
    __setExternalImageVerifierForTests(async () => ({
      ok: false,
      error: "image exceeds the 10 MB maximum size",
    }));
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "https://huge.example.com/giant.png",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/10 MB/);
  });

  it("rejects logoImageUrl when the host resolves to a private/internal address", async () => {
    __setExternalImageVerifierForTests(async () => ({
      ok: false,
      error: "host resolves to a non-publicly-routable address",
    }));
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "http://internal.local/logo.png",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-publicly-routable/);
  });

  it("persists the URL when the verifier reports the host is serving a real image", async () => {
    __setExternalImageVerifierForTests(async () => ({ ok: true }));
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "https://cdn.example.com/verified-logo.png",
      faviconUrl: "https://cdn.example.com/verified-favicon.ico",
    });
    expect(res.status).toBe(200);
    expect(res.body.logoImageUrl).toBe("https://cdn.example.com/verified-logo.png");
    expect(res.body.faviconUrl).toBe("https://cdn.example.com/verified-favicon.ico");
  });

  it("does not call the verifier for /objects/ internal paths", async () => {
    let called = false;
    __setExternalImageVerifierForTests(async () => {
      called = true;
      return { ok: true };
    });
    const app = createTestApp(admin);
    // The internal-object branch validates against ObjectStorageService
    // and will 400 because the path doesn't exist — what we care about
    // here is that the external verifier was never consulted.
    const res = await request(app).put(URL(orgId)).send({
      logoImageUrl: "/objects/uploads/never-checked-by-external-verifier",
    });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});

describe("verifyExternalImageUrl — real network probe (Task #1089)", () => {
  it("rejects URLs that resolve to loopback / private hosts via the SSRF guard", async () => {
    // Bypass the test-mode short-circuit by exercising realVerify
    // directly through the public entry point with the override
    // cleared. 127.0.0.1 / localhost will resolve to the loopback
    // address and must be rejected before any TCP connection.
    __setExternalImageVerifierForTests(null);
    const { verifyExternalImageUrl } = await import("../lib/externalImageVerifier.js");
    // Re-import is a no-op in the test branch; we call realVerify by
    // temporarily flipping NODE_ENV around the call.
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const result = await verifyExternalImageUrl("http://127.0.0.1:1/logo.png");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/non-publicly-routable|did not resolve/);
      }
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("rejects non-http(s) protocols", async () => {
    __setExternalImageVerifierForTests(null);
    const { verifyExternalImageUrl } = await import("../lib/externalImageVerifier.js");
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const result = await verifyExternalImageUrl("ftp://example.com/logo.png");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/http/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
