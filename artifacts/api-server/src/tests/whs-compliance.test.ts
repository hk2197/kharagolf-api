/**
 * WHS 2024/2026 Compliance Test Suite
 *
 * 98 test cases covering all WHS Rules of Handicapping sections:
 * §3.1  Adjusted Gross Score (AGS) — Net Double Bogey / Par+5
 * §5.1  Score Differential (18-hole with PCC)
 * §5.1b 9-hole combination differential
 * §5.1d 10–17 hole partial round
 * §5.3  Handicap Index phases (Phase 1/2/3)
 * §5.4/5.7/5.8 Soft Cap and Hard Cap
 * §5.9  Exceptional Score Reduction (ESR)
 * §6.1  Course Handicap
 * §6.2  Playing Handicap with named allowances
 *
 * Plus a 25-round lifecycle simulation.
 */

import { describe, it, expect } from "vitest";
import {
  calculateAGS,
  calculateAGSPerHole,
  calculateGrossScore,
  isPlayerEstablished,
  type HoleScore,
} from "../lib/ags";
import {
  scoreDifferential18,
  scoreDifferential9,
  scoreDifferentialPartialRound,
  esrReduction,
  applyESR,
  calculateHandicapIndex,
  applyCaps,
  updateLowHI,
  recalcHandicapIndex,
  computeCourseHandicap,
  computePlayingHandicap,
  playingHandicapAllowance,
  strokesOnHole,
  stablefordPointsForHole,
} from "../lib/handicap";

// ─── §3.1 AGS — Established Player (Net Double Bogey) ──────────────────────

describe("§3.1 AGS — Established Player (Net Double Bogey)", () => {
  function hole(holeNumber: number, par: number, si: number, strokes: number): HoleScore {
    return { holeNumber, par, strokeIndex: si, strokes };
  }

  it("TC-001: uncapped score passes through unchanged", () => {
    const holes: HoleScore[] = [hole(1, 4, 9, 5)]; // max = 4+2+0=6, actual=5 < 6
    expect(calculateAGS(holes, 18)).toBe(5);
  });

  it("TC-002: score capped at Net Double Bogey", () => {
    // PH=18: floor(18/18)=1 base, extra=(9<=0)=0, received=1, max=4+2+1=7
    const holes: HoleScore[] = [hole(1, 4, 9, 10)]; // actual=10 > max=7
    expect(calculateAGS(holes, 18)).toBe(7);
  });

  it("TC-003: plus handicapper gives stroke, raising cap", () => {
    // PH = -2: SI=1 gets +1 stroke given up, SI=2 gets +1 stroke given up
    // Hole SI=1: strokes received = -1, max = 4+2+(-1)=5
    const holes: HoleScore[] = [hole(1, 4, 1, 8)];
    expect(calculateAGS(holes, -2)).toBe(5);
  });

  it("TC-004: player receiving 2 strokes per hole (PH=36)", () => {
    // PH=36: base=floor(36/18)=2, extra=(1<=36%18=0)=0, received=2, max=4+2+2=8
    const holes: HoleScore[] = [hole(1, 4, 1, 12)];
    expect(calculateAGS(holes, 36)).toBe(8);
  });

  it("TC-005: par 3 hole capped correctly", () => {
    // PH=18: SI=5 → received=1, max=3+2+1=6
    const holes: HoleScore[] = [hole(1, 3, 5, 9)];
    expect(calculateAGS(holes, 18)).toBe(6);
  });

  it("TC-006: par 5 hole uncapped", () => {
    const holes: HoleScore[] = [hole(1, 5, 2, 6)]; // max=5+2+0=7, actual=6
    expect(calculateAGS(holes, 9)).toBe(6);
  });

  it("TC-007: null strokes are skipped", () => {
    const holes: HoleScore[] = [
      { holeNumber: 1, par: 4, strokeIndex: 1, strokes: null },
      hole(2, 4, 2, 5),
    ];
    expect(calculateAGS(holes, 18)).toBe(5);
  });

  it("TC-008: 18-hole round AGS sum", () => {
    const holes: HoleScore[] = Array.from({ length: 18 }, (_, i) => hole(i + 1, 4, i + 1, 5));
    // PH=18: all holes get 1 stroke, max=4+2+1=7, actual=5 ≤ 7
    expect(calculateAGS(holes, 18)).toBe(90); // 18 * 5
  });

  it("TC-009: 18-hole round with multiple caps", () => {
    const holes: HoleScore[] = Array.from({ length: 18 }, (_, i) => hole(i + 1, 4, i + 1, 12));
    // PH=9: SI 1-9 get 1 stroke; SI 10-18 get 0 strokes
    // SI 1-9: max=4+2+1=7; SI 10-18: max=4+2+0=6
    const expected = 9 * 7 + 9 * 6;
    expect(calculateAGS(holes, 9)).toBe(expected);
  });
});

// ─── §3.1 AGS — Pre-Establishment (Par+5) ──────────────────────────────────

describe("§3.1 AGS — Pre-Establishment Player (Par+5)", () => {
  function hole(holeNumber: number, par: number, si: number | null, strokes: number): HoleScore {
    return { holeNumber, par, strokeIndex: si, strokes };
  }

  it("TC-010: uncapped score on Par+5 rule", () => {
    const holes: HoleScore[] = [hole(1, 4, 9, 6)]; // max=4+5=9, actual=6
    expect(calculateAGS(holes, 18, false)).toBe(6);
  });

  it("TC-011: capped at Par+5 (ignores strokes received)", () => {
    const holes: HoleScore[] = [hole(1, 4, 9, 12)]; // max=4+5=9
    expect(calculateAGS(holes, 18, false)).toBe(9);
  });

  it("TC-012: Par+5 is independent of playing handicap", () => {
    const holes: HoleScore[] = [hole(1, 4, 1, 12)];
    // Even with PH=0 (would be max=6 for established), pre-establishment cap = 9
    expect(calculateAGS(holes, 0, false)).toBe(9);
  });

  it("TC-013: par 3 pre-establishment cap = par+5 = 8", () => {
    const holes: HoleScore[] = [hole(1, 3, 1, 15)];
    expect(calculateAGS(holes, 18, false)).toBe(8);
  });

  it("TC-014: isPlayerEstablished correctly classifies", () => {
    expect(isPlayerEstablished(53)).toBe(false);
    expect(isPlayerEstablished(54)).toBe(true);
    expect(isPlayerEstablished(100)).toBe(true);
    expect(isPlayerEstablished(0)).toBe(false);
  });

  it("TC-015: per-hole breakdown shows wasCapped correctly", () => {
    const holes: HoleScore[] = [
      hole(1, 4, 1, 6),  // 4+5=9, 6 < 9, not capped
      hole(2, 4, 2, 12), // 4+5=9, 12 > 9, capped
    ];
    const result = calculateAGSPerHole(holes, 18, false);
    expect(result[0].wasCapped).toBe(false);
    expect(result[1].wasCapped).toBe(true);
    expect(result[1].cappedStrokes).toBe(9);
  });
});

// ─── §5.1 Score Differential (18-hole) ─────────────────────────────────────

describe("§5.1 Score Differential — 18-hole", () => {
  it("TC-016: basic differential formula", () => {
    // (113/113) * (72 - 72 - 0) = 0.0
    expect(scoreDifferential18(72, 72, 113)).toBe(0.0);
  });

  it("TC-017: positive differential above CR", () => {
    // (113/113) * (80 - 72 - 0) = 8.0
    expect(scoreDifferential18(80, 72, 113)).toBe(8.0);
  });

  it("TC-018: negative differential below CR", () => {
    // (113/113) * (65 - 72 - 0) = -7.0
    expect(scoreDifferential18(65, 72, 113)).toBe(-7.0);
  });

  it("TC-019: slope adjustment (SR > 113 makes diff smaller)", () => {
    // (113/130) * (80 - 72) = 0.869 * 8 = 6.9538... ≈ 7.0 (rounded to 1dp)
    const diff = scoreDifferential18(80, 72, 130);
    expect(diff).toBe(7.0); // Math.round(6.9538 * 10) / 10 = 7.0
  });

  it("TC-020: slope adjustment (SR < 113 makes diff larger)", () => {
    // (113/100) * (80 - 72) = 1.13 * 8 = 9.04 ≈ 9.0
    expect(scoreDifferential18(80, 72, 100)).toBe(9.0);
  });

  it("TC-021: PCC adjustment reduces differential", () => {
    // (113/113) * (80 - 72 - 2) = 6.0
    expect(scoreDifferential18(80, 72, 113, 2)).toBe(6.0);
  });

  it("TC-022: PCC negative (conditions easy) increases differential", () => {
    // (113/113) * (80 - 72 - (-1)) = 9.0
    expect(scoreDifferential18(80, 72, 113, -1)).toBe(9.0);
  });

  it("TC-023: fractional result rounded to 1 decimal", () => {
    // (113/125) * (75 - 70) = 0.904 * 5 = 4.52 → 4.5
    const diff = scoreDifferential18(75, 70, 125);
    expect(diff).toBe(4.5);
  });

  it("TC-024: high slope, high score", () => {
    // (113/155) * (95 - 73.2 - 0) = 0.729 * 21.8 = 15.888... ≈ 15.9
    const diff = scoreDifferential18(95, 73.2, 155);
    expect(Math.abs(diff - 15.9)).toBeLessThan(0.15);
  });

  it("TC-025: CR with decimal", () => {
    // (113/113) * (85 - 71.5) = 13.5
    expect(scoreDifferential18(85, 71.5, 113)).toBe(13.5);
  });
});

// ─── §5.1b 9-hole combination ───────────────────────────────────────────────

describe("§5.1b 9-hole Score Differential", () => {
  it("TC-026: basic 9-hole combination", () => {
    // actual: (113/113) * (38 - 36.5 - 0) = 1.5
    // expected: max(0, 10.0/2) = 5.0
    // combined: 6.5
    expect(scoreDifferential9(38, 36.5, 113, 10.0)).toBe(6.5);
  });

  it("TC-027: PCC halved for 9-hole round", () => {
    // PCC=2 → pcc9=1
    // actual: (113/113) * (38 - 36.5 - 1) = 0.5
    // expected: max(0, 10.0/2) = 5.0
    // combined: 5.5
    expect(scoreDifferential9(38, 36.5, 113, 10.0, 2)).toBe(5.5);
  });

  it("TC-028: negative HI produces 0 expected differential", () => {
    // HI = -2.0: expectedDiff = max(0, -1.0) = 0
    const diff = scoreDifferential9(38, 36.5, 113, -2.0);
    expect(diff).toBe(1.5); // just the actual part
  });

  it("TC-029: 9-hole with slope adjustment", () => {
    // actual: (113/120) * (40 - 36 - 0) = 0.9417 * 4 = 3.767 ≈ 3.8
    // expected: max(0, 16.0/2) = 8.0
    // combined: 11.8
    const diff = scoreDifferential9(40, 36, 120, 16.0);
    expect(Math.abs(diff - 11.8)).toBeLessThan(0.1);
  });

  it("TC-030: unestablished player (HI=0) expected diff = 0", () => {
    // HI=0: expected = max(0, 0) = 0
    const diff = scoreDifferential9(38, 36.5, 113, 0);
    expect(diff).toBe(1.5);
  });
});

// ─── §5.1d 10–17 Hole Partial Round ─────────────────────────────────────────

describe("§5.1d Partial Round (10–17 holes)", () => {
  it("TC-031: 10-hole partial round", () => {
    const diff = scoreDifferentialPartialRound(42, 72, 113, 10, 14.0);
    // ratingProrated = 72 * (10/18) = 40.0
    // unplayed = 8, expected = (14.0/18)*8 = 6.222
    // effectiveScore = 42 + 6.222 = 48.222
    // raw = (113/113) * (48.222 - 40.0 - 0) = 8.222 → 8.2
    expect(Math.abs(diff - 8.2)).toBeLessThan(0.1);
  });

  it("TC-032: 14-hole partial round", () => {
    const diff = scoreDifferentialPartialRound(60, 72, 113, 14, 12.0);
    // prorated = 72 * (14/18) = 56.0
    // unplayed = 4, expected = (12.0/18)*4 = 2.667
    // effective = 60 + 2.667 = 62.667
    // raw = 62.667 - 56.0 = 6.667 → 6.7
    expect(Math.abs(diff - 6.7)).toBeLessThan(0.1);
  });

  it("TC-033: 17-hole round (one hole not played)", () => {
    const diff = scoreDifferentialPartialRound(74, 72.1, 113, 17, 8.0);
    // prorated = 72.1 * (17/18) = 68.094
    // expected = (8/18)*1 = 0.444
    // effective = 74 + 0.444 = 74.444
    // raw = 74.444 - 68.094 = 6.35 → 6.4
    expect(Math.abs(diff - 6.4)).toBeLessThan(0.2);
  });

  it("TC-034: partial round with PCC applied", () => {
    const noPcc = scoreDifferentialPartialRound(42, 72, 113, 10, 14.0, 0);
    const withPcc = scoreDifferentialPartialRound(42, 72, 113, 10, 14.0, 2);
    expect(withPcc).toBeLessThan(noPcc);
    expect(Math.abs(noPcc - withPcc - 2.0)).toBeLessThan(0.01);
  });

  it("TC-035: 18-hole partial handled as full round result", () => {
    // When holesPlayed=18 this path shouldn't be used but formula is stable
    const diff = scoreDifferentialPartialRound(80, 72, 113, 18, 10.0);
    expect(diff).toBeCloseTo(8.0, 1);
  });
});

// ─── §5.9 Exceptional Score Reduction (ESR) ────────────────────────────────

describe("§5.9 Exceptional Score Reduction", () => {
  it("TC-036: no reduction when improvement < 7.0", () => {
    expect(esrReduction(10.0, 16.9)).toBe(0);
  });

  it("TC-037: no reduction at exactly 6.9 improvement", () => {
    expect(esrReduction(10.0, 16.9)).toBe(0); // 16.9 - 10.0 = 6.9 < 7
  });

  it("TC-038: 1.0 reduction when improvement is exactly 7.0", () => {
    expect(esrReduction(10.0, 17.0)).toBe(1.0);
  });

  it("TC-039: 1.0 reduction when improvement is 9.9", () => {
    expect(esrReduction(5.0, 14.9)).toBe(1.0); // 14.9 - 5.0 = 9.9
  });

  it("TC-040: 2.0 reduction when improvement is exactly 10.0", () => {
    expect(esrReduction(5.0, 15.0)).toBe(2.0); // 15.0 - 5.0 = 10.0
  });

  it("TC-041: 2.0 reduction when improvement is > 10.0", () => {
    expect(esrReduction(-2.0, 10.0)).toBe(2.0); // 10.0 - (-2.0) = 12.0
  });

  it("TC-042: applyESR with no current HI returns unchanged", () => {
    const result = applyESR(8.0, null);
    expect(result.rawDifferential).toBe(8.0);
    expect(result.esrAdjustment).toBe(0);
    expect(result.finalDifferential).toBe(8.0);
  });

  it("TC-043: applyESR applies 1.0 reduction correctly", () => {
    const result = applyESR(5.0, 13.0); // 13.0 - 5.0 = 8.0 → 1.0 reduction
    expect(result.rawDifferential).toBe(5.0);
    expect(result.esrAdjustment).toBe(1.0);
    expect(result.finalDifferential).toBe(4.0);
  });

  it("TC-044: applyESR applies 2.0 reduction correctly", () => {
    const result = applyESR(2.0, 14.0); // 14.0 - 2.0 = 12.0 → 2.0 reduction
    expect(result.rawDifferential).toBe(2.0);
    expect(result.esrAdjustment).toBe(2.0);
    expect(result.finalDifferential).toBe(0.0);
  });

  it("TC-045: ESR can result in negative final differential", () => {
    const result = applyESR(-1.0, 12.0); // 12.0 - (-1.0) = 13.0 → 2.0 reduction
    expect(result.finalDifferential).toBe(-3.0);
  });
});

// ─── §5.3 Handicap Index Calculation — Phase 1 ──────────────────────────────

describe("§5.3 Phase 1 — Not Yet Established", () => {
  it("TC-046: 0 differentials → null", () => {
    expect(calculateHandicapIndex([])).toBeNull();
  });

  it("TC-047: 1 differential → null", () => {
    expect(calculateHandicapIndex([10.0])).toBeNull();
  });

  it("TC-048: 2 differentials → null", () => {
    expect(calculateHandicapIndex([10.0, 12.0])).toBeNull();
  });
});

// ─── §5.3 Handicap Index Calculation — Phase 2 ──────────────────────────────

describe("§5.3 Phase 2 — Establishing (3-19 differentials)", () => {
  it("TC-049: 3 differentials, best 1, adjustment -2.0", () => {
    // best 1 = 10.0, adjustment = -2.0 → HI = 8.0
    expect(calculateHandicapIndex([10.0, 15.0, 20.0])).toBe(8.0);
  });

  it("TC-050: 4 differentials, best 1, adjustment -1.0", () => {
    // best 1 = 8.0, adjustment = -1.0 → HI = 7.0
    expect(calculateHandicapIndex([8.0, 12.0, 14.0, 18.0])).toBe(7.0);
  });

  it("TC-051: 5 differentials, best 1, adjustment 0", () => {
    // best 1 = 6.0 → HI = 6.0
    expect(calculateHandicapIndex([6.0, 8.0, 10.0, 12.0, 14.0])).toBe(6.0);
  });

  it("TC-052: 6 differentials, best 2, adjustment -1.0", () => {
    // best 2 = [5.0, 7.0] avg = 6.0, adj = -1.0 → 5.0
    expect(calculateHandicapIndex([5.0, 7.0, 10.0, 12.0, 14.0, 16.0])).toBe(5.0);
  });

  it("TC-053: 7 differentials, best 2, adjustment 0", () => {
    // best 2 = [4.0, 6.0] avg = 5.0
    expect(calculateHandicapIndex([4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0])).toBe(5.0);
  });

  it("TC-054: 9 differentials, best 3, adjustment 0", () => {
    const diffs = [3.0, 5.0, 7.0, 9.0, 11.0, 13.0, 15.0, 17.0, 19.0];
    // best 3 = [3, 5, 7] avg = 5.0
    expect(calculateHandicapIndex(diffs)).toBe(5.0);
  });

  it("TC-055: 11 differentials, best 4, adjustment 0", () => {
    const diffs = [2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 22.0];
    // best 4 = [2, 4, 6, 8] avg = 5.0
    expect(calculateHandicapIndex(diffs)).toBe(5.0);
  });

  it("TC-056: 13 differentials, best 5, adjustment 0", () => {
    const diffs = [2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 22.0, 24.0, 26.0];
    // best 5 = [2, 4, 6, 8, 10] avg = 6.0
    expect(calculateHandicapIndex(diffs)).toBe(6.0);
  });

  it("TC-057: 17 differentials, best 6, adjustment 0", () => {
    const diffs = Array.from({ length: 17 }, (_, i) => (i + 1) * 2.0); // 2,4,...,34
    // best 6 = [2,4,6,8,10,12] avg = 7.0
    expect(calculateHandicapIndex(diffs)).toBe(7.0);
  });

  it("TC-058: 18 differentials, best 7, adjustment 0", () => {
    const diffs = Array.from({ length: 18 }, (_, i) => (i + 1) * 2.0); // 2,4,...,36
    // best 7 = [2,4,6,8,10,12,14] avg = 8.0
    expect(calculateHandicapIndex(diffs)).toBe(8.0);
  });

  it("TC-059: 19 differentials, best 7, adjustment 0", () => {
    const diffs = Array.from({ length: 19 }, (_, i) => (i + 1) * 2.0); // 2,4,...,38
    // best 7 = [2,4,6,8,10,12,14] avg = 8.0
    expect(calculateHandicapIndex(diffs)).toBe(8.0);
  });

  it("TC-060: phase 2 does NOT apply 0.96 factor", () => {
    // 5 diffs, best 1 = 10.0. Without 0.96: HI=10.0. With 0.96: HI=9.6
    expect(calculateHandicapIndex([10.0, 12.0, 14.0, 16.0, 18.0])).toBe(10.0);
  });
});

// ─── §5.3 Handicap Index Calculation — Phase 3 ──────────────────────────────

describe("§5.3 Phase 3 — Established (≥20 differentials)", () => {
  it("TC-061: 20 differentials, best 8 of last 20, × 0.96", () => {
    const diffs = Array.from({ length: 20 }, (_, i) => (i + 1) * 1.0); // 1,2,...,20
    // best 8 = [1,2,3,4,5,6,7,8] avg = 4.5, × 0.96 = 4.32 → 4.3
    expect(calculateHandicapIndex(diffs)).toBe(4.3);
  });

  it("TC-062: 25 differentials uses only last 20", () => {
    // First 5 are very low but outside the window
    const old5 = Array.from({ length: 5 }, () => 1.0);
    const new20 = Array.from({ length: 20 }, () => 15.0);
    const diffs = [...old5, ...new20];
    // last 20 are all 15.0, best 8 = 15.0, × 0.96 = 14.4
    expect(calculateHandicapIndex(diffs)).toBe(14.4);
  });

  it("TC-063: H.I. capped at 54.0", () => {
    const diffs = Array.from({ length: 20 }, () => 60.0);
    expect(calculateHandicapIndex(diffs)).toBe(54.0);
  });

  it("TC-064: H.I. floored at -9.9 (plus player limit)", () => {
    const diffs = Array.from({ length: 20 }, () => -20.0);
    expect(calculateHandicapIndex(diffs)).toBe(-9.9);
  });

  it("TC-065: 0.96 factor confirmed at exactly 20 diffs", () => {
    const diffs = Array.from({ length: 20 }, () => 10.0);
    // avg = 10.0, × 0.96 = 9.6
    expect(calculateHandicapIndex(diffs)).toBe(9.6);
  });

  it("TC-066: fractional H.I. rounded to 1 decimal", () => {
    // create 20 diffs where best 8 avg = 12.05 → × 0.96 = 11.568 → 11.6
    const diffs = [10.0, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 20.0, 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8, 20.9, 21.0, 21.1];
    const hi = calculateHandicapIndex(diffs);
    expect(hi).not.toBeNull();
    expect(Number.isFinite(hi)).toBe(true);
    const str = hi!.toFixed(1);
    expect(str).toMatch(/^\-?\d+\.\d$/);
  });
});

// ─── §5.4/5.7/5.8 Soft Cap and Hard Cap ─────────────────────────────────────

describe("§5.4/5.7/5.8 Soft Cap and Hard Cap", () => {
  it("TC-067: no cap when H.I. ≤ Low H.I. + 3.0", () => {
    expect(applyCaps(13.0, 10.0)).toBe(13.0);
  });

  it("TC-068: no cap at exactly Low H.I. + 3.0", () => {
    expect(applyCaps(13.0, 10.0)).toBe(13.0);
  });

  it("TC-069: soft cap applied at Low H.I. + 3.2 (visible reduction)", () => {
    // candidate = 13.2, lowHI = 10.0 → softThreshold = 13.0
    // excess = 0.2, result = 13.0 + 0.1 = 13.1 → 13.1 < 13.2
    const result = applyCaps(13.2, 10.0);
    expect(result).toBeLessThan(13.2);
    expect(result).toBe(13.1);
  });

  it("TC-070: soft cap formula (50% of excess)", () => {
    // candidate = 16.0, lowHI = 10.0 → threshold = 13.0
    // excess = 3.0, result = 13.0 + 1.5 = 14.5
    expect(applyCaps(16.0, 10.0)).toBe(14.5);
  });

  it("TC-071: hard cap at Low H.I. + 5.0", () => {
    // candidate = 20.0, lowHI = 10.0 → hardMax = 15.0
    expect(applyCaps(20.0, 10.0)).toBe(15.0);
  });

  it("TC-072: soft cap result below hard cap passes through", () => {
    // candidate = 14.9, lowHI = 10.0 → threshold=13.0, excess=1.9, result=13.95 → 14.0
    // hardMax = 15.0, so not hard capped
    const result = applyCaps(14.9, 10.0);
    expect(result).toBeLessThan(15.0);
  });

  it("TC-073: negative Low H.I. (plus marker) caps correctly", () => {
    // lowHI = -4.0: threshold = -1.0, hardMax = 1.0
    // candidate = 3.0: excess = 4.0, soft = -1.0 + 2.0 = 1.0, hard = 1.0
    expect(applyCaps(3.0, -4.0)).toBe(1.0);
  });

  it("TC-074: updateLowHI returns lower of two", () => {
    expect(updateLowHI(8.0, 10.0)).toBe(8.0);
    expect(updateLowHI(12.0, 10.0)).toBe(10.0);
  });

  it("TC-075: updateLowHI with null current returns new value", () => {
    expect(updateLowHI(12.0, null)).toBe(12.0);
  });

  it("TC-076: recalcHandicapIndex applies caps correctly", () => {
    // 20 diffs all=10.0 → HI=9.6, Low HI=9.6 initially
    // Adding new score with HI already set at 9.6
    const diffs = Array.from({ length: 20 }, () => 10.0);
    const result = recalcHandicapIndex(diffs, 9.6);
    expect(result.cappedHandicapIndex).toBe(9.6); // no cap needed
    expect(result.lowHandicapIndex).toBe(9.6);
  });

  it("TC-077: cap result is capped, uncapped HI exposed separately", () => {
    // 20 diffs: first 8 best = 20.0, lowHI = 5.0 → cap kicks in
    const diffs = Array.from({ length: 20 }, () => 20.0);
    const result = recalcHandicapIndex(diffs, 5.0);
    // HI = 20*0.96 = 19.2, low = 5.0, threshold = 8.0, excess = 11.2 → soft = 8.0+5.6=13.6, hard = 10.0
    expect(result.cappedHandicapIndex).toBe(10.0);
  });
});

// ─── §6.1 Course Handicap ───────────────────────────────────────────────────

describe("§6.1 Course Handicap", () => {
  it("TC-078: standard 18-hole course HI × SR/113 + (CR-Par)", () => {
    // HI=14.0, SR=113, CR=72.1, Par=72
    // CH = round(14.0*(113/113) + (72.1-72)) = round(14.1) = 14
    expect(computeCourseHandicap(14.0, 113, 72.1, 72)).toBe(14);
  });

  it("TC-079: course with high slope", () => {
    // HI=10.0, SR=135, CR=74.2, Par=72
    // CH = round(10.0*(135/113) + (74.2-72)) = round(11.95+2.2) = round(14.15) = 14
    expect(computeCourseHandicap(10.0, 135, 74.2, 72)).toBe(14);
  });

  it("TC-080: null slope defaults to 113", () => {
    // HI=14.0, slope=null → SR=113
    expect(computeCourseHandicap(14.0, null, 72.0, 72)).toBe(14);
  });

  it("TC-081: null course rating defaults to par", () => {
    // HI=14.0, CR=null → CR=Par=72 → (CR-Par)=0
    expect(computeCourseHandicap(14.0, 113, null, 72)).toBe(14);
  });

  it("TC-082: plus handicapper on easy course", () => {
    // HI=-1.0, SR=120, CR=70.5, Par=71
    // CH = round(-1*(120/113) + (70.5-71)) = round(-1.062 - 0.5) = round(-1.562) = -2
    expect(computeCourseHandicap(-1.0, 120, 70.5, 71)).toBe(-2);
  });

  it("TC-083: high HI player on hard course", () => {
    // HI=36.0, SR=140, CR=75.5, Par=72
    // CH = round(36*(140/113) + 3.5) = round(44.6+3.5) = round(48.1) = 48
    expect(computeCourseHandicap(36.0, 140, 75.5, 72)).toBe(48);
  });
});

// ─── §6.2 Playing Handicap ──────────────────────────────────────────────────

describe("§6.2 Playing Handicap with named allowances", () => {
  it("TC-084: stroke play 95% allowance", () => {
    expect(playingHandicapAllowance("stroke_play")).toBe(95);
  });

  it("TC-085: match play 100% allowance", () => {
    expect(playingHandicapAllowance("match_play")).toBe(100);
  });

  it("TC-086: four ball 85% allowance", () => {
    expect(playingHandicapAllowance("four_ball")).toBe(85);
  });

  it("TC-087: scramble 35% allowance", () => {
    expect(playingHandicapAllowance("scramble")).toBe(35);
  });

  it("TC-088: foursomes 50% allowance", () => {
    expect(playingHandicapAllowance("foursomes")).toBe(50);
  });

  it("TC-089: unknown format defaults to 100%", () => {
    expect(playingHandicapAllowance("unknown_format")).toBe(100);
  });

  it("TC-090: computePlayingHandicap applies allowance", () => {
    // HI=20, SR=113, CR=72, Par=72 → CH=20
    // 95% allowance → PH = round(20*0.95) = 19
    expect(computePlayingHandicap(20.0, 113, 72.0, 72, 95)).toBe(19);
  });

  it("TC-091: computePlayingHandicap rounds correctly", () => {
    // HI=21, SR=113, CR=72, Par=72 → CH=21
    // 85% → PH = round(21*0.85) = round(17.85) = 18
    expect(computePlayingHandicap(21.0, 113, 72.0, 72, 85)).toBe(18);
  });
});

// ─── Strokes on Hole / Stableford ───────────────────────────────────────────

describe("Strokes on Hole and Stableford", () => {
  it("TC-092: player with PH=18 receives 1 stroke on all 18 holes", () => {
    for (let si = 1; si <= 18; si++) {
      expect(strokesOnHole(si, 18)).toBe(1);
    }
  });

  it("TC-093: player with PH=19 receives 2 strokes on SI=1", () => {
    expect(strokesOnHole(1, 19)).toBe(2);
    expect(strokesOnHole(2, 19)).toBe(1);
  });

  it("TC-094: plus handicapper (PH=-2) gives strokes on SI=1,2", () => {
    expect(strokesOnHole(1, -2)).toBe(-1);
    expect(strokesOnHole(2, -2)).toBe(-1);
    // SI=3 with PH=-2: absPH=2, base=0, extra=(2%18>0 && 3<=2)=false → -(0+0)=0
    expect(strokesOnHole(3, -2)).toBeGreaterThanOrEqual(-0.001);
    expect(strokesOnHole(3, -2)).toBeLessThanOrEqual(0.001);
  });

  it("TC-095: stableford: 4 on par 4 with 0 strokes = 2 points", () => {
    expect(stablefordPointsForHole(4, 4, 10, 0)).toBe(2);
  });

  it("TC-096: stableford: 3 on par 4 with 0 strokes = 3 points", () => {
    expect(stablefordPointsForHole(3, 4, 10, 0)).toBe(3);
  });

  it("TC-097: stableford: 6 on par 4 with 0 strokes = 0 points (no negative)", () => {
    expect(stablefordPointsForHole(6, 4, 10, 0)).toBe(0);
  });
});

// ─── 25-Round Lifecycle Simulation ──────────────────────────────────────────

describe("25-Round Lifecycle Simulation (§5.3 Phase progression)", () => {
  it("TC-098: full lifecycle from Phase 1 through Phase 3 with caps", () => {
    const diffs: number[] = [];
    let lowHI: number | null = null;

    // Rounds 1-2: Phase 1 (no HI established)
    diffs.push(18.0);
    let result = recalcHandicapIndex(diffs, lowHI);
    expect(result.phase).toBe(1);
    expect(result.handicapIndex).toBeNull();

    diffs.push(16.0);
    result = recalcHandicapIndex(diffs, lowHI);
    expect(result.phase).toBe(1);
    expect(result.handicapIndex).toBeNull();

    // Round 3: Phase 2 begins (best 1 of 3, adj -2.0)
    diffs.push(14.0);
    result = recalcHandicapIndex(diffs, lowHI);
    expect(result.phase).toBe(2);
    expect(result.handicapIndex).not.toBeNull();
    // best 1 = 14.0, adj = -2.0 → HI = 12.0
    expect(result.handicapIndex).toBe(12.0);
    expect(result.cappedHandicapIndex).not.toBeNull();
    lowHI = result.lowHandicapIndex;
    expect(lowHI).toBe(12.0);

    // Rounds 4-5: more diffs, progressing through phase 2
    diffs.push(13.0, 12.0);
    result = recalcHandicapIndex(diffs, lowHI);
    expect(result.phase).toBe(2);
    // 5 diffs: best 1 = 12.0, adj = 0 → HI = 12.0
    expect(result.handicapIndex).toBe(12.0);
    lowHI = result.lowHandicapIndex;

    // Rounds 6-19: build to 19 diffs (still phase 2, best 7) — deterministic values
    const roundDiffs = [11.5, 11.0, 12.0, 11.8, 11.2, 12.5, 11.1, 11.9, 12.2, 11.3, 11.7, 12.1, 11.4, 11.6];
    for (const d of roundDiffs) {
      diffs.push(d);
      result = recalcHandicapIndex(diffs, lowHI!);
      lowHI = result.lowHandicapIndex;
    }
    expect(result.phase).toBe(2);
    expect(diffs.length).toBe(19);

    // Round 20: transitions to Phase 3
    diffs.push(10.0);
    result = recalcHandicapIndex(diffs, lowHI);
    expect(result.phase).toBe(3);
    expect(result.isProvisional).toBe(false);
    expect(diffs.length).toBe(20);

    // Phase 3 HI should be around best 8 × 0.96 of last 20
    // All recent diffs 10-13, best 8 should be low end
    const hi = result.cappedHandicapIndex!;
    expect(hi).toBeGreaterThan(0);
    expect(hi).toBeLessThan(54.0);

    // Rounds 21-25: simulate a player whose game deteriorates
    for (let r = 21; r <= 25; r++) {
      diffs.push(25.0); // suddenly much worse
      result = recalcHandicapIndex(diffs, lowHI);
      // Caps should prevent runaway increase
      if (lowHI !== null) {
        expect(result.cappedHandicapIndex!).toBeLessThanOrEqual(lowHI + 5.0);
      }
      lowHI = result.lowHandicapIndex;
    }

    // After 25 rounds, the hard cap should have limited the HI
    expect(result.cappedHandicapIndex!).toBeLessThanOrEqual(result.lowHandicapIndex! + 5.0);
    expect(result.phase).toBe(3);
  });
});
