/**
 * Task #1038 — Automated tests for the team-match playoff format setting.
 *
 * Covers:
 *   1. POST /ryder-cup/config persists each accepted `tieBreakRule` value
 *      ("sudden_death", "extra_holes_3", "none") and rejects invalid values
 *      with HTTP 400.
 *   2. POST /ryder-cup/matches/:matchId/hole enforces the configured rule
 *      for holes beyond regulation (>18):
 *        - rule = "none"           → any hole > 18 rejected with 400
 *        - rule = "extra_holes_3"  → holes 19-21 accepted, hole 22 rejected
 *        - rule = "sudden_death"   → hole 19 accepted (no upper cap)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../lib/realtime", () => ({
  notifyLeaderboardUpdate: vi.fn(),
  broadcastBracketUpdate: vi.fn(),
  broadcastRyderCupUpdate: vi.fn(),
}));

import request from "supertest";
import {
  db,
  organizationsTable,
  coursesTable,
  tournamentsTable,
  ryderCupConfigTable,
  ryderCupSessionsTable,
  ryderCupMatchesTable,
  appUsersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let sessionId: number;
let matchId: number;
let adminUserId: number;
let admin: TestUser;

beforeAll(async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `T1038_${suffix}`,
    slug: `t1038-${suffix}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T1038 Course",
    slug: `t1038-course-${suffix}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T1038 Ryder Cup ${suffix}`,
    format: "stroke_play",
    status: "active",
    rounds: 1,
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `t1038_admin_${suffix}`,
    username: `t1038_admin_${suffix}`,
    email: `t1038_admin_${suffix}@example.test`,
    displayName: "T1038 Admin",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  adminUserId = user.id;

  admin = {
    id: adminUserId,
    username: `t1038_admin_${suffix}`,
    displayName: "T1038 Admin",
    role: "super_admin",
  };
});

afterAll(async () => {
  await db.delete(ryderCupMatchesTable).where(eq(ryderCupMatchesTable.tournamentId, tournamentId));
  await db.delete(ryderCupSessionsTable).where(eq(ryderCupSessionsTable.tournamentId, tournamentId));
  await db.delete(ryderCupConfigTable).where(eq(ryderCupConfigTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminUserId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

async function postConfig(body: Record<string, unknown>) {
  const app = createTestApp(admin);
  return request(app)
    .post(`/api/organizations/${orgId}/tournaments/${tournamentId}/ryder-cup/config`)
    .send({ team1Name: "Team A", team2Name: "Team B", totalPoints: 28, ...body });
}

async function setRule(rule: "sudden_death" | "extra_holes_3" | "none") {
  await db.update(ryderCupConfigTable)
    .set({ tieBreakRule: rule })
    .where(eq(ryderCupConfigTable.tournamentId, tournamentId));
}

async function ensureMatch() {
  if (sessionId && matchId) return;
  const [s] = await db.insert(ryderCupSessionsTable).values({
    tournamentId,
    sessionNumber: 1,
    sessionType: "singles",
    name: "Singles",
  }).returning({ id: ryderCupSessionsTable.id });
  sessionId = s.id;
  const [m] = await db.insert(ryderCupMatchesTable).values({
    sessionId,
    tournamentId,
    matchNumber: 1,
  }).returning({ id: ryderCupMatchesTable.id });
  matchId = m.id;
}

async function postHole(holeNumber: number, holeResult: "team1" | "team2" | "halved" = "halved") {
  const app = createTestApp(admin);
  return request(app)
    .post(`/api/organizations/${orgId}/tournaments/${tournamentId}/ryder-cup/matches/${matchId}/hole`)
    .send({ holeNumber, holeResult });
}

describe("POST /ryder-cup/config — tieBreakRule persistence + validation", () => {
  it.each(["sudden_death", "extra_holes_3", "none"] as const)(
    "saves tieBreakRule = %s and persists it on the config row",
    async (rule) => {
      const res = await postConfig({ tieBreakRule: rule });
      expect(res.status).toBe(200);
      expect(res.body.config.tieBreakRule).toBe(rule);

      const [row] = await db.select({ tieBreakRule: ryderCupConfigTable.tieBreakRule })
        .from(ryderCupConfigTable)
        .where(eq(ryderCupConfigTable.tournamentId, tournamentId));
      expect(row.tieBreakRule).toBe(rule);
    },
  );

  it("rejects an unknown tieBreakRule with HTTP 400 and does not mutate the existing rule", async () => {
    await setRule("sudden_death");
    const res = await postConfig({ tieBreakRule: "coin_flip" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tieBreakRule/i);

    const [row] = await db.select({ tieBreakRule: ryderCupConfigTable.tieBreakRule })
      .from(ryderCupConfigTable)
      .where(eq(ryderCupConfigTable.tournamentId, tournamentId));
    expect(row.tieBreakRule).toBe("sudden_death");
  });

  it("preserves the existing tieBreakRule when the field is omitted from the payload", async () => {
    await setRule("extra_holes_3");
    const res = await postConfig({});
    expect(res.status).toBe(200);

    const [row] = await db.select({ tieBreakRule: ryderCupConfigTable.tieBreakRule })
      .from(ryderCupConfigTable)
      .where(eq(ryderCupConfigTable.tournamentId, tournamentId));
    expect(row.tieBreakRule).toBe("extra_holes_3");
  });
});

describe("POST /ryder-cup/matches/:matchId/hole — playoff-hole rule enforcement", () => {
  beforeAll(async () => {
    await ensureMatch();
  });

  it("accepts holes 1-18 regardless of the configured rule", async () => {
    await setRule("none");
    const res = await postHole(18);
    expect(res.status).toBe(200);
  });

  it("rejects any playoff hole (>18) when tieBreakRule = 'none'", async () => {
    await setRule("none");
    const res = await postHole(19);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disabled/i);
  });

  it("caps the 3-hole aggregate playoff at hole 21 when tieBreakRule = 'extra_holes_3'", async () => {
    await setRule("extra_holes_3");

    const res19 = await postHole(19);
    expect(res19.status).toBe(200);

    const res21 = await postHole(21);
    expect(res21.status).toBe(200);

    const res22 = await postHole(22);
    expect(res22.status).toBe(400);
    expect(res22.body.error).toMatch(/21/);
  });

  it("allows playoff holes (including hole 19 and beyond 21) when tieBreakRule = 'sudden_death'", async () => {
    await setRule("sudden_death");
    const res19 = await postHole(19);
    expect(res19.status).toBe(200);
    const res22 = await postHole(22);
    expect(res22.status).toBe(200);
  });
});
