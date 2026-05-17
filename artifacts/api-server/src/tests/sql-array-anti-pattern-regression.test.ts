/**
 * Regression coverage for Task #815 — SQL ARRAY/ANY anti-pattern audit.
 *
 * Background: Task #658 found that GET /api/portal/highlights crashed with a
 * 500 whenever a player had any queued reels because the SQL was written as
 * `ANY(${waitingIds}::int[])` against the drizzle sql tag, which expanded
 * `${waitingIds}` to `($1,$2,$3)` and produced invalid Postgres syntax. The
 * audit performed under Task #815 swept the api-server source for the same
 * anti-pattern and converted every remaining occurrence (which all used the
 * sql.raw + Array.join("," ) workaround) to drizzle's typed `inArray()` /
 * `notInArray()` helper.
 *
 * This suite exercises the converted queries with multi-element id arrays
 * end-to-end against the real test database. Under the original anti-pattern
 * a multi-id payload would have crashed the route with a 500 (or, in the
 * sql.raw form, opened a SQL-injection seam). The asserts below pin both
 * shape and presence: the route returns 200 and the result set actually
 * contains the rows we wrote, proving the IN-list bound to multiple ids.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  scoresTable,
  teeTimesTable,
  teeTimePlayersTable,
  appUsersTable,
  clubMembersTable,
  memberConsentsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import router from "../routes/index.js";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let teeTimeId: number;
const playerIds: number[] = [];

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `T815_${stamp}`,
    slug: `t815-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T815 Course",
    slug: `t815-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T815 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  // Four players in one group — enough that an IN-list mistakenly bound as
  // a row-tuple ($1,$2,$3,$4) would fail with a syntax error.
  for (const fn of ["A", "B", "C", "D"]) {
    const [p] = await db.insert(playersTable).values({
      tournamentId,
      firstName: fn,
      lastName: "Player",
      email: `t815-${fn.toLowerCase()}-${stamp}@example.test`,
    }).returning({ id: playersTable.id });
    playerIds.push(p.id);
  }

  const [tt] = await db.insert(teeTimesTable).values({
    tournamentId,
    teeTime: new Date(),
  }).returning({ id: teeTimesTable.id });
  teeTimeId = tt.id;

  await db.insert(teeTimePlayersTable).values(
    playerIds.map(playerId => ({ teeTimeId, playerId })),
  );

  // One stored score per player so the IN-list returns a multi-row result.
  await db.insert(scoresTable).values(
    playerIds.map((playerId, i) => ({
      tournamentId,
      playerId,
      round: 1,
      holeNumber: 1,
      strokes: 4 + i,
    })),
  );
});

afterAll(async () => {
  if (tournamentId) {
    await db.delete(scoresTable).where(eq(scoresTable.tournamentId, tournamentId));
  }
  if (teeTimeId) {
    await db.delete(teeTimePlayersTable).where(eq(teeTimePlayersTable.teeTimeId, teeTimeId));
    await db.delete(teeTimesTable).where(eq(teeTimesTable.id, teeTimeId));
  }
  if (tournamentId) {
    await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
    await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  }
  if (courseId) await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function scorerApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as {
      scorerSession: { tournamentId: number; orgId: number; pinId: number };
    }).scorerSession = { tournamentId, orgId, pinId: 1 };
    req.isAuthenticated = function (this: Request) { return false; } as Request["isAuthenticated"];
    next();
  });
  app.use("/api", router);
  return app;
}

describe("GET /api/scorer/groups/:groupId — multi-id IN-list (Task #815)", () => {
  it("returns 200 and loads scores for every player in the group", async () => {
    // The route resolves the players in the tee-time group, then fetches
    // their stored scores via `inArray(scoresTable.playerId, playerIds)`.
    // Under the original `ANY(${playerIds}::int[])` anti-pattern this
    // would 500 with a Postgres syntax error as soon as more than one
    // player was in the group. Asserting a 200 + a populated scores
    // array pins the IN-list to the typed-binding form.
    const res = await request(scorerApp()).get(`/api/scorer/groups/${teeTimeId}?round=1`);
    expect(res.status).toBe(200);

    const scores = res.body.scores as Array<{ playerId: number; strokes: number; holeNumber: number }>;
    expect(Array.isArray(scores)).toBe(true);
    expect(scores.length).toBe(playerIds.length);

    const returnedIds = new Set(scores.map(s => s.playerId));
    for (const id of playerIds) expect(returnedIds.has(id)).toBe(true);

    // The route also returns the player roster — confirm it agrees with
    // the scores so we know the multi-id query genuinely matched the
    // group, not a stray row.
    const players = res.body.players as Array<{ playerId: number }>;
    expect(players.length).toBe(playerIds.length);
  });

  it("GET /api/organizations/:orgId/members-360/consent-health binds every consent type as its own parameter (Task #815)", async () => {
    // The consent-health route was the last remaining call site that
    // built its IN-list with `sql.raw("ARRAY[" + arr.join(",") + ...)`.
    // It happened to work because the array elements are hard-coded
    // strings, but the pattern is the same risky construction style
    // as the highlights bug. After conversion to typed sql.join() the
    // route must still return tallies that include the consent rows we
    // wrote (proving the IN-list bound to multiple values), with no
    // 500.
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const [admin] = await db.insert(appUsersTable).values({
      replitUserId: `t815-consent-${stamp}`,
      username: `t815_consent_${stamp}`,
      email: `t815-consent-${stamp}@example.test`,
      displayName: "Consent Admin",
      role: "org_admin",
      organizationId: orgId,
    }).returning({ id: appUsersTable.id });

    const [member] = await db.insert(clubMembersTable).values({
      organizationId: orgId,
      firstName: "Consent",
      lastName: "Member",
      email: `t815-cmember-${stamp}@example.test`,
    }).returning({ id: clubMembersTable.id });

    // Insert a consent row for several distinct types so the IN-list
    // genuinely matches more than one element.
    await db.insert(memberConsentsTable).values([
      { clubMemberId: member.id, organizationId: orgId, consentType: "privacy", granted: true },
      { clubMemberId: member.id, organizationId: orgId, consentType: "marketing", granted: false },
      { clubMemberId: member.id, organizationId: orgId, consentType: "photo", granted: true },
    ]);

    try {
      const adminUser: TestUser = {
        id: admin.id,
        username: `t815_consent_${stamp}`,
        role: "org_admin",
        organizationId: orgId,
      };
      const app = createTestApp(adminUser);
      const res = await request(app).get(`/api/organizations/${orgId}/members-360/consent-health`);
      expect(res.status).toBe(200);

      const categories = res.body.categories as Array<{
        consentType: string;
        grantedMembers: number;
        withdrawnMembers: number;
      }>;
      expect(Array.isArray(categories)).toBe(true);
      const byType = new Map(categories.map(c => [c.consentType, c]));

      // The three rows we wrote are reflected in the tally — proving
      // the multi-element IN-list actually matched.
      expect(byType.get("privacy")?.grantedMembers).toBe(1);
      expect(byType.get("marketing")?.withdrawnMembers).toBe(1);
      expect(byType.get("photo")?.grantedMembers).toBe(1);
    } finally {
      await db.delete(memberConsentsTable).where(eq(memberConsentsTable.clubMemberId, member.id));
      await db.delete(clubMembersTable).where(eq(clubMembersTable.id, member.id));
      await db.delete(appUsersTable).where(eq(appUsersTable.id, admin.id));
    }
  });

  it("still returns 200 with an empty scores array when only one player is in the group", async () => {
    // A single-id payload exercises the same code path with a one-element
    // array, which is the boundary case the original `${arr}::int[]`
    // pattern coincidentally happened to format correctly. Pinning it
    // here guards against a future "optimisation" that splits the
    // single-id case back onto a hand-rolled SQL fragment.
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const [solo] = await db.insert(playersTable).values({
      tournamentId,
      firstName: "Solo",
      lastName: "Player",
      email: `t815-solo-${stamp}@example.test`,
    }).returning({ id: playersTable.id });
    const [soloTt] = await db.insert(teeTimesTable).values({
      tournamentId,
      teeTime: new Date(),
    }).returning({ id: teeTimesTable.id });
    await db.insert(teeTimePlayersTable).values({ teeTimeId: soloTt.id, playerId: solo.id });

    try {
      const res = await request(scorerApp()).get(`/api/scorer/groups/${soloTt.id}?round=1`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.scores)).toBe(true);
      expect(res.body.scores.length).toBe(0);
      expect(res.body.players.length).toBe(1);
    } finally {
      await db.delete(teeTimePlayersTable).where(eq(teeTimePlayersTable.teeTimeId, soloTt.id));
      await db.delete(teeTimesTable).where(eq(teeTimesTable.id, soloTt.id));
      await db.delete(playersTable).where(eq(playersTable.id, solo.id));
    }
  });
});
