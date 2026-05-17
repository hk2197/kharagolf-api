/**
 * Integration tests for the persisted-cut override in `computeLeaderboard`
 * (Task #1004 / #1164).
 *
 * Once an admin runs `applyCut` on a player, `players.cutAt` is set and the
 * leaderboard MUST report `madeCut=false` for that player on every recompute,
 * regardless of:
 *
 *   1. The cutLine math saying the player is inside the line, OR
 *   2. The position-based cut (cutPosition) saying the player ranks within
 *      the made-cut bracket.
 *
 * Both code paths are exercised end-to-end against the real test DB so the
 * override at the bottom of the cut-resolution block stays trusted.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  db,
  organizationsTable,
  tournamentsTable,
  playersTable,
  scoresTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { computeLeaderboard } from "../realtime.js";

const createdOrgIds: number[] = [];
const createdTournamentIds: number[] = [];
const createdPlayerIds: number[] = [];

async function seedTournament(opts: {
  cutLine?: number | null;
  cutAfterRound?: number | null;
  cutPosition?: string | null;
  rounds?: number;
}): Promise<{ orgId: number; tournamentId: number }> {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `CutTrackingOrg_${ts}`,
    slug: `cut-tracking-${ts}`,
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: org.id,
    name: `CutTracking_${ts}`,
    status: "active",
    rounds: opts.rounds ?? 1,
    cutLine: opts.cutLine ?? null,
    cutAfterRound: opts.cutAfterRound ?? null,
    cutPosition: opts.cutPosition ?? null,
    startDate: new Date(),
  }).returning({ id: tournamentsTable.id });
  createdTournamentIds.push(t.id);

  return { orgId: org.id, tournamentId: t.id };
}

async function seedPlayer(tournamentId: number, firstName: string): Promise<number> {
  const [p] = await db.insert(playersTable).values({
    tournamentId,
    firstName,
    lastName: "Cut",
  }).returning({ id: playersTable.id });
  createdPlayerIds.push(p.id);
  return p.id;
}

/**
 * Insert 18 holes of round 1 scoring at the requested per-hole stroke count.
 * Default par is 4 per hole (no holeDetails seeded, so the leaderboard falls
 * back to par=4). Strokes=4 → scoreToPar=0; strokes=5 → scoreToPar=18.
 */
async function seedRound(
  tournamentId: number,
  playerId: number,
  perHoleStrokes: number,
): Promise<void> {
  const rows = Array.from({ length: 18 }, (_, i) => ({
    tournamentId,
    playerId,
    round: 1,
    holeNumber: i + 1,
    strokes: perHoleStrokes,
  }));
  await db.insert(scoresTable).values(rows);
}

afterAll(async () => {
  // FK ON DELETE CASCADE on players → tournaments → organizations wipes the
  // dependent rows when we drop each parent.
  if (createdPlayerIds.length > 0) {
    await db.delete(playersTable).where(inArray(playersTable.id, createdPlayerIds));
  }
  if (createdTournamentIds.length > 0) {
    await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, createdTournamentIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("computeLeaderboard — players.cutAt overrides cutLine math", () => {
  it("forces madeCut=false on a player whose recomputed cutLine math would put them inside the line", async () => {
    // cutLine = 10 over par; cutAfterRound = 1.
    const { tournamentId } = await seedTournament({
      cutLine: 10, cutAfterRound: 1, rounds: 1,
    });
    const aliceId = await seedPlayer(tournamentId, "Alice"); // shoots even
    const bobId = await seedPlayer(tournamentId, "Bob");     // shoots +18

    await seedRound(tournamentId, aliceId, 4); // 18 × par 4 → scoreToPar = 0
    await seedRound(tournamentId, bobId, 5);   // 18 × bogey → scoreToPar = 18

    // Baseline: Alice's math passes the cut, Bob's does not.
    const before = await computeLeaderboard(tournamentId);
    expect(before).not.toBeNull();
    const aliceBefore = before!.entries.find(e => e.playerId === aliceId)!;
    const bobBefore = before!.entries.find(e => e.playerId === bobId)!;
    expect(aliceBefore.scoreToPar).toBe(0);
    expect(aliceBefore.madeCut).toBe(true);
    expect(bobBefore.scoreToPar).toBe(18);
    expect(bobBefore.madeCut).toBe(false);

    // Mark Alice as cut via the persisted column (simulating cutHandler.applyCut).
    await db.update(playersTable)
      .set({ cutAt: new Date() })
      .where(eq(playersTable.id, aliceId));

    // Recompute: Alice's math still says she made the cut, but the persisted
    // cutAt must override and force madeCut=false.
    const after = await computeLeaderboard(tournamentId);
    expect(after).not.toBeNull();
    const aliceAfter = after!.entries.find(e => e.playerId === aliceId)!;
    expect(aliceAfter.scoreToPar).toBe(0); // recomputed math unchanged
    expect(aliceAfter.madeCut).toBe(false); // override wins
  });
});

describe("computeLeaderboard — players.cutAt overrides position-based cut", () => {
  it("forces madeCut=false even when the player would rank inside cutPosition (top1)", async () => {
    // cutPosition top1: only the leader makes the cut.
    const { tournamentId } = await seedTournament({
      cutLine: null, cutAfterRound: 1, cutPosition: "top1", rounds: 1,
    });
    const aliceId = await seedPlayer(tournamentId, "Alice"); // leads at even
    const bobId = await seedPlayer(tournamentId, "Bob");     // bogey-fest

    await seedRound(tournamentId, aliceId, 4); // scoreToPar = 0 → rank 1
    await seedRound(tournamentId, bobId, 5);   // scoreToPar = 18 → rank 2

    // Baseline: Alice ranks #1 → top1 says madeCut=true. Bob falls outside.
    const before = await computeLeaderboard(tournamentId);
    expect(before).not.toBeNull();
    const aliceBefore = before!.entries.find(e => e.playerId === aliceId)!;
    const bobBefore = before!.entries.find(e => e.playerId === bobId)!;
    expect(aliceBefore.madeCut).toBe(true);
    expect(bobBefore.madeCut).toBe(false);

    // Officially cut Alice — rare but possible (e.g. WD after the cut day).
    await db.update(playersTable)
      .set({ cutAt: new Date() })
      .where(eq(playersTable.id, aliceId));

    // Persisted cutAt must override the position-based cut block too.
    const after = await computeLeaderboard(tournamentId);
    expect(after).not.toBeNull();
    const aliceAfter = after!.entries.find(e => e.playerId === aliceId)!;
    expect(aliceAfter.madeCut).toBe(false);
  });
});
