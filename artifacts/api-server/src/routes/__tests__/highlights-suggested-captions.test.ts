/**
 * Task #699 — Auto-caption suggestions on the candidate-media endpoint.
 *
 * Pins the contract for `suggestedCaptions` on
 *   GET /api/portal/highlights/candidate-media
 *
 * Covers every scenario the production resolver branches on:
 *
 *   • Tournament-scoped media — player resolved by userId, score-to-par
 *     labels (Eagle/Birdie/Par/Bogey/Double Bogey/+N) all derived from
 *     the count of shots on the matching hole.
 *   • Tournament-scoped media — player resolved by email when the
 *     player row has no userId link.
 *   • Par detection via the tournament's course (media.courseId is null).
 *   • Par detection via media.courseId for general-play uploads (no
 *     tournament context).
 *   • General-play media uploaded by the caller — falls back to the
 *     caller's own shots and uses club / carry distance for the chip.
 *   • Media with a holeNumber but no shot data anywhere → "Hole N" only
 *     (or "Hole N · Par P" if par can be looked up).
 *   • Media with no holeNumber → empty suggestions array.
 *
 * Render queue is stubbed to avoid touching ffmpeg.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

vi.mock("../../lib/highlightQueue.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/highlightQueue.js")>(
    "../../lib/highlightQueue.js",
  );
  return { ...actual, enqueueRender: vi.fn(async () => {}) };
});

import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  coursesTable,
  holeDetailsTable,
  tournamentsTable,
  playersTable,
  shotsTable,
  mediaTable,
  generalPlayRoundsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgId: number;
let courseTourId: number;
let courseGenId: number;
let tournamentId: number;
let callerUserId: number;
let emailMatchedUserId: number;
let callerPlayerId: number;
let emailMatchedPlayerId: number;
let generalRoundId: number;
const callerEmail = `caller_${Date.now()}@auto-cap.test`;
const emailMatchEmail = `byemail_${Date.now()}@auto-cap.test`;

const mediaIds: number[] = [];

async function seedMedia(values: Partial<typeof mediaTable.$inferInsert>) {
  const [row] = await db.insert(mediaTable).values({
    organizationId: orgId,
    objectPath: `/objects/test/${Math.random().toString(36).slice(2)}.jpg`,
    mediaType: "image",
    approved: true,
    uploadedByUserId: callerUserId,
    ...values,
  } as typeof mediaTable.$inferInsert).returning({ id: mediaTable.id });
  mediaIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `T699_${stamp}`, slug: `t699-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [callerUser] = await db.insert(appUsersTable).values({
    replitUserId: `t699-caller-${stamp}`,
    username: `t699_caller_${stamp}`,
    email: callerEmail,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  callerUserId = callerUser.id;

  const [byEmailUser] = await db.insert(appUsersTable).values({
    replitUserId: `t699-byemail-${stamp}`,
    username: `t699_byemail_${stamp}`,
    email: emailMatchEmail,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  emailMatchedUserId = byEmailUser.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: callerUserId, role: "player" },
    { organizationId: orgId, userId: emailMatchedUserId, role: "player" },
  ]);

  // Two courses: one used by the tournament, one used by general-play
  // media (so we can cover both par-lookup branches).
  const [tCourse] = await db.insert(coursesTable).values({
    organizationId: orgId, name: "T699 Tour Course",
    slug: `t699-tour-${stamp}`, holes: 18, par: 72,
  }).returning({ id: coursesTable.id });
  courseTourId = tCourse.id;

  const [gCourse] = await db.insert(coursesTable).values({
    organizationId: orgId, name: "T699 Gen Course",
    slug: `t699-gen-${stamp}`, holes: 18, par: 72,
  }).returning({ id: coursesTable.id });
  courseGenId = gCourse.id;

  // Hole pars chosen so the score counts below land on each label exactly:
  //   1 → par 4 (3 shots → Birdie)
  //   2 → par 5 (3 shots → Eagle, diff -2)
  //   3 → par 4 (4 shots → Par)
  //   4 → par 4 (5 shots → Bogey)
  //   5 → par 4 (6 shots → Double Bogey)
  //   6 → par 3 (7 shots → +4)
  //   7 → par 4 (no shots, par via tournament course)
  //   8 → par 3 (no shots anywhere, used for "Hole N · Par P" fallback)
  const tourPars: Record<number, number> = { 1: 4, 2: 5, 3: 4, 4: 4, 5: 4, 6: 3, 7: 4 };
  await db.insert(holeDetailsTable).values(
    Object.entries(tourPars).map(([h, par]) => ({
      courseId: courseTourId, holeNumber: Number(h), par,
    })),
  );
  await db.insert(holeDetailsTable).values([
    { courseId: courseGenId, holeNumber: 8, par: 3 },
    { courseId: courseGenId, holeNumber: 9, par: 4 },
  ]);

  const [tour] = await db.insert(tournamentsTable).values({
    organizationId: orgId, courseId: courseTourId,
    name: `T699 Tournament ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  tournamentId = tour.id;

  // Caller is enrolled by userId.
  const [pCaller] = await db.insert(playersTable).values({
    tournamentId, userId: callerUserId,
    firstName: "Cal", lastName: "Ler",
    email: callerEmail,
  }).returning({ id: playersTable.id });
  callerPlayerId = pCaller.id;

  // Email-matched user is enrolled WITHOUT a userId link — the resolver
  // should match them by email.
  const [pByEmail] = await db.insert(playersTable).values({
    tournamentId,
    firstName: "By", lastName: "Email",
    email: emailMatchEmail,
  }).returning({ id: playersTable.id });
  emailMatchedPlayerId = pByEmail.id;

  // Tournament shots — count per hole = score.
  const tourShotRows: Array<typeof shotsTable.$inferInsert> = [];
  const addTourShots = (playerId: number, hole: number, count: number, club?: string, carry?: number) => {
    for (let i = 1; i <= count; i++) {
      tourShotRows.push({
        tournamentId, playerId, holeNumber: hole, shotNumber: i,
        club: i === 1 ? club : undefined,
        distanceCarried: i === 1 && carry ? String(carry) : undefined,
      });
    }
  };
  addTourShots(callerPlayerId, 1, 3, "Driver", 250);
  addTourShots(callerPlayerId, 2, 3, "3-Wood", 230);
  addTourShots(callerPlayerId, 3, 4, "Driver", 245);
  addTourShots(callerPlayerId, 4, 5, "Driver", 240);
  addTourShots(callerPlayerId, 5, 6, "Driver", 235);
  addTourShots(callerPlayerId, 6, 7, "8-Iron", 140);
  // Email-matched player gets one shot on hole 1 as their own.
  addTourShots(emailMatchedPlayerId, 1, 4, "Driver", 220);
  await db.insert(shotsTable).values(tourShotRows);

  // General-play round + shots for hole 9 (par 4, 4 shots → Par) so we
  // exercise the general-play branch and the media.courseId par lookup.
  const [gpr] = await db.insert(generalPlayRoundsTable).values({
    userId: callerUserId, organizationId: orgId, courseId: courseGenId,
  }).returning({ id: generalPlayRoundsTable.id });
  generalRoundId = gpr.id;
  const genShots: Array<typeof shotsTable.$inferInsert> = [];
  for (let i = 1; i <= 4; i++) {
    genShots.push({
      generalPlayRoundId: generalRoundId, userId: callerUserId,
      holeNumber: 9, shotNumber: i,
      club: i === 1 ? "5-Iron" : undefined,
      distanceCarried: i === 1 ? "180" : undefined,
    });
  }
  await db.insert(shotsTable).values(genShots);
});

afterAll(async () => {
  if (mediaIds.length > 0) await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
  await db.delete(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
  await db.delete(shotsTable).where(eq(shotsTable.generalPlayRoundId, generalRoundId));
  await db.delete(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, generalRoundId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(holeDetailsTable).where(inArray(holeDetailsTable.courseId, [courseTourId, courseGenId]));
  await db.delete(coursesTable).where(inArray(coursesTable.id, [courseTourId, courseGenId]));
  await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, [callerUserId, emailMatchedUserId]));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [callerUserId, emailMatchedUserId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function asUser(id: number): TestUser {
  return { id, username: `u${id}`, role: "player", organizationId: orgId };
}

type CandidateItem = {
  id: number; holeNumber: number | null; suggestedCaptions: string[];
};

async function fetchCandidates(userId: number, tournamentIdQ?: number): Promise<Map<number, string[]>> {
  const app = createTestApp(asUser(userId));
  const url = tournamentIdQ
    ? `/api/portal/highlights/candidate-media?tournamentId=${tournamentIdQ}`
    : "/api/portal/highlights/candidate-media";
  const res = await request(app).get(url);
  expect(res.status).toBe(200);
  const out = new Map<number, string[]>();
  for (const m of res.body.media as CandidateItem[]) out.set(m.id, m.suggestedCaptions);
  return out;
}

describe("GET /api/portal/highlights/candidate-media — suggestedCaptions", () => {
  it("emits each score-to-par label (Eagle/Birdie/Par/Bogey/Double Bogey/+N) for tournament shots", async () => {
    const m1 = await seedMedia({ tournamentId, holeNumber: 1 }); // Birdie
    const m2 = await seedMedia({ tournamentId, holeNumber: 2 }); // Eagle
    const m3 = await seedMedia({ tournamentId, holeNumber: 3 }); // Par
    const m4 = await seedMedia({ tournamentId, holeNumber: 4 }); // Bogey
    const m5 = await seedMedia({ tournamentId, holeNumber: 5 }); // Double Bogey
    const m6 = await seedMedia({ tournamentId, holeNumber: 6 }); // +4

    const caps = await fetchCandidates(callerUserId, tournamentId);

    // Each item should have exactly two suggestions: a club/carry chip and
    // a par/score chip.
    expect(caps.get(m1)).toEqual([
      "Hole 1 · Driver · 250y",
      "Hole 1 · Par 4 · Birdie",
    ]);
    expect(caps.get(m2)).toEqual([
      "Hole 2 · 3-Wood · 230y",
      "Hole 2 · Par 5 · Eagle",
    ]);
    expect(caps.get(m3)).toEqual([
      "Hole 3 · Driver · 245y",
      "Hole 3 · Par 4 · Par",
    ]);
    expect(caps.get(m4)).toEqual([
      "Hole 4 · Driver · 240y",
      "Hole 4 · Par 4 · Bogey",
    ]);
    expect(caps.get(m5)).toEqual([
      "Hole 5 · Driver · 235y",
      "Hole 5 · Par 4 · Double Bogey",
    ]);
    expect(caps.get(m6)).toEqual([
      "Hole 6 · 8-Iron · 140y",
      "Hole 6 · Par 3 · +4",
    ]);
  });

  it("resolves the tournament player by email when the player row has no userId link", async () => {
    // Caller (by-email user) uploads a media item to the tournament — they
    // are enrolled only via `players.email`, not players.userId.
    const m = await seedMedia({
      tournamentId, holeNumber: 1,
      uploadedByUserId: emailMatchedUserId,
    });
    const caps = await fetchCandidates(emailMatchedUserId, tournamentId);
    // 4 shots on par-4 hole 1 → Par. Carry "220" stored as string.
    expect(caps.get(m)).toEqual([
      "Hole 1 · Driver · 220y",
      "Hole 1 · Par 4 · Par",
    ]);
  });

  it("looks up par via the tournament's course when media.courseId is null", async () => {
    // Hole 7 has tournament shots = 0, but par is seeded on the tournament's
    // course → suggestion should still include "Par 4" via the tournament
    // → course join (no shots → no score-to-par label).
    const m = await seedMedia({ tournamentId, holeNumber: 7 });
    const caps = await fetchCandidates(callerUserId, tournamentId);
    expect(caps.get(m)).toEqual(["Hole 7 · Par 4"]);
  });

  it("looks up par via media.courseId for general-play uploads", async () => {
    // No tournament; media carries courseId directly. 4 shots on par 4 → Par.
    const m = await seedMedia({ holeNumber: 9, courseId: courseGenId });
    const caps = await fetchCandidates(callerUserId);
    expect(caps.get(m)).toEqual([
      "Hole 9 · 5-Iron · 180y",
      "Hole 9 · Par 4 · Par",
    ]);
  });

  it("falls back to par-only chip when a hole has par data but no shots", async () => {
    // Hole 8 has par 3 on the gen course; no shots anywhere.
    const m = await seedMedia({ holeNumber: 8, courseId: courseGenId });
    const caps = await fetchCandidates(callerUserId);
    expect(caps.get(m)).toEqual(["Hole 8 · Par 3"]);
  });

  it("emits a bare 'Hole N' chip when there is no par data and no shots", async () => {
    // Hole 12 — never seeded in either course, no shots either.
    const m = await seedMedia({ holeNumber: 12 });
    const caps = await fetchCandidates(callerUserId);
    expect(caps.get(m)).toEqual(["Hole 12"]);
  });

  it("returns no suggestions for media without a holeNumber", async () => {
    const m = await seedMedia({}); // no hole
    const caps = await fetchCandidates(callerUserId);
    expect(caps.get(m)).toEqual([]);
  });
});
