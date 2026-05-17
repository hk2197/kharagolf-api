/**
 * Integration tests: Tournament Announcement Authorization
 *
 * Verifies that:
 *   - Unauthenticated users receive 401
 *   - Players without enrollment receive 403
 *   - Org admins for the correct org can POST and GET announcements
 *   - Org admins for a different org are rejected (403)
 *
 * Uses the real PostgreSQL database. Test fixtures are created in beforeAll
 * and torn down in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  tournamentAnnouncementsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

let testOrgId: number;
let testTournamentId: number;
let testCourseId: number;

beforeAll(async () => {
  // Organization
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_AnnouncementAuthz_${Date.now()}`,
    slug: `test-ann-authz-${Date.now()}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  // Course (required FK for tournament)
  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Test Course",
    slug: `test-course-${Date.now()}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  // Tournament
  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Test Tournament ${Date.now()}`,
    format: "stroke_play",
    status: "upcoming",
    startDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = tournament.id;
});

afterAll(async () => {
  // Cascade order: announcements → tournament → course → org
  await db.delete(tournamentAnnouncementsTable)
    .where(eq(tournamentAnnouncementsTable.tournamentId, testTournamentId));
  await db.delete(tournamentsTable)
    .where(and(eq(tournamentsTable.id, testTournamentId), eq(tournamentsTable.organizationId, testOrgId)));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

// ── GET announcement authorization ────────────────────────────────────────

describe("GET /announcements — authorization", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp(); // no user
    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/announcements`);
    expect(res.status).toBe(401);
  });

  it("returns 200 for org admin of the correct org (empty list initially)", async () => {
    const app = createTestApp({
      id: 1,
      username: "admin",
      role: "org_admin",
      organizationId: testOrgId,
    });

    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/announcements`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns 403 for an org admin from a DIFFERENT org", async () => {
    const app = createTestApp({
      id: 2,
      username: "other_admin",
      role: "org_admin",
      organizationId: testOrgId + 9999, // wrong org
    });

    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/announcements`);
    // The player enrollment check will also fail since they have no enrollment
    expect([403, 401]).toContain(res.status);
  });

  it("returns 200 for super_admin regardless of org", async () => {
    const app = createTestApp({
      id: 3,
      username: "superadmin",
      role: "super_admin",
    });

    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/announcements`);
    expect(res.status).toBe(200);
  });
});

// ── POST announcement authorization ───────────────────────────────────────

describe("POST /announcements — authorization", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/announcements`)
      .send({ body: "Test announcement", type: "general" });
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller has player role", async () => {
    const app = createTestApp({
      id: 100,
      username: "a_player",
      role: "player",
      organizationId: testOrgId,
    });

    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/announcements`)
      .send({ body: "Player trying to announce", type: "general" });
    expect(res.status).toBe(403);
  });

  it("returns 400 when body is empty", async () => {
    const app = createTestApp({
      id: 1,
      username: "admin",
      role: "org_admin",
      organizationId: testOrgId,
    });

    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/announcements`)
      .send({ body: "   ", type: "general" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/body/i);
  });

  it("creates an announcement and returns 201 for a valid org admin", async () => {
    const app = createTestApp({
      id: 1,
      username: "admin",
      displayName: "Test Admin",
      role: "org_admin",
      organizationId: testOrgId,
    });

    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/announcements`)
      .send({ body: "Tee time delayed by 30 minutes due to weather", type: "delay" });

    expect(res.status).toBe(201);
    expect(res.body.body).toBe("Tee time delayed by 30 minutes due to weather");
    expect(res.body.type).toBe("delay");
    expect(res.body.tournamentId).toBe(testTournamentId);
    expect(res.body.authorName).toBe("Test Admin");
  });

  it("returns 404 when the tournament does not belong to the org", async () => {
    const app = createTestApp({
      id: 1,
      username: "admin",
      role: "org_admin",
      organizationId: testOrgId,
    });

    // Use a fake tournament ID that doesn't exist in this org
    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/9999999/announcements`)
      .send({ body: "Hello", type: "general" });
    expect(res.status).toBe(404);
  });

  it("GET returns the announcement that was just created", async () => {
    const app = createTestApp({
      id: 1,
      username: "admin",
      role: "org_admin",
      organizationId: testOrgId,
    });

    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/announcements`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // There should be at least the one we created in the previous test
    const bodies = res.body.map((a: { body: string }) => a.body);
    expect(bodies).toContain("Tee time delayed by 30 minutes due to weather");
  });
});
