/**
 * Integration tests: extra badge categories (Tasks #783 + #928).
 *
 * Task #623 covered the headline badge groups. This sibling suite fills the
 * remaining-coverage gap called out in #783 + #928 for:
 *   • GIR 50%+ for 5 rounds       (gir_50_pct, consistency)
 *   • Fairway 50%+ for 5 rounds   (fairway_50_pct, consistency)
 *   • Low-putts round             (low_putts_round, consistency)
 *   • Comeback king               (comeback_king, scoring)
 *   • Bogey-free round            (bogey_free_round, scoring)
 *   • 3+ birdies in a round       (3_birdies_round, scoring)
 *   • Hat trick (3 in a row)      (hat_trick_birdies, scoring)
 *   • Eagle on a par 5            (eagle_par5, scoring)
 *   • Back-9 birdie blitz         (back_nine_birdie_blitz, scoring)
 *   • 9-hole hero (under par 9)   (9_hole_hero, scoring)
 *   • Scratch round               (scratch_round, scoring)
 *   • 10 distinct courses         (10_courses, social)
 *   • Perfect attendance          (perfect_attendance, seasonal)
 *
 * Each rule is exercised with at least one positive case and one negative
 * boundary case. Follows the same DB-fixture / mocked-comms pattern as
 * `achievement-engine.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
  sendTransactionalSms: vi.fn(async () => undefined),
  sendBroadcast: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  coursesTable,
  holeDetailsTable,
  tournamentsTable,
  playersTable,
  scoresTable,
  achievementsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { evaluateAchievementsForPlayer } from "../lib/achievementEngine.js";
import * as comms from "../lib/comms.js";

let orgId: number;
let courseId: number;
const ts = Date.now();

async function createUser(suffix: string): Promise<number> {
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `ach-x-${suffix}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    username: `ach_x_${suffix}_${ts}_${Math.random().toString(36).slice(2, 6)}`,
    email: `ach_x_${suffix}_${ts}_${Math.random().toString(36).slice(2, 6)}@example.com`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  return u.id;
}

async function createTournament(name: string, rounds = 1, overrideCourseId?: number): Promise<number> {
  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId: overrideCourseId ?? courseId,
    name: `${name}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    format: "stroke_play",
    status: "active",
    rounds,
  }).returning({ id: tournamentsTable.id });
  return t.id;
}

/**
 * Create a one-off course with arbitrary per-hole pars. Useful for
 * eagle-on-par-5 tests since the default test course is all par 4.
 */
async function createCourseWithPars(suffix: string, holePars: number[]): Promise<number> {
  const [c] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: `AchExtra Course ${suffix} ${ts}`,
    slug: `ach-extra-course-${suffix}-${ts}-${Math.random().toString(36).slice(2, 6)}`,
    holes: holePars.length,
    par: holePars.reduce((a, p) => a + p, 0),
  }).returning({ id: coursesTable.id });
  await db.insert(holeDetailsTable).values(
    holePars.map((par, i) => ({ courseId: c.id, holeNumber: i + 1, par })),
  );
  return c.id;
}

async function createPlayer(userId: number, tournamentId: number): Promise<number> {
  const [p] = await db.insert(playersTable).values({
    tournamentId,
    userId,
    firstName: "Test",
    lastName: "Player",
    email: `ach_x_${userId}_${tournamentId}@example.com`,
  }).returning({ id: playersTable.id });
  return p.id;
}

type RoundOpts = {
  round?: number;
  putts?: (number | null)[];
  girHit?: (boolean | null)[];
  fairwayHit?: (boolean | null)[];
};

async function insertRound(
  playerId: number,
  tournamentId: number,
  strokesPerHole: number[],
  opts: RoundOpts = {},
) {
  const round = opts.round ?? 1;
  const rows = strokesPerHole.map((strokes, i) => ({
    tournamentId,
    playerId,
    round,
    holeNumber: i + 1,
    strokes,
    putts: opts.putts ? opts.putts[i] ?? null : null,
    girHit: opts.girHit ? opts.girHit[i] ?? null : null,
    fairwayHit: opts.fairwayHit ? opts.fairwayHit[i] ?? null : null,
  }));
  await db.insert(scoresTable).values(rows);
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `AchExtraTestOrg_${ts}`,
    slug: `ach-extra-test-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: `AchExtra Course ${ts}`,
    slug: `ach-extra-course-${ts}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  // Every hole par 4 → total course par 72.
  await db.insert(holeDetailsTable).values(
    Array.from({ length: 18 }, (_, i) => ({
      courseId,
      holeNumber: i + 1,
      par: 4,
    })),
  );
});

afterAll(async () => {
  await db.delete(tournamentsTable).where(eq(tournamentsTable.organizationId, orgId));
  await db.delete(achievementsTable).where(eq(achievementsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.organizationId, orgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(() => {
  vi.mocked(comms.sendTransactionalPush).mockClear();
});

// ─── Bogey-free round ──────────────────────────────────────────────────────

describe("bogey_free_round", () => {
  it("awards bogey_free_round when no hole is over par", async () => {
    const userId = await createUser("bf-pos");
    const tId = await createTournament("BogeyFreePos");
    const pId = await createPlayer(userId, tId);

    // All pars (under par on a hole would also be fine; the rule only
    // disqualifies bogeys-or-worse).
    await insertRound(pId, tId, Array(18).fill(4));

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).toContain("bogey_free_round");
  });

  it("does NOT award bogey_free_round when even a single hole is +1", async () => {
    const userId = await createUser("bf-neg");
    const tId = await createTournament("BogeyFreeNeg");
    const pId = await createPlayer(userId, tId);

    // 17 pars + one bogey on hole 1 (5 on a par 4) → should be excluded.
    const strokes = [5, ...Array(17).fill(4)];
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).not.toContain("bogey_free_round");
  });
});

// ─── Comeback king ─────────────────────────────────────────────────────────

describe("comeback_king", () => {
  it("awards comeback_king when +5 through 9 turns into under par by 18", async () => {
    const userId = await createUser("cb-pos");
    const tId = await createTournament("ComebackPos");
    const pId = await createPlayer(userId, tId);

    // Front 9: five bogeys (5 on par 4) + four pars → 41 vs par 36 (+5).
    // Back 9: five birdies (3 on par 4) + four pars → 31 vs par 36 (-5).
    // Total: 72 ... that's even par, not under. Drop one more stroke:
    // Back 9: six birdies + three pars → 30 vs 36 (-6). Total 71 = -1.
    const front9 = [5, 5, 5, 5, 5, 4, 4, 4, 4]; // sum 41
    const back9 = [3, 3, 3, 3, 3, 3, 4, 4, 4];  // sum 30
    await insertRound(pId, tId, [...front9, ...back9]);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).toContain("comeback_king");
  });

  it("does NOT award comeback_king when the final score is not under par", async () => {
    const userId = await createUser("cb-neg");
    const tId = await createTournament("ComebackNeg");
    const pId = await createPlayer(userId, tId);

    // Front 9 +5 (41 vs 36), back 9 -5 (31 vs 36) → total 72 = even par.
    // Boundary: rule requires totalToPar < 0, so even par must NOT trigger.
    const front9 = [5, 5, 5, 5, 5, 4, 4, 4, 4]; // 41
    const back9 = [3, 3, 3, 3, 3, 4, 4, 4, 4];  // 31
    await insertRound(pId, tId, [...front9, ...back9]);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).not.toContain("comeback_king");
  });
});

// ─── Low-putts round ───────────────────────────────────────────────────────

describe("low_putts_round", () => {
  it("awards low_putts_round when average putts per hole is under 1.8", async () => {
    const userId = await createUser("putt-pos");
    const tId = await createTournament("PuttPos");
    const pId = await createPlayer(userId, tId);

    // Putts: nine 1-putts and nine 2-putts → average 1.5 < 1.8.
    const putts = [...Array(9).fill(1), ...Array(9).fill(2)];
    await insertRound(pId, tId, Array(18).fill(4), { putts });

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).toContain("low_putts_round");
  });

  it("does NOT award low_putts_round when the average is exactly 1.8 (boundary)", async () => {
    const userId = await createUser("putt-neg");
    const tId = await createTournament("PuttNeg");
    const pId = await createPlayer(userId, tId);

    // 10 holes with putts data, average exactly 1.8 (not strictly less).
    // Other holes: putts left null (excluded from the average).
    // [2,2,2,2,2,2,2,2,1,1] sum 18 / 10 = 1.8.
    const putts: (number | null)[] = [2, 2, 2, 2, 2, 2, 2, 2, 1, 1, null, null, null, null, null, null, null, null];
    await insertRound(pId, tId, Array(18).fill(4), { putts });

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).not.toContain("low_putts_round");
  });
});

// ─── GIR 50%+ for 5 rounds ─────────────────────────────────────────────────

describe("gir_50_pct", () => {
  // Helper: one round with `hits` GIR-true values out of 18 holes.
  function girArray(hits: number): boolean[] {
    return [
      ...Array(hits).fill(true),
      ...Array(18 - hits).fill(false),
    ];
  }

  it("awards gir_50_pct after 5 rounds at >=50% GIR", async () => {
    const userId = await createUser("gir-pos");

    // Five tournaments, one round each, 9/18 GIR (= 50%).
    let lastPid = 0;
    let lastTid = 0;
    for (let i = 0; i < 5; i++) {
      const tId = await createTournament(`GIRposT${i}`);
      const pId = await createPlayer(userId, tId);
      await insertRound(pId, tId, Array(18).fill(4), { girHit: girArray(9) });
      lastPid = pId;
      lastTid = tId;
    }

    const earned = await evaluateAchievementsForPlayer(userId, lastPid, lastTid);
    expect(earned).toContain("gir_50_pct");
  });

  it("does NOT award gir_50_pct with only 4 qualifying rounds (boundary)", async () => {
    const userId = await createUser("gir-neg");

    // Four rounds at 50%, plus one round below 50% (8/18 hits).
    let lastPid = 0;
    let lastTid = 0;
    for (let i = 0; i < 4; i++) {
      const tId = await createTournament(`GIRnegT${i}`);
      const pId = await createPlayer(userId, tId);
      await insertRound(pId, tId, Array(18).fill(4), { girHit: girArray(9) });
      lastPid = pId;
      lastTid = tId;
    }
    // 5th round only 8/18 GIR → does NOT count toward the 5-round threshold.
    {
      const tId = await createTournament(`GIRnegTbelow`);
      const pId = await createPlayer(userId, tId);
      await insertRound(pId, tId, Array(18).fill(4), { girHit: girArray(8) });
      lastPid = pId;
      lastTid = tId;
    }

    const earned = await evaluateAchievementsForPlayer(userId, lastPid, lastTid);
    expect(earned).not.toContain("gir_50_pct");
  });
});

// ─── Fairway 50%+ for 5 rounds ─────────────────────────────────────────────

describe("fairway_50_pct", () => {
  // Helper: 18-hole fairway-hit array. Holes 1-4 are par 3 in real life so
  // fairwayHit is typically null on those, but our test course is all par 4
  // so we just provide booleans across all 18 holes.
  function fwArray(hits: number): boolean[] {
    return [
      ...Array(hits).fill(true),
      ...Array(18 - hits).fill(false),
    ];
  }

  it("awards fairway_50_pct after 5 rounds at >=50% fairways hit", async () => {
    const userId = await createUser("fw-pos");

    let lastPid = 0;
    let lastTid = 0;
    for (let i = 0; i < 5; i++) {
      const tId = await createTournament(`FWposT${i}`);
      const pId = await createPlayer(userId, tId);
      // 9/18 fairways hit (50%).
      await insertRound(pId, tId, Array(18).fill(4), { fairwayHit: fwArray(9) });
      lastPid = pId;
      lastTid = tId;
    }

    const earned = await evaluateAchievementsForPlayer(userId, lastPid, lastTid);
    expect(earned).toContain("fairway_50_pct");
  });

  it("does NOT award fairway_50_pct when one of 5 rounds is below 50% (boundary)", async () => {
    const userId = await createUser("fw-neg");

    let lastPid = 0;
    let lastTid = 0;
    for (let i = 0; i < 4; i++) {
      const tId = await createTournament(`FWnegT${i}`);
      const pId = await createPlayer(userId, tId);
      await insertRound(pId, tId, Array(18).fill(4), { fairwayHit: fwArray(9) });
      lastPid = pId;
      lastTid = tId;
    }
    // 5th round is only 8/18 fairways → not a qualifying round.
    {
      const tId = await createTournament(`FWnegTbelow`);
      const pId = await createPlayer(userId, tId);
      await insertRound(pId, tId, Array(18).fill(4), { fairwayHit: fwArray(8) });
      lastPid = pId;
      lastTid = tId;
    }

    const earned = await evaluateAchievementsForPlayer(userId, lastPid, lastTid);
    expect(earned).not.toContain("fairway_50_pct");
  });
});

// ─── 3+ birdies in a round ────────────────────────────────────────────────

describe("3_birdies_round", () => {
  it("awards 3_birdies_round when there are exactly 3 birdies", async () => {
    const userId = await createUser("3bd-pos");
    const tId = await createTournament("ThreeBirdiesPos");
    const pId = await createPlayer(userId, tId);

    // 3 birdies (3 on par 4) on holes 1-3, pars on the rest.
    const strokes = [3, 3, 3, ...Array(15).fill(4)];
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).toContain("3_birdies_round");
  });

  it("does NOT award 3_birdies_round with only 2 birdies (boundary)", async () => {
    const userId = await createUser("3bd-neg");
    const tId = await createTournament("ThreeBirdiesNeg");
    const pId = await createPlayer(userId, tId);

    // Exactly 2 birdies on holes 1-2, pars elsewhere → should NOT trigger.
    const strokes = [3, 3, ...Array(16).fill(4)];
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).not.toContain("3_birdies_round");
  });
});

// ─── Hat trick (3 consecutive birdies) ────────────────────────────────────

describe("hat_trick_birdies", () => {
  it("awards hat_trick_birdies on 3 consecutive birdies", async () => {
    const userId = await createUser("hat-pos");
    const tId = await createTournament("HatTrickPos");
    const pId = await createPlayer(userId, tId);

    // Birdies on holes 4-5-6 (consecutive), pars elsewhere.
    const strokes = Array(18).fill(4);
    strokes[3] = 3; strokes[4] = 3; strokes[5] = 3;
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).toContain("hat_trick_birdies");
  });

  it("does NOT award hat_trick_birdies when birdies are not consecutive (boundary)", async () => {
    const userId = await createUser("hat-neg");
    const tId = await createTournament("HatTrickNeg");
    const pId = await createPlayer(userId, tId);

    // 2 consecutive birdies (holes 1-2), a par to break the streak, then
    // another birdie on hole 4 → still 3 birdies in the round (so
    // 3_birdies_round may fire), but hat_trick_birdies must NOT.
    const strokes = Array(18).fill(4);
    strokes[0] = 3; strokes[1] = 3; strokes[3] = 3;
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).not.toContain("hat_trick_birdies");
  });
});

// ─── Eagle on a par 5 ─────────────────────────────────────────────────────

describe("eagle_par5", () => {
  it("awards eagle_par5 when player makes 3 strokes on a par-5 hole", async () => {
    const userId = await createUser("eag5-pos");
    // Custom course: hole 1 is par 5, holes 2-18 are par 4.
    const par5CourseId = await createCourseWithPars("p5pos", [5, ...Array(17).fill(4)]);
    const tId = await createTournament("EaglePar5Pos", 1, par5CourseId);
    const pId = await createPlayer(userId, tId);

    // 3 strokes on the par 5 (eagle, -2), pars on the rest.
    const strokes = [3, ...Array(17).fill(4)];
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).toContain("eagle_par5");
  });

  it("does NOT award eagle_par5 when the eagle is on a par 4 (boundary)", async () => {
    const userId = await createUser("eag5-neg");
    // Default course is all par 4. An eagle here (2 strokes on a par 4)
    // satisfies first_eagle, but NOT eagle_par5.
    const tId = await createTournament("EaglePar5Neg");
    const pId = await createPlayer(userId, tId);

    const strokes = [2, ...Array(17).fill(4)];
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).toContain("first_eagle"); // sanity check the eagle did register
    expect(earned).not.toContain("eagle_par5");
  });
});

// ─── Back-9 birdie blitz ──────────────────────────────────────────────────

describe("back_nine_birdie_blitz", () => {
  it("awards back_nine_birdie_blitz when 3+ birdies fall on holes 10-18", async () => {
    const userId = await createUser("b9-pos");
    const tId = await createTournament("Back9Pos");
    const pId = await createPlayer(userId, tId);

    // Pars on the front 9, 3 birdies on holes 10-12, pars on the rest.
    const strokes = Array(18).fill(4);
    strokes[9] = 3; strokes[10] = 3; strokes[11] = 3;
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).toContain("back_nine_birdie_blitz");
  });

  it("does NOT award back_nine_birdie_blitz when only 2 birdies are on the back 9 (boundary)", async () => {
    const userId = await createUser("b9-neg");
    const tId = await createTournament("Back9Neg");
    const pId = await createPlayer(userId, tId);

    // 5 birdies on the front 9 (so 3_birdies_round still fires) but only
    // 2 birdies on the back 9 → should NOT award the back-9 blitz.
    const strokes = Array(18).fill(4);
    strokes[0] = 3; strokes[1] = 3; strokes[2] = 3; strokes[3] = 3; strokes[4] = 3;
    strokes[10] = 3; strokes[11] = 3;
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).not.toContain("back_nine_birdie_blitz");
  });
});

// ─── 9-hole hero (under par on either nine) ───────────────────────────────

describe("9_hole_hero", () => {
  it("awards 9_hole_hero when the front 9 is under par", async () => {
    const userId = await createUser("9hh-pos");
    const tId = await createTournament("NineHeroPos");
    const pId = await createPlayer(userId, tId);

    // Front 9: one birdie (3) + 8 pars → 35 vs 36 (-1, under par).
    // Back 9: all pars → even par.
    const front9 = [3, 4, 4, 4, 4, 4, 4, 4, 4];
    const back9 = Array(9).fill(4);
    await insertRound(pId, tId, [...front9, ...back9]);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).toContain("9_hole_hero");
  });

  it("does NOT award 9_hole_hero when both nines are exactly even par (boundary)", async () => {
    const userId = await createUser("9hh-neg");
    const tId = await createTournament("NineHeroNeg");
    const pId = await createPlayer(userId, tId);

    // All pars: each nine is exactly even — strictly under-par is required.
    await insertRound(pId, tId, Array(18).fill(4));

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).not.toContain("9_hole_hero");
  });
});

// ─── Scratch round (gross ≤ course par) ──────────────────────────────────

describe("scratch_round", () => {
  it("awards scratch_round when the gross score equals course par", async () => {
    const userId = await createUser("sr-pos");
    const tId = await createTournament("ScratchPos");
    const pId = await createPlayer(userId, tId);

    // 18 pars → gross 72 = course par 72.
    await insertRound(pId, tId, Array(18).fill(4));

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).toContain("scratch_round");
  });

  it("does NOT award scratch_round when the gross is +1 over par (boundary)", async () => {
    const userId = await createUser("sr-neg");
    const tId = await createTournament("ScratchNeg");
    const pId = await createPlayer(userId, tId);

    // 17 pars + one bogey → gross 73 vs par 72 (+1).
    const strokes = [5, ...Array(17).fill(4)];
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).not.toContain("scratch_round");
  });
});

// ─── 10 distinct courses ──────────────────────────────────────────────────

describe("10_courses", () => {
  it("awards 10_courses after the player has played on 10 distinct courses", async () => {
    const userId = await createUser("10c-pos");

    // 10 brand-new courses, one tournament + round on each.
    let lastPid = 0;
    let lastTid = 0;
    for (let i = 0; i < 10; i++) {
      const cId = await createCourseWithPars(`pos${i}`, Array(18).fill(4));
      const tId = await createTournament(`TenCoursesPos${i}`, 1, cId);
      const pId = await createPlayer(userId, tId);
      await insertRound(pId, tId, Array(18).fill(4));
      lastPid = pId;
      lastTid = tId;
    }

    const earned = await evaluateAchievementsForPlayer(userId, lastPid, lastTid);
    expect(earned).toContain("10_courses");
  });

  it("does NOT award 10_courses with only 9 distinct courses (boundary)", async () => {
    const userId = await createUser("10c-neg");

    // 9 distinct courses, plus one tournament that re-uses an existing course
    // → 10 tournaments but still only 9 distinct courses.
    let lastPid = 0;
    let lastTid = 0;
    let firstCourseId = 0;
    for (let i = 0; i < 9; i++) {
      const cId = await createCourseWithPars(`neg${i}`, Array(18).fill(4));
      if (i === 0) firstCourseId = cId;
      const tId = await createTournament(`TenCoursesNeg${i}`, 1, cId);
      const pId = await createPlayer(userId, tId);
      await insertRound(pId, tId, Array(18).fill(4));
      lastPid = pId;
      lastTid = tId;
    }
    // 10th tournament on the same course as #0 → still 9 distinct courses.
    {
      const tId = await createTournament(`TenCoursesNegDup`, 1, firstCourseId);
      const pId = await createPlayer(userId, tId);
      await insertRound(pId, tId, Array(18).fill(4));
      lastPid = pId;
      lastTid = tId;
    }

    const earned = await evaluateAchievementsForPlayer(userId, lastPid, lastTid);
    expect(earned).not.toContain("10_courses");
  });
});

// ─── Perfect attendance ───────────────────────────────────────────────────

describe("perfect_attendance", () => {
  it("awards perfect_attendance when the player completes every round of a 2-round event", async () => {
    const userId = await createUser("pa-pos");
    const tId = await createTournament("PerfectAttPos", 2);
    const pId = await createPlayer(userId, tId);

    // Both rounds played in full.
    await insertRound(pId, tId, Array(18).fill(4), { round: 1 });
    await insertRound(pId, tId, Array(18).fill(4), { round: 2 });

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).toContain("perfect_attendance");
  });

  it("does NOT award perfect_attendance when the player skips a round (boundary)", async () => {
    const userId = await createUser("pa-neg");
    const tId = await createTournament("PerfectAttNeg", 2);
    const pId = await createPlayer(userId, tId);

    // Only round 1 played; round 2 missing → 1 of 2 rounds, should NOT trigger.
    await insertRound(pId, tId, Array(18).fill(4), { round: 1 });

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).not.toContain("perfect_attendance");
  });
});
