/**
 * Task #598 — wolf picks & nassau presses end-to-end coverage.
 *
 * The mobile capture controls (kharagolf-mobile/components/SideGamesPanel.tsx)
 * and the web admin override editor (kharagolf-web/src/components/SideGamesAdmin.tsx)
 * both write the same `events` blob to a side-game instance via
 *   PUT /api/side-game-instances/:id   { events: { picks?, presses? } }
 * and re-read live standings from
 *   GET /api/side-game-instances/:id/standings
 *
 * These tests drive that round-trip against a real DB + the engine, covering:
 *   1. Wolf — partner / lone / blind picks each shape standings as expected.
 *   2. Wolf — admin override (web) writing the same final events as the
 *      mobile flow yields the same standings, regardless of intermediate edits.
 *   3. Nassau — calling and removing presses changes events.presses and
 *      makes the standings recompute.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  playersTable,
  tournamentsTable,
  sideGameInstancesTable,
  sideGameSettlementsTable,
  scoresTable,
  coursesTable,
  holeDetailsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let orgId: number;
let adminUserId: number;
let courseId: number;
let wolfTournamentId: number;
let nassauTournamentId: number;
const wolfPlayerIds: number[] = [];   // [A, B, C, D] in wolf tournament
const nassauPlayerIds: number[] = []; // [A, B] in nassau tournament
let wolfInstanceId: number;
let nassauInstanceId: number;

const tag = `t598_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `T598 Org ${tag}`,
    slug: `${tag}-org`,
    contactEmail: `${tag}@example.test`,
  }).returning();
  orgId = org.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}_admin`,
    username: `${tag}_admin`,
    email: `${tag}_admin@example.test`,
    displayName: "Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning();
  adminUserId = admin.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId, name: `T598 Course ${tag}`, slug: `${tag}-course`,
  }).returning();
  courseId = course.id;

  // Holes 1-9, par 4, with handicap stroke index = hole number (so the
  // hardest holes are 1..N as we go).  Players have no handicap so
  // handicapStrokes will be 0 across the board.
  await db.insert(holeDetailsTable).values(
    Array.from({ length: 9 }, (_, i) => ({
      courseId, holeNumber: i + 1, par: 4, handicap: i + 1,
    })),
  );

  // ─── Wolf tournament: 4 players, holes 1-3 only ────────────────────
  const [wolfT] = await db.insert(tournamentsTable).values({
    organizationId: orgId, courseId,
    name: `T598 Wolf Tournament ${tag}`,
    startDate: new Date(),
    rounds: 1,
  }).returning();
  wolfTournamentId = wolfT.id;
  for (const fn of ["A", "B", "C", "D"]) {
    const [p] = await db.insert(playersTable).values({
      tournamentId: wolfTournamentId, firstName: fn, lastName: "P",
    }).returning();
    wolfPlayerIds.push(p.id);
  }
  const [wA, wB, wC, wD] = wolfPlayerIds;

  // Scores chosen so each hole has a clean outcome under default rotation:
  //   Hole 1: A=4 B=5 C=5 D=5  (wolf=A)
  //   Hole 2: B=3 A=4 C=4 D=4  (wolf=B by rotation index 1)
  //   Hole 3: C=5 A=4 B=4 D=4  (wolf=C, pack wins)
  await db.insert(scoresTable).values([
    { tournamentId: wolfTournamentId, playerId: wA, round: 1, holeNumber: 1, strokes: 4 },
    { tournamentId: wolfTournamentId, playerId: wB, round: 1, holeNumber: 1, strokes: 5 },
    { tournamentId: wolfTournamentId, playerId: wC, round: 1, holeNumber: 1, strokes: 5 },
    { tournamentId: wolfTournamentId, playerId: wD, round: 1, holeNumber: 1, strokes: 5 },
    { tournamentId: wolfTournamentId, playerId: wA, round: 1, holeNumber: 2, strokes: 4 },
    { tournamentId: wolfTournamentId, playerId: wB, round: 1, holeNumber: 2, strokes: 3 },
    { tournamentId: wolfTournamentId, playerId: wC, round: 1, holeNumber: 2, strokes: 4 },
    { tournamentId: wolfTournamentId, playerId: wD, round: 1, holeNumber: 2, strokes: 4 },
    { tournamentId: wolfTournamentId, playerId: wA, round: 1, holeNumber: 3, strokes: 4 },
    { tournamentId: wolfTournamentId, playerId: wB, round: 1, holeNumber: 3, strokes: 4 },
    { tournamentId: wolfTournamentId, playerId: wC, round: 1, holeNumber: 3, strokes: 5 },
    { tournamentId: wolfTournamentId, playerId: wD, round: 1, holeNumber: 3, strokes: 4 },
  ]);

  const [wolf] = await db.insert(sideGameInstancesTable).values({
    organizationId: orgId, tournamentId: wolfTournamentId, round: 1, gameType: "wolf",
    name: "T598 Wolf",
    rules: { perHole: 1, loneWolfMultiplier: 2, blindWolfMultiplier: 3, wolfOrder: wolfPlayerIds },
    events: {},
    participantPlayerIds: wolfPlayerIds,
    participantNames: Object.fromEntries(wolfPlayerIds.map((id, i) => [id, `${"ABCD"[i]} P`])),
    createdByUserId: adminUserId,
  }).returning();
  wolfInstanceId = wolf.id;

  // ─── Nassau tournament: A vs B, holes 1-6 ──────────────────────────
  const [nassauT] = await db.insert(tournamentsTable).values({
    organizationId: orgId, courseId,
    name: `T598 Nassau Tournament ${tag}`,
    startDate: new Date(),
    rounds: 1,
  }).returning();
  nassauTournamentId = nassauT.id;
  for (const fn of ["A", "B"]) {
    const [p] = await db.insert(playersTable).values({
      tournamentId: nassauTournamentId, firstName: fn, lastName: "P",
    }).returning();
    nassauPlayerIds.push(p.id);
  }
  const [nA, nB] = nassauPlayerIds;
  // Front (1,2,3): A=4,B=5 (A); A=4,B=3 (B); A=4,B=4 (halve) → A net 0, halved.
  // Back  (4,5,6): A=4,B=5 (A); A=4,B=5 (A); A=5,B=4 (B)    → A net +1, A wins.
  // Total (1..6):  A net 0+1 = +1 → A wins total.
  await db.insert(scoresTable).values([
    { tournamentId: nassauTournamentId, playerId: nA, round: 1, holeNumber: 1, strokes: 4 },
    { tournamentId: nassauTournamentId, playerId: nB, round: 1, holeNumber: 1, strokes: 5 },
    { tournamentId: nassauTournamentId, playerId: nA, round: 1, holeNumber: 2, strokes: 4 },
    { tournamentId: nassauTournamentId, playerId: nB, round: 1, holeNumber: 2, strokes: 3 },
    { tournamentId: nassauTournamentId, playerId: nA, round: 1, holeNumber: 3, strokes: 4 },
    { tournamentId: nassauTournamentId, playerId: nB, round: 1, holeNumber: 3, strokes: 4 },
    { tournamentId: nassauTournamentId, playerId: nA, round: 1, holeNumber: 4, strokes: 4 },
    { tournamentId: nassauTournamentId, playerId: nB, round: 1, holeNumber: 4, strokes: 5 },
    { tournamentId: nassauTournamentId, playerId: nA, round: 1, holeNumber: 5, strokes: 4 },
    { tournamentId: nassauTournamentId, playerId: nB, round: 1, holeNumber: 5, strokes: 5 },
    { tournamentId: nassauTournamentId, playerId: nA, round: 1, holeNumber: 6, strokes: 5 },
    { tournamentId: nassauTournamentId, playerId: nB, round: 1, holeNumber: 6, strokes: 4 },
  ]);

  const [nassau] = await db.insert(sideGameInstancesTable).values({
    organizationId: orgId, tournamentId: nassauTournamentId, round: 1, gameType: "nassau",
    name: "T598 Nassau",
    rules: {
      perSegment: 1, allowPress: true,
      teamA: [nA], teamB: [nB],
      frontHoles: [1, 2, 3], backHoles: [4, 5, 6],
    },
    events: {},
    participantPlayerIds: [nA, nB],
    participantNames: { [nA]: "A P", [nB]: "B P" },
    createdByUserId: adminUserId,
  }).returning();
  nassauInstanceId = nassau.id;
});

afterAll(async () => {
  await db.delete(sideGameSettlementsTable).where(inArray(sideGameSettlementsTable.instanceId, [wolfInstanceId, nassauInstanceId]));
  await db.delete(sideGameInstancesTable).where(inArray(sideGameInstancesTable.id, [wolfInstanceId, nassauInstanceId]));
  await db.delete(scoresTable).where(inArray(scoresTable.tournamentId, [wolfTournamentId, nassauTournamentId]));
  await db.delete(playersTable).where(inArray(playersTable.id, [...wolfPlayerIds, ...nassauPlayerIds]));
  await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, [wolfTournamentId, nassauTournamentId]));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function netByPlayer(perPlayer: { playerId: number; net: number }[]): Map<number, number> {
  return new Map(perPlayer.map(p => [p.playerId, p.net]));
}

describe("Task #598 — Wolf picks: mobile capture flow", () => {
  it("a 'partner' pick on hole 1 writes events.picks and standings credit both teammates", async () => {
    const [pA, pB, pC, pD] = wolfPlayerIds;
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    // Mobile records the wolf's partner pick for hole 1.
    const events = { picks: [{ hole: 1, mode: "partner", partnerPlayerId: pB }] };
    const put = await request(app).put(`/api/side-game-instances/${wolfInstanceId}`).send({ events });
    expect(put.status).toBe(200);
    expect(put.body.events.picks).toEqual(events.picks);

    const standings = await request(app).get(`/api/side-game-instances/${wolfInstanceId}/standings`);
    expect(standings.status).toBe(200);
    // Only hole 1 is "picked"; holes 2 and 3 fall to the engine's default (auto-partner).
    // Hole 1: wolf=A, partner=B → teamWolf=[A,B] best=4, teamRest=[C,D] best=5.
    //         Wolf wins, payout=1, 2 losers × 2 winners = +2 each to A,B; -2 each to C,D.
    // Hole 2: wolf=B, no pick → auto-partner picks lowest teammate (A=4, C=4, D=4 → first match A).
    //         teamWolf=[B,A] best=3, teamRest=[C,D] best=4. Wolf wins, +2 each to A,B; -2 to C,D.
    // Hole 3: wolf=C, no pick → teammates A=4,B=4,D=4 (all tied, picks A).
    //         teamWolf=[C,A] best=4, teamRest=[B,D] best=4 → halved.
    // Totals: A=+4, B=+4, C=-4, D=-4
    const m = netByPlayer(standings.body.standings.perPlayer);
    expect(m.get(pA)).toBe(4);
    expect(m.get(pB)).toBe(4);
    expect(m.get(pC)).toBe(-4);
    expect(m.get(pD)).toBe(-4);
  });

  it("switching hole 1 to 'lone wolf' recomputes standings with the loneWolfMultiplier", async () => {
    const [pA, pB, pC, pD] = wolfPlayerIds;
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    // Mobile re-records the same hole as a lone wolf.
    const events = { picks: [{ hole: 1, mode: "lone" }] };
    const put = await request(app).put(`/api/side-game-instances/${wolfInstanceId}`).send({ events });
    expect(put.status).toBe(200);
    expect(put.body.events.picks).toHaveLength(1);
    expect(put.body.events.picks[0].mode).toBe("lone");

    const standings = await request(app).get(`/api/side-game-instances/${wolfInstanceId}/standings`);
    // Hole 1: wolf=A alone (mult=2). teamWolf=[A] best=4, teamRest=[B,C,D] best=5.
    //         Wolf wins, payout=2 → A +6, others -2 each.
    // Hole 2 & 3: same as before (auto-partner). Hole 2: A,B +2; C,D -2. Hole 3: halved.
    // Totals: A = +6+2+0 = +8, B = -2+2 = 0, C = -2-2 = -4, D = -2-2 = -4
    const m = netByPlayer(standings.body.standings.perPlayer);
    expect(m.get(pA)).toBe(8);
    expect(m.get(pB)).toBe(0);
    expect(m.get(pC)).toBe(-4);
    expect(m.get(pD)).toBe(-4);
  });

  it("switching hole 1 to 'blind wolf' applies the blindWolfMultiplier", async () => {
    const [pA, pB, pC, pD] = wolfPlayerIds;
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    const events = { picks: [{ hole: 1, mode: "blind" }] };
    const put = await request(app).put(`/api/side-game-instances/${wolfInstanceId}`).send({ events });
    expect(put.status).toBe(200);

    const standings = await request(app).get(`/api/side-game-instances/${wolfInstanceId}/standings`);
    // Hole 1: wolf=A alone, mult=3 → A +9, others -3.
    // Hole 2: A,B +2; C,D -2. Hole 3: halved.
    // Totals: A=+11, B=-1, C=-5, D=-5
    const m = netByPlayer(standings.body.standings.perPlayer);
    expect(m.get(pA)).toBe(11);
    expect(m.get(pB)).toBe(-1);
    expect(m.get(pC)).toBe(-5);
    expect(m.get(pD)).toBe(-5);
    // Per-hole note must mention the x3 multiplier in the wolf description.
    const notes = standings.body.standings.perHoleNotes as Array<{ hole: number; note: string }>;
    expect(notes.some(n => n.hole === 1 && /x3/.test(n.note))).toBe(true);
  });
});

describe("Task #598 — Wolf picks: web admin override produces the same engine result", () => {
  it("an admin override that ends up with identical events.picks yields identical standings to the mobile flow", async () => {
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    // (a) Mobile path: capture sequence partner → lone → final 'partner with pB'.
    const [, pB] = wolfPlayerIds;
    const mobileEvents = { picks: [{ hole: 1, mode: "partner", partnerPlayerId: pB }] };
    await request(app).put(`/api/side-game-instances/${wolfInstanceId}`).send({ events: mobileEvents });
    const mobileStandings = await request(app).get(`/api/side-game-instances/${wolfInstanceId}/standings`);

    // (b) Admin web path: scrub events to junk, then override back to the
    //     same final state. The PUT body shape is the same as the mobile editor
    //     (web admin UI calls PUT /api/side-game-instances/:id with { events }).
    await request(app).put(`/api/side-game-instances/${wolfInstanceId}`)
      .send({ events: { picks: [{ hole: 1, mode: "lone" }] } });
    await request(app).put(`/api/side-game-instances/${wolfInstanceId}`)
      .send({ events: mobileEvents });
    const adminStandings = await request(app).get(`/api/side-game-instances/${wolfInstanceId}/standings`);

    expect(adminStandings.body.standings.perPlayer.map((p: { net: number }) => p.net))
      .toEqual(mobileStandings.body.standings.perPlayer.map((p: { net: number }) => p.net));
    expect(adminStandings.body.standings.settlements)
      .toEqual(mobileStandings.body.standings.settlements);
  });
});

describe("Task #598 — Nassau presses: call & remove via PUT /events", () => {
  it("with no presses, front/back/total settle as three independent matches", async () => {
    const [pA, pB] = nassauPlayerIds;
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    // Reset events to empty (mobile starting state).
    await request(app).put(`/api/side-game-instances/${nassauInstanceId}`).send({ events: {} });
    const r = await request(app).get(`/api/side-game-instances/${nassauInstanceId}/standings`);
    expect(r.status).toBe(200);
    // Front (1,2,3): A=4,B=5 (A); A=4,B=3 (B); A=4,B=4 (halve) → A net 0 → halved (perSeg=1, no payout).
    // Back  (4,5,6): A=4,B=5 (A); A=4,B=5 (A); A=5,B=4 (B) → A net +1 → A wins back.
    // Total (1..6): A net 0+1 = +1 → A wins total.
    // Net: A = +0 (front) +1 (back) +1 (total) = +2; B = -2.
    const m = netByPlayer(r.body.standings.perPlayer);
    expect(m.get(pA)).toBe(2);
    expect(m.get(pB)).toBe(-2);
    expect(r.body.standings.summary).toMatch(/Front: halve.*Back: A.*Total: A/);
  });

  it("calling a press updates events.presses and the press sub-match is added to standings", async () => {
    const [pA, pB] = nassauPlayerIds;
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    // Mobile: B presses on the back at hole 6 (only hole 6 — A=5,B=4 → B wins press).
    const events = { presses: [{ hole: 6, calledByTeam: "B", segment: "back" }] };
    const put = await request(app).put(`/api/side-game-instances/${nassauInstanceId}`).send({ events });
    expect(put.status).toBe(200);
    expect(put.body.events.presses).toEqual(events.presses);

    const r = await request(app).get(`/api/side-game-instances/${nassauInstanceId}/standings`);
    // Base: A=+2, B=-2. Press hole 6: A=5,B=4 → B wins press → +1 to B.
    // New net: A = +2-1 = +1; B = -2+1 = -1.
    const m = netByPlayer(r.body.standings.perPlayer);
    expect(m.get(pA)).toBe(1);
    expect(m.get(pB)).toBe(-1);
    const notes = r.body.standings.perHoleNotes as Array<{ hole: number; note: string }>;
    expect(notes.some(n => /press/i.test(n.note))).toBe(true);
  });

  it("removing the press reverts standings to the no-press totals", async () => {
    const [pA, pB] = nassauPlayerIds;
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    // Mobile: clear presses (the SideGamesPanel removePress sends an updated array).
    await request(app).put(`/api/side-game-instances/${nassauInstanceId}`).send({ events: { presses: [] } });
    const r = await request(app).get(`/api/side-game-instances/${nassauInstanceId}/standings`);
    const m = netByPlayer(r.body.standings.perPlayer);
    expect(m.get(pA)).toBe(2);
    expect(m.get(pB)).toBe(-2);
  });

  it("admin override that ends up with the same press list yields the same standings as the mobile flow", async () => {
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    // Mobile flow: call one press, settle.
    const finalEvents = { presses: [{ hole: 6, calledByTeam: "B", segment: "back" }] };
    await request(app).put(`/api/side-game-instances/${nassauInstanceId}`).send({ events: finalEvents });
    const mobile = await request(app).get(`/api/side-game-instances/${nassauInstanceId}/standings`);

    // Admin override flow: stomp on it with extras then re-issue the same final list.
    await request(app).put(`/api/side-game-instances/${nassauInstanceId}`).send({
      events: { presses: [
        { hole: 4, calledByTeam: "A", segment: "back" },
        { hole: 6, calledByTeam: "B", segment: "back" },
      ] },
    });
    await request(app).put(`/api/side-game-instances/${nassauInstanceId}`).send({ events: finalEvents });
    const admin = await request(app).get(`/api/side-game-instances/${nassauInstanceId}/standings`);

    expect(admin.body.standings.perPlayer.map((p: { net: number }) => p.net))
      .toEqual(mobile.body.standings.perPlayer.map((p: { net: number }) => p.net));
    expect(admin.body.standings.settlements)
      .toEqual(mobile.body.standings.settlements);
  });
});
