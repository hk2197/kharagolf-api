/**
 * Task #1756 — API coverage for the new public org branding endpoints
 * used by the pre-auth login / register / forgot-password pages.
 *
 *   GET /api/public/orgs/by-slug/:slug/branding
 *   GET /api/public/orgs/by-id/:orgId/branding
 *
 * Both endpoints share `buildPublicOrgBranding()` and must apply the
 * same precedence as `resolveOrgBranding()`:
 *
 *   1. The `club_theming` row when `customized === true`
 *   2. The legacy `organizations.{logo_url,primary_color}` columns
 *
 * The legacy fallback was the regression caught in code review on the
 * register-page flow — clubs that uploaded a logo via the old onboarding
 * UI but never opened the customised theming editor must still see
 * their logo on the register page.
 *
 * On a miss / DB error the endpoints return 200 + `branding: null` so
 * the login UI can fall back to the KHARAGOLF default mark without
 * special-casing 404s.
 */
process.env.SESSION_SECRET ||= "test-session-secret-public-org-branding";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { organizationsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";
import { invalidateClubThemeCache } from "../lib/clubTheming.js";

const orgIds: number[] = [];
let orgWithThemeId: number;
let orgWithThemeSlug: string;
let orgLegacyId: number;
let orgLegacySlug: string;
let orgPlainId: number;
let orgPlainSlug: string;

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // Org A — has a customised club_theming row. Both columns set.
  orgWithThemeSlug = `pinevalley-${stamp}`.toLowerCase();
  const [a] = await db.insert(organizationsTable).values({
    name: "Pine Valley Golf Club",
    slug: orgWithThemeSlug,
    // Set legacy fields too so we can prove the theme row WINS over them.
    logoUrl: "https://cdn.example.com/legacy-pinevalley.png",
    primaryColor: "#999999",
  }).returning({ id: organizationsTable.id });
  orgWithThemeId = a.id;
  orgIds.push(orgWithThemeId);

  await db.execute(sql`
    INSERT INTO club_theming (organization_id, primary_color, accent_color, font_family, logo_url, favicon_url)
    VALUES (${orgWithThemeId}, '#102030', '#aabbcc', 'Inter, system-ui, sans-serif',
            'https://cdn.example.com/themed-pinevalley.png',
            'https://cdn.example.com/themed-pinevalley-fav.ico')
  `);
  invalidateClubThemeCache(orgWithThemeId);

  // Org B — legacy logo only, no club_theming row. The regression case.
  orgLegacySlug = `legacyclub-${stamp}`.toLowerCase();
  const [b] = await db.insert(organizationsTable).values({
    name: "Legacy Club",
    slug: orgLegacySlug,
    logoUrl: "https://cdn.example.com/legacy-only.png",
    primaryColor: "#001122",
  }).returning({ id: organizationsTable.id });
  orgLegacyId = b.id;
  orgIds.push(orgLegacyId);
  invalidateClubThemeCache(orgLegacyId);

  // Org C — no logo anywhere. Branding payload comes back with logoUrl=null.
  orgPlainSlug = `plainclub-${stamp}`.toLowerCase();
  const [c] = await db.insert(organizationsTable).values({
    name: "Plain Club",
    slug: orgPlainSlug,
  }).returning({ id: organizationsTable.id });
  orgPlainId = c.id;
  orgIds.push(orgPlainId);
  invalidateClubThemeCache(orgPlainId);
});

afterAll(async () => {
  if (orgIds.length) {
    await db.execute(sql`DELETE FROM club_theming WHERE organization_id IN (${sql.join(orgIds.map((id) => sql`${id}`), sql`, `)})`);
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgIds));
  }
});

describe("GET /api/public/orgs/by-slug/:slug/branding (Task #1756)", () => {
  it("returns the club_theming row's logo + primaryColor when the org is customised", async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/public/orgs/by-slug/${orgWithThemeSlug}/branding`);
    expect(res.status).toBe(200);
    expect(res.body.branding).toMatchObject({
      organizationId: orgWithThemeId,
      slug: orgWithThemeSlug,
      name: "Pine Valley Golf Club",
      logoUrl: "https://cdn.example.com/themed-pinevalley.png",
      faviconUrl: "https://cdn.example.com/themed-pinevalley-fav.ico",
      primaryColor: "#102030",
    });
  });

  it("falls back to the legacy organizations.logoUrl / primaryColor when no club_theming row exists", async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/public/orgs/by-slug/${orgLegacySlug}/branding`);
    expect(res.status).toBe(200);
    expect(res.body.branding).toMatchObject({
      organizationId: orgLegacyId,
      slug: orgLegacySlug,
      name: "Legacy Club",
      logoUrl: "https://cdn.example.com/legacy-only.png",
      faviconUrl: null,
      primaryColor: "#001122",
    });
  });

  it("returns 200 + branding:null for an unknown slug so the login UI can fall back silently", async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/public/orgs/by-slug/no-such-slug-${Date.now()}/branding`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ branding: null });
  });
});

describe("GET /api/public/orgs/by-id/:orgId/branding (Task #1756)", () => {
  it("returns the club_theming row's logo when the org is customised", async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/public/orgs/by-id/${orgWithThemeId}/branding`);
    expect(res.status).toBe(200);
    expect(res.body.branding).toMatchObject({
      organizationId: orgWithThemeId,
      slug: orgWithThemeSlug,
      name: "Pine Valley Golf Club",
      logoUrl: "https://cdn.example.com/themed-pinevalley.png",
      primaryColor: "#102030",
    });
  });

  it("honours the legacy organizations.logoUrl fallback for the register-page flow", async () => {
    // Register page passes tournament.organizationId → by-id. Without
    // legacy fallback, this org (no club_theming row) would silently
    // render the default KHARAGOLF mark instead of the saved logo —
    // the exact regression code review caught.
    const app = createTestApp();
    const res = await request(app).get(`/api/public/orgs/by-id/${orgLegacyId}/branding`);
    expect(res.status).toBe(200);
    expect(res.body.branding).toMatchObject({
      organizationId: orgLegacyId,
      slug: orgLegacySlug,
      name: "Legacy Club",
      logoUrl: "https://cdn.example.com/legacy-only.png",
      primaryColor: "#001122",
    });
  });

  it("returns the org with logoUrl:null when no logo is on file (caller falls back to default mark)", async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/public/orgs/by-id/${orgPlainId}/branding`);
    expect(res.status).toBe(200);
    // logoUrl is the contract the pre-auth UI cares about — when it's
    // null, <PreAuthBrand /> falls back to the KHARAGOLF mark. The
    // primaryColor falls through to whatever the schema default is
    // (organizations.primary_color is non-null by default), which is
    // fine because the UI only swaps the colour in when it differs
    // from the design-token default.
    expect(res.body.branding).toMatchObject({
      organizationId: orgPlainId,
      slug: orgPlainSlug,
      name: "Plain Club",
      logoUrl: null,
      faviconUrl: null,
    });
    expect(res.body.branding.primaryColor === null || typeof res.body.branding.primaryColor === "string").toBe(true);
  });

  it("returns 200 + branding:null for an unknown orgId", async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/public/orgs/by-id/2147483640/branding`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ branding: null });
  });

  it("returns 200 + branding:null for a non-numeric orgId so a flaky route never breaks login", async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/public/orgs/by-id/not-a-number/branding`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ branding: null });
  });
});
