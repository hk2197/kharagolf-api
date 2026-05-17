/**
 * Regression test for Task #2194 — the prize certificate PDF logo
 * (`routes/prizes.ts`) must honour the saved `club_theming` row over the
 * legacy `organizations.logo_url` column.
 *
 * Background: Task #1758 routed the certificate logo through
 * `resolveOrgBranding(orgId, org)` so the same logo the admin most recently
 * picked in the club-theming UI ends up on the printed certificate. This
 * test stubs `global.fetch` so we can capture which URL the route tries to
 * download as the embedded logo, locking in the new precedence:
 *   1. club_theming row (when the org has saved one) — WINS
 *   2. organizations.logo_url — fallback
 *
 * Mirrors `broadcast-overlay-club-theming.test.ts` (Task #1758).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  clubThemingTable,
  coursesTable,
  tournamentsTable,
  prizeCategoriesTable,
  prizeAwardsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import { invalidateClubThemeCache } from "../lib/clubTheming.js";

const LEGACY_LOGO = "https://example.com/prize-legacy-logo.png";
const THEMED_LOGO = "https://example.com/prize-club-theming-logo.png";

let testOrgId: number;
let testCourseId: number;
let tournamentId: number;
let prizeCategoryId: number;
let awardId: number;
let admin: TestUser;
let originalFetch: typeof fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_PrizeCertCT_${suffix}`,
    slug: `test-prize-cert-ct-${suffix}`,
    logoUrl: LEGACY_LOGO,
    primaryColor: "#aaaaaa",
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  await db.insert(clubThemingTable).values({
    organizationId: testOrgId,
    primaryColor: "#bada55",
    accentColor: "#112233",
    fontFamily: "Outfit",
    logoUrl: THEMED_LOGO,
    faviconUrl: null,
  });
  invalidateClubThemeCache(testOrgId);

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Prize Cert CT Course",
    slug: `prize-cert-ct-course-${suffix}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const tStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const tEnd = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Prize Cert CT ${suffix}`,
    format: "stroke_play",
    status: "completed",
    startDate: tStart,
    endDate: tEnd,
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [cat] = await db.insert(prizeCategoriesTable).values({
    tournamentId,
    name: "Champion",
    displayOrder: 0,
  }).returning({ id: prizeCategoriesTable.id });
  prizeCategoryId = cat.id;

  const [award] = await db.insert(prizeAwardsTable).values({
    prizeCategoryId,
    tournamentId,
    playerName: "Asha Singh",
  }).returning({ id: prizeAwardsTable.id });
  awardId = award.id;

  admin = {
    id: 1,
    username: "prize_cert_super_admin",
    role: "super_admin",
  };
});

afterAll(async () => {
  await db.delete(prizeAwardsTable).where(eq(prizeAwardsTable.id, awardId));
  await db.delete(prizeCategoriesTable).where(eq(prizeCategoriesTable.id, prizeCategoryId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(clubThemingTable).where(eq(clubThemingTable.organizationId, testOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Return a tiny opaque body — pdfkit's `doc.image` will throw on the
  // bogus payload but the route swallows that and renders the certificate
  // without a logo. For this regression test we only care about which
  // URL the route tried to fetch.
  fetchSpy = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as Response));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Task #2194 — prize certificate PDF embeds the club_theming logo over the legacy organizations.logo_url", () => {
  it("downloads the saved club_theming logo URL when streaming the certificate", async () => {
    const app = createTestApp(admin);
    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/tournaments/${tournamentId}/prizes/${prizeCategoryId}/award/${awardId}/certificate`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const fetchedUrl = String(fetchSpy.mock.calls[0][0]);
    expect(fetchedUrl).toBe(THEMED_LOGO);
    // Defensive: the legacy column must NOT win when a club_theming row
    // exists, otherwise admins who only saved branding via the club-theming
    // UI silently get the old logo on printed certificates again.
    expect(fetchedUrl).not.toBe(LEGACY_LOGO);
  });
});
