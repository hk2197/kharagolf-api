/**
 * Task #1175 — GET /api/organizations/:orgId/tournaments/:tid/survey/responses
 *
 * Pins the contract for the post-event survey responses endpoint that powers
 * the "Survey responses" panel on the tournament admin page. Covers:
 *   • Empty case — no survey ever sent → returns survey: null + zero counts.
 *   • Aggregation — rating averages + distribution, boolean tallies, text
 *     answer collection ordered by submission time (newest first).
 *   • IDOR — admin of org A cannot read responses for a tournament in org B.
 *   • AuthZ — regular players are rejected with 403.
 *   • Auth — unauthenticated callers are rejected with 401.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  tournamentsTable,
  postEventSurveysTable,
  postEventSurveyResponsesTable,
  playersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAUser: TestUser;
let adminBUser: TestUser;
let playerUser: TestUser;
let tournamentWithSurveyId: number;
let tournamentNoSurveyId: number;
let tournamentOrgBId: number;
let surveyId: number;
const userIdsToCleanup: number[] = [];

beforeAll(async () => {
  const stamp = uid("t1175");

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1175 A ${stamp}`, slug: `t1175a-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1175 B ${stamp}`, slug: `t1175b-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [aAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `t1175-admA-${stamp}`,
    username: `t1175_admA_${stamp}`,
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userIdsToCleanup.push(aAdmin.id);
  adminAUser = { id: aAdmin.id, username: `admA_${stamp}`, role: "org_admin", organizationId: orgAId };

  const [bAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `t1175-admB-${stamp}`,
    username: `t1175_admB_${stamp}`,
    role: "org_admin",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  userIdsToCleanup.push(bAdmin.id);
  adminBUser = { id: bAdmin.id, username: `admB_${stamp}`, role: "org_admin", organizationId: orgBId };

  const [pl] = await db.insert(appUsersTable).values({
    replitUserId: `t1175-pl-${stamp}`,
    username: `t1175_pl_${stamp}`,
    // Task #1633 — pin a stable display name so the respondent column on the
    // CSV/JSON exports is predictable in the assertions below.
    displayName: "Player Alice",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userIdsToCleanup.push(pl.id);
  playerUser = { id: pl.id, username: `pl_${stamp}`, role: "player", organizationId: orgAId };

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgAId, userId: adminAUser.id, role: "org_admin" },
    { organizationId: orgBId, userId: adminBUser.id, role: "org_admin" },
    { organizationId: orgAId, userId: playerUser.id, role: "player" },
  ]);

  const [tWith] = await db.insert(tournamentsTable).values({
    organizationId: orgAId, name: `T1175 with-survey ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  tournamentWithSurveyId = tWith.id;

  const [tNo] = await db.insert(tournamentsTable).values({
    organizationId: orgAId, name: `T1175 no-survey ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  tournamentNoSurveyId = tNo.id;

  const [tB] = await db.insert(tournamentsTable).values({
    organizationId: orgBId, name: `T1175 orgB ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  tournamentOrgBId = tB.id;

  // Eligible pool for the with-survey tournament (Task #1626) — register
  // four players so the response rate works out to 3/4 (75%) below.
  await db.insert(playersTable).values([
    { tournamentId: tournamentWithSurveyId, firstName: "Alice", lastName: "A", userId: playerUser.id },
    { tournamentId: tournamentWithSurveyId, firstName: "Bob", lastName: "B" },
    { tournamentId: tournamentWithSurveyId, firstName: "Cara", lastName: "C" },
    { tournamentId: tournamentWithSurveyId, firstName: "Dan", lastName: "D" },
  ]);

  const questions = [
    { id: "overall", prompt: "Overall experience", type: "rating" as const },
    { id: "comeback", prompt: "Would you play again?", type: "boolean" as const },
    { id: "comments", prompt: "Any comments?", type: "text" as const },
  ];

  const [survey] = await db.insert(postEventSurveysTable).values({
    tournamentId: tournamentWithSurveyId,
    organizationId: orgAId,
    questions,
    sentAt: new Date("2026-04-01T10:00:00Z"),
  }).returning({ id: postEventSurveysTable.id });
  surveyId = survey.id;

  // Three responses with mixed answers to exercise every aggregation branch.
  await db.insert(postEventSurveyResponsesTable).values([
    {
      surveyId,
      userId: playerUser.id,
      answers: { overall: 5, comeback: true, comments: "Loved the format!" },
      submittedAt: new Date("2026-04-02T09:00:00Z"),
    },
    {
      surveyId,
      userId: null,
      answers: { overall: 4, comeback: "yes", comments: "Pace was a bit slow on the back nine." },
      submittedAt: new Date("2026-04-02T10:00:00Z"),
    },
    {
      surveyId,
      userId: null,
      answers: { overall: 3, comeback: false, comments: "" },
      submittedAt: new Date("2026-04-02T11:00:00Z"),
    },
  ]);
});

afterAll(async () => {
  await db.delete(postEventSurveyResponsesTable).where(eq(postEventSurveyResponsesTable.surveyId, surveyId));
  await db.delete(postEventSurveysTable).where(eq(postEventSurveysTable.id, surveyId));
  await db.delete(playersTable).where(inArray(playersTable.tournamentId, [tournamentWithSurveyId, tournamentNoSurveyId, tournamentOrgBId]));
  await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, [tournamentWithSurveyId, tournamentNoSurveyId, tournamentOrgBId]));
  await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, userIdsToCleanup));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIdsToCleanup));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgAId, orgBId]));
});

describe("GET /api/organizations/:orgId/tournaments/:tid/survey/responses", () => {
  it("aggregates ratings, booleans and text answers for an org admin", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses`);

    expect(res.status).toBe(200);
    expect(res.body.survey).toBeTruthy();
    expect(res.body.survey.id).toBe(surveyId);
    expect(res.body.totalResponses).toBe(3);
    // Task #1626 — denominator for the response-rate display.
    expect(res.body.eligiblePlayers).toBe(4);

    const byId = Object.fromEntries(res.body.aggregates.map((a: { id: string }) => [a.id, a]));

    // rating
    expect(byId.overall.type).toBe("rating");
    expect(byId.overall.count).toBe(3);
    expect(byId.overall.average).toBeCloseTo(4, 5); // (5+4+3)/3
    expect(byId.overall.distribution).toEqual({ "5": 1, "4": 1, "3": 1 });
    expect(byId.overall.label).toBe("Overall experience");

    // boolean — accepts both literal true/false and the string "yes"/"no".
    expect(byId.comeback.type).toBe("boolean");
    expect(byId.comeback.yes).toBe(2);
    expect(byId.comeback.no).toBe(1);
    expect(byId.comeback.count).toBe(3);

    // text — empty/whitespace answers are filtered out, newest first.
    expect(byId.comments.type).toBe("text");
    expect(byId.comments.count).toBe(2);
    expect(byId.comments.answers.map((a: { text: string }) => a.text)).toEqual([
      "Pace was a bit slow on the back nine.",
      "Loved the format!",
    ]);

    // Task #1633 — every text answer is tagged with the respondent's display
    // name (or "Anonymous" when userId is null) so committees can follow up.
    expect(byId.comments.answers.map((a: { respondent: string }) => a.respondent)).toEqual([
      "Anonymous",
      "Player Alice",
    ]);
  });

  it("returns survey: null when no survey has been sent for the tournament", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentNoSurveyId}/survey/responses`);

    expect(res.status).toBe(200);
    // Even before any survey is sent, the eligible-pool denominator is
    // returned (zero here — no players registered for tNo).
    expect(res.body).toEqual({ survey: null, totalResponses: 0, eligiblePlayers: 0, aggregates: [] });
  });

  it("blocks an admin of a different org via 404 (tournament not in their org)", async () => {
    // adminA tries to read a tournament that lives in orgB.
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentOrgBId}/survey/responses`);

    expect(res.status).toBe(404);
  });

  it("rejects non-admin players with 403", async () => {
    const app = createTestApp(playerUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses`);

    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses`);

    expect(res.status).toBe(401);
  });
});

// Task #2028 — lightweight windowed-count companion to /survey/responses.
// The admin panel uses this to render "X of Y responses in window" next to
// the export date pickers so admins can sanity-check a tight window before
// downloading the CSV. Pins the same from/to validation as the CSV endpoint
// so the numerator and the eventual export agree.
describe("GET /api/organizations/:orgId/tournaments/:tid/survey/responses/count (Task #2028)", () => {
  it("returns the unfiltered count when no from/to is supplied", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses/count`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 3 });
  });

  it("filters to responses inside the from/to window (inclusive bounds)", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses/count`)
      .query({
        from: "2026-04-02T09:30:00.000Z",
        to: "2026-04-02T10:30:00.000Z",
      });

    expect(res.status).toBe(200);
    // Only the 10:00Z response falls inside the window.
    expect(res.body).toEqual({ count: 1 });
  });

  it("'from' alone counts the newest responses (inclusive lower bound)", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses/count`)
      .query({ from: "2026-04-02T10:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 2 });
  });

  it("'to' alone counts the oldest responses (inclusive upper bound)", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses/count`)
      .query({ to: "2026-04-02T10:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 2 });
  });

  it("returns count 0 for an empty window", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses/count`)
      .query({
        from: "2030-01-01T00:00:00.000Z",
        to: "2030-12-31T23:59:59.999Z",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0 });
  });

  it("returns count 0 (not 404) when the tournament has no survey yet", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentNoSurveyId}/survey/responses/count`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0 });
  });

  it("rejects an invalid 'from' with 400 and a clear message", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses/count`)
      .query({ from: "not-a-date" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from/);
    expect(res.body.error).toMatch(/ISO 8601/);
  });

  it("rejects 'from' after 'to' with 400", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses/count`)
      .query({
        from: "2026-04-10T00:00:00.000Z",
        to: "2026-04-01T00:00:00.000Z",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/before/);
  });

  it("blocks an admin of a different org via 404 (tournament not in their org)", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentOrgBId}/survey/responses/count`);

    expect(res.status).toBe(404);
  });

  it("rejects non-admin players with 403", async () => {
    const app = createTestApp(playerUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses/count`);

    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses/count`);

    expect(res.status).toBe(401);
  });
});

describe("GET /api/organizations/:orgId/tournaments/:tid/survey/responses.csv", () => {
  it("returns a CSV with one row per response, one column per question + submittedAt", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toContain(`survey-responses-tournament-${tournamentWithSurveyId}.csv`);

    // Strip the BOM before splitting.
    const body = String(res.text).replace(/^\uFEFF/, "");
    const lines = body.trim().split(/\r\n/);

    // Header + 3 responses
    expect(lines.length).toBe(4);
    // Task #1633 — `respondent` column lives between `submittedAt` and the
    // per-question columns so admins can scan the spreadsheet left-to-right
    // (when, who, what) without rearranging columns.
    expect(lines[0]).toBe("submittedAt,respondent,Overall experience,Would you play again?,Any comments?");

    // Newest response first (matches the JSON endpoint's ordering).
    expect(lines[1]).toBe("2026-04-02T11:00:00.000Z,Anonymous,3,no,");
    expect(lines[2]).toBe("2026-04-02T10:00:00.000Z,Anonymous,4,yes,Pace was a bit slow on the back nine.");
    expect(lines[3]).toBe("2026-04-02T09:00:00.000Z,Player Alice,5,yes,Loved the format!");
  });

  it("falls back to username when displayName is null and CSV-escapes commas in the name", async () => {
    // Task #1633 — pin both the displayName→username fallback and the
    // CSV-escaping of a comma inside the respondent column itself.
    const stamp2 = uid("t1633");
    const [pl2] = await db.insert(appUsersTable).values({
      replitUserId: `t1633-pl-${stamp2}`,
      // Comma in the username forces the CSV-escape path on the new column.
      username: `Doe, John (${stamp2})`,
      displayName: null,
      role: "player",
      organizationId: orgAId,
    }).returning({ id: appUsersTable.id });
    const usernameOnlyUser = pl2;

    const submittedAt = new Date("2026-04-04T15:00:00Z");
    await db.insert(postEventSurveyResponsesTable).values({
      surveyId,
      userId: usernameOnlyUser.id,
      answers: { overall: 4, comeback: true, comments: "Username fallback works" },
      submittedAt,
    });
    try {
      const app = createTestApp(adminAUser);
      const res = await request(app)
        .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`);
      expect(res.status).toBe(200);
      const body = String(res.text).replace(/^\uFEFF/, "");
      const newestLine = body.trim().split(/\r\n/)[1];
      expect(newestLine).toBe(
        `2026-04-04T15:00:00.000Z,"Doe, John (${stamp2})",4,yes,Username fallback works`,
      );
    } finally {
      await db.delete(postEventSurveyResponsesTable).where(eq(postEventSurveyResponsesTable.submittedAt, submittedAt));
      await db.delete(appUsersTable).where(eq(appUsersTable.id, usernameOnlyUser.id));
    }
  });

  it("returns 404 when no survey has been sent for the tournament", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentNoSurveyId}/survey/responses.csv`);

    expect(res.status).toBe(404);
  });

  it("blocks an admin of a different org via 404 (tournament not in their org)", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentOrgBId}/survey/responses.csv`);

    expect(res.status).toBe(404);
  });

  it("rejects non-admin players with 403", async () => {
    const app = createTestApp(playerUser);
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`);

    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`);

    expect(res.status).toBe(401);
  });

  // Task #1634 — admins can scope the export to a date window via from/to.
  describe("date-range filter (Task #1634)", () => {
    it("includes only responses within the from/to window", async () => {
      const app = createTestApp(adminAUser);
      const res = await request(app)
        .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`)
        .query({
          from: "2026-04-02T09:30:00.000Z",
          to: "2026-04-02T10:30:00.000Z",
        });

      expect(res.status).toBe(200);
      const body = String(res.text).replace(/^\uFEFF/, "");
      const lines = body.trim().split(/\r\n/);
      // Header + the single response submitted at 10:00Z
      expect(lines.length).toBe(2);
      expect(lines[0]).toBe("submittedAt,Overall experience,Would you play again?,Any comments?");
      expect(lines[1]).toBe("2026-04-02T10:00:00.000Z,4,yes,Pace was a bit slow on the back nine.");
    });

    it("'from' alone keeps newest responses (inclusive lower bound)", async () => {
      const app = createTestApp(adminAUser);
      const res = await request(app)
        .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`)
        .query({ from: "2026-04-02T10:00:00.000Z" });

      expect(res.status).toBe(200);
      const body = String(res.text).replace(/^\uFEFF/, "");
      const lines = body.trim().split(/\r\n/);
      // 10:00Z and 11:00Z, but not 09:00Z
      expect(lines.length).toBe(3);
      expect(lines[1]).toBe("2026-04-02T11:00:00.000Z,3,no,");
      expect(lines[2]).toBe("2026-04-02T10:00:00.000Z,4,yes,Pace was a bit slow on the back nine.");
    });

    it("'to' alone keeps oldest responses (inclusive upper bound)", async () => {
      const app = createTestApp(adminAUser);
      const res = await request(app)
        .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`)
        .query({ to: "2026-04-02T10:00:00.000Z" });

      expect(res.status).toBe(200);
      const body = String(res.text).replace(/^\uFEFF/, "");
      const lines = body.trim().split(/\r\n/);
      // 09:00Z and 10:00Z, but not 11:00Z
      expect(lines.length).toBe(3);
      expect(lines[1]).toBe("2026-04-02T10:00:00.000Z,4,yes,Pace was a bit slow on the back nine.");
      expect(lines[2]).toBe("2026-04-02T09:00:00.000Z,5,yes,Loved the format!");
    });

    it("an empty window returns just the header row", async () => {
      const app = createTestApp(adminAUser);
      const res = await request(app)
        .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`)
        .query({
          from: "2030-01-01T00:00:00.000Z",
          to: "2030-12-31T23:59:59.999Z",
        });

      expect(res.status).toBe(200);
      const body = String(res.text).replace(/^\uFEFF/, "");
      const lines = body.trim().split(/\r\n/);
      expect(lines.length).toBe(1);
      expect(lines[0]).toBe("submittedAt,Overall experience,Would you play again?,Any comments?");
    });

    it("omitting from/to returns every response (unfiltered)", async () => {
      const app = createTestApp(adminAUser);
      const res = await request(app)
        .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`);

      expect(res.status).toBe(200);
      const body = String(res.text).replace(/^\uFEFF/, "");
      const lines = body.trim().split(/\r\n/);
      // Header + 3 responses (matches the original unfiltered case).
      expect(lines.length).toBe(4);
    });

    it("rejects an invalid 'from' with 400 and a clear message", async () => {
      const app = createTestApp(adminAUser);
      const res = await request(app)
        .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`)
        .query({ from: "not-a-date" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/from/);
      expect(res.body.error).toMatch(/ISO 8601/);
    });

    it("rejects an invalid 'to' with 400 and a clear message", async () => {
      const app = createTestApp(adminAUser);
      const res = await request(app)
        .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`)
        .query({ to: "still-not-a-date" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/to/);
      expect(res.body.error).toMatch(/ISO 8601/);
    });

    it("rejects loosely-parseable non-ISO date strings with 400", async () => {
      // "Jan 1, 2026" is parseable by `new Date()` but is NOT ISO 8601, so
      // we want a clean 400 instead of silently accepting the legacy format.
      const app = createTestApp(adminAUser);
      const res = await request(app)
        .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`)
        .query({ from: "Jan 1, 2026" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/from/);
      expect(res.body.error).toMatch(/ISO 8601/);
    });

    it("accepts a date-only ISO string (YYYY-MM-DD)", async () => {
      const app = createTestApp(adminAUser);
      const res = await request(app)
        .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`)
        .query({ from: "2026-04-01", to: "2026-04-30" });

      expect(res.status).toBe(200);
      const body = String(res.text).replace(/^\uFEFF/, "");
      const lines = body.trim().split(/\r\n/);
      // All three responses fall within April 2026.
      expect(lines.length).toBe(4);
    });

    it("rejects 'from' after 'to' with 400", async () => {
      const app = createTestApp(adminAUser);
      const res = await request(app)
        .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`)
        .query({
          from: "2026-04-10T00:00:00.000Z",
          to: "2026-04-01T00:00:00.000Z",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/before/);
    });
  });

  it("CSV-escapes commas, quotes, and newlines in text answers", async () => {
    // Insert a tricky response with a comma, embedded quote, and newline.
    const trickyAt = new Date("2026-04-03T12:00:00Z");
    await db.insert(postEventSurveyResponsesTable).values({
      surveyId,
      userId: null,
      answers: { overall: 2, comeback: false, comments: 'Great pace, but the "back nine"\nwas slow.' },
      submittedAt: trickyAt,
    });
    try {
      const app = createTestApp(adminAUser);
      const res = await request(app)
        .get(`/api/organizations/${orgAId}/tournaments/${tournamentWithSurveyId}/survey/responses.csv`);
      expect(res.status).toBe(200);
      const body = String(res.text).replace(/^\uFEFF/, "");
      // The tricky comments cell must be wrapped in quotes with embedded quotes doubled.
      expect(body).toContain('"Great pace, but the ""back nine""\nwas slow."');
    } finally {
      await db.delete(postEventSurveyResponsesTable).where(eq(postEventSurveyResponsesTable.submittedAt, trickyAt));
    }
  });
});
