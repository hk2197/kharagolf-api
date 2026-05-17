/**
 * Integration tests: Cross-club ladder auto-feed (Task #462, coverage Task #600)
 *
 * Verifies that `creditGeneralPlayRoundToLadders` and
 * `creditTournamentResultsToLadders` (the hooks invoked from the general-play
 * confirm route and the tournament completion route respectively) behave per
 * spec:
 *
 *   1. A confirmed general-play round at a participating club credits the
 *      registered player's ladder entry exactly once, even when the hook is
 *      re-invoked for the same round (idempotent on
 *      (ladderId, generalPlayRoundId)).
 *   2. A completed tournament credits every eligible registered player based
 *      on the leaderboard, exactly once per (ladder, entry, tournament). The
 *      points awarded match the ladder format (stableford passes through the
 *      stableford total; stroke uses max(0, 100 - net|gross)).
 *   3. Rounds played outside the ladder season window are ignored.
 *   4. Rounds at organizations that are NOT participating clubs are ignored.
 *   5. Tournament players who are not registered as ladder entries are
 *      ignored, and re-completing the tournament does not double-credit.
 *
 * The mailer + comms + webhook modules used by the routes are not invoked
 * here because the lib hooks are called directly; we don't need to mock them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  holeDetailsTable,
  appUsersTable,
  tournamentsTable,
  playersTable,
  scoresTable,
  generalPlayRoundsTable,
  generalPlayHoleScoresTable,
  crossClubLaddersTable,
  crossClubLadderClubsTable,
  crossClubLadderEntriesTable,
  crossClubLadderResultsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  creditGeneralPlayRoundToLadders,
  creditTournamentResultsToLadders,
} from "../lib/cross-club-ladder-feed.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

let participatingOrgId: number;
let nonParticipatingOrgId: number;
let courseId: number;
let userIdA: number;
let userIdB: number;
let userIdC: number;

const createdLadderIds: number[] = [];
const createdRoundIds: number[] = [];
const createdTournamentIds: number[] = [];

/**
 * Create a fresh ladder + participating-club row + entries for the given
 * users. Returns the ladder id and entry ids keyed by user id so each test
 * can assert against its own isolated ladder without cross-test leakage.
 */
async function makeLadder(opts: {
  format: "stableford" | "stroke" | "national_ladder";
  status?: "active" | "open" | "draft";
  seasonStart: Date;
  seasonEnd: Date;
  /** If true, link participatingOrgId as a club. */
  linkParticipatingOrg?: boolean;
  entryUserIds: Array<{ userId: number; handicap?: number | null }>;
  label: string;
}) {
  const [ladder] = await db.insert(crossClubLaddersTable).values({
    name: `Ladder_${opts.label}_${stamp}`,
    format: opts.format,
    status: opts.status ?? "active",
    scope: "national",
    seasonStart: opts.seasonStart,
    seasonEnd: opts.seasonEnd,
    shareSlug: `ladder-${opts.label}-${stamp}`,
    isPublic: true,
  }).returning({ id: crossClubLaddersTable.id });
  createdLadderIds.push(ladder.id);

  if (opts.linkParticipatingOrg !== false) {
    await db.insert(crossClubLadderClubsTable).values({
      ladderId: ladder.id,
      organizationId: participatingOrgId,
    });
  }

  const entriesByUser = new Map<number, number>();
  for (const e of opts.entryUserIds) {
    const [row] = await db.insert(crossClubLadderEntriesTable).values({
      ladderId: ladder.id,
      userId: e.userId,
      playerName: `Entry_${opts.label}_${e.userId}`,
      handicapAtRegistration: e.handicap != null ? String(e.handicap) : null,
    }).returning({ id: crossClubLadderEntriesTable.id });
    entriesByUser.set(e.userId, row.id);
  }
  return { ladderId: ladder.id, entriesByUser };
}

/** Insert a confirmed general-play round at the participating org. */
async function makeConfirmedRound(opts: {
  userId: number;
  organizationId?: number;
  playedAt?: Date;
  grossScore?: number;
  perHoleStrokes?: number; // strokes per hole, default 5
}) {
  const [round] = await db.insert(generalPlayRoundsTable).values({
    userId: opts.userId,
    organizationId: opts.organizationId ?? participatingOrgId,
    courseId,
    status: "confirmed",
    grossScore: opts.grossScore ?? 90,
    holesPlayed: 18,
    playedAt: opts.playedAt ?? new Date(),
  }).returning({ id: generalPlayRoundsTable.id });
  createdRoundIds.push(round.id);

  const strokes = opts.perHoleStrokes ?? 5;
  for (let h = 1; h <= 18; h++) {
    await db.insert(generalPlayHoleScoresTable).values({
      roundId: round.id,
      holeNumber: h,
      par: 4,
      strokes,
    });
  }
  return round.id;
}

beforeAll(async () => {
  const [orgIn] = await db.insert(organizationsTable).values({
    name: `LadderFeed_In_${stamp}`,
    slug: `ladder-feed-in-${stamp}`,
  }).returning({ id: organizationsTable.id });
  participatingOrgId = orgIn.id;

  const [orgOut] = await db.insert(organizationsTable).values({
    name: `LadderFeed_Out_${stamp}`,
    slug: `ladder-feed-out-${stamp}`,
  }).returning({ id: organizationsTable.id });
  nonParticipatingOrgId = orgOut.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: participatingOrgId,
    name: "Ladder Feed Test Course",
    slug: `ladder-feed-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  for (let h = 1; h <= 18; h++) {
    await db.insert(holeDetailsTable).values({
      courseId,
      holeNumber: h,
      par: 4,
      handicap: h,
    });
  }

  const userSeeds = [
    { key: "a" as const, set: (id: number) => (userIdA = id) },
    { key: "b" as const, set: (id: number) => (userIdB = id) },
    { key: "c" as const, set: (id: number) => (userIdC = id) },
  ];
  for (const u of userSeeds) {
    const [row] = await db.insert(appUsersTable).values({
      replitUserId: `ladder-feed-${stamp}-${u.key}`,
      username: `ladder_feed_${stamp}_${u.key}`,
      email: `ladder_feed_${stamp}_${u.key}@example.com`,
      displayName: `Ladder Tester ${u.key.toUpperCase()}`,
    }).returning({ id: appUsersTable.id });
    u.set(row.id);
  }
});

afterAll(async () => {
  // Order matters: results -> entries -> clubs -> ladders happens via
  // ladder cascade; rounds + scores via tournament/org cascade.
  for (const id of createdRoundIds) {
    await db.delete(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, id));
  }
  for (const id of createdLadderIds) {
    await db.delete(crossClubLaddersTable).where(eq(crossClubLaddersTable.id, id));
  }
  for (const id of createdTournamentIds) {
    await db.delete(tournamentsTable).where(eq(tournamentsTable.id, id));
  }
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  for (const id of [userIdA, userIdB, userIdC]) {
    if (id) await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, participatingOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, nonParticipatingOrgId));
});

describe("creditGeneralPlayRoundToLadders", () => {
  it("credits a confirmed round to the user's ladder entry exactly once and is idempotent on re-trigger", async () => {
    const seasonStart = new Date(Date.now() - 30 * 86_400_000);
    const seasonEnd = new Date(Date.now() + 30 * 86_400_000);
    const { ladderId, entriesByUser } = await makeLadder({
      format: "stableford",
      seasonStart,
      seasonEnd,
      entryUserIds: [{ userId: userIdA, handicap: 18 }],
      label: "gp-idem",
    });

    const roundId = await makeConfirmedRound({ userId: userIdA, perHoleStrokes: 5 });

    await creditGeneralPlayRoundToLadders(roundId);

    const after1 = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    expect(after1).toHaveLength(1);
    expect(after1[0].entryId).toBe(entriesByUser.get(userIdA));
    expect(after1[0].generalPlayRoundId).toBe(roundId);
    // Stableford with PH=18, par=4, SI 1..18, strokes=5 per hole: every
    // hole the player gets at least 1 stroke received → net ≤ par on most
    // holes; total stableford > 0.
    expect(after1[0].stablefordPoints).not.toBeNull();
    expect(after1[0].pointsAwarded).toBe(after1[0].stablefordPoints);

    // Re-trigger: must not create a duplicate row.
    await creditGeneralPlayRoundToLadders(roundId);
    const after2 = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    expect(after2).toHaveLength(1);
    expect(after2[0].id).toBe(after1[0].id);
  });

  it("ignores rounds played outside the ladder season window", async () => {
    const seasonStart = new Date(Date.now() - 60 * 86_400_000);
    const seasonEnd = new Date(Date.now() - 30 * 86_400_000);
    const { ladderId } = await makeLadder({
      format: "stableford",
      seasonStart,
      seasonEnd,
      entryUserIds: [{ userId: userIdA, handicap: 18 }],
      label: "gp-out-of-season",
    });

    // Round played today, well after the season ended.
    const roundId = await makeConfirmedRound({ userId: userIdA });
    await creditGeneralPlayRoundToLadders(roundId);

    const rows = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    expect(rows).toHaveLength(0);
  });

  it("ignores rounds at organizations that are not participating clubs", async () => {
    const seasonStart = new Date(Date.now() - 30 * 86_400_000);
    const seasonEnd = new Date(Date.now() + 30 * 86_400_000);
    const { ladderId } = await makeLadder({
      format: "stableford",
      seasonStart,
      seasonEnd,
      // Only participatingOrgId is linked as a club.
      entryUserIds: [{ userId: userIdA, handicap: 18 }],
      label: "gp-non-club",
    });

    // Played at the org that is NOT a participating club.
    const roundId = await makeConfirmedRound({
      userId: userIdA,
      organizationId: nonParticipatingOrgId,
    });
    await creditGeneralPlayRoundToLadders(roundId);

    const rows = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    expect(rows).toHaveLength(0);
  });

  it("ignores rounds whose status is not 'confirmed'", async () => {
    const seasonStart = new Date(Date.now() - 30 * 86_400_000);
    const seasonEnd = new Date(Date.now() + 30 * 86_400_000);
    const { ladderId } = await makeLadder({
      format: "stableford",
      seasonStart,
      seasonEnd,
      entryUserIds: [{ userId: userIdA, handicap: 18 }],
      label: "gp-unconfirmed",
    });

    const roundId = await makeConfirmedRound({ userId: userIdA });
    await db.update(generalPlayRoundsTable)
      .set({ status: "pending_marker" })
      .where(eq(generalPlayRoundsTable.id, roundId));

    await creditGeneralPlayRoundToLadders(roundId);
    const rows = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    expect(rows).toHaveLength(0);
  });

  it("uses the stroke format formula (max(0, 100 - net)) for stroke ladders", async () => {
    const seasonStart = new Date(Date.now() - 30 * 86_400_000);
    const seasonEnd = new Date(Date.now() + 30 * 86_400_000);
    const { ladderId, entriesByUser } = await makeLadder({
      format: "stroke",
      seasonStart,
      seasonEnd,
      entryUserIds: [{ userId: userIdA, handicap: 18 }],
      label: "gp-stroke",
    });

    // gross 90, handicap 18 → net 72 → points = 100 - 72 = 28
    const roundId = await makeConfirmedRound({ userId: userIdA, grossScore: 90 });
    await creditGeneralPlayRoundToLadders(roundId);

    const rows = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    expect(rows).toHaveLength(1);
    expect(rows[0].entryId).toBe(entriesByUser.get(userIdA));
    expect(rows[0].grossScore).toBe(90);
    expect(rows[0].netScore).toBe(72);
    expect(rows[0].pointsAwarded).toBe(28);
    // stroke format does not need stableford points
    expect(rows[0].stablefordPoints).toBeNull();
  });
});

describe("creditTournamentResultsToLadders", () => {
  /**
   * Build a stroke-play tournament with three players (two registered as
   * ladder entries, one not) and per-hole scores so `computeLeaderboard`
   * returns a deterministic ranking.
   */
  async function makeCompletedTournament(opts: {
    label: string;
    playerUserIds: Array<number | null>;
    perPlayerStrokes: number[]; // length must match
  }) {
    const [t] = await db.insert(tournamentsTable).values({
      organizationId: participatingOrgId,
      courseId,
      name: `Ladder Feed Tournament ${opts.label} ${stamp}`,
      format: "stroke_play",
      status: "completed",
      rounds: 1,
      startDate: new Date(),
      endDate: new Date(),
      maxPlayers: 16,
    }).returning({ id: tournamentsTable.id });
    createdTournamentIds.push(t.id);

    const playerIds: number[] = [];
    for (let i = 0; i < opts.playerUserIds.length; i++) {
      const [p] = await db.insert(playersTable).values({
        tournamentId: t.id,
        userId: opts.playerUserIds[i] ?? null,
        firstName: `Player${i + 1}_${opts.label}`,
        lastName: "LadderFeed",
      }).returning({ id: playersTable.id });
      playerIds.push(p.id);

      const strokes = opts.perPlayerStrokes[i];
      for (let h = 1; h <= 18; h++) {
        await db.insert(scoresTable).values({
          tournamentId: t.id,
          playerId: p.id,
          round: 1,
          holeNumber: h,
          strokes,
        });
      }
    }
    return { tournamentId: t.id, playerIds };
  }

  it("credits each eligible registered player from the leaderboard exactly once", async () => {
    const seasonStart = new Date(Date.now() - 30 * 86_400_000);
    const seasonEnd = new Date(Date.now() + 30 * 86_400_000);
    const { ladderId, entriesByUser } = await makeLadder({
      format: "stableford",
      seasonStart,
      seasonEnd,
      entryUserIds: [
        { userId: userIdA, handicap: 18 },
        { userId: userIdB, handicap: 18 },
      ],
      label: "tx-credit",
    });

    // userIdC plays but is NOT a ladder entry; the third "player" has no
    // userId at all (walk-up registration). Both must be ignored.
    const { tournamentId } = await makeCompletedTournament({
      label: "credit",
      playerUserIds: [userIdA, userIdB, userIdC, null],
      perPlayerStrokes: [4, 5, 6, 7],
    });

    await creditTournamentResultsToLadders(tournamentId);

    const rows = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    // Exactly one row per registered ladder entry that played: A and B.
    expect(rows).toHaveLength(2);
    const entryIds = rows.map(r => r.entryId).sort();
    expect(entryIds).toEqual(
      [entriesByUser.get(userIdA)!, entriesByUser.get(userIdB)!].sort(),
    );
    for (const r of rows) {
      expect(r.tournamentId).toBe(tournamentId);
      expect(r.generalPlayRoundId).toBeNull();
      // Stableford-format ladders pass the leaderboard's stableford total
      // straight through as pointsAwarded.
      expect(r.stablefordPoints).not.toBeNull();
      expect(r.pointsAwarded).toBe(r.stablefordPoints);
    }
  });

  it("uses the stroke format formula (max(0, 100 - net|gross)) for tournament credits", async () => {
    const seasonStart = new Date(Date.now() - 30 * 86_400_000);
    const seasonEnd = new Date(Date.now() + 30 * 86_400_000);
    const { ladderId, entriesByUser } = await makeLadder({
      format: "stroke",
      seasonStart,
      seasonEnd,
      entryUserIds: [
        { userId: userIdA, handicap: 18 },
        { userId: userIdB, handicap: 18 },
      ],
      label: "tx-stroke",
    });

    // Player A: 4 strokes/hole × 18 = gross 72; Player B: 5 × 18 = gross 90.
    const { tournamentId } = await makeCompletedTournament({
      label: "stroke",
      playerUserIds: [userIdA, userIdB],
      perPlayerStrokes: [4, 5],
    });

    await creditTournamentResultsToLadders(tournamentId);

    const rows = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    expect(rows).toHaveLength(2);

    const byEntry = new Map(rows.map(r => [r.entryId, r]));
    const a = byEntry.get(entriesByUser.get(userIdA)!)!;
    const b = byEntry.get(entriesByUser.get(userIdB)!)!;

    // Stroke format = max(0, 100 - net) when net is available, else gross.
    // computeLeaderboard supplies both, so net is preferred.
    expect(a.pointsAwarded).toBe(Math.max(0, 100 - (a.netScore ?? a.grossScore ?? 0)));
    expect(b.pointsAwarded).toBe(Math.max(0, 100 - (b.netScore ?? b.grossScore ?? 0)));
    // And the per-row scores carried through from the leaderboard match the
    // expected raw values (sanity check on the wiring, not just on the
    // formula).
    expect(a.grossScore).toBe(72);
    expect(b.grossScore).toBe(90);
  });

  it("passes stableford points straight through for national_ladder format too", async () => {
    const seasonStart = new Date(Date.now() - 30 * 86_400_000);
    const seasonEnd = new Date(Date.now() + 30 * 86_400_000);
    const { ladderId } = await makeLadder({
      format: "national_ladder",
      seasonStart,
      seasonEnd,
      entryUserIds: [{ userId: userIdA, handicap: 18 }],
      label: "tx-national",
    });

    const { tournamentId } = await makeCompletedTournament({
      label: "national",
      playerUserIds: [userIdA],
      perPlayerStrokes: [5],
    });

    await creditTournamentResultsToLadders(tournamentId);

    const rows = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    expect(rows).toHaveLength(1);
    expect(rows[0].stablefordPoints).not.toBeNull();
    expect(rows[0].pointsAwarded).toBe(rows[0].stablefordPoints);
  });

  it("is idempotent — re-running the hook for the same tournament does not double-credit", async () => {
    const seasonStart = new Date(Date.now() - 30 * 86_400_000);
    const seasonEnd = new Date(Date.now() + 30 * 86_400_000);
    const { ladderId } = await makeLadder({
      format: "stableford",
      seasonStart,
      seasonEnd,
      entryUserIds: [
        { userId: userIdA, handicap: 18 },
        { userId: userIdB, handicap: 18 },
      ],
      label: "tx-idem",
    });

    const { tournamentId } = await makeCompletedTournament({
      label: "idem",
      playerUserIds: [userIdA, userIdB],
      perPlayerStrokes: [4, 5],
    });

    await creditTournamentResultsToLadders(tournamentId);
    const after1 = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    expect(after1).toHaveLength(2);

    await creditTournamentResultsToLadders(tournamentId);
    const after2 = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    expect(after2).toHaveLength(2);
    expect(after2.map(r => r.id).sort()).toEqual(after1.map(r => r.id).sort());
  });

  it("ignores tournaments held outside the ladder season window", async () => {
    const seasonStart = new Date(Date.now() - 60 * 86_400_000);
    const seasonEnd = new Date(Date.now() - 30 * 86_400_000);
    const { ladderId } = await makeLadder({
      format: "stableford",
      seasonStart,
      seasonEnd,
      entryUserIds: [{ userId: userIdA, handicap: 18 }],
      label: "tx-out-of-season",
    });

    const { tournamentId } = await makeCompletedTournament({
      label: "out-of-season",
      playerUserIds: [userIdA],
      perPlayerStrokes: [4],
    });

    await creditTournamentResultsToLadders(tournamentId);
    const rows = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    expect(rows).toHaveLength(0);
  });

  it("ignores tournaments whose status is not 'completed'", async () => {
    const seasonStart = new Date(Date.now() - 30 * 86_400_000);
    const seasonEnd = new Date(Date.now() + 30 * 86_400_000);
    const { ladderId } = await makeLadder({
      format: "stableford",
      seasonStart,
      seasonEnd,
      entryUserIds: [{ userId: userIdA, handicap: 18 }],
      label: "tx-not-completed",
    });

    const { tournamentId } = await makeCompletedTournament({
      label: "not-completed",
      playerUserIds: [userIdA],
      perPlayerStrokes: [4],
    });
    await db.update(tournamentsTable)
      .set({ status: "active" })
      .where(eq(tournamentsTable.id, tournamentId));

    await creditTournamentResultsToLadders(tournamentId);
    const rows = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    expect(rows).toHaveLength(0);
  });
});
