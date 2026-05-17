/**
 * Task #1612 — Daily round-weather-cache refresh.
 *
 * Coverage:
 *   1. Rounds with no `round_weather_cache` row at all get inserted.
 *   2. Rows whose previous fetch returned NULL on both columns are
 *      retried — a successful fetch this time fills them in.
 *   3. Rows that already carry a non-null observation are NOT touched
 *      and the archive is NOT re-hit for them.
 *   4. The summary returned by `runRoundWeatherCacheBackfill` reports
 *      filled vs. still-pending counts.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-round-weather-backfill-cron";

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const getHistoricalWeatherMock = vi.hoisted(() =>
  vi.fn<(lat: number, lng: number, date: string) => Promise<{
    date: string; temperatureMean: number | null; windSpeedMax: number | null;
  }>>(),
);
vi.mock("../lib/weather.js", () => ({
  getHistoricalWeather: getHistoricalWeatherMock,
}));

import {
  db,
  organizationsTable,
  appUsersTable,
  coursesTable,
  tournamentsTable,
  tournamentRoundsTable,
  generalPlayRoundsTable,
  roundWeatherCacheTable,
} from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { runRoundWeatherCacheBackfill } from "../lib/roundWeatherBackfill.js";

let orgId: number;
let userId: number;
let courseId: number;
const tournamentIds: number[] = [];
const generalPlayRoundIds: number[] = [];

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function seedTournament(opts: { startDaysAgo: number; rounds: number }) {
  const startDate = new Date(Date.now() - opts.startDaysAgo * 24 * 60 * 60 * 1000);
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    name: `RoundWxBackfill_${stamp}`,
    status: "active",
    startDate,
    courseId,
  }).returning({ id: tournamentsTable.id });
  tournamentIds.push(t.id);
  for (let r = 1; r <= opts.rounds; r++) {
    await db.insert(tournamentRoundsTable).values({
      tournamentId: t.id,
      roundNumber: r,
      courseId,
      // Each round one day after the previous, anchored at startDate.
      scheduledDate: new Date(startDate.getTime() + (r - 1) * 24 * 60 * 60 * 1000),
    });
  }
  return t.id;
}

async function seedGeneralPlayRound(opts: { playedDaysAgo: number }) {
  const playedAt = new Date(Date.now() - opts.playedDaysAgo * 24 * 60 * 60 * 1000);
  const [g] = await db.insert(generalPlayRoundsTable).values({
    userId,
    organizationId: orgId,
    courseId,
    holesPlayed: 18,
    status: "confirmed",
    playedAt,
  }).returning({ id: generalPlayRoundsTable.id });
  generalPlayRoundIds.push(g.id);
  return g.id;
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `RoundWxBackfill_${stamp}`,
    slug: `round-wx-backfill-${stamp}`.toLowerCase(),
    isActive: true,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `round-wx-backfill-${stamp}`,
    username: `round_wx_backfill_${stamp}`,
    email: `${stamp}@example.test`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  const [c] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: `RoundWxBackfillCourse_${stamp}`,
    slug: `round-wx-backfill-course-${stamp}`.toLowerCase(),
    latitude: "37.77",
    longitude: "-122.42",
  }).returning({ id: coursesTable.id });
  courseId = c.id;
});

afterAll(async () => {
  if (tournamentIds.length > 0) {
    await db.delete(roundWeatherCacheTable).where(inArray(roundWeatherCacheTable.tournamentId, tournamentIds));
    await db.delete(tournamentRoundsTable).where(inArray(tournamentRoundsTable.tournamentId, tournamentIds));
    await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, tournamentIds));
  }
  if (generalPlayRoundIds.length > 0) {
    await db.delete(roundWeatherCacheTable).where(inArray(roundWeatherCacheTable.generalPlayRoundId, generalPlayRoundIds));
    await db.delete(generalPlayRoundsTable).where(inArray(generalPlayRoundsTable.id, generalPlayRoundIds));
  }
  if (courseId) await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  getHistoricalWeatherMock.mockReset();
  // Wipe any cache rows our seeded entities may have accumulated from a
  // prior test in this file.
  if (tournamentIds.length > 0) {
    await db.delete(roundWeatherCacheTable).where(inArray(roundWeatherCacheTable.tournamentId, tournamentIds));
  }
  if (generalPlayRoundIds.length > 0) {
    await db.delete(roundWeatherCacheTable).where(inArray(roundWeatherCacheTable.generalPlayRoundId, generalPlayRoundIds));
  }
});

describe("runRoundWeatherCacheBackfill (Task #1612 daily cron)", () => {
  it("fills brand-new tournament-round cache rows when the archive returns data", async () => {
    const tId = await seedTournament({ startDaysAgo: 7, rounds: 2 });
    getHistoricalWeatherMock.mockImplementation(async (_lat, _lng, date) => ({
      date, temperatureMean: 18.5, windSpeedMax: 12.3,
    }));

    const result = await runRoundWeatherCacheBackfill({ days: 30 });

    // Both new rounds should be filled.
    expect(result.updated).toBeGreaterThanOrEqual(2);
    expect(result.nullObservation).toBe(0);

    const rows = await db.select({
      round: roundWeatherCacheTable.round,
      temperatureMean: roundWeatherCacheTable.temperatureMean,
      windSpeedMax: roundWeatherCacheTable.windSpeedMax,
    })
      .from(roundWeatherCacheTable)
      .where(eq(roundWeatherCacheTable.tournamentId, tId));

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.temperatureMean).toBe("18.50");
      expect(r.windSpeedMax).toBe("12.30");
    }
  });

  it("retries rows whose previous fetch landed NULL once the archive catches up", async () => {
    // Seed a round logged 2 days ago (well within the Open-Meteo lag window).
    const gpId = await seedGeneralPlayRound({ playedDaysAgo: 2 });

    // Pre-existing cache row with both observations NULL — what the
    // first backfill attempt would have written while the archive was
    // still lagging.
    const playedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await db.insert(roundWeatherCacheTable).values({
      generalPlayRoundId: gpId,
      round: 1,
      courseId,
      observedDate: dateKey(playedAt),
      temperatureMean: null,
      windSpeedMax: null,
    });

    // The archive now has data — the daily cron should re-fetch and fill it.
    getHistoricalWeatherMock.mockImplementation(async (_lat, _lng, date) => ({
      date, temperatureMean: 22.0, windSpeedMax: 8.5,
    }));

    const result = await runRoundWeatherCacheBackfill({ days: 30 });

    expect(result.updated).toBeGreaterThanOrEqual(1);

    const [row] = await db.select({
      temperatureMean: roundWeatherCacheTable.temperatureMean,
      windSpeedMax: roundWeatherCacheTable.windSpeedMax,
    })
      .from(roundWeatherCacheTable)
      .where(eq(roundWeatherCacheTable.generalPlayRoundId, gpId))
      .limit(1);

    expect(row.temperatureMean).toBe("22.00");
    expect(row.windSpeedMax).toBe("8.50");
  });

  it("skips rows already populated with a non-null observation and doesn't re-hit the archive", async () => {
    const gpId = await seedGeneralPlayRound({ playedDaysAgo: 10 });
    const playedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    // Pre-existing cache row that already carries a temperature.
    await db.insert(roundWeatherCacheTable).values({
      generalPlayRoundId: gpId,
      round: 1,
      courseId,
      observedDate: dateKey(playedAt),
      temperatureMean: "15.00",
      windSpeedMax: null,
    });

    // Track how many times the archive was hit *for this round only*. We
    // can't assert "never called" because the test DB may carry seeds
    // from other suites (other tournaments / GP rounds inside the
    // 30-day window). Using a per-round filter keeps the assertion
    // precise without depending on global DB state.
    const hitsForOurRound: string[] = [];
    getHistoricalWeatherMock.mockImplementation(async (lat, lng, date) => {
      // Our seeded course coords. Other rounds in the window use
      // different coords (or the same — we filter by date too).
      if (lat === 37.77 && lng === -122.42 && date === dateKey(playedAt)) {
        hitsForOurRound.push(date);
      }
      return { date, temperatureMean: 99.0, windSpeedMax: 99.0 };
    });

    const result = await runRoundWeatherCacheBackfill({ days: 30 });

    // Our row should have been counted as already-cached and skipped.
    expect(result.skippedAlreadyCached).toBeGreaterThanOrEqual(1);
    expect(hitsForOurRound).toHaveLength(0);

    // And the existing row's value is preserved (NOT overwritten with the 99.0 stub).
    const [row] = await db.select({
      temperatureMean: roundWeatherCacheTable.temperatureMean,
      windSpeedMax: roundWeatherCacheTable.windSpeedMax,
    })
      .from(roundWeatherCacheTable)
      .where(eq(roundWeatherCacheTable.generalPlayRoundId, gpId))
      .limit(1);

    expect(row.temperatureMean).toBe("15.00");
    expect(row.windSpeedMax).toBeNull();
  });

  it("counts rows that come back NULL again as still-pending (not filled)", async () => {
    await seedGeneralPlayRound({ playedDaysAgo: 1 });
    // Archive still lagging — returns nothing.
    getHistoricalWeatherMock.mockImplementation(async (_lat, _lng, date) => ({
      date, temperatureMean: null, windSpeedMax: null,
    }));

    const result = await runRoundWeatherCacheBackfill({ days: 30 });

    // Our newly-seeded round should land in the pending bucket.
    expect(result.nullObservation).toBeGreaterThanOrEqual(1);

    // And a row was still written so the next pass can find and retry it.
    const cached = await db.select({
      temperatureMean: roundWeatherCacheTable.temperatureMean,
      windSpeedMax: roundWeatherCacheTable.windSpeedMax,
    })
      .from(roundWeatherCacheTable)
      .where(and(
        inArray(roundWeatherCacheTable.generalPlayRoundId, generalPlayRoundIds),
        isNull(roundWeatherCacheTable.temperatureMean),
        isNull(roundWeatherCacheTable.windSpeedMax),
      ));

    expect(cached.length).toBeGreaterThanOrEqual(1);
  });
});
