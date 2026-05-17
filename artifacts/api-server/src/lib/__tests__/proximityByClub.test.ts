import { describe, it, expect } from "vitest";
import {
  computeProximityByClub,
  computeProximityCoachingTips,
  computeWeeklyProximityHistory,
  lookupProximityBenchmark,
  normalizeClubForBenchmark,
  practiceDistanceYardsForClubKey,
  PROXIMITY_BENCHMARKS_FT,
  type ProximityByClubStat,
} from "../strokes-gained.js";

type Shot = Parameters<typeof computeProximityByClub>[0][number];

function shot(over: Partial<Shot>): Shot {
  return {
    tournamentId: 1,
    generalPlayRoundId: null,
    round: 1,
    holeNumber: 1,
    shotNumber: 1,
    shotType: "approach",
    club: "7i",
    lieType: "fairway",
    missDirection: null,
    distanceToPin: "150",
    distanceCarried: null,
    ...over,
  };
}

describe("computeProximityByClub", () => {
  it("returns empty array when no shots", () => {
    expect(computeProximityByClub([])).toEqual([]);
  });

  it("groups by club and computes mean / p90 in feet", () => {
    // Two holes, same club. Next-shot distance to pin: 5y (=15ft) and 10y (=30ft).
    // Mean = 22.5 ft, p90 with 2 samples = the larger = 30 ft.
    const shots: Shot[] = [
      shot({ holeNumber: 1, shotNumber: 1, distanceToPin: "150" }),
      shot({ holeNumber: 1, shotNumber: 2, shotType: "putt", distanceToPin: "5", club: null }),
      shot({ holeNumber: 2, shotNumber: 1, distanceToPin: "150" }),
      shot({ holeNumber: 2, shotNumber: 2, shotType: "putt", distanceToPin: "10", club: null }),
    ];
    const out = computeProximityByClub(shots);
    expect(out).toHaveLength(1);
    expect(out[0].club).toBe("7i");
    expect(out[0].shots).toBe(2);
    expect(out[0].meanProximityFt).toBeCloseTo(22.5, 1);
    expect(out[0].p90ProximityFt).toBeCloseTo(30, 1);
    expect(out[0].greenInRegPct).toBe(100);
    // Benchmark for "7i" should be populated alongside the player's stat
    expect(out[0].benchmark).not.toBeNull();
    expect(out[0].benchmark?.clubKey).toBe("7i");
    expect(out[0].benchmark?.tourMeanFt).toBe(PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt);
    expect(out[0].benchmark?.scratchMeanFt).toBe(PROXIMITY_BENCHMARKS_FT["7i"].scratchMeanFt);
    expect(out[0].benchmark?.midHandicapMeanFt).toBe(PROXIMITY_BENCHMARKS_FT["7i"].midHandicapMeanFt);
  });

  it("ignores putts and tee shots", () => {
    const shots: Shot[] = [
      shot({ shotType: "tee", club: "driver", distanceToPin: "400" }),
      shot({ shotType: "putt", club: "putter", shotNumber: 2, distanceToPin: "5" }),
    ];
    expect(computeProximityByClub(shots)).toEqual([]);
  });

  it("computes a non-100% GIR when the next shot is not a putt", () => {
    // First approach lands off the green (next shot is a chip), second hits green.
    const shots: Shot[] = [
      shot({ holeNumber: 1, shotNumber: 1, distanceToPin: "150", club: "7i" }),
      shot({ holeNumber: 1, shotNumber: 2, shotType: "chip", distanceToPin: "20", club: "wedge" }),
      shot({ holeNumber: 2, shotNumber: 1, distanceToPin: "150", club: "7i" }),
      shot({ holeNumber: 2, shotNumber: 2, shotType: "putt", distanceToPin: "5", club: null }),
    ];
    const sevenIron = computeProximityByClub(shots).find(c => c.club === "7i");
    expect(sevenIron?.shots).toBe(2);
    expect(sevenIron?.greenInRegPct).toBe(50);
  });

  it("returns null benchmark when the player's club label can't be normalised", () => {
    const shots: Shot[] = [
      shot({ holeNumber: 1, shotNumber: 1, distanceToPin: "150", club: "mystery-stick" }),
      shot({ holeNumber: 1, shotNumber: 2, shotType: "putt", distanceToPin: "5", club: null }),
    ];
    const out = computeProximityByClub(shots);
    expect(out).toHaveLength(1);
    expect(out[0].benchmark).toBeNull();
  });
});

describe("normalizeClubForBenchmark", () => {
  it.each([
    ["7i", "7i"],
    ["7 iron", "7i"],
    ["7-iron", "7i"],
    ["7", "7i"],
    ["iron 7", "7i"],
    ["7Iron", "7i"],
    ["PW", "pw"],
    ["pitching wedge", "pw"],
    ["wedge", "pw"],
    ["GW", "gw"],
    ["AW", "gw"],
    ["gap wedge", "gw"],
    ["approach wedge", "gw"],
    ["50°", "gw"],
    ["SW", "sw"],
    ["sand wedge", "sw"],
    ["56°", "sw"],
    ["LW", "lw"],
    ["lob wedge", "lw"],
    ["60°", "lw"],
    ["Driver", "driver"],
    ["1w", "driver"],
    ["3w", "3w"],
    ["3 wood", "3w"],
    ["3h", "3h"],
    ["3-hybrid", "3h"],
    ["hybrid 3", "3h"],
  ])("normalises %s → %s", (input, expected) => {
    expect(normalizeClubForBenchmark(input)).toBe(expected);
  });

  it.each([null, undefined, "", "putter", "chipper", "weird-stick"])(
    "returns null for unrecognised label %p",
    (input) => {
      expect(normalizeClubForBenchmark(input as string | null | undefined)).toBeNull();
    },
  );
});

describe("lookupProximityBenchmark", () => {
  it("returns the canonical benchmark for a known club", () => {
    const b = lookupProximityBenchmark("7 iron");
    expect(b).not.toBeNull();
    expect(b?.clubKey).toBe("7i");
    expect(b?.tourMeanFt).toBe(PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt);
  });

  it("returns null for unmapped clubs", () => {
    expect(lookupProximityBenchmark("putter")).toBeNull();
    expect(lookupProximityBenchmark(null)).toBeNull();
  });

  it("orders the canonical wedge benchmarks tour < scratch < mid-handicap", () => {
    for (const key of ["7i", "pw", "sw", "lw", "5i"]) {
      const b = PROXIMITY_BENCHMARKS_FT[key];
      expect(b.tourMeanFt).toBeLessThan(b.scratchMeanFt);
      expect(b.scratchMeanFt).toBeLessThan(b.midHandicapMeanFt);
    }
  });
});

// Task #1348 — coaching tip surfaces the 1-2 weakest clubs vs tour and ships
// the same caddieHint string the AI Caddie appends to its rationale.
describe("computeProximityCoachingTips", () => {
  function statFor(
    clubKey: keyof typeof PROXIMITY_BENCHMARKS_FT,
    overrides: { meanProximityFt: number; shots?: number; club?: string },
  ): ProximityByClubStat {
    const b = PROXIMITY_BENCHMARKS_FT[clubKey];
    return {
      club: overrides.club ?? clubKey,
      shots: overrides.shots ?? 5,
      meanProximityFt: overrides.meanProximityFt,
      p90ProximityFt: overrides.meanProximityFt + 10,
      greenInRegPct: 80,
      benchmark: {
        clubKey,
        tourMeanFt: b.tourMeanFt,
        scratchMeanFt: b.scratchMeanFt,
        midHandicapMeanFt: b.midHandicapMeanFt,
      },
    };
  }

  it("returns no tips when no club exceeds the gap threshold", () => {
    const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
    const stats = [statFor("7i", { meanProximityFt: tour7i + 1 })];
    expect(computeProximityCoachingTips(stats)).toEqual([]);
  });

  it("returns no tips for clubs with too few tracked shots", () => {
    const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
    const stats = [statFor("7i", { meanProximityFt: tour7i + 12, shots: 2 })];
    expect(computeProximityCoachingTips(stats)).toEqual([]);
  });

  it("skips stats with no resolved benchmark", () => {
    const stats: ProximityByClubStat[] = [
      {
        club: "mystery",
        shots: 10,
        meanProximityFt: 80,
        p90ProximityFt: 100,
        greenInRegPct: 50,
        benchmark: null,
      },
    ];
    expect(computeProximityCoachingTips(stats)).toEqual([]);
  });

  it("picks the worst clubs first and caps at maxTips (default 2)", () => {
    const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
    const tourPw = PROXIMITY_BENCHMARKS_FT["pw"].tourMeanFt;
    const tourSw = PROXIMITY_BENCHMARKS_FT["sw"].tourMeanFt;
    // 7i has the biggest gap, then sw, then pw — pw should be cut.
    const stats = [
      statFor("pw", { meanProximityFt: tourPw + 4 }),
      statFor("sw", { meanProximityFt: tourSw + 8 }),
      statFor("7i", { meanProximityFt: tour7i + 15 }),
    ];
    const tips = computeProximityCoachingTips(stats);
    expect(tips).toHaveLength(2);
    expect(tips[0].clubKey).toBe("7i");
    expect(tips[1].clubKey).toBe("sw");
    expect(tips[0].gapVsTourFt).toBeGreaterThan(tips[1].gapVsTourFt);
  });

  it("respects an explicit maxTips override (clamped 1..5)", () => {
    const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
    const tourPw = PROXIMITY_BENCHMARKS_FT["pw"].tourMeanFt;
    const tourSw = PROXIMITY_BENCHMARKS_FT["sw"].tourMeanFt;
    const stats = [
      statFor("pw", { meanProximityFt: tourPw + 4 }),
      statFor("sw", { meanProximityFt: tourSw + 8 }),
      statFor("7i", { meanProximityFt: tour7i + 15 }),
    ];
    expect(computeProximityCoachingTips(stats, { maxTips: 1 })).toHaveLength(1);
    expect(computeProximityCoachingTips(stats, { maxTips: 5 })).toHaveLength(3);
    // 0 should clamp up to 1 (we always want at least one tip if asked).
    expect(computeProximityCoachingTips(stats, { maxTips: 0 })).toHaveLength(1);
  });

  it("builds a player-facing message and AI-Caddie hint with practice distance", () => {
    const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
    const stats = [statFor("7i", { meanProximityFt: tour7i + 8, club: "7-iron" })];
    const [tip] = computeProximityCoachingTips(stats);
    expect(tip).toBeDefined();
    expect(tip.club).toBe("7-iron");
    expect(tip.clubKey).toBe("7i");
    expect(tip.gapVsTourFt).toBeCloseTo(8, 1);
    // Half-the-gap, floor of 2.
    expect(tip.aimLongFt).toBe(Math.max(2, Math.round(8 * 0.6)));
    // Player message should name the club, the gap, and the practice distance.
    expect(tip.message).toContain("7-iron");
    expect(tip.message).toContain("8 ft worse than tour");
    const practice = practiceDistanceYardsForClubKey("7i");
    expect(practice).not.toBeNull();
    expect(tip.practiceDistanceYards).toBe(practice);
    expect(tip.message).toContain(`Practice from ${practice} yds`);
    // Caddie hint must be the compact form the AI Caddie appends to rationale.
    expect(tip.caddieHint).toBe(
      `you're 8 ft worse with the 7-iron — aim ${tip.aimLongFt} ft long of pin`,
    );
  });

  // Task #1640 — trend annotation vs the previous comparison window.
  describe("trend annotation (Task #1640)", () => {
    it("returns null trend when no previous stats are supplied", () => {
      const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
      const stats = [statFor("7i", { meanProximityFt: tour7i + 10 })];
      const [tip] = computeProximityCoachingTips(stats);
      expect(tip.previousMeanProximityFt).toBeNull();
      expect(tip.trendVsTourFt).toBeNull();
      expect(tip.trendLabel).toBeNull();
    });

    it("returns null trend when no previous-window stat matches the club key", () => {
      const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
      const tourPw = PROXIMITY_BENCHMARKS_FT["pw"].tourMeanFt;
      const stats = [statFor("7i", { meanProximityFt: tour7i + 10 })];
      // Previous window only has data for a different club.
      const previousStats = [statFor("pw", { meanProximityFt: tourPw + 5 })];
      const [tip] = computeProximityCoachingTips(stats, { previousStats });
      expect(tip.previousMeanProximityFt).toBeNull();
      expect(tip.trendVsTourFt).toBeNull();
      expect(tip.trendLabel).toBeNull();
    });

    it("ignores previous stats with too few shots to be trustworthy", () => {
      const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
      const stats = [statFor("7i", { meanProximityFt: tour7i + 10 })];
      const previousStats = [statFor("7i", { meanProximityFt: tour7i + 4, shots: 1 })];
      const [tip] = computeProximityCoachingTips(stats, { previousStats });
      expect(tip.trendVsTourFt).toBeNull();
      expect(tip.trendLabel).toBeNull();
    });

    it("labels small movements as 'no change'", () => {
      const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
      const stats = [statFor("7i", { meanProximityFt: tour7i + 10 })];
      // Previous mean within ±0.5 ft of current → flat.
      const previousStats = [statFor("7i", { meanProximityFt: tour7i + 10.2 })];
      const [tip] = computeProximityCoachingTips(stats, { previousStats });
      expect(tip.trendVsTourFt).toBeCloseTo(-0.2, 1);
      expect(tip.trendLabel).toBe("no change");
    });

    it("flags slipping when the gap has widened", () => {
      const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
      const stats = [statFor("7i", { meanProximityFt: tour7i + 10 })];
      // Previous gap was 6.6 ft, now 10 ft → +3.4 ft (slipping).
      const previousStats = [statFor("7i", { meanProximityFt: tour7i + 6.6 })];
      const [tip] = computeProximityCoachingTips(stats, { previousStats });
      expect(tip.trendVsTourFt).toBeCloseTo(3.4, 1);
      expect(tip.trendLabel).toContain("slipping");
      expect(tip.trendLabel).toContain("+3.4 ft");
      // Caddie hint stays in the "you're X ft worse" framing — gap is still
      // widening, no encouragement warranted.
      expect(tip.caddieHint).toContain("worse with the 7i");
    });

    it("labels closing trends with a minus prefix and the previous-window label", () => {
      const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
      const stats = [statFor("7i", { meanProximityFt: tour7i + 6 })];
      // Previous gap was 9 ft, now 6 ft → −3 ft from prev 30d.
      const previousStats = [statFor("7i", { meanProximityFt: tour7i + 9 })];
      const [tip] = computeProximityCoachingTips(stats, { previousStats });
      expect(tip.trendVsTourFt).toBeCloseTo(-3, 1);
      expect(tip.trendLabel).toBe("\u22123.0 ft from prev 30d");
    });

    it("flips the caddie hint to encouragement when the gap is closing past the threshold", () => {
      const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
      const stats = [statFor("7i", { meanProximityFt: tour7i + 6, club: "7-iron" })];
      // Previous gap was 12 ft, now 6 ft → −6 ft (well past the threshold).
      const previousStats = [statFor("7i", { meanProximityFt: tour7i + 12, club: "7-iron" })];
      const [tip] = computeProximityCoachingTips(stats, { previousStats });
      expect(tip.trendVsTourFt).toBeCloseTo(-6, 1);
      expect(tip.caddieHint).toBe("you're closing the gap with the 7-iron — keep it up");
    });

    it("does NOT flip to encouragement when the closing trend is below the threshold", () => {
      const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
      const stats = [statFor("7i", { meanProximityFt: tour7i + 8 })];
      // Closing by 1.0 ft → above the no-change band but below the
      // encouragement threshold (1.5 ft). Should still surface a "closing"
      // label but keep the standard "you're X ft worse" caddie hint.
      const previousStats = [statFor("7i", { meanProximityFt: tour7i + 9 })];
      const [tip] = computeProximityCoachingTips(stats, { previousStats });
      expect(tip.trendVsTourFt).toBeCloseTo(-1, 1);
      expect(tip.trendLabel).toContain("from prev 30d");
      expect(tip.caddieHint).toContain("worse with the 7i");
    });

    it("honours a custom previous-window label", () => {
      const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
      const stats = [statFor("7i", { meanProximityFt: tour7i + 6 })];
      const previousStats = [statFor("7i", { meanProximityFt: tour7i + 9 })];
      const [tip] = computeProximityCoachingTips(stats, {
        previousStats,
        previousWindowLabel: "prev 60d",
      });
      expect(tip.trendLabel).toContain("prev 60d");
    });

    it("matches previous stats by canonical club key, not raw label", () => {
      const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
      const stats = [statFor("7i", { meanProximityFt: tour7i + 8, club: "7-iron" })];
      // Previous-window label is the short form, current is the long form.
      const previousStats = [statFor("7i", { meanProximityFt: tour7i + 4, club: "7i" })];
      const [tip] = computeProximityCoachingTips(stats, { previousStats });
      expect(tip.trendVsTourFt).toBeCloseTo(4, 1);
      expect(tip.trendLabel).toContain("slipping");
    });
  });

  it("flips the second sentence to 'already at scratch' when the gap is purely vs tour", () => {
    // Pick a meanProximity between scratch and tour: gap vs tour ≥ 3 ft, but
    // mean ≤ scratch so the message should congratulate the player.
    const b = PROXIMITY_BENCHMARKS_FT["7i"];
    const mean = Math.min(b.scratchMeanFt, b.tourMeanFt + 4);
    if (mean - b.tourMeanFt < 3) {
      // Bench is too tight — fall back to a club with more headroom.
      const b2 = PROXIMITY_BENCHMARKS_FT["sw"];
      const mean2 = Math.min(b2.scratchMeanFt, b2.tourMeanFt + 4);
      const stats = [statFor("sw", { meanProximityFt: mean2 })];
      const [tip] = computeProximityCoachingTips(stats);
      expect(tip.message).toContain("already at scratch level");
    } else {
      const stats = [statFor("7i", { meanProximityFt: mean })];
      const [tip] = computeProximityCoachingTips(stats);
      expect(tip.message).toContain("already at scratch level");
    }
  });
});

describe("practiceDistanceYardsForClubKey", () => {
  it("returns null for unknown / missing keys", () => {
    expect(practiceDistanceYardsForClubKey(null)).toBeNull();
    expect(practiceDistanceYardsForClubKey(undefined)).toBeNull();
    expect(practiceDistanceYardsForClubKey("")).toBeNull();
    expect(practiceDistanceYardsForClubKey("not-a-club")).toBeNull();
  });

  it("returns a positive yardage for canonical iron / wedge keys", () => {
    for (const key of ["7i", "pw", "sw", "lw", "5i"]) {
      const yds = practiceDistanceYardsForClubKey(key);
      expect(yds).not.toBeNull();
      expect(yds!).toBeGreaterThan(0);
    }
  });
});

// Task #2039 — weekly gap-vs-tour history powering the inline sparkline next
// to each "Work on This Club" trend label.
describe("computeWeeklyProximityHistory", () => {
  // Anchor "now" to a fixed point so the bucket boundaries are deterministic.
  const NOW_MS = Date.parse("2025-04-30T12:00:00Z");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;
  const TOUR_7I = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;

  function withTime(over: Partial<Shot> & { recordedAt: Date }): Shot {
    return { ...shot(over), recordedAt: over.recordedAt };
  }

  // Build a hole = approach + putt pair so the proximity outcome is the
  // putt's distance-to-pin (in yards) × 3 → feet.
  function holeAt(opts: {
    holeNumber: number;
    daysAgo: number;
    club: string;
    nextDistYards: number;
  }): Shot[] {
    const recordedAt = new Date(NOW_MS - opts.daysAgo * DAY_MS);
    return [
      withTime({
        holeNumber: opts.holeNumber,
        shotNumber: 1,
        club: opts.club,
        distanceToPin: "150",
        recordedAt,
      }),
      withTime({
        holeNumber: opts.holeNumber,
        shotNumber: 2,
        shotType: "putt",
        club: null,
        distanceToPin: String(opts.nextDistYards),
        recordedAt,
      }),
    ];
  }

  it("returns the requested number of buckets in chronological order", () => {
    const out = computeWeeklyProximityHistory([], {
      club: "7i",
      tourMeanFt: TOUR_7I,
      weeks: 6,
      nowMs: NOW_MS,
    });
    expect(out).toHaveLength(6);
    // Each bucket starts WEEK_MS earlier than the next; oldest is first.
    for (let i = 1; i < out.length; i++) {
      const prev = Date.parse(out[i - 1].weekStart);
      const curr = Date.parse(out[i].weekStart);
      expect(curr - prev).toBe(WEEK_MS);
    }
    // The newest bucket starts exactly one week before NOW.
    expect(Date.parse(out[out.length - 1].weekStart)).toBe(NOW_MS - WEEK_MS);
    // Every bucket has zero shots and a null mean / gap.
    for (const b of out) {
      expect(b.shots).toBe(0);
      expect(b.meanProximityFt).toBeNull();
      expect(b.gapVsTourFt).toBeNull();
    }
  });

  it("clamps weeks to a sensible range", () => {
    expect(
      computeWeeklyProximityHistory([], { club: "7i", tourMeanFt: TOUR_7I, weeks: 0, nowMs: NOW_MS }),
    ).toHaveLength(1);
    expect(
      computeWeeklyProximityHistory([], { club: "7i", tourMeanFt: TOUR_7I, weeks: 999, nowMs: NOW_MS }),
    ).toHaveLength(52);
  });

  it("buckets shots into the correct trailing weekly windows", () => {
    // One approach per week for the last 6 weeks. Next-shot distance to pin
    // (yards) is the index → proximity in feet is index × 3.
    const shots: Shot[] = [];
    let hole = 1;
    for (let i = 0; i < 6; i++) {
      // daysAgo of `i * 7 + 1` lands the shot squarely inside the i-th-from-newest week.
      shots.push(...holeAt({ holeNumber: hole++, daysAgo: i * 7 + 1, club: "7i", nextDistYards: i + 1 }));
    }
    const out = computeWeeklyProximityHistory(shots, {
      club: "7i",
      tourMeanFt: TOUR_7I,
      weeks: 6,
      nowMs: NOW_MS,
    });
    expect(out).toHaveLength(6);
    // Each bucket should have exactly one shot.
    for (const b of out) expect(b.shots).toBe(1);
    // Newest bucket (last in the array) corresponds to the `daysAgo: 1` shot
    // → next-dist 1y → 3 ft proximity.
    expect(out[out.length - 1].meanProximityFt).toBe(3);
    expect(out[out.length - 1].gapVsTourFt).toBeCloseTo(3 - TOUR_7I, 1);
    // Oldest bucket (first in the array) is the `daysAgo: 36` shot → 6y → 18 ft.
    expect(out[0].meanProximityFt).toBe(18);
    expect(out[0].gapVsTourFt).toBeCloseTo(18 - TOUR_7I, 1);
  });

  it("ignores shots from a different club", () => {
    const shots: Shot[] = [
      ...holeAt({ holeNumber: 1, daysAgo: 1, club: "7i", nextDistYards: 5 }),
      ...holeAt({ holeNumber: 2, daysAgo: 1, club: "pw", nextDistYards: 50 }),
    ];
    const out = computeWeeklyProximityHistory(shots, {
      club: "7i",
      tourMeanFt: TOUR_7I,
      weeks: 6,
      nowMs: NOW_MS,
    });
    expect(out[out.length - 1].shots).toBe(1);
    // pw shot must not have polluted the 7i mean (5y → 15 ft).
    expect(out[out.length - 1].meanProximityFt).toBe(15);
  });

  it("ignores shots older than the oldest bucket", () => {
    const shots: Shot[] = [
      ...holeAt({ holeNumber: 1, daysAgo: 100, club: "7i", nextDistYards: 50 }),
    ];
    const out = computeWeeklyProximityHistory(shots, {
      club: "7i",
      tourMeanFt: TOUR_7I,
      weeks: 6,
      nowMs: NOW_MS,
    });
    for (const b of out) expect(b.shots).toBe(0);
  });

  it("averages multiple shots within the same bucket", () => {
    // Two 7i approaches within the trailing week — proximities 6 ft and 12 ft → mean 9 ft.
    const shots: Shot[] = [
      ...holeAt({ holeNumber: 1, daysAgo: 1, club: "7i", nextDistYards: 2 }),
      ...holeAt({ holeNumber: 2, daysAgo: 3, club: "7i", nextDistYards: 4 }),
    ];
    const out = computeWeeklyProximityHistory(shots, {
      club: "7i",
      tourMeanFt: TOUR_7I,
      weeks: 6,
      nowMs: NOW_MS,
    });
    expect(out[out.length - 1].shots).toBe(2);
    expect(out[out.length - 1].meanProximityFt).toBeCloseTo(9, 1);
  });

  it("skips approaches missing distanceToPin or recordedAt", () => {
    const at = new Date(NOW_MS - DAY_MS);
    const shots: Shot[] = [
      withTime({
        holeNumber: 1, shotNumber: 1, club: "7i", distanceToPin: null, recordedAt: at,
      }),
      // No recordedAt at all — must be ignored.
      shot({ holeNumber: 2, shotNumber: 1, club: "7i", distanceToPin: "150" }),
    ];
    const out = computeWeeklyProximityHistory(shots, {
      club: "7i",
      tourMeanFt: TOUR_7I,
      weeks: 6,
      nowMs: NOW_MS,
    });
    for (const b of out) expect(b.shots).toBe(0);
  });

  it("ignores putts and tee shots even when the club label matches", () => {
    const at = new Date(NOW_MS - DAY_MS);
    const shots: Shot[] = [
      withTime({ holeNumber: 1, shotNumber: 1, shotType: "tee", club: "7i", distanceToPin: "200", recordedAt: at }),
      withTime({ holeNumber: 1, shotNumber: 2, shotType: "putt", club: "7i", distanceToPin: "5", recordedAt: at }),
    ];
    const out = computeWeeklyProximityHistory(shots, {
      club: "7i",
      tourMeanFt: TOUR_7I,
      weeks: 6,
      nowMs: NOW_MS,
    });
    for (const b of out) expect(b.shots).toBe(0);
  });
});

// Task #2039 — interface surface check: the helper itself doesn't fill in
// `weeklyGapHistory` (the route handler does), so the field starts as null.
describe("computeProximityCoachingTips weeklyGapHistory default", () => {
  it("returns weeklyGapHistory: null on every tip by default", () => {
    const tour7i = PROXIMITY_BENCHMARKS_FT["7i"].tourMeanFt;
    const stats: ProximityByClubStat[] = [
      {
        club: "7i",
        shots: 10,
        meanProximityFt: tour7i + 8,
        p90ProximityFt: tour7i + 20,
        greenInRegPct: 70,
        benchmark: {
          clubKey: "7i",
          tourMeanFt: tour7i,
          scratchMeanFt: PROXIMITY_BENCHMARKS_FT["7i"].scratchMeanFt,
          midHandicapMeanFt: PROXIMITY_BENCHMARKS_FT["7i"].midHandicapMeanFt,
        },
      },
    ];
    const [tip] = computeProximityCoachingTips(stats);
    expect(tip).toBeDefined();
    expect(tip.weeklyGapHistory).toBeNull();
  });
});
