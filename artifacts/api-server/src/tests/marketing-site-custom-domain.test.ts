/**
 * Task #661 — Coverage for the custom-domain admin endpoint:
 *
 *   PATCH /api/organizations/:orgId/marketing-site/custom-domain
 *
 * Locks in:
 *   - Hostname normalisation (lowercasing, stripping protocol/port/path)
 *   - Invalid input rejection (400)
 *   - Cross-org duplicate detection (409)
 *   - Plan-flag gating (402 when the org's plan does not include `customDomain`)
 *   - Auth gating (401 unauthenticated, 403 wrong role / wrong org)
 *   - Cache-version bump on the marketing-site row
 *   - Clearing the domain (null / empty string) wipes the value
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-marketing-custom-domain";
process.env.PRIVATE_OBJECT_DIR ||= "/test-bucket/private";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

let entOrgId: number;     // enterprise tier — plan flag enabled
let freeOrgId: number;    // free tier — plan flag disabled
let otherEntOrgId: number; // enterprise — used to seed a colliding domain

let entAdmin: TestUser;
let freeAdmin: TestUser;
let player: TestUser;
let crossOrgAdmin: TestUser;
let superAdmin: TestUser;

const createdUserIds: number[] = [];
const createdOrgIds: number[] = [];

const URL_FOR = (orgId: number) =>
  `/api/organizations/${orgId}/marketing-site/custom-domain`;

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

async function makeOrg(opts: {
  tier: "free" | "starter" | "pro" | "enterprise";
  customDomain?: string | null;
}): Promise<number> {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [o] = await db.insert(organizationsTable).values({
    name: `CustDom_${opts.tier}_${stamp}`,
    slug: `custdom-${opts.tier}-${stamp}`.toLowerCase(),
    subscriptionTier: opts.tier,
    customDomain: opts.customDomain ?? null,
    isActive: true,
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return o.id;
}

beforeAll(async () => {
  entOrgId = await makeOrg({ tier: "enterprise" });
  freeOrgId = await makeOrg({ tier: "free" });
  otherEntOrgId = await makeOrg({
    tier: "enterprise",
    customDomain: `taken-${Date.now()}.example.com`,
  });

  entAdmin = await makeUser(entOrgId, "org_admin");
  freeAdmin = await makeUser(freeOrgId, "org_admin");
  player = await makeUser(entOrgId, "player");
  crossOrgAdmin = await makeUser(otherEntOrgId, "org_admin");
  superAdmin = await makeUser(null, "super_admin");
});

afterAll(async () => {
  await db.delete(clubMarketingSitesTable)
    .where(inArray(clubMarketingSitesTable.organizationId, createdOrgIds));
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable)
      .where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(async () => {
  // Reset the enterprise org's domain to null between tests so each one
  // starts from a clean slate (apart from the deliberately-seeded
  // collision on otherEntOrgId).
  await db.update(organizationsTable)
    .set({ customDomain: null })
    .where(eq(organizationsTable.id, entOrgId));
});

describe("PATCH /marketing-site/custom-domain — auth", () => {
  it("401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: "golf.club.com" });
    expect(res.status).toBe(401);
  });

  it("403 for non-admin role (player)", async () => {
    const app = createTestApp(player);
    const res = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: "golf.club.com" });
    expect(res.status).toBe(403);
  });

  it("403 when an org admin targets another org", async () => {
    const app = createTestApp(crossOrgAdmin);
    const res = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: "golf.club.com" });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /marketing-site/custom-domain — plan gating", () => {
  it("402 when the org's plan does not include customDomain (free tier)", async () => {
    const app = createTestApp(freeAdmin);
    const res = await request(app).patch(URL_FOR(freeOrgId))
      .send({ customDomain: "golf.freeclub.com" });
    expect(res.status).toBe(402);
    expect(res.body.featureGate?.feature).toBe("customDomain");

    // The DB value must remain untouched (still null).
    const [row] = await db.select({ d: organizationsTable.customDomain })
      .from(organizationsTable).where(eq(organizationsTable.id, freeOrgId));
    expect(row.d).toBeNull();
  });
});

describe("PATCH /marketing-site/custom-domain — normalisation", () => {
  it("lowercases the hostname", async () => {
    const app = createTestApp(entAdmin);
    const res = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: "GOLF.MyClub.COM" });
    expect(res.status).toBe(200);
    expect(res.body.customDomain).toBe("golf.myclub.com");

    const [row] = await db.select({ d: organizationsTable.customDomain })
      .from(organizationsTable).where(eq(organizationsTable.id, entOrgId));
    expect(row.d).toBe("golf.myclub.com");
  });

  it("strips https:// protocol, port, and path", async () => {
    const app = createTestApp(entAdmin);
    const res = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: "https://Golf.MyClub.com:8443/path/to/page" });
    expect(res.status).toBe(200);
    expect(res.body.customDomain).toBe("golf.myclub.com");
  });

  it("strips http:// protocol", async () => {
    const app = createTestApp(entAdmin);
    const res = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: "http://golf.myclub.com" });
    expect(res.status).toBe(200);
    expect(res.body.customDomain).toBe("golf.myclub.com");
  });

  it("trims surrounding whitespace", async () => {
    const app = createTestApp(entAdmin);
    const res = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: "   golf.myclub.com   " });
    expect(res.status).toBe(200);
    expect(res.body.customDomain).toBe("golf.myclub.com");
  });
});

describe("PATCH /marketing-site/custom-domain — invalid input", () => {
  const cases: Array<[string, unknown]> = [
    ["bare label (no dot)", "localhost"],
    ["leading hyphen in label", "-bad.example.com"],
    ["trailing hyphen in label", "bad-.example.com"],
    ["underscore in label", "bad_label.example.com"],
    ["space in hostname", "bad host.example.com"],
    ["pure-numeric TLD / IP", "1.2.3.4"],
    ["non-string number", 12345],
    ["non-string boolean", true],
  ];

  for (const [label, value] of cases) {
    it(`400 for ${label}`, async () => {
      const app = createTestApp(entAdmin);
      const res = await request(app).patch(URL_FOR(entOrgId))
        .send({ customDomain: value });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/valid hostname/i);
    });
  }
});

describe("PATCH /marketing-site/custom-domain — uniqueness", () => {
  it("409 when another org already owns the same domain (case-insensitive)", async () => {
    const [other] = await db.select({ d: organizationsTable.customDomain })
      .from(organizationsTable).where(eq(organizationsTable.id, otherEntOrgId));
    const taken = other.d!;

    const app = createTestApp(entAdmin);
    const res = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: taken.toUpperCase() });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already assigned/i);

    // The caller's org domain must remain unchanged.
    const [row] = await db.select({ d: organizationsTable.customDomain })
      .from(organizationsTable).where(eq(organizationsTable.id, entOrgId));
    expect(row.d).toBeNull();
  });

  it("allows re-saving the same org's existing domain (self-uniqueness exemption)", async () => {
    const app = createTestApp(entAdmin);
    // First save.
    const r1 = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: "selfsave.example.com" });
    expect(r1.status).toBe(200);
    // Second save with the same value should succeed (no 409 against self).
    const r2 = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: "selfsave.example.com" });
    expect(r2.status).toBe(200);
    expect(r2.body.customDomain).toBe("selfsave.example.com");
  });
});

describe("PATCH /marketing-site/custom-domain — clearing", () => {
  it("clears the domain when given null", async () => {
    // Seed a value first.
    await db.update(organizationsTable)
      .set({ customDomain: "to-be-cleared.example.com" })
      .where(eq(organizationsTable.id, entOrgId));

    const app = createTestApp(entAdmin);
    const res = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: null });
    expect(res.status).toBe(200);
    expect(res.body.customDomain).toBeNull();

    const [row] = await db.select({ d: organizationsTable.customDomain })
      .from(organizationsTable).where(eq(organizationsTable.id, entOrgId));
    expect(row.d).toBeNull();
  });

  it("clears the domain when given an empty string", async () => {
    await db.update(organizationsTable)
      .set({ customDomain: "to-be-cleared.example.com" })
      .where(eq(organizationsTable.id, entOrgId));

    const app = createTestApp(entAdmin);
    const res = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: "" });
    expect(res.status).toBe(200);
    expect(res.body.customDomain).toBeNull();
  });
});

describe("PATCH /marketing-site/custom-domain — cache-version bump", () => {
  it("increments the marketing-site cacheVersion on every successful save", async () => {
    const app = createTestApp(entAdmin);

    // Touch once to ensure the marketing-site row exists, then read its cacheVersion.
    const r1 = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: "cachebump-a.example.com" });
    expect(r1.status).toBe(200);

    const before = await db.query.clubMarketingSitesTable.findFirst({
      where: eq(clubMarketingSitesTable.organizationId, entOrgId),
    });
    expect(before).toBeTruthy();
    const v1 = before!.cacheVersion;

    const r2 = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: "cachebump-b.example.com" });
    expect(r2.status).toBe(200);

    const after = await db.query.clubMarketingSitesTable.findFirst({
      where: eq(clubMarketingSitesTable.organizationId, entOrgId),
    });
    expect(after!.cacheVersion).toBe(v1 + 1);
  });

  it("super_admin may save on any org and still bumps cacheVersion", async () => {
    const app = createTestApp(superAdmin);
    const r = await request(app).patch(URL_FOR(entOrgId))
      .send({ customDomain: "super.example.com" });
    expect(r.status).toBe(200);
    expect(r.body.customDomain).toBe("super.example.com");

    const site = await db.query.clubMarketingSitesTable.findFirst({
      where: eq(clubMarketingSitesTable.organizationId, entOrgId),
    });
    expect(site!.cacheVersion).toBeGreaterThanOrEqual(1);
  });
});
