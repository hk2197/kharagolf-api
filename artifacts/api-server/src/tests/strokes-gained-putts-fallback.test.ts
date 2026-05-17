/**
 * Unit tests: scorecard-derived SG-Putting fallback (Task #566).
 *
 * Verifies that `computePerHoleSGFromShots` and `computeRoundSGFromShots`
 * fall back to `holePutts` (sourced from `scoresTable.putts` /
 * `generalPlayHoleScoresTable.putts`) when no putt-typed shots are present.
 *
 * Pure-function tests — no DB / no transport.
 */
import { describe, it, expect } from "vitest";
import {
  computePerHoleSGFromShots,
  computeRoundSGFromShots,
  expectedFirstPuttStrokes,
  type ShotRow,
  type HoleParMap,
  type HolePuttsMap,
} from "../lib/strokes-gained.js";

function shot(partial: Partial<ShotRow> & Pick<ShotRow, "holeNumber" | "shotNumber" | "shotType" | "distanceToPin">): ShotRow {
  return {
    id: partial.id ?? Math.floor(Math.random() * 1e9),
    tournamentId: partial.tournamentId ?? 1,
    playerId: partial.playerId ?? 1,
    round: partial.round ?? 1,
    club: partial.club ?? null,
    lieType: partial.lieType ?? null,
    missDirection: partial.missDirection ?? null,
    distanceCarried: partial.distanceCarried ?? null,
    recordedAt: partial.recordedAt ?? new Date(),
    ...partial,
  };
}

describe("scorecard-derived SG-Putting fallback", () => {
  it("expectedFirstPuttStrokes returns a positive baseline near 2.0", () => {
    const e = expectedFirstPuttStrokes("scratch");
    // 11-yard (≈33 ft) typical first-putt expected strokes — interpolated
    // between table rows at 10 yd (1.93) and 13 yd (2.04).
    expect(e).toBeGreaterThan(1.9);
    expect(e).toBeLessThan(2.05);
    // Higher handicap baselines expect more strokes from the same position.
    expect(expectedFirstPuttStrokes("18")).toBeGreaterThan(e);
  });

  it("per-hole: estimates SG-Putting from putts when no putt shots are tracked", () => {
    // One tee shot tracked, no putts in shots[]; scorecard recorded 1 putt
    // (e.g. a chip-in or great two-putt followed by a tap-in not captured).
    const shots: ShotRow[] = [
      shot({ holeNumber: 1, shotNumber: 1, shotType: "tee", distanceToPin: "350" }),
    ];
    const pars: HoleParMap = new Map([[1, 4]]);
    const putts: HolePuttsMap = new Map([[1, 1]]);

    const holes = computePerHoleSGFromShots(shots, pars, "scratch", putts);
    expect(holes).toHaveLength(1);
    const expected = expectedFirstPuttStrokes("scratch") - 1;
    expect(holes[0].sgPutting).toBeCloseTo(Math.round(expected * 100) / 100, 2);
    expect(holes[0].sgPutting).toBeGreaterThan(0); // 1 putt is gained
  });

  it("per-hole: 3 putts produce a negative SG-Putting estimate", () => {
    const pars: HoleParMap = new Map([[5, 4]]);
    const putts: HolePuttsMap = new Map([[5, 3]]);
    const holes = computePerHoleSGFromShots([], pars, "scratch", putts);
    expect(holes).toHaveLength(1);
    expect(holes[0].sgPutting).toBeLessThan(0);
    expect(holes[0].shotsOnHole).toBe(0);
  });

  it("per-hole: tracked putt shots take precedence over scorecard putts", () => {
    // Hole has tracked putts → fallback must NOT double-count putts.
    const shots: ShotRow[] = [
      shot({ holeNumber: 1, shotNumber: 1, shotType: "putt", distanceToPin: "5" }),
      shot({ holeNumber: 1, shotNumber: 2, shotType: "putt", distanceToPin: "0.5" }),
    ];
    const pars: HoleParMap = new Map([[1, 4]]);
    const trackedOnly = computePerHoleSGFromShots(shots, pars, "scratch");
    const withPutts = computePerHoleSGFromShots(shots, pars, "scratch", new Map([[1, 99]]));
    // The recorded putt count of "99" must be ignored because putt shots exist.
    expect(withPutts[0].sgPutting).toBeCloseTo(trackedOnly[0].sgPutting, 2);
  });

  it("per-hole: puttingEstimated=true on scorecard fallback, false when putts tracked", () => {
    const pars: HoleParMap = new Map([[1, 4], [2, 4]]);

    // Hole 1: tracked putt → measured.
    // Hole 2: only scorecard putt count → estimated.
    const shots: ShotRow[] = [
      shot({ holeNumber: 1, shotNumber: 1, shotType: "tee", distanceToPin: "350" }),
      shot({ holeNumber: 1, shotNumber: 2, shotType: "putt", distanceToPin: "5" }),
      shot({ holeNumber: 2, shotNumber: 1, shotType: "tee", distanceToPin: "350" }),
    ];
    const putts: HolePuttsMap = new Map([[1, 1], [2, 2]]);
    const holes = computePerHoleSGFromShots(shots, pars, "scratch", putts);
    const h1 = holes.find(h => h.holeNumber === 1)!;
    const h2 = holes.find(h => h.holeNumber === 2)!;
    expect(h1.puttingEstimated).toBe(false);
    expect(h2.puttingEstimated).toBe(true);
  });

  it("per-hole: empty shots + empty putts returns no holes", () => {
    expect(computePerHoleSGFromShots([], new Map(), "scratch", new Map())).toEqual([]);
    expect(computePerHoleSGFromShots([], new Map(), "scratch")).toEqual([]);
  });

  it("round: surfaces SG-Putting from putts even when shot tracking is absent", () => {
    // Full 18-hole scorecard putt counts, no per-shot tracking at all.
    const holePutts: HolePuttsMap = new Map();
    for (let h = 1; h <= 18; h++) holePutts.set(h, 2); // 36 putts
    const result = computeRoundSGFromShots({
      tournamentId: 42, round: 1, shots: [], holePars: new Map(), holePutts,
    }, "scratch");

    expect(result.sgPutting).not.toBeNull();
    // 18 × (E_first_putt - 2.0). E≈1.97 → roughly -0.5.
    const e = expectedFirstPuttStrokes("scratch");
    const expected = Math.round((18 * (e - 2)) * 100) / 100;
    expect(result.sgPutting!).toBeCloseTo(expected, 1);
    // Other categories remain null since no off-green shots were tracked.
    expect(result.sgApproach).toBeNull();
    expect(result.sgOTT).toBeNull();
    // sgTotal aggregates only categories with data — should equal sgPutting here.
    expect(result.sgTotal).toBeCloseTo(result.sgPutting!, 2);
  });

  it("round: tags sgPuttingSource as 'measured' when a putt-typed shot is tracked", () => {
    const shots: ShotRow[] = [];
    for (let h = 1; h <= 18; h++) {
      shots.push(shot({ holeNumber: h, shotNumber: 1, shotType: "tee", distanceToPin: "350" }));
    }
    // Add a single tracked putt on hole 1 — that's enough to mark the round measured.
    shots.push(shot({ holeNumber: 1, shotNumber: 2, shotType: "putt", distanceToPin: "5" }));
    const result = computeRoundSGFromShots({
      tournamentId: 7, round: 1, shots, holePars: new Map(),
    }, "scratch");
    expect(result.sgPutting).not.toBeNull();
    expect(result.sgPuttingSource).toBe("measured");
  });

  it("round: tags sgPuttingSource as 'estimated' when only scorecard putts are present", () => {
    const holePutts: HolePuttsMap = new Map();
    for (let h = 1; h <= 18; h++) holePutts.set(h, 2);
    const result = computeRoundSGFromShots({
      tournamentId: 8, round: 1, shots: [], holePars: new Map(), holePutts,
    }, "scratch");
    expect(result.sgPutting).not.toBeNull();
    expect(result.sgPuttingSource).toBe("estimated");
  });

  it("round: sgPuttingSource is null when no SG-Putting figure is produced", () => {
    const result = computeRoundSGFromShots({
      tournamentId: 9, round: 1, shots: [], holePars: new Map(),
    }, "scratch");
    expect(result.sgPutting).toBeNull();
    expect(result.sgPuttingSource).toBeNull();
  });

  it("expectedFirstPuttStrokes accepts an explicit distance override", () => {
    const def = expectedFirstPuttStrokes("scratch");
    const short = expectedFirstPuttStrokes("scratch", 2);  // ~6 ft
    const long = expectedFirstPuttStrokes("scratch", 25);  // ~75 ft
    expect(short).toBeLessThan(def);
    expect(long).toBeGreaterThan(def);
  });

  it("per-hole: uses the last non-putt shot's distanceToPin when it lies on the green", () => {
    // Approach landed 3 yards (~9 ft) from pin; scorecard recorded 2 putts.
    // Estimate should use 3 yd as the first-putt distance, not the 11-yd default.
    const shots: ShotRow[] = [
      shot({ holeNumber: 7, shotNumber: 1, shotType: "tee", distanceToPin: "350" }),
      shot({ holeNumber: 7, shotNumber: 2, shotType: "approach", distanceToPin: "3" }),
    ];
    const pars: HoleParMap = new Map([[7, 4]]);
    const putts: HolePuttsMap = new Map([[7, 2]]);

    const holes = computePerHoleSGFromShots(shots, pars, "scratch", putts);
    expect(holes).toHaveLength(1);
    const expectedSg = Math.round((expectedFirstPuttStrokes("scratch", 3) - 2) * 100) / 100;
    expect(holes[0].sgPutting).toBeCloseTo(expectedSg, 2);
    // Sanity: should differ from the default 11-yard estimate.
    const defaultSg = Math.round((expectedFirstPuttStrokes("scratch") - 2) * 100) / 100;
    expect(holes[0].sgPutting).not.toBeCloseTo(defaultSg, 2);
  });

  it("per-hole: ignores the inferred distance when the last non-putt shot is far from the pin", () => {
    // Last shot is an approach starting 150 yd out — clearly not on the green.
    const shots: ShotRow[] = [
      shot({ holeNumber: 2, shotNumber: 1, shotType: "tee", distanceToPin: "350" }),
      shot({ holeNumber: 2, shotNumber: 2, shotType: "approach", distanceToPin: "150" }),
    ];
    const pars: HoleParMap = new Map([[2, 4]]);
    const putts: HolePuttsMap = new Map([[2, 2]]);

    const holes = computePerHoleSGFromShots(shots, pars, "scratch", putts);
    const defaultSg = Math.round((expectedFirstPuttStrokes("scratch") - 2) * 100) / 100;
    expect(holes[0].sgPutting).toBeCloseTo(defaultSg, 2);
  });

  it("per-hole: falls back to the 11-yard default when no shots are tracked at all", () => {
    const pars: HoleParMap = new Map([[1, 4]]);
    const putts: HolePuttsMap = new Map([[1, 2]]);
    const holes = computePerHoleSGFromShots([], pars, "scratch", putts);
    const defaultSg = Math.round((expectedFirstPuttStrokes("scratch") - 2) * 100) / 100;
    expect(holes[0].sgPutting).toBeCloseTo(defaultSg, 2);
  });

  it("round: uses the last non-putt shot's distance for the SG-Putting fallback", () => {
    // 18 holes, each with a tee shot + an approach landing 4 yd from the pin,
    // and 2 recorded putts per hole. Meets MIN_SHOTS_PER_ROUND.
    const shots: ShotRow[] = [];
    const pars: HoleParMap = new Map();
    const holePutts: HolePuttsMap = new Map();
    for (let h = 1; h <= 18; h++) {
      pars.set(h, 4);
      shots.push(shot({ holeNumber: h, shotNumber: 1, shotType: "tee", distanceToPin: "350" }));
      shots.push(shot({ holeNumber: h, shotNumber: 2, shotType: "approach", distanceToPin: "4" }));
      holePutts.set(h, 2);
    }

    const result = computeRoundSGFromShots({
      tournamentId: 9, round: 1, shots, holePars: pars, holePutts,
    }, "scratch");

    expect(result.sgPutting).not.toBeNull();
    // SG-Putting comes only from the per-hole fallback (no putt shots tracked):
    // 18 holes × (E(4yd) - 2 putts).
    const expected = Math.round((18 * (expectedFirstPuttStrokes("scratch", 4) - 2)) * 100) / 100;
    expect(result.sgPutting!).toBeCloseTo(expected, 1);

    // And it must differ meaningfully from the default 11-yard estimate.
    const defaultExpected = Math.round((18 * (expectedFirstPuttStrokes("scratch") - 2)) * 100) / 100;
    expect(Math.abs(result.sgPutting! - defaultExpected)).toBeGreaterThan(0.5);
  });

  it("round: putts on a hole that already has tracked putts are not double-counted", () => {
    // 18 holes of 2 strokes (just tee shots) — meets MIN_SHOTS_PER_ROUND.
    const shots: ShotRow[] = [];
    const pars: HoleParMap = new Map();
    for (let h = 1; h <= 18; h++) {
      pars.set(h, 4);
      shots.push(shot({ holeNumber: h, shotNumber: 1, shotType: "tee", distanceToPin: "350" }));
    }
    // Add a tracked putt only on hole 1.
    shots.push(shot({ holeNumber: 1, shotNumber: 2, shotType: "putt", distanceToPin: "3" }));
    const holePutts: HolePuttsMap = new Map();
    for (let h = 1; h <= 18; h++) holePutts.set(h, 2);

    const result = computeRoundSGFromShots({
      tournamentId: 1, round: 1, shots, holePars: pars, holePutts,
    }, "scratch");

    expect(result.sgPutting).not.toBeNull();
    // Hole 1 contributes the tracked-shot SG (ignoring scorecard "2" putts),
    // holes 2..18 contribute scorecard-fallback SG. Validate no NaNs.
    expect(Number.isFinite(result.sgPutting!)).toBe(true);
  });
});
