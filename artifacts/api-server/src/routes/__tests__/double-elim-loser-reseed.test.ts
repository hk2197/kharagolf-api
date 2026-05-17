/**
 * Task #732 — Lock in the WB-loser → LB-minor reseed mapping for the
 * double-elimination bracket engine (introduced by Task #571).
 *
 * The mapping itself lives in `lib/double-elim-routing.ts` and is consumed by
 * `routes/match-play.ts` when wiring `nextLoserMatchId` for WB R(L+1) losers.
 *
 * These tests:
 *   1. Pin the documented per-level mapping table for bracket sizes 4, 8, 16
 *      and 32: WB R(L+1) match k loser → LB R(2L) match (mCount - k + 1),
 *      slot 2.
 *   2. Verify the structural anti-rematch property at WB-feed level 1 (the
 *      level the reseed was designed to fix): for every WB R2 match k, the
 *      set of seed slot positions that feed that match is disjoint from the
 *      set of seed slot positions that could end up at slot 1 of the LB R2
 *      minor match the loser drops into. Without the reseed, those sets
 *      overlap entirely (the WB R2 loser lands opposite the LB cons winner
 *      from their own WB R2 sub-bracket — i.e. their WB R1 opponent).
 *
 *      At higher WB-feed levels (L ≥ 2) the LB cons winner can have travelled
 *      through enough rounds that their identity set spans the whole bracket,
 *      so a multi-step (non-immediate) rematch remains structurally possible
 *      by design — these tests only pin the per-level *mapping table*, not a
 *      global no-rematch guarantee.
 *
 * The tests are pure (no DB) — they exercise the routing helper directly and
 * model the rest of the bracket structurally.
 */
import { describe, it, expect } from "vitest";
import {
  lbMinorMatchCount,
  wbLoserLbRoundNumber,
  wbLoserToLbMinorMatchNumber,
} from "../../lib/double-elim-routing";

const BRACKET_SIZES = [4, 8, 16, 32] as const;

// ─── Structural model helpers ────────────────────────────────────────────────

/**
 * Returns the set of original seed slot positions (0-indexed within the
 * size-`slotCount` WB R1 layout) that feed WB round `wbRound` match
 * `wbMatchNumber` (1-indexed).
 *
 * WB R r match k consumes a contiguous block of 2^r seed slots starting at
 * (k-1) * 2^r.
 */
function wbMatchSlotRange(wbRound: number, wbMatchNumber: number): Set<number> {
  const blockSize = Math.pow(2, wbRound);
  const start = (wbMatchNumber - 1) * blockSize;
  const out = new Set<number>();
  for (let i = 0; i < blockSize; i++) out.add(start + i);
  return out;
}

/**
 * Set of original seed slot positions that could possibly occupy a given slot
 * of an LB minor match at WB-feed level `L`, match `m` (1-indexed), in a
 * `slotCount`-slot bracket.
 *
 *   slot 2: the freshly-dropped WB R(L+1) loser from match
 *           k = (mCount - m + 1).
 *   slot 1: the LB cons winner from LB R(2L-1) cons match m, which in turn
 *           is reachable from earlier-level LB minor matches.
 */
function possibleAtMinor(
  level: number,
  m: number,
  slot: 1 | 2,
  slotCount: number,
): Set<number> {
  if (slot === 2) {
    const mCount = lbMinorMatchCount(level, slotCount);
    const k = mCount - m + 1;
    return wbMatchSlotRange(level + 1, k);
  }
  return possibleAtCons(level, m, slotCount);
}

/**
 * Set of original seed slot positions that could possibly occupy *either*
 * slot of LB R(2L-1) cons match `m`.
 *
 *   L = 1: WB R1 losers from matches (2m-1) and (2m).
 *   L > 1: union of both slots of LB R(2(L-1)) minor matches (2m-1) and (2m)
 *          (i.e. the previous-level minor winners that feed this cons match).
 */
function possibleAtCons(
  level: number,
  m: number,
  slotCount: number,
): Set<number> {
  if (level === 1) {
    return new Set([
      ...wbMatchSlotRange(1, 2 * m - 1),
      ...wbMatchSlotRange(1, 2 * m),
    ]);
  }
  const prev = level - 1;
  const out = new Set<number>();
  for (const j of [2 * m - 1, 2 * m]) {
    for (const s of possibleAtMinor(prev, j, 1, slotCount)) out.add(s);
    for (const s of possibleAtMinor(prev, j, 2, slotCount)) out.add(s);
  }
  return out;
}

function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

function lbLevelsFor(slotCount: number): number {
  return Math.log2(slotCount) - 1;
}

// ─── Sanity checks on the structural model itself ───────────────────────────

describe("structural model sanity", () => {
  for (const slotCount of BRACKET_SIZES) {
    const lbLevels = lbLevelsFor(slotCount);
    it(`slotCount=${slotCount}: cons match source sets are non-empty and within bounds`, () => {
      for (let level = 1; level <= lbLevels; level++) {
        const mCount = lbMinorMatchCount(level, slotCount);
        for (let m = 1; m <= mCount; m++) {
          const sources = possibleAtCons(level, m, slotCount);
          expect(sources.size).toBeGreaterThan(0);
          expect(sources.size).toBeLessThanOrEqual(slotCount);
          for (const s of sources) {
            expect(s).toBeGreaterThanOrEqual(0);
            expect(s).toBeLessThan(slotCount);
          }
        }
      }
    });

    it(`slotCount=${slotCount}: level-1 cons match feeds exactly 4 WB R1 seed slots`, () => {
      // Direct check on the base case the reseed actually targets.
      const mCount = lbMinorMatchCount(1, slotCount);
      for (let m = 1; m <= mCount; m++) {
        const sources = possibleAtCons(1, m, slotCount);
        expect(sources.size).toBe(4);
      }
    });
  }
});

// ─── Documented per-level mapping ───────────────────────────────────────────

describe("WB-loser → LB-minor mapping (m = mCount - k + 1)", () => {
  for (const slotCount of BRACKET_SIZES) {
    const lbLevels = lbLevelsFor(slotCount);

    it(`slotCount=${slotCount}: mapping matches the documented formula at every level`, () => {
      for (let level = 1; level <= lbLevels; level++) {
        const mCount = lbMinorMatchCount(level, slotCount);
        for (let k = 1; k <= mCount; k++) {
          const m = wbLoserToLbMinorMatchNumber(level, k, slotCount);
          expect(m).toBe(mCount - k + 1);
          expect(m).toBeGreaterThanOrEqual(1);
          expect(m).toBeLessThanOrEqual(mCount);
        }
      }
    });

    it(`slotCount=${slotCount}: mapping is a permutation (bijection k ↔ m)`, () => {
      for (let level = 1; level <= lbLevels; level++) {
        const mCount = lbMinorMatchCount(level, slotCount);
        const targets = new Set<number>();
        for (let k = 1; k <= mCount; k++) {
          targets.add(wbLoserToLbMinorMatchNumber(level, k, slotCount));
        }
        expect(targets.size).toBe(mCount);
      }
    });

    it(`slotCount=${slotCount}: WB-feed level L uses LB round 2L (alternating cons/minor)`, () => {
      for (let level = 1; level <= lbLevels; level++) {
        expect(wbLoserLbRoundNumber(level)).toBe(2 * level);
      }
    });
  }

  // Spot-check explicit mappings on the 8-player bracket so the table stays
  // human-readable in source.
  it("8-player bracket: per-level table matches the documented values", () => {
    // Level 1: WB R2 has 2 matches, LB R2 has 2 minor matches. Expect 1↔2.
    expect(wbLoserToLbMinorMatchNumber(1, 1, 8)).toBe(2);
    expect(wbLoserToLbMinorMatchNumber(1, 2, 8)).toBe(1);
    // Level 2: WB R3 (final) has 1 match, LB R4 has 1 minor match. 1→1.
    expect(wbLoserToLbMinorMatchNumber(2, 1, 8)).toBe(1);
  });

  it("16-player bracket: level 1 reverses 4 matches, level 2 reverses 2", () => {
    for (const k of [1, 2, 3, 4]) {
      expect(wbLoserToLbMinorMatchNumber(1, k, 16)).toBe(5 - k);
    }
    for (const k of [1, 2]) {
      expect(wbLoserToLbMinorMatchNumber(2, k, 16)).toBe(3 - k);
    }
    expect(wbLoserToLbMinorMatchNumber(3, 1, 16)).toBe(1);
  });
});

// ─── Structural anti-rematch guarantee ──────────────────────────────────────

describe("no immediate rematch is structurally possible (WB-feed level 1)", () => {
  // slotCount=4 is degenerate at level 1 (only 1 LB cons match, so the WB R2
  // loser can only ever drop opposite their own WB R1 sub-bracket). The reseed
  // is meaningful starting at slotCount=8.
  for (const slotCount of [8, 16, 32] as const) {
    it(`slotCount=${slotCount}: WB R2 loser never lands opposite a same-section cons winner`, () => {
      const level = 1;
      const mCount = lbMinorMatchCount(level, slotCount);
      for (let k = 1; k <= mCount; k++) {
        const wbSection = wbMatchSlotRange(level + 1, k);
        const target = wbLoserToLbMinorMatchNumber(level, k, slotCount);
        const slot1Sources = possibleAtMinor(level, target, 1, slotCount);
        const overlap = intersect(wbSection, slot1Sources);
        expect(
          overlap.size,
          `slotCount=${slotCount} WB R2 match ${k} → LB R2 match ${target}: ` +
            `overlap=${[...overlap].join(",")}`,
        ).toBe(0);
      }
    });

    it(`slotCount=${slotCount}: WITHOUT the reseed (k → k), an immediate rematch IS possible (sanity)`, () => {
      // Direct mapping is what the engine did before Task #571. Verify the
      // anti-rematch test above is non-trivial: with k → k, at least one
      // WB R2 match's section overlaps slot-1 of LB R2 minor match k.
      const level = 1;
      const mCount = lbMinorMatchCount(level, slotCount);
      let foundCollision = false;
      for (let k = 1; k <= mCount; k++) {
        const wbSection = wbMatchSlotRange(level + 1, k);
        const slot1Sources = possibleAtMinor(level, k, 1, slotCount);
        if (intersect(wbSection, slot1Sources).size > 0) {
          foundCollision = true;
          break;
        }
      }
      expect(foundCollision).toBe(true);
    });
  }

  it("slotCount=4 is degenerate (only 1 LB cons match — rematch unavoidable structurally)", () => {
    // slotCount=4 has just 1 WB R2 match and 1 LB R2 minor match, so the
    // mapping is the identity 1 → 1 and the structural overlap is total.
    // Documented here so a future engine change for n=4 doesn't silently break.
    expect(wbLoserToLbMinorMatchNumber(1, 1, 4)).toBe(1);
    const overlap = intersect(
      wbMatchSlotRange(2, 1),
      possibleAtMinor(1, 1, 1, 4),
    );
    expect(overlap.size).toBe(4);
  });
});
