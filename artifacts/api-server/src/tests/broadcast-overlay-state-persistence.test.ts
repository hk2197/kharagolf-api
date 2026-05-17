/**
 * Integration tests: Persisted Broadcast Overlay Cue State (Task #426 / #550)
 *
 * Locks in that producer cues survive an API server restart by exercising:
 *   - Public state endpoint hydrates from `broadcast_overlay_states` when a row exists
 *   - Public state endpoint falls back to org-branding defaults when no row exists
 *   - Admin PUT and POST cue endpoints upsert into `broadcast_overlay_states`
 *
 * The in-memory overlay cache is keyed by tournamentId; each test uses a freshly
 * created tournament (and clears any pre-existing cached state by reaching for
 * a tournament id that the API has never touched) so we are reading from the DB
 * the same way a freshly-restarted API would.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  broadcastOverlayStatesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

let testOrgId: number;
let testCourseId: number;
let persistedTournamentId: number; // has a pre-seeded row
let defaultsTournamentId: number;  // no row → defaults
let adminTournamentId: number;     // mutated via admin endpoints

beforeAll(async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_OverlayState_${suffix}`,
    slug: `test-overlay-state-${suffix}`,
    logoUrl: "https://example.com/org-logo.png",
    primaryColor: "#0033aa",
    // Intentionally left at the default (free) tier. The whsScoring
    // entitlement gate is now scoped to actual WHS scoring routes only,
    // so broadcast-overlay endpoints must work on every plan.
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Overlay Test Course",
    slug: `overlay-course-${suffix}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const tStart = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const tEnd = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);

  const tournaments = await db.insert(tournamentsTable).values([
    {
      organizationId: testOrgId, courseId: testCourseId,
      name: `Overlay Persisted ${suffix}`,
      format: "stroke_play", status: "upcoming",
      startDate: tStart, endDate: tEnd, maxPlayers: 32,
    },
    {
      organizationId: testOrgId, courseId: testCourseId,
      name: `Overlay Defaults ${suffix}`,
      format: "stroke_play", status: "upcoming",
      startDate: tStart, endDate: tEnd, maxPlayers: 32,
    },
    {
      organizationId: testOrgId, courseId: testCourseId,
      name: `Overlay Admin ${suffix}`,
      format: "stroke_play", status: "upcoming",
      startDate: tStart, endDate: tEnd, maxPlayers: 32,
    },
  ]).returning({ id: tournamentsTable.id });

  persistedTournamentId = tournaments[0].id;
  defaultsTournamentId = tournaments[1].id;
  adminTournamentId = tournaments[2].id;

  // Pre-seed a persisted overlay row that mimics what the producer panel would
  // have written before the API restarted.
  await db.insert(broadcastOverlayStatesTable).values({
    tournamentId: persistedTournamentId,
    state: {
      active: {
        leaderboard: true,
        "lower-third": true,
        "current-group": false,
        "player-card": false,
        hole: true,
        "sponsor-bug": false,
      },
      currentGroupId: null,
      currentHole: 14,
      currentPlayerId: null,
      currentSponsorId: null,
      lowerThirdText: "Back nine — moving day",
      leaderboardLimit: 8,
      theme: {
        logoUrl: "https://example.com/custom-overlay-logo.png",
        primaryColor: "#ff8800",
        accentColor: "#112233",
        sponsorPosition: "top-left",
        showSafeArea: true,
      },
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date(),
  });
});

afterAll(async () => {
  const tournamentIds = [persistedTournamentId, defaultsTournamentId, adminTournamentId];
  await db.delete(broadcastOverlayStatesTable)
    .where(inArray(broadcastOverlayStatesTable.tournamentId, tournamentIds));
  await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, tournamentIds));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

// ── Public state endpoint ──────────────────────────────────────────────────

describe("GET /public/overlays/:tournamentId/state — persistence", () => {
  it("hydrates persisted active overlays, current hole, lower-third text, and theme overrides", async () => {
    const app = createTestApp(); // public endpoint, no auth
    const res = await request(app)
      .get(`/api/public/overlays/${persistedTournamentId}/state`);

    expect(res.status).toBe(200);
    expect(res.body.tournament.id).toBe(persistedTournamentId);

    const s = res.body.state;
    expect(s.active.leaderboard).toBe(true);
    expect(s.active["lower-third"]).toBe(true);
    expect(s.active.hole).toBe(true);
    expect(s.active["current-group"]).toBe(false);
    expect(s.currentHole).toBe(14);
    expect(s.lowerThirdText).toBe("Back nine — moving day");
    expect(s.leaderboardLimit).toBe(8);
    expect(s.theme.logoUrl).toBe("https://example.com/custom-overlay-logo.png");
    expect(s.theme.primaryColor).toBe("#ff8800");
    expect(s.theme.accentColor).toBe("#112233");
    expect(s.theme.sponsorPosition).toBe("top-left");
    expect(s.theme.showSafeArea).toBe(true);
  });

  it("falls back to org-branding defaults when no row exists for the tournament", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/public/overlays/${defaultsTournamentId}/state`);

    expect(res.status).toBe(200);
    const s = res.body.state;
    // All overlays start hidden by default
    expect(s.active.leaderboard).toBe(false);
    expect(s.active["lower-third"]).toBe(false);
    expect(s.active.hole).toBe(false);
    expect(s.currentHole).toBeNull();
    expect(s.currentGroupId).toBeNull();
    expect(s.currentPlayerId).toBeNull();
    expect(s.lowerThirdText).toBeNull();
    expect(s.leaderboardLimit).toBe(10);
    // Theme inherits org branding
    expect(s.theme.logoUrl).toBe("https://example.com/org-logo.png");
    expect(s.theme.primaryColor).toBe("#0033aa");
    expect(s.theme.sponsorPosition).toBe("bottom-right");
    expect(s.theme.showSafeArea).toBe(false);
    // Org info is exposed alongside state
    expect(res.body.org.id).toBe(testOrgId);
    expect(res.body.org.logoUrl).toBe("https://example.com/org-logo.png");
    expect(res.body.org.primaryColor).toBe("#0033aa");
  });
});

// ── Admin write endpoints ──────────────────────────────────────────────────

describe("Admin overlay write endpoints — persistence", () => {
  const adminUser = (orgId: number) => ({
    id: 424242,
    username: "overlay_admin",
    displayName: "Overlay Admin",
    role: "org_admin",
    organizationId: orgId,
  });

  it("PUT /overlay-state upserts the producer state into broadcast_overlay_states", async () => {
    const app = createTestApp(adminUser(testOrgId));

    const res = await request(app)
      .put(`/api/organizations/${testOrgId}/tournaments/${adminTournamentId}/overlay-state`)
      .send({
        active: { leaderboard: true, "lower-third": true },
        currentHole: 7,
        lowerThirdText: "Featured group on 7",
        leaderboardLimit: 5,
        theme: { primaryColor: "#abcdef", sponsorPosition: "top-right" },
      });

    expect(res.status).toBe(200);
    expect(res.body.active.leaderboard).toBe(true);
    expect(res.body.active["lower-third"]).toBe(true);
    expect(res.body.currentHole).toBe(7);
    expect(res.body.lowerThirdText).toBe("Featured group on 7");
    expect(res.body.leaderboardLimit).toBe(5);
    expect(res.body.theme.primaryColor).toBe("#abcdef");
    expect(res.body.theme.sponsorPosition).toBe("top-right");

    const [row] = await db
      .select({ state: broadcastOverlayStatesTable.state })
      .from(broadcastOverlayStatesTable)
      .where(eq(broadcastOverlayStatesTable.tournamentId, adminTournamentId));
    expect(row).toBeTruthy();
    const persisted = row!.state as {
      active: Record<string, boolean>;
      currentHole: number | null;
      lowerThirdText: string | null;
      leaderboardLimit: number;
      theme: { primaryColor: string; sponsorPosition: string };
    };
    expect(persisted.active.leaderboard).toBe(true);
    expect(persisted.active["lower-third"]).toBe(true);
    expect(persisted.currentHole).toBe(7);
    expect(persisted.lowerThirdText).toBe("Featured group on 7");
    expect(persisted.leaderboardLimit).toBe(5);
    expect(persisted.theme.primaryColor).toBe("#abcdef");
    expect(persisted.theme.sponsorPosition).toBe("top-right");
  });

  it("POST /overlay-cue updates the persisted row for a hole cue", async () => {
    const app = createTestApp(adminUser(testOrgId));
    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${adminTournamentId}/overlay-cue`)
      .send({ type: "hole", value: 12 });

    expect(res.status).toBe(200);
    expect(res.body.currentHole).toBe(12);

    const [row] = await db
      .select({ state: broadcastOverlayStatesTable.state })
      .from(broadcastOverlayStatesTable)
      .where(eq(broadcastOverlayStatesTable.tournamentId, adminTournamentId));
    const persisted = row!.state as { currentHole: number | null };
    expect(persisted.currentHole).toBe(12);
  });

  it("POST /overlay-cue lower-third sets text and toggles the lower-third overlay on", async () => {
    const app = createTestApp(adminUser(testOrgId));
    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${adminTournamentId}/overlay-cue`)
      .send({ type: "lower-third", value: "Eagle on 13!" });

    expect(res.status).toBe(200);
    expect(res.body.lowerThirdText).toBe("Eagle on 13!");
    expect(res.body.active["lower-third"]).toBe(true);

    const [row] = await db
      .select({ state: broadcastOverlayStatesTable.state })
      .from(broadcastOverlayStatesTable)
      .where(eq(broadcastOverlayStatesTable.tournamentId, adminTournamentId));
    const persisted = row!.state as {
      lowerThirdText: string | null;
      active: Record<string, boolean>;
    };
    expect(persisted.lowerThirdText).toBe("Eagle on 13!");
    expect(persisted.active["lower-third"]).toBe(true);
  });

  it("POST /overlay-cue clear-all turns every overlay off and persists it", async () => {
    const app = createTestApp(adminUser(testOrgId));
    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${adminTournamentId}/overlay-cue`)
      .send({ type: "clear-all" });

    expect(res.status).toBe(200);
    for (const v of Object.values(res.body.active as Record<string, boolean>)) {
      expect(v).toBe(false);
    }

    const [row] = await db
      .select({ state: broadcastOverlayStatesTable.state })
      .from(broadcastOverlayStatesTable)
      .where(eq(broadcastOverlayStatesTable.tournamentId, adminTournamentId));
    const persisted = row!.state as { active: Record<string, boolean> };
    for (const v of Object.values(persisted.active)) {
      expect(v).toBe(false);
    }
  });

  it("rejects admin PUT from a different org with 404 (tournament-access guard)", async () => {
    const app = createTestApp(adminUser(testOrgId + 9_999_999));
    const res = await request(app)
      .put(`/api/organizations/${testOrgId}/tournaments/${adminTournamentId}/overlay-state`)
      .send({ currentHole: 1 });
    // The tournament does belong to the org in the URL, but the caller is an
    // org_admin for a different org with no membership/staff rows on the
    // target tournament — `requireTournamentAccess` returns 403 in that case.
    expect(res.status).toBe(403);
  });
});
