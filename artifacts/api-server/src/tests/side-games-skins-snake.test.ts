/**
 * Task #758 — skins & snake end-to-end coverage.
 *
 * Mirrors the wolf/nassau suite (Task #598) for the other two side games:
 * the mobile capture controls (kharagolf-mobile/components/SideGamesPanel.tsx)
 * and the web admin override editor
 * (kharagolf-web/src/components/SideGamesAdmin.tsx) both push instance config
 * (skins gross/net + carryover + validation, snake 3-putt / 4-putt rules)
 * through the same shape of payload:
 *   PUT  /api/side-game-instances/:id   { rules: {...} }
 * and re-read live standings from
 *   GET  /api/side-game-instances/:id/standings
 *
 * These tests drive that round-trip against a real DB + the engine, covering:
 *   1. Skins — gross + carryover, carryover-off, and birdie-or-better
 *      validation each shape standings as expected.
 *   2. Skins — admin override (web) writing the same final rules as the mobile
 *      flow yields the same standings, regardless of intermediate edits.
 *   3. Snake — fourPuttsAlsoPass on/off changes who holds the snake; tweaking
 *      stake recomputes the per-player nets via the same rules payload.
 *   4. Snake — admin override that ends up with the same rules yields the same
 *      standings as the mobile flow.
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
let skinsTournamentId: number;
let skinsNetTournamentId: number;
let snakeTournamentId: number;
const skinsPlayerIds: number[] = [];    // [A, B, C, D]
const skinsNetPlayerIds: number[] = []; // [A, B, C, D] — A has a 1-stroke handicap
const snakePlayerIds: number[] = [];    // [A, B, C, D]
let skinsInstanceId: number;
let skinsNetInstanceId: number;
let snakeInstanceId: number;

const tag = `t758_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `T758 Org ${tag}`,
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
    organizationId: orgId, name: `T758 Course ${tag}`, slug: `${tag}-course`,
  }).returning();
  courseId = course.id;

  // Holes 1-9, par 4, with handicap stroke index = hole number.  Players
  // have no handicap so handicapStrokes will be 0 across the board — gross
  // and net are identical for every test below.
  await db.insert(holeDetailsTable).values(
    Array.from({ length: 9 }, (_, i) => ({
      courseId, holeNumber: i + 1, par: 4, handicap: i + 1,
    })),
  );

  // ─── Skins tournament: 4 players, holes 1-3 ───────────────────────────
  // Hole 1: A=4 B=5 C=5 D=5  → A wins outright at par
  // Hole 2: A=4 B=4 C=5 D=5  → tie at 4 (carry / no-skin / carry)
  // Hole 3: A=5 B=3 C=5 D=5  → B wins outright with a birdie
  const [skinsT] = await db.insert(tournamentsTable).values({
    organizationId: orgId, courseId,
    name: `T758 Skins Tournament ${tag}`,
    startDate: new Date(),
    rounds: 1,
  }).returning();
  skinsTournamentId = skinsT.id;
  for (const fn of ["A", "B", "C", "D"]) {
    const [p] = await db.insert(playersTable).values({
      tournamentId: skinsTournamentId, firstName: fn, lastName: "P",
    }).returning();
    skinsPlayerIds.push(p.id);
  }
  const [sA, sB, sC, sD] = skinsPlayerIds;
  await db.insert(scoresTable).values([
    { tournamentId: skinsTournamentId, playerId: sA, round: 1, holeNumber: 1, strokes: 4 },
    { tournamentId: skinsTournamentId, playerId: sB, round: 1, holeNumber: 1, strokes: 5 },
    { tournamentId: skinsTournamentId, playerId: sC, round: 1, holeNumber: 1, strokes: 5 },
    { tournamentId: skinsTournamentId, playerId: sD, round: 1, holeNumber: 1, strokes: 5 },
    { tournamentId: skinsTournamentId, playerId: sA, round: 1, holeNumber: 2, strokes: 4 },
    { tournamentId: skinsTournamentId, playerId: sB, round: 1, holeNumber: 2, strokes: 4 },
    { tournamentId: skinsTournamentId, playerId: sC, round: 1, holeNumber: 2, strokes: 5 },
    { tournamentId: skinsTournamentId, playerId: sD, round: 1, holeNumber: 2, strokes: 5 },
    { tournamentId: skinsTournamentId, playerId: sA, round: 1, holeNumber: 3, strokes: 5 },
    { tournamentId: skinsTournamentId, playerId: sB, round: 1, holeNumber: 3, strokes: 3 },
    { tournamentId: skinsTournamentId, playerId: sC, round: 1, holeNumber: 3, strokes: 5 },
    { tournamentId: skinsTournamentId, playerId: sD, round: 1, holeNumber: 3, strokes: 5 },
  ]);
  const [skins] = await db.insert(sideGameInstancesTable).values({
    organizationId: orgId, tournamentId: skinsTournamentId, round: 1, gameType: "skins",
    name: "T758 Skins",
    rules: { scoring: "gross", carryover: true, perSkin: 1 },
    events: {},
    participantPlayerIds: skinsPlayerIds,
    participantNames: Object.fromEntries(skinsPlayerIds.map((id, i) => [id, `${"ABCD"[i]} P`])),
    createdByUserId: adminUserId,
  }).returning();
  skinsInstanceId = skins.id;

  // ─── Skins (net) tournament: 4 players, holes 1-2 ─────────────────────
  // Player A has a 1-stroke handicap (handicapIndex=1, no slope/rating on
  // the course → courseHandicap=1 → 1 stroke on hole 1, si=1).
  // Hole 1 (par 4, si=1):  A=4 (net 3), B=4 (net 4), C=5, D=5
  //   Gross: A & B tie at 4 → carry; Net: A wins outright with 3.
  // Hole 2 (par 4, si=2):  A=5 (no stroke; si=2 > ph=1), B=4, C=5, D=5
  //   Gross: B wins.
  const [skinsNetT] = await db.insert(tournamentsTable).values({
    organizationId: orgId, courseId,
    name: `T758 Skins-Net Tournament ${tag}`,
    startDate: new Date(),
    rounds: 1,
    handicapAllowance: 100,
  }).returning();
  skinsNetTournamentId = skinsNetT.id;
  for (let i = 0; i < 4; i++) {
    const fn = "ABCD"[i];
    const [p] = await db.insert(playersTable).values({
      tournamentId: skinsNetTournamentId, firstName: fn, lastName: "P",
      handicapIndex: i === 0 ? "1" : "0",
    }).returning();
    skinsNetPlayerIds.push(p.id);
  }
  const [snA, snB, snC, snD] = skinsNetPlayerIds;
  await db.insert(scoresTable).values([
    { tournamentId: skinsNetTournamentId, playerId: snA, round: 1, holeNumber: 1, strokes: 4 },
    { tournamentId: skinsNetTournamentId, playerId: snB, round: 1, holeNumber: 1, strokes: 4 },
    { tournamentId: skinsNetTournamentId, playerId: snC, round: 1, holeNumber: 1, strokes: 5 },
    { tournamentId: skinsNetTournamentId, playerId: snD, round: 1, holeNumber: 1, strokes: 5 },
    { tournamentId: skinsNetTournamentId, playerId: snA, round: 1, holeNumber: 2, strokes: 5 },
    { tournamentId: skinsNetTournamentId, playerId: snB, round: 1, holeNumber: 2, strokes: 4 },
    { tournamentId: skinsNetTournamentId, playerId: snC, round: 1, holeNumber: 2, strokes: 5 },
    { tournamentId: skinsNetTournamentId, playerId: snD, round: 1, holeNumber: 2, strokes: 5 },
  ]);
  const [skinsNet] = await db.insert(sideGameInstancesTable).values({
    organizationId: orgId, tournamentId: skinsNetTournamentId, round: 1, gameType: "skins",
    name: "T758 Skins (net)",
    rules: { scoring: "gross", carryover: true, perSkin: 1 },
    events: {},
    participantPlayerIds: skinsNetPlayerIds,
    participantNames: Object.fromEntries(skinsNetPlayerIds.map((id, i) => [id, `${"ABCD"[i]} P`])),
    createdByUserId: adminUserId,
  }).returning();
  skinsNetInstanceId = skinsNet.id;

  // ─── Snake tournament: 4 players, holes 1-9 ───────────────────────────
  // Putts laid out so the snake holder depends on whether 4-putts pass:
  //   Hole 1: A putts 3 → A holds
  //   Hole 3: B putts 3 → B holds
  //   Hole 5: C putts 4 → C holds (only when fourPuttsAlsoPass is true)
  //   Hole 7: D putts 2 → no change
  const [snakeT] = await db.insert(tournamentsTable).values({
    organizationId: orgId, courseId,
    name: `T758 Snake Tournament ${tag}`,
    startDate: new Date(),
    rounds: 1,
  }).returning();
  snakeTournamentId = snakeT.id;
  for (const fn of ["A", "B", "C", "D"]) {
    const [p] = await db.insert(playersTable).values({
      tournamentId: snakeTournamentId, firstName: fn, lastName: "P",
    }).returning();
    snakePlayerIds.push(p.id);
  }
  const [nA, nB, nC, nD] = snakePlayerIds;
  await db.insert(scoresTable).values([
    { tournamentId: snakeTournamentId, playerId: nA, round: 1, holeNumber: 1, strokes: 5, putts: 3 },
    { tournamentId: snakeTournamentId, playerId: nB, round: 1, holeNumber: 3, strokes: 5, putts: 3 },
    { tournamentId: snakeTournamentId, playerId: nC, round: 1, holeNumber: 5, strokes: 6, putts: 4 },
    { tournamentId: snakeTournamentId, playerId: nD, round: 1, holeNumber: 7, strokes: 4, putts: 2 },
  ]);
  const [snake] = await db.insert(sideGameInstancesTable).values({
    organizationId: orgId, tournamentId: snakeTournamentId, round: 1, gameType: "snake",
    name: "T758 Snake",
    rules: { stake: 1, fourPuttsAlsoPass: true },
    events: {},
    participantPlayerIds: snakePlayerIds,
    participantNames: Object.fromEntries(snakePlayerIds.map((id, i) => [id, `${"ABCD"[i]} P`])),
    createdByUserId: adminUserId,
  }).returning();
  snakeInstanceId = snake.id;
});

afterAll(async () => {
  await db.delete(sideGameSettlementsTable).where(inArray(sideGameSettlementsTable.instanceId, [skinsInstanceId, skinsNetInstanceId, snakeInstanceId]));
  await db.delete(sideGameInstancesTable).where(inArray(sideGameInstancesTable.id, [skinsInstanceId, skinsNetInstanceId, snakeInstanceId]));
  await db.delete(scoresTable).where(inArray(scoresTable.tournamentId, [skinsTournamentId, skinsNetTournamentId, snakeTournamentId]));
  await db.delete(playersTable).where(inArray(playersTable.id, [...skinsPlayerIds, ...skinsNetPlayerIds, ...snakePlayerIds]));
  await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, [skinsTournamentId, skinsNetTournamentId, snakeTournamentId]));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function netByPlayer(perPlayer: { playerId: number; net: number }[]): Map<number, number> {
  return new Map(perPlayer.map(p => [p.playerId, p.net]));
}

describe("Task #758 — Skins: rules captured via PUT shape standings", () => {
  it("gross + carryover (default): tie hole carries forward, carry winner sweeps", async () => {
    const [pA, pB, pC, pD] = skinsPlayerIds;
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    const rules = { scoring: "gross", carryover: true, perSkin: 1 };
    const put = await request(app).put(`/api/side-game-instances/${skinsInstanceId}`).send({ rules });
    expect(put.status).toBe(200);
    expect(put.body.rules).toMatchObject(rules);

    const standings = await request(app).get(`/api/side-game-instances/${skinsInstanceId}/standings`);
    expect(standings.status).toBe(200);
    // Hole 1: A wins 1 skin → A +3, others -1.
    // Hole 2: tie → carry 1.
    // Hole 3: B wins 1 + 1 carry = 2 skins → B +6, others -2.
    // Net: A = +3-2 = +1, B = -1+6 = +5, C = -1-2 = -3, D = -1-2 = -3
    const m = netByPlayer(standings.body.standings.perPlayer);
    expect(m.get(pA)).toBe(1);
    expect(m.get(pB)).toBe(5);
    expect(m.get(pC)).toBe(-3);
    expect(m.get(pD)).toBe(-3);
    expect(standings.body.standings.summary).toMatch(/3 skins awarded/);
    const notes = standings.body.standings.perHoleNotes as Array<{ hole: number; note: string }>;
    expect(notes.some(n => n.hole === 2 && /carries/i.test(n.note))).toBe(true);
  });

  it("carryover off: tied hole simply has no skin", async () => {
    const [pA, pB, pC, pD] = skinsPlayerIds;
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    const rules = { scoring: "gross", carryover: false, perSkin: 1 };
    const put = await request(app).put(`/api/side-game-instances/${skinsInstanceId}`).send({ rules });
    expect(put.status).toBe(200);

    const standings = await request(app).get(`/api/side-game-instances/${skinsInstanceId}/standings`);
    // Hole 1: A wins → A +3, others -1.  Hole 2: tie, no skin.  Hole 3: B wins → B +3, others -1.
    // Net: A = +3-1 = +2, B = -1+3 = +2, C = -1-1 = -2, D = -1-1 = -2
    const m = netByPlayer(standings.body.standings.perPlayer);
    expect(m.get(pA)).toBe(2);
    expect(m.get(pB)).toBe(2);
    expect(m.get(pC)).toBe(-2);
    expect(m.get(pD)).toBe(-2);
    const notes = standings.body.standings.perHoleNotes as Array<{ hole: number; note: string }>;
    expect(notes.some(n => n.hole === 2 && /no skin/i.test(n.note))).toBe(true);
  });

  it("birdie-or-better validation rejects par wins, then a real birdie sweeps the carries", async () => {
    const [pA, pB, pC, pD] = skinsPlayerIds;
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    const rules = { scoring: "gross", carryover: true, perSkin: 1, validation: "birdie_or_better" };
    const put = await request(app).put(`/api/side-game-instances/${skinsInstanceId}`).send({ rules });
    expect(put.status).toBe(200);

    const standings = await request(app).get(`/api/side-game-instances/${skinsInstanceId}/standings`);
    // Hole 1: A wins at par 4 — fails birdie validation, carries.
    // Hole 2: tie, carries.
    // Hole 3: B birdies (3 < par 4) → wins 1 + 2 carries = 3 skins → B +9, others -3.
    const m = netByPlayer(standings.body.standings.perPlayer);
    expect(m.get(pA)).toBe(-3);
    expect(m.get(pB)).toBe(9);
    expect(m.get(pC)).toBe(-3);
    expect(m.get(pD)).toBe(-3);
    const notes = standings.body.standings.perHoleNotes as Array<{ hole: number; note: string }>;
    expect(notes.some(n => n.hole === 1 && /not validated/i.test(n.note))).toBe(true);
    // Settlement: C and D each pay 3 to B (the only creditor).
    const settlements = standings.body.standings.settlements as Array<{ fromPlayerId: number; toPlayerId: number; amount: number }>;
    expect(settlements.find(s => s.fromPlayerId === pC && s.toPlayerId === pB)?.amount).toBe(3);
    expect(settlements.find(s => s.fromPlayerId === pD && s.toPlayerId === pB)?.amount).toBe(3);
  });
});

describe("Task #758 — Skins: net scoring uses handicap strokes to break gross ties", () => {
  it("flipping scoring gross→net via PUT recomputes standings using handicapStrokes from the loader", async () => {
    const [pA, pB, pC, pD] = skinsNetPlayerIds;
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    // Gross: hole 1 ties (A=4, B=4) → carry; hole 2 B wins outright with 4
    //         → B sweeps 1 + 1 carry = 2 skins → B +6, others -2.
    const grossPut = await request(app).put(`/api/side-game-instances/${skinsNetInstanceId}`)
      .send({ rules: { scoring: "gross", carryover: true, perSkin: 1 } });
    expect(grossPut.status).toBe(200);
    const gross = await request(app).get(`/api/side-game-instances/${skinsNetInstanceId}/standings`);
    const gm = netByPlayer(gross.body.standings.perPlayer);
    expect(gm.get(pA)).toBe(-2);
    expect(gm.get(pB)).toBe(6);
    expect(gm.get(pC)).toBe(-2);
    expect(gm.get(pD)).toBe(-2);

    // Net: A has 1 stroke on hole 1 (si=1), so net A=3, B=4 → A wins outright
    //      with no carry. Hole 2: A net 5 (no stroke; ph=1, si=2 → 0), B=4
    //      wins outright with 1 skin.
    //      A: +3 (1 skin × 3 losers) -1 (paid to B) = +2
    //      B: -1 (paid to A) + 3 (1 skin × 3 losers) = +2
    //      C: -1 -1 = -2,  D: -1 -1 = -2
    const netPut = await request(app).put(`/api/side-game-instances/${skinsNetInstanceId}`)
      .send({ rules: { scoring: "net", carryover: true, perSkin: 1 } });
    expect(netPut.status).toBe(200);
    expect(netPut.body.rules).toMatchObject({ scoring: "net" });
    const net = await request(app).get(`/api/side-game-instances/${skinsNetInstanceId}/standings`);
    const nm = netByPlayer(net.body.standings.perPlayer);
    expect(nm.get(pA)).toBe(2);
    expect(nm.get(pB)).toBe(2);
    expect(nm.get(pC)).toBe(-2);
    expect(nm.get(pD)).toBe(-2);

    // Settlements: C and D each owe 1 to A and 1 to B.
    const settlements = net.body.standings.settlements as Array<{ fromPlayerId: number; toPlayerId: number; amount: number }>;
    const totalsByCreditor = new Map<number, number>();
    for (const s of settlements) {
      totalsByCreditor.set(s.toPlayerId, (totalsByCreditor.get(s.toPlayerId) ?? 0) + s.amount);
    }
    expect(totalsByCreditor.get(pA)).toBe(2);
    expect(totalsByCreditor.get(pB)).toBe(2);
  });
});

describe("Task #758 — Skins: web admin override produces the same engine result", () => {
  it("an admin override that ends up with identical rules yields identical standings to the mobile flow", async () => {
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    // (a) Mobile path: configure default gross + carryover.
    const mobileRules = { scoring: "gross", carryover: true, perSkin: 1 };
    await request(app).put(`/api/side-game-instances/${skinsInstanceId}`).send({ rules: mobileRules });
    const mobile = await request(app).get(`/api/side-game-instances/${skinsInstanceId}/standings`);

    // (b) Admin web path: scrub rules to a different config, then override
    //     back to the same final state. The PUT body shape is the same
    //     (web admin UI calls PUT /api/side-game-instances/:id with { rules }).
    await request(app).put(`/api/side-game-instances/${skinsInstanceId}`)
      .send({ rules: { scoring: "gross", carryover: false, perSkin: 1, validation: "birdie_or_better" } });
    await request(app).put(`/api/side-game-instances/${skinsInstanceId}`)
      .send({ rules: mobileRules });
    const admin = await request(app).get(`/api/side-game-instances/${skinsInstanceId}/standings`);

    expect(admin.body.standings.perPlayer.map((p: { net: number }) => p.net))
      .toEqual(mobile.body.standings.perPlayer.map((p: { net: number }) => p.net));
    expect(admin.body.standings.settlements)
      .toEqual(mobile.body.standings.settlements);
  });
});

describe("Task #758 — Snake: 3-putt / 4-putt rules captured via PUT shape standings", () => {
  it("with fourPuttsAlsoPass=true (default): the latest 3- or 4-putter holds the snake", async () => {
    const [pA, pB, pC, pD] = snakePlayerIds;
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    const rules = { stake: 1, fourPuttsAlsoPass: true };
    const put = await request(app).put(`/api/side-game-instances/${snakeInstanceId}`).send({ rules });
    expect(put.status).toBe(200);
    expect(put.body.rules).toMatchObject(rules);

    const standings = await request(app).get(`/api/side-game-instances/${snakeInstanceId}/standings`);
    expect(standings.status).toBe(200);
    // Holders in order: A (h1, 3-putt) → B (h3, 3-putt) → C (h5, 4-putt holds because fourPlus=true)
    // → C still holds at end. C pays 1 to each of A,B,D.
    const m = netByPlayer(standings.body.standings.perPlayer);
    expect(m.get(pA)).toBe(1);
    expect(m.get(pB)).toBe(1);
    expect(m.get(pC)).toBe(-3);
    expect(m.get(pD)).toBe(1);
    expect(standings.body.standings.summary).toMatch(/hole 5/);
  });

  it("flipping fourPuttsAlsoPass=false moves the snake back to the latest pure 3-putter", async () => {
    const [pA, pB, pC, pD] = snakePlayerIds;
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    const rules = { stake: 1, fourPuttsAlsoPass: false };
    const put = await request(app).put(`/api/side-game-instances/${snakeInstanceId}`).send({ rules });
    expect(put.status).toBe(200);

    const standings = await request(app).get(`/api/side-game-instances/${snakeInstanceId}/standings`);
    // C's 4-putt is now ignored.  The latest 3-putt is B at hole 3 → B holds.
    const m = netByPlayer(standings.body.standings.perPlayer);
    expect(m.get(pA)).toBe(1);
    expect(m.get(pB)).toBe(-3);
    expect(m.get(pC)).toBe(1);
    expect(m.get(pD)).toBe(1);
    expect(standings.body.standings.summary).toMatch(/hole 3/);
  });

  it("raising the stake recomputes per-player nets via the same rules payload", async () => {
    const [pA, pB, pC, pD] = snakePlayerIds;
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    const rules = { stake: 2, fourPuttsAlsoPass: true };
    const put = await request(app).put(`/api/side-game-instances/${snakeInstanceId}`).send({ rules });
    expect(put.status).toBe(200);

    const standings = await request(app).get(`/api/side-game-instances/${snakeInstanceId}/standings`);
    // C still holds (h5).  Stake doubled → C pays 2 to each of A,B,D.
    const m = netByPlayer(standings.body.standings.perPlayer);
    expect(m.get(pA)).toBe(2);
    expect(m.get(pB)).toBe(2);
    expect(m.get(pC)).toBe(-6);
    expect(m.get(pD)).toBe(2);
    // Settlement: A,B,D each receive 2 from C.
    const settlements = standings.body.standings.settlements as Array<{ fromPlayerId: number; toPlayerId: number; amount: number }>;
    expect(settlements.filter(s => s.fromPlayerId === pC).map(s => s.amount).reduce((a, b) => a + b, 0)).toBe(6);
  });
});

describe("Task #758 — Snake: web admin override produces the same engine result", () => {
  it("an admin override that ends up with identical rules yields identical standings to the mobile flow", async () => {
    const app = createTestApp({ id: adminUserId, username: "admin", role: "org_admin", organizationId: orgId });

    // (a) Mobile path: configure stake=1 with 4-putts passing.
    const mobileRules = { stake: 1, fourPuttsAlsoPass: true };
    await request(app).put(`/api/side-game-instances/${snakeInstanceId}`).send({ rules: mobileRules });
    const mobile = await request(app).get(`/api/side-game-instances/${snakeInstanceId}/standings`);

    // (b) Admin web path: stomp on it (3-putt-only at higher stake), then
    //     override back to the same final state.
    await request(app).put(`/api/side-game-instances/${snakeInstanceId}`)
      .send({ rules: { stake: 5, fourPuttsAlsoPass: false } });
    await request(app).put(`/api/side-game-instances/${snakeInstanceId}`)
      .send({ rules: mobileRules });
    const admin = await request(app).get(`/api/side-game-instances/${snakeInstanceId}/standings`);

    expect(admin.body.standings.perPlayer.map((p: { net: number }) => p.net))
      .toEqual(mobile.body.standings.perPlayer.map((p: { net: number }) => p.net));
    expect(admin.body.standings.settlements)
      .toEqual(mobile.body.standings.settlements);
  });
});
