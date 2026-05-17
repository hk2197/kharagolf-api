/**
 * Regression test for Task #2194 — the player-facing
 * `/api/portal/membership/card` SVG (`routes/portal.ts` ~line 6775) must
 * honour the saved `club_theming` row over the legacy
 * `organizations.logo_url` / `organizations.primary_color` columns.
 *
 * Background: Task #1758 routed the membership card through
 * `resolveOrgBranding(orgId, org)` so the same logo and primary colour the
 * admin picked in the club-theming UI show up on the player's downloadable
 * card. This test stubs `global.fetch` to capture the logo URL the route
 * downloads, and mocks `@resvg/resvg-js` so we can also assert the SVG
 * passed to the rasteriser uses the club_theming primary colour as the
 * accent stripe.
 *
 * Mirrors `broadcast-overlay-club-theming.test.ts` (Task #1758).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

let capturedSvg = "";

vi.mock("@resvg/resvg-js", () => ({
  // Constructor must be a real function (not arrow) so `new Resvg(...)`
  // works under the vitest mock and an instance with `render()` is
  // returned. See https://vitest.dev/api/vi#vi-spyon.
  Resvg: function MockResvg(svg: string) {
    capturedSvg = svg;
    return {
      render: () => ({ asPng: () => Buffer.from([0]) }),
    };
  },
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  clubThemingTable,
  appUsersTable,
  clubMembersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import { invalidateClubThemeCache } from "../lib/clubTheming.js";

const LEGACY_LOGO = "https://example.com/card-legacy-logo.png";
const LEGACY_COLOR = "#aaaaaa";
const THEMED_LOGO = "https://example.com/card-club-theming-logo.png";
const THEMED_COLOR = "#bada55";

let testOrgId: number;
let testUserId: number;
let testMemberId: number;
let player: TestUser;
let originalFetch: typeof fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_MemberCardCT_${suffix}`,
    slug: `test-member-card-ct-${suffix}`,
    logoUrl: LEGACY_LOGO,
    primaryColor: LEGACY_COLOR,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  await db.insert(clubThemingTable).values({
    organizationId: testOrgId,
    primaryColor: THEMED_COLOR,
    accentColor: "#112233",
    fontFamily: "Outfit",
    logoUrl: THEMED_LOGO,
    faviconUrl: null,
  });
  invalidateClubThemeCache(testOrgId);

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `member-card-ct-${suffix}`,
    username: `member_card_ct_${suffix}`,
    email: `card_${suffix}@example.com`,
    displayName: "Card CT Player",
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    userId: testUserId,
    firstName: "Asha",
    lastName: "Singh",
    memberNumber: "M-1001",
    subscriptionStatus: "active",
  }).returning({ id: clubMembersTable.id });
  testMemberId = m.id;

  // Use a player session with no organizationId so the `mobileApp`
  // session-aware feature gate short-circuits ("No org context (super-admin,
  // etc.) — allow"). This keeps the test focused on the branding regression
  // rather than plan-tier configuration.
  player = {
    id: testUserId,
    username: `member_card_ct_${suffix}`,
    role: "player",
  };
});

afterAll(async () => {
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, testMemberId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(clubThemingTable).where(eq(clubThemingTable.organizationId, testOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  capturedSvg = "";
  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
    headers: { get: () => "image/png" },
  } as unknown as Response));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Task #2194 — /portal/membership/card honours club_theming over legacy organizations.* columns", () => {
  it("downloads the club_theming logo and renders the SVG with the club_theming primary colour", async () => {
    const app = createTestApp(player);
    const res = await request(app).get("/api/portal/membership/card");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const fetchedUrl = String(fetchSpy.mock.calls[0][0]);
    expect(fetchedUrl).toBe(THEMED_LOGO);
    expect(fetchedUrl).not.toBe(LEGACY_LOGO);

    // The card SVG paints its accent stripe + tier label with the resolved
    // primary colour. Ensure the club_theming colour wins, not the legacy
    // organizations.primary_color column.
    expect(capturedSvg.length).toBeGreaterThan(0);
    expect(capturedSvg).toContain(THEMED_COLOR);
    expect(capturedSvg).not.toContain(LEGACY_COLOR);
  });
});
