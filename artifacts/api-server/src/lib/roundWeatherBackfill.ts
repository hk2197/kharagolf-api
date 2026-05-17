/**
 * Task #1612 — Reusable round-weather-cache backfill loop.
 *
 * Originally inlined in `scripts/backfillRoundWeatherCache.ts` (Task #1346).
 * Hoisted into `src/lib/` so the same loop can be invoked both from the
 * admin CLI script and from the daily cron registered in `startCronJobs()`.
 *
 * Behaviour:
 *   * Walks the trailing `days`-day window of tournament rounds and
 *     general-play rounds.
 *   * Idempotent: rows already populated with a non-null
 *     `temperature_mean` or `wind_speed_max` are skipped — only rows
 *     that were missing or returned NULL on a previous fetch are
 *     retried (Open-Meteo's archive lags ~5 days; rounds logged
 *     within that window are guaranteed to land NULL the first time
 *     and have to be picked up by a later pass once the archive
 *     catches up).
 *   * Returns a `BackfillResult` summary so callers can log
 *     filled-vs-pending counts.
 */
import {
  db,
  tournamentsTable,
  tournamentRoundsTable,
  generalPlayRoundsTable,
  coursesTable,
  roundWeatherCacheTable,
} from "@workspace/db";
import { and, eq, gte, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import { getHistoricalWeather } from "./weather.js";

export interface BackfillResult {
  /** Rows that just received a non-null observation. */
  updated: number;
  /** Rows whose fetch returned NULL again (still waiting for the archive). */
  nullObservation: number;
  /** Rows already populated with a non-null observation — skipped. */
  skippedAlreadyCached: number;
  /** Rows whose course had no lat/lng — skipped. */
  skippedNoCoords: number;
  /** Fetches that threw (network errors etc.). */
  failed: number;
  /** Total candidate rounds in the window. */
  total: number;
}

interface CourseLoc { id: number; lat: number; lng: number; }

interface RoundJob {
  tournamentId: number | null;
  generalPlayRoundId: number | null;
  round: number;
  courseId: number;
  date: string;
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function loadCourseLocs(courseIds: number[]): Promise<Map<number, CourseLoc | null>> {
  const out = new Map<number, CourseLoc | null>();
  if (courseIds.length === 0) return out;
  const courses = await db.select({
    id: coursesTable.id,
    latitude: coursesTable.latitude,
    longitude: coursesTable.longitude,
  }).from(coursesTable).where(inArray(coursesTable.id, courseIds));
  for (const c of courses) {
    const lat = c.latitude  !== null ? parseFloat(String(c.latitude))  : NaN;
    const lng = c.longitude !== null ? parseFloat(String(c.longitude)) : NaN;
    out.set(c.id, Number.isFinite(lat) && Number.isFinite(lng)
      ? { id: c.id, lat, lng }
      : null);
  }
  return out;
}

async function collectTournamentRounds(since: Date): Promise<RoundJob[]> {
  const tRounds = await db.select({
    tournamentId: tournamentRoundsTable.tournamentId,
    roundNumber: tournamentRoundsTable.roundNumber,
    perRoundCourseId: tournamentRoundsTable.courseId,
    scheduledDate: tournamentRoundsTable.scheduledDate,
    tournamentCourseId: tournamentsTable.courseId,
    tournamentStartDate: tournamentsTable.startDate,
  })
    .from(tournamentRoundsTable)
    .innerJoin(tournamentsTable, eq(tournamentRoundsTable.tournamentId, tournamentsTable.id))
    .where(or(
      gte(tournamentRoundsTable.scheduledDate, since),
      and(isNull(tournamentRoundsTable.scheduledDate), gte(tournamentsTable.startDate, since)),
    ));
  const jobs: RoundJob[] = [];
  for (const r of tRounds) {
    const courseId = r.perRoundCourseId ?? r.tournamentCourseId;
    const playedAt = r.scheduledDate ?? r.tournamentStartDate;
    if (courseId === null || playedAt === null) continue;
    jobs.push({
      tournamentId: r.tournamentId,
      generalPlayRoundId: null,
      round: r.roundNumber,
      courseId,
      date: dateKey(playedAt),
    });
  }
  const soloT = await db.select({
    id: tournamentsTable.id,
    courseId: tournamentsTable.courseId,
    startDate: tournamentsTable.startDate,
  })
    .from(tournamentsTable)
    .where(and(
      isNotNull(tournamentsTable.startDate),
      isNotNull(tournamentsTable.courseId),
      gte(tournamentsTable.startDate, since),
    ));
  const seenT = new Set(jobs.filter(j => j.tournamentId !== null).map(j => `${j.tournamentId}-${j.round}`));
  for (const t of soloT) {
    if (t.courseId === null || t.startDate === null) continue;
    const k = `${t.id}-1`;
    if (seenT.has(k)) continue;
    jobs.push({
      tournamentId: t.id,
      generalPlayRoundId: null,
      round: 1,
      courseId: t.courseId,
      date: dateKey(t.startDate),
    });
  }
  return jobs;
}

async function collectGeneralPlayRounds(since: Date): Promise<RoundJob[]> {
  const rows = await db.select({
    id: generalPlayRoundsTable.id,
    courseId: generalPlayRoundsTable.courseId,
    playedAt: generalPlayRoundsTable.playedAt,
  })
    .from(generalPlayRoundsTable)
    .where(gte(generalPlayRoundsTable.playedAt, since));
  const jobs: RoundJob[] = [];
  for (const r of rows) {
    if (r.courseId === null || r.playedAt === null) continue;
    jobs.push({
      tournamentId: null,
      generalPlayRoundId: r.id,
      round: 1,
      courseId: r.courseId,
      date: dateKey(r.playedAt),
    });
  }
  return jobs;
}

async function loadExistingCacheKeys(jobs: RoundJob[]): Promise<Set<string>> {
  // A cache row counts as "already populated" only when it carries at
  // least one of (temperature_mean, wind_speed_max). Rows with both NULL
  // are treated as retryable so the daily cron can re-fetch them once
  // Open-Meteo's archive catches up (~5-day lag).
  const tIds = [...new Set(jobs.map(j => j.tournamentId).filter((v): v is number => v !== null))];
  const gpIds = [...new Set(jobs.map(j => j.generalPlayRoundId).filter((v): v is number => v !== null))];
  const out = new Set<string>();
  if (tIds.length === 0 && gpIds.length === 0) return out;
  const filters = [
    tIds.length > 0 ? inArray(roundWeatherCacheTable.tournamentId, tIds) : null,
    gpIds.length > 0 ? inArray(roundWeatherCacheTable.generalPlayRoundId, gpIds) : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  const rows = await db.select({
    tournamentId: roundWeatherCacheTable.tournamentId,
    generalPlayRoundId: roundWeatherCacheTable.generalPlayRoundId,
    round: roundWeatherCacheTable.round,
    temperatureMean: roundWeatherCacheTable.temperatureMean,
    windSpeedMax: roundWeatherCacheTable.windSpeedMax,
  })
    .from(roundWeatherCacheTable)
    .where(and(
      filters.length === 1 ? filters[0] : or(...filters),
      or(
        isNotNull(roundWeatherCacheTable.temperatureMean),
        isNotNull(roundWeatherCacheTable.windSpeedMax),
      ),
    ));
  for (const r of rows) {
    out.add(`${r.tournamentId ?? "g"}-${r.generalPlayRoundId ?? "t"}-${r.round}`);
  }
  return out;
}

async function upsertCacheRow(
  job: RoundJob,
  observation: { temperatureMean: number | null; windSpeedMax: number | null },
): Promise<void> {
  const existing = await db.select({ id: roundWeatherCacheTable.id })
    .from(roundWeatherCacheTable)
    .where(and(
      eq(roundWeatherCacheTable.round, job.round),
      job.tournamentId !== null
        ? eq(roundWeatherCacheTable.tournamentId, job.tournamentId)
        : isNull(roundWeatherCacheTable.tournamentId),
      job.generalPlayRoundId !== null
        ? eq(roundWeatherCacheTable.generalPlayRoundId, job.generalPlayRoundId)
        : isNull(roundWeatherCacheTable.generalPlayRoundId),
    ))
    .limit(1);
  const tempStr = observation.temperatureMean !== null
    ? observation.temperatureMean.toFixed(2) : null;
  const windStr = observation.windSpeedMax !== null
    ? observation.windSpeedMax.toFixed(2) : null;
  if (existing.length > 0) {
    await db.update(roundWeatherCacheTable)
      .set({
        courseId: job.courseId,
        observedDate: job.date,
        temperatureMean: tempStr,
        windSpeedMax: windStr,
        fetchedAt: sql`NOW()`,
      })
      .where(eq(roundWeatherCacheTable.id, existing[0].id));
  } else {
    await db.insert(roundWeatherCacheTable).values({
      tournamentId: job.tournamentId,
      generalPlayRoundId: job.generalPlayRoundId,
      round: job.round,
      courseId: job.courseId,
      observedDate: job.date,
      temperatureMean: tempStr,
      windSpeedMax: windStr,
    });
  }
}

export interface RunBackfillOptions {
  /** Trailing window in days. Clamped to [1, 365]. Default 30. */
  days?: number;
  /**
   * Optional structured logger. Callers (cron, CLI) wire this up so the
   * unified summary line shows up in the right log stream.
   */
  log?: (msg: string) => void;
}

/**
 * Backfill (or refresh) `round_weather_cache` rows for every round in
 * the trailing window whose existing row is missing or carries only
 * NULL observations.
 *
 * Safe to call repeatedly — already-populated rows are skipped.
 */
export async function runRoundWeatherCacheBackfill(
  opts: RunBackfillOptions = {},
): Promise<BackfillResult> {
  const days = Math.max(1, Math.min(365, opts.days ?? 30));
  const log = opts.log ?? (() => { /* silent by default */ });
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  log(`[round-weather-backfill] window: ${days} day(s), since ${since.toISOString()}`);

  const [tJobs, gJobs] = await Promise.all([
    collectTournamentRounds(since),
    collectGeneralPlayRounds(since),
  ]);
  const allJobs = [...tJobs, ...gJobs];
  log(`[round-weather-backfill] candidate rounds: ${allJobs.length} (${tJobs.length} tournament + ${gJobs.length} general-play)`);

  const courseIds = [...new Set(allJobs.map(j => j.courseId))];
  const courseLocs = await loadCourseLocs(courseIds);
  const alreadyDone = await loadExistingCacheKeys(allJobs);

  let updated = 0;
  let skippedAlreadyCached = 0;
  let skippedNoCoords = 0;
  let nullObservation = 0;
  let failed = 0;

  for (const job of allJobs) {
    const key = `${job.tournamentId ?? "g"}-${job.generalPlayRoundId ?? "t"}-${job.round}`;
    if (alreadyDone.has(key)) {
      skippedAlreadyCached++;
      continue;
    }
    const loc = courseLocs.get(job.courseId);
    if (!loc) {
      skippedNoCoords++;
      continue;
    }
    try {
      const obs = await getHistoricalWeather(loc.lat, loc.lng, job.date);
      await upsertCacheRow(job, {
        temperatureMean: obs.temperatureMean,
        windSpeedMax: obs.windSpeedMax,
      });
      if (obs.temperatureMean === null && obs.windSpeedMax === null) {
        nullObservation++;
      } else {
        updated++;
      }
    } catch (err) {
      failed++;
      log(`[round-weather-backfill] ${key}: failed — ${(err as Error).message}`);
    }
  }

  log(
    `[round-weather-backfill] done: filled=${updated} stillPending=${nullObservation} ` +
    `skippedAlreadyCached=${skippedAlreadyCached} skippedNoCoords=${skippedNoCoords} ` +
    `failed=${failed} total=${allJobs.length}`,
  );

  return {
    updated,
    nullObservation,
    skippedAlreadyCached,
    skippedNoCoords,
    failed,
    total: allJobs.length,
  };
}
