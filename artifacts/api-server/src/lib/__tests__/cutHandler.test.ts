/**
 * Integration tests for `applyCut` (lib/cutHandler.ts) — Task #1339.
 *
 * These tests pin down the upstream cut/un-cut workflow that sets and
 * clears `players.cut_at`. The downstream `computeLeaderboard` override
 * is already covered by `realtime-cut-tracking.test.ts` (Task #1164);
 * here we verify that `applyCut` itself segregates the right players.
 *
 * Cut-line math (per cutHandler.ts, Task #1599): the round-par is read
 * from the tournament's actual course (via `courses.par` or the sum of
 * `hole_details.par`), so `cutLineStrokes = totalPar + tournament.cutLine`.
 * Survivors satisfy `totalStrokes <= cutLineStrokes`; everyone else is
 * cut. Survivors get `cut_at = NULL`, the cut group gets `now()`.
 *
 * Where a tournament has no course attached, the helper falls back to
 * the legacy 72 default so existing single-course tests keep working
 * even if they don't seed a course explicitly.
 *
 * Players who have no scores in the requested rounds are NOT included
 * in the SUM/GROUP BY result, so `applyCut` neither cuts nor clears
 * them. We document and pin that behaviour explicitly so an accidental
 * outer-join refactor can't silently flip it.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  db,
  organizationsTable,
  tournamentsTable,
  playersTable,
  scoresTable,
  coursesTable,
  holeDetailsTable,
  tournamentRoundsTable,
} from "@workspace/db";
import { eq, inArray, isNull, isNotNull, and } from "drizzle-orm";
import { applyCut } from "../cutHandler.js";

const createdOrgIds: number[] = [];
const createdTournamentIds: number[] = [];
const createdPlayerIds: number[] = [];
const createdCourseIds: number[] = [];

/**
 * Seed a course (default par 72, 18 holes). When `holeParPattern` is
 * provided we also seed a `hole_details` row per hole — this is what
 * lets `applyCut` use the exact per-hole par instead of the
 * course-level default.
 */
async function seedCourse(
  organizationId: number,
  opts: { par?: number; holes?: number; holeParPattern?: number[] } = {},
): Promise<number> {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const par = opts.par ?? 72;
  const holes = opts.holes ?? 18;
  const [c] = await db.insert(coursesTable).values({
    organizationId,
    name: `CutHandlerCourse_${ts}`,
    slug: `cut-handler-course-${ts}`,
    par,
    holes,
  }).returning({ id: coursesTable.id });
  createdCourseIds.push(c.id);

  if (opts.holeParPattern) {
    if (opts.holeParPattern.length !== holes) {
      throw new Error(
        `holeParPattern length (${opts.holeParPattern.length}) must match holes (${holes})`,
      );
    }
    await db.insert(holeDetailsTable).values(
      opts.holeParPattern.map((p, i) => ({
        courseId: c.id,
        holeNumber: i + 1,
        par: p,
      })),
    );
  }
  return c.id;
}

async function seedTournament(opts: {
  cutLine?: number | null;
  cutAfterRound?: number | null;
  cutPosition?: string | null;
  rounds?: number;
  courseId?: number | null;
}): Promise<{ orgId: number; tournamentId: number }> {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `CutHandlerOrg_${ts}`,
    slug: `cut-handler-${ts}`,
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: org.id,
    name: `CutHandler_${ts}`,
    status: "active",
    rounds: opts.rounds ?? 1,
    cutLine: opts.cutLine ?? null,
    cutAfterRound: opts.cutAfterRound ?? null,
    cutPosition: opts.cutPosition ?? null,
    startDate: new Date(),
    courseId: opts.courseId ?? null,
  }).returning({ id: tournamentsTable.id });
  createdTournamentIds.push(t.id);

  return { orgId: org.id, tournamentId: t.id };
}

/**
 * Pin a specific course to a specific round of a tournament via the
 * `tournament_rounds` mapping table. Used by multi-course tests.
 */
async function setRoundCourse(
  tournamentId: number,
  roundNumber: number,
  courseId: number,
): Promise<void> {
  await db.insert(tournamentRoundsTable).values({
    tournamentId,
    roundNumber,
    courseId,
  });
}

async function seedPlayer(
  tournamentId: number,
  firstName: string,
  extra: { dns?: boolean; cutAt?: Date | null } = {},
): Promise<number> {
  const [p] = await db.insert(playersTable).values({
    tournamentId,
    firstName,
    lastName: "Player",
    dns: extra.dns ?? false,
    cutAt: extra.cutAt ?? null,
  }).returning({ id: playersTable.id });
  createdPlayerIds.push(p.id);
  return p.id;
}

/**
 * Insert 18 holes of a single round. With perHoleStrokes=4 the round
 * total is 72 (even par when the underlying course is par 72).
 */
async function seedRound(
  tournamentId: number,
  playerId: number,
  round: number,
  perHoleStrokes: number,
): Promise<void> {
  const rows = Array.from({ length: 18 }, (_, i) => ({
    tournamentId,
    playerId,
    round,
    holeNumber: i + 1,
    strokes: perHoleStrokes,
  }));
  await db.insert(scoresTable).values(rows);
}

async function getCutAt(playerId: number): Promise<Date | null> {
  const [row] = await db.select({ cutAt: playersTable.cutAt })
    .from(playersTable)
    .where(eq(playersTable.id, playerId))
    .limit(1);
  return row?.cutAt ?? null;
}

afterAll(async () => {
  if (createdPlayerIds.length > 0) {
    await db.delete(playersTable).where(inArray(playersTable.id, createdPlayerIds));
  }
  if (createdTournamentIds.length > 0) {
    await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, createdTournamentIds));
  }
  if (createdCourseIds.length > 0) {
    // hole_details + tournament_rounds cascade from courses/tournaments.
    await db.delete(coursesTable).where(inArray(coursesTable.id, createdCourseIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("applyCut — segregating players by the configured cut line", () => {
  it("cuts only players whose total strokes are strictly above the cut line, and leaves survivors' cut_at NULL", async () => {
    // cutLine = 10 over par, throughRound = 1, course par = 72 →
    // cutLineStrokes = 72 + 10 = 82. We seed a real par-72 course
    // (with full per-hole details summing to 72) so this test exercises
    // the actual course-par lookup path, not the no-course fallback.
    const { orgId, tournamentId } = await seedTournament({
      cutLine: 10, cutAfterRound: 1, rounds: 2,
    });
    const courseId = await seedCourse(orgId, {
      par: 72,
      holeParPattern: Array(18).fill(4),
    });
    await db.update(tournamentsTable).set({ courseId })
      .where(eq(tournamentsTable.id, tournamentId));
    const aliceId = await seedPlayer(tournamentId, "Alice"); // 72 — well inside
    const bobId = await seedPlayer(tournamentId, "Bob");     // 81 — inside (par 4 + one bogey × 9 = 81)
    const carolId = await seedPlayer(tournamentId, "Carol"); // 90 — outside (all bogeys)
    const daveId = await seedPlayer(tournamentId, "Dave");   // 108 — outside (all double bogeys)

    await seedRound(tournamentId, aliceId, 1, 4);
    // Bob: 9 holes par + 9 holes bogey → 9*4 + 9*5 = 81
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: bobId, round: 1, holeNumber: i + 1,
        strokes: i < 9 ? 4 : 5,
      })),
    );
    await seedRound(tournamentId, carolId, 1, 5);
    await seedRound(tournamentId, daveId, 1, 6);

    const result = await applyCut(tournamentId, 1);

    expect(result.applied).toBe(true);
    expect(result.cutLineStrokes).toBe(82);
    expect(result.survivors.map(s => s.playerId).sort((a, b) => a - b))
      .toEqual([aliceId, bobId].sort((a, b) => a - b));
    expect(result.cut.map(c => c.playerId).sort((a, b) => a - b))
      .toEqual([carolId, daveId].sort((a, b) => a - b));
    expect(result.persistedCount).toBe(4);

    // Verify the persisted cut_at column matches the in-memory split.
    expect(await getCutAt(aliceId)).toBeNull();
    expect(await getCutAt(bobId)).toBeNull();
    expect(await getCutAt(carolId)).toBeInstanceOf(Date);
    expect(await getCutAt(daveId)).toBeInstanceOf(Date);
  });

  it("treats players who tie the cut line exactly as survivors (boundary uses '<=')", async () => {
    // cutLine = 10, cutLineStrokes = 82. Tied player shoots exactly 82.
    const { tournamentId } = await seedTournament({
      cutLine: 10, cutAfterRound: 1, rounds: 1,
    });
    // 8 par + 10 bogey = 8*4 + 10*5 = 82
    const tiedId = await seedPlayer(tournamentId, "Tied");
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: tiedId, round: 1, holeNumber: i + 1,
        strokes: i < 8 ? 4 : 5,
      })),
    );
    // Sanity-check loser at 83 to make sure the boundary really is the cut.
    const overId = await seedPlayer(tournamentId, "Over");
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: overId, round: 1, holeNumber: i + 1,
        strokes: i < 7 ? 4 : 5, // 7*4 + 11*5 = 83
      })),
    );

    const result = await applyCut(tournamentId, 1);

    expect(result.cutLineStrokes).toBe(82);
    expect(result.survivors.map(s => s.playerId)).toContain(tiedId);
    expect(result.cut.map(c => c.playerId)).toContain(overId);
    expect(await getCutAt(tiedId)).toBeNull();
    expect(await getCutAt(overId)).toBeInstanceOf(Date);
  });
});

describe("applyCut — un-cut / reset flow", () => {
  it("clears cut_at for a previously-cut player whose corrected score now passes the line", async () => {
    const { tournamentId } = await seedTournament({
      cutLine: 10, cutAfterRound: 1, rounds: 1,
    });
    // Carol starts way over the line.
    const carolId = await seedPlayer(tournamentId, "Carol");
    await seedRound(tournamentId, carolId, 1, 5); // 90 strokes → cut.
    // Anchor a survivor so the survivors-update branch also fires.
    const aliceId = await seedPlayer(tournamentId, "Alice");
    await seedRound(tournamentId, aliceId, 1, 4); // 72 → survivor.

    const first = await applyCut(tournamentId, 1);
    expect(first.cut.map(c => c.playerId)).toEqual([carolId]);
    expect(await getCutAt(carolId)).toBeInstanceOf(Date);
    expect(await getCutAt(aliceId)).toBeNull();

    // Score correction: drop Carol's bogeys to pars → new total = 72.
    await db.update(scoresTable)
      .set({ strokes: 4 })
      .where(and(eq(scoresTable.tournamentId, tournamentId), eq(scoresTable.playerId, carolId)));

    const second = await applyCut(tournamentId, 1);
    expect(second.cut).toEqual([]);
    expect(second.survivors.map(s => s.playerId).sort((a, b) => a - b))
      .toEqual([aliceId, carolId].sort((a, b) => a - b));
    // Carol's cut_at must be lifted by the rerun.
    expect(await getCutAt(carolId)).toBeNull();
    expect(await getCutAt(aliceId)).toBeNull();
  });

  it("does not touch players from other tournaments, even with the same player names", async () => {
    const { tournamentId: tourA } = await seedTournament({
      cutLine: 10, cutAfterRound: 1, rounds: 1,
    });
    const { tournamentId: tourB } = await seedTournament({
      cutLine: 10, cutAfterRound: 1, rounds: 1,
    });

    // Both tournaments have a Carol who shoots 90 (would be cut).
    const carolAId = await seedPlayer(tourA, "Carol");
    const carolBId = await seedPlayer(tourB, "Carol");
    await seedRound(tourA, carolAId, 1, 5);
    await seedRound(tourB, carolBId, 1, 5);

    // Pre-set carolB.cutAt to a known sentinel so we can prove it survives.
    const sentinel = new Date("2020-01-01T00:00:00Z");
    await db.update(playersTable).set({ cutAt: sentinel })
      .where(eq(playersTable.id, carolBId));

    await applyCut(tourA, 1);

    expect(await getCutAt(carolAId)).toBeInstanceOf(Date);
    const carolBAfter = await getCutAt(carolBId);
    expect(carolBAfter).toBeInstanceOf(Date);
    expect(carolBAfter!.toISOString()).toBe(sentinel.toISOString());
  });
});

describe("applyCut — edge cases (DNS, missing scores, no cut configured)", () => {
  it("ignores DNS players who have no scores: their cut_at is left untouched", async () => {
    const { tournamentId } = await seedTournament({
      cutLine: 10, cutAfterRound: 1, rounds: 1,
    });
    const aliceId = await seedPlayer(tournamentId, "Alice");
    await seedRound(tournamentId, aliceId, 1, 4); // 72 → survivor

    // DNS player with no scores. Pre-set cutAt to a sentinel so we can
    // verify the run does not flip it to NULL (a survivors-update bug)
    // nor stamp a fresh now() (a cut-update bug).
    const sentinel = new Date("2020-01-01T00:00:00Z");
    const dnsId = await seedPlayer(tournamentId, "DNS", { dns: true, cutAt: sentinel });

    const result = await applyCut(tournamentId, 1);

    expect(result.survivors.map(s => s.playerId)).toEqual([aliceId]);
    expect(result.cut).toEqual([]);
    // DNS player wasn't in the SUM/GROUP BY → should not be touched at all.
    const dnsAfter = await getCutAt(dnsId);
    expect(dnsAfter).toBeInstanceOf(Date);
    expect(dnsAfter!.toISOString()).toBe(sentinel.toISOString());
  });

  it("ignores players with no scores in the through-round window: their cut_at stays as-is", async () => {
    // 2-round tournament, cut after round 2. Player 'Latecomer' joined
    // mid-tournament and has zero scores yet — they must not be cut nor
    // un-cut by the routine.
    const { tournamentId } = await seedTournament({
      cutLine: 10, cutAfterRound: 2, rounds: 2,
    });
    const aliceId = await seedPlayer(tournamentId, "Alice");
    // Two rounds at par → 144 strokes total. cutLineStrokes = 144 + 10 = 154.
    await seedRound(tournamentId, aliceId, 1, 4);
    await seedRound(tournamentId, aliceId, 2, 4);

    const latecomerId = await seedPlayer(tournamentId, "Latecomer");
    // No scores at all.

    const result = await applyCut(tournamentId, 2);

    expect(result.cutLineStrokes).toBe(72 * 2 + 10);
    expect(result.survivors.map(s => s.playerId)).toEqual([aliceId]);
    expect(result.cut).toEqual([]);
    // Latecomer wasn't in totals → not touched. Default cut_at remains NULL.
    expect(await getCutAt(latecomerId)).toBeNull();
  });

  it("returns applied=false and writes nothing when the tournament has no cut line", async () => {
    const { tournamentId } = await seedTournament({
      cutLine: null, cutAfterRound: null, rounds: 1,
    });
    const aliceId = await seedPlayer(tournamentId, "Alice");
    await seedRound(tournamentId, aliceId, 1, 6); // 108 — would be way over

    // Pre-stamp cut_at so we can prove no_cut_line short-circuit doesn't
    // accidentally clear it.
    const sentinel = new Date("2020-01-01T00:00:00Z");
    await db.update(playersTable).set({ cutAt: sentinel })
      .where(eq(playersTable.id, aliceId));

    const result = await applyCut(tournamentId, 1);

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("no_cut_line");
    expect(result.survivors).toEqual([]);
    expect(result.cut).toEqual([]);

    const after = await getCutAt(aliceId);
    expect(after).toBeInstanceOf(Date);
    expect(after!.toISOString()).toBe(sentinel.toISOString());
  });

  it("returns applied=false when the tournament does not exist", async () => {
    const result = await applyCut(2_147_483_000, 1);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("tournament_not_found");
    expect(result.survivors).toEqual([]);
    expect(result.cut).toEqual([]);
  });
});

describe("applyCut — cutPosition (top-N) segregation", () => {
  it("cuts everyone outside top-N exactly when cutPosition='topN' (no ties bracket)", async () => {
    // top2: only the two best players survive; ties at the boundary are
    // broken by sort order, mirroring computeLeaderboard.
    const { tournamentId } = await seedTournament({
      cutLine: null, cutAfterRound: 1, cutPosition: "top2", rounds: 1,
    });
    const aliceId = await seedPlayer(tournamentId, "Alice"); // 72 — rank 1
    const bobId = await seedPlayer(tournamentId, "Bob");     // 81 — rank 2
    const carolId = await seedPlayer(tournamentId, "Carol"); // 90 — rank 3
    const daveId = await seedPlayer(tournamentId, "Dave");   // 108 — rank 4

    await seedRound(tournamentId, aliceId, 1, 4);
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: bobId, round: 1, holeNumber: i + 1,
        strokes: i < 9 ? 4 : 5, // 81
      })),
    );
    await seedRound(tournamentId, carolId, 1, 5);
    await seedRound(tournamentId, daveId, 1, 6);

    const result = await applyCut(tournamentId, 1);

    expect(result.applied).toBe(true);
    expect(result.mode).toBe("position");
    expect(result.cutPositionSize).toBe(2);
    expect(result.cutLineStrokes).toBeUndefined();
    expect(result.survivors.map(s => s.playerId)).toEqual([aliceId, bobId]);
    expect(result.cut.map(c => c.playerId).sort((a, b) => a - b))
      .toEqual([carolId, daveId].sort((a, b) => a - b));

    expect(await getCutAt(aliceId)).toBeNull();
    expect(await getCutAt(bobId)).toBeNull();
    expect(await getCutAt(carolId)).toBeInstanceOf(Date);
    expect(await getCutAt(daveId)).toBeInstanceOf(Date);
  });

  it("includes ties at the cut boundary when cutPosition='topN_ties'", async () => {
    // top2_ties: the player tied with Bob at the boundary survives too.
    const { tournamentId } = await seedTournament({
      cutLine: null, cutAfterRound: 1, cutPosition: "top2_ties", rounds: 1,
    });
    const aliceId = await seedPlayer(tournamentId, "Alice");   // 72 — leader
    const bobId = await seedPlayer(tournamentId, "Bob");       // 81 — rank 2
    const charlieId = await seedPlayer(tournamentId, "Charlie"); // 81 — tied with Bob
    const daveId = await seedPlayer(tournamentId, "Dave");     // 90 — outside

    await seedRound(tournamentId, aliceId, 1, 4);
    const eightyOne = (pid: number) =>
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: pid, round: 1, holeNumber: i + 1,
        strokes: i < 9 ? 4 : 5, // 9*4 + 9*5 = 81
      }));
    await db.insert(scoresTable).values(eightyOne(bobId));
    await db.insert(scoresTable).values(eightyOne(charlieId));
    await seedRound(tournamentId, daveId, 1, 5);

    const result = await applyCut(tournamentId, 1);

    expect(result.applied).toBe(true);
    expect(result.mode).toBe("position");
    expect(result.cutPositionSize).toBe(2);
    expect(result.cutThresholdStrokes).toBe(81);
    expect(result.survivors.map(s => s.playerId).sort((a, b) => a - b))
      .toEqual([aliceId, bobId, charlieId].sort((a, b) => a - b));
    expect(result.cut.map(c => c.playerId)).toEqual([daveId]);

    expect(await getCutAt(aliceId)).toBeNull();
    expect(await getCutAt(bobId)).toBeNull();
    expect(await getCutAt(charlieId)).toBeNull();
    expect(await getCutAt(daveId)).toBeInstanceOf(Date);
  });

  it("clears cut_at on a previously-cut player who climbs into the top-N after a score correction", async () => {
    const { tournamentId } = await seedTournament({
      cutLine: null, cutAfterRound: 1, cutPosition: "top2", rounds: 1,
    });
    const aliceId = await seedPlayer(tournamentId, "Alice");   // 72
    const bobId = await seedPlayer(tournamentId, "Bob");       // 90 — initially cut
    const carolId = await seedPlayer(tournamentId, "Carol");   // 81 — initially survives
    await seedRound(tournamentId, aliceId, 1, 4);
    await seedRound(tournamentId, bobId, 1, 5); // 90
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: carolId, round: 1, holeNumber: i + 1,
        strokes: i < 9 ? 4 : 5, // 81
      })),
    );

    const first = await applyCut(tournamentId, 1);
    expect(first.survivors.map(s => s.playerId)).toEqual([aliceId, carolId]);
    expect(first.cut.map(c => c.playerId)).toEqual([bobId]);
    expect(await getCutAt(bobId)).toBeInstanceOf(Date);
    expect(await getCutAt(carolId)).toBeNull();

    // Score correction: Bob's bogeys become pars → 72, climbs to top.
    await db.update(scoresTable)
      .set({ strokes: 4 })
      .where(and(eq(scoresTable.tournamentId, tournamentId), eq(scoresTable.playerId, bobId)));

    const second = await applyCut(tournamentId, 1);
    expect(second.survivors.map(s => s.playerId).sort((a, b) => a - b))
      .toEqual([aliceId, bobId].sort((a, b) => a - b));
    expect(second.cut.map(c => c.playerId)).toEqual([carolId]);
    // Bob's cut_at must now be cleared; Carol's must now be set.
    expect(await getCutAt(aliceId)).toBeNull();
    expect(await getCutAt(bobId)).toBeNull();
    expect(await getCutAt(carolId)).toBeInstanceOf(Date);
  });

  it("survives everyone when fewer players than the top-N have scores (top-N_ties degenerate case)", async () => {
    const { tournamentId } = await seedTournament({
      cutLine: null, cutAfterRound: 1, cutPosition: "top10_ties", rounds: 1,
    });
    const aliceId = await seedPlayer(tournamentId, "Alice");
    const bobId = await seedPlayer(tournamentId, "Bob");
    await seedRound(tournamentId, aliceId, 1, 4); // 72
    await seedRound(tournamentId, bobId, 1, 5);   // 90

    const result = await applyCut(tournamentId, 1);

    expect(result.applied).toBe(true);
    expect(result.mode).toBe("position");
    expect(result.cut).toEqual([]);
    expect(result.survivors.map(s => s.playerId).sort((a, b) => a - b))
      .toEqual([aliceId, bobId].sort((a, b) => a - b));
    expect(await getCutAt(aliceId)).toBeNull();
    expect(await getCutAt(bobId)).toBeNull();
  });

  it("lets cutPosition take precedence when both cutLine and cutPosition are set", async () => {
    // cutLine=10 → would let Bob (81) and Alice (72) survive. But
    // cutPosition='top1' restricts that to just Alice.
    const { tournamentId } = await seedTournament({
      cutLine: 10, cutAfterRound: 1, cutPosition: "top1", rounds: 1,
    });
    const aliceId = await seedPlayer(tournamentId, "Alice");
    const bobId = await seedPlayer(tournamentId, "Bob");
    const carolId = await seedPlayer(tournamentId, "Carol");
    await seedRound(tournamentId, aliceId, 1, 4); // 72
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: bobId, round: 1, holeNumber: i + 1,
        strokes: i < 9 ? 4 : 5, // 81 — inside the line, but rank 2
      })),
    );
    await seedRound(tournamentId, carolId, 1, 5); // 90 — outside both

    const result = await applyCut(tournamentId, 1);

    expect(result.applied).toBe(true);
    expect(result.mode).toBe("position");
    expect(result.cutPositionSize).toBe(1);
    expect(result.cutLineStrokes).toBeUndefined();
    expect(result.survivors.map(s => s.playerId)).toEqual([aliceId]);
    expect(result.cut.map(c => c.playerId).sort((a, b) => a - b))
      .toEqual([bobId, carolId].sort((a, b) => a - b));

    expect(await getCutAt(aliceId)).toBeNull();
    expect(await getCutAt(bobId)).toBeInstanceOf(Date);
    expect(await getCutAt(carolId)).toBeInstanceOf(Date);
  });

  it("breaks ties at the top-N boundary deterministically by playerId, not by SQL row order", async () => {
    // Three players all tied at 81. cutPosition='top2' (no ties bracket) →
    // exactly 2 survive. The pair must be deterministic across runs: the
    // two with the SMALLEST player ids, since the secondary sort key is
    // playerId asc.
    const { tournamentId } = await seedTournament({
      cutLine: null, cutAfterRound: 1, cutPosition: "top2", rounds: 1,
    });
    const p1 = await seedPlayer(tournamentId, "P1");
    const p2 = await seedPlayer(tournamentId, "P2");
    const p3 = await seedPlayer(tournamentId, "P3");
    const eightyOne = (pid: number) =>
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: pid, round: 1, holeNumber: i + 1,
        strokes: i < 9 ? 4 : 5,
      }));
    await db.insert(scoresTable).values(eightyOne(p1));
    await db.insert(scoresTable).values(eightyOne(p2));
    await db.insert(scoresTable).values(eightyOne(p3));

    const result = await applyCut(tournamentId, 1);

    expect(result.applied).toBe(true);
    expect(result.mode).toBe("position");
    // Smallest two ids survive; largest is cut.
    expect(result.survivors.map(s => s.playerId)).toEqual([p1, p2]);
    expect(result.cut.map(c => c.playerId)).toEqual([p3]);
    expect(await getCutAt(p1)).toBeNull();
    expect(await getCutAt(p2)).toBeNull();
    expect(await getCutAt(p3)).toBeInstanceOf(Date);

    // Re-run: result must be byte-stable.
    const second = await applyCut(tournamentId, 1);
    expect(second.survivors.map(s => s.playerId)).toEqual([p1, p2]);
    expect(second.cut.map(c => c.playerId)).toEqual([p3]);
  });

  it("rejects malformed-but-parseable cutPosition values like 'top0_ties'", async () => {
    const { tournamentId } = await seedTournament({
      cutLine: null, cutAfterRound: 1, cutPosition: "top0_ties", rounds: 1,
    });
    const aliceId = await seedPlayer(tournamentId, "Alice");
    await seedRound(tournamentId, aliceId, 1, 4);

    const result = await applyCut(tournamentId, 1);

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("invalid_cut_position");
    expect(result.survivors).toEqual([]);
    expect(result.cut).toEqual([]);
    // Alice's cut_at default (NULL) must be preserved.
    expect(await getCutAt(aliceId)).toBeNull();
  });

  it("rejects unparseable cutPosition values without writing anything", async () => {
    const { tournamentId } = await seedTournament({
      cutLine: null, cutAfterRound: 1, cutPosition: "bogus", rounds: 1,
    });
    const aliceId = await seedPlayer(tournamentId, "Alice");
    await seedRound(tournamentId, aliceId, 1, 6); // 108

    const sentinel = new Date("2020-01-01T00:00:00Z");
    await db.update(playersTable).set({ cutAt: sentinel })
      .where(eq(playersTable.id, aliceId));

    const result = await applyCut(tournamentId, 1);

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("invalid_cut_position");
    expect(result.survivors).toEqual([]);
    expect(result.cut).toEqual([]);
    const after = await getCutAt(aliceId);
    expect(after).toBeInstanceOf(Date);
    expect(after!.toISOString()).toBe(sentinel.toISOString());
  });
});

describe("applyCut — verifies the persistence side-effect on the players table", () => {
  it("matches the (cut_at IS NOT NULL) row count to result.cut and (cut_at IS NULL) to result.survivors", async () => {
    const { tournamentId } = await seedTournament({
      cutLine: 5, cutAfterRound: 1, rounds: 1,
    });
    // cutLineStrokes = 77.
    const winners = [
      await seedPlayer(tournamentId, "W1"),
      await seedPlayer(tournamentId, "W2"),
    ];
    const losers = [
      await seedPlayer(tournamentId, "L1"),
      await seedPlayer(tournamentId, "L2"),
      await seedPlayer(tournamentId, "L3"),
    ];
    for (const id of winners) await seedRound(tournamentId, id, 1, 4); // 72 each
    for (const id of losers)  await seedRound(tournamentId, id, 1, 5); // 90 each

    const result = await applyCut(tournamentId, 1);

    expect(result.survivors.map(s => s.playerId).sort((a, b) => a - b))
      .toEqual([...winners].sort((a, b) => a - b));
    expect(result.cut.map(c => c.playerId).sort((a, b) => a - b))
      .toEqual([...losers].sort((a, b) => a - b));

    // Re-query the DB and assert the persisted shape matches.
    const persistedCut = await db.select({ id: playersTable.id })
      .from(playersTable)
      .where(and(
        eq(playersTable.tournamentId, tournamentId),
        isNotNull(playersTable.cutAt),
      ));
    const persistedSurvivors = await db.select({ id: playersTable.id })
      .from(playersTable)
      .where(and(
        eq(playersTable.tournamentId, tournamentId),
        isNull(playersTable.cutAt),
      ));

    expect(persistedCut.map(r => r.id).sort((a, b) => a - b))
      .toEqual([...losers].sort((a, b) => a - b));
    expect(persistedSurvivors.map(r => r.id).sort((a, b) => a - b))
      .toEqual([...winners].sort((a, b) => a - b));
  });
});

describe("applyCut — uses the actual course par for cutLine math (Task #1599)", () => {
  it("uses courses.par when no per-hole details are seeded (par-70 course)", async () => {
    // par 70 course, cutLine = +5 → cutLineStrokes = 75.
    // Alice shoots 75 (tied with cut line) → survives.
    // Bob shoots 76 → cut.
    const { orgId, tournamentId } = await seedTournament({
      cutLine: 5, cutAfterRound: 1, rounds: 1,
    });
    const courseId = await seedCourse(orgId, { par: 70 });
    await db.update(tournamentsTable).set({ courseId })
      .where(eq(tournamentsTable.id, tournamentId));

    const aliceId = await seedPlayer(tournamentId, "Alice");
    const bobId = await seedPlayer(tournamentId, "Bob");
    // Alice: 15*4 + 3*5 = 60 + 15 = 75
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: aliceId, round: 1, holeNumber: i + 1,
        strokes: i < 15 ? 4 : 5,
      })),
    );
    // Bob: 14*4 + 4*5 = 56 + 20 = 76
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: bobId, round: 1, holeNumber: i + 1,
        strokes: i < 14 ? 4 : 5,
      })),
    );

    const result = await applyCut(tournamentId, 1);

    expect(result.applied).toBe(true);
    expect(result.cutLineStrokes).toBe(75);
    expect(result.survivors.map(s => s.playerId)).toEqual([aliceId]);
    expect(result.cut.map(c => c.playerId)).toEqual([bobId]);
    expect(await getCutAt(aliceId)).toBeNull();
    expect(await getCutAt(bobId)).toBeInstanceOf(Date);
  });

  it("uses the sum of hole_details.par when every hole has a row (par-71 course)", async () => {
    // 17 par-4 holes + 1 par-3 hole = 71. courses.par left at the
    // default 72 to prove hole_details wins when seeded fully.
    // cutLine = +3 → cutLineStrokes = 71 + 3 = 74. NOT 75.
    const { orgId, tournamentId } = await seedTournament({
      cutLine: 3, cutAfterRound: 1, rounds: 1,
    });
    const pattern = Array(18).fill(4) as number[];
    pattern[0] = 3; // one par-3 → sums to 71
    const courseId = await seedCourse(orgId, {
      par: 72, // intentionally inconsistent: hole_details takes precedence
      holeParPattern: pattern,
    });
    await db.update(tournamentsTable).set({ courseId })
      .where(eq(tournamentsTable.id, tournamentId));

    const aliceId = await seedPlayer(tournamentId, "Alice"); // 74
    const bobId = await seedPlayer(tournamentId, "Bob");     // 75

    // Alice = 74 strokes: hole 1 (par-3) = 4 (+1), holes 2-3 = 5 each
    // (+1 each), holes 4-18 = 4 each. 4 + 5*2 + 15*4 = 74. Ties the
    // line under the hole_details sum, so survives.
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => {
        if (i === 0) return { tournamentId, playerId: aliceId, round: 1, holeNumber: 1, strokes: 4 };
        if (i === 1) return { tournamentId, playerId: aliceId, round: 1, holeNumber: 2, strokes: 5 };
        if (i === 2) return { tournamentId, playerId: aliceId, round: 1, holeNumber: 3, strokes: 5 };
        return { tournamentId, playerId: aliceId, round: 1, holeNumber: i + 1, strokes: 4 };
      }),
    );
    // Bob = 75 strokes: hole 1 = 4, holes 2-4 = 5 each, rest pars.
    // 4 + 5*3 + 14*4 = 75. One stroke over the hole_details cut, so cut.
    // (Critically: with the legacy 72 default this would be inside +3.)
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => {
        if (i === 0) return { tournamentId, playerId: bobId, round: 1, holeNumber: 1, strokes: 4 };
        if (i === 1) return { tournamentId, playerId: bobId, round: 1, holeNumber: 2, strokes: 5 };
        if (i === 2) return { tournamentId, playerId: bobId, round: 1, holeNumber: 3, strokes: 5 };
        if (i === 3) return { tournamentId, playerId: bobId, round: 1, holeNumber: 4, strokes: 5 };
        return { tournamentId, playerId: bobId, round: 1, holeNumber: i + 1, strokes: 4 };
      }),
    );

    const result = await applyCut(tournamentId, 1);

    expect(result.applied).toBe(true);
    // Critical assertion: hole_details sum (71) wins over courses.par (72).
    expect(result.cutLineStrokes).toBe(74);
    expect(result.survivors.map(s => s.playerId)).toEqual([aliceId]);
    expect(result.cut.map(c => c.playerId)).toEqual([bobId]);
  });

  it("falls back to courses.par when hole_details are partially seeded", async () => {
    // 18-hole course with only 9 hole_details rows (partial seed). The
    // helper must NOT use the partial sum — it must fall back to
    // courses.par (= 70). cutLine = +5 → cutLineStrokes = 75.
    const { orgId, tournamentId } = await seedTournament({
      cutLine: 5, cutAfterRound: 1, rounds: 1,
    });
    const [course] = await db.insert(coursesTable).values({
      organizationId: orgId,
      name: `PartialCourse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      slug: `partial-course-${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      par: 70,
      holes: 18,
    }).returning({ id: coursesTable.id });
    createdCourseIds.push(course.id);
    // Seed only the first 9 holes — sum would be 36, well off the real
    // course par. Helper should ignore this and use courses.par (70).
    await db.insert(holeDetailsTable).values(
      Array.from({ length: 9 }, (_, i) => ({
        courseId: course.id, holeNumber: i + 1, par: 4,
      })),
    );
    await db.update(tournamentsTable).set({ courseId: course.id })
      .where(eq(tournamentsTable.id, tournamentId));

    const aliceId = await seedPlayer(tournamentId, "Alice"); // 75 strokes
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: aliceId, round: 1, holeNumber: i + 1,
        strokes: i < 15 ? 4 : 5, // 60 + 15 = 75
      })),
    );
    const bobId = await seedPlayer(tournamentId, "Bob"); // 76 strokes
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: bobId, round: 1, holeNumber: i + 1,
        strokes: i < 14 ? 4 : 5, // 56 + 20 = 76
      })),
    );

    const result = await applyCut(tournamentId, 1);

    expect(result.applied).toBe(true);
    // 70 (from courses.par) + 5 = 75. NOT 36 + 5 = 41 (partial sum trap).
    expect(result.cutLineStrokes).toBe(75);
    expect(result.survivors.map(s => s.playerId)).toEqual([aliceId]);
    expect(result.cut.map(c => c.playerId)).toEqual([bobId]);
  });

  it("sums per-round par from tournament_rounds for multi-course championships", async () => {
    // Round 1 on a par-70 course, Round 2 on a par-72 course.
    // throughRound=2, cutLine=+5 → cutLineStrokes = 70 + 72 + 5 = 147.
    const { orgId, tournamentId } = await seedTournament({
      cutLine: 5, cutAfterRound: 2, rounds: 2,
    });
    const course70 = await seedCourse(orgId, { par: 70 });
    const course72 = await seedCourse(orgId, { par: 72 });
    // No tournament-level course; per-round mapping fully drives par.
    await setRoundCourse(tournamentId, 1, course70);
    await setRoundCourse(tournamentId, 2, course72);

    const aliceId = await seedPlayer(tournamentId, "Alice"); // 70 + 72 = 142 → survivor
    const bobId = await seedPlayer(tournamentId, "Bob");     // 75 + 73 = 148 → cut

    // Alice round 1: 16*4 + 2*3 = 70  (mix to make exactly 70)
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: aliceId, round: 1, holeNumber: i + 1,
        strokes: i < 16 ? 4 : 3, // 64 + 6 = 70
      })),
    );
    // Alice round 2: 18*4 = 72
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: aliceId, round: 2, holeNumber: i + 1,
        strokes: 4,
      })),
    );
    // Bob round 1: 17*4 + 1*7 = 75
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: bobId, round: 1, holeNumber: i + 1,
        strokes: i < 17 ? 4 : 7,
      })),
    );
    // Bob round 2: 17*4 + 1*5 = 73
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: bobId, round: 2, holeNumber: i + 1,
        strokes: i < 17 ? 4 : 5,
      })),
    );

    const result = await applyCut(tournamentId, 2);

    expect(result.applied).toBe(true);
    expect(result.cutLineStrokes).toBe(147); // 70 + 72 + 5
    expect(result.survivors.map(s => s.playerId)).toEqual([aliceId]);
    expect(result.cut.map(c => c.playerId)).toEqual([bobId]);
  });

  it("falls back to tournament.courseId for rounds with no tournament_rounds entry", async () => {
    // Tournament-level course is par 70. Round 2 has an explicit
    // override to a par-72 course. Round 1 has no per-round entry → it
    // must fall back to the tournament-level par-70 course.
    // throughRound=2 → totalPar = 70 + 72 = 142, cutLine=+4 → 146.
    const { orgId, tournamentId } = await seedTournament({
      cutLine: 4, cutAfterRound: 2, rounds: 2,
    });
    const defaultCourse70 = await seedCourse(orgId, { par: 70 });
    const overrideCourse72 = await seedCourse(orgId, { par: 72 });
    await db.update(tournamentsTable).set({ courseId: defaultCourse70 })
      .where(eq(tournamentsTable.id, tournamentId));
    // Only round 2 is explicitly mapped; round 1 inherits from the tournament.
    await setRoundCourse(tournamentId, 2, overrideCourse72);

    const aliceId = await seedPlayer(tournamentId, "Alice"); // 70 + 72 = 142 → survives
    const bobId = await seedPlayer(tournamentId, "Bob");     // 73 + 74 = 147 → cut

    // Alice round 1 = 70 (16*4 + 2*3)
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: aliceId, round: 1, holeNumber: i + 1,
        strokes: i < 16 ? 4 : 3,
      })),
    );
    // Alice round 2 = 72 (18*4)
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: aliceId, round: 2, holeNumber: i + 1,
        strokes: 4,
      })),
    );
    // Bob round 1 = 73 (17*4 + 1*5)
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: bobId, round: 1, holeNumber: i + 1,
        strokes: i < 17 ? 4 : 5,
      })),
    );
    // Bob round 2 = 74 (16*4 + 2*5)
    await db.insert(scoresTable).values(
      Array.from({ length: 18 }, (_, i) => ({
        tournamentId, playerId: bobId, round: 2, holeNumber: i + 1,
        strokes: i < 16 ? 4 : 5,
      })),
    );

    const result = await applyCut(tournamentId, 2);

    expect(result.applied).toBe(true);
    expect(result.cutLineStrokes).toBe(146); // 70 + 72 + 4
    expect(result.survivors.map(s => s.playerId)).toEqual([aliceId]);
    expect(result.cut.map(c => c.playerId)).toEqual([bobId]);
  });

  it("retains the legacy 72-per-round fallback when the tournament has no course attached", async () => {
    // No course on the tournament, no tournament_rounds entries. The
    // helper must fall back to the legacy 72-per-round default so the
    // existing single-course behaviour is preserved.
    const { tournamentId } = await seedTournament({
      cutLine: 10, cutAfterRound: 1, rounds: 1,
    });
    const aliceId = await seedPlayer(tournamentId, "Alice");
    await seedRound(tournamentId, aliceId, 1, 4); // 72 → survives
    const bobId = await seedPlayer(tournamentId, "Bob");
    await seedRound(tournamentId, bobId, 1, 5); // 90 → cut

    const result = await applyCut(tournamentId, 1);

    expect(result.applied).toBe(true);
    expect(result.cutLineStrokes).toBe(82); // 72 + 10
    expect(result.survivors.map(s => s.playerId)).toEqual([aliceId]);
    expect(result.cut.map(c => c.playerId)).toEqual([bobId]);
  });
});
