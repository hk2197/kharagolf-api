/**
 * Integration tests for the `playsLikeYards` field on the watch hole-context
 * payloads (Task #564).
 *
 * Two transports surface the same field and both are covered here:
 *
 *   1. HTTP — GET /api/portal/watch/hole-context
 *   2. WS   — /ws/watch `hole_context` event (delivered on `subscribe`)
 *
 * Both transports call the shared `computePlaysLikeForHole` helper, which in
 * turn calls `getWeather` and `fetchElevations`. Those two helpers are mocked
 * via `vi.hoisted` so the suite never touches Open-Meteo / OpenWeatherMap.
 *
 * The test database is real (matches the rest of `src/tests/`); fixtures are
 * cleaned up in `afterAll` to keep the suite hermetic.
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
import { handleMessage, type WatchSession } from "../routes/ws-watch.js";
import { issueWatchToken } from "../lib/watch-token.js";

let testOrgId: number;
let testCourseId: number;
let testTournamentId: number;
let testUserId: number;
let testPlayerId: number;

// Equator + ~111 m due north for hole 1 → bearing ≈ 0°. Picked so a wind
// FROM north is a pure headwind for the shot line, matching the unit tests.
const COURSE_LAT = "0.0000000";
const COURSE_LNG = "0.0000000";
const GREEN_LAT_STR = "0.0010000";
const GREEN_LNG_STR = "0.0000000";

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: `TestOrg_PlaysLikeWatch_${stamp}`,
      slug: `test-playslike-watch-${stamp}`,
    })
    .returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db
    .insert(coursesTable)
    .values({
      organizationId: testOrgId,
      name: "PlaysLike Course",
      slug: `playslike-course-${stamp}`,
      holes: 18,
      par: 72,
      latitude: COURSE_LAT,
      longitude: COURSE_LNG,
    })
    .returning({ id: coursesTable.id });
  testCourseId = course.id;

  // Hole 1 is the only one needed for these tests; seed a known yardage and
  // a green coordinate ~111 m due north of the course centre.
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
      name: `PlaysLike Tournament ${stamp}`,
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
      replitUserId: `playslike-watch-test-${stamp}`,
      username: `playslike_watch_test_${stamp}`,
    })
    .returning({ id: appUsersTable.id });
  testUserId = user.id;

  const [player] = await db
    .insert(playersTable)
    .values({
      tournamentId: testTournamentId,
      userId: testUserId,
      firstName: "PlaysLike",
      lastName: "Tester",
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
// configurable mock.
const realFetch = globalThis.fetch;
type ElevResponse = number[] | "error" | "throw";
const fetchElevationsMock = vi.fn<() => Promise<ElevResponse>>();

beforeAll(() => {
  // We override beforeAll *after* the DB seed beforeAll above; vitest runs
  // them in registration order so the seed still happens first.
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("/v1/elevation")) {
      // Forward anything that isn't an elevation lookup to the real fetch so
      // unrelated outbound calls (currently none in this suite) don't blow up.
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

beforeEach(() => {
  getWeatherMock.mockReset();
  fetchElevationsMock.mockReset();
  fetchElevationsMock.mockResolvedValue([0, 0]);
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

// ──────────────────────────────────────────────────────────────────────────
// HTTP — GET /api/portal/watch/hole-context
// ──────────────────────────────────────────────────────────────────────────
describe("GET /api/portal/watch/hole-context — playsLikeYards", () => {
  it("includes playsLikeYards when weather + elevation succeed", async () => {
    // 20 km/h headwind + flat → +3 yds on a 150 yd hole.
    mockWeatherOk(20, 0);
    fetchElevationsMock.mockResolvedValue([100, 100]);

    const app = createTestApp({
      id: testUserId,
      username: "playslike_watch_test",
      role: "member",
    });
    const res = await request(app).get(
      `/api/portal/watch/hole-context?tournamentId=${testTournamentId}&hole=1&lat=0&lng=0`,
    );

    expect(res.status).toBe(200);
    expect(res.body.playsLikeYards).toBe(153);
    // Task #562: per-factor breakdown is surfaced alongside the rounded total
    // so the phone scorecard can render "plays X yds (+W wind / +E elev)".
    // Headwind contributes +3, flat hole contributes 0.
    expect(res.body.playsLikeWindAdj).toBe(3);
    expect(res.body.playsLikeElevAdj).toBe(0);
    // Task #878 — bearing-to-green and wind's "from" direction are surfaced
    // so clients can rotate a small arrow next to the wind yardage.
    // Equator → ~111 m due north → bearing ≈ 0°; wind FROM 0° (north) too,
    // so the arrow should be a pure headwind (relative toward = 180°).
    expect(res.body.playsLikeBearingDeg).toBe(0);
    expect(res.body.playsLikeWindDirDeg).toBe(0);
    // Sanity-check the hole metadata is still present.
    expect(res.body.par).toBe(4);
    expect(res.body.yardageWhite).toBe(150);
    expect(getWeatherMock).toHaveBeenCalledTimes(1);
    expect(fetchElevationsMock).toHaveBeenCalledTimes(1);
  });

  it("returns separate wind and elevation contributions when both are non-zero", async () => {
    // 20 km/h headwind (+3 yds) + 10 m uphill (+11 yds) → 164 yds.
    mockWeatherOk(20, 0);
    fetchElevationsMock.mockResolvedValue([100, 110]);

    const app = createTestApp({
      id: testUserId,
      username: "playslike_watch_test",
      role: "member",
    });
    const res = await request(app).get(
      `/api/portal/watch/hole-context?tournamentId=${testTournamentId}&hole=1&lat=0&lng=0`,
    );

    expect(res.status).toBe(200);
    expect(res.body.playsLikeWindAdj).toBe(3);
    expect(res.body.playsLikeElevAdj).toBe(11);
    expect(res.body.playsLikeYards).toBe(164);
  });

  it("omits playsLikeYards (and its breakdown) when the weather provider is unavailable", async () => {
    getWeatherMock.mockRejectedValue(new Error("weather provider down"));
    fetchElevationsMock.mockResolvedValue([100, 100]);

    const app = createTestApp({
      id: testUserId,
      username: "playslike_watch_test",
      role: "member",
    });
    const res = await request(app).get(
      `/api/portal/watch/hole-context?tournamentId=${testTournamentId}&hole=1&lat=0&lng=0`,
    );

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("playsLikeYards");
    // Per the contract the wind/elev breakdown fields are OMITTED entirely
    // (not null, not zero) so existing clients never have to disambiguate
    // "missing data" from "calm + flat".
    expect(res.body).not.toHaveProperty("playsLikeWindAdj");
    expect(res.body).not.toHaveProperty("playsLikeElevAdj");
    // Task #878 — bearing/wind-direction arrow inputs are likewise omitted
    // so the watch / web clients hide the arrow rather than rendering a
    // bogus rotation against an absent yardage.
    expect(res.body).not.toHaveProperty("playsLikeBearingDeg");
    expect(res.body).not.toHaveProperty("playsLikeWindDirDeg");
    // The rest of the hole context still comes through cleanly.
    expect(res.body.par).toBe(4);
    expect(res.body.yardageWhite).toBe(150);
  });

  it("omits playsLikeYards (and its breakdown) when elevation lookup fails", async () => {
    mockWeatherOk(20, 0);
    fetchElevationsMock.mockResolvedValue("throw");

    const app = createTestApp({
      id: testUserId,
      username: "playslike_watch_test",
      role: "member",
    });
    const res = await request(app).get(
      `/api/portal/watch/hole-context?tournamentId=${testTournamentId}&hole=1&lat=0&lng=0`,
    );

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("playsLikeYards");
    expect(res.body).not.toHaveProperty("playsLikeWindAdj");
    expect(res.body).not.toHaveProperty("playsLikeElevAdj");
    expect(res.body).not.toHaveProperty("playsLikeBearingDeg");
    expect(res.body).not.toHaveProperty("playsLikeWindDirDeg");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// WS — /ws/watch `hole_context` payload
// ──────────────────────────────────────────────────────────────────────────
function makeStubSession(): { session: WatchSession; sent: object[] } {
  const sent: object[] = [];
  const ws = {
    readyState: 1,
    send: (data: string) => {
      sent.push(JSON.parse(data) as object);
    },
  } as unknown as WatchSession["ws"];
  const session: WatchSession = {
    ws,
    userId: null,
    tournamentId: null,
    round: 1,
    sessionId: "test-session",
    pushIntervalId: null,
    batteryMode: false,
    playerLat: null,
    playerLng: null,
  };
  return { session, sent };
}

async function authAndSubscribe(): Promise<{
  session: WatchSession;
  sent: object[];
}> {
  const { session, sent } = makeStubSession();
  const token = issueWatchToken(testUserId);
  await handleMessage(session, JSON.stringify({ type: "auth", token }));
  await handleMessage(
    session,
    JSON.stringify({
      type: "subscribe",
      tournamentId: testTournamentId,
      round: 1,
    }),
  );
  // The subscribe path schedules a periodic push — clear it so the suite
  // doesn't leak timers between tests.
  if (session.pushIntervalId) clearInterval(session.pushIntervalId);
  return { session, sent };
}

describe("/ws/watch hole_context — playsLikeYards", () => {
  it("includes playsLikeYards when weather + elevation succeed", async () => {
    // Clear any pre-existing scores so subscribe lands on hole 1.
    await db
      .delete(scoresTable)
      .where(eq(scoresTable.tournamentId, testTournamentId));

    // 20 km/h headwind + flat → +3 yds on a 150 yd hole. The WS path uses
    // course centre as the tee proxy because the protocol does not carry the
    // watch's live GPS — that's exactly what we seeded above.
    mockWeatherOk(20, 0);
    fetchElevationsMock.mockResolvedValue([100, 100]);

    const { sent } = await authAndSubscribe();

    const ctx = sent.find(
      (m) => (m as { type?: string }).type === "hole_context",
    ) as
      | {
          holeNumber: number;
          playsLikeYards?: number;
          playsLikeWindAdj?: number;
          playsLikeElevAdj?: number;
        }
      | undefined;
    expect(ctx).toBeDefined();
    expect(ctx!.holeNumber).toBe(1);
    expect(ctx!.playsLikeYards).toBe(153);
    // Task #562: same wind/elev breakdown fields the HTTP route exposes are
    // also pushed over the WS so the phone scorecard renders identically
    // whether it polled or subscribed.
    expect(ctx!.playsLikeWindAdj).toBe(3);
    expect(ctx!.playsLikeElevAdj).toBe(0);
    // Task #878 — bearing & wind-from direction are pushed too so the watch
    // can rotate the small wind arrow next to the breakdown.
    expect((ctx as Record<string, unknown>).playsLikeBearingDeg).toBe(0);
    expect((ctx as Record<string, unknown>).playsLikeWindDirDeg).toBe(0);
  });

  it("returns separate wind and elevation contributions when both are non-zero", async () => {
    await db
      .delete(scoresTable)
      .where(eq(scoresTable.tournamentId, testTournamentId));

    // 20 km/h headwind (+3) + 10 m uphill (+11) → 164 yds.
    mockWeatherOk(20, 0);
    fetchElevationsMock.mockResolvedValue([100, 110]);

    const { sent } = await authAndSubscribe();

    const ctx = sent.find(
      (m) => (m as { type?: string }).type === "hole_context",
    ) as
      | {
          playsLikeYards?: number;
          playsLikeWindAdj?: number;
          playsLikeElevAdj?: number;
        }
      | undefined;
    expect(ctx).toBeDefined();
    expect(ctx!.playsLikeYards).toBe(164);
    expect(ctx!.playsLikeWindAdj).toBe(3);
    expect(ctx!.playsLikeElevAdj).toBe(11);
  });

  it("omits playsLikeYards (and its breakdown) when the weather provider is unavailable", async () => {
    await db
      .delete(scoresTable)
      .where(eq(scoresTable.tournamentId, testTournamentId));

    getWeatherMock.mockRejectedValue(new Error("weather provider down"));
    fetchElevationsMock.mockResolvedValue([100, 100]);

    const { sent } = await authAndSubscribe();

    const ctx = sent.find(
      (m) => (m as { type?: string }).type === "hole_context",
    ) as Record<string, unknown> | undefined;
    expect(ctx).toBeDefined();
    // Field is OMITTED entirely (not null) so existing iOS / Wear OS clients
    // keep their pre-Task-#480 "no PL" rendering path.
    expect(ctx).not.toHaveProperty("playsLikeYards");
    expect(ctx).not.toHaveProperty("playsLikeWindAdj");
    expect(ctx).not.toHaveProperty("playsLikeElevAdj");
    // Hole metadata still flows through as before.
    expect(ctx!.par).toBe(4);
    expect(ctx!.yardageWhite).toBe(150);
  });

  it("omits playsLikeYards (and its breakdown) when elevation lookup fails", async () => {
    await db
      .delete(scoresTable)
      .where(eq(scoresTable.tournamentId, testTournamentId));

    mockWeatherOk(20, 0);
    fetchElevationsMock.mockResolvedValue("throw");

    const { sent } = await authAndSubscribe();

    const ctx = sent.find(
      (m) => (m as { type?: string }).type === "hole_context",
    ) as Record<string, unknown> | undefined;
    expect(ctx).toBeDefined();
    expect(ctx).not.toHaveProperty("playsLikeYards");
    expect(ctx).not.toHaveProperty("playsLikeWindAdj");
    expect(ctx).not.toHaveProperty("playsLikeElevAdj");
  });
});
