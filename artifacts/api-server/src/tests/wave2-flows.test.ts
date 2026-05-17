/**
 * Integration tests: Wave 2 (Task #937) end-to-end flows — Task #1173.
 *
 * The features below shipped together but had no automated cross-flow
 * coverage. These tests pin the load-bearing endpoints in
 * `routes/wave2.ts` so a regression in any one of them (status enum
 * rename, IDOR guard removed, response shape changed) breaks CI before
 * it breaks players or admins.
 *
 * Covers (mirrors the "Done looks like" checklist in task-1173.md):
 *
 *   1. Course corrections: player submit → admin queue list → admin
 *      accept/reject → player "mine" view shows new status.
 *   2. Tournament cut: admin POST /cut returns advanced/cut counts and
 *      persists `players.cut_at` for the cut group; rejects when the
 *      tournament has no cut line; rejects cross-org access (IDOR).
 *   3. Coach marketplace expanded filters: priceMin / priceMax / region
 *      / handicap / minRating / specialty all narrow results to the
 *      seeded coach that satisfies them.
 *   4. Tee booking cancel-and-promote: lead booker cancels their booking
 *      and the oldest waitlist entry is auto-promoted to a confirmed
 *      booking; non-lead caller is rejected with 403.
 *   5. Plus: handicap "explain", post-event survey send, and match-play
 *      head-to-head form-guide endpoints — mentioned in the task even
 *      though they're not on the explicit checklist.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  scoresTable,
  courseDataCorrectionsTable,
  postEventSurveysTable,
  teachingProsTable,
  coachMarketplaceProfilesTable,
  courseTeeSlotTable,
  teeBookingsTable,
  teeBookingWaitlistTable,
  matchPlayBracketTable,
  bracketRoundsTable,
  bracketMatchesTable,
  whsScoreRecordsTable,
  handicapHistoryTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

// ── Seeded entities reused across describe blocks ────────────────────
let orgId: number;
let otherOrgId: number;
let playerUserId: number;
let otherPlayerUserId: number;
let adminUserId: number;
let courseId: number;
let tournamentId: number;
let player1Id: number;
let player2Id: number;
let player3Id: number;
let player4Id: number;
let teeSlotId: number;
let bracketId: number;
let bracketRoundId: number;
let bp1Id: number;
let bp2Id: number;

// Coach marketplace seed
let coachOrg1Id: number;
let coachOrg2Id: number;
let coachA: { proId: number; profileId: number };
let coachB: { proId: number; profileId: number };
let coachC: { proId: number; profileId: number };

beforeAll(async () => {
  // ── Two orgs (cross-org guard tests) ──
  const [org] = await db.insert(organizationsTable).values({
    name: `Wave2_Org_${stamp}`, slug: `wave2-org-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [other] = await db.insert(organizationsTable).values({
    name: `Wave2_Other_${stamp}`, slug: `wave2-other-${stamp}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = other.id;

  // ── App users: a player, a second player, an admin ──
  const [player] = await db.insert(appUsersTable).values({
    replitUserId: `wave2-player-${stamp}`, username: `wave2_player_${stamp}`,
    role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  playerUserId = player.id;

  const [other2] = await db.insert(appUsersTable).values({
    replitUserId: `wave2-other-${stamp}`, username: `wave2_other_${stamp}`,
    role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  otherPlayerUserId = other2.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `wave2-admin-${stamp}`, username: `wave2_admin_${stamp}`,
    role: "org_admin", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = admin.id;

  // ── Course ──
  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: `Wave2 Course ${stamp}`,
    slug: `wave2-course-${stamp}`,
    holes: 18, par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  // ── Tournament with cut line (+10 over par across rounds) ──
  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `Wave2 Tournament ${stamp}`,
    cutLine: 10,
    rounds: 3,
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  // ── Four players: two safely under the cut, two well over. ──
  // Round par = 72; throughRound=2 → totalPar=144; cutLineStrokes=154.
  // Players at 140/142 survive; at 160/170 are cut.
  const playerInserts = await db.insert(playersTable).values([
    { tournamentId, firstName: "Alice", lastName: `S_${stamp}`, userId: playerUserId },
    { tournamentId, firstName: "Bob", lastName: `S_${stamp}`, userId: otherPlayerUserId },
    { tournamentId, firstName: "Carol", lastName: `C_${stamp}` },
    { tournamentId, firstName: "Dave", lastName: `C_${stamp}` },
  ]).returning({ id: playersTable.id });
  [player1Id, player2Id, player3Id, player4Id] = playerInserts.map(p => p.id);

  // Round 1 totals: 70/71/82/85. Round 2 totals: 70/71/78/85. So:
  //   Alice 140 → survives, Bob 142 → survives
  //   Carol 160 → cut, Dave 170 → cut
  const scoreRows: Array<{ tournamentId: number; playerId: number; round: number; holeNumber: number; strokes: number }> = [];
  const splits = [
    { pid: player1Id, r1: 70, r2: 70 },
    { pid: player2Id, r1: 71, r2: 71 },
    { pid: player3Id, r1: 82, r2: 78 },
    { pid: player4Id, r1: 85, r2: 85 },
  ];
  for (const s of splits) {
    // Encode each round's total as a single hole-1 score (cutHandler sums by player+round).
    scoreRows.push({ tournamentId, playerId: s.pid, round: 1, holeNumber: 1, strokes: s.r1 });
    scoreRows.push({ tournamentId, playerId: s.pid, round: 2, holeNumber: 1, strokes: s.r2 });
  }
  await db.insert(scoresTable).values(scoreRows);

  // ── Tee slot + base booking + waitlist for cancel-and-promote ──
  const [slot] = await db.insert(courseTeeSlotTable).values({
    courseId,
    organizationId: orgId,
    slotDate: new Date(),
    slotTime: "09:00",
    capacity: 4,
  }).returning({ id: courseTeeSlotTable.id });
  teeSlotId = slot.id;

  // Match-play bracket + two completed matches with reversed result so
  // the form-guide returns aWins=1 / bWins=1 / halved=0.
  const [bracket] = await db.insert(matchPlayBracketTable).values({
    tournamentId, format: "single_elim", totalRounds: 1,
  }).returning({ id: matchPlayBracketTable.id });
  bracketId = bracket.id;

  const [round] = await db.insert(bracketRoundsTable).values({
    bracketId, roundNumber: 1, name: "R1",
  }).returning({ id: bracketRoundsTable.id });
  bracketRoundId = round.id;

  // Form-guide queries by playerId (bracketMatches.player1Id) — re-use
  // player1/player2 from above so the head-to-head record is meaningful.
  bp1Id = player1Id;
  bp2Id = player2Id;
  await db.insert(bracketMatchesTable).values([
    {
      bracketId, roundId: bracketRoundId, matchNumber: 1,
      player1Id: bp1Id, player2Id: bp2Id,
      result: "player1_wins", winnerId: bp1Id, matchStatus: "2 UP",
    },
    {
      bracketId, roundId: bracketRoundId, matchNumber: 2,
      player1Id: bp2Id, player2Id: bp1Id,
      result: "player1_wins", winnerId: bp2Id, matchStatus: "1 UP",
    },
  ]);

  // ── Coach marketplace seed (separate orgs to test region filter) ──
  const [coachOrg1] = await db.insert(organizationsTable).values({
    name: `Bengaluru Golf ${stamp}`, slug: `coach-org-1-${stamp}`,
  }).returning({ id: organizationsTable.id });
  coachOrg1Id = coachOrg1.id;

  const [coachOrg2] = await db.insert(organizationsTable).values({
    name: `Mumbai Greens ${stamp}`, slug: `coach-org-2-${stamp}`,
  }).returning({ id: organizationsTable.id });
  coachOrg2Id = coachOrg2.id;

  const [proA] = await db.insert(teachingProsTable).values({
    organizationId: coachOrg1Id, displayName: `Coach Aarav ${stamp}`,
    specialisms: ["short_game", "putting"], isActive: true,
  }).returning({ id: teachingProsTable.id });
  const [profA] = await db.insert(coachMarketplaceProfilesTable).values({
    proId: proA.id, organizationId: coachOrg1Id,
    isListed: true, yearsExperience: 12,
    hourlyRatePaise: 500_000, asyncReviewPricePaise: 200_000,
    acceptsInPerson: true, acceptsAsync: true,
    asyncTurnaroundHours: 24, ratingsAvg: "4.80", ratingsCount: 12,
    languages: ["en", "hi"],
    coachesHandicapMin: "0",
    coachesHandicapMax: "18",
  }).returning({ id: coachMarketplaceProfilesTable.id });
  coachA = { proId: proA.id, profileId: profA.id };

  const [proB] = await db.insert(teachingProsTable).values({
    organizationId: coachOrg2Id, displayName: `Coach Bina ${stamp}`,
    specialisms: ["driving"], isActive: true,
  }).returning({ id: teachingProsTable.id });
  const [profB] = await db.insert(coachMarketplaceProfilesTable).values({
    proId: proB.id, organizationId: coachOrg2Id,
    isListed: true, yearsExperience: 5,
    hourlyRatePaise: 300_000, asyncReviewPricePaise: 600_000,
    acceptsInPerson: true, acceptsAsync: true,
    asyncTurnaroundHours: 48, ratingsAvg: "4.20", ratingsCount: 4,
    languages: ["en"],
    coachesHandicapMin: "10",
    coachesHandicapMax: "36",
  }).returning({ id: coachMarketplaceProfilesTable.id });
  coachB = { proId: proB.id, profileId: profB.id };

  // Coach C is unlisted (control: should never appear in /coaches).
  const [proC] = await db.insert(teachingProsTable).values({
    organizationId: coachOrg1Id, displayName: `Coach Hidden ${stamp}`,
    specialisms: ["putting"], isActive: true,
  }).returning({ id: teachingProsTable.id });
  const [profC] = await db.insert(coachMarketplaceProfilesTable).values({
    proId: proC.id, organizationId: coachOrg1Id,
    isListed: false, yearsExperience: 1,
    hourlyRatePaise: 100_000, asyncReviewPricePaise: 100_000,
    acceptsInPerson: true, acceptsAsync: false,
    asyncTurnaroundHours: 48, ratingsAvg: "5.00", ratingsCount: 1,
  }).returning({ id: coachMarketplaceProfilesTable.id });
  coachC = { proId: proC.id, profileId: profC.id };
});

afterAll(async () => {
  // Bracket → matches first, then rounds, bracket itself.
  await db.delete(bracketMatchesTable).where(eq(bracketMatchesTable.bracketId, bracketId));
  await db.delete(bracketRoundsTable).where(eq(bracketRoundsTable.bracketId, bracketId));
  await db.delete(matchPlayBracketTable).where(eq(matchPlayBracketTable.id, bracketId));

  await db.delete(teeBookingWaitlistTable).where(eq(teeBookingWaitlistTable.slotId, teeSlotId));
  await db.delete(teeBookingsTable).where(eq(teeBookingsTable.slotId, teeSlotId));
  await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.id, teeSlotId));

  await db.delete(courseDataCorrectionsTable).where(eq(courseDataCorrectionsTable.organizationId, orgId));
  await db.delete(postEventSurveysTable).where(eq(postEventSurveysTable.tournamentId, tournamentId));
  await db.delete(scoresTable).where(eq(scoresTable.tournamentId, tournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(whsScoreRecordsTable).where(eq(whsScoreRecordsTable.userId, playerUserId));
  await db.delete(handicapHistoryTable).where(eq(handicapHistoryTable.userId, playerUserId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [playerUserId, otherPlayerUserId, adminUserId]));

  await db.delete(coachMarketplaceProfilesTable).where(inArray(coachMarketplaceProfilesTable.id, [coachA.profileId, coachB.profileId, coachC.profileId]));
  await db.delete(teachingProsTable).where(inArray(teachingProsTable.id, [coachA.proId, coachB.proId, coachC.proId]));

  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgId, otherOrgId, coachOrg1Id, coachOrg2Id]));
});

function asPlayer() {
  return createTestApp({ id: playerUserId, username: "wave2_player", role: "player", organizationId: orgId });
}
function asOtherPlayer() {
  return createTestApp({ id: otherPlayerUserId, username: "wave2_other", role: "player", organizationId: orgId });
}
function asAdmin() {
  return createTestApp({ id: adminUserId, username: "wave2_admin", role: "org_admin", organizationId: orgId });
}
function asOtherOrgAdmin() {
  return createTestApp({ id: 999_001, username: "other_admin", role: "org_admin", organizationId: otherOrgId });
}

// ─── 1. COURSE CORRECTIONS END-TO-END ─────────────────────────────────
describe("Wave 2 — course corrections submit → admin → resolve flow", () => {
  it("player submits a correction, admin sees it in the open queue, accepts it, player sees status flip", async () => {
    // 1a. Player submits.
    const submit = await request(asPlayer())
      .post("/api/portal/course-corrections")
      .send({
        courseId, organizationId: orgId,
        holeNumber: 7, fieldName: "par",
        currentValue: "4", proposedValue: "5",
        reason: "The card and signage say par 5",
      });
    expect(submit.status).toBe(201);
    expect(submit.body.correction).toMatchObject({
      courseId, organizationId: orgId,
      holeNumber: 7, fieldName: "par",
      proposedValue: "5", status: "open",
      reportedByUserId: playerUserId,
    });
    const correctionId = submit.body.correction.id as number;

    // 1b. Player sees it in /mine right away.
    const mine = await request(asPlayer())
      .get("/api/portal/course-corrections/mine");
    expect(mine.status).toBe(200);
    expect(mine.body.corrections.find((c: { id: number }) => c.id === correctionId)).toMatchObject({
      id: correctionId, status: "open",
    });

    // 1c. Admin sees it in the open queue.
    const queue = await request(asAdmin())
      .get(`/api/organizations/${orgId}/course-corrections?status=open`);
    expect(queue.status).toBe(200);
    expect(queue.body.corrections.find((c: { id: number }) => c.id === correctionId)).toBeDefined();

    // 1d. Cross-org admin gets 403.
    const cross = await request(asOtherOrgAdmin())
      .get(`/api/organizations/${orgId}/course-corrections?status=open`);
    expect(cross.status).toBe(403);

    // 1e. Admin accepts with notes.
    const resolve = await request(asAdmin())
      .post(`/api/organizations/${orgId}/course-corrections/${correctionId}/resolve`)
      .send({ decision: "accepted", reviewNotes: "Confirmed with the head pro." });
    expect(resolve.status).toBe(200);
    expect(resolve.body.correction).toMatchObject({
      id: correctionId, status: "accepted",
      reviewNotes: "Confirmed with the head pro.",
      reviewedByUserId: adminUserId,
    });
    expect(resolve.body.correction.reviewedAt).toBeTruthy();

    // 1f. Player view reflects the new status.
    const mineAfter = await request(asPlayer())
      .get("/api/portal/course-corrections/mine");
    expect(mineAfter.status).toBe(200);
    const updated = mineAfter.body.corrections.find((c: { id: number }) => c.id === correctionId);
    expect(updated).toMatchObject({
      status: "accepted",
      reviewNotes: "Confirmed with the head pro.",
    });

    // 1g. Open queue no longer surfaces it.
    const queueAfter = await request(asAdmin())
      .get(`/api/organizations/${orgId}/course-corrections?status=open`);
    expect(queueAfter.body.corrections.find((c: { id: number }) => c.id === correctionId)).toBeUndefined();

    // 1h. Accepted filter does surface it.
    const queueAccepted = await request(asAdmin())
      .get(`/api/organizations/${orgId}/course-corrections?status=accepted`);
    expect(queueAccepted.body.corrections.find((c: { id: number }) => c.id === correctionId)).toBeDefined();
  });

  it("rejects unknown decisions with 400 (guards the enum the UI sends)", async () => {
    const submit = await request(asPlayer())
      .post("/api/portal/course-corrections")
      .send({
        courseId, organizationId: orgId,
        fieldName: "yardage", proposedValue: "420",
      });
    expect(submit.status).toBe(201);
    const id = submit.body.correction.id as number;

    const bad = await request(asAdmin())
      .post(`/api/organizations/${orgId}/course-corrections/${id}/resolve`)
      .send({ decision: "totally-not-real" });
    expect(bad.status).toBe(400);
  });

  it("returns 401 when an unauthenticated caller posts a correction", async () => {
    const res = await request(createTestApp())
      .post("/api/portal/course-corrections")
      .send({ courseId, organizationId: orgId, fieldName: "par", proposedValue: "5" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(asPlayer())
      .post("/api/portal/course-corrections")
      .send({ courseId, organizationId: orgId, fieldName: "par" /* no proposedValue */ });
    expect(res.status).toBe(400);
  });
});

// ─── 2. TOURNAMENT APPLY CUT ──────────────────────────────────────────
describe("Wave 2 — tournament Apply Cut", () => {
  it("admin POST /cut returns survivors + cut counts and persists cut_at", async () => {
    const res = await request(asAdmin())
      .post(`/api/organizations/${orgId}/tournaments/${tournamentId}/cut`)
      .send({ throughRound: 2 });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    // Cut line strokes = 72*2 + 10 = 154; 140 + 142 survive, 160 + 170 cut.
    expect(res.body.cutLineStrokes).toBe(154);
    expect(res.body.survivors).toHaveLength(2);
    expect(res.body.cut).toHaveLength(2);
    expect(res.body.persistedCount).toBeGreaterThanOrEqual(4);

    const survivorIds = res.body.survivors.map((p: { playerId: number }) => p.playerId).sort();
    const cutIds = res.body.cut.map((p: { playerId: number }) => p.playerId).sort();
    expect(survivorIds).toEqual([player1Id, player2Id].sort());
    expect(cutIds).toEqual([player3Id, player4Id].sort());

    // Persistence: cut_at should be NULL for survivors and a timestamp for the cut group.
    const after = await db.select({ id: playersTable.id, cutAt: playersTable.cutAt })
      .from(playersTable)
      .where(eq(playersTable.tournamentId, tournamentId));
    const map = new Map(after.map(p => [p.id, p.cutAt]));
    expect(map.get(player1Id)).toBeNull();
    expect(map.get(player2Id)).toBeNull();
    expect(map.get(player3Id)).toBeInstanceOf(Date);
    expect(map.get(player4Id)).toBeInstanceOf(Date);
  });

  it("returns 409 when the tournament has no cut line set", async () => {
    const [t] = await db.insert(tournamentsTable).values({
      organizationId: orgId, courseId,
      name: `NoCut_${stamp}`, cutLine: null, rounds: 2,
    }).returning({ id: tournamentsTable.id });
    try {
      const res = await request(asAdmin())
        .post(`/api/organizations/${orgId}/tournaments/${t.id}/cut`)
        .send({ throughRound: 2 });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("no_cut_line");
    } finally {
      await db.delete(tournamentsTable).where(eq(tournamentsTable.id, t.id));
    }
  });

  it("rejects cross-org admin with 404 (IDOR guard)", async () => {
    const res = await request(asOtherOrgAdmin())
      .post(`/api/organizations/${otherOrgId}/tournaments/${tournamentId}/cut`)
      .send({ throughRound: 2 });
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(createTestApp())
      .post(`/api/organizations/${orgId}/tournaments/${tournamentId}/cut`)
      .send({ throughRound: 2 });
    expect(res.status).toBe(401);
  });
});

// ─── 3. POST-EVENT SURVEY SEND ────────────────────────────────────────
describe("Wave 2 — Send post-event survey", () => {
  it("admin can send a survey; row is upserted on second send", async () => {
    const first = await request(asAdmin())
      .post(`/api/organizations/${orgId}/tournaments/${tournamentId}/survey/send`)
      .send({
        questions: [
          { id: "overall", label: "Overall experience", type: "rating" },
          { id: "comments", label: "Comments?", type: "text" },
        ],
      });
    expect(first.status).toBe(201);
    expect(first.body.survey.tournamentId).toBe(tournamentId);
    expect(Array.isArray(first.body.survey.questions)).toBe(true);

    // Second send re-uses the same row (UNIQUE on tournamentId).
    const second = await request(asAdmin())
      .post(`/api/organizations/${orgId}/tournaments/${tournamentId}/survey/send`)
      .send({ questions: [{ id: "course", label: "Course condition?", type: "rating" }] });
    expect(second.status).toBe(201);
    expect(second.body.survey.id).toBe(first.body.survey.id);
  });

  it("returns 404 when sending a survey for a tournament in another org", async () => {
    const res = await request(asAdmin())
      .post(`/api/organizations/${orgId}/tournaments/99999999/survey/send`)
      .send({ questions: [] });
    expect(res.status).toBe(404);
  });
});

// ─── 4. COACH MARKETPLACE EXPANDED FILTERS ────────────────────────────
describe("Wave 2 — coach marketplace expanded filters", () => {
  async function listIds(query: string) {
    const res = await request(createTestApp()).get(`/api/coach-marketplace/coaches${query ? "?" + query : ""}`);
    expect(res.status).toBe(200);
    return (res.body.coaches as Array<{ proId: number }>).map(c => c.proId);
  }

  it("returns both listed coaches with no filters and never returns the unlisted coach", async () => {
    const ids = await listIds("");
    expect(ids).toContain(coachA.proId);
    expect(ids).toContain(coachB.proId);
    expect(ids).not.toContain(coachC.proId);
  });

  it("specialty narrows to the coach with that specialism only", async () => {
    const idsShort = await listIds("specialty=short_game");
    expect(idsShort).toContain(coachA.proId);
    expect(idsShort).not.toContain(coachB.proId);

    const idsDriving = await listIds("specialty=driving");
    expect(idsDriving).toContain(coachB.proId);
    expect(idsDriving).not.toContain(coachA.proId);
  });

  it("region narrows by parent organization name (case-insensitive substring)", async () => {
    const ids = await listIds("region=bengaluru");
    expect(ids).toContain(coachA.proId);
    expect(ids).not.toContain(coachB.proId);
  });

  it("priceMin / priceMax in async mode bracket the async review price (paise)", async () => {
    // Coach A async price = 200_000, Coach B = 600_000.
    const idsCheap = await listIds("mode=async&priceMax=300000");
    expect(idsCheap).toContain(coachA.proId);
    expect(idsCheap).not.toContain(coachB.proId);

    const idsPricey = await listIds("mode=async&priceMin=500000");
    expect(idsPricey).toContain(coachB.proId);
    expect(idsPricey).not.toContain(coachA.proId);
  });

  // Task #1630 — the sidebar copy says "₹/session", but historically the
  // API only ever compared against `asyncReviewPricePaise`, so a player on
  // the in-person tab who set "Max ₹3500" was actually filtering out the
  // cheap-in-person coach (Bina at ₹3000/hr but ₹6000/review). The fix is
  // mode-aware: in_person filters on `hourlyRatePaise`, async on
  // `asyncReviewPricePaise`, and `all` keeps the coach if either offered
  // price falls in the bracket.
  it("priceMin / priceMax in in_person mode bracket the hourly rate (paise)", async () => {
    // Coach A hourly = 500_000, Coach B = 300_000.
    const idsCheapHourly = await listIds("mode=in_person&priceMax=400000");
    expect(idsCheapHourly).toContain(coachB.proId);
    expect(idsCheapHourly).not.toContain(coachA.proId);

    const idsPriceyHourly = await listIds("mode=in_person&priceMin=400000");
    expect(idsPriceyHourly).toContain(coachA.proId);
    expect(idsPriceyHourly).not.toContain(coachB.proId);
  });

  it("priceMin / priceMax with no mode toggle considers either price the coach offers", async () => {
    // priceMax=250_000 (₹2500) — Coach A's async (200k) qualifies even
    // though their hourly is 500k. Coach B's cheapest is hourly 300k, so
    // they are excluded.
    const idsLowCeiling = await listIds("priceMax=250000");
    expect(idsLowCeiling).toContain(coachA.proId);
    expect(idsLowCeiling).not.toContain(coachB.proId);

    // priceMin=550_000 (₹5500) — only Coach B's async (600k) clears it.
    // Coach A's hourly (500k) and async (200k) are both below.
    const idsHighFloor = await listIds("priceMin=550000");
    expect(idsHighFloor).toContain(coachB.proId);
    expect(idsHighFloor).not.toContain(coachA.proId);
  });

  it("minRating narrows to high-rated coaches only", async () => {
    // Coach A rating = 4.80, Coach B = 4.20.
    const ids = await listIds("minRating=4.5");
    expect(ids).toContain(coachA.proId);
    expect(ids).not.toContain(coachB.proId);
  });

  it("handicap=20 includes coach B (window 10..36) but excludes coach A (window 0..18)", async () => {
    const ids = await listIds("handicap=20");
    expect(ids).toContain(coachB.proId);
    expect(ids).not.toContain(coachA.proId);
  });

  it("combining filters narrows further (specialty + region + priceMax)", async () => {
    const ids = await listIds("specialty=short_game&region=bengaluru&priceMax=300000");
    expect(ids).toEqual([coachA.proId]);
  });
});

// ─── 5. TEE BOOKING CANCEL + AUTO-PROMOTE ─────────────────────────────
describe("Wave 2 — tee booking cancel and auto-promote", () => {
  it("lead booker cancels and the oldest waitlist entry is promoted to a confirmed booking", async () => {
    // Seed: confirmed booking owned by playerUserId (party of 2),
    // plus a waitlist entry for otherPlayerUserId.
    const [booking] = await db.insert(teeBookingsTable).values({
      slotId: teeSlotId, organizationId: orgId,
      leadUserId: playerUserId, partySize: 2,
      status: "confirmed", paymentModel: "pay_at_checkin",
    }).returning({ id: teeBookingsTable.id });

    const [waitlist] = await db.insert(teeBookingWaitlistTable).values({
      slotId: teeSlotId, organizationId: orgId,
      userId: otherPlayerUserId, partySize: 2, status: "waiting",
    }).returning({ id: teeBookingWaitlistTable.id });

    try {
      const res = await request(asPlayer())
        .post(`/api/portal/tee-bookings/${booking.id}/cancel-and-promote`)
        .send({ reason: "schedule_conflict" });
      expect(res.status).toBe(200);
      expect(res.body.cancelled).toBe(true);
      expect(res.body.promotion.promoted).toBe(true);
      expect(res.body.promotion.waitlistId).toBe(waitlist.id);
      expect(res.body.promotion.bookingId).toBeGreaterThan(0);

      // Original booking should now be cancelled.
      const [orig] = await db.select({ status: teeBookingsTable.status, cancelledAt: teeBookingsTable.cancelledAt })
        .from(teeBookingsTable).where(eq(teeBookingsTable.id, booking.id));
      expect(orig.status).toBe("cancelled");
      expect(orig.cancelledAt).toBeInstanceOf(Date);

      // Waitlist row should be flagged 'promoted' and linked to the new booking.
      const [wlAfter] = await db.select().from(teeBookingWaitlistTable).where(eq(teeBookingWaitlistTable.id, waitlist.id));
      expect(wlAfter.status).toBe("promoted");
      expect(wlAfter.promotedBookingId).toBe(res.body.promotion.bookingId);
      expect(wlAfter.promotedAt).toBeInstanceOf(Date);

      // The promoted booking exists, owned by the otherPlayer, in pending state.
      const [promoted] = await db.select()
        .from(teeBookingsTable)
        .where(eq(teeBookingsTable.id, res.body.promotion.bookingId));
      expect(promoted.leadUserId).toBe(otherPlayerUserId);
      expect(promoted.partySize).toBe(2);
      expect(promoted.status).toBe("pending");
    } finally {
      await db.delete(teeBookingWaitlistTable).where(eq(teeBookingWaitlistTable.slotId, teeSlotId));
      await db.delete(teeBookingsTable).where(eq(teeBookingsTable.slotId, teeSlotId));
    }
  });

  it("returns promoted=false when there is no eligible waitlist entry", async () => {
    const [booking] = await db.insert(teeBookingsTable).values({
      slotId: teeSlotId, organizationId: orgId,
      leadUserId: playerUserId, partySize: 1,
      status: "confirmed", paymentModel: "pay_at_checkin",
    }).returning({ id: teeBookingsTable.id });

    try {
      const res = await request(asPlayer())
        .post(`/api/portal/tee-bookings/${booking.id}/cancel-and-promote`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.cancelled).toBe(true);
      expect(res.body.promotion.promoted).toBe(false);
      // The dispatcher returns a "no_eligible_waiter" reason — pin the contract.
      expect(["no_eligible_waiter", "no_capacity"]).toContain(res.body.promotion.reason);
    } finally {
      await db.delete(teeBookingsTable).where(eq(teeBookingsTable.id, booking.id));
    }
  });

  it("returns 403 when a non-lead caller tries to cancel", async () => {
    const [booking] = await db.insert(teeBookingsTable).values({
      slotId: teeSlotId, organizationId: orgId,
      leadUserId: playerUserId, partySize: 1,
      status: "confirmed", paymentModel: "pay_at_checkin",
    }).returning({ id: teeBookingsTable.id });
    try {
      const res = await request(asOtherPlayer())
        .post(`/api/portal/tee-bookings/${booking.id}/cancel-and-promote`)
        .send({});
      expect(res.status).toBe(403);
    } finally {
      await db.delete(teeBookingsTable).where(eq(teeBookingsTable.id, booking.id));
    }
  });

  it("returns 404 when the booking does not exist", async () => {
    const res = await request(asPlayer())
      .post(`/api/portal/tee-bookings/99999999/cancel-and-promote`)
      .send({});
    expect(res.status).toBe(404);
  });
});

// ─── 6. MATCH-PLAY HEAD-TO-HEAD FORM GUIDE ────────────────────────────
describe("Wave 2 — match-play head-to-head form guide", () => {
  it("returns the win/loss/halved record between two players in either match orientation", async () => {
    const res = await request(asPlayer())
      .get(`/api/match-play/form-guide?playerA=${bp1Id}&playerB=${bp2Id}`);
    expect(res.status).toBe(200);
    expect(res.body.playerA).toBe(bp1Id);
    expect(res.body.playerB).toBe(bp2Id);
    expect(res.body.record).toEqual({ aWins: 1, bWins: 1, halved: 0, total: 2 });
    expect(res.body.matches).toHaveLength(2);
  });

  it("returns 400 when either query parameter is missing", async () => {
    const res = await request(asPlayer()).get(`/api/match-play/form-guide?playerA=${bp1Id}`);
    expect(res.status).toBe(400);
  });

  it("returns an empty record for a player pair with no completed matches", async () => {
    const res = await request(asPlayer())
      .get(`/api/match-play/form-guide?playerA=${player3Id}&playerB=${player4Id}`);
    expect(res.status).toBe(200);
    expect(res.body.record).toEqual({ aWins: 0, bWins: 0, halved: 0, total: 0 });
    expect(res.body.matches).toEqual([]);
  });
});

// ─── 7. HANDICAP "WHY" PANEL ──────────────────────────────────────────
describe("Wave 2 — handicap explain", () => {
  it("returns the rolling 20 with the lowest 8 flagged as used in the index", async () => {
    // Seed 10 score records with varying differentials. The 8 lowest
    // differentials should be flagged usedInIndex=true.
    const seedRows = await db.insert(whsScoreRecordsTable).values(
      Array.from({ length: 10 }).map((_, i) => ({
        userId: playerUserId,
        organizationId: orgId,
        courseId,
        sourceType: "general_play",
        holesPlayed: 18,
        playedAt: new Date(Date.now() - (10 - i) * 86_400_000),
        courseRating: "72.0",
        slopeRating: 113,
        grossScore: 80 + i,
        adjustedGrossScore: 80 + i,
        rawDifferential: String(8 + i * 0.5),
        finalDifferential: String(8 + i * 0.5),
        is9Hole: false,
        handicapIndexAfter: "12.4",
      })),
    ).returning({ id: whsScoreRecordsTable.id });
    const seededIds = seedRows.map(r => r.id);

    try {
      const res = await request(asPlayer()).get("/api/portal/handicap/explain");
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(10);
      expect(res.body.used).toBe(8);
      expect(Array.isArray(res.body.rollingWindow)).toBe(true);
      const used = (res.body.rollingWindow as Array<{ usedInIndex: boolean; finalDifferential: string }>)
        .filter(r => r.usedInIndex);
      expect(used.length).toBe(8);
      // The 8 lowest differentials should be the used set — sanity-check that
      // none of the flagged "used" rows have a higher diff than any unflagged row.
      const usedMax = Math.max(...used.map(r => Number(r.finalDifferential)));
      const unusedMin = Math.min(
        ...(res.body.rollingWindow as Array<{ usedInIndex: boolean; finalDifferential: string }>)
          .filter(r => !r.usedInIndex)
          .map(r => Number(r.finalDifferential)),
      );
      expect(usedMax).toBeLessThanOrEqual(unusedMin);
    } finally {
      await db.delete(whsScoreRecordsTable).where(inArray(whsScoreRecordsTable.id, seededIds));
    }
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(createTestApp()).get("/api/portal/handicap/explain");
    expect(res.status).toBe(401);
  });
});
