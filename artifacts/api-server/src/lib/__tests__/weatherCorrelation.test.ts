/**
 * Unit tests for `computeWeatherCorrelation` (Task #1169).
 *
 * Covers the analytics helper that joins per-round shots, course locations,
 * par maps, and historical weather to produce per-bucket SG-Total deltas:
 *
 *   - shots are grouped into rounds by (tournamentId, generalPlayRoundId, round)
 *   - per-round wind / temperature observations land in the correct bucket
 *   - bucket means and the player baseline drive the `sgDelta` calculation
 *   - edge cases: empty window, no wind data, single bucket, mixed deltas
 *
 * `@workspace/db`, `../weather.js`, and `../strokes-gained.js` are mocked via
 * `vi.hoisted` so the suite never touches Postgres or the live Open-Meteo
 * archive (mirroring the pattern in `playsLike.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface MockShot {
  id: number;
  tournamentId: number | null;
  playerId: number | null;
  generalPlayRoundId: number | null;
  userId: number | null;
  round: number;
  holeNumber: number;
  shotNumber: number;
  shotType: string;
  club: string | null;
  lieType: string | null;
  missDirection: string | null;
  distanceToPin: string | null;
  distanceCarried: string | null;
  recordedAt: Date;
}
interface MockTournament { id: number; courseId: number | null; startDate: Date | null; }
interface MockGenPlayRound { id: number; courseId: number; playedAt: Date; }
interface MockCourse { id: number; latitude: string | null; longitude: string | null; }
interface MockHoleDetail { courseId: number; holeNumber: number; par: number; }
interface MockCaddieRec {
  userId: number;
  tournamentId: number | null;
  generalPlayRoundId: number | null;
  round: number;
  temperature: number | null;
  humidity?: number | null;
  precipitation?: number | null;
}
interface MockRoundWeatherCache {
  tournamentId: number | null;
  generalPlayRoundId: number | null;
  round: number;
  temperatureMean: number | null;
  windSpeedMax: number | null;
}

interface MockState {
  shots: MockShot[];
  tournaments: MockTournament[];
  genPlayRounds: MockGenPlayRound[];
  courses: MockCourse[];
  holeDetails: MockHoleDetail[];
  caddieRecs: MockCaddieRec[];
  weatherCache: MockRoundWeatherCache[];
  weather: Map<string, { wind: number | null; temp: number | null }>;
  sgByRoundKey: Map<string, number | null>;
  /**
   * Optional cutoff (epoch ms). When set, the shots-table mock returns only
   * rows whose `recordedAt` is >= the cutoff, simulating the `gte(...)`
   * predicate the production code applies. Tests that need to exercise
   * window-exclusion behavior set this; everyone else leaves it null.
   */
  shotsSinceMs: number | null;
}

const mocks = vi.hoisted(() => {
  const state: MockState = {
    shots: [],
    tournaments: [],
    genPlayRounds: [],
    courses: [],
    holeDetails: [],
    caddieRecs: [],
    weatherCache: [],
    weather: new Map(),
    sgByRoundKey: new Map(),
    shotsSinceMs: null,
  };
  // Plain marker objects stand in for the drizzle table refs; column-key
  // attributes are added below so `shotsTable.userId` etc. don't blow up.
  const shotsTable: Record<string, unknown> = { __name: "shots" };
  const tournamentsTable: Record<string, unknown> = { __name: "tournaments" };
  const generalPlayRoundsTable: Record<string, unknown> = { __name: "generalPlayRounds" };
  const holeDetailsTable: Record<string, unknown> = { __name: "holeDetails" };
  const coursesTable: Record<string, unknown> = { __name: "courses" };
  const caddieRecommendationsTable: Record<string, unknown> = { __name: "caddieRecommendations" };
  const roundWeatherCacheTable: Record<string, unknown> = { __name: "roundWeatherCache" };
  for (const k of [
    "id","tournamentId","playerId","generalPlayRoundId","userId","round",
    "holeNumber","shotNumber","shotType","club","lieType","missDirection",
    "distanceToPin","distanceCarried","recordedAt",
  ]) shotsTable[k] = { __col: k };
  for (const k of ["id","courseId","startDate"]) tournamentsTable[k] = { __col: k };
  for (const k of ["id","courseId","playedAt"]) generalPlayRoundsTable[k] = { __col: k };
  for (const k of ["id","latitude","longitude"]) coursesTable[k] = { __col: k };
  for (const k of ["courseId","holeNumber","par"]) holeDetailsTable[k] = { __col: k };
  for (const k of ["userId","tournamentId","generalPlayRoundId","round","temperature","humidity","precipitation"]) {
    caddieRecommendationsTable[k] = { __col: k };
  }
  for (const k of ["tournamentId","generalPlayRoundId","round","temperatureMean","windSpeedMax"]) {
    roundWeatherCacheTable[k] = { __col: k };
  }
  return {
    state,
    shotsTable,
    tournamentsTable,
    generalPlayRoundsTable,
    holeDetailsTable,
    coursesTable,
    caddieRecommendationsTable,
    roundWeatherCacheTable,
  };
});

vi.mock("@workspace/db", () => {
  const { state, shotsTable, tournamentsTable, generalPlayRoundsTable,
          holeDetailsTable, coursesTable, caddieRecommendationsTable,
          roundWeatherCacheTable } = mocks;

  function rowsFor(t: unknown): unknown[] {
    if (t === shotsTable) {
      // Honor the configured `recordedAt >= since` cutoff so tests can
      // exercise the lib's window filter even though we don't crack the
      // drizzle predicate apart.
      const cutoff = state.shotsSinceMs;
      if (cutoff === null) return state.shots.slice();
      return state.shots.filter(s => s.recordedAt.getTime() >= cutoff);
    }
    if (t === tournamentsTable) return state.tournaments.slice();
    if (t === generalPlayRoundsTable) return state.genPlayRounds.slice();
    if (t === coursesTable) return state.courses.slice();
    if (t === holeDetailsTable) return state.holeDetails.slice();
    if (t === roundWeatherCacheTable) {
      // The lib's cache lookup expects (temperature_mean, wind_speed_max)
      // back as numeric strings (drizzle's runtime shape). Expose a
      // simple flat list — the lib filters by the matching tournament/gp
      // ids inside the same query, but our mock returns everything and
      // relies on the lib's per-round key matching to do the filtering.
      return state.weatherCache.map(r => ({
        tournamentId: r.tournamentId,
        generalPlayRoundId: r.generalPlayRoundId,
        round: r.round,
        temperatureMean: r.temperatureMean !== null ? String(r.temperatureMean) : null,
        windSpeedMax:    r.windSpeedMax    !== null ? String(r.windSpeedMax)    : null,
      }));
    }
    if (t === caddieRecommendationsTable) {
      // Aggregate caddie recommendations into one row per
      // (tournamentId, generalPlayRoundId, round) bucket with avgTemp /
      // avgHumidity / avgPrecip, mirroring the GROUP BY in the production
      // query. Each numeric column is exposed as a string (the lib parses
      // with parseFloat) so this matches Drizzle's runtime shape. AVG()
      // ignores nulls in SQL, so we only count non-null contributions per
      // column. Rows where every weather column is null are excluded —
      // matching the production WHERE clause.
      interface AggBucket {
        tournamentId: number | null;
        generalPlayRoundId: number | null;
        round: number;
        tempSum: number; tempCount: number;
        humSum: number;  humCount: number;
        prcSum: number;  prcCount: number;
      }
      const groups = new Map<string, AggBucket>();
      for (const r of state.caddieRecs) {
        const tOk = r.temperature !== null && Number.isFinite(r.temperature);
        const hOk = r.humidity != null && Number.isFinite(r.humidity);
        const pOk = r.precipitation != null && Number.isFinite(r.precipitation);
        if (!tOk && !hOk && !pOk) continue;
        const key = `${r.tournamentId ?? "g"}-${r.generalPlayRoundId ?? "t"}-${r.round}`;
        const cur = groups.get(key) ?? {
          tournamentId: r.tournamentId,
          generalPlayRoundId: r.generalPlayRoundId,
          round: r.round,
          tempSum: 0, tempCount: 0,
          humSum: 0,  humCount: 0,
          prcSum: 0,  prcCount: 0,
        };
        if (tOk) { cur.tempSum += r.temperature!; cur.tempCount++; }
        if (hOk) { cur.humSum  += r.humidity!;    cur.humCount++; }
        if (pOk) { cur.prcSum  += r.precipitation!; cur.prcCount++; }
        groups.set(key, cur);
      }
      return [...groups.values()].map(g => ({
        tournamentId: g.tournamentId,
        generalPlayRoundId: g.generalPlayRoundId,
        round: g.round,
        avgTemp:     g.tempCount > 0 ? String(g.tempSum / g.tempCount) : null,
        avgHumidity: g.humCount  > 0 ? String(g.humSum  / g.humCount)  : null,
        avgPrecip:   g.prcCount  > 0 ? String(g.prcSum  / g.prcCount)  : null,
      }));
    }
    return [];
  }

  // Thenable that lets the lib chain `.where(...).groupBy(...)` and still
  // await the eventual promise. `.where()` returns a thenable that ALSO
  // exposes `.groupBy()`, returning the same row set either way.
  function thenable(t: unknown): { groupBy: (...args: unknown[]) => Promise<unknown[]>; then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) => Promise<unknown> } {
    const settle = () => Promise.resolve(rowsFor(t));
    return {
      groupBy: () => settle(),
      then: (resolve, reject) => settle().then(resolve, reject),
    };
  }

  const db = {
    select: () => ({
      from: (t: unknown) => ({
        where: () => thenable(t),
      }),
    }),
  };
  return {
    db,
    shotsTable,
    tournamentsTable,
    generalPlayRoundsTable,
    holeDetailsTable,
    coursesTable,
    caddieRecommendationsTable,
    roundWeatherCacheTable,
  };
});

vi.mock("../weather.js", () => ({
  getHistoricalWeather: vi.fn(async (lat: number, lng: number, date: string) => {
    const key = `${lat.toFixed(2)},${lng.toFixed(2)},${date}`;
    const got = mocks.state.weather.get(key);
    return {
      date,
      temperatureMean: got?.temp ?? null,
      windSpeedMax: got?.wind ?? null,
    };
  }),
}));

vi.mock("../strokes-gained.js", () => ({
  computeRoundSGFromShots: vi.fn((r: { tournamentId: number; round: number; shots: MockShot[] }) => {
    const first = r.shots[0];
    const sgKey = `${first.tournamentId ?? "g"}-${first.generalPlayRoundId ?? "t"}-${r.round}`;
    const sgTotal = mocks.state.sgByRoundKey.has(sgKey)
      ? mocks.state.sgByRoundKey.get(sgKey)!
      : null;
    return {
      tournamentId: r.tournamentId,
      round: r.round,
      sgPutting: null, sgApproach: null, sgATG: null, sgOTT: null,
      sgTotal,
      shotsTracked: r.shots.length,
      sgPuttingSource: null,
    };
  }),
}));

import { computeWeatherCorrelation } from "../weatherCorrelation.js";

let shotIdCounter = 0;
let dayCounter = 0;

function nextDate(): string {
  // Each unsalted call gets its own day so the per-round weather key is
  // unique. Dates are anchored relative to "now" so the suite stays inside
  // the lib's default 30-day trailing window no matter when CI runs.
  dayCounter++;
  const d = new Date(Date.now() - dayCounter * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

interface AddRoundOpts {
  tournamentId?: number | null;
  generalPlayRoundId?: number | null;
  round?: number;
  courseId?: number;
  date?: string;          // YYYY-MM-DD (UTC)
  lat?: number;
  lng?: number;
  wind?: number | null;
  temp?: number | null;
  sgTotal?: number | null;
  shotCount?: number;     // how many shots to push (default 1)
}

function addRound(o: AddRoundOpts = {}) {
  const tournamentId = o.tournamentId ?? null;
  const generalPlayRoundId = o.generalPlayRoundId ?? (tournamentId === null ? 100 : null);
  const round = o.round ?? 1;
  const courseId = o.courseId ?? 1;
  const date = o.date ?? nextDate();
  const lat = o.lat ?? 37.77;
  const lng = o.lng ?? -122.42;
  const shotCount = o.shotCount ?? 1;

  for (let i = 0; i < shotCount; i++) {
    mocks.state.shots.push({
      id: ++shotIdCounter,
      tournamentId,
      playerId: null,
      generalPlayRoundId,
      userId: 1,
      round,
      holeNumber: 1,
      shotNumber: i + 1,
      shotType: "tee",
      club: null,
      lieType: null,
      missDirection: null,
      distanceToPin: null,
      distanceCarried: null,
      recordedAt: new Date(`${date}T12:00:00Z`),
    });
  }

  if (tournamentId !== null && !mocks.state.tournaments.some(t => t.id === tournamentId)) {
    mocks.state.tournaments.push({
      id: tournamentId,
      courseId,
      startDate: new Date(`${date}T12:00:00Z`),
    });
  }
  if (generalPlayRoundId !== null && !mocks.state.genPlayRounds.some(g => g.id === generalPlayRoundId)) {
    mocks.state.genPlayRounds.push({
      id: generalPlayRoundId,
      courseId,
      playedAt: new Date(`${date}T12:00:00Z`),
    });
  }
  if (!mocks.state.courses.some(c => c.id === courseId)) {
    mocks.state.courses.push({ id: courseId, latitude: String(lat), longitude: String(lng) });
  }

  // Weather lookup is keyed exactly the way the lib computes it.
  const weatherKey = `${lat.toFixed(2)},${lng.toFixed(2)},${date}`;
  if (o.wind !== undefined || o.temp !== undefined) {
    mocks.state.weather.set(weatherKey, {
      wind: o.wind ?? null,
      temp: o.temp ?? null,
    });
  }

  const sgKey = `${tournamentId ?? "g"}-${generalPlayRoundId ?? "t"}-${round}`;
  mocks.state.sgByRoundKey.set(sgKey, o.sgTotal ?? null);
}

beforeEach(() => {
  mocks.state.shots = [];
  mocks.state.tournaments = [];
  mocks.state.genPlayRounds = [];
  mocks.state.courses = [];
  mocks.state.holeDetails = [];
  mocks.state.caddieRecs = [];
  mocks.state.weather.clear();
  mocks.state.sgByRoundKey.clear();
  mocks.state.weatherCache = [];
  mocks.state.caddieRecs = [];
  mocks.state.shotsSinceMs = null;
  shotIdCounter = 0;
  dayCounter = 0;
});

describe("computeWeatherCorrelation — round grouping", () => {
  it("groups shots by (tournamentId, generalPlayRoundId, round) into distinct rounds", async () => {
    // Same tournament, two rounds → two groups.
    addRound({ tournamentId: 10, round: 1, sgTotal: 1.0, wind: 5, temp: 18, shotCount: 3 });
    addRound({ tournamentId: 10, round: 2, sgTotal: -1.0, wind: 5, temp: 18, shotCount: 4 });
    // Different tournament, same round number → still distinct.
    addRound({ tournamentId: 11, round: 1, sgTotal: 0.5, wind: 5, temp: 18 });
    // General-play round → a fourth group.
    addRound({ generalPlayRoundId: 200, round: 1, sgTotal: -0.5, wind: 5, temp: 18 });

    const out = await computeWeatherCorrelation(1);

    expect(out.baselineRoundCount).toBe(4);
    // baseline = (1.0 + -1.0 + 0.5 + -0.5) / 4 = 0
    expect(out.baselineSgTotal).toBe(0);
    // All four rounds had wind=5 → land in the "Calm <10 km/h" bucket.
    const calm = out.windBuckets.find(b => b.label === "Calm <10 km/h")!;
    expect(calm.rounds).toBe(4);
  });

  it("returns the configured window range and clamps windowDays into [1, 365]", async () => {
    const tooBig = await computeWeatherCorrelation(1, { windowDays: 9999 });
    expect(tooBig.windowDays).toBe(365);
    const tooSmall = await computeWeatherCorrelation(1, { windowDays: 0 });
    expect(tooSmall.windowDays).toBe(1);
    const ok = await computeWeatherCorrelation(1, { windowDays: 60 });
    expect(ok.windowDays).toBe(60);
  });
});

describe("computeWeatherCorrelation — wind bucketing", () => {
  it("places each round into its correct wind bucket (with min-inclusive boundaries)", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal: 0,  wind: 5,  temp: null });   // Calm
    addRound({ tournamentId: 2, round: 1, sgTotal: 0,  wind: 10, temp: null });   // 10-20 (boundary: min=10 inclusive)
    addRound({ tournamentId: 3, round: 1, sgTotal: 0,  wind: 15, temp: null });   // 10-20
    addRound({ tournamentId: 4, round: 1, sgTotal: 0,  wind: 25, temp: null });   // 20-30
    addRound({ tournamentId: 5, round: 1, sgTotal: 0,  wind: 45, temp: null });   // 30+

    const out = await computeWeatherCorrelation(1);

    const byLabel = Object.fromEntries(out.windBuckets.map(b => [b.label, b]));
    expect(byLabel["Calm <10 km/h"].rounds).toBe(1);
    expect(byLabel["10-20 km/h"].rounds).toBe(2);
    expect(byLabel["20-30 km/h"].rounds).toBe(1);
    expect(byLabel["30+ km/h"].rounds).toBe(1);
  });

  it("exposes the four canonical wind buckets in order", async () => {
    const out = await computeWeatherCorrelation(1);
    expect(out.windBuckets.map(b => b.label)).toEqual([
      "Calm <10 km/h",
      "10-20 km/h",
      "20-30 km/h",
      "30+ km/h",
    ]);
  });
});

describe("computeWeatherCorrelation — SG delta math", () => {
  it("computes per-bucket mean and subtracts the player baseline", async () => {
    // Baseline rounds (heavy-wind) with SG = -2 and -1.
    addRound({ tournamentId: 1, round: 1, sgTotal: -2, wind: 25, temp: null });
    addRound({ tournamentId: 2, round: 1, sgTotal: -1, wind: 25, temp: null });
    // Calm rounds with SG = +2 and +1.
    addRound({ tournamentId: 3, round: 1, sgTotal:  2, wind: 5,  temp: null });
    addRound({ tournamentId: 4, round: 1, sgTotal:  1, wind: 5,  temp: null });

    const out = await computeWeatherCorrelation(1);

    expect(out.baselineRoundCount).toBe(4);
    expect(out.baselineSgTotal).toBe(0); // (-2 + -1 + 2 + 1) / 4 = 0
    const calm = out.windBuckets.find(b => b.label === "Calm <10 km/h")!;
    const heavy = out.windBuckets.find(b => b.label === "20-30 km/h")!;
    expect(calm.rounds).toBe(2);
    expect(calm.meanSgTotal).toBe(1.5);   // (2 + 1) / 2
    expect(calm.sgDelta).toBe(1.5);       // 1.5 - 0
    expect(heavy.rounds).toBe(2);
    expect(heavy.meanSgTotal).toBe(-1.5); // (-2 + -1) / 2
    expect(heavy.sgDelta).toBe(-1.5);     // -1.5 - 0
  });

  it("rounds bucket means and deltas to two decimals", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal: 1 / 3, wind: 5, temp: null });
    addRound({ tournamentId: 2, round: 1, sgTotal: 2 / 3, wind: 5, temp: null });
    const out = await computeWeatherCorrelation(1);
    const calm = out.windBuckets.find(b => b.label === "Calm <10 km/h")!;
    // mean = 0.5, baseline = 0.5, delta = 0 → all rounded to 2 decimals.
    expect(calm.meanSgTotal).toBe(0.5);
    expect(out.baselineSgTotal).toBe(0.5);
    expect(calm.sgDelta).toBe(0);
  });

  it("produces both positive and negative deltas across buckets", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal: -3, wind: 35, temp: null });
    addRound({ tournamentId: 2, round: 1, sgTotal: -1, wind: 35, temp: null });
    addRound({ tournamentId: 3, round: 1, sgTotal:  1, wind: 15, temp: null });
    addRound({ tournamentId: 4, round: 1, sgTotal:  3, wind: 5,  temp: null });

    const out = await computeWeatherCorrelation(1);

    expect(out.baselineRoundCount).toBe(4);
    expect(out.baselineSgTotal).toBe(0); // (-3 + -1 + 1 + 3) / 4

    const byLabel = Object.fromEntries(out.windBuckets.map(b => [b.label, b]));
    expect(byLabel["Calm <10 km/h"].sgDelta).toBe(3);   // 3 - 0
    expect(byLabel["10-20 km/h"].sgDelta).toBe(1);      // 1 - 0
    expect(byLabel["30+ km/h"].sgDelta).toBe(-2);       // (-3 + -1) / 2 - 0
    // Bucket with no rounds → delta is null even though baseline exists.
    expect(byLabel["20-30 km/h"].rounds).toBe(0);
    expect(byLabel["20-30 km/h"].meanSgTotal).toBeNull();
    expect(byLabel["20-30 km/h"].sgDelta).toBeNull();
  });
});

describe("computeWeatherCorrelation — temperature buckets", () => {
  it("flags temperatureAvailable=false when no round has a temperature observation", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal: 0, wind: 15, temp: null });
    const out = await computeWeatherCorrelation(1);
    expect(out.temperatureAvailable).toBe(false);
    for (const b of out.temperatureBuckets) expect(b.rounds).toBe(0);
  });

  it("buckets rounds by temperature when observations are present", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal:  1, wind: null, temp: 5  }); // Cold
    addRound({ tournamentId: 2, round: 1, sgTotal:  0, wind: null, temp: 15 }); // Mild
    addRound({ tournamentId: 3, round: 1, sgTotal: -1, wind: null, temp: 25 }); // Warm
    addRound({ tournamentId: 4, round: 1, sgTotal: -2, wind: null, temp: 35 }); // Hot

    const out = await computeWeatherCorrelation(1);

    expect(out.temperatureAvailable).toBe(true);
    const byLabel = Object.fromEntries(out.temperatureBuckets.map(b => [b.label, b]));
    expect(byLabel["Cold <10°C"].rounds).toBe(1);
    expect(byLabel["Mild 10-20°C"].rounds).toBe(1);
    expect(byLabel["Warm 20-30°C"].rounds).toBe(1);
    expect(byLabel["Hot 30+°C"].rounds).toBe(1);
    // Temperature buckets remain populated even though no round had wind data.
    for (const b of out.windBuckets) expect(b.rounds).toBe(0);
  });

  it("lets persisted caddie-recommendation temperatures override the archive value", async () => {
    // Archive says the round was 5°C (Cold). The persisted recordings average
    // to ((28 + 32) / 2) = 30°C → bucket should jump to Hot.
    addRound({ tournamentId: 7, round: 1, sgTotal: 0, wind: null, temp: 5 });
    mocks.state.caddieRecs.push(
      { userId: 1, tournamentId: 7, generalPlayRoundId: null, round: 1, temperature: 28 },
      { userId: 1, tournamentId: 7, generalPlayRoundId: null, round: 1, temperature: 32 },
    );

    const out = await computeWeatherCorrelation(1);

    expect(out.temperatureAvailable).toBe(true);
    const byLabel = Object.fromEntries(out.temperatureBuckets.map(b => [b.label, b]));
    expect(byLabel["Cold <10°C"].rounds).toBe(0);
    expect(byLabel["Hot 30+°C"].rounds).toBe(1);
  });

  it("uses persisted temperatures even when the archive returned no temperature", async () => {
    // No archive temp at all — only the persisted recordings carry data.
    addRound({ tournamentId: 8, round: 1, sgTotal: 1, wind: null, temp: null });
    mocks.state.caddieRecs.push(
      { userId: 1, tournamentId: 8, generalPlayRoundId: null, round: 1, temperature: 12 },
      { userId: 1, tournamentId: 8, generalPlayRoundId: null, round: 1, temperature: 14 },
    );

    const out = await computeWeatherCorrelation(1);

    expect(out.temperatureAvailable).toBe(true);
    const byLabel = Object.fromEntries(out.temperatureBuckets.map(b => [b.label, b]));
    // (12 + 14) / 2 = 13°C → Mild bucket.
    expect(byLabel["Mild 10-20°C"].rounds).toBe(1);
  });
});

// Task #1347 — humidity & precipitation buckets are populated only from
// persisted caddie_recommendations (the historical archive doesn't expose
// them), so the tests below seed `mocks.state.caddieRecs` directly.
describe("computeWeatherCorrelation — humidity buckets", () => {
  it("flags humidityAvailable=false and reports four empty humidity buckets when no rounds carry humidity", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal: 0, wind: 5, temp: 18 });
    const out = await computeWeatherCorrelation(1);
    expect(out.humidityAvailable).toBe(false);
    expect(out.humidityBuckets.map(b => b.label)).toEqual([
      "Dry <40%",
      "Comfortable 40-60%",
      "Humid 60-80%",
      "Muggy 80%+",
    ]);
    for (const b of out.humidityBuckets) {
      expect(b.rounds).toBe(0);
      expect(b.meanSgTotal).toBeNull();
      expect(b.sgDelta).toBeNull();
    }
  });

  it("buckets rounds by their averaged persisted humidity reading", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal:  1, wind: null, temp: null });
    addRound({ tournamentId: 2, round: 1, sgTotal:  0, wind: null, temp: null });
    addRound({ tournamentId: 3, round: 1, sgTotal: -1, wind: null, temp: null });
    addRound({ tournamentId: 4, round: 1, sgTotal: -2, wind: null, temp: null });
    mocks.state.caddieRecs.push(
      { userId: 1, tournamentId: 1, generalPlayRoundId: null, round: 1, temperature: null, humidity: 30 }, // Dry
      { userId: 1, tournamentId: 2, generalPlayRoundId: null, round: 1, temperature: null, humidity: 50 }, // Comfortable
      { userId: 1, tournamentId: 3, generalPlayRoundId: null, round: 1, temperature: null, humidity: 70 }, // Humid
      { userId: 1, tournamentId: 4, generalPlayRoundId: null, round: 1, temperature: null, humidity: 90 }, // Muggy
    );

    const out = await computeWeatherCorrelation(1);

    expect(out.humidityAvailable).toBe(true);
    const byLabel = Object.fromEntries(out.humidityBuckets.map(b => [b.label, b]));
    expect(byLabel["Dry <40%"].rounds).toBe(1);
    expect(byLabel["Comfortable 40-60%"].rounds).toBe(1);
    expect(byLabel["Humid 60-80%"].rounds).toBe(1);
    expect(byLabel["Muggy 80%+"].rounds).toBe(1);
  });

  it("averages multiple recommendations per round before bucketing humidity", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal: 0, wind: null, temp: null });
    // (75 + 85) / 2 = 80 → boundary lands in "Muggy 80%+" (min-inclusive).
    mocks.state.caddieRecs.push(
      { userId: 1, tournamentId: 1, generalPlayRoundId: null, round: 1, temperature: null, humidity: 75 },
      { userId: 1, tournamentId: 1, generalPlayRoundId: null, round: 1, temperature: null, humidity: 85 },
    );
    const out = await computeWeatherCorrelation(1);
    const byLabel = Object.fromEntries(out.humidityBuckets.map(b => [b.label, b]));
    expect(byLabel["Muggy 80%+"].rounds).toBe(1);
    expect(byLabel["Humid 60-80%"].rounds).toBe(0);
  });

  it("computes sgDelta vs the player baseline for humidity buckets", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal:  2, wind: null, temp: null }); // Dry
    addRound({ tournamentId: 2, round: 1, sgTotal: -2, wind: null, temp: null }); // Muggy
    mocks.state.caddieRecs.push(
      { userId: 1, tournamentId: 1, generalPlayRoundId: null, round: 1, temperature: null, humidity: 25 },
      { userId: 1, tournamentId: 2, generalPlayRoundId: null, round: 1, temperature: null, humidity: 95 },
    );
    const out = await computeWeatherCorrelation(1);
    expect(out.baselineSgTotal).toBe(0); // (2 + -2) / 2
    const byLabel = Object.fromEntries(out.humidityBuckets.map(b => [b.label, b]));
    expect(byLabel["Dry <40%"].sgDelta).toBe(2);
    expect(byLabel["Muggy 80%+"].sgDelta).toBe(-2);
  });
});

describe("computeWeatherCorrelation — precipitation buckets", () => {
  it("exposes the four canonical precipitation buckets in order even when empty", async () => {
    const out = await computeWeatherCorrelation(1);
    expect(out.precipitationAvailable).toBe(false);
    expect(out.precipitationBuckets.map(b => b.label)).toEqual([
      "Dry <0.1mm",
      "Light 0.1-2mm",
      "Moderate 2-10mm",
      "Heavy 10mm+",
    ]);
  });

  it("places a 0mm reading into the Dry bucket (min-inclusive on 0)", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal: 0, wind: null, temp: null });
    mocks.state.caddieRecs.push(
      { userId: 1, tournamentId: 1, generalPlayRoundId: null, round: 1, temperature: null, precipitation: 0 },
    );
    const out = await computeWeatherCorrelation(1);
    expect(out.precipitationAvailable).toBe(true);
    const byLabel = Object.fromEntries(out.precipitationBuckets.map(b => [b.label, b]));
    expect(byLabel["Dry <0.1mm"].rounds).toBe(1);
  });

  it("buckets rounds across all four precipitation ranges", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal:  1, wind: null, temp: null });
    addRound({ tournamentId: 2, round: 1, sgTotal:  0, wind: null, temp: null });
    addRound({ tournamentId: 3, round: 1, sgTotal: -1, wind: null, temp: null });
    addRound({ tournamentId: 4, round: 1, sgTotal: -3, wind: null, temp: null });
    mocks.state.caddieRecs.push(
      { userId: 1, tournamentId: 1, generalPlayRoundId: null, round: 1, temperature: null, precipitation: 0    }, // Dry
      { userId: 1, tournamentId: 2, generalPlayRoundId: null, round: 1, temperature: null, precipitation: 0.5  }, // Light
      { userId: 1, tournamentId: 3, generalPlayRoundId: null, round: 1, temperature: null, precipitation: 5    }, // Moderate
      { userId: 1, tournamentId: 4, generalPlayRoundId: null, round: 1, temperature: null, precipitation: 25   }, // Heavy
    );
    const out = await computeWeatherCorrelation(1);
    expect(out.precipitationAvailable).toBe(true);
    const byLabel = Object.fromEntries(out.precipitationBuckets.map(b => [b.label, b]));
    expect(byLabel["Dry <0.1mm"].rounds).toBe(1);
    expect(byLabel["Light 0.1-2mm"].rounds).toBe(1);
    expect(byLabel["Moderate 2-10mm"].rounds).toBe(1);
    expect(byLabel["Heavy 10mm+"].rounds).toBe(1);
  });

  it("computes sgDelta vs the player baseline for precipitation buckets", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal:  2, wind: null, temp: null }); // Dry
    addRound({ tournamentId: 2, round: 1, sgTotal: -2, wind: null, temp: null }); // Heavy
    mocks.state.caddieRecs.push(
      { userId: 1, tournamentId: 1, generalPlayRoundId: null, round: 1, temperature: null, precipitation: 0 },
      { userId: 1, tournamentId: 2, generalPlayRoundId: null, round: 1, temperature: null, precipitation: 15 },
    );
    const out = await computeWeatherCorrelation(1);
    expect(out.baselineSgTotal).toBe(0);
    const byLabel = Object.fromEntries(out.precipitationBuckets.map(b => [b.label, b]));
    expect(byLabel["Dry <0.1mm"].sgDelta).toBe(2);
    expect(byLabel["Heavy 10mm+"].sgDelta).toBe(-2);
  });

  it("ignores caddie_recommendation rows that are weather-empty for both humidity and precipitation", async () => {
    // A row with all three weather columns null shouldn't materialize a
    // bucket assignment. The round still contributes to the baseline
    // through its shots but neither humidity nor precip should fire.
    addRound({ tournamentId: 1, round: 1, sgTotal: 1, wind: null, temp: null });
    mocks.state.caddieRecs.push(
      { userId: 1, tournamentId: 1, generalPlayRoundId: null, round: 1, temperature: null, humidity: null, precipitation: null },
    );
    const out = await computeWeatherCorrelation(1);
    expect(out.humidityAvailable).toBe(false);
    expect(out.precipitationAvailable).toBe(false);
    expect(out.baselineRoundCount).toBe(1);
  });
});

describe("computeWeatherCorrelation — round_weather_cache fallback (Task #1346)", () => {
  it("uses cached temperature when the live archive call returned null", async () => {
    // Simulate an older round whose archive lookup yields nothing on this
    // request (e.g. the in-memory cache was evicted and Open-Meteo
    // hiccupped). The backfill had stored 22°C earlier → Warm bucket.
    addRound({ tournamentId: 20, round: 1, sgTotal: 0, wind: null, temp: null });
    mocks.state.weatherCache.push({
      tournamentId: 20, generalPlayRoundId: null, round: 1,
      temperatureMean: 22, windSpeedMax: null,
    });

    const out = await computeWeatherCorrelation(1);

    expect(out.temperatureAvailable).toBe(true);
    const byLabel = Object.fromEntries(out.temperatureBuckets.map(b => [b.label, b]));
    expect(byLabel["Warm 20-30°C"].rounds).toBe(1);
  });

  it("uses cached wind when the live archive call returned null", async () => {
    addRound({ tournamentId: 21, round: 1, sgTotal: 0, wind: null, temp: null });
    mocks.state.weatherCache.push({
      tournamentId: 21, generalPlayRoundId: null, round: 1,
      temperatureMean: null, windSpeedMax: 25,
    });

    const out = await computeWeatherCorrelation(1);

    const byLabel = Object.fromEntries(out.windBuckets.map(b => [b.label, b]));
    expect(byLabel["20-30 km/h"].rounds).toBe(1);
  });

  it("does not let the cache override a live archive value", async () => {
    // Archive observed 5°C (Cold). Cache has a stale 25°C (Warm) row.
    // The live value wins so the round lands in Cold, not Warm.
    addRound({ tournamentId: 22, round: 1, sgTotal: 0, wind: null, temp: 5 });
    mocks.state.weatherCache.push({
      tournamentId: 22, generalPlayRoundId: null, round: 1,
      temperatureMean: 25, windSpeedMax: null,
    });

    const out = await computeWeatherCorrelation(1);

    const byLabel = Object.fromEntries(out.temperatureBuckets.map(b => [b.label, b]));
    expect(byLabel["Cold <10°C"].rounds).toBe(1);
    expect(byLabel["Warm 20-30°C"].rounds).toBe(0);
  });

  it("lets persisted caddie-recommendation temperatures override the cache", async () => {
    // Cache has 5°C; the on-course recordings average to 30°C and win.
    addRound({ tournamentId: 23, round: 1, sgTotal: 0, wind: null, temp: null });
    mocks.state.weatherCache.push({
      tournamentId: 23, generalPlayRoundId: null, round: 1,
      temperatureMean: 5, windSpeedMax: null,
    });
    mocks.state.caddieRecs.push(
      { userId: 1, tournamentId: 23, generalPlayRoundId: null, round: 1, temperature: 28 },
      { userId: 1, tournamentId: 23, generalPlayRoundId: null, round: 1, temperature: 32 },
    );

    const out = await computeWeatherCorrelation(1);

    const byLabel = Object.fromEntries(out.temperatureBuckets.map(b => [b.label, b]));
    expect(byLabel["Cold <10°C"].rounds).toBe(0);
    expect(byLabel["Hot 30+°C"].rounds).toBe(1);
  });

  it("falls back to the cache for general-play rounds too", async () => {
    addRound({ generalPlayRoundId: 555, round: 1, sgTotal: 0, wind: null, temp: null });
    mocks.state.weatherCache.push({
      tournamentId: null, generalPlayRoundId: 555, round: 1,
      temperatureMean: 15, windSpeedMax: null,
    });

    const out = await computeWeatherCorrelation(1);

    const byLabel = Object.fromEntries(out.temperatureBuckets.map(b => [b.label, b]));
    expect(byLabel["Mild 10-20°C"].rounds).toBe(1);
  });
});

describe("computeWeatherCorrelation — edge cases", () => {
  it("returns null baseline and empty buckets when no rounds fall in the window", async () => {
    const out = await computeWeatherCorrelation(1);
    expect(out.baselineRoundCount).toBe(0);
    expect(out.baselineSgTotal).toBeNull();
    expect(out.temperatureAvailable).toBe(false);
    expect(out.humidityAvailable).toBe(false);
    expect(out.precipitationAvailable).toBe(false);
    for (const acc of [out.windBuckets, out.temperatureBuckets, out.humidityBuckets, out.precipitationBuckets]) {
      for (const b of acc) {
        expect(b.rounds).toBe(0);
        expect(b.meanSgTotal).toBeNull();
        expect(b.sgDelta).toBeNull();
      }
    }
  });

  it("still computes baseline even when no round has wind data", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal:  1, wind: null, temp: null });
    addRound({ tournamentId: 2, round: 1, sgTotal: -1, wind: null, temp: null });
    addRound({ tournamentId: 3, round: 1, sgTotal:  2, wind: null, temp: null });

    const out = await computeWeatherCorrelation(1);

    expect(out.baselineRoundCount).toBe(3);
    // (1 + -1 + 2) / 3 ≈ 0.6667 → rounded to 0.67.
    expect(out.baselineSgTotal).toBe(0.67);
    for (const b of out.windBuckets) {
      expect(b.rounds).toBe(0);
      expect(b.meanSgTotal).toBeNull();
      expect(b.sgDelta).toBeNull();
    }
  });

  it("populates only the matching bucket when every round falls into one wind range", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal: -1, wind: 22, temp: null });
    addRound({ tournamentId: 2, round: 1, sgTotal: -2, wind: 28, temp: null });
    addRound({ tournamentId: 3, round: 1, sgTotal: -3, wind: 24, temp: null });

    const out = await computeWeatherCorrelation(1);

    const byLabel = Object.fromEntries(out.windBuckets.map(b => [b.label, b]));
    expect(byLabel["20-30 km/h"].rounds).toBe(3);
    expect(byLabel["20-30 km/h"].meanSgTotal).toBe(-2); // (-1 + -2 + -3) / 3
    expect(byLabel["20-30 km/h"].sgDelta).toBe(0);      // -2 - (-2) baseline
    expect(byLabel["Calm <10 km/h"].rounds).toBe(0);
    expect(byLabel["10-20 km/h"].rounds).toBe(0);
    expect(byLabel["30+ km/h"].rounds).toBe(0);
  });

  it("excludes rounds whose SG-Total cannot be computed from the baseline and buckets", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal: 2,    wind: 5, temp: null });
    addRound({ tournamentId: 2, round: 1, sgTotal: null, wind: 5, temp: null });

    const out = await computeWeatherCorrelation(1);

    expect(out.baselineRoundCount).toBe(1);
    expect(out.baselineSgTotal).toBe(2);
    const calm = out.windBuckets.find(b => b.label === "Calm <10 km/h")!;
    expect(calm.rounds).toBe(1);
    expect(calm.meanSgTotal).toBe(2);
  });

  it("excludes rounds whose shots fall outside the requested window", async () => {
    // Two rounds: one inside the 30-day window, one 60 days ago. With the
    // mock honoring `recordedAt >= now - 30d`, only the recent round should
    // contribute to the baseline and bucket counts.
    const now = Date.now();
    const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);

    addRound({ tournamentId: 1, round: 1, sgTotal: 1,
               date: fiveDaysAgo, wind: 5, temp: null });
    addRound({ tournamentId: 2, round: 1, sgTotal: -5,
               date: sixtyDaysAgo, wind: 5, temp: null });

    mocks.state.shotsSinceMs = now - 30 * 24 * 60 * 60 * 1000;

    const out = await computeWeatherCorrelation(1, { windowDays: 30 });

    expect(out.baselineRoundCount).toBe(1);
    expect(out.baselineSgTotal).toBe(1);
    const calm = out.windBuckets.find(b => b.label === "Calm <10 km/h")!;
    expect(calm.rounds).toBe(1);
    expect(calm.meanSgTotal).toBe(1);
  });

  // Task #1613 — pendingRoundsCount surfaces rounds whose temperature is
  // still unresolved (Open-Meteo archive lags ~5 days). Tests cover the
  // empty-window default, the "all resolved" zero case, and a mix of
  // resolved + pending baseline-eligible rounds.
  it("reports pendingRoundsCount = 0 when there are no rounds in the window", async () => {
    const out = await computeWeatherCorrelation(1);
    expect(out.pendingRoundsCount).toBe(0);
  });

  it("reports pendingRoundsCount = 0 when every baseline round has a temperature", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal: 1, wind: 5, temp: 18 });
    addRound({ tournamentId: 2, round: 1, sgTotal: 0, wind: 5, temp: 25 });
    const out = await computeWeatherCorrelation(1);
    expect(out.baselineRoundCount).toBe(2);
    expect(out.pendingRoundsCount).toBe(0);
  });

  it("counts baseline-eligible rounds whose temperature has not been resolved", async () => {
    // Two rounds with resolved temperatures, two whose weather lookup
    // returned null (e.g. the archive lag for very recent rounds).
    addRound({ tournamentId: 1, round: 1, sgTotal:  1, wind: 5, temp: 18 });
    addRound({ tournamentId: 2, round: 1, sgTotal:  0, wind: 5, temp: 25 });
    addRound({ tournamentId: 3, round: 1, sgTotal: -1, wind: 5, temp: null });
    addRound({ tournamentId: 4, round: 1, sgTotal:  2, wind: 5, temp: null });
    const out = await computeWeatherCorrelation(1);
    expect(out.baselineRoundCount).toBe(4);
    expect(out.pendingRoundsCount).toBe(2);
  });

  it("does not count rounds with no SG-Total toward pendingRoundsCount", async () => {
    // Round 1 contributes to the baseline but lacks a temperature → pending.
    // Round 2 has no SG-Total → should not count even though temp is null.
    addRound({ tournamentId: 1, round: 1, sgTotal: 1,    wind: 5, temp: null });
    addRound({ tournamentId: 2, round: 1, sgTotal: null, wind: 5, temp: null });
    const out = await computeWeatherCorrelation(1);
    expect(out.baselineRoundCount).toBe(1);
    expect(out.pendingRoundsCount).toBe(1);
  });

  it("does not count rounds whose course has no lat/lng toward pendingRoundsCount", async () => {
    // Round 1: course has location and a missing temperature → genuine pending.
    // Round 2: course has no coordinates, so weather can never be resolved →
    // must NOT be counted as "pending" (the UI says "check back in a few days"
    // and that wouldn't be true for these rounds).
    addRound({ tournamentId: 1, round: 1, sgTotal: 1, wind: 5, temp: null,
               courseId: 1, lat: 37.77, lng: -122.42 });
    addRound({ tournamentId: 2, round: 1, sgTotal: -1, wind: 5, temp: null,
               courseId: 2 });
    const c = mocks.state.courses.find(x => x.id === 2)!;
    c.latitude = null;
    c.longitude = null;

    const out = await computeWeatherCorrelation(1);
    expect(out.baselineRoundCount).toBe(2);
    expect(out.pendingRoundsCount).toBe(1);
  });

  // Task #2003 — pendingWindRoundsCount mirrors pendingRoundsCount but for
  // the wind chart. Wind has no caddie-recommendation override (only the
  // archive + round-weather cache), so its missingness can differ from
  // temperature's. The cases below mirror the temperature tests above and
  // add one that exercises the divergence between the two counters.
  it("reports pendingWindRoundsCount = 0 when there are no rounds in the window", async () => {
    const out = await computeWeatherCorrelation(1);
    expect(out.pendingWindRoundsCount).toBe(0);
  });

  it("reports pendingWindRoundsCount = 0 when every baseline round has wind", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal: 1, wind: 5,  temp: 18 });
    addRound({ tournamentId: 2, round: 1, sgTotal: 0, wind: 15, temp: 25 });
    const out = await computeWeatherCorrelation(1);
    expect(out.baselineRoundCount).toBe(2);
    expect(out.pendingWindRoundsCount).toBe(0);
  });

  it("counts baseline-eligible rounds whose wind has not been resolved", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal:  1, wind: 5,    temp: 18 });
    addRound({ tournamentId: 2, round: 1, sgTotal:  0, wind: 5,    temp: 25 });
    addRound({ tournamentId: 3, round: 1, sgTotal: -1, wind: null, temp: 18 });
    addRound({ tournamentId: 4, round: 1, sgTotal:  2, wind: null, temp: 25 });
    const out = await computeWeatherCorrelation(1);
    expect(out.baselineRoundCount).toBe(4);
    expect(out.pendingWindRoundsCount).toBe(2);
  });

  it("does not count rounds with no SG-Total toward pendingWindRoundsCount", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal: 1,    wind: null, temp: null });
    addRound({ tournamentId: 2, round: 1, sgTotal: null, wind: null, temp: null });
    const out = await computeWeatherCorrelation(1);
    expect(out.baselineRoundCount).toBe(1);
    expect(out.pendingWindRoundsCount).toBe(1);
  });

  it("does not count rounds whose course has no lat/lng toward pendingWindRoundsCount", async () => {
    addRound({ tournamentId: 1, round: 1, sgTotal:  1, wind: null, temp: null,
               courseId: 1, lat: 37.77, lng: -122.42 });
    addRound({ tournamentId: 2, round: 1, sgTotal: -1, wind: null, temp: null,
               courseId: 2 });
    const c = mocks.state.courses.find(x => x.id === 2)!;
    c.latitude = null;
    c.longitude = null;

    const out = await computeWeatherCorrelation(1);
    expect(out.baselineRoundCount).toBe(2);
    expect(out.pendingWindRoundsCount).toBe(1);
  });

  it("tracks wind and temperature pending counts independently when caddie recs cover temp but not wind", async () => {
    // Round 1: archive returned no temp / no wind, but a persisted caddie
    // recommendation supplies the temperature → temp resolved, wind still
    // pending.
    addRound({ tournamentId: 1, round: 1, sgTotal: 1, wind: null, temp: null });
    mocks.state.caddieRecs.push(
      { userId: 1, tournamentId: 1, generalPlayRoundId: null, round: 1, temperature: 18 },
    );
    // Round 2: archive missing both, no caddie override → both pending.
    addRound({ tournamentId: 2, round: 1, sgTotal: 0, wind: null, temp: null });

    const out = await computeWeatherCorrelation(1);

    expect(out.baselineRoundCount).toBe(2);
    // Temperature only pending for round 2 (round 1 was rescued by the
    // persisted caddie reading).
    expect(out.pendingRoundsCount).toBe(1);
    // Wind has no caddie fallback, so both rounds are pending.
    expect(out.pendingWindRoundsCount).toBe(2);
  });

  it("skips rounds whose course has no lat/lng even though SG still counts toward the baseline", async () => {
    // Round 1: course has location → bucketed.
    addRound({ tournamentId: 1, round: 1, sgTotal: 1, wind: 5, temp: null,
               courseId: 1, lat: 37.77, lng: -122.42 });
    // Round 2: same shape, but null lat/lng on courseId 2 → no bucket assignment.
    addRound({ tournamentId: 2, round: 1, sgTotal: -1, wind: 5, temp: null,
               courseId: 2 });
    // Strip the second course's coordinates.
    const c = mocks.state.courses.find(x => x.id === 2)!;
    c.latitude = null;
    c.longitude = null;

    const out = await computeWeatherCorrelation(1);

    expect(out.baselineRoundCount).toBe(2);
    expect(out.baselineSgTotal).toBe(0);
    const calm = out.windBuckets.find(b => b.label === "Calm <10 km/h")!;
    expect(calm.rounds).toBe(1); // only the round with a known course location
  });
});
