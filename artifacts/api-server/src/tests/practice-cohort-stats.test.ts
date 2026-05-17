// Task #2044 — integration coverage for the tip-driven vs manual practice
// A/B endpoints. Player A: tip-cohort 7i, +30 ft improvement. Player B:
// manual-cohort 7i, +3 ft improvement.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  playersTable,
  organizationsTable,
  coursesTable,
  tournamentsTable,
  shotsTable,
  practiceSessionsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let adminUserId: number;
let playerAUserId: number;
let playerAPlayerId: number;
let playerBUserId: number;
let playerBPlayerId: number;
let playerAUser: TestUser;
let adminUser: TestUser;

// Canonical engine clubKey ("7i") must match what we write into practice_sessions.
const CLUB_KEY = "7i";
const CLUB_LABEL = "7 Iron";

// Seed approach+putt pairs; putt yards drive the player's mean proximity.
async function seedShots(opts: {
  playerId: number;
  userId: number;
  proximityYds: number;
  count: number;
  holeOffset: number;
  recordedAt: Date;
}) {
  const rows: Array<typeof shotsTable.$inferInsert> = [];
  for (let i = 0; i < opts.count; i++) {
    const hole = opts.holeOffset + i + 1;
    rows.push({
      tournamentId,
      playerId: opts.playerId,
      userId: opts.userId,
      round: 1,
      holeNumber: hole,
      shotNumber: 1,
      shotType: "approach",
      club: CLUB_LABEL,
      distanceToPin: "150",
      distanceCarried: "150",
      recordedAt: opts.recordedAt,
    });
    rows.push({
      tournamentId,
      playerId: opts.playerId,
      userId: opts.userId,
      round: 1,
      holeNumber: hole,
      shotNumber: 2,
      shotType: "putt",
      distanceToPin: String(opts.proximityYds),
      recordedAt: new Date(opts.recordedAt.getTime() + 60_000),
    });
  }
  await db.insert(shotsTable).values(rows);
}

beforeAll(async () => {
  const tag = uid("cohort2044");

  const [org] = await db.insert(organizationsTable).values({
    name: `Cohort2044_${tag}`,
    slug: `cohort-2044-${tag}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Cohort 2044 Course",
    slug: `cohort-2044-course-${tag}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `Cohort 2044 ${tag}`,
    format: "stroke_play",
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  // Org admin (drives the admin endpoint).
  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin`,
    username: `${tag}_admin`,
    email: `${tag}_admin@test.local`,
    displayName: "Cohort Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = admin.id;
  adminUser = { id: adminUserId, username: `${tag}_admin`, role: "org_admin", organizationId: orgId };

  const [pA] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-pA`,
    username: `${tag}_pA`,
    email: `${tag}_pA@test.local`,
    displayName: "Cohort Player A",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  playerAUserId = pA.id;
  playerAUser = { id: playerAUserId, username: `${tag}_pA`, role: "player", organizationId: orgId };
  const [pARow] = await db.insert(playersTable).values({
    tournamentId,
    userId: playerAUserId,
    firstName: "Cohort",
    lastName: "PlayerA",
  }).returning({ id: playersTable.id });
  playerAPlayerId = pARow.id;

  const [pB] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-pB`,
    username: `${tag}_pB`,
    email: `${tag}_pB@test.local`,
    displayName: "Cohort Player B",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  playerBUserId = pB.id;
  const [pBRow] = await db.insert(playersTable).values({
    tournamentId,
    userId: playerBUserId,
    firstName: "Cohort",
    lastName: "PlayerB",
  }).returning({ id: playersTable.id });
  playerBPlayerId = pBRow.id;

  // T-3d anchor keeps every row safely inside the default 30-day window.
  const inWindow = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  const sessionRows: Array<typeof practiceSessionsTable.$inferInsert> = [];
  // Player A: 4 tip + 1 manual = tip-cohort.
  for (let i = 0; i < 4; i++) {
    sessionRows.push({
      userId: playerAUserId,
      organizationId: orgId,
      sessionType: "range",
      durationMinutes: 30,
      source: "coaching_tip",
      clubKey: CLUB_KEY,
      sessionDate: new Date(inWindow.getTime() + i * 60_000),
    });
  }
  sessionRows.push({
    userId: playerAUserId,
    organizationId: orgId,
    sessionType: "range",
    durationMinutes: 20,
    source: "manual",
    clubKey: CLUB_KEY,
    sessionDate: inWindow,
  });
  // Player B: 1 tip + 4 manual = manual-cohort.
  sessionRows.push({
    userId: playerBUserId,
    organizationId: orgId,
    sessionType: "range",
    durationMinutes: 30,
    source: "coaching_tip",
    clubKey: CLUB_KEY,
    sessionDate: inWindow,
  });
  for (let i = 0; i < 4; i++) {
    sessionRows.push({
      userId: playerBUserId,
      organizationId: orgId,
      sessionType: "range",
      durationMinutes: 25,
      source: "manual",
      clubKey: CLUB_KEY,
      sessionDate: new Date(inWindow.getTime() + i * 60_000),
    });
  }
  await db.insert(practiceSessionsTable).values(sessionRows);

  // Putt yards × 3 = proximity ft. A: 60→30 (+30 ft); B: 39→36 (+3 ft).
  const inCurrent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const inPrior = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  await seedShots({ playerId: playerAPlayerId, userId: playerAUserId, proximityYds: 10, count: 4, holeOffset: 0, recordedAt: inCurrent });
  await seedShots({ playerId: playerAPlayerId, userId: playerAUserId, proximityYds: 20, count: 4, holeOffset: 10, recordedAt: inPrior });
  await seedShots({ playerId: playerBPlayerId, userId: playerBUserId, proximityYds: 12, count: 4, holeOffset: 0, recordedAt: inCurrent });
  await seedShots({ playerId: playerBPlayerId, userId: playerBUserId, proximityYds: 13, count: 4, holeOffset: 10, recordedAt: inPrior });
});

afterAll(async () => {
  await db.delete(shotsTable).where(inArray(shotsTable.userId, [playerAUserId, playerBUserId]));
  await db.delete(practiceSessionsTable).where(inArray(practiceSessionsTable.userId, [playerAUserId, playerBUserId]));
  await db.delete(playersTable).where(inArray(playersTable.id, [playerAPlayerId, playerBPlayerId]));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminUserId, playerAUserId, playerBUserId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("Task #2044 — practice cohort A/B endpoints", () => {
  it("player endpoint reports tip-cohort improvement and tags the byClub row", async () => {
    const app = createTestApp(playerAUser);
    const res = await request(app)
      .get("/api/portal/practice/cohort-stats")
      .expect(200);

    expect(res.body.summary.tipDrivenSessions).toBe(4);
    expect(res.body.summary.manualSessions).toBe(1);
    expect(res.body.summary.tipCohortClubs).toBe(1);
    expect(res.body.summary.manualCohortClubs).toBe(0);
    expect(res.body.summary.tipCohortAvgImprovementFt).toBeCloseTo(30, 1);
    expect(res.body.summary.manualCohortAvgImprovementFt).toBeNull();

    const ironRow = (res.body.byClub as Array<{ clubKey: string; cohort: string; proximityImprovementFt: number | null }>)
      .find(r => r.clubKey === CLUB_KEY);
    expect(ironRow).toBeTruthy();
    expect(ironRow!.cohort).toBe("tip");
    expect(ironRow!.proximityImprovementFt).toBeCloseTo(30, 1);
  });

  it("admin endpoint splits proximity gain per club between tip and manual cohorts", async () => {
    const app = createTestApp(adminUser);
    const res = await request(app)
      .get("/api/portal/admin/practice/cohort-stats")
      .expect(200);

    expect(res.body.summary.tipCohortPlayerClubs).toBe(1);
    expect(res.body.summary.manualCohortPlayerClubs).toBe(1);
    expect(res.body.summary.tipCohortAvgImprovementFt).toBeCloseTo(30, 1);
    expect(res.body.summary.manualCohortAvgImprovementFt).toBeCloseTo(3, 1);

    const ironRow = (res.body.byClub as Array<{
      clubKey: string;
      tipCohortPlayers: number;
      manualCohortPlayers: number;
      tipCohortMeanImprovementFt: number | null;
      manualCohortMeanImprovementFt: number | null;
    }>).find(r => r.clubKey === CLUB_KEY);
    expect(ironRow).toBeTruthy();
    expect(ironRow!.tipCohortPlayers).toBe(1);
    expect(ironRow!.manualCohortPlayers).toBe(1);
    expect(ironRow!.tipCohortMeanImprovementFt).toBeCloseTo(30, 1);
    expect(ironRow!.manualCohortMeanImprovementFt).toBeCloseTo(3, 1);
  });

  it("admin endpoint honours the clubKey filter without dropping cohort assignment", async () => {
    const app = createTestApp(adminUser);
    const res = await request(app)
      .get("/api/portal/admin/practice/cohort-stats")
      .query({ clubKey: CLUB_KEY })
      .expect(200);

    expect(res.body.clubKeyFilter).toBe(CLUB_KEY);
    expect(res.body.summary.tipCohortPlayerClubs).toBe(1);
    expect(res.body.summary.manualCohortPlayerClubs).toBe(1);
    expect(res.body.byClub).toHaveLength(1);
    expect(res.body.byClub[0].clubKey).toBe(CLUB_KEY);
  });
});
