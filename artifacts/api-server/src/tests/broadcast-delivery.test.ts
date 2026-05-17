/**
 * Integration tests: Multi-channel Broadcast Delivery
 *
 * Verifies the broadcast endpoint's:
 *   - Authorization (401 / 403 paths)
 *   - Input validation (400 for missing body)
 *   - Tournament-level broadcast routing (recipient counts, 404 for bad IDs)
 *   - League-level broadcast routing
 *   - Org-wide fallback routing (no tournamentId/leagueId)
 *   - Flight-based targeting validation (404 for non-existent flight)
 *
 * Actual email/SMS/push delivery is not triggered in tests because there are
 * no real recipients in the DB fixtures. We verify the control-flow behavior
 * (status codes, response shape) rather than external side-effects.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  leaguesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

let testOrgId: number;
let testTournamentId: number;
let testLeagueId: number;
let testCourseId: number;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_Broadcast_${Date.now()}`,
    slug: `test-broadcast-${Date.now()}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Broadcast Test Course",
    slug: `broadcast-test-course-${Date.now()}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Broadcast Test Tournament ${Date.now()}`,
    format: "stroke_play",
    status: "upcoming",
    startDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = tournament.id;

  const [league] = await db.insert(leaguesTable).values({
    organizationId: testOrgId,
    name: `Broadcast Test League ${Date.now()}`,
    format: "stroke_play",
    status: "active",
    seasonStart: new Date(),
    seasonEnd: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  }).returning({ id: leaguesTable.id });
  testLeagueId = league.id;
});

afterAll(async () => {
  await db.delete(tournamentsTable)
    .where(and(eq(tournamentsTable.id, testTournamentId), eq(tournamentsTable.organizationId, testOrgId)));
  await db.delete(leaguesTable)
    .where(and(eq(leaguesTable.id, testLeagueId), eq(leaguesTable.organizationId, testOrgId)));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

// ── Authorization ─────────────────────────────────────────────────────────

describe("Broadcast — authorization", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/messages/broadcast`)
      .send({ body: "Hello", tournamentId: testTournamentId, channels: ["email"] });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a player role", async () => {
    const app = createTestApp({
      id: 999,
      username: "player",
      role: "player",
      organizationId: testOrgId,
    });

    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/messages/broadcast`)
      .send({ body: "Hello", tournamentId: testTournamentId, channels: ["email"] });
    expect(res.status).toBe(403);
  });

  it("returns 403 when admin is from a different org", async () => {
    const app = createTestApp({
      id: 998,
      username: "other_admin",
      role: "org_admin",
      organizationId: testOrgId + 8888,
    });

    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/messages/broadcast`)
      .send({ body: "Hello", tournamentId: testTournamentId, channels: ["email"] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/org mismatch/i);
  });
});

// ── Input validation ──────────────────────────────────────────────────────

describe("Broadcast — input validation", () => {
  let adminApp: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    adminApp = createTestApp({
      id: 1,
      username: "admin",
      role: "org_admin",
      organizationId: testOrgId,
    });
  });

  it("returns 400 when body is missing", async () => {
    const res = await request(adminApp)
      .post(`/api/organizations/${testOrgId}/messages/broadcast`)
      .send({ tournamentId: testTournamentId, channels: ["email"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/body/i);
  });

  it("returns 400 when body is whitespace-only", async () => {
    const res = await request(adminApp)
      .post(`/api/organizations/${testOrgId}/messages/broadcast`)
      .send({ body: "   ", tournamentId: testTournamentId, channels: ["email"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/body/i);
  });
});

// ── Tournament-level broadcast ────────────────────────────────────────────

describe("Broadcast — tournament routing", () => {
  let adminApp: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    adminApp = createTestApp({
      id: 1,
      username: "admin",
      role: "org_admin",
      organizationId: testOrgId,
    });
  });

  it("returns 404 when tournament does not belong to the org", async () => {
    const res = await request(adminApp)
      .post(`/api/organizations/${testOrgId}/messages/broadcast`)
      .send({
        body: "Hello players",
        tournamentId: 999999,
        channels: ["email"],
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/tournament/i);
  });

  it("returns 404 when a non-existent flightId is specified", async () => {
    const res = await request(adminApp)
      .post(`/api/organizations/${testOrgId}/messages/broadcast`)
      .send({
        body: "Hello flight",
        tournamentId: testTournamentId,
        flightId: "999999",
        channels: ["email"],
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/flight/i);
  });

  it("succeeds with 0 recipients when tournament has no players", async () => {
    const res = await request(adminApp)
      .post(`/api/organizations/${testOrgId}/messages/broadcast`)
      .send({
        subject: "Empty Broadcast",
        body: "Test message for empty tournament",
        tournamentId: testTournamentId,
        channels: ["email"],
      });
    // 200 with { ok: true, messageId, recipientCount: 0 }
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.messageId).toBe("number");
    expect(res.body.recipientCount).toBe(0);
  });
});

// ── League-level broadcast ────────────────────────────────────────────────

describe("Broadcast — league routing", () => {
  let adminApp: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    adminApp = createTestApp({
      id: 1,
      username: "admin",
      role: "org_admin",
      organizationId: testOrgId,
    });
  });

  it("returns 404 when league does not belong to the org", async () => {
    const res = await request(adminApp)
      .post(`/api/organizations/${testOrgId}/messages/broadcast`)
      .send({
        body: "Hello members",
        leagueId: 999999,
        channels: ["email"],
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/league/i);
  });

  it("succeeds with 0 recipients when league has no members", async () => {
    const res = await request(adminApp)
      .post(`/api/organizations/${testOrgId}/messages/broadcast`)
      .send({
        subject: "League Broadcast",
        body: "Test message for empty league",
        leagueId: testLeagueId,
        channels: ["email"],
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.recipientCount).toBe(0);
  });
});

// ── Org-wide broadcast (no tournamentId/leagueId) ────────────────────────

describe("Broadcast — org-wide routing", () => {
  it("succeeds for super_admin with no event filter", async () => {
    const app = createTestApp({
      id: 1,
      username: "superadmin",
      role: "super_admin",
    });

    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/messages/broadcast`)
      .send({
        body: "Org-wide announcement",
        channels: ["email"],
        // No tournamentId or leagueId → org-wide
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.recipientCount).toBe("number");
  });
});
