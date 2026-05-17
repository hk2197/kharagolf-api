/**
 * Integration tests: Cross-club ladder standings recompute (Task #756).
 *
 * `recomputeStandings(ladderId)` is invoked after every ladder result
 * insert (manual endpoint, general-play hook, tournament hook). The auto-feed
 * tests (Task #600) cover the per-row insert; this file covers the
 * recompute logic itself:
 *
 *   1. best-of-N selection picks the highest-scoring N results per entry
 *      and flags the rest with countedTowardTotal = false.
 *   2. totalPoints, roundsCounted, position, and previousPosition are
 *      updated correctly across multiple entries in the same division.
 *   3. Divisions are scored independently — position numbering restarts
 *      at 1 inside each division.
 *   4. Ties on totalPoints produce a deterministic, consistent ordering
 *      (no two entries share a position; re-running yields identical
 *      assignments).
 *   5. When `bestOfRounds` is null the recompute counts every result.
 *
 * Results are inserted directly via Drizzle so the recompute logic can
 * be exercised with deterministic point values, independent of the
 * scoring formulas covered by the feed tests.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  crossClubLaddersTable,
  crossClubLadderEntriesTable,
  crossClubLadderResultsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { recomputeStandings } from "../lib/cross-club-ladder-standings.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

let orgId: number;
const createdUserIds: number[] = [];
const createdLadderIds: number[] = [];

async function makeUser(label: string): Promise<number> {
  const [row] = await db.insert(appUsersTable).values({
    replitUserId: `ladder-stand-${stamp}-${label}`,
    username: `ladder_stand_${stamp}_${label}`,
    email: `ladder_stand_${stamp}_${label}@example.com`,
    displayName: `Standings Tester ${label.toUpperCase()}`,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(row.id);
  return row.id;
}

async function makeLadder(opts: {
  label: string;
  bestOfRounds: number | null;
}): Promise<number> {
  const [ladder] = await db.insert(crossClubLaddersTable).values({
    name: `LadderStandings_${opts.label}_${stamp}`,
    format: "stableford",
    status: "active",
    scope: "national",
    seasonStart: new Date(Date.now() - 30 * 86_400_000),
    seasonEnd: new Date(Date.now() + 30 * 86_400_000),
    shareSlug: `ladder-stand-${opts.label}-${stamp}`,
    isPublic: true,
    bestOfRounds: opts.bestOfRounds,
  }).returning({ id: crossClubLaddersTable.id });
  createdLadderIds.push(ladder.id);
  return ladder.id;
}

async function makeEntry(opts: {
  ladderId: number;
  userId: number;
  label: string;
  division?: number;
  initialPosition?: number | null;
}): Promise<number> {
  const [row] = await db.insert(crossClubLadderEntriesTable).values({
    ladderId: opts.ladderId,
    userId: opts.userId,
    playerName: `Stand_${opts.label}`,
    division: opts.division ?? 1,
    position: opts.initialPosition ?? null,
  }).returning({ id: crossClubLadderEntriesTable.id });
  return row.id;
}

async function insertResult(opts: {
  ladderId: number;
  entryId: number;
  pointsAwarded: number;
  roundDate?: Date;
}): Promise<number> {
  const [row] = await db.insert(crossClubLadderResultsTable).values({
    ladderId: opts.ladderId,
    entryId: opts.entryId,
    roundDate: opts.roundDate ?? new Date(),
    pointsAwarded: opts.pointsAwarded,
    countedTowardTotal: true,
  }).returning({ id: crossClubLadderResultsTable.id });
  return row.id;
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `LadderStand_${stamp}`,
    slug: `ladder-stand-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
});

afterAll(async () => {
  for (const id of createdLadderIds) {
    await db.delete(crossClubLaddersTable).where(eq(crossClubLaddersTable.id, id));
  }
  for (const id of createdUserIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  if (orgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  }
});

describe("recomputeStandings: best-of-N selection", () => {
  it("counts only the top N pointsAwarded results per entry and flags the rest as not counted", async () => {
    const ladderId = await makeLadder({ label: "best-of-3", bestOfRounds: 3 });
    const userId = await makeUser("best-of-3");
    const entryId = await makeEntry({ ladderId, userId, label: "best-of-3" });

    // Five results: top 3 by points are 50, 40, 30; the bottom two
    // (20, 10) must be flagged countedTowardTotal=false.
    const r10 = await insertResult({ ladderId, entryId, pointsAwarded: 10 });
    const r50 = await insertResult({ ladderId, entryId, pointsAwarded: 50 });
    const r30 = await insertResult({ ladderId, entryId, pointsAwarded: 30 });
    const r20 = await insertResult({ ladderId, entryId, pointsAwarded: 20 });
    const r40 = await insertResult({ ladderId, entryId, pointsAwarded: 40 });

    await recomputeStandings(ladderId);

    const results = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    const byId = new Map(results.map(r => [r.id, r]));
    expect(byId.get(r50)!.countedTowardTotal).toBe(true);
    expect(byId.get(r40)!.countedTowardTotal).toBe(true);
    expect(byId.get(r30)!.countedTowardTotal).toBe(true);
    expect(byId.get(r20)!.countedTowardTotal).toBe(false);
    expect(byId.get(r10)!.countedTowardTotal).toBe(false);

    const [entry] = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.id, entryId));
    expect(entry.totalPoints).toBe(120); // 50+40+30
    expect(entry.roundsCounted).toBe(3);
  });

  it("counts every result when bestOfRounds is null", async () => {
    const ladderId = await makeLadder({ label: "best-of-null", bestOfRounds: null });
    const userId = await makeUser("best-of-null");
    const entryId = await makeEntry({ ladderId, userId, label: "best-of-null" });

    await insertResult({ ladderId, entryId, pointsAwarded: 11 });
    await insertResult({ ladderId, entryId, pointsAwarded: 22 });
    await insertResult({ ladderId, entryId, pointsAwarded: 33 });

    await recomputeStandings(ladderId);

    const results = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.ladderId, ladderId));
    expect(results.every(r => r.countedTowardTotal)).toBe(true);

    const [entry] = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.id, entryId));
    expect(entry.totalPoints).toBe(66);
    expect(entry.roundsCounted).toBe(3);
  });
});

describe("recomputeStandings: totals, position, and previousPosition", () => {
  it("orders entries within a division by totalPoints DESC and rolls previousPosition forward", async () => {
    const ladderId = await makeLadder({ label: "ordering", bestOfRounds: 2 });
    const userA = await makeUser("ordering-a");
    const userB = await makeUser("ordering-b");
    const userC = await makeUser("ordering-c");

    // Seed an existing position so we can verify previousPosition is
    // captured from the prior value, not invented.
    const entryA = await makeEntry({ ladderId, userId: userA, label: "A", initialPosition: 3 });
    const entryB = await makeEntry({ ladderId, userId: userB, label: "B", initialPosition: 1 });
    const entryC = await makeEntry({ ladderId, userId: userC, label: "C", initialPosition: 2 });

    // Best-of-2 totals: A=50+40=90, B=20+15=35, C=70+30=100
    await insertResult({ ladderId, entryId: entryA, pointsAwarded: 50 });
    await insertResult({ ladderId, entryId: entryA, pointsAwarded: 40 });
    await insertResult({ ladderId, entryId: entryA, pointsAwarded: 5 });

    await insertResult({ ladderId, entryId: entryB, pointsAwarded: 20 });
    await insertResult({ ladderId, entryId: entryB, pointsAwarded: 15 });

    await insertResult({ ladderId, entryId: entryC, pointsAwarded: 70 });
    await insertResult({ ladderId, entryId: entryC, pointsAwarded: 30 });
    await insertResult({ ladderId, entryId: entryC, pointsAwarded: 25 });

    await recomputeStandings(ladderId);

    const entries = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.ladderId, ladderId));
    const byId = new Map(entries.map(e => [e.id, e]));

    expect(byId.get(entryA)!.totalPoints).toBe(90);
    expect(byId.get(entryB)!.totalPoints).toBe(35);
    expect(byId.get(entryC)!.totalPoints).toBe(100);

    expect(byId.get(entryA)!.roundsCounted).toBe(2);
    expect(byId.get(entryB)!.roundsCounted).toBe(2);
    expect(byId.get(entryC)!.roundsCounted).toBe(2);

    // Position by totalPoints DESC: C (100) → 1, A (90) → 2, B (35) → 3.
    expect(byId.get(entryC)!.position).toBe(1);
    expect(byId.get(entryA)!.position).toBe(2);
    expect(byId.get(entryB)!.position).toBe(3);

    // previousPosition is the position BEFORE the recompute.
    expect(byId.get(entryA)!.previousPosition).toBe(3);
    expect(byId.get(entryB)!.previousPosition).toBe(1);
    expect(byId.get(entryC)!.previousPosition).toBe(2);

    // Re-run: previousPosition should now be the just-assigned position.
    await recomputeStandings(ladderId);
    const after = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.ladderId, ladderId));
    const byId2 = new Map(after.map(e => [e.id, e]));
    expect(byId2.get(entryC)!.previousPosition).toBe(1);
    expect(byId2.get(entryA)!.previousPosition).toBe(2);
    expect(byId2.get(entryB)!.previousPosition).toBe(3);
    // And ordering is unchanged.
    expect(byId2.get(entryC)!.position).toBe(1);
    expect(byId2.get(entryA)!.position).toBe(2);
    expect(byId2.get(entryB)!.position).toBe(3);
  });

  it("numbers positions independently within each division", async () => {
    const ladderId = await makeLadder({ label: "divisions", bestOfRounds: null });
    const userA = await makeUser("div-a");
    const userB = await makeUser("div-b");
    const userC = await makeUser("div-c");
    const userD = await makeUser("div-d");

    // Division 1: A (60) > B (40)  → positions 1, 2
    // Division 2: C (90) > D (10)  → positions 1, 2
    const entryA = await makeEntry({ ladderId, userId: userA, label: "A", division: 1 });
    const entryB = await makeEntry({ ladderId, userId: userB, label: "B", division: 1 });
    const entryC = await makeEntry({ ladderId, userId: userC, label: "C", division: 2 });
    const entryD = await makeEntry({ ladderId, userId: userD, label: "D", division: 2 });

    await insertResult({ ladderId, entryId: entryA, pointsAwarded: 60 });
    await insertResult({ ladderId, entryId: entryB, pointsAwarded: 40 });
    await insertResult({ ladderId, entryId: entryC, pointsAwarded: 90 });
    await insertResult({ ladderId, entryId: entryD, pointsAwarded: 10 });

    await recomputeStandings(ladderId);

    const entries = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.ladderId, ladderId));
    const byId = new Map(entries.map(e => [e.id, e]));

    expect(byId.get(entryA)!.position).toBe(1);
    expect(byId.get(entryB)!.position).toBe(2);
    expect(byId.get(entryC)!.position).toBe(1);
    expect(byId.get(entryD)!.position).toBe(2);
  });
});

describe("recomputeStandings: tie-breaking", () => {
  it("assigns distinct, consecutive positions when entries are tied on totalPoints, and is consistent across re-runs", async () => {
    const ladderId = await makeLadder({ label: "ties", bestOfRounds: null });
    const userA = await makeUser("tie-a");
    const userB = await makeUser("tie-b");
    const userC = await makeUser("tie-c");

    // A and B are tied at 50; C trails at 30.
    const entryA = await makeEntry({ ladderId, userId: userA, label: "A" });
    const entryB = await makeEntry({ ladderId, userId: userB, label: "B" });
    const entryC = await makeEntry({ ladderId, userId: userC, label: "C" });

    await insertResult({ ladderId, entryId: entryA, pointsAwarded: 50 });
    await insertResult({ ladderId, entryId: entryB, pointsAwarded: 50 });
    await insertResult({ ladderId, entryId: entryC, pointsAwarded: 30 });

    await recomputeStandings(ladderId);

    const entries1 = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.ladderId, ladderId));
    const byId1 = new Map(entries1.map(e => [e.id, e]));

    const posA1 = byId1.get(entryA)!.position!;
    const posB1 = byId1.get(entryB)!.position!;
    const posC1 = byId1.get(entryC)!.position!;

    // The trailing entry is always last; the two tied entries take the
    // top two slots — distinct positions, no duplicates.
    expect(posC1).toBe(3);
    expect(new Set([posA1, posB1])).toEqual(new Set([1, 2]));

    // Production rule: recomputeStandings sorts by totalPoints DESC with
    // JS's stable Array.sort, applied to entries fetched from Postgres
    // with no ORDER BY. In practice that means the earlier-inserted
    // entry wins the tie. A and B are inserted in that order, so A
    // must rank ahead of B. Encoding this guards the rule against a
    // silent change (e.g. someone adding a different secondary sort
    // key) — a regression here would still satisfy the looser
    // distinct-positions check above but would flip leaderboards in
    // production.
    expect(posA1).toBe(1);
    expect(posB1).toBe(2);

    // Re-running the recompute must produce the same assignment so
    // leaderboards don't flicker between requests.
    await recomputeStandings(ladderId);
    const entries2 = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.ladderId, ladderId));
    const byId2 = new Map(entries2.map(e => [e.id, e]));
    expect(byId2.get(entryA)!.position).toBe(posA1);
    expect(byId2.get(entryB)!.position).toBe(posB1);
    expect(byId2.get(entryC)!.position).toBe(posC1);
  });
});
