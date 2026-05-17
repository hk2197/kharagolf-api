/**
 * Regression test for Task #1758 — broadcast overlays must honour the
 * saved `club_theming` row over the legacy `organizations.logo_url` /
 * `organizations.primary_color` columns.
 *
 * Background: Task #1438 introduced `resolveOrgBranding(orgId)` so the
 * notification dispatcher and membership-card renderer would pick up
 * branding the admin saved through the new club-theming UI. The
 * broadcast-overlay state route was still reading the legacy org
 * columns directly, so admins who only customised branding via the
 * club-theming UI saw the old (or no) logo on their stream overlays.
 *
 * This test exercises the `/api/public/overlays/:tournamentId/state`
 * endpoint to lock in the new precedence:
 *   1. club_theming row (when the org has saved one) — WINS
 *   2. organizations.* columns — fallback
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  clubThemingTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
import { invalidateClubThemeCache } from "../lib/clubTheming.js";

let testOrgId: number;
let testCourseId: number;
let themedTournamentId: number;

beforeAll(async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Org carries the LEGACY branding columns. The club_theming row should
  // override these for the overlay state response.
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_OverlayClubTheming_${suffix}`,
    slug: `test-overlay-club-theming-${suffix}`,
    logoUrl: "https://example.com/legacy-logo.png",
    primaryColor: "#aaaaaa",
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  await db.insert(clubThemingTable).values({
    organizationId: testOrgId,
    primaryColor: "#bada55",
    accentColor: "#112233",
    fontFamily: "Outfit",
    logoUrl: "https://example.com/club-theming-logo.png",
    faviconUrl: null,
  });
  // The resolver caches per orgId for 60s; flush the entry the seeded org
  // would have collected from any prior test in the same process.
  invalidateClubThemeCache(testOrgId);

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Overlay Club-Theming Course",
    slug: `overlay-ct-course-${suffix}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const tStart = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const tEnd = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Overlay Club-Theming ${suffix}`,
    format: "stroke_play",
    status: "upcoming",
    startDate: tStart,
    endDate: tEnd,
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  themedTournamentId = tournament.id;
});

afterAll(async () => {
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, themedTournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(clubThemingTable).where(eq(clubThemingTable.organizationId, testOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

describe("GET /public/overlays/:tournamentId/state — club theming precedence (Task #1758)", () => {
  it("uses the saved club_theming row over legacy organizations.* columns for overlay branding", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/public/overlays/${themedTournamentId}/state`);

    expect(res.status).toBe(200);

    // The OBS browser source reads `state.theme.*` for its visuals.
    expect(res.body.state.theme.logoUrl).toBe("https://example.com/club-theming-logo.png");
    expect(res.body.state.theme.primaryColor).toBe("#bada55");

    // The `org` envelope (used by producer panels) should reflect the
    // resolved branding too, not the legacy org columns.
    expect(res.body.org.id).toBe(testOrgId);
    expect(res.body.org.logoUrl).toBe("https://example.com/club-theming-logo.png");
    expect(res.body.org.primaryColor).toBe("#bada55");
  });
});
