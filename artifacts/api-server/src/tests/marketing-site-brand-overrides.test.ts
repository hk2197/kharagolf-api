/**
 * Task #665 — API coverage for the per-club marketing-site brand overrides
 * (Task #584). Validates that PUT /api/organizations/:orgId/marketing-site:
 *
 *   - rejects malformed brandPrimaryColor / brandAccentColor values
 *     (must be a #RGB or #RRGGBB hex), returning 400.
 *   - rejects brandHeadingFont values that aren't on the allow-list (400).
 *   - persists valid hex colors and allow-listed fonts (200).
 *   - treats null and "" as a reset back to the theme default by writing
 *     NULL to the column.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-marketing-brand-overrides";

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
  const slug = `mkt-brand-${stamp}`.toLowerCase();
  const [org] = await db.insert(organizationsTable).values({
    name: `MktBrand_${stamp}`,
    slug,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  admin = await makeUser(orgId, "org_admin");
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

describe("PUT /marketing-site — brand overrides validation (Task #584)", () => {
  it("rejects a malformed brandPrimaryColor with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .put(URL(orgId))
      .send({ brandPrimaryColor: "not-a-color" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/brandPrimaryColor/);
  });

  it("rejects a malformed brandAccentColor with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .put(URL(orgId))
      .send({ brandAccentColor: "#zz1122" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/brandAccentColor/);
  });

  it("rejects a brandHeadingFont that is not on the allow-list with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .put(URL(orgId))
      .send({ brandHeadingFont: "Comic Sans MS, cursive" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/brandHeadingFont/);
  });

  it("accepts a valid #RRGGBB primary color, #RGB accent color and allow-listed font, and persists them", async () => {
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      brandPrimaryColor: "#102030",
      brandAccentColor: "#abc",
      brandHeadingFont: "'Playfair Display', Georgia, serif",
    });
    expect(res.status).toBe(200);
    expect(res.body.brandPrimaryColor).toBe("#102030");
    expect(res.body.brandAccentColor).toBe("#abc");
    expect(res.body.brandHeadingFont).toBe("'Playfair Display', Georgia, serif");

    const row = await loadSite();
    expect(row?.brandPrimaryColor).toBe("#102030");
    expect(row?.brandAccentColor).toBe("#abc");
    expect(row?.brandHeadingFont).toBe("'Playfair Display', Georgia, serif");
  });

  it("treats explicit null as a reset back to the theme default (writes NULL)", async () => {
    // Seed values first so we can prove the reset.
    {
      const app = createTestApp(admin);
      await request(app).put(URL(orgId)).send({
        brandPrimaryColor: "#112233",
        brandAccentColor: "#445566",
        brandHeadingFont: "Montserrat, system-ui, sans-serif",
      });
    }
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      brandPrimaryColor: null,
      brandAccentColor: null,
      brandHeadingFont: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.brandPrimaryColor).toBeNull();
    expect(res.body.brandAccentColor).toBeNull();
    expect(res.body.brandHeadingFont).toBeNull();

    const row = await loadSite();
    expect(row?.brandPrimaryColor).toBeNull();
    expect(row?.brandAccentColor).toBeNull();
    expect(row?.brandHeadingFont).toBeNull();
  });

  it("treats empty string as a reset back to the theme default (writes NULL)", async () => {
    // Seed values first so we can prove the reset.
    {
      const app = createTestApp(admin);
      await request(app).put(URL(orgId)).send({
        brandPrimaryColor: "#aabbcc",
        brandAccentColor: "#ddeeff",
        brandHeadingFont: "'Roboto Slab', Georgia, serif",
      });
    }
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({
      brandPrimaryColor: "",
      brandAccentColor: "",
      brandHeadingFont: "",
    });
    expect(res.status).toBe(200);
    expect(res.body.brandPrimaryColor).toBeNull();
    expect(res.body.brandAccentColor).toBeNull();
    expect(res.body.brandHeadingFont).toBeNull();

    const row = await loadSite();
    expect(row?.brandPrimaryColor).toBeNull();
    expect(row?.brandAccentColor).toBeNull();
    expect(row?.brandHeadingFont).toBeNull();
  });

  it("ignores brand override fields entirely when the patch omits them", async () => {
    // Seed values, then send a patch that doesn't mention the overrides.
    {
      const app = createTestApp(admin);
      await request(app).put(URL(orgId)).send({
        brandPrimaryColor: "#001122",
        brandAccentColor: "#334455",
        brandHeadingFont: "Inter, system-ui, sans-serif",
      });
    }
    const app = createTestApp(admin);
    const res = await request(app).put(URL(orgId)).send({ heroTitle: "Hello" });
    expect(res.status).toBe(200);
    expect(res.body.brandPrimaryColor).toBe("#001122");
    expect(res.body.brandAccentColor).toBe("#334455");
    expect(res.body.brandHeadingFont).toBe("Inter, system-ui, sans-serif");
  });
});
