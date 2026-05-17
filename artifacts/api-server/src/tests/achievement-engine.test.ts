/**
 * Integration tests: badge / achievement engine (Task #623).
 *
 * Verifies `evaluateAchievementsForPlayer` and `evaluateLeagueAchievements`
 * award the right badges for the main categories — first birdie / eagle /
 * hole-in-one, even par + under-par rounds, round-count milestones,
 * tournament champion, and league winner — and that:
 *   • re-running the evaluator does NOT award the same badge twice
 *     (the unique index on (user_id, badge_type) plus `.returning()` make
 *     the operation idempotent), and
 *   • the transactional push notification is dispatched ONLY for the
 *     newly-earned badges in a given evaluation pass — never for badges
 *     that were already in the table.
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
  leaguesTable,
  leagueMembersTable,
  leagueStandingsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { evaluateAchievementsForPlayer, evaluateLeagueAchievements } from "../lib/achievementEngine.js";
import * as comms from "../lib/comms.js";

// ── Per-suite fixtures (one org + course + hole pars, all par 4) ───────────
let orgId: number;
let courseId: number;
const ts = Date.now();

async function createUser(suffix: string): Promise<number> {
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `ach-${suffix}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    username: `ach_${suffix}_${ts}`,
    email: `ach_${suffix}_${ts}@example.com`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  return u.id;
}

async function createTournament(name: string, rounds = 1): Promise<number> {
  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `${name}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    format: "stroke_play",
    status: "active",
    rounds,
  }).returning({ id: tournamentsTable.id });
  return t.id;
}

async function createPlayer(userId: number, tournamentId: number): Promise<number> {
  const [p] = await db.insert(playersTable).values({
    tournamentId,
    userId,
    firstName: "Test",
    lastName: "Player",
    email: `ach_${userId}_${tournamentId}@example.com`,
  }).returning({ id: playersTable.id });
  return p.id;
}

/** Insert one full 18-hole round (round=1) with the supplied per-hole strokes. */
async function insertRound(
  playerId: number,
  tournamentId: number,
  strokesPerHole: number[],
  round = 1,
  putts?: number[],
) {
  const rows = strokesPerHole.map((strokes, i) => ({
    tournamentId,
    playerId,
    round,
    holeNumber: i + 1,
    strokes,
    putts: putts ? putts[i] ?? null : null,
  }));
  await db.insert(scoresTable).values(rows);
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `AchievementEngineTestOrg_${ts}`,
    slug: `ach-engine-test-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: `AchTest Course ${ts}`,
    slug: `ach-test-course-${ts}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  // Hole details — every hole is par 4 (total par 72).
  await db.insert(holeDetailsTable).values(
    Array.from({ length: 18 }, (_, i) => ({
      courseId,
      holeNumber: i + 1,
      par: 4,
    })),
  );
});

afterAll(async () => {
  // Several FKs into appUsers/organizations are RESTRICT (no cascade), so
  // tear down dependent rows in order before removing the org/users.
  // Leagues cascade → league_members + league_standings.
  await db.delete(leaguesTable).where(eq(leaguesTable.organizationId, orgId));
  // Tournaments cascade → players + scores.
  await db.delete(tournamentsTable).where(eq(tournamentsTable.organizationId, orgId));
  // Achievements cascade from user, but also FK org — delete by org to be safe.
  await db.delete(achievementsTable).where(eq(achievementsTable.organizationId, orgId));
  // App users are now safe to remove.
  await db.delete(appUsersTable).where(eq(appUsersTable.organizationId, orgId));
  // Org cleans up courses + hole_details by cascade.
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(() => {
  vi.mocked(comms.sendTransactionalPush).mockClear();
});

// ─── Scoring badges ────────────────────────────────────────────────────────

describe("evaluateAchievementsForPlayer — scoring badges", () => {
  it("awards first_birdie when the user records a birdie (3 on a par 4)", async () => {
    const userId = await createUser("birdie");
    const tId = await createTournament("BirdieT");
    const pId = await createPlayer(userId, tId);

    // Round of all pars except hole 1 is a birdie (3 on par 4)
    const strokes = [3, ...Array(17).fill(4)];
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);

    expect(earned).toContain("first_birdie");
    // Even-par-or-better: 71 vs 72 → also under_par_round AND first_par_round
    expect(earned).toContain("under_par_round");
    expect(earned).toContain("first_par_round");
  });

  it("awards first_eagle when the user records an eagle (2 on a par 4)", async () => {
    const userId = await createUser("eagle");
    const tId = await createTournament("EagleT");
    const pId = await createPlayer(userId, tId);

    const strokes = [2, ...Array(17).fill(4)];
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);

    expect(earned).toContain("first_eagle");
    // Eagle on par 4 also satisfies first_birdie (career birdie count uses
    // toPar === -1 only, so an eagle alone does NOT trigger first_birdie).
    expect(earned).not.toContain("first_birdie");
  });

  it("awards first_hole_in_one for a 1-stroke score on a par-3+ hole", async () => {
    const userId = await createUser("hio");
    const tId = await createTournament("HIO_T");
    const pId = await createPlayer(userId, tId);

    // 1 stroke on hole 1 (par 4). The engine accepts hole-in-one on any
    // hole with par >= 3, so this counts.
    const strokes = [1, ...Array(17).fill(4)];
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).toContain("first_hole_in_one");
  });

  it("awards under_par_round when gross is below course par", async () => {
    const userId = await createUser("under");
    const tId = await createTournament("UnderT");
    const pId = await createPlayer(userId, tId);

    // Three birdies, fifteen pars → 69 vs 72
    const strokes = [3, 3, 3, ...Array(15).fill(4)];
    await insertRound(pId, tId, strokes);

    const earned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(earned).toContain("under_par_round");
  });
});

// ─── Round-count milestone badges ──────────────────────────────────────────

describe("evaluateAchievementsForPlayer — round milestones", () => {
  it("awards 10_rounds badge once the player has 10 completed rounds", async () => {
    const userId = await createUser("rounds10");

    // Spread 10 rounds across 10 separate tournaments (each player row has
    // its own tournamentId — that's how the engine groups rounds).
    const playerRows: Array<{ pId: number; tId: number }> = [];
    for (let i = 0; i < 10; i++) {
      const tId = await createTournament(`Rounds10T${i}`);
      const pId = await createPlayer(userId, tId);
      // Boring all-par round (gross 72) — not under par, so we shouldn't
      // accidentally award scoring badges (still triggers first_par_round).
      await insertRound(pId, tId, Array(18).fill(4));
      playerRows.push({ pId, tId });
    }

    const last = playerRows[playerRows.length - 1];
    const earned = await evaluateAchievementsForPlayer(userId, last.pId, last.tId);

    expect(earned).toContain("10_rounds");
    // 10 distinct tournaments → also satisfies 5_tournaments milestone
    expect(earned).toContain("5_tournaments");
    expect(earned).toContain("10_tournaments");
    // None of the 25/50 rounds badges should fire yet
    expect(earned).not.toContain("25_rounds");
    expect(earned).not.toContain("50_rounds");
  });
});

// ─── Tournament champion ───────────────────────────────────────────────────

describe("evaluateAchievementsForPlayer — tournament champion", () => {
  it("awards tournament_champion to the player with the lowest gross", async () => {
    const winnerUserId = await createUser("champ-winner");
    const loserUserId = await createUser("champ-loser");
    const tId = await createTournament("ChampT");

    const winnerPid = await createPlayer(winnerUserId, tId);
    const loserPid = await createPlayer(loserUserId, tId);

    // Winner shoots 70 (two birdies + 16 pars), loser shoots 76 (four
    // bogeys + 14 pars). Both complete 18 holes.
    await insertRound(winnerPid, tId, [3, 3, ...Array(16).fill(4)]);
    await insertRound(loserPid, tId, [5, 5, 5, 5, ...Array(14).fill(4)]);

    const winnerEarned = await evaluateAchievementsForPlayer(winnerUserId, winnerPid, tId);
    const loserEarned = await evaluateAchievementsForPlayer(loserUserId, loserPid, tId);

    expect(winnerEarned).toContain("tournament_champion");
    expect(loserEarned).not.toContain("tournament_champion");
  });
});

// ─── Idempotency + push-notification semantics ─────────────────────────────

describe("evaluateAchievementsForPlayer — idempotency & push semantics", () => {
  it("does not award the same badge twice on re-evaluation", async () => {
    const userId = await createUser("idem");
    const tId = await createTournament("IdemT");
    const pId = await createPlayer(userId, tId);

    // Birdie on hole 1, rest pars → first_birdie + first_par_round + under_par
    await insertRound(pId, tId, [3, ...Array(17).fill(4)]);

    const first = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(first.length).toBeGreaterThan(0);
    expect(first).toContain("first_birdie");

    // Snapshot the achievements table for this user.
    const afterFirst = await db
      .select({ badgeType: achievementsTable.badgeType })
      .from(achievementsTable)
      .where(eq(achievementsTable.userId, userId));
    const typesAfterFirst = afterFirst.map(r => r.badgeType).sort();

    // Re-run the evaluator with the exact same data.
    const second = await evaluateAchievementsForPlayer(userId, pId, tId);

    // No newly-earned badges on the second pass.
    expect(second).toEqual([]);

    // Achievements table is identical (no duplicates, no extras).
    const afterSecond = await db
      .select({ badgeType: achievementsTable.badgeType })
      .from(achievementsTable)
      .where(eq(achievementsTable.userId, userId));
    const typesAfterSecond = afterSecond.map(r => r.badgeType).sort();
    expect(typesAfterSecond).toEqual(typesAfterFirst);

    // And no row appears more than once for the same badge type.
    const counts = new Map<string, number>();
    for (const t of typesAfterSecond) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);
  });

  it("sends a push notification only when at least one badge is newly earned", async () => {
    const userId = await createUser("push");
    const tId = await createTournament("PushT");
    const pId = await createPlayer(userId, tId);

    await insertRound(pId, tId, [3, ...Array(17).fill(4)]);

    const pushSpy = vi.mocked(comms.sendTransactionalPush);
    pushSpy.mockClear();

    // First pass — should send exactly one push that lists the newly earned
    // badges in its data payload.
    const firstEarned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(firstEarned.length).toBeGreaterThan(0);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    const [recipients, , , data] = pushSpy.mock.calls[0];
    expect(recipients).toEqual([userId]);
    expect((data as { badges?: string[] }).badges).toEqual(firstEarned);

    pushSpy.mockClear();

    // Second pass with no new data — engine returns [] and MUST NOT push.
    const secondEarned = await evaluateAchievementsForPlayer(userId, pId, tId);
    expect(secondEarned).toEqual([]);
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

// ─── League winner ─────────────────────────────────────────────────────────

describe("evaluateLeagueAchievements", () => {
  async function setupLeague(userId: number, position: number): Promise<number> {
    const [league] = await db.insert(leaguesTable).values({
      organizationId: orgId,
      courseId,
      name: `AchLeague-${ts}-${Math.random().toString(36).slice(2, 8)}`,
      format: "stableford",
      type: "individual",
      status: "active",
    }).returning({ id: leaguesTable.id });

    const [member] = await db.insert(leagueMembersTable).values({
      leagueId: league.id,
      userId,
      firstName: "League",
      lastName: "Member",
      email: `leaguemem_${userId}@example.com`,
    }).returning({ id: leagueMembersTable.id });

    await db.insert(leagueStandingsTable).values({
      leagueId: league.id,
      memberId: member.id,
      totalPoints: 100,
      position,
    });

    return league.id;
  }

  it("awards league_winner when the user finishes in position 1", async () => {
    const userId = await createUser("league-win");
    const leagueId = await setupLeague(userId, 1);

    const earned = await evaluateLeagueAchievements(userId, leagueId);
    expect(earned).toContain("league_winner");
  });

  it("does NOT award league_winner when the user finishes elsewhere", async () => {
    const userId = await createUser("league-loss");
    const leagueId = await setupLeague(userId, 4);

    const earned = await evaluateLeagueAchievements(userId, leagueId);
    expect(earned).not.toContain("league_winner");
  });

  it("is idempotent — re-running for a winner does not duplicate the badge", async () => {
    const userId = await createUser("league-idem");
    const leagueId = await setupLeague(userId, 1);

    const first = await evaluateLeagueAchievements(userId, leagueId);
    expect(first).toContain("league_winner");

    const second = await evaluateLeagueAchievements(userId, leagueId);
    expect(second).toEqual([]);

    const rows = await db
      .select({ id: achievementsTable.id })
      .from(achievementsTable)
      .where(and(
        eq(achievementsTable.userId, userId),
        eq(achievementsTable.badgeType, "league_winner"),
      ));
    expect(rows.length).toBe(1);
  });
});
