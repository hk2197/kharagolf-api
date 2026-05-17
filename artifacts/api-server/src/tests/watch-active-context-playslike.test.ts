/**
 * Integration tests for the plays-like breakdown trio
 * (`playsLikeYards`, `playsLikeWindAdj`, `playsLikeElevAdj`) on
 *   GET /api/portal/watch/active-context
 *
 * The active-context endpoint is what the Garmin Connect IQ field & similar
 * "tell me everything in one shot" clients hit, so the per-factor wind /
 * elevation breakdown surfaced there must change as the supplied player
 * position moves. In particular: walking *across* the green should flip the
 * sign of `playsLikeWindAdj` (the wind component goes from headwind to
 * tailwind once the shot bearing reverses).
 *
 * `getWeather` and the Open-Meteo elevation lookup are mocked so the suite
 * never touches the live weather/elevation providers — see
 * `watch-hole-context-playslike.test.ts` for the same pattern.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";

const { getWeatherMock } = vi.hoisted(() => ({
  getWeatherMock: vi.fn(),
}));

vi.mock("../lib/weather.js", () => ({
  getWeather: getWeatherMock,
}));

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  holeDetailsTable,
  tournamentsTable,
  playersTable,
  scoresTable,
  appUsersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let testOrgId: number;
let testCourseId: number;
let testTournamentId: number;
let testUserId: number;
let testPlayerId: number;

// Equator + green ~111 m due north of course centre. The shot from the
// course centre to the green has bearing ≈ 0°, so a wind FROM north
// (windDirection=0) is a pure headwind for that shot.
const COURSE_LAT = "0.0000000";
const COURSE_LNG = "0.0000000";
const GREEN_LAT_STR = "0.0010000";
const GREEN_LNG_STR = "0.0000000";
const GREEN_LAT_NUM = 0.001;
const GREEN_LNG_NUM = 0.0;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: `TestOrg_PlaysLikeActiveCtx_${stamp}`,
      slug: `test-playslike-activectx-${stamp}`,
    })
    .returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db
    .insert(coursesTable)
    .values({
      organizationId: testOrgId,
      name: "PlaysLike ActiveCtx Course",
      slug: `playslike-activectx-course-${stamp}`,
      holes: 18,
      par: 72,
      latitude: COURSE_LAT,
      longitude: COURSE_LNG,
    })
    .returning({ id: coursesTable.id });
  testCourseId = course.id;

  // Hole 1 is the only one needed; seed a known yardage and a green centre
  // ~111 m due north of the course centre.
  const holes = Array.from({ length: 18 }, (_, i) => ({
    courseId: testCourseId,
    holeNumber: i + 1,
    par: 4,
    yardageWhite: 150,
    greenCentreLat: i === 0 ? GREEN_LAT_STR : "0.0020000",
    greenCentreLng: i === 0 ? GREEN_LNG_STR : "0.0000000",
  }));
  await db.insert(holeDetailsTable).values(holes);

  const [tournament] = await db
    .insert(tournamentsTable)
    .values({
      organizationId: testOrgId,
      courseId: testCourseId,
      name: `PlaysLike ActiveCtx Tournament ${stamp}`,
      format: "stroke_play",
      status: "active",
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      maxPlayers: 32,
    })
    .returning({ id: tournamentsTable.id });
  testTournamentId = tournament.id;

  const [user] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: `playslike-activectx-test-${stamp}`,
      username: `playslike_activectx_test_${stamp}`,
    })
    .returning({ id: appUsersTable.id });
  testUserId = user.id;

  const [player] = await db
    .insert(playersTable)
    .values({
      tournamentId: testTournamentId,
      userId: testUserId,
      firstName: "PlaysLike",
      lastName: "ActiveCtx",
      currentRound: 1,
    })
    .returning({ id: playersTable.id });
  testPlayerId = player.id;
});

afterAll(async () => {
  await db.delete(scoresTable).where(eq(scoresTable.tournamentId, testTournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, testTournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, testTournamentId));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, testCourseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

// `fetchElevations` lives in the same module as `computePlaysLikeForHole`,
// so a vi.mock partial override doesn't intercept the in-module call. Stub
// global fetch instead and route Open-Meteo elevation lookups through this
// configurable mock — same approach as watch-hole-context-playslike.test.ts.
const realFetch = globalThis.fetch;
type ElevResponse = number[] | "error" | "throw";
const fetchElevationsMock = vi.fn<() => Promise<ElevResponse>>();

beforeAll(() => {
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("/v1/elevation")) {
      return realFetch(input);
    }
    const next = await fetchElevationsMock();
    if (next === "throw") throw new Error("network error");
    if (next === "error") {
      return new Response("oops", { status: 500 });
    }
    return new Response(JSON.stringify({ elevation: next }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  getWeatherMock.mockReset();
  fetchElevationsMock.mockReset();
  fetchElevationsMock.mockResolvedValue([0, 0]);
  // Make sure hole 1 is always the next unscored hole.
  await db
    .delete(scoresTable)
    .where(eq(scoresTable.tournamentId, testTournamentId));
});

function mockWeatherOk(windSpeed: number, windDirection: number) {
  getWeatherMock.mockResolvedValue({
    temperature: 21,
    windSpeed,
    windDirection,
    precipitation: 0,
    weatherCode: 0,
    description: "Clear",
    humidity: 50,
    feelsLike: 21,
    alerts: [],
    source: "open-meteo",
  });
}

describe("GET /api/portal/watch/active-context — plays-like breakdown trio", () => {
  it("returns playsLikeYards + windAdj + elevAdj when wind & elevation are mockable", async () => {
    // 20 km/h headwind (+3 yds on 150) + 10 m uphill (+11 yds) → 164 yds.
    mockWeatherOk(20, 0);
    fetchElevationsMock.mockResolvedValue([100, 110]);

    const app = createTestApp({
      id: testUserId,
      username: "playslike_activectx_test",
      role: "member",
    });
    // No lat/lng — falls back to course centre as the player position.
    const res = await request(app).get("/api/portal/watch/active-context");

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.holeNumber).toBe(1);
    expect(res.body.playsLikeYards).toBe(164);
    expect(res.body.playsLikeWindAdj).toBe(3);
    expect(res.body.playsLikeElevAdj).toBe(11);
    // Task #878 — bearing-to-green and wind's "from" compass direction
    // are also surfaced on active-context so the Garmin CIQ field (and any
    // other client polling this route) can rotate the small wind arrow
    // next to the breakdown using the same `(windFrom + 180) - bearing`
    // formula the watch / web use. Course centre as player position →
    // ~due-north shot, so bearing rounds to 0°; wind FROM 0° (north) too.
    expect(res.body.playsLikeBearingDeg).toBe(0);
    expect(res.body.playsLikeWindDirDeg).toBe(0);
  });

  it("nulls the breakdown trio when the weather provider is unavailable", async () => {
    getWeatherMock.mockRejectedValue(new Error("weather provider down"));
    fetchElevationsMock.mockResolvedValue([100, 100]);

    const app = createTestApp({
      id: testUserId,
      username: "playslike_activectx_test",
      role: "member",
    });
    const res = await request(app).get("/api/portal/watch/active-context");

    expect(res.status).toBe(200);
    // Per the active-context contract these fields are surfaced as `null`
    // (not omitted) so the Garmin CIQ field can render a stable "—".
    expect(res.body.playsLikeYards).toBeNull();
    expect(res.body.playsLikeWindAdj).toBeNull();
    expect(res.body.playsLikeElevAdj).toBeNull();
    // Task #878 — arrow rotation inputs are nulled too on the active-context
    // contract (matches the trio above) so the CIQ field / web view hide
    // the arrow rather than rotating it against an absent yardage.
    expect(res.body.playsLikeBearingDeg).toBeNull();
    expect(res.body.playsLikeWindDirDeg).toBeNull();
  });

  it("flips the sign of windAdj when the player walks across the green", async () => {
    // Wind FROM north at 20 km/h, flat hole.
    mockWeatherOk(20, 0);
    fetchElevationsMock.mockResolvedValue([100, 100]);

    const app = createTestApp({
      id: testUserId,
      username: "playslike_activectx_test",
      role: "member",
    });

    // 1) Player south of green → shot bearing ≈ 0° (north). Wind FROM
    //    north is a pure headwind, so windAdj is POSITIVE.
    const southOfGreenLat = GREEN_LAT_NUM - 0.001; // ~111 m south of green
    const southRes = await request(app).get(
      `/api/portal/watch/active-context?lat=${southOfGreenLat}&lng=${GREEN_LNG_NUM}`,
    );
    expect(southRes.status).toBe(200);
    expect(southRes.body.active).toBe(true);
    expect(southRes.body.playsLikeWindAdj).toBeGreaterThan(0);
    expect(southRes.body.playsLikeElevAdj).toBe(0);
    const southWindAdj: number = southRes.body.playsLikeWindAdj;

    // 2) Player NORTH of green → shot bearing ≈ 180° (south). The same
    //    wind FROM north is now a tailwind, so windAdj must be NEGATIVE.
    const northOfGreenLat = GREEN_LAT_NUM + 0.001; // ~111 m north of green
    const northRes = await request(app).get(
      `/api/portal/watch/active-context?lat=${northOfGreenLat}&lng=${GREEN_LNG_NUM}`,
    );
    expect(northRes.status).toBe(200);
    expect(northRes.body.active).toBe(true);
    expect(northRes.body.playsLikeWindAdj).toBeLessThan(0);
    expect(northRes.body.playsLikeElevAdj).toBe(0);

    // Sanity: the two have opposite signs (the whole point of the test).
    expect(Math.sign(southRes.body.playsLikeWindAdj)).toBe(
      -Math.sign(northRes.body.playsLikeWindAdj),
    );
    // And the magnitudes are sensible — tailwind is roughly half the
    // headwind effect per computePlaysLike, so |north| ≈ 0.5 * |south|.
    expect(Math.abs(northRes.body.playsLikeWindAdj)).toBeLessThan(southWindAdj);
  });
});
