/**
 * Weather correlation analytics — Task #1002.
 *
 * For each round in the trailing window we compute the player's SG-Total via
 * the existing strokes-gained helpers, then bucket those rounds by both
 * average wind speed and mean temperature observed during the round.
 *
 * Per-round weather is sourced from Open-Meteo's free archive API
 * (`getHistoricalWeather`), keyed on the course's lat/lng and the round's
 * local-date. Results are cached in-memory for 24h per (lat, lng, date) so
 * the endpoint stays cheap on repeated calls.
 *
 * Returns SG delta (per-bucket mean SG-Total minus the overall window
 * baseline) so the chart shows "how does my scoring shift in heavy wind /
 * cold weather vs my average".
 */

import {
  db,
  shotsTable,
  tournamentsTable,
  generalPlayRoundsTable,
  holeDetailsTable,
  coursesTable,
  caddieRecommendationsTable,
  roundWeatherCacheTable,
} from "@workspace/db";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import {
  computeRoundSGFromShots,
  type RoundShotData,
  type ShotRow,
  type HoleParMap,
} from "./strokes-gained.js";
import { getHistoricalWeather } from "./weather.js";

export interface WeatherBucket {
  /** Human label (e.g. "Calm <10 km/h", "10-20 km/h"). */
  label: string;
  /** Lower bound (inclusive). */
  min: number;
  /** Upper bound (exclusive). */
  max: number;
  /** Number of rounds that fell into this bucket. */
  rounds: number;
  /** Mean SG-Total for the bucket, null when no rounds. */
  meanSgTotal: number | null;
  /** Delta vs the player's window baseline (mean - baseline). */
  sgDelta: number | null;
}

export interface WeatherCorrelationResult {
  windowDays: number;
  windowStart: string;
  /** Player baseline (mean SG-Total across all rounds in window). */
  baselineSgTotal: number | null;
  baselineRoundCount: number;
  windBuckets: WeatherBucket[];
  temperatureBuckets: WeatherBucket[];
  /** Task #1347 — humidity & precipitation buckets, same shape as the others. */
  humidityBuckets: WeatherBucket[];
  precipitationBuckets: WeatherBucket[];
  /** True when at least one round had an observed temperature. */
  temperatureAvailable: boolean;
  /** True when at least one round had an observed humidity reading. */
  humidityAvailable: boolean;
  /** True when at least one round had an observed precipitation reading. */
  precipitationAvailable: boolean;
  /**
   * Task #1613 — number of rounds inside the window that contributed to the
   * baseline (i.e. SG-Total could be computed) but for which no temperature
   * reading has been resolved yet. These rounds are silently missing from the
   * temperature chart because the Open-Meteo archive lags by ~5 days; the UI
   * surfaces this count so the gap is visible to the player.
   */
  pendingRoundsCount: number;
  /**
   * Task #2003 — same idea as `pendingRoundsCount` but for the wind chart.
   * Wind doesn't have the persisted-caddie-reading fallback that temperature
   * uses (step 5b only carries temp/humidity/precip), so wind missingness can
   * differ from temperature missingness for the same round. Tracked
   * independently so the Weather Correlation — Wind card can mirror the same
   * "X rounds pending weather data" hint.
   */
  pendingWindRoundsCount: number;
}

const WIND_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "Calm <10 km/h", min: 0,  max: 10 },
  { label: "10-20 km/h",    min: 10, max: 20 },
  { label: "20-30 km/h",    min: 20, max: 30 },
  { label: "30+ km/h",      min: 30, max: 9999 },
];

const TEMP_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "Cold <10°C",    min: -50, max: 10 },
  { label: "Mild 10-20°C",  min: 10,  max: 20 },
  { label: "Warm 20-30°C",  min: 20,  max: 30 },
  { label: "Hot 30+°C",     min: 30,  max: 99 },
];

// Task #1347 — humidity (% relative) and precipitation (mm last hour) buckets.
// Humidity max=101 so a 100% reading lands in "Muggy 80%+". Precip starts at 0
// inclusive so completely dry rounds register in "Dry <0.1mm".
const HUMIDITY_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "Dry <40%",          min: 0,  max: 40  },
  { label: "Comfortable 40-60%", min: 40, max: 60  },
  { label: "Humid 60-80%",      min: 60, max: 80  },
  { label: "Muggy 80%+",        min: 80, max: 101 },
];

const PRECIP_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "Dry <0.1mm",      min: 0,    max: 0.1   },
  { label: "Light 0.1-2mm",   min: 0.1,  max: 2     },
  { label: "Moderate 2-10mm", min: 2,    max: 10    },
  { label: "Heavy 10mm+",     min: 10,   max: 9999  },
];

interface RoundContext {
  key: string;
  tournamentId: number | null;
  generalPlayRoundId: number | null;
  round: number;
  courseId: number | null;
  playedAt: Date | null;
  shots: ShotRow[];
}

function dateKey(d: Date): string {
  // YYYY-MM-DD in UTC; fine for archive lookup at course-level lat/lng granularity.
  return d.toISOString().slice(0, 10);
}

export async function computeWeatherCorrelation(
  userId: number,
  opts: { windowDays?: number } = {},
): Promise<WeatherCorrelationResult> {
  const windowDays = Math.max(1, Math.min(365, opts.windowDays ?? 30));
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // 1. Pull the player's shots in the window.
  const rows = await db
    .select({
      id: shotsTable.id,
      tournamentId: shotsTable.tournamentId,
      playerId: shotsTable.playerId,
      generalPlayRoundId: shotsTable.generalPlayRoundId,
      userId: shotsTable.userId,
      round: shotsTable.round,
      holeNumber: shotsTable.holeNumber,
      shotNumber: shotsTable.shotNumber,
      shotType: shotsTable.shotType,
      club: shotsTable.club,
      lieType: shotsTable.lieType,
      missDirection: shotsTable.missDirection,
      distanceToPin: shotsTable.distanceToPin,
      distanceCarried: shotsTable.distanceCarried,
      recordedAt: shotsTable.recordedAt,
    })
    .from(shotsTable)
    .where(and(
      eq(shotsTable.userId, userId),
      gte(shotsTable.recordedAt, since),
    ));

  // 2. Group into rounds.
  const groups = new Map<string, RoundContext>();
  for (const r of rows) {
    const key = `${r.tournamentId ?? "g"}-${r.generalPlayRoundId ?? "t"}-${r.round}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        tournamentId: r.tournamentId,
        generalPlayRoundId: r.generalPlayRoundId,
        round: r.round,
        courseId: null,
        playedAt: null,
        shots: [],
      });
    }
    groups.get(key)!.shots.push(r as ShotRow);
  }

  // 3. Resolve courseId + playedAt per round.
  const tIds = [...new Set([...groups.values()].map(g => g.tournamentId).filter((v): v is number => v !== null))];
  const gpIds = [...new Set([...groups.values()].map(g => g.generalPlayRoundId).filter((v): v is number => v !== null))];
  const tInfo = new Map<number, { courseId: number | null; startDate: Date | null }>();
  const gInfo = new Map<number, { courseId: number; playedAt: Date }>();
  if (tIds.length > 0) {
    const t = await db.select({
      id: tournamentsTable.id,
      courseId: tournamentsTable.courseId,
      startDate: tournamentsTable.startDate,
    }).from(tournamentsTable).where(inArray(tournamentsTable.id, tIds));
    for (const row of t) tInfo.set(row.id, { courseId: row.courseId, startDate: row.startDate });
  }
  if (gpIds.length > 0) {
    const g = await db.select({
      id: generalPlayRoundsTable.id,
      courseId: generalPlayRoundsTable.courseId,
      playedAt: generalPlayRoundsTable.playedAt,
    }).from(generalPlayRoundsTable).where(inArray(generalPlayRoundsTable.id, gpIds));
    for (const row of g) gInfo.set(row.id, { courseId: row.courseId, playedAt: row.playedAt });
  }
  for (const g of groups.values()) {
    if (g.tournamentId && tInfo.has(g.tournamentId)) {
      const t = tInfo.get(g.tournamentId)!;
      g.courseId = t.courseId;
      g.playedAt = t.startDate;
    } else if (g.generalPlayRoundId && gInfo.has(g.generalPlayRoundId)) {
      const gp = gInfo.get(g.generalPlayRoundId)!;
      g.courseId = gp.courseId;
      g.playedAt = gp.playedAt;
    }
    // Fall-back: if round date is unknown, use the latest shot recordedAt.
    if (!g.playedAt && g.shots.length > 0) {
      const latest = g.shots
        .map(s => s.recordedAt as Date | null)
        .filter((d): d is Date => d instanceof Date)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      if (latest) g.playedAt = latest;
    }
  }

  // 4. Resolve course locations + par maps.
  const courseIds = [...new Set([...groups.values()].map(g => g.courseId).filter((v): v is number => v !== null))];
  const courseLoc = new Map<number, { lat: number; lng: number } | null>();
  const parsByCourse = new Map<number, HoleParMap>();
  if (courseIds.length > 0) {
    const courses = await db.select({
      id: coursesTable.id,
      latitude: coursesTable.latitude,
      longitude: coursesTable.longitude,
    }).from(coursesTable).where(inArray(coursesTable.id, courseIds));
    for (const c of courses) {
      const lat = c.latitude !== null ? parseFloat(String(c.latitude)) : NaN;
      const lng = c.longitude !== null ? parseFloat(String(c.longitude)) : NaN;
      courseLoc.set(c.id, Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null);
    }
    const pars = await db.select({
      courseId: holeDetailsTable.courseId,
      holeNumber: holeDetailsTable.holeNumber,
      par: holeDetailsTable.par,
    }).from(holeDetailsTable).where(inArray(holeDetailsTable.courseId, courseIds));
    for (const p of pars) {
      if (!parsByCourse.has(p.courseId)) parsByCourse.set(p.courseId, new Map());
      parsByCourse.get(p.courseId)!.set(p.holeNumber, p.par);
    }
  }

  // 5. Fetch per-round historical weather (one call per unique
  //    (lat, lng, date)). Concurrency capped via Promise.all on the
  //    deduped key set; the in-module cache covers repeats across calls.
  interface RoundWeather { wind: number | null; temp: number | null; }
  const weatherByRound = new Map<string, RoundWeather>();
  const fetchKeys = new Map<string, { lat: number; lng: number; date: string }>();
  for (const g of groups.values()) {
    if (!g.courseId || !g.playedAt) continue;
    const loc = courseLoc.get(g.courseId);
    if (!loc) continue;
    const date = dateKey(g.playedAt);
    fetchKeys.set(`${loc.lat.toFixed(2)},${loc.lng.toFixed(2)},${date}`, { ...loc, date });
  }
  const fetched = new Map<string, { wind: number | null; temp: number | null }>();
  await Promise.all([...fetchKeys.entries()].map(async ([k, q]) => {
    const obs = await getHistoricalWeather(q.lat, q.lng, q.date);
    fetched.set(k, { wind: obs.windSpeedMax, temp: obs.temperatureMean });
  }));
  for (const g of groups.values()) {
    if (!g.courseId || !g.playedAt) continue;
    const loc = courseLoc.get(g.courseId);
    if (!loc) continue;
    const k = `${loc.lat.toFixed(2)},${loc.lng.toFixed(2)},${dateKey(g.playedAt)}`;
    const got = fetched.get(k);
    if (got) weatherByRound.set(g.key, got);
  }

  // 5a. Task #1346 — Layer in the persistent per-round weather cache. The
  //     `backfill:round-weather-cache` script writes one row per
  //     (tournament/gp, round) with the daily mean temp and daily max wind
  //     resolved from `getHistoricalWeather()`. Reading from it here lets
  //     older rounds populate the chart even when:
  //       * the in-memory archive cache has been evicted (server restart), or
  //       * the live archive call returned null on this request (transient
  //         Open-Meteo hiccup) but did succeed at backfill time.
  //     Per-round caddie-recommendation temperatures (step 5b) still take
  //     precedence — they are the on-course observed reading. The cache is
  //     used to fill in gaps left by the archive lookup.
  const tIdsForCache = [...new Set([...groups.values()]
    .map(g => g.tournamentId).filter((v): v is number => v !== null))];
  const gpIdsForCache = [...new Set([...groups.values()]
    .map(g => g.generalPlayRoundId).filter((v): v is number => v !== null))];
  const cachedByRound = new Map<string, { wind: number | null; temp: number | null }>();
  if (tIdsForCache.length > 0 || gpIdsForCache.length > 0) {
    const cacheFilters = [
      tIdsForCache.length > 0
        ? inArray(roundWeatherCacheTable.tournamentId, tIdsForCache)
        : null,
      gpIdsForCache.length > 0
        ? inArray(roundWeatherCacheTable.generalPlayRoundId, gpIdsForCache)
        : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);
    const cacheRows = await db
      .select({
        tournamentId: roundWeatherCacheTable.tournamentId,
        generalPlayRoundId: roundWeatherCacheTable.generalPlayRoundId,
        round: roundWeatherCacheTable.round,
        temperatureMean: roundWeatherCacheTable.temperatureMean,
        windSpeedMax: roundWeatherCacheTable.windSpeedMax,
      })
      .from(roundWeatherCacheTable)
      .where(cacheFilters.length === 1 ? cacheFilters[0] : or(...cacheFilters));
    for (const r of cacheRows) {
      const key = `${r.tournamentId ?? "g"}-${r.generalPlayRoundId ?? "t"}-${r.round}`;
      const t = r.temperatureMean != null ? parseFloat(r.temperatureMean) : NaN;
      const w = r.windSpeedMax    != null ? parseFloat(r.windSpeedMax)    : NaN;
      cachedByRound.set(key, {
        temp: Number.isFinite(t) ? t : null,
        wind: Number.isFinite(w) ? w : null,
      });
    }
  }
  for (const g of groups.values()) {
    const cached = cachedByRound.get(g.key);
    if (!cached) continue;
    const existing = weatherByRound.get(g.key);
    // Live archive value wins when present; cache fills in missing fields.
    weatherByRound.set(g.key, {
      wind: existing?.wind ?? cached.wind,
      temp: existing?.temp ?? cached.temp,
    });
  }

  // 5b. Task #1167 / #1347 — Pull persisted per-round weather observations
  //     from caddie_recommendations. The recommend route stamps the live
  //     observed temperature, humidity, and precipitation on every persisted
  //     recommendation, so a single round typically has many rows. We average
  //     them per (tournament/gp, round) and let temperature OVERRIDE both the
  //     historical-archive value and the round-weather-cache fallback (step
  //     5a) for that round, because:
  //       * the archive lags 5 days and is null for very recent rounds, and
  //       * the persisted reading is the actual on-course observation.
  //     The archive doesn't expose humidity / precipitation, so the persisted
  //     averages are the only source for those buckets.
  //     We leave the wind value alone (the archive's daily max is more
  //     representative of "round wind" than a single recommend snapshot).
  interface PersistedWeather { temp: number | null; humidity: number | null; precip: number | null; }
  const tIdsForWx = [...new Set([...groups.values()]
    .map(g => g.tournamentId).filter((v): v is number => v !== null))];
  const gpIdsForWx = [...new Set([...groups.values()]
    .map(g => g.generalPlayRoundId).filter((v): v is number => v !== null))];
  const persistedWxByRound = new Map<string, PersistedWeather>();
  if (tIdsForWx.length > 0 || gpIdsForWx.length > 0) {
    const idFilters = [
      tIdsForWx.length > 0
        ? inArray(caddieRecommendationsTable.tournamentId, tIdsForWx)
        : null,
      gpIdsForWx.length > 0
        ? inArray(caddieRecommendationsTable.generalPlayRoundId, gpIdsForWx)
        : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);
    const wxRows = await db
      .select({
        tournamentId: caddieRecommendationsTable.tournamentId,
        generalPlayRoundId: caddieRecommendationsTable.generalPlayRoundId,
        round: caddieRecommendationsTable.round,
        avgTemp: sql<string | null>`AVG(${caddieRecommendationsTable.temperature})`,
        avgHumidity: sql<string | null>`AVG(${caddieRecommendationsTable.humidity})`,
        avgPrecip: sql<string | null>`AVG(${caddieRecommendationsTable.precipitation})`,
      })
      .from(caddieRecommendationsTable)
      .where(and(
        eq(caddieRecommendationsTable.userId, userId),
        // At least one of the three weather columns must be non-null —
        // otherwise the row contributes nothing and would just inflate the
        // GROUP BY result without changing any bucket assignment.
        sql`(${caddieRecommendationsTable.temperature} IS NOT NULL
             OR ${caddieRecommendationsTable.humidity} IS NOT NULL
             OR ${caddieRecommendationsTable.precipitation} IS NOT NULL)`,
        idFilters.length === 1 ? idFilters[0] : or(...idFilters),
      ))
      .groupBy(
        caddieRecommendationsTable.tournamentId,
        caddieRecommendationsTable.generalPlayRoundId,
        caddieRecommendationsTable.round,
      );
    for (const r of wxRows) {
      const key = `${r.tournamentId ?? "g"}-${r.generalPlayRoundId ?? "t"}-${r.round}`;
      const t = r.avgTemp != null ? parseFloat(r.avgTemp) : NaN;
      const h = r.avgHumidity != null ? parseFloat(r.avgHumidity) : NaN;
      const p = r.avgPrecip != null ? parseFloat(r.avgPrecip) : NaN;
      persistedWxByRound.set(key, {
        temp: Number.isFinite(t) ? t : null,
        humidity: Number.isFinite(h) ? h : null,
        precip: Number.isFinite(p) ? p : null,
      });
    }
  }
  // Persisted temperature overrides the archive value (see comment above).
  // Humidity / precipitation are only carried via the persisted source.
  const humidityByRound = new Map<string, number>();
  const precipByRound = new Map<string, number>();
  for (const g of groups.values()) {
    const wx = persistedWxByRound.get(g.key);
    if (!wx) continue;
    if (wx.temp !== null) {
      const existing = weatherByRound.get(g.key);
      weatherByRound.set(g.key, {
        wind: existing?.wind ?? null,
        temp: wx.temp,
      });
    }
    if (wx.humidity !== null) humidityByRound.set(g.key, wx.humidity);
    if (wx.precip !== null) precipByRound.set(g.key, wx.precip);
  }

  // 6. Per-round SG-Total + bucket assignment.
  const windAcc     = WIND_BUCKETS.map(b => ({ ...b, sgSum: 0, rounds: 0 }));
  const tempAcc     = TEMP_BUCKETS.map(b => ({ ...b, sgSum: 0, rounds: 0 }));
  const humidityAcc = HUMIDITY_BUCKETS.map(b => ({ ...b, sgSum: 0, rounds: 0 }));
  const precipAcc   = PRECIP_BUCKETS.map(b => ({ ...b, sgSum: 0, rounds: 0 }));
  let baselineSum = 0;
  let baselineCount = 0;
  let tempObservedAny = false;
  let humidityObservedAny = false;
  let precipObservedAny = false;
  // Task #1613 — count baseline-eligible rounds whose temperature is still
  // unresolved (Open-Meteo archive lags by ~5 days). The UI surfaces this so
  // players know recent rounds will populate the chart later.
  let pendingRoundsCount = 0;
  // Task #2003 — same counter but for the wind chart. Wind has fewer
  // fallbacks than temperature (no caddie-rec override), so we track it
  // independently rather than reusing pendingRoundsCount.
  let pendingWindRoundsCount = 0;

  for (const g of groups.values()) {
    const holePars: HoleParMap = (g.courseId && parsByCourse.get(g.courseId)) || new Map();
    const r: RoundShotData = { tournamentId: g.tournamentId ?? 0, round: g.round, shots: g.shots, holePars };
    const sg = computeRoundSGFromShots(r, "scratch");
    if (sg.sgTotal === null) continue;
    baselineSum += sg.sgTotal;
    baselineCount++;

    const w = weatherByRound.get(g.key);
    // Task #1613 / #2003 — gate "pending" counters on whether the round's
    // weather could *ever* have been resolved. Rounds without coordinates
    // are permanently unresolvable and shouldn't make the "check back in a
    // few days" copy misleading. Computed once and reused for both temp
    // and wind so the hint stays consistent across the two cards.
    const canResolveWeather =
      g.courseId != null && g.playedAt != null && !!courseLoc.get(g.courseId);
    if (w?.wind != null) {
      const b = windAcc.find(b => w.wind! >= b.min && w.wind! < b.max);
      if (b) { b.sgSum += sg.sgTotal; b.rounds++; }
    } else if (canResolveWeather) {
      // Task #2003 — wind is missing but the archive should eventually
      // resolve it (course has lat/lng + play date). Surfaced on the wind
      // chart so players see "X rounds pending weather data" alongside the
      // existing temperature hint.
      pendingWindRoundsCount++;
    }
    if (w?.temp != null) {
      tempObservedAny = true;
      const b = tempAcc.find(b => w.temp! >= b.min && w.temp! < b.max);
      if (b) { b.sgSum += sg.sgTotal; b.rounds++; }
    } else if (canResolveWeather) {
      pendingRoundsCount++;
    }
    const hum = humidityByRound.get(g.key);
    if (hum != null) {
      humidityObservedAny = true;
      const b = humidityAcc.find(b => hum >= b.min && hum < b.max);
      if (b) { b.sgSum += sg.sgTotal; b.rounds++; }
    }
    const prc = precipByRound.get(g.key);
    if (prc != null) {
      precipObservedAny = true;
      const b = precipAcc.find(b => prc >= b.min && prc < b.max);
      if (b) { b.sgSum += sg.sgTotal; b.rounds++; }
    }
  }

  const baseline = baselineCount > 0 ? baselineSum / baselineCount : null;
  const baselineRounded = baseline !== null ? Math.round(baseline * 100) / 100 : null;

  function finalize(acc: typeof windAcc): WeatherBucket[] {
    return acc.map(b => {
      const mean = b.rounds > 0 ? b.sgSum / b.rounds : null;
      const meanRounded = mean !== null ? Math.round(mean * 100) / 100 : null;
      const delta = mean !== null && baseline !== null
        ? Math.round((mean - baseline) * 100) / 100
        : null;
      return { label: b.label, min: b.min, max: b.max, rounds: b.rounds, meanSgTotal: meanRounded, sgDelta: delta };
    });
  }

  return {
    windowDays,
    windowStart: since.toISOString(),
    baselineSgTotal: baselineRounded,
    baselineRoundCount: baselineCount,
    windBuckets: finalize(windAcc),
    temperatureBuckets: finalize(tempAcc),
    humidityBuckets: finalize(humidityAcc),
    precipitationBuckets: finalize(precipAcc),
    temperatureAvailable: tempObservedAny,
    humidityAvailable: humidityObservedAny,
    precipitationAvailable: precipObservedAny,
    pendingRoundsCount,
    pendingWindRoundsCount,
  };
}
