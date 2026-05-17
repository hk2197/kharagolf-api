/**
 * Regression test for Task #2193 — the multi-org switcher payload at
 * `GET /api/portal/my-orgs` must honour the saved `club_theming` row
 * over the legacy `organizations.logo_url` column.
 *
 * Background: Task #1758 wired the saved `club_theming` row into
 * broadcast overlays / event emails / membership cards / certificates
 * via `resolveOrgBranding(orgId)`. The portal's `/my-orgs` route
 * intentionally stayed on the legacy column at the time because it
 * returns N orgs and per-org `resolveOrgBranding()` calls would have
 * been a fan-out. The switcher therefore showed the OLD logo for clubs
 * that only customised branding through the new club-theming UI.
 *
 * The fix uses a single LEFT JOIN onto `club_theming` plus
 * `COALESCE(club_theming.logo_url, organizations.logo_url)` so that:
 *   1. A club_theming row with a non-null logo WINS over the legacy
 *      column (the club-theming UI is the source of truth).
 *   2. A club with no club_theming row still shows its legacy logo
 *      (older onboarding flows that never opened the club-theming UI).
 *   3. A club_theming row whose logo_url is NULL falls through to the
 *      legacy column (the resolver cannot tell "unset" from "cleared",
 *      so we mirror `resolveOrgBranding`'s behaviour for parity).
 */
process.env.SESSION_SECRET ||= "test-session-secret-portal-my-orgs-club-theming";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  orgMembershipsTable,
  appUsersTable,
  clubThemingTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

let userId: number;
const orgIds: number[] = [];
let themedOrgId: number;
let legacyOrgId: number;
let themedRowNullLogoOrgId: number;

beforeAll(async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Test player who belongs to all three orgs.
  const userTag = uid("myorgs_user");
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: userTag,
    username: userTag,
    email: `${userTag}@test.local`,
    displayName: "My Orgs Test User",
    role: "player",
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  // Org A — has BOTH a legacy logo column AND a club_theming row with a
  // different logo. The themed logo must win on the switcher.
  const [a] = await db.insert(organizationsTable).values({
    name: `Themed Org ${suffix}`,
    slug: `themed-org-${suffix}`.toLowerCase(),
    logoUrl: "https://cdn.example.com/legacy-themed.png",
  }).returning({ id: organizationsTable.id });
  themedOrgId = a.id;
  orgIds.push(themedOrgId);

  await db.insert(clubThemingTable).values({
    organizationId: themedOrgId,
    primaryColor: "#102030",
    accentColor: "#aabbcc",
    fontFamily: "Outfit",
    logoUrl: "https://cdn.example.com/themed-themed.png",
    faviconUrl: null,
  });

  // Org B — legacy logo only, no club_theming row at all. Switcher
  // should still show the legacy logo (older onboarding flows).
  const [b] = await db.insert(organizationsTable).values({
    name: `Legacy Org ${suffix}`,
    slug: `legacy-org-${suffix}`.toLowerCase(),
    logoUrl: "https://cdn.example.com/legacy-only.png",
  }).returning({ id: organizationsTable.id });
  legacyOrgId = b.id;
  orgIds.push(legacyOrgId);

  // Org C — has a club_theming row but its logo_url is null (admin
  // saved colours via the theming UI but never uploaded a logo there).
  // We still want to surface the legacy logo column rather than nothing.
  const [c] = await db.insert(organizationsTable).values({
    name: `Themed-No-Logo Org ${suffix}`,
    slug: `themed-no-logo-${suffix}`.toLowerCase(),
    logoUrl: "https://cdn.example.com/legacy-fallback.png",
  }).returning({ id: organizationsTable.id });
  themedRowNullLogoOrgId = c.id;
  orgIds.push(themedRowNullLogoOrgId);

  await db.insert(clubThemingTable).values({
    organizationId: themedRowNullLogoOrgId,
    primaryColor: "#445566",
    accentColor: "#778899",
    fontFamily: "Inter",
    logoUrl: null,
    faviconUrl: null,
  });

  await db.insert(orgMembershipsTable).values([
    { organizationId: themedOrgId, userId, role: "player" },
    { organizationId: legacyOrgId, userId, role: "player" },
    { organizationId: themedRowNullLogoOrgId, userId, role: "player" },
  ]);
});

afterAll(async () => {
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.userId, userId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (orgIds.length) {
    await db.delete(clubThemingTable).where(inArray(clubThemingTable.organizationId, orgIds));
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgIds));
  }
});

describe("GET /api/portal/my-orgs — club theming precedence (Task #2193)", () => {
  it("returns the saved club_theming logo over the legacy organizations.logo_url column", async () => {
    const app = createTestApp({ id: userId, username: "myorgs_user", role: "player" });
    const res = await request(app).get("/api/portal/my-orgs");

    expect(res.status).toBe(200);
    const orgs: Array<{ id: number; logoUrl: string | null }> = res.body.orgs;
    const themed = orgs.find(o => o.id === themedOrgId);
    const legacy = orgs.find(o => o.id === legacyOrgId);
    const themedNoLogo = orgs.find(o => o.id === themedRowNullLogoOrgId);

    // The switcher shows the same logo as the membership card / event
    // emails for the themed org — the club_theming row WINS.
    expect(themed?.logoUrl).toBe("https://cdn.example.com/themed-themed.png");

    // No club_theming row → legacy column still surfaces.
    expect(legacy?.logoUrl).toBe("https://cdn.example.com/legacy-only.png");

    // club_theming row exists but logo_url is null → fall through to
    // the legacy column rather than blanking the switcher logo.
    expect(themedNoLogo?.logoUrl).toBe("https://cdn.example.com/legacy-fallback.png");
  });
});
