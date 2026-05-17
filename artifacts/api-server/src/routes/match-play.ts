import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import {
  tournamentsTable,
  playersTable,
  matchPlayBracketTable,
  bracketRoundsTable,
  bracketMatchesTable,
  ryderCupSessionsTable,
  ryderCupMatchesTable,
  ryderCupConfigTable,
} from "@workspace/db";
import { eq, and, asc, inArray } from "drizzle-orm";
import { requireTournamentAccess } from "../lib/permissions";
import { notifyLeaderboardUpdate, broadcastBracketUpdate, broadcastRyderCupUpdate } from "../lib/realtime";
import { logger } from "../lib/logger";
import { computeRrStandings, ROUND_ROBIN_TIE_BREAK_ROUND_NAME, type RrStandingsMatch } from "../lib/round-robin-standings";
import { wbLoserToLbMinorMatchNumber } from "../lib/double-elim-routing";
import { notifyRoundRobinTieBreak } from "../lib/roundRobinTieBreakNotify";

const router: IRouter = Router({ mergeParams: true });

// ─── Utility: compute match status string ────────────────────────────────────

type HoleOwner = "player1" | "player2" | "halved";

function computeMatchStatus(holeResults: Record<number, HoleOwner>, totalHoles = 18): string {
  let p1 = 0, p2 = 0;
  let holesPlayed = 0;
  for (let h = 1; h <= totalHoles; h++) {
    const r = holeResults[h];
    if (!r) continue;
    if (r === "player1") p1++;
    else if (r === "player2") p2++;
    holesPlayed++;
  }
  if (holesPlayed === 0) return "All Square";
  const remaining = totalHoles - holesPlayed;
  const diff = p1 - p2;
  if (diff === 0) return remaining === 0 ? "Halved" : "All Square";
  const leader = diff > 0 ? "Player 1" : "Player 2";
  const lead = Math.abs(diff);
  if (lead > remaining) return `${leader} wins ${lead}&${remaining}`;
  if (lead === remaining && remaining > 0) return `${leader} Dormie ${lead}`;
  return `${lead} Up (${remaining} to play)`;
}

// ─── Playoff resolution for tied knockout matches ────────────────────────────

type TieBreakRule = "sudden_death" | "extra_holes_3" | "none";
type PlayoffResolution =
  | { state: "regular" }                                          // not yet tied at 18
  | { state: "halved" }                                           // tied at 18, no playoff required
  | { state: "p1_wins" | "p2_wins" }                              // playoff resolved
  | { state: "playoff_in_progress"; nextHole: number; mode: "sudden_death" | "extra_holes_3" };

function resolvePlayoff(
  holeResults: Record<number, HoleOwner>,
  tieBreakRule: TieBreakRule,
  regularHoles = 18,
): PlayoffResolution {
  let p1 = 0, p2 = 0, played = 0;
  for (let h = 1; h <= regularHoles; h++) {
    const r = holeResults[h];
    if (!r) continue;
    played++;
    if (r === "player1") p1++;
    else if (r === "player2") p2++;
  }
  if (played < regularHoles || p1 !== p2) return { state: "regular" };
  if (tieBreakRule === "none") return { state: "halved" };

  // 3-hole aggregate playoff over holes 19..21, then sudden death from 22
  if (tieBreakRule === "extra_holes_3") {
    let pp1 = 0, pp2 = 0, ppPlayed = 0;
    for (let h = regularHoles + 1; h <= regularHoles + 3; h++) {
      const r = holeResults[h];
      if (!r) continue;
      ppPlayed++;
      if (r === "player1") pp1++;
      else if (r === "player2") pp2++;
    }
    if (ppPlayed < 3) {
      return { state: "playoff_in_progress", nextHole: regularHoles + 1 + ppPlayed, mode: "extra_holes_3" };
    }
    if (pp1 > pp2) return { state: "p1_wins" };
    if (pp2 > pp1) return { state: "p2_wins" };
    // Tied after 3-hole aggregate → continue with sudden death from hole 22
    for (let h = regularHoles + 4; ; h++) {
      const r = holeResults[h];
      if (!r) return { state: "playoff_in_progress", nextHole: h, mode: "sudden_death" };
      if (r === "player1") return { state: "p1_wins" };
      if (r === "player2") return { state: "p2_wins" };
      // halved → keep scanning
    }
  }

  // sudden_death: scan holes 19+ for first decisive hole
  for (let h = regularHoles + 1; ; h++) {
    const r = holeResults[h];
    if (!r) return { state: "playoff_in_progress", nextHole: h, mode: "sudden_death" };
    if (r === "player1") return { state: "p1_wins" };
    if (r === "player2") return { state: "p2_wins" };
  }
}

function isKnockoutFormat(format: string): boolean {
  return format === "single_elim" || format === "double_elim";
}

function playoffStatusLabel(mode: "sudden_death" | "extra_holes_3", nextHole: number): string {
  return mode === "extra_holes_3"
    ? `3-Hole Playoff — Hole ${nextHole}`
    : `Sudden Death — Hole ${nextHole}`;
}

function genShareToken(): string {
  return randomBytes(12).toString("base64url");
}

type HoleOwnerTeam = "team1" | "team2" | "halved";

function computeRyderMatchStatus(holeResults: Record<number, HoleOwnerTeam>, totalHoles = 18): string {
  let t1 = 0, t2 = 0;
  let holesPlayed = 0;
  for (const key of Object.keys(holeResults)) {
    const r = holeResults[Number(key)];
    if (r === "team1") t1++;
    else if (r === "team2") t2++;
    holesPlayed++;
  }
  if (holesPlayed === 0) return "All Square";
  const remaining = totalHoles - holesPlayed;
  const diff = t1 - t2;
  if (diff === 0) return remaining === 0 ? "Halved" : "All Square";
  const leader = diff > 0 ? "Team 1" : "Team 2";
  const lead = Math.abs(diff);
  if (lead > remaining) return `${leader} wins ${lead}&${remaining}`;
  if (lead === remaining && remaining > 0) return `${leader} Dormie ${lead}`;
  return `${lead} Up (${remaining} to play)`;
}

// ─── Bracket Engine Helpers ──────────────────────────────────────────────────

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function getRoundName(roundNum: number, totalRounds: number): string {
  const roundFromFinal = totalRounds - roundNum;
  if (roundFromFinal === 0) return "Final";
  if (roundFromFinal === 1) return "Semi-Final";
  if (roundFromFinal === 2) return "Quarter-Final";
  return `Round of ${nextPowerOfTwo(Math.pow(2, roundFromFinal + 1))}`;
}

/**
 * Place seeds into standard bracket positions so that:
 *   - Seed 1 vs Seed N (top half of bracket)
 *   - Seed 2 vs Seed N-1 (bottom half)
 *   - etc.
 *
 * We use the recursive approach: positions are interleaved so that
 * higher seeds only meet lower seeds as late as possible.
 * Returns an array of length slotCount where each entry is a player id or null (bye).
 */
function buildSeededSlots(
  seededPlayers: Array<{ id: number; seed: number }>,
  slotCount: number,
): (number | null)[] {
  const slots: (number | null)[] = Array(slotCount).fill(null);

  // Build ordered seed positions using the standard single-elimination arrangement.
  // The algorithm: recursively place seed 1 at top, seed 2 at bottom, then fill
  // the remaining positions so opponents always have maximum seed gap.
  function seatPosition(seed: number, size: number): number {
    if (size === 1) return 0;
    const half = size / 2;
    if (seed <= size / 2) {
      // Place in top half — recurse with seed mapped within [1..size/2]
      return seatPosition(seed, half) * 2;
    } else {
      // Place in bottom half — mirror: complement relative to size+1
      const mirror = size + 1 - seed;
      return seatPosition(mirror, half) * 2 + 1;
    }
  }

  for (const player of seededPlayers) {
    const pos = seatPosition(player.seed, slotCount);
    slots[pos] = player.id;
  }
  return slots;
}

/**
 * Round-robin draw using the standard "circle method".
 * Every player faces every other player exactly once.
 * For odd N, a phantom bye player is added → some matches are bye-pairings (auto-skip).
 */
async function generateRoundRobinDraw(
  bracketId: number,
  players: Array<{ id: number; seed: number }>,
): Promise<void> {
  const ordered = [...players].sort((a, b) => a.seed - b.seed).map(p => p.id);
  const isOdd = ordered.length % 2 === 1;
  const ids: (number | null)[] = isOdd ? [...ordered, null] : [...ordered];
  const n = ids.length;
  const totalRounds = n - 1;
  const half = n / 2;

  await db.update(matchPlayBracketTable)
    .set({ totalRounds, drawGeneratedAt: new Date(), updatedAt: new Date() })
    .where(eq(matchPlayBracketTable.id, bracketId));

  // Circle method: index 0 fixed, others rotate.
  let rotation = ids.slice();
  for (let r = 1; r <= totalRounds; r++) {
    const [roundRow] = await db.insert(bracketRoundsTable).values({
      bracketId,
      roundNumber: r,
      name: `Round ${r}`,
      bracketType: "main",
    }).returning();

    let matchNum = 1;
    for (let i = 0; i < half; i++) {
      const p1 = rotation[i];
      const p2 = rotation[n - 1 - i];
      const isBye = p1 === null || p2 === null;
      await db.insert(bracketMatchesTable).values({
        bracketId,
        roundId: roundRow.id,
        matchNumber: matchNum++,
        bracketType: "main",
        player1Id: p1 ?? null,
        player2Id: p2 ?? null,
        player1IsBye: p1 === null,
        player2IsBye: p2 === null,
        result: isBye ? (p1 === null ? "player2_wins" : "player1_wins") : "pending",
        winnerId: isBye ? (p1 ?? p2 ?? null) : null,
        holeResults: {},
      });
    }

    // Rotate (keep first fixed)
    const fixed = rotation[0];
    const rotated = rotation.slice(1);
    rotated.unshift(rotated.pop()!);
    rotation = [fixed, ...rotated];
  }
}

/**
 * Traditional Double-Elimination draw.
 *
 * For a WB with R = log2(slotCount) rounds:
 *  - LB has 2*(R - 1) rounds, alternating "consolidation" and "minor":
 *      LB R(2L-1) "consolidation": pairs of LB winners from previous minor round
 *                                  (or pairs of WB R1 losers when L=1).
 *      LB R(2L)   "minor":         each LB consolidation winner plays a freshly
 *                                  dropped WB R(L+1) loser.
 *      Each pair of LB rounds at "level" L has slotCount / 2^(L+1) matches.
 *  - Grand Final: WB winner (slot 1) vs LB final winner (slot 2).
 *
 * Slot routing is deterministic via nextWinnerSlot / nextLoserSlot:
 *  - WB R1 match k loser → LB R1 match ceil(k/2), slot = (k odd ? 1 : 2)
 *  - LB cons match k winner → LB minor match k, slot 1
 *  - WB R(L+1) match k loser → LB R(2L) match (mCount - k + 1), slot 2  (reseeded)
 *  - LB minor match k winner → LB cons (next level) match ceil(k/2), slot = (k odd ? 1 : 2)
 *  - WB final winner → Grand Final, slot 1
 *  - LB final winner → Grand Final, slot 2
 *
 * WB-drop reseeding: at each WB feed level L (≥1), the WB R(L+1) losers are
 * reversed before being placed into the LB R(2L) minor round. Without this,
 * the WB R(L+1) loser of match k would drop into the same LB minor match
 * (slot 2) where the LB cons winner from the same WB section sits in slot 1
 * — guaranteeing an immediate rematch with their R1 opponent. Reversing the
 * drop order routes each WB drop to the opposite side of the LB, pushing
 * rematches as late as possible. The mapping per level is documented below:
 *
 *   Level L   WB feed round   # matches   mapping (WB match → LB minor match)
 *   ─────────────────────────────────────────────────────────────────────────
 *     1       WB R2           slotCount/4 m_k → m_{N - k + 1}, where N = slotCount/4
 *     2       WB R3           slotCount/8 m_k → m_{N - k + 1}, where N = slotCount/8
 *     ...
 *     R-1     WB final        1           m_1 → m_1 (no-op for single match)
 */
async function generateDoubleElimDraw(
  bracketId: number,
  players: Array<{ id: number; seed: number }>,
): Promise<void> {
  const n = players.length;
  const slotCount = nextPowerOfTwo(n);
  const wbRounds = Math.log2(slotCount); // R
  if (wbRounds < 2) {
    // Edge case: only 2 players; fall back to single-elim with a no-op LB.
    return generateDraw(bracketId, 0, players, false, "single_elim");
  }

  const lbLevels = wbRounds - 1;          // L = 1..R-1
  const lbRoundCount = 2 * lbLevels;      // alternating cons/minor
  const totalRounds = wbRounds + 1;       // metadata: WB depth + GF

  await db.update(matchPlayBracketTable)
    .set({ totalRounds, drawGeneratedAt: new Date(), updatedAt: new Date() })
    .where(eq(matchPlayBracketTable.id, bracketId));

  // ── Build WB ──
  const seededPlayers = [...players].sort((a, b) => a.seed - b.seed);
  const slots = buildSeededSlots(seededPlayers, slotCount);

  type Inserted = { id: number; roundNumber: number; matchNumber: number };
  const wbMatchesByRound: Inserted[][] = []; // wbMatchesByRound[r-1] = matches in WB R r

  for (let r = 1; r <= wbRounds; r++) {
    const [round] = await db.insert(bracketRoundsTable).values({
      bracketId, roundNumber: r, name: `WB ${getRoundName(r, wbRounds)}`, bracketType: "main",
    }).returning();
    const mCount = slotCount / Math.pow(2, r);
    const arr: Inserted[] = [];
    for (let i = 0; i < mCount; i++) {
      let p1: number | null = null, p2: number | null = null;
      if (r === 1) { p1 = slots[i * 2]; p2 = slots[i * 2 + 1]; }
      const [m] = await db.insert(bracketMatchesTable).values({
        bracketId, roundId: round.id, matchNumber: i + 1, bracketType: "main",
        player1Id: p1, player2Id: p2,
        player1IsBye: r === 1 && p1 === null,
        player2IsBye: r === 1 && p2 === null,
        result: "pending", holeResults: {},
      }).returning();
      arr.push({ id: m.id, roundNumber: r, matchNumber: i + 1 });
    }
    wbMatchesByRound.push(arr);
  }

  // ── Build LB rounds (alternating cons/minor) ──
  // lbMatchesByRound[lbRoundNumber-1] = matches at that LB round (1-indexed).
  const lbMatchesByRound: Inserted[][] = [];
  for (let r = 1; r <= lbRoundCount; r++) {
    const isCons = r % 2 === 1;
    const level = Math.ceil(r / 2);                     // 1..lbLevels
    const mCount = slotCount / Math.pow(2, level + 1);  // slots/4 at L=1, slots/8 at L=2, ...
    // Label per traditional double-elim convention: each WB feed level gets a
    // pair of sub-rounds — the "major" round (LB-only) named "LB R{L}", and
    // the "minor" merge round (where new WB drops join) named "LB R{L} Minor".
    // The very last LB sub-round is the LB Final.
    const isLbFinal = r === lbRoundCount;
    const lbName = isLbFinal
      ? "LB Final"
      : isCons
        ? `LB R${level}`
        : `LB R${level} Minor`;
    const [round] = await db.insert(bracketRoundsTable).values({
      bracketId,
      roundNumber: r,
      name: lbName,
      bracketType: "consolation",
    }).returning();
    const arr: Inserted[] = [];
    for (let i = 1; i <= mCount; i++) {
      const [m] = await db.insert(bracketMatchesTable).values({
        bracketId, roundId: round.id, matchNumber: i, bracketType: "consolation",
        result: "pending", holeResults: {},
      }).returning();
      arr.push({ id: m.id, roundNumber: r, matchNumber: i });
    }
    lbMatchesByRound.push(arr);
  }

  // ── Grand Final ──
  const [gfRound] = await db.insert(bracketRoundsTable).values({
    bracketId, roundNumber: wbRounds + 1, name: "Grand Final", bracketType: "main",
  }).returning();
  const [gfMatch] = await db.insert(bracketMatchesTable).values({
    bracketId, roundId: gfRound.id, matchNumber: 1, bracketType: "main",
    result: "pending", holeResults: {},
  }).returning();

  // ── Wire WB winner advancement ──
  for (let r = 1; r < wbRounds; r++) {
    const cur = wbMatchesByRound[r - 1];
    const nxt = wbMatchesByRound[r];
    for (const m of cur) {
      const next = nxt[Math.ceil(m.matchNumber / 2) - 1];
      const slot = m.matchNumber % 2 === 1 ? 1 : 2;
      if (next) await db.update(bracketMatchesTable)
        .set({ nextMatchId: next.id, nextWinnerSlot: slot })
        .where(eq(bracketMatchesTable.id, m.id));
    }
  }
  // WB final winner → GF slot 1
  for (const m of wbMatchesByRound[wbRounds - 1]) {
    await db.update(bracketMatchesTable)
      .set({ nextMatchId: gfMatch.id, nextWinnerSlot: 1 })
      .where(eq(bracketMatchesTable.id, m.id));
  }

  // ── Wire WB losers → LB ──
  // WB R1 losers → LB R1 (consolidation, level 1)
  {
    const wb = wbMatchesByRound[0];
    const lb = lbMatchesByRound[0];
    for (const m of wb) {
      const lbm = lb[Math.ceil(m.matchNumber / 2) - 1];
      const slot = m.matchNumber % 2 === 1 ? 1 : 2;
      if (lbm) await db.update(bracketMatchesTable)
        .set({ nextLoserMatchId: lbm.id, nextLoserSlot: slot })
        .where(eq(bracketMatchesTable.id, m.id));
    }
  }
  // WB R(L+1) losers (for L=1..lbLevels) → LB R(2L) (minor of level L), slot 2.
  // Reseed by reversing the drop order at each level so WB drops land on the
  // opposite side of the LB and don't immediately rematch the LB cons winner
  // that came from the same WB section. See block comment above for the full
  // per-level mapping table.
  for (let level = 1; level <= lbLevels; level++) {
    const wbR = level + 1;          // WB round number
    const lbR = 2 * level;          // LB round number (minor)
    const wb = wbMatchesByRound[wbR - 1];
    const lb = lbMatchesByRound[lbR - 1];
    for (const m of wb) {
      // Reversed drop order so WB losers land on the opposite side of the LB
      // and avoid an immediate rematch with the same-section cons winner.
      // See `lib/double-elim-routing.ts` for the documented per-level mapping.
      const targetMatchNumber = wbLoserToLbMinorMatchNumber(level, m.matchNumber, slotCount);
      const lbm = lb[targetMatchNumber - 1];
      if (lbm) await db.update(bracketMatchesTable)
        .set({ nextLoserMatchId: lbm.id, nextLoserSlot: 2 })
        .where(eq(bracketMatchesTable.id, m.id));
    }
  }

  // ── Wire LB winner advancement ──
  for (let r = 1; r < lbRoundCount; r++) {
    const cur = lbMatchesByRound[r - 1];
    const nxt = lbMatchesByRound[r];
    const isConsCur = r % 2 === 1;
    for (const m of cur) {
      if (isConsCur) {
        // cons → minor (same level), slot 1, same matchNumber
        const next = nxt[m.matchNumber - 1];
        if (next) await db.update(bracketMatchesTable)
          .set({ nextMatchId: next.id, nextWinnerSlot: 1 })
          .where(eq(bracketMatchesTable.id, m.id));
      } else {
        // minor → cons (next level), match ceil(k/2), slot odd→1 even→2
        const next = nxt[Math.ceil(m.matchNumber / 2) - 1];
        const slot = m.matchNumber % 2 === 1 ? 1 : 2;
        if (next) await db.update(bracketMatchesTable)
          .set({ nextMatchId: next.id, nextWinnerSlot: slot })
          .where(eq(bracketMatchesTable.id, m.id));
      }
    }
  }
  // LB final → Grand Final, slot 2
  for (const m of lbMatchesByRound[lbRoundCount - 1]) {
    await db.update(bracketMatchesTable)
      .set({ nextMatchId: gfMatch.id, nextWinnerSlot: 2 })
      .where(eq(bracketMatchesTable.id, m.id));
  }

  // ── Auto-advance round-1 WB byes (winner uses nextWinnerSlot; loser slot is unused for byes) ──
  for (const m of wbMatchesByRound[0]) {
    const [row] = await db.select().from(bracketMatchesTable).where(eq(bracketMatchesTable.id, m.id));
    if (!row || (!row.player1IsBye && !row.player2IsBye)) continue;
    const winnerId = row.player1IsBye ? row.player2Id : row.player1Id;
    if (!winnerId) continue;
    const byeResult = row.player1IsBye ? "player2_wins" : "player1_wins";
    await db.update(bracketMatchesTable).set({ result: byeResult, winnerId, updatedAt: new Date() })
      .where(eq(bracketMatchesTable.id, m.id));
    if (row.nextMatchId) {
      const slotCol = row.nextWinnerSlot === 2 ? "player2Id" : "player1Id";
      await db.update(bracketMatchesTable)
        .set({ [slotCol]: winnerId, updatedAt: new Date() })
        .where(eq(bracketMatchesTable.id, row.nextMatchId));
    }
  }
}

async function generateDraw(
  bracketId: number,
  tournamentId: number,
  players: Array<{ id: number; seed: number }>,
  hasConsolation: boolean,
  format: string = "single_elim",
): Promise<void> {
  // Clear any previous rounds/matches first (regenerate)
  const existingRounds = await db.select({ id: bracketRoundsTable.id })
    .from(bracketRoundsTable)
    .where(eq(bracketRoundsTable.bracketId, bracketId));
  if (existingRounds.length > 0) {
    const roundIds = existingRounds.map(r => r.id);
    await db.delete(bracketMatchesTable).where(inArray(bracketMatchesTable.roundId, roundIds));
  }
  await db.delete(bracketRoundsTable).where(eq(bracketRoundsTable.bracketId, bracketId));

  // Reset finalization state — a regenerated draw must be treated as
  // in-progress again so maybeFinalizeRoundRobin can run the new bracket
  // through to completion without being blocked by stale champion data.
  await db.update(matchPlayBracketTable)
    .set({ championId: null, runnerUpId: null, completedAt: null, updatedAt: new Date() })
    .where(eq(matchPlayBracketTable.id, bracketId));

  if (format === "round_robin") {
    await generateRoundRobinDraw(bracketId, players);
    return;
  }
  if (format === "double_elim") {
    await generateDoubleElimDraw(bracketId, players);
    return;
  }

  // ── single_elim (default) ──
  const n = players.length;
  const slotCount = nextPowerOfTwo(n);
  const totalRounds = Math.log2(slotCount);

  // Update bracket meta
  await db.update(matchPlayBracketTable)
    .set({ totalRounds, drawGeneratedAt: new Date(), updatedAt: new Date() })
    .where(eq(matchPlayBracketTable.id, bracketId));

  // Place players into seeded slots (standard bracket arrangement)
  const seededPlayers = [...players].sort((a, b) => a.seed - b.seed);
  const slots = buildSeededSlots(seededPlayers, slotCount);

  // ── Create all rounds & matches ──────────────────────────────────────────
  // We create all placeholder matches first so we can wire nextMatchId.
  // Store round and match records keyed by round number and match number.

  type InsertedMatch = { id: number; roundNumber: number; matchNumber: number };
  const insertedMatches: InsertedMatch[] = [];

  for (let r = 1; r <= totalRounds; r++) {
    const [roundRow] = await db.insert(bracketRoundsTable).values({
      bracketId,
      roundNumber: r,
      name: getRoundName(r, totalRounds),
      bracketType: "main",
    }).returning();

    const mCount = slotCount / Math.pow(2, r);

    if (r === 1) {
      // First round: assign player slots from seeded positions
      for (let i = 0; i < mCount; i++) {
        const p1 = slots[i * 2];
        const p2 = slots[i * 2 + 1];
        const [m] = await db.insert(bracketMatchesTable).values({
          bracketId,
          roundId: roundRow.id,
          matchNumber: i + 1,
          bracketType: "main",
          player1Id: p1 ?? null,
          player2Id: p2 ?? null,
          player1IsBye: p1 === null,
          player2IsBye: p2 === null,
          result: "pending",
          holeResults: {},
        }).returning();
        insertedMatches.push({ id: m.id, roundNumber: r, matchNumber: i + 1 });
      }
    } else {
      // Later rounds: placeholder matches (players filled in as winners advance)
      for (let m = 1; m <= mCount; m++) {
        const [row] = await db.insert(bracketMatchesTable).values({
          bracketId,
          roundId: roundRow.id,
          matchNumber: m,
          bracketType: "main",
          result: "pending",
          holeResults: {},
        }).returning();
        insertedMatches.push({ id: row.id, roundNumber: r, matchNumber: m });
      }
    }
  }

  // Wire nextMatchId: for each match in round r, the winner goes to match
  // ceil(matchNumber/2) in round r+1.
  for (const m of insertedMatches) {
    if (m.roundNumber >= totalRounds) continue; // final has no next
    const nextMatchNumber = Math.ceil(m.matchNumber / 2);
    const nextMatch = insertedMatches.find(
      x => x.roundNumber === m.roundNumber + 1 && x.matchNumber === nextMatchNumber,
    );
    if (nextMatch) {
      await db.update(bracketMatchesTable)
        .set({ nextMatchId: nextMatch.id })
        .where(eq(bracketMatchesTable.id, m.id));
    }
  }

  // Auto-advance bye winners in round 1: if one slot is a bye, the present player wins immediately
  for (let i = 0; i < slotCount / 2; i++) {
    const matchNum = i + 1;
    const m = insertedMatches.find(x => x.roundNumber === 1 && x.matchNumber === matchNum);
    if (!m) continue;
    const [row] = await db.select().from(bracketMatchesTable).where(eq(bracketMatchesTable.id, m.id));
    if (!row) continue;
    const hasBye = row.player1IsBye || row.player2IsBye;
    if (!hasBye) continue;

    // One player, the other is a bye → auto-advance
    // If player1 is the bye, player2 wins; if player2 is the bye, player1 wins
    const winnerId = row.player1IsBye ? row.player2Id : row.player1Id;
    const byeResult = row.player1IsBye ? "player2_wins" : "player1_wins";
    if (!winnerId) continue;

    await db.update(bracketMatchesTable)
      .set({ result: byeResult, winnerId, updatedAt: new Date() })
      .where(eq(bracketMatchesTable.id, m.id));

    if (row.nextMatchId) {
      const [nextRow] = await db.select().from(bracketMatchesTable)
        .where(eq(bracketMatchesTable.id, row.nextMatchId));
      if (nextRow) {
        const slot = !nextRow.player1Id ? "player1Id" : "player2Id";
        await db.update(bracketMatchesTable)
          .set({ [slot]: winnerId, updatedAt: new Date() })
          .where(eq(bracketMatchesTable.id, row.nextMatchId));
      }
    }
  }

  // Consolation bracket (single round — loser gets placed when their round-1 match completes)
  if (hasConsolation) {
    const firstRoundMatches = insertedMatches.filter(x => x.roundNumber === 1);
    const [conRound] = await db.insert(bracketRoundsTable).values({
      bracketId,
      roundNumber: 1,
      name: "Consolation Round",
      bracketType: "consolation",
    }).returning();

    for (const fm of firstRoundMatches) {
      await db.insert(bracketMatchesTable).values({
        bracketId,
        roundId: conRound.id,
        matchNumber: fm.matchNumber,
        bracketType: "consolation",
        result: "pending",
        holeResults: {},
      });
    }
  }
}

// ─── Round-robin completion / champion detection ────────────────────────────
//
// Called after recording any RR match result. Decides one of:
//   1. Bracket already finalised (championId set)            → no-op
//   2. A tie-break round exists and its match is complete    → finalise using
//      the tie-break match's winner / loser as champion / runner-up
//   3. A tie-break round exists but the match is not complete → no-op
//   4. All non-tie-break RR matches are complete:
//      a. Unique #1 in standings                             → finalise
//      b. Multi-way tie at #1, tieBreakRule === "none"       → finalise
//         (preserve historic "shared first" behaviour)
//      c. Multi-way tie at #1, tieBreakRule !== "none"       → create a
//         "Tie-Break" round + match between the top-two tied players
async function maybeFinalizeRoundRobin(
  bracketId: number,
  tournamentId: number,
  tieBreakRule: TieBreakRule,
): Promise<{ championId: number | null; runnerUpId: number | null; tieBreakRoundCreated: boolean; tieBreakMatchId: number | null }> {
  const result = { championId: null as number | null, runnerUpId: null as number | null, tieBreakRoundCreated: false, tieBreakMatchId: null as number | null };

  const [bracketRow] = await db.select().from(matchPlayBracketTable)
    .where(eq(matchPlayBracketTable.id, bracketId));
  if (!bracketRow) return result;
  if (bracketRow.championId) {
    return { championId: bracketRow.championId, runnerUpId: bracketRow.runnerUpId, tieBreakRoundCreated: false, tieBreakMatchId: null };
  }

  // Identify any existing tie-break round for this bracket.
  const [tieBreakRound] = await db.select().from(bracketRoundsTable)
    .where(and(
      eq(bracketRoundsTable.bracketId, bracketId),
      eq(bracketRoundsTable.name, ROUND_ROBIN_TIE_BREAK_ROUND_NAME),
    ));

  // Pull every match in the bracket so we can split RR vs tie-break and
  // compute standings server-side.
  const allMatches = await db.select().from(bracketMatchesTable)
    .where(eq(bracketMatchesTable.bracketId, bracketId));

  if (tieBreakRound) {
    const tbMatches = allMatches.filter(m => m.roundId === tieBreakRound.id);
    const tbDecided = tbMatches.length > 0 && tbMatches.every(m => m.result !== "pending" && m.winnerId);
    if (!tbDecided) return result;
    // Champion = tie-break winner; runner-up = the other player.
    const tb = tbMatches[0];
    const championId = tb.winnerId!;
    const runnerUpId = championId === tb.player1Id ? (tb.player2Id ?? null) : (tb.player1Id ?? null);
    await finaliseBracket(bracketId, tournamentId, championId, runnerUpId);
    return { championId, runnerUpId, tieBreakRoundCreated: false, tieBreakMatchId: null };
  }

  // No tie-break round yet — only finalise once every regular RR match is done.
  const rrMatches = allMatches.filter(m => m.bracketType === "main");
  const allComplete = rrMatches.every(m => m.result !== "pending");
  if (!allComplete) return result;

  const standings = computeRrStandings(rrMatches.map(m => ({
    bracketType: m.bracketType,
    player1Id: m.player1Id,
    player2Id: m.player2Id,
    player1IsBye: m.player1IsBye,
    player2IsBye: m.player2IsBye,
    result: m.result,
    winnerId: m.winnerId,
    holeResults: m.holeResults as Record<string, string> | null,
  } satisfies RrStandingsMatch)));

  if (standings.length === 0) return result;

  const top = standings[0];
  if (!top.tied || tieBreakRule === "none") {
    const championId = top.playerId;
    const runnerUpId = standings[1]?.playerId ?? null;
    await finaliseBracket(bracketId, tournamentId, championId, runnerUpId);
    return { championId, runnerUpId, tieBreakRoundCreated: false, tieBreakMatchId: null };
  }

  // Need a manual playoff between the players truly tied at #1.
  // Pick the first two — their order from computeRrStandings already prefers
  // h2h then holes won, so this is a deterministic top-two.
  const tiedTop = standings.filter(s => s.tied
    && s.points === top.points
    && s.holesWon === top.holesWon);
  if (tiedTop.length < 2) return result; // shouldn't happen but guard

  const p1Id = tiedTop[0].playerId;
  const p2Id = tiedTop[1].playerId;

  // Place the tie-break round after the highest existing round number so the
  // unique (bracketId, roundNumber, bracketType) index doesn't collide.
  const existingRounds = await db.select({ roundNumber: bracketRoundsTable.roundNumber })
    .from(bracketRoundsTable)
    .where(and(
      eq(bracketRoundsTable.bracketId, bracketId),
      eq(bracketRoundsTable.bracketType, "main"),
    ));
  const nextRoundNumber = existingRounds.reduce((max, r) => Math.max(max, r.roundNumber), 0) + 1;

  const [tbRound] = await db.insert(bracketRoundsTable).values({
    bracketId,
    roundNumber: nextRoundNumber,
    name: ROUND_ROBIN_TIE_BREAK_ROUND_NAME,
    bracketType: "main",
  }).returning();

  const [tbMatch] = await db.insert(bracketMatchesTable).values({
    bracketId,
    roundId: tbRound.id,
    matchNumber: 1,
    bracketType: "main",
    player1Id: p1Id,
    player2Id: p2Id,
    result: "pending",
    holeResults: {},
  }).returning({ id: bracketMatchesTable.id });

  // Fire-and-forget: notify the tournament directors and the two tied
  // players that a tie-break match was just created. Failures here must
  // not break the bracket finalization flow.
  notifyRoundRobinTieBreak({
    bracketId,
    tournamentId,
    tieBreakMatchId: tbMatch.id,
    player1Id: p1Id,
    player2Id: p2Id,
  }).catch((err) => {
    logger.warn({ bracketId, tournamentId, tieBreakMatchId: tbMatch.id, err },
      "Round-robin tie-break notification failed");
  });

  return { championId: null, runnerUpId: null, tieBreakRoundCreated: true, tieBreakMatchId: tbMatch.id };
}

async function finaliseBracket(
  bracketId: number,
  tournamentId: number,
  championId: number,
  runnerUpId: number | null,
): Promise<void> {
  await db.update(matchPlayBracketTable)
    .set({ championId, runnerUpId, completedAt: new Date(), updatedAt: new Date() })
    .where(eq(matchPlayBracketTable.id, bracketId));
  logger.info({ bracketId, tournamentId, championId, runnerUpId },
    "Round-robin bracket marked complete");
}

// ─── MATCH PLAY BRACKET ROUTES ───────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/bracket
router.get("/bracket", async (req: Request, res: Response) => {
  const { orgId, tournamentId } = (req.params as Record<string, string>);
  try {
    // Verify tournament belongs to this org
    const [tournament] = await db.select({ id: tournamentsTable.id })
      .from(tournamentsTable)
      .where(and(
        eq(tournamentsTable.id, Number(tournamentId)),
        eq(tournamentsTable.organizationId, Number(orgId)),
      ));
    if (!tournament) { res.status(404).json({ error: "Tournament not found" }); return; }

    const [bracket] = await db.select()
      .from(matchPlayBracketTable)
      .where(eq(matchPlayBracketTable.tournamentId, Number(tournamentId)));
    if (!bracket) { res.status(404).json({ error: "Bracket not found" }); return; }

    const rounds = await db.select()
      .from(bracketRoundsTable)
      .where(eq(bracketRoundsTable.bracketId, bracket.id))
      .orderBy(asc(bracketRoundsTable.bracketType), asc(bracketRoundsTable.roundNumber));

    const matches = await db.select({
      id: bracketMatchesTable.id,
      bracketId: bracketMatchesTable.bracketId,
      roundId: bracketMatchesTable.roundId,
      matchNumber: bracketMatchesTable.matchNumber,
      bracketType: bracketMatchesTable.bracketType,
      player1Id: bracketMatchesTable.player1Id,
      player2Id: bracketMatchesTable.player2Id,
      player1IsBye: bracketMatchesTable.player1IsBye,
      player2IsBye: bracketMatchesTable.player2IsBye,
      result: bracketMatchesTable.result,
      winnerId: bracketMatchesTable.winnerId,
      holeResults: bracketMatchesTable.holeResults,
      matchStatus: bracketMatchesTable.matchStatus,
      conceededByPlayerId: bracketMatchesTable.conceededByPlayerId,
      conceededOnHole: bracketMatchesTable.conceededOnHole,
      nextMatchId: bracketMatchesTable.nextMatchId,
      updatedAt: bracketMatchesTable.updatedAt,
    })
      .from(bracketMatchesTable)
      .where(eq(bracketMatchesTable.bracketId, bracket.id))
      .orderBy(asc(bracketMatchesTable.roundId), asc(bracketMatchesTable.matchNumber));

    // Fetch all players in tournament for name resolution
    const playerList = await db.select({
      id: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      handicapIndex: playersTable.handicapIndex,
    }).from(playersTable)
      .where(eq(playersTable.tournamentId, Number(tournamentId)));

    const playerMap = new Map(playerList.map(p => [p.id, p]));

    const enrichedMatches = matches.map(m => ({
      ...m,
      player1: m.player1Id ? (playerMap.get(m.player1Id) ?? null) : null,
      player2: m.player2Id ? (playerMap.get(m.player2Id) ?? null) : null,
      winner: m.winnerId ? (playerMap.get(m.winnerId) ?? null) : null,
    }));

    res.json({ bracket, rounds, matches: enrichedMatches });
  } catch (err) {
    logger.error({ err }, "Failed to fetch bracket");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /organizations/:orgId/tournaments/:tournamentId/bracket
// Create or reset bracket config
router.post("/bracket", async (req: Request, res: Response) => {
  const { orgId, tournamentId } = (req.params as Record<string, string>);
  if (!await requireTournamentAccess(req, res, Number(orgId), Number(tournamentId))) return;
  const {
    seedingMethod = "manual",
    hasConsolation = false,
    format = "single_elim",
    tieBreakRule = "sudden_death",
  } = req.body as {
    seedingMethod?: string; hasConsolation?: boolean;
    format?: "single_elim" | "double_elim" | "round_robin";
    tieBreakRule?: "sudden_death" | "extra_holes_3" | "none";
  };
  try {
    const existing = await db.select().from(matchPlayBracketTable)
      .where(eq(matchPlayBracketTable.tournamentId, Number(tournamentId)));
    let bracket;
    if (existing.length > 0) {
      [bracket] = await db.update(matchPlayBracketTable)
        .set({
          seedingMethod, hasConsolation, format, tieBreakRule,
          shareToken: existing[0].shareToken ?? genShareToken(),
          updatedAt: new Date(),
        })
        .where(eq(matchPlayBracketTable.tournamentId, Number(tournamentId)))
        .returning();
    } else {
      [bracket] = await db.insert(matchPlayBracketTable)
        .values({
          tournamentId: Number(tournamentId),
          seedingMethod, hasConsolation, format, tieBreakRule,
          shareToken: genShareToken(),
        })
        .returning();

      // Task #2008 — branded `match.scheduled` dispatch on bracket creation,
      // fanned out to every participating tournament player. The bracket row
      // is the canonical "matches scheduled" event in this product.
      try {
        const playerRows = await db.select({ userId: playersTable.userId })
          .from(playersTable)
          .where(and(
            eq(playersTable.tournamentId, Number(tournamentId)),
            eq(playersTable.dns, false),
          ));
        const userIds = playerRows
          .map(p => p.userId)
          .filter((id): id is number => typeof id === "number" && id > 0);
        if (userIds.length > 0) {
          const { notifyMatchScheduled } = await import("../lib/brandedNotifications.js");
          void notifyMatchScheduled({
            userIds,
            matchId: bracket.id,
            scheduledAt: new Date(),
          });
        }
      } catch (err) {
        logger.warn({ err, tournamentId }, "[match-play] branded match.scheduled notify failed (non-fatal)");
      }
    }
    res.json({ bracket });
  } catch (err) {
    logger.error({ err }, "Failed to create/update bracket");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /organizations/:orgId/tournaments/:tournamentId/bracket/generate-draw
router.post("/bracket/generate-draw", async (req: Request, res: Response) => {
  const { orgId, tournamentId } = (req.params as Record<string, string>);
  if (!await requireTournamentAccess(req, res, Number(orgId), Number(tournamentId))) return;
  const { seeds } = req.body as { seeds?: Array<{ playerId: number; seed: number }> };
  try {
    const [bracket] = await db.select().from(matchPlayBracketTable)
      .where(eq(matchPlayBracketTable.tournamentId, Number(tournamentId)));
    if (!bracket) { res.status(404).json({ error: "Bracket config not found. Create it first." }); return; }

    let playerSeeds: Array<{ id: number; seed: number }>;
    if (seeds && seeds.length > 0) {
      playerSeeds = seeds.map(s => ({ id: s.playerId, seed: s.seed }));
    } else {
      const players = await db.select({
        id: playersTable.id,
        handicapIndex: playersTable.handicapIndex,
      }).from(playersTable)
        .where(and(
          eq(playersTable.tournamentId, Number(tournamentId)),
          eq(playersTable.dns, false),
        ))
        .orderBy(asc(playersTable.handicapIndex));
      playerSeeds = players.map((p, idx) => ({ id: p.id, seed: idx + 1 }));
    }

    if (playerSeeds.length < 2) {
      res.status(400).json({ error: "Need at least 2 players to generate draw" }); return;
    }

    await generateDraw(bracket.id, Number(tournamentId), playerSeeds, bracket.hasConsolation, bracket.format);

    const [updated] = await db.select().from(matchPlayBracketTable)
      .where(eq(matchPlayBracketTable.id, bracket.id));
    broadcastBracketUpdate(Number(tournamentId), { type: "draw_generated", bracket: updated });
    res.json({ success: true, bracket: updated });
  } catch (err) {
    logger.error({ err }, "Failed to generate draw");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /organizations/:orgId/tournaments/:tournamentId/bracket/matches/:matchId/result
router.post("/bracket/matches/:matchId/result", async (req: Request, res: Response) => {
  const { orgId, tournamentId, matchId } = (req.params as Record<string, string>);
  if (!await requireTournamentAccess(req, res, Number(orgId), Number(tournamentId))) return;
  const { result, holeResults, concededByPlayerId, concededOnHole } = req.body;
  try {
    // Fetch match then verify its bracket belongs to this tournament
    const [matchRow] = await db.select().from(bracketMatchesTable)
      .where(eq(bracketMatchesTable.id, Number(matchId)));
    if (!matchRow) { res.status(404).json({ error: "Match not found" }); return; }

    const [bracketRow] = await db.select().from(matchPlayBracketTable)
      .where(and(
        eq(matchPlayBracketTable.id, matchRow.bracketId),
        eq(matchPlayBracketTable.tournamentId, Number(tournamentId)),
      ));
    if (!bracketRow) { res.status(403).json({ error: "Match does not belong to this tournament" }); return; }

    const resolvedHoleResults = (holeResults ?? matchRow.holeResults ?? {}) as Record<number, HoleOwner>;
    let matchStatus = computeMatchStatus(resolvedHoleResults);
    let effectiveResult: string = result;
    const tieBreakRule = (bracketRow.tieBreakRule ?? "sudden_death") as TieBreakRule;
    // RR tie-break rounds use the same playoff resolution as a knockout match,
    // because they exist specifically to break a top-of-table tie.
    const [matchRound] = await db.select({ name: bracketRoundsTable.name })
      .from(bracketRoundsTable)
      .where(eq(bracketRoundsTable.id, matchRow.roundId));
    const isRrTieBreakMatch = bracketRow.format === "round_robin"
      && matchRound?.name === ROUND_ROBIN_TIE_BREAK_ROUND_NAME;
    const knockout = isKnockoutFormat(bracketRow.format ?? "single_elim") || isRrTieBreakMatch;

    // Tie-break enforcement: when a knockout match is halved at 18, apply the bracket's rule.
    // - none (or non-knockout): allow halved through (round-robin awards 0.5 pts each via standings).
    // - sudden_death / extra_holes_3: scan playoff holes (19+); coerce winner if resolved,
    //   otherwise refuse with 409 so the admin UI can prompt for the next playoff hole.
    if (result === "halved" && knockout && tieBreakRule !== "none") {
      const resolution = resolvePlayoff(resolvedHoleResults, tieBreakRule);
      if (resolution.state === "p1_wins") {
        effectiveResult = "player1_wins";
        matchStatus = "Player 1 wins (playoff)";
      } else if (resolution.state === "p2_wins") {
        effectiveResult = "player2_wins";
        matchStatus = "Player 2 wins (playoff)";
      } else if (resolution.state === "playoff_in_progress") {
        matchStatus = playoffStatusLabel(resolution.mode, resolution.nextHole);
        await db.update(bracketMatchesTable)
          .set({ holeResults: resolvedHoleResults, matchStatus, updatedAt: new Date() })
          .where(eq(bracketMatchesTable.id, Number(matchId)));
        broadcastBracketUpdate(Number(tournamentId), { matchId: Number(matchId), playoff: resolution });
        res.status(409).json({
          error: "playoff_required",
          tieBreakRule,
          mode: resolution.mode,
          nextHole: resolution.nextHole,
          matchStatus,
        }); return;
      } else if (resolution.state === "regular") {
        // Admin reported halved but didn't enter all 18 hole results. A knockout match
        // cannot end halved under sudden_death/extra_holes_3, so refuse — but persist a
        // "Playoff required" status so the UI surfaces the playoff entry flow on reopen
        // and broadcast the state so spectators see the playoff is pending.
        const mode: "sudden_death" | "extra_holes_3" = tieBreakRule === "extra_holes_3" ? "extra_holes_3" : "sudden_death";
        const playoffStatus = playoffStatusLabel(mode, 19);
        await db.update(bracketMatchesTable)
          .set({ holeResults: resolvedHoleResults, matchStatus: playoffStatus, updatedAt: new Date() })
          .where(eq(bracketMatchesTable.id, Number(matchId)));
        broadcastBracketUpdate(Number(tournamentId), { matchId: Number(matchId), playoff: { state: "playoff_in_progress", mode, nextHole: 19 } });
        res.status(409).json({
          error: "playoff_required",
          tieBreakRule,
          mode,
          nextHole: 19,
          matchStatus: playoffStatus,
        }); return;
      }
      // resolution.state === "halved" cannot occur here because tieBreakRule !== "none".
    }

    let winnerId: number | null = null;
    if (effectiveResult === "player1_wins") {
      winnerId = matchRow.player1Id;
    } else if (effectiveResult === "player2_wins") {
      winnerId = matchRow.player2Id;
    } else if (effectiveResult === "conceded") {
      // Conceded: the player who conceded loses — the other player wins
      if (concededByPlayerId) {
        winnerId = concededByPlayerId === matchRow.player1Id ? matchRow.player2Id : matchRow.player1Id;
      }
    }

    const [updatedMatch] = await db.update(bracketMatchesTable)
      .set({
        result: effectiveResult as typeof result,
        holeResults: resolvedHoleResults,
        matchStatus,
        winnerId,
        conceededByPlayerId: concededByPlayerId ?? null,
        conceededOnHole: concededOnHole ?? null,
        updatedAt: new Date(),
      })
      .where(eq(bracketMatchesTable.id, Number(matchId)))
      .returning();

    // Advance winner to next round (deterministic slot if known)
    if (winnerId && matchRow.nextMatchId) {
      const [nextMatch] = await db.select().from(bracketMatchesTable)
        .where(eq(bracketMatchesTable.id, matchRow.nextMatchId));
      if (nextMatch) {
        const targetSlot: "player1Id" | "player2Id" = matchRow.nextWinnerSlot === 2
          ? "player2Id"
          : matchRow.nextWinnerSlot === 1
            ? "player1Id"
            : (!nextMatch.player1Id ? "player1Id" : "player2Id");
        const occupiedBy = nextMatch[targetSlot];
        if (occupiedBy && occupiedBy !== winnerId) {
          logger.warn({ nextMatchId: nextMatch.id, targetSlot, occupiedBy, winnerId },
            "Bracket advancement: target slot already filled — refusing to overwrite");
        } else {
          await db.update(bracketMatchesTable)
            .set({ [targetSlot]: winnerId, updatedAt: new Date() })
            .where(eq(bracketMatchesTable.id, matchRow.nextMatchId));
        }
      }
    }

    // Advance loser to LB (double-elim) via nextLoserMatchId — deterministic slot if known
    if (matchRow.bracketType === "main" && matchRow.nextLoserMatchId && winnerId) {
      const loserId = winnerId === matchRow.player1Id ? matchRow.player2Id : matchRow.player1Id;
      if (loserId) {
        const [lbMatch] = await db.select().from(bracketMatchesTable)
          .where(eq(bracketMatchesTable.id, matchRow.nextLoserMatchId));
        if (lbMatch) {
          const targetSlot: "player1Id" | "player2Id" = matchRow.nextLoserSlot === 2
            ? "player2Id"
            : matchRow.nextLoserSlot === 1
              ? "player1Id"
              : (!lbMatch.player1Id ? "player1Id" : "player2Id");
          const occupiedBy = lbMatch[targetSlot];
          if (occupiedBy && occupiedBy !== loserId) {
            logger.warn({ nextLoserMatchId: lbMatch.id, targetSlot, occupiedBy, loserId },
              "Bracket loser routing: target slot already filled — refusing to overwrite");
          } else {
            await db.update(bracketMatchesTable)
              .set({ [targetSlot]: loserId, updatedAt: new Date() })
              .where(eq(bracketMatchesTable.id, matchRow.nextLoserMatchId));
          }
        }
      }
    }

    // Advance loser to consolation bracket if applicable. Use winnerId (which already
    // reflects the playoff-coerced effectiveResult) so playoff outcomes route the loser
    // correctly rather than relying on the original `result` value.
    if (matchRow.bracketType === "main" && bracketRow.hasConsolation && bracketRow.format === "single_elim" && winnerId) {
      const loserId = winnerId === matchRow.player1Id ? matchRow.player2Id : matchRow.player1Id;
      if (loserId) {
        const [consolationRound] = await db.select().from(bracketRoundsTable)
          .where(and(
            eq(bracketRoundsTable.bracketId, matchRow.bracketId),
            eq(bracketRoundsTable.bracketType, "consolation"),
            eq(bracketRoundsTable.roundNumber, 1),
          ));
        if (consolationRound) {
          const [consolationMatch] = await db.select().from(bracketMatchesTable)
            .where(and(
              eq(bracketMatchesTable.roundId, consolationRound.id),
              eq(bracketMatchesTable.matchNumber, matchRow.matchNumber),
            ));
          if (consolationMatch) {
            // Fill whichever slot is empty
            if (!consolationMatch.player1Id) {
              await db.update(bracketMatchesTable)
                .set({ player1Id: loserId, updatedAt: new Date() })
                .where(eq(bracketMatchesTable.id, consolationMatch.id));
            } else if (!consolationMatch.player2Id) {
              await db.update(bracketMatchesTable)
                .set({ player2Id: loserId, updatedAt: new Date() })
                .where(eq(bracketMatchesTable.id, consolationMatch.id));
            }
          }
        }
      }
    }

    // Round-robin: after recording any RR match result, see whether the
    // bracket can now be marked complete (or whether a tie-break round needs
    // to be created for a top-spot tie).
    let rrFinalize: { championId: number | null; runnerUpId: number | null; tieBreakRoundCreated: boolean; tieBreakMatchId: number | null } | null = null;
    if (bracketRow.format === "round_robin") {
      rrFinalize = await maybeFinalizeRoundRobin(bracketRow.id, bracketRow.tournamentId, (bracketRow.tieBreakRule ?? "sudden_death") as TieBreakRule);
    }

    notifyLeaderboardUpdate(Number(tournamentId), {});
    broadcastBracketUpdate(Number(tournamentId), { matchId: Number(matchId), result: updatedMatch, rrFinalize });

    // Task #2008 — branded `match.result.recorded` dispatch to both players
    // of the bracket match. Each player gets the result alongside their
    // opponent's name so the email + digest render is meaningful even when
    // viewed days after the match was played.
    try {
      const sides: Array<{ playerId: number | null; opponentId: number | null }> = [
        { playerId: matchRow.player1Id, opponentId: matchRow.player2Id },
        { playerId: matchRow.player2Id, opponentId: matchRow.player1Id },
      ];
      const playerIdsToLoad = sides
        .flatMap(s => [s.playerId, s.opponentId])
        .filter((id): id is number => typeof id === "number" && id > 0);
      if (playerIdsToLoad.length > 0) {
        const playerRows = await db.select({
          id: playersTable.id,
          userId: playersTable.userId,
          firstName: playersTable.firstName,
          lastName: playersTable.lastName,
        }).from(playersTable).where(inArray(playersTable.id, Array.from(new Set(playerIdsToLoad))));
        const byId = new Map(playerRows.map(p => [p.id, p]));
        const { notifyMatchResultRecorded } = await import("../lib/brandedNotifications.js");
        for (const side of sides) {
          if (!side.playerId) continue;
          const me = byId.get(side.playerId);
          if (!me?.userId) continue;
          const opp = side.opponentId ? byId.get(side.opponentId) : undefined;
          const opponentName = opp ? `${opp.firstName} ${opp.lastName}`.trim() : undefined;
          void notifyMatchResultRecorded({
            userIds: [me.userId],
            matchId: Number(matchId),
            opponentName,
            result: typeof effectiveResult === "string" ? effectiveResult : undefined,
          });
        }
      }
    } catch (err) {
      logger.warn({ err, matchId }, "[match-play] branded match.result notify failed (non-fatal)");
    }

    res.json({ match: updatedMatch, rrFinalize });
  } catch (err) {
    logger.error({ err }, "Failed to record match result");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /organizations/:orgId/tournaments/:tournamentId/bracket/matches/:matchId/hole
// Record individual hole result for a bracket match (live scoring)
router.post("/bracket/matches/:matchId/hole", async (req: Request, res: Response) => {
  const { orgId, tournamentId, matchId } = (req.params as Record<string, string>);
  if (!await requireTournamentAccess(req, res, Number(orgId), Number(tournamentId))) return;
  const { holeNumber, holeResult } = req.body as { holeNumber: number; holeResult: "player1" | "player2" | "halved" };
  try {
    const [matchRow] = await db.select().from(bracketMatchesTable)
      .where(eq(bracketMatchesTable.id, Number(matchId)));
    if (!matchRow) { res.status(404).json({ error: "Match not found" }); return; }

    // Verify match belongs to this tournament
    const [bracketRow] = await db.select({
      id: matchPlayBracketTable.id,
      format: matchPlayBracketTable.format,
      tieBreakRule: matchPlayBracketTable.tieBreakRule,
    })
      .from(matchPlayBracketTable)
      .where(and(
        eq(matchPlayBracketTable.id, matchRow.bracketId),
        eq(matchPlayBracketTable.tournamentId, Number(tournamentId)),
      ));
    if (!bracketRow) { res.status(403).json({ error: "Match does not belong to this tournament" }); return; }

    const holeResults = { ...(matchRow.holeResults as Record<number, HoleOwner> ?? {}), [holeNumber]: holeResult };
    let matchStatus = computeMatchStatus(holeResults);

    // If we're past hole 18 on a knockout bracket with a tie-break rule, surface playoff status.
    const tieBreakRule = (bracketRow.tieBreakRule ?? "sudden_death") as TieBreakRule;
    if (holeNumber > 18 && isKnockoutFormat(bracketRow.format ?? "single_elim") && tieBreakRule !== "none") {
      const resolution = resolvePlayoff(holeResults, tieBreakRule);
      if (resolution.state === "playoff_in_progress") {
        matchStatus = playoffStatusLabel(resolution.mode, resolution.nextHole);
      } else if (resolution.state === "p1_wins" || resolution.state === "p2_wins") {
        matchStatus = resolution.state === "p1_wins" ? "Player 1 wins (playoff)" : "Player 2 wins (playoff)";
      }
    }

    const [updated] = await db.update(bracketMatchesTable)
      .set({ holeResults, matchStatus, updatedAt: new Date() })
      .where(eq(bracketMatchesTable.id, Number(matchId)))
      .returning();

    notifyLeaderboardUpdate(Number(tournamentId), {});
    broadcastBracketUpdate(Number(tournamentId), { matchId: Number(matchId), holeResult: updated });
    res.json({ match: updated });
  } catch (err) {
    logger.error({ err }, "Failed to record hole result");
    res.status(500).json({ error: "Server error" });
  }
});

// ─── RYDER CUP ROUTES ───────────────────────────────────────────────────────

// GET /organizations/:orgId/tournaments/:tournamentId/ryder-cup
router.get("/ryder-cup", async (req: Request, res: Response) => {
  const { orgId, tournamentId } = (req.params as Record<string, string>);
  try {
    // Verify tournament belongs to this org
    const [tournament] = await db.select({ id: tournamentsTable.id })
      .from(tournamentsTable)
      .where(and(
        eq(tournamentsTable.id, Number(tournamentId)),
        eq(tournamentsTable.organizationId, Number(orgId)),
      ));
    if (!tournament) { res.status(404).json({ error: "Tournament not found" }); return; }

    const [config] = await db.select().from(ryderCupConfigTable)
      .where(eq(ryderCupConfigTable.tournamentId, Number(tournamentId)));

    const sessions = await db.select().from(ryderCupSessionsTable)
      .where(eq(ryderCupSessionsTable.tournamentId, Number(tournamentId)))
      .orderBy(asc(ryderCupSessionsTable.sessionNumber));

    const matches = await db.select().from(ryderCupMatchesTable)
      .where(eq(ryderCupMatchesTable.tournamentId, Number(tournamentId)))
      .orderBy(asc(ryderCupMatchesTable.sessionId), asc(ryderCupMatchesTable.matchNumber));

    // Fetch player info
    const playerList = await db.select({
      id: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      handicapIndex: playersTable.handicapIndex,
    }).from(playersTable)
      .where(eq(playersTable.tournamentId, Number(tournamentId)));

    const playerMap = new Map(playerList.map(p => [p.id, p]));

    const enrichedMatches = matches.map(m => ({
      ...m,
      team1Player1: m.team1Player1Id ? (playerMap.get(m.team1Player1Id) ?? null) : null,
      team1Player2: m.team1Player2Id ? (playerMap.get(m.team1Player2Id) ?? null) : null,
      team2Player1: m.team2Player1Id ? (playerMap.get(m.team2Player1Id) ?? null) : null,
      team2Player2: m.team2Player2Id ? (playerMap.get(m.team2Player2Id) ?? null) : null,
    }));

    // Compute running totals from match records
    let team1Total = 0, team2Total = 0;
    for (const m of matches) {
      team1Total += Number(m.team1Points);
      team2Total += Number(m.team2Points);
    }

    res.json({
      config: config ?? null,
      sessions,
      matches: enrichedMatches,
      runningTotals: { team1: team1Total, team2: team2Total },
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch Ryder Cup data");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /organizations/:orgId/tournaments/:tournamentId/ryder-cup/config
router.post("/ryder-cup/config", async (req: Request, res: Response) => {
  const { orgId, tournamentId } = (req.params as Record<string, string>);
  if (!await requireTournamentAccess(req, res, Number(orgId), Number(tournamentId))) return;
  const { team1Name, team2Name, team1Colour, team2Colour, totalPoints, tieBreakRule } = req.body;
  const allowedTieBreakRules = ["sudden_death", "extra_holes_3", "none"] as const;
  type RyderTieBreakRule = typeof allowedTieBreakRules[number];
  const normalizedTieBreakRule: RyderTieBreakRule | undefined =
    tieBreakRule === undefined || tieBreakRule === null
      ? undefined
      : (allowedTieBreakRules as readonly string[]).includes(tieBreakRule)
        ? (tieBreakRule as RyderTieBreakRule)
        : undefined;
  if (tieBreakRule !== undefined && tieBreakRule !== null && normalizedTieBreakRule === undefined) {
    res.status(400).json({ error: "Invalid tieBreakRule" }); return;
  }
  try {
    const existing = await db.select().from(ryderCupConfigTable)
      .where(eq(ryderCupConfigTable.tournamentId, Number(tournamentId)));
    let config;
    if (existing.length > 0) {
      [config] = await db.update(ryderCupConfigTable)
        .set({
          team1Name, team2Name, team1Colour, team2Colour, totalPoints,
          ...(normalizedTieBreakRule ? { tieBreakRule: normalizedTieBreakRule } : {}),
          shareToken: existing[0].shareToken ?? genShareToken(),
          updatedAt: new Date(),
        })
        .where(eq(ryderCupConfigTable.tournamentId, Number(tournamentId)))
        .returning();
    } else {
      [config] = await db.insert(ryderCupConfigTable)
        .values({
          tournamentId: Number(tournamentId),
          team1Name, team2Name, team1Colour, team2Colour, totalPoints,
          ...(normalizedTieBreakRule ? { tieBreakRule: normalizedTieBreakRule } : {}),
          shareToken: genShareToken(),
        })
        .returning();
    }
    res.json({ config });
  } catch (err) {
    logger.error({ err }, "Failed to save Ryder Cup config");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /organizations/:orgId/tournaments/:tournamentId/ryder-cup/sessions
router.post("/ryder-cup/sessions", async (req: Request, res: Response) => {
  const { orgId, tournamentId } = (req.params as Record<string, string>);
  if (!await requireTournamentAccess(req, res, Number(orgId), Number(tournamentId))) return;
  const { sessionType, name, scheduledDate } = req.body;

  try {
    const [config] = await db.select().from(ryderCupConfigTable)
      .where(eq(ryderCupConfigTable.tournamentId, Number(tournamentId)));
    if (!config) { res.status(400).json({ error: "Configure Ryder Cup teams first" }); return; }

    const existing = await db.select({ id: ryderCupSessionsTable.id, sessionNumber: ryderCupSessionsTable.sessionNumber })
      .from(ryderCupSessionsTable)
      .where(eq(ryderCupSessionsTable.tournamentId, Number(tournamentId)))
      .orderBy(asc(ryderCupSessionsTable.sessionNumber));

    const sessionNumber = (existing[existing.length - 1]?.sessionNumber ?? 0) + 1;

    const [session] = await db.insert(ryderCupSessionsTable)
      .values({
        tournamentId: Number(tournamentId),
        sessionNumber,
        sessionType,
        name,
        team1Name: config.team1Name,
        team2Name: config.team2Name,
        scheduledDate: scheduledDate ? new Date(scheduledDate) : null,
      })
      .returning();

    res.json({ session });
  } catch (err) {
    logger.error({ err }, "Failed to create Ryder Cup session");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /organizations/:orgId/tournaments/:tournamentId/ryder-cup/sessions/:sessionId/matches
router.post("/ryder-cup/sessions/:sessionId/matches", async (req: Request, res: Response) => {
  const { orgId, tournamentId, sessionId } = (req.params as Record<string, string>);
  if (!await requireTournamentAccess(req, res, Number(orgId), Number(tournamentId))) return;
  const { team1Player1Id, team1Player2Id, team2Player1Id, team2Player2Id } = req.body;
  try {
    // Verify session belongs to this tournament
    const [session] = await db.select().from(ryderCupSessionsTable)
      .where(and(
        eq(ryderCupSessionsTable.id, Number(sessionId)),
        eq(ryderCupSessionsTable.tournamentId, Number(tournamentId)),
      ));
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }

    const existing = await db.select({ matchNumber: ryderCupMatchesTable.matchNumber })
      .from(ryderCupMatchesTable)
      .where(eq(ryderCupMatchesTable.sessionId, Number(sessionId)))
      .orderBy(asc(ryderCupMatchesTable.matchNumber));
    const matchNumber = (existing[existing.length - 1]?.matchNumber ?? 0) + 1;

    const [newMatch] = await db.insert(ryderCupMatchesTable)
      .values({
        sessionId: Number(sessionId),
        tournamentId: Number(tournamentId),
        matchNumber,
        team1Player1Id: team1Player1Id ?? null,
        team1Player2Id: team1Player2Id ?? null,
        team2Player1Id: team2Player1Id ?? null,
        team2Player2Id: team2Player2Id ?? null,
        result: "pending",
        team1Points: "0",
        team2Points: "0",
        holeResults: {},
      })
      .returning();

    res.json({ match: newMatch });
  } catch (err) {
    logger.error({ err }, "Failed to create Ryder Cup match");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /organizations/:orgId/tournaments/:tournamentId/ryder-cup/matches/:matchId/result
router.post("/ryder-cup/matches/:matchId/result", async (req: Request, res: Response) => {
  const { orgId, tournamentId, matchId } = (req.params as Record<string, string>);
  if (!await requireTournamentAccess(req, res, Number(orgId), Number(tournamentId))) return;
  const { result, holeResults, concededByTeam, concededOnHole } = req.body;
  try {
    // Verify match belongs to this tournament
    const [matchRow] = await db.select().from(ryderCupMatchesTable)
      .where(and(
        eq(ryderCupMatchesTable.id, Number(matchId)),
        eq(ryderCupMatchesTable.tournamentId, Number(tournamentId)),
      ));
    if (!matchRow) { res.status(404).json({ error: "Match not found" }); return; }

    const resolvedHoleResults = holeResults ?? matchRow.holeResults ?? {};
    const matchStatus = computeRyderMatchStatus(resolvedHoleResults as Record<number, HoleOwnerTeam>);

    let team1Points = "0", team2Points = "0";
    if (result === "player1_wins") {
      team1Points = "1"; team2Points = "0";
    } else if (result === "player2_wins") {
      team1Points = "0"; team2Points = "1";
    } else if (result === "halved") {
      team1Points = "0.5"; team2Points = "0.5";
    } else if (result === "conceded" && concededByTeam) {
      // The team that conceded loses, the other team wins the point
      if (concededByTeam === "team1") { team1Points = "0"; team2Points = "1"; }
      else if (concededByTeam === "team2") { team1Points = "1"; team2Points = "0"; }
    }

    const [updatedMatch] = await db.update(ryderCupMatchesTable)
      .set({
        result,
        holeResults: resolvedHoleResults,
        matchStatus,
        team1Points,
        team2Points,
        conceededByTeam: concededByTeam ?? null,
        conceededOnHole: concededOnHole ?? null,
        updatedAt: new Date(),
      })
      .where(eq(ryderCupMatchesTable.id, Number(matchId)))
      .returning();

    // Recompute totals from all matches in this tournament
    const allMatches = await db.select({ team1Points: ryderCupMatchesTable.team1Points, team2Points: ryderCupMatchesTable.team2Points })
      .from(ryderCupMatchesTable)
      .where(eq(ryderCupMatchesTable.tournamentId, Number(tournamentId)));
    const t1Total = allMatches.reduce((s, m) => s + Number(m.team1Points), 0);
    const t2Total = allMatches.reduce((s, m) => s + Number(m.team2Points), 0);
    await db.update(ryderCupConfigTable)
      .set({ team1TotalPoints: String(t1Total), team2TotalPoints: String(t2Total), updatedAt: new Date() })
      .where(eq(ryderCupConfigTable.tournamentId, Number(tournamentId)));

    notifyLeaderboardUpdate(Number(tournamentId), {});
    broadcastRyderCupUpdate(Number(tournamentId), { matchId: Number(matchId), result: updatedMatch, runningTotals: { team1: t1Total, team2: t2Total } });
    res.json({ match: updatedMatch, runningTotals: { team1: t1Total, team2: t2Total } });
  } catch (err) {
    logger.error({ err }, "Failed to record Ryder Cup match result");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /organizations/:orgId/tournaments/:tournamentId/ryder-cup/matches/:matchId/hole
// Record individual hole result for a Ryder Cup match (live scoring)
router.post("/ryder-cup/matches/:matchId/hole", async (req: Request, res: Response) => {
  const { orgId, tournamentId, matchId } = (req.params as Record<string, string>);
  if (!await requireTournamentAccess(req, res, Number(orgId), Number(tournamentId))) return;
  const { holeNumber, holeResult } = req.body as { holeNumber: number; holeResult: "team1" | "team2" | "halved" };
  try {
    // Verify match belongs to this tournament
    const [matchRow] = await db.select().from(ryderCupMatchesTable)
      .where(and(
        eq(ryderCupMatchesTable.id, Number(matchId)),
        eq(ryderCupMatchesTable.tournamentId, Number(tournamentId)),
      ));
    if (!matchRow) { res.status(404).json({ error: "Match not found" }); return; }

    // Enforce the configured playoff rule for holes beyond regulation (>18).
    if (holeNumber > 18) {
      const [cfg] = await db.select({ tieBreakRule: ryderCupConfigTable.tieBreakRule })
        .from(ryderCupConfigTable)
        .where(eq(ryderCupConfigTable.tournamentId, Number(tournamentId)));
      const rule = (cfg?.tieBreakRule ?? "sudden_death") as "sudden_death" | "extra_holes_3" | "none";
      if (rule === "none") {
        res.status(400).json({ error: "Playoff holes are disabled for this Ryder Cup" }); return;
      }
      if (rule === "extra_holes_3" && holeNumber > 21) {
        res.status(400).json({ error: "3-hole aggregate playoff is capped at hole 21" }); return;
      }
    }

    const holeResults = { ...(matchRow.holeResults as Record<number, HoleOwnerTeam> ?? {}), [holeNumber]: holeResult };
    const matchStatus = computeRyderMatchStatus(holeResults);

    const [updated] = await db.update(ryderCupMatchesTable)
      .set({ holeResults, matchStatus, updatedAt: new Date() })
      .where(eq(ryderCupMatchesTable.id, Number(matchId)))
      .returning();

    notifyLeaderboardUpdate(Number(tournamentId), {});
    broadcastRyderCupUpdate(Number(tournamentId), { matchId: Number(matchId), holeResult: updated });
    res.json({ match: updated });
  } catch (err) {
    logger.error({ err }, "Failed to record Ryder Cup hole result");
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/ryder-cup/matches/:matchId
router.delete("/ryder-cup/matches/:matchId", async (req: Request, res: Response) => {
  const { orgId, tournamentId, matchId } = (req.params as Record<string, string>);
  if (!await requireTournamentAccess(req, res, Number(orgId), Number(tournamentId))) return;
  try {
    // Verify match belongs to this tournament before deleting
    const [matchRow] = await db.select({ id: ryderCupMatchesTable.id })
      .from(ryderCupMatchesTable)
      .where(and(
        eq(ryderCupMatchesTable.id, Number(matchId)),
        eq(ryderCupMatchesTable.tournamentId, Number(tournamentId)),
      ));
    if (!matchRow) { res.status(404).json({ error: "Match not found" }); return; }
    await db.delete(ryderCupMatchesTable).where(eq(ryderCupMatchesTable.id, Number(matchId)));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete Ryder Cup match");
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /organizations/:orgId/tournaments/:tournamentId/ryder-cup/sessions/:sessionId
router.delete("/ryder-cup/sessions/:sessionId", async (req: Request, res: Response) => {
  const { orgId, tournamentId, sessionId } = (req.params as Record<string, string>);
  if (!await requireTournamentAccess(req, res, Number(orgId), Number(tournamentId))) return;
  try {
    // Verify session belongs to this tournament before deleting
    const [sessionRow] = await db.select({ id: ryderCupSessionsTable.id })
      .from(ryderCupSessionsTable)
      .where(and(
        eq(ryderCupSessionsTable.id, Number(sessionId)),
        eq(ryderCupSessionsTable.tournamentId, Number(tournamentId)),
      ));
    if (!sessionRow) { res.status(404).json({ error: "Session not found" }); return; }
    await db.delete(ryderCupMatchesTable).where(eq(ryderCupMatchesTable.sessionId, Number(sessionId)));
    await db.delete(ryderCupSessionsTable).where(eq(ryderCupSessionsTable.id, Number(sessionId)));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete Ryder Cup session");
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
